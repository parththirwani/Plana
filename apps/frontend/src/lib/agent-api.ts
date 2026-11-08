import { request } from "./api";
import type {
  AgentCapabilities,
  AgentConfig,
  AgentPolicy,
  AgentRun,
  EventPage,
  RunSelection,
} from "./agent-types";

export const getAgentPolicy = (orgId: string) =>
  request<AgentPolicy>(`/organizations/${orgId}/agent-config`);
export const saveAgentPolicy = (orgId: string, config: AgentConfig) =>
  request<{ config: AgentConfig }>(`/organizations/${orgId}/agent-config`, {
    method: "PUT",
    body: config,
  });
export const getAgentCapabilities = (issueId: string) =>
  request<AgentCapabilities>(`/issues/${issueId}/agent-runs/capabilities`);
export const listAgentRuns = (issueId: string) =>
  request<{ runs: AgentRun[] }>(`/issues/${issueId}/agent-runs`);
export const launchAgentRun = (issueId: string, selection: RunSelection, idempotencyKey: string) =>
  request<{ run: AgentRun }>(`/issues/${issueId}/agent-runs`, {
    method: "POST",
    body: { ...selection, idempotencyKey },
  });
export const getRunEvents = (runId: string, afterSequence: number) =>
  request<EventPage>(`/agent-runs/${runId}/events?afterSequence=${afterSequence}&limit=200`);
export const decideRunPlan = (run: AgentRun, decision: "APPROVED" | "REJECTED") =>
  request(`/agent-runs/${run.id}/approvals`, {
    method: "POST",
    body: { planVersion: run.planVersion, baseCommit: run.baseCommit, decision },
  });
export const cancelAgentRun = (runId: string) =>
  request(`/agent-runs/${runId}/cancel`, { method: "POST", body: {} });
export const resumeAgentRun = (runId: string) =>
  request(`/agent-runs/${runId}/resume`, { method: "POST" });
