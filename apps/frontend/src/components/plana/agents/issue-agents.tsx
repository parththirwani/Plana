import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Bot, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { getAgentCapabilities, listAgentRuns } from "@/lib/agent-api";
import { isFinishedRun } from "@/lib/agent-types";
import { useAuthStore } from "@/lib/auth-store";
import type { Role } from "@/lib/plana-types";
import { atLeast } from "@/lib/plana-types";
import { SecondaryButton } from "../ui-kit";
import { RunActivity } from "./run-activity";
import { RunLauncher } from "./run-launcher";
import { SimulationNotice } from "./team-agent-settings";

export function IssueAgents({
  issueId,
  orgId,
  role,
}: {
  issueId: string;
  orgId: string;
  role: Role;
}) {
  const userId = useAuthStore((s) => s.user?.id);
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const capabilities = useQuery({
    queryKey: ["agent-capabilities", issueId, userId],
    queryFn: () => getAgentCapabilities(issueId),
    retry: false,
  });
  const runs = useQuery({
    queryKey: ["agent-runs", issueId, userId],
    queryFn: () => listAgentRuns(issueId),
    refetchInterval: 2500,
    retry: false,
  });
  const canOperate = atLeast(role, "MODERATOR");
  if (capabilities.isPending || runs.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading agents...
      </p>
    );
  if (capabilities.error || runs.error)
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p>{capabilities.error?.message ?? runs.error?.message}</p>
        <SecondaryButton
          onClick={() => {
            void capabilities.refetch();
            void runs.refetch();
          }}
        >
          Try again
        </SecondaryButton>
      </div>
    );
  const history = runs.data.runs;
  const active = history.find((r) => !isFinishedRun(r.status));
  const selected = history.find((r) => r.id === selectedId) ?? active ?? history[0];
  const showLauncher = !active && (creating || !selected);
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-semibold">
            <Bot className="h-5 w-5 text-primary" aria-hidden />
            Coding agents
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Choose a harness to work on this card.
          </p>
        </div>
        <Link
          to="/app/org/$orgId/settings"
          params={{ orgId }}
          search={{ tab: "Agents" }}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Settings2 className="h-3.5 w-3.5" aria-hidden />
          Team settings
        </Link>
      </div>
      <SimulationNotice simulation={capabilities.data.simulation} />
      {!canOperate && (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
          You can view runs. Launching and approving requires a team admin or moderator.
        </p>
      )}
      {!capabilities.data.allowedRepositories.length && (
        <p className="rounded-lg border border-border px-3 py-3 text-sm text-muted-foreground">
          No repositories approved yet. A team admin can add them in{" "}
          <Link
            to="/app/org/$orgId/settings"
            params={{ orgId }}
            search={{ tab: "Agents" }}
            className="text-primary underline"
          >
            team agent settings
          </Link>
          .
        </p>
      )}
      {showLauncher ? (
        <>
          {selected && (
            <SecondaryButton onClick={() => setCreating(false)}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to run
            </SecondaryButton>
          )}
          <RunLauncher
            issueId={issueId}
            capabilities={capabilities.data}
            canOperate={canOperate}
            onLaunched={(run) => {
              client.setQueryData<{ runs: typeof history }>(
                ["agent-runs", issueId, userId],
                (previous) => ({
                  runs: [run, ...(previous?.runs ?? []).filter((r) => r.id !== run.id)],
                }),
              );
              setSelectedId(run.id);
              setCreating(false);
              void client.invalidateQueries({ queryKey: ["agent-runs", issueId] });
            }}
          />
        </>
      ) : (
        selected && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Run history</span>
                <select
                  className="h-9 w-full rounded-lg border border-border bg-surface px-2 text-xs"
                  value={selected.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {history.map((r) => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.createdAt).toLocaleString()} ·{" "}
                      {r.status.toLowerCase().replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              {canOperate && !active && (
                <SecondaryButton onClick={() => setCreating(true)}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New run
                </SecondaryButton>
              )}
            </div>
            {active && selected.id !== active.id && (
              <button
                className="text-xs text-primary underline"
                onClick={() => setSelectedId(active.id)}
              >
                View the active run
              </button>
            )}
            <RunActivity key={selected.id} run={selected} canOperate={canOperate} />
          </>
        )
      )}
    </div>
  );
}
