import { GitBranch, LoaderCircle, Play, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { launchAgentRun } from "@/lib/agent-api";
import { initialSelection, selectionError } from "@/lib/agent-types";
import type {
  AgentRun,
  AgentCapabilities,
  EngineSpec,
  ExecutionMode,
  RunSelection,
} from "@/lib/agent-types";
import { Field, PrimaryButton, inputClass } from "../ui-kit";
import { HarnessPicker } from "./harness-picker";

export function RunLauncher({
  issueId,
  capabilities,
  canOperate,
  onLaunched,
}: {
  issueId: string;
  capabilities: AgentCapabilities;
  canOperate: boolean;
  onLaunched: (run: AgentRun) => void;
}) {
  const [selection, setSelection] = useState<RunSelection>(() => initialSelection(capabilities));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const engine = capabilities.engines.find((e) => e.id === selection.engine);
  const model = engine?.models.find((m) => m.id === selection.model);
  const disabledReason = selectionError(capabilities, selection);
  const patch = (change: Partial<RunSelection>) => {
    setSelection((s) => ({ ...s, ...change }));
    setError("");
  };
  const chooseEngine = (next: EngineSpec) => patch({ engine: next.id, model: "", options: {} });
  const launch = async () => {
    if (!canOperate || disabledReason || pending) return;
    const fingerprint = JSON.stringify(selection);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    setPending(true);
    setError("");
    try {
      const result = await launchAgentRun(issueId, selection, attempt.current.key);
      onLaunched(result.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not launch run.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-5">
      <fieldset disabled={!canOperate || pending} className="space-y-5">
        <HarnessPicker
          engines={capabilities.engines}
          value={selection.engine}
          onChange={chooseEngine}
        />
        <Field label="Model">
          <select
            className={inputClass}
            value={selection.model}
            disabled={!engine}
            onChange={(e) => patch({ model: e.target.value, options: {} })}
          >
            <option value="" disabled>
              Choose a model
            </option>
            {engine?.models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.id}
                {!m.available ? ` • ${m.reason ?? "Unavailable"}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {model &&
          Object.entries(model.options).map(([name, values]) => (
            <Field key={name} label={name.replace(/([A-Z])/g, " $1")}>
              <select
                className={inputClass}
                value={selection.options[name] ?? ""}
                onChange={(e) => {
                  const options = { ...selection.options };
                  if (e.target.value) options[name] = e.target.value;
                  else delete options[name];
                  patch({ options });
                }}
              >
                <option value="">Harness default</option>
                {values.map((v) => (
                  <option key={v.value} value={v.value} disabled={!v.available}>
                    {v.value}
                    {!v.available ? ` • ${v.reason ?? "Unavailable"}` : ""}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        <Field label="Repository">
          <div className="relative">
            <GitBranch
              className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            <select
              className={`${inputClass} pl-9`}
              value={selection.repository}
              onChange={(e) => patch({ repository: e.target.value })}
            >
              <option value="" disabled>
                Choose an approved repository
              </option>
              {selection.repository &&
                !capabilities.allowedRepositories.includes(selection.repository) && (
                  <option value={selection.repository} disabled>
                    {selection.repository} (no longer approved)
                  </option>
                )}
              {capabilities.allowedRepositories.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Run mode</legend>
          <div className="space-y-2">
            {(
              [
                [
                  "PLAN_AND_APPROVE",
                  "Plan first, then approve",
                  "Review the plan before implementation starts.",
                ],
                [
                  "IMPLEMENT",
                  "Implement directly",
                  "Start implementation without a plan approval step.",
                ],
              ] as const
            ).map(([mode, label, detail]) => {
              const available = engine?.executionModes[mode];
              return (
                <label
                  key={mode}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-3 has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
                >
                  <input
                    className="mt-1 accent-primary"
                    type="radio"
                    name={`run-mode-${issueId}`}
                    value={mode}
                    checked={selection.executionMode === mode}
                    disabled={!available?.available}
                    onChange={() => patch({ executionMode: mode as ExecutionMode })}
                  />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">
                      {available?.available
                        ? detail
                        : (available?.reason ?? "Choose a harness first.")}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </fieldset>
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        Repository access is managed by your team. Each run gets its own sandbox.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {canOperate && disabledReason && (
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      )}
      {canOperate && (
        <PrimaryButton
          className="w-full"
          disabled={pending || !!disabledReason}
          onClick={() => void launch()}
        >
          {pending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Play className="h-4 w-4" aria-hidden />
          )}
          {pending
            ? "Queuing run..."
            : capabilities.simulation
              ? "Launch simulated run"
              : "Launch agent run"}
        </PrimaryButton>
      )}
    </div>
  );
}
