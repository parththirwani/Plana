export type EngineId = "CODEX" | "CLAUDE_CODE" | "OPENCODE" | "PI";
export type ExecutionMode = "IMPLEMENT" | "PLAN_AND_APPROVE";
export type Availability = { available: boolean; reason?: string };
export interface EngineModel extends Availability {
  id: string;
  options: Record<string, (Availability & { value: string })[]>;
}
export interface EngineSpec extends Availability {
  id: EngineId;
  label: string;
  models: EngineModel[];
  executionModes: Record<ExecutionMode, Availability>;
}
export interface AgentConfig {
  allowedRepositories: string[];
  defaultEngine: EngineId | null;
  defaultModel: string | null;
  defaultExecutionMode: ExecutionMode;
}
export interface AgentPolicy {
  config: AgentConfig | null;
  engines: EngineSpec[];
  simulation: boolean;
}
export interface AgentCapabilities {
  engines: EngineSpec[];
  simulation: boolean;
  allowedRepositories: string[];
  repositories: { boardDefault: string | null; issueOverride: string | null };
  defaults: { engine: EngineId | null; model: string | null; executionMode: ExecutionMode };
}
export interface RunSelection {
  engine: EngineId | "";
  model: string;
  executionMode: ExecutionMode;
  repository: string;
  options: Record<string, string>;
}
export interface AgentRun {
  id: string;
  engine: EngineId;
  model: string;
  repository: string;
  executionMode: ExecutionMode;
  status: string;
  baseCommit: string | null;
  planVersion: number;
  createdBy: string;
  createdAt: string;
}
export interface RunEvent {
  id: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface EventPage {
  events: RunEvent[];
  nextSequence: number;
  hasMore: boolean;
}
export const isFinishedRun = (status: string) =>
  ["COMPLETED", "FAILED", "CANCELLED"].includes(status);

export function initialSelection(capabilities: AgentCapabilities): RunSelection {
  const { defaults, repositories, allowedRepositories } = capabilities;
  return {
    engine: defaults.engine ?? "",
    model: defaults.model ?? "",
    executionMode: defaults.executionMode,
    repository:
      repositories.issueOverride ?? repositories.boardDefault ?? allowedRepositories[0] ?? "",
    options: {},
  };
}

export function selectionError(capabilities: AgentCapabilities, selection: RunSelection) {
  const engine = capabilities.engines.find((e) => e.id === selection.engine);
  if (!engine) return "Choose a harness to continue.";
  if (!engine.available) return engine.reason ?? "This harness is unavailable.";
  const model = engine.models.find((m) => m.id === selection.model);
  if (!model?.available) return model?.reason ?? "Choose an available model.";
  const mode = engine.executionModes[selection.executionMode];
  if (!mode.available) return mode.reason ?? "This run mode is unavailable.";
  if (!capabilities.allowedRepositories.includes(selection.repository))
    return "Choose a repository approved by your team admin.";
  for (const [key, value] of Object.entries(selection.options)) {
    if (!model.options[key]?.some((o) => o.value === value && o.available))
      return `The selected ${key} is unavailable.`;
  }
  return null;
}
