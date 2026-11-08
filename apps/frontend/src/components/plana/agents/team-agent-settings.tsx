import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, LoaderCircle, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { getAgentPolicy, saveAgentPolicy } from "@/lib/agent-api";
import type { AgentConfig, AgentPolicy, ExecutionMode } from "@/lib/agent-types";
import { useAuthStore } from "@/lib/auth-store";
import type { Role } from "@/lib/plana-types";
import { Field, PrimaryButton, SecondaryButton, Surface, inputClass } from "../ui-kit";
import { HarnessPicker } from "./harness-picker";

export function TeamAgentSettings({ orgId, role }: { orgId: string; role: Role }) {
  const userId = useAuthStore((s) => s.user?.id);
  const query = useQuery({
    queryKey: ["agent-policy", orgId, userId],
    queryFn: () => getAgentPolicy(orgId),
    retry: false,
  });
  if (query.isPending)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading team agent settings...
      </p>
    );
  if (query.error)
    return (
      <div role="alert" className="space-y-3 text-sm">
        <p>{query.error.message}</p>
        <SecondaryButton onClick={() => void query.refetch()}>Try again</SecondaryButton>
      </div>
    );
  return <PolicyForm key={orgId} orgId={orgId} role={role} policy={query.data} />;
}

function PolicyForm({ orgId, role, policy }: { orgId: string; role: Role; policy: AgentPolicy }) {
  const queryClient = useQueryClient();
  const [config, setConfig] = useState<AgentConfig>(
    policy.config ?? {
      allowedRepositories: [],
      defaultEngine: null,
      defaultModel: null,
      defaultExecutionMode: "PLAN_AND_APPROVE",
    },
  );
  const [repositories, setRepositories] = useState(config.allowedRepositories.join("\n"));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const isAdmin = role === "ADMIN";
  const engine = policy.engines.find((e) => e.id === config.defaultEngine);
  const patch = (values: Partial<AgentConfig>) => {
    setConfig((c) => ({ ...c, ...values }));
    setSaved(false);
  };
  const save = async () => {
    setError("");
    setSaved(false);
    const allowedRepositories = [
      ...new Set(
        repositories
          .split(/[\n,]+/)
          .map((r) => r.trim())
          .filter(Boolean),
      ),
    ];
    if (
      allowedRepositories.length > 100 ||
      allowedRepositories.some(
        (r) => r.length > 200 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(r),
      )
    ) {
      setError("Enter up to 100 repositories as owner/repository, one per line.");
      return;
    }
    setPending(true);
    try {
      await saveAgentPolicy(orgId, { ...config, allowedRepositories });
      setConfig((c) => ({ ...c, allowedRepositories }));
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["agent-policy", orgId] });
      await queryClient.invalidateQueries({ queryKey: ["agent-capabilities"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save team settings.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Agents for your team</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose the defaults your teammates start with and the repositories agents can access.
        </p>
      </div>
      <div className="flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4 text-sm">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />
        <div>
          <p className="font-medium">Shared defaults. Role-based control.</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Admins manage these settings. Admins and moderators launch, approve, and cancel runs.
            Members can view plans and activity. Defaults can be changed for individual runs.
          </p>
        </div>
      </div>
      <SimulationNotice simulation={policy.simulation} />
      {!isAdmin && (
        <p className="text-sm text-muted-foreground">
          You have read-only access. Ask a team admin to change these settings.
        </p>
      )}
      <Surface className="space-y-5 p-5 sm:p-6">
        <fieldset disabled={!isAdmin || pending} className="space-y-5">
          <HarnessPicker
            engines={policy.engines}
            value={config.defaultEngine ?? ""}
            onChange={(e) =>
              patch({
                defaultEngine: e.id,
                defaultModel: e.models.find((m) => m.available)?.id ?? null,
              })
            }
          />
          {config.defaultEngine && (
            <div className="flex items-end gap-3">
              <Field label="Default model">
                <select
                  className={inputClass}
                  value={config.defaultModel ?? ""}
                  onChange={(e) => patch({ defaultModel: e.target.value })}
                >
                  <option value="" disabled>
                    Choose a model
                  </option>
                  {engine?.models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.id}
                      {!m.available ? " (unavailable)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <SecondaryButton
                type="button"
                onClick={() => patch({ defaultEngine: null, defaultModel: null })}
              >
                Clear default
              </SecondaryButton>
            </div>
          )}
          <Field label="Default run mode">
            <select
              className={inputClass}
              value={config.defaultExecutionMode}
              onChange={(e) => patch({ defaultExecutionMode: e.target.value as ExecutionMode })}
            >
              <option value="PLAN_AND_APPROVE">Plan first, then approve</option>
              <option value="IMPLEMENT">Implement directly</option>
            </select>
          </Field>
          <div className="border-t border-border pt-5">
            <Field label="Approved repositories">
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <GitBranch className="h-3.5 w-3.5" aria-hidden />
                One owner/repository per line
              </div>
              <textarea
                rows={4}
                className={`${inputClass} h-auto py-2 font-mono text-xs`}
                placeholder="your-team/web\nyour-team/api"
                value={repositories}
                onChange={(e) => {
                  setRepositories(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            <p className="mt-2 text-xs text-muted-foreground">
              Only these repositories can be used by runs in this team. An empty list prevents new
              runs.
            </p>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-3">
          {isAdmin && (
            <PrimaryButton
              disabled={pending || (!!config.defaultEngine && !config.defaultModel)}
              onClick={() => void save()}
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}Save team
              settings
            </PrimaryButton>
          )}
          {saved && (
            <p role="status" className="text-sm text-primary">
              Team settings saved.
            </p>
          )}
        </div>
      </Surface>
    </div>
  );
}

export function SimulationNotice({ simulation }: { simulation: boolean }) {
  return (
    <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {simulation
        ? "Simulation mode. Runs use fake engines and sandboxes. No real VM or GitHub pull request is created."
        : "Agent execution is not configured. Harnesses remain unavailable until a supported runtime is enabled."}
    </p>
  );
}
