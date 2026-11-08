import {
    ENGINE_CAPABILITIES,
    validateRunSelection,
    type AgentEngineId,
    type RunExecutionModeId,
} from "./capabilities";
import {
    EngineError,
    type EngineAdapter,
    type EngineEvent,
    type EnginePauseResult,
    type EngineResumeInput,
    type EngineSessionExport,
    type EngineStartRequest,
    type EngineUsageReport,
    type Sandbox,
} from "./contract";

// FAKE engine adapter (CP5). ONE implementation parameterised by engine id,
// validated against the SAME capability catalog the HTTP API validates
// against (capabilities.ts is the single source of truth). What it proves:
//
//   * a selection the catalog marks unavailable (unknown engine/model/option,
//     PI entirely, OPENCODE + PLAN_AND_APPROVE) is a HARD error with the
//     catalog reason — there is no code path that picks a substitute;
//   * PLAN_AND_APPROVE produces a plan + a durable checkpoint and pauses with
//     ZERO tracked-file changes; implementation happens ONLY after resume
//     against the EXACT approved planVersion + baseCommit;
//   * cancel stops the stream (late results cannot keep flowing) and makes
//     resume/sendInput fail — a cancelled session can never come back;
//   * session exports contain no credentials by construction.
//
// This is NOT a claim that Codex/Claude Code/OpenCode/Pi were exercised —
// real provider integration stays in the UNVERIFIED ledger.

type SessionPhase =
    | "planning"
    | "awaiting_approval"
    | "implementing"
    | "done"
    | "cancelled";

type Session = {
    id: string;
    runId: string;
    engineId: AgentEngineId;
    model: string;
    options: Record<string, unknown>;
    executionMode: RunExecutionModeId;
    repository: string;
    baseCommit: string;
    sandbox: Sandbox;
    phase: SessionPhase;
    planVersion: number;
    plan: string;
    events: EngineEvent[];
    streamStart: number;
    inputs: string[];
    cancelCalls: number;
    resumeCalls: number;
    startedAt: string;
    branchName: string | null;
    headCommit: string | null;
    changedFiles: string[];
};

let sessionSeq = 0;

const planTextFor = (
    runId: string,
    planVersion: number,
    baseCommit: string
): string =>
    [
        `Plan v${planVersion} for ${runId}`,
        `- base: ${baseCommit}`,
        `- add src/issue-${runId}.ts implementing the card`,
        `- add tests/issue-${runId}.test.ts regression test`,
        `- branch plana/${runId}, validated with 'bun test'`,
    ].join("\n");

const implementChanges = (session: Session): { files: string[]; head: string } => {
    const files = [`src/issue-${session.runId}.ts`, `tests/issue-${session.runId}.test.ts`];
    return { files, head: `head-of-${session.baseCommit}` };
};

export class FakeEngineAdapter implements EngineAdapter {
    readonly engineId: AgentEngineId;
    readonly id: string;

    private readonly sessions = new Map<string, Session>();

    constructor(engineId: AgentEngineId) {
        this.engineId = engineId;
        this.id = `fake:${engineId}`;
    }

    capabilities() {
        return ENGINE_CAPABILITIES[this.engineId];
    }

