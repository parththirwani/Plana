import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { initialSelection, selectionError } from "../src/lib/agent-types";
import type { AgentCapabilities, AgentRun, RunSelection } from "../src/lib/agent-types";
import { RunLauncher } from "../src/components/plana/agents/run-launcher";
import { RunActivity } from "../src/components/plana/agents/run-activity";
import { TeamAgentSettings } from "../src/components/plana/agents/team-agent-settings";

const capabilities: AgentCapabilities = {
  simulation: true,
  engines: [
    {
      id: "CODEX",
      label: "OpenAI Codex",
      available: true,
      models: [
        {
          id: "gpt-5",
          available: true,
          options: {
            reasoningEffort: [
              { value: "high", available: true },
              { value: "max", available: false, reason: "Not supported" },
            ],
          },
        },
      ],
      executionModes: { IMPLEMENT: { available: true }, PLAN_AND_APPROVE: { available: true } },
    },
    {
      id: "PI",
      label: "Pi",
      available: false,
      reason: "Runtime unavailable",
      models: [],
      executionModes: { IMPLEMENT: { available: false }, PLAN_AND_APPROVE: { available: false } },
    },
  ],
  allowedRepositories: ["team/web"],
  repositories: { issueOverride: null, boardDefault: "team/web" },
  defaults: { engine: "CODEX", model: "gpt-5", executionMode: "PLAN_AND_APPROVE" },
};
const selection = (): RunSelection => initialSelection(structuredClone(capabilities));
const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const render = (node: ReactNode, queryClient = client()) =>
  renderToStaticMarkup(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);

describe("team harness selection", () => {
  test("inherits the exact team defaults and issue repository takes priority", () => {
    expect(selection()).toEqual({
      engine: "CODEX",
      model: "gpt-5",
      repository: "team/web",
      executionMode: "PLAN_AND_APPROVE",
      options: {},
    });
    expect(
      initialSelection({
        ...capabilities,
        repositories: { issueOverride: "team/api", boardDefault: "team/web" },
      }).repository,
    ).toBe("team/api");
  });
  test("does not replace a removed repository, retired model, or unavailable default harness", () => {
    expect(selectionError(capabilities, { ...selection(), repository: "other/private" })).toContain(
      "approved",
    );
    expect(selectionError(capabilities, { ...selection(), model: "retired-model" })).toContain(
      "available model",
    );
    expect(selectionError(capabilities, { ...selection(), engine: "PI" })).toBe(
      "Runtime unavailable",
    );
  });
  test("options and run mode are checked before launch", () => {
    expect(
      selectionError(capabilities, { ...selection(), options: { reasoningEffort: "max" } }),
    ).toContain("unavailable");
    expect(
      selectionError(capabilities, { ...selection(), options: { invented: "yes" } }),
    ).toContain("unavailable");
    const restricted = structuredClone(capabilities);
    restricted.engines[0]!.executionModes.PLAN_AND_APPROVE = {
      available: false,
      reason: "Plan mode disabled",
    };
    expect(selectionError(restricted, selection())).toBe("Plan mode disabled");
  });
  test("no team default requires an explicit harness and model choice", () => {
    const initial = initialSelection({
      ...capabilities,
      defaults: { ...capabilities.defaults, engine: null, model: null },
    });
    expect(initial.engine).toBe("");
    expect(initial.model).toBe("");
    expect(selectionError(capabilities, initial)).toContain("Choose a harness");
  });
  test("member sees the configuration but cannot launch; operator sees a simulated launch", () => {
    const member = render(
      <RunLauncher
        issueId="issue"
        capabilities={capabilities}
        canOperate={false}
        onLaunched={() => {}}
      />,
    );
    expect(member).toContain('fieldset disabled=""');
    expect(member).not.toContain("Launch simulated run");
    expect(member).toContain("/harnesses/codex.svg");
    const operator = render(
      <RunLauncher issueId="issue" capabilities={capabilities} canOperate onLaunched={() => {}} />,
    );
    expect(operator).toContain("Launch simulated run");
    expect(operator).toContain("Runtime unavailable");
  });
  test("team policy is editable only for admins", () => {
    const q = client();
    q.setQueryData(["agent-policy", "org", undefined], {
      config: {
        allowedRepositories: ["team/web"],
        defaultEngine: "CODEX",
        defaultModel: "gpt-5",
        defaultExecutionMode: "IMPLEMENT",
      },
      engines: capabilities.engines,
      simulation: true,
    });
    const member = render(<TeamAgentSettings orgId="org" role="MEMBER" />, q);
    const moderator = render(<TeamAgentSettings orgId="org" role="MODERATOR" />, q);
    expect(member).not.toContain("Save team settings");
    expect(moderator).not.toContain("Save team settings");
    expect(member).toContain("read-only access");
    expect(render(<TeamAgentSettings orgId="org" role="ADMIN" />, q)).toContain(
      "Save team settings",
    );
  });
});

describe("plan review controls", () => {
  const run: AgentRun = {
    id: "run",
    engine: "CODEX",
    model: "gpt-5",
    repository: "team/web",
    executionMode: "PLAN_AND_APPROVE",
    status: "AWAITING_APPROVAL",
    baseCommit: "abc123",
    planVersion: 2,
    createdBy: "moderator",
    createdAt: "2026-11-08T00:00:00Z",
  };
  const withPlan = () => {
    const q = client();
    q.setQueryData(["agent-events", "run", undefined], {
      pages: [
        {
          events: [
            {
              id: "event",
              sequence: 1,
              type: "run.plan.updated",
              createdAt: run.createdAt,
              data: {
                planVersion: 2,
                baseCommit: "abc123",
                plan: "Implement the permission check and add a regression test.",
              },
            },
          ],
          nextSequence: 1,
          hasMore: false,
        },
      ],
      pageParams: [0],
    });
    return q;
  };
  test("members can read a saved plan but cannot approve, reject, or cancel", () => {
    const html = render(<RunActivity run={run} canOperate={false} />, withPlan());
    expect(html).toContain("Implement the permission check");
    expect(html).not.toContain("Approve and implement");
    expect(html).not.toContain("Reject plan");
    expect(html).not.toContain("Cancel run");
  });
  test("sandbox status comes from persisted lifecycle phases", () => {
    const q = withPlan();
    q.setQueryData(["agent-events", "run", undefined], {
      pages: [
        {
          events: [
            {
              id: "lifecycle",
              sequence: 1,
              type: "run.sandbox.lifecycle",
              data: { phase: "paused-awaiting-approval" },
              createdAt: run.createdAt,
            },
          ],
          nextSequence: 1,
          hasMore: false,
        },
      ],
      pageParams: [0],
    });
    expect(render(<RunActivity run={run} canOperate={false} />, q)).toContain(
      "paused awaiting approval",
    );
  });
  test("operators receive approval and cancellation controls for the current plan", () => {
    const html = render(<RunActivity run={run} canOperate />, withPlan());
    expect(html).toContain("Approve and implement");
    expect(html).toContain("Reject plan");
    expect(html).toContain("Cancel run");
    expect(html).toContain("abc123");
  });
  test("terminal runs cannot be resumed or cancelled", () => {
    const html = render(
      <RunActivity run={{ ...run, status: "COMPLETED" }} canOperate />,
      withPlan(),
    );
    expect(html).not.toContain("Cancel run");
    expect(html).not.toContain("Resume run");
    expect(html).not.toContain("Approve and implement");
  });
});
