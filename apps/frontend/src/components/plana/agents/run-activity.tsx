import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, RefreshCw, Square, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { cancelAgentRun, decideRunPlan, getRunEvents, resumeAgentRun } from "@/lib/agent-api";
import { isFinishedRun } from "@/lib/agent-types";
import type { AgentRun, RunEvent } from "@/lib/agent-types";
import { useAuthStore } from "@/lib/auth-store";
import { PrimaryButton, SecondaryButton } from "../ui-kit";
import { HarnessLogo } from "./harness-picker";

const statusLabel = (value: string) => value.toLowerCase().replaceAll("_", " ");
function eventText(event: RunEvent) {
  const d = event.data;
  if (event.type === "run.engine.output") {
    const inner =
      typeof d["data"] === "object" && d["data"] ? (d["data"] as Record<string, unknown>) : {};
    return String(
      d["text"] ?? d["path"] ?? inner["path"] ?? d["kind"] ?? d["type"] ?? "Engine activity",
    );
  }
  if (event.type === "run.status.changed")
    return statusLabel(String(d["to"] ?? d["status"] ?? "Status changed"));
  return String(
    d["message"] ??
      d["phase"] ??
      d["action"] ??
      event.type.replace(/^run\./, "").replaceAll(".", " "),
  );
}

export function RunActivity({ run, canOperate }: { run: AgentRun; canOperate: boolean }) {
  const userId = useAuthStore((s) => s.user?.id);
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const query = useInfiniteQuery({
    queryKey: ["agent-events", run.id, userId],
    queryFn: ({ pageParam }) => getRunEvents(run.id, pageParam),
    initialPageParam: 0,
    getNextPageParam: (page) => (page.hasMore ? page.nextSequence : undefined),
    // Terminal status can precede cleanup acknowledgement, so keep fetching receipts.
    refetchInterval: 2500,
    retry: false,
  });
  const { hasNextPage, isFetching, isError, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetching && !isError) void fetchNextPage();
  }, [hasNextPage, isFetching, isError, fetchNextPage]);
  const events = query.data?.pages.flatMap((p) => p.events) ?? [];
  const planEvent = [...events]
    .reverse()
    .find((e) => e.type === "run.plan.updated" && e.data["planVersion"] === run.planVersion);
  const plan = typeof planEvent?.data["plan"] === "string" ? planEvent.data["plan"] : null;
  const cleaned = events.some((e) => e.type === "run.cleanup.completed");
  const paused = [...events].reverse().find((e) => e.type === "run.sandbox.lifecycle");
  const sandbox = cleaned
    ? "Released"
    : paused
      ? String(paused.data["phase"] ?? "Provisioned").replaceAll("-", " ")
      : "Waiting for provisioning";
  const act = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run action failed.");
    } finally {
      await client.invalidateQueries({ queryKey: ["agent-runs"] });
      await client.invalidateQueries({ queryKey: ["agent-events", run.id] });
      setPending(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-center gap-3">
          <HarnessLogo engine={run.engine} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{run.model}</p>
            <p className="truncate text-xs text-muted-foreground">{run.repository}</p>
          </div>
          <span
            role="status"
            className="rounded-md bg-muted px-2 py-1 text-xs font-medium capitalize"
          >
            {statusLabel(run.status)}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Sandbox</dt>
            <dd className="mt-1 capitalize">{sandbox}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Run mode</dt>
            <dd className="mt-1">
              {run.executionMode === "PLAN_AND_APPROVE" ? "Plan and approve" : "Implement"}
            </dd>
          </div>
        </dl>
      </div>
      {run.status === "AWAITING_APPROVAL" && (
        <section className="space-y-3 rounded-xl border border-primary/30 bg-primary-soft p-4">
          <h3 className="text-sm font-semibold">Review plan v{run.planVersion}</h3>
          {plan ? (
            <pre className="max-h-72 overflow-auto text-xs leading-relaxed whitespace-pre-wrap break-words">
              {plan}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              Loading the current plan before approval...
            </p>
          )}
          <p className="break-all text-xs text-muted-foreground">
            Base commit: {run.baseCommit ?? "Not pinned yet"}
          </p>
          {canOperate ? (
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                disabled={pending || !plan || !run.baseCommit || query.hasNextPage || query.isError}
                onClick={() => void act(() => decideRunPlan(run, "APPROVED"))}
              >
                Approve and implement
              </PrimaryButton>
              <SecondaryButton
                disabled={pending || !plan || query.hasNextPage || query.isError}
                onClick={() => void act(() => decideRunPlan(run, "REJECTED"))}
              >
                Reject plan
              </SecondaryButton>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              A team admin or moderator must approve this plan.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {canOperate && !isFinishedRun(run.status) && (
        <div className="flex flex-wrap gap-2">
          {["BLOCKED", "LIMIT_REACHED"].includes(run.status) && (
            <SecondaryButton
              disabled={pending}
              onClick={() => void act(() => resumeAgentRun(run.id))}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              Resume run
            </SecondaryButton>
          )}
          <SecondaryButton
            disabled={pending}
            onClick={() => void act(() => cancelAgentRun(run.id))}
          >
            <Square className="h-3.5 w-3.5" aria-hidden />
            Cancel run
          </SecondaryButton>
          {pending && (
            <LoaderCircle className="h-4 w-4 animate-spin self-center" aria-label="Updating run" />
          )}
        </div>
      )}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4" aria-hidden />
          Run activity
          <span className="ml-auto text-xs text-muted-foreground">{events.length} events</span>
        </h3>
        {query.error && (
          <div className="mb-3 text-xs text-destructive" role="alert">
            {query.error.message}
            <button className="ml-2 underline" onClick={() => void query.refetch()}>
              Retry
            </button>
          </div>
        )}
        {query.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            Loading activity...
          </p>
        )}
        {!query.isPending && !events.length && (
          <p className="text-xs text-muted-foreground">Waiting for the worker to start.</p>
        )}
        <ol className="max-h-80 space-y-3 overflow-auto pr-1">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 text-xs">
              <span className="w-5 shrink-0 pt-0.5 font-mono text-muted-foreground">
                {event.sequence}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words whitespace-pre-wrap">{eventText(event)}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      {cleaned && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden />
          Sandbox released. Run activity is saved.
        </p>
      )}
    </div>
  );
}