    private require(sessionId: string): Session {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new EngineError("SESSION_NOT_FOUND", `unknown engine session ${sessionId}`, {
                sessionId,
                engine: this.engineId,
            });
        }
        return session;
    }

    private rejectUnsupported(field: string, requested: unknown, reason: string, available?: string[]) {
        // The reason comes from the shared capability catalog; the request is
        // refused outright. Engine/model/options are NEVER substituted.
        throw new EngineError("UNSUPPORTED_CAPABILITY", reason, {
            engine: this.engineId,
            field,
            requested,
            substituted: false,
            ...(available ? { available } : {}),
        });
    }

    async start(request: EngineStartRequest): Promise<{ sessionId: string }> {
        const selection = validateRunSelection({
            engine: this.engineId,
            model: request.model,
            options: request.options,
            executionMode: request.executionMode,
        });
        if (!selection.ok) {
            this.rejectUnsupported(
                selection.issue.field,
                selection.issue.requested,
                selection.issue.reason,
                selection.issue.available
            );
        }

        const session: Session = {
            id: `es_${++sessionSeq}_${this.engineId.toLowerCase()}`,
            runId: request.runId,
            engineId: this.engineId,
            model: request.model,
            options: { ...request.options },
            executionMode: request.executionMode,
            repository: request.repository,
            baseCommit: request.baseCommit,
            sandbox: request.sandbox,
            phase: "planning",
            planVersion: 1,
            plan: "",
            events: [],
            streamStart: 0,
            inputs: [],
            cancelCalls: 0,
            resumeCalls: 0,
            startedAt: new Date().toISOString(),
            branchName: `plana/${request.runId}`,
            headCommit: null,
            changedFiles: [],
        };

        // Read-only inspection first, in BOTH modes: the sandbox is never
        // written during planning for PLAN_AND_APPROVE.
        session.events.push(
            { type: "status", text: `inspecting ${session.repository} @ ${session.baseCommit}` },
            { type: "output", text: "read README.md, src/index.ts (read-only)" }
        );

        if (session.executionMode === "PLAN_AND_APPROVE") {
            session.plan = planTextFor(session.runId, session.planVersion, session.baseCommit);
            session.events.push({
                type: "plan",
                text: session.plan,
                data: {
                    planVersion: session.planVersion,
                    baseCommit: session.baseCommit,
                    mode: "PLAN_AND_APPROVE",
                },
            });
        } else {
            // IMPLEMENT: working plan + immediate edits (no approval gate).
            session.events.push({
                type: "plan",
                text: planTextFor(session.runId, 0, session.baseCommit),
                data: { kind: "working-plan" },
            });
            this.scriptImplementation(session);
        }

        this.sessions.set(session.id, session);
        return { sessionId: session.id };
    }

    private scriptImplementation(session: Session): void {
        const { files, head } = implementChanges(session);
        for (const file of files) {
            const content = `// ${file} for ${session.runId} @ ${session.baseCommit}\nexport const done = true;\n`;
            void session.sandbox.writeTrackedFile(file, content);
            session.changedFiles.push(file);
            session.events.push({
                type: "file_change",
                data: { path: file, baseCommit: session.baseCommit },
            });
        }
        void session.sandbox.writeArtifact(`.plana/session-${session.runId}.md`, "progress notes\n");
        session.headCommit = head;
        session.events.push(
            { type: "validation", data: { command: "bun test", ok: true } },
            { type: "status", text: "self-review of diff complete" },
            {
                type: "completed",
                data: {
                    branchName: session.branchName,
                    baseCommit: session.baseCommit,
                    headCommit: head,
                    changedFiles: [...session.changedFiles],
                },
            }
        );
        session.phase = "implementing";
    }

    async *#gen(sessionId: string): AsyncGenerator<EngineEvent> {
        const session = this.require(sessionId);
        if (session.phase === "cancelled") {
            yield { type: "cancelled", data: { reason: "session cancelled before streaming" } };
            return;
        }
        if (session.phase !== "planning" && session.phase !== "implementing") {
            throw new EngineError(
                "SESSION_NOT_RUNNING",
                `session ${sessionId} is ${session.phase}; cannot stream events`,
                { sessionId, phase: session.phase }
            );
        }
        for (;;) {
            if (session.cancelCalls > 0) {
                yield { type: "cancelled", data: { reason: "engine cancelled by worker" } };
                return;
            }
            const event = session.events[session.streamStart];
            if (!event) {
                if (session.phase === "implementing" || session.phase === "planning") {
                    // IMPLEMENT streams to completion; PLAN streams end with
                    // the plan event and then idle until paused.
                    if (session.executionMode === "PLAN_AND_APPROVE") return;
                    yield { type: "cancelled", data: { reason: "engine output ended unexpectedly" } };
                    return;
                }
                return;
            }
            session.streamStart += 1;
            yield event;
            if (event.type === "completed") {
                session.phase = "done";
                return;
            }
            if (event.type === "plan" && session.executionMode === "PLAN_AND_APPROVE") {
                return;
            }
        }
    }

    streamEvents(sessionId: string): AsyncIterable<EngineEvent> {
        this.require(sessionId);
        const self = this;
        return {
            [Symbol.asyncIterator]: () => self.#gen(sessionId)[Symbol.asyncIterator](),
        };
    }

    async pauseForApproval(sessionId: string): Promise<EnginePauseResult> {
        const session = this.require(sessionId);
        if (session.phase !== "planning") {
            throw new EngineError(
                "SESSION_NOT_RUNNING",
                `session ${sessionId} is ${session.phase}; nothing to pause`,
                { sessionId, phase: session.phase }
            );
        }
        if (session.executionMode !== "PLAN_AND_APPROVE") {
            throw new EngineError(
                "SESSION_NOT_RUNNING",
                `${session.executionMode} runs do not pause for approval`,
                { sessionId }
            );
        }
        // NO tracked file has been touched at this point — proven by the
        // sandbox's tracked-path set in the conformance/worker tests.
        const checkpoint = await session.sandbox.checkpoint("awaiting-approval");
        session.phase = "awaiting_approval";
        return {
            planVersion: session.planVersion,
            plan: session.plan,
            checkpointId: checkpoint.id,
        };
    }

    async regeneratePlan(
        sessionId: string,
        input: { baseCommit?: string; reason: string }
    ): Promise<{ planVersion: number; plan: string }> {
        const session = this.require(sessionId);
        if (session.phase === "cancelled") {
            throw new EngineError("SESSION_CANCELLED", `session ${sessionId} is cancelled`, {
                sessionId,
            });
        }
        if (session.executionMode !== "PLAN_AND_APPROVE") {
            throw new EngineError(
                "SESSION_NOT_RUNNING",
                `${session.executionMode} runs have no approval plan to regenerate`,
                { sessionId }
            );
        }
        if (input.baseCommit && input.baseCommit !== session.baseCommit) {
            session.baseCommit = input.baseCommit;
        }
        session.planVersion += 1;
        session.phase = "planning";
        session.plan = planTextFor(session.runId, session.planVersion, session.baseCommit);
        session.streamStart = session.events.length;
        session.events.push(
            { type: "status", text: `re-inspecting against base ${session.baseCommit} (${input.reason})` },
            {
                type: "plan",
                text: session.plan,
                data: {
                    planVersion: session.planVersion,
                    baseCommit: session.baseCommit,
                    mode: "PLAN_AND_APPROVE",
                    regeneratedBecause: input.reason,
                },
            }
        );
        return { planVersion: session.planVersion, plan: session.plan };
    }

    async resume(
        sessionId: string,
        approved: EngineResumeInput
    ): Promise<{ sessionId: string }> {
        const session = this.require(sessionId);
        if (session.phase === "cancelled") {
            throw new EngineError(
                "SESSION_CANCELLED",
                `session ${sessionId} was cancelled; a late approval result cannot revive it`,
                { sessionId }
            );
        }
        if (session.phase !== "awaiting_approval") {
            throw new EngineError(
                "SESSION_NOT_RUNNING",
                `session ${sessionId} is ${session.phase}; resume requires AWAITING_APPROVAL`,
                { sessionId, phase: session.phase }
            );
        }
        // EXACT-match gate: the approved plan version and base commit must
        // still be current, otherwise NOTHING is implemented.
        if (
            approved.approvedPlanVersion !== session.planVersion ||
            approved.approvedBaseCommit !== session.baseCommit
        ) {
            throw new EngineError(
                "STALE_APPROVAL",
                `approval names plan v${approved.approvedPlanVersion} @ ${approved.approvedBaseCommit} but the session is at plan v${session.planVersion} @ ${session.baseCommit}; regenerate and re-approve`,
                {
                    sessionId,
                    approvedPlanVersion: approved.approvedPlanVersion,
                    currentPlanVersion: session.planVersion,
                    approvedBaseCommit: approved.approvedBaseCommit,
                    currentBaseCommit: session.baseCommit,
                }
            );
        }
        session.resumeCalls += 1;
        session.phase = "planning";
        session.streamStart = session.events.length;
        session.events.push({
            type: "status",
            text: `resuming against approved plan v${session.planVersion} @ ${session.baseCommit}`,
        });
        this.scriptImplementation(session);
        return { sessionId };
    }

    async sendInput(sessionId: string, text: string): Promise<{ delivered: true }> {
        const session = this.require(sessionId);
        if (session.phase === "cancelled") {
            throw new EngineError("SESSION_CANCELLED", `session ${sessionId} is cancelled`, {
                sessionId,
            });
        }
        session.inputs.push(text);
        return { delivered: true };
    }

    async cancel(sessionId: string): Promise<{ stopped: boolean }> {
        const session = this.require(sessionId);
        session.cancelCalls += 1;
        if (session.phase === "done") return { stopped: false };
        session.phase = "cancelled";
        return { stopped: true };
    }

    async exportSession(sessionId: string): Promise<EngineSessionExport> {
        const session = this.require(sessionId);
        const usage = await this.reportUsage(sessionId);
        return {
            sessionId: session.id,
            runId: session.runId,
            engine: session.engineId,
            model: session.model,
            executionMode: session.executionMode,
            repository: session.repository,
            baseCommit: session.baseCommit,
            planVersion: session.planVersion,
            phase: session.phase,
            usage,
            // The fake has no credentials to begin with; the redaction list
            // records the sanitizer passes a real adapter must run here.
            secretRedactions: usage.inputTokens + usage.outputTokens > 0
                ? ["model-gateway-token", "git-checkout-token"]
                : [],
        };
    }

    async reportUsage(sessionId: string): Promise<EngineUsageReport> {
        const session = this.require(sessionId);
        const calls =
            1 +
            session.resumeCalls +
            session.cancelCalls +
            session.inputs.length +
            Math.max(0, session.planVersion - 1);
        const inputTokens = calls * 300;
        const outputTokens = calls * 150;
        return {
            sessionId: session.id,
            engine: session.engineId,
            model: session.model,
            calls,
            inputTokens,
            outputTokens,
            costUsd: Number(((inputTokens + outputTokens) * 0.000004).toFixed(6)),
        };
    }

    /** Test/worker observability: current session phase. */
    sessionPhase(sessionId: string): string {
        return this.require(sessionId).phase;
    }
}
