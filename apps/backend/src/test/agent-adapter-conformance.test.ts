import { describe, expect, test } from "bun:test";
import {
    ENGINE_CAPABILITIES,
    type AgentEngineId,
    type RunExecutionModeId,
} from "../adapters/capabilities";
import {
    EngineError,
    SandboxError,
    type EngineErrorCode,
    type EngineEvent,
} from "../adapters/contract";
import { FakeEngineAdapter } from "../adapters/fakeEngine";
import {
    DEFAULT_REPO_FILES,
    createFakeSandboxFactory,
} from "../adapters/fakeSandbox";
import { createFakeOnlyRegistry } from "../adapters/registry";

// CP5 EVIDENCE — adapter conformance.
//
// One shared checklist per contract surface, run against EVERY fake
// implementation: the fake sandbox, and one fake engine adapter per engine
// the capability catalog marks available (CODEX, CLAUDE_CODE, OPENCODE).
// The results prove the fakes satisfy their contracts IDENTICALLY — same
// checks, same outcomes, implementation after implementation. The PI rules
// live here too: unavailable selections are hard, reasoned rejections;
// nothing is ever substituted and engines are never switched.

type Check = { name: string; passed: boolean; detail?: string };

const runCheck = async (name: string, fn: () => Promise<void>): Promise<Check> => {
    try {
        await fn();
        return { name, passed: true };
    } catch (error) {
        return { name, passed: false, detail: String(error) };
    }
};

const assert = (condition: unknown, message: string): void => {
    if (!condition) throw new Error(message);
};

const expectEngineError = async (
    fn: () => Promise<unknown>,
    code: EngineErrorCode,
    messageIncludes?: string
): Promise<EngineError> => {
    let thrown: unknown = null;
    try {
        await fn();
    } catch (error) {
        thrown = error;
    }
    assert(thrown !== null, `expected EngineError ${code}, nothing was thrown`);
    assert(
        thrown instanceof EngineError && thrown.code === code,
        `expected EngineError ${code}, got ${String(thrown)}`
    );
    if (messageIncludes) {
        assert(
            (thrown as EngineError).message.includes(messageIncludes),
            `error message must mention '${messageIncludes}', got: ${(thrown as EngineError).message}`
        );
    }
    return thrown as EngineError;
};

const drain = async (stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> => {
    const events: EngineEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
};

const MODEL_BY_ENGINE: Record<string, string> = {
    CODEX: "gpt-5",
    CLAUDE_CODE: "claude-sonnet-4",
    OPENCODE: "opencode-linear",
};

const AVAILABLE_ENGINES = (Object.keys(ENGINE_CAPABILITIES) as AgentEngineId[]).filter(
    (id) => ENGINE_CAPABILITIES[id].available
);
const PAA_ENGINES = AVAILABLE_ENGINES.filter(
    (id) => ENGINE_CAPABILITIES[id].executionModes.PLAN_AND_APPROVE.available
);

const engineFixture = (engineId: AgentEngineId, executionMode: RunExecutionModeId) => {
    const adapter = new FakeEngineAdapter(engineId);
    const sandboxes = createFakeSandboxFactory();
    let seq = 0;
    const start = async (overrides: Record<string, unknown> = {}) => {
        seq += 1;
        const runId = `run_${engineId.toLowerCase()}_${seq}`;
        const { sandbox } = await sandboxes.connectOrRecreate(runId, {
            repository: "acme/web",
            baseCommit: "base-1",
        });
        const { sessionId } = await adapter.start({
            runId,
            repository: String(overrides.repository ?? "acme/web"),
            baseCommit: "base-1",
            executionMode: (overrides.executionMode as RunExecutionModeId) ?? executionMode,
            model: String(overrides.model ?? MODEL_BY_ENGINE[engineId]),
            options: (overrides.options as Record<string, unknown>) ?? {},
            instructions: "follow the card",
            sandbox,
        });
        return { runId, sessionId, sandbox, adapter };
    };
    return { adapter, sandboxes, start };
};

const INITIAL_TRACKED = Object.keys(DEFAULT_REPO_FILES).sort();

/** Shared engine contract checklist — every fake engine passes the SAME
 *  checks with the SAME outcomes. */
const runEngineConformanceChecks = async (engineId: AgentEngineId): Promise<Check[]> => {
    const spec = ENGINE_CAPABILITIES[engineId];
    const checks: Check[] = [];
    const add = async (name: string, fn: () => Promise<void>) =>
        checks.push(await runCheck(name, fn));

    await add("capabilities-come-from-shared-catalog", async () => {
        const { adapter } = engineFixture(engineId, "IMPLEMENT");
        assert(adapter.capabilities() === spec, "capabilities() must BE the shared EngineSpec object");
        assert(adapter.engineId === engineId, "adapter must report its engine id — never a switched one");
    });

    await add("implement-mode-streams-to-completion-and-changes-tracked-files", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, sandbox, adapter } = await start();
        const events = await drain(adapter.streamEvents(sessionId));
        const kinds = events.map((e) => e.type);
        assert(kinds[0] === "status" && kinds[1] === "output", "engine starts with read-only inspection");
        assert(kinds.includes("plan"), "IMPLEMENT streams a working plan");
        const completed = events.find((e) => e.type === "completed");
        assert(completed, "IMPLEMENT stream must end with a completed event");
        const data = completed!.data as Record<string, unknown>;
        assert(data.headCommit === "head-of-base-1", `head commit mismatch: ${String(data.headCommit)}`);
        assert(Array.isArray(data.changedFiles) && data.changedFiles.length === 2, "two changed files");
        assert(String(data.branchName).startsWith("plana/"), "task branch recorded on the completion");
        const tracked = await sandbox.trackedPaths();
        assert(tracked.length === INITIAL_TRACKED.length + 2, "implementation wrote 2 tracked files");
        const files = sandbox.snapshotFiles();
        assert(".plana/session-notes.md" in files || Object.keys(files).some((f) => f.startsWith(".plana/")), "progress artifact written");
    });

    await add("cancel-stops-stream-and-yields-cancelled", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, adapter } = await start();
        const { stopped } = await adapter.cancel(sessionId);
        assert(stopped, "cancel reports the engine stopped");
        const events = await drain(adapter.streamEvents(sessionId));
        assert(events.length === 1 && events[0]!.type === "cancelled", "stream yields only a cancelled event");
    });

    await add("cancelled-session-rejects-later-work", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, adapter } = await start();
        await adapter.cancel(sessionId);
        await expectEngineError(() => adapter.sendInput(sessionId, "late"), "SESSION_CANCELLED");
        await expectEngineError(
            () => adapter.resume(sessionId, { approvedPlanVersion: 1, approvedBaseCommit: "base-1" }),
            "SESSION_CANCELLED"
        );
    });

    await add("send-input-records-message", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, adapter } = await start();
        const { delivered } = await adapter.sendInput(sessionId, "please also update docs");
        assert(delivered, "sendInput confirms delivery");
        const usage = await adapter.reportUsage(sessionId);
        assert(usage.calls === 2, `usage must count the message (calls=2), got ${usage.calls}`);
    });

    await add("session-export-is-credential-free", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, adapter } = await start();
        const exported = await adapter.exportSession(sessionId);
        const json = JSON.stringify(exported);
        assert(
            !/(api[_-]?key|password|authorization|bearer)\s*[:=]/i.test(json),
            "exports must not carry credential-looking values"
        );
        assert(Array.isArray(exported.secretRedactions), "export declares its sanitizer passes");
        assert(exported.engine === engineId, "export must name the SAME engine — never a switched one");
    });

    await add("usage-report-is-accountable", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const { sessionId, adapter } = await start();
        const usage = await adapter.reportUsage(sessionId);
        assert(usage.calls >= 1 && usage.inputTokens === usage.calls * 300, "token accounting is coherent");
        assert(usage.costUsd > 0, "usage reports cost for budget metering");
    });

    await add("unavailable-model-is-rejected-never-substituted", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const retired = spec.models.find((m) => !m.available);
        assert(retired, "catalog must list an unavailable model for this engine");
        const error = await expectEngineError(
            () => start({ model: retired!.id }),
            "UNSUPPORTED_CAPABILITY",
            retired!.id
        );
        assert(retired!.reason !== undefined, "catalog reason exists");
        assert(retired!.reason!.length > 10, "catalog reason is explicit");
        assert(error.message.includes(retired!.reason!), "rejection carries the catalog reason");
        assert((error.details as any).substituted === false, "adapter states it substituted NOTHING");
    });

    await add("unknown-model-and-unknown-option-are-rejected", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        await expectEngineError(() => start({ model: "definitely-not-a-model" }), "UNSUPPORTED_CAPABILITY");
        await expectEngineError(
            () => start({ options: { mysteryKnob: "loud" } }),
            "UNSUPPORTED_CAPABILITY",
            "mysteryKnob"
        );
    });

    await add("plan-mode-availability-matches-catalog-exactly", async () => {
        const { start } = engineFixture(engineId, "IMPLEMENT");
        const paa = spec.executionModes.PLAN_AND_APPROVE;
        if (paa.available) {
            const { sessionId } = await start({ executionMode: "PLAN_AND_APPROVE" });
            assert(sessionId, "supported engines accept PLAN_AND_APPROVE");
        } else {
            assert(paa.reason !== undefined, "catalog states why the mode is unavailable");
            const error = await expectEngineError(
                () => start({ executionMode: "PLAN_AND_APPROVE" }),
                "UNSUPPORTED_CAPABILITY",
                paa.reason!
            );
            assert((error.details as any).substituted === false, "no silent mode substitution");
        }
    });

    return checks;
};

/** PLAN_AND_APPROVE deep checks — run identically on engines whose catalog
 *  entry supports the mode. */
const runPlanModeConformanceChecks = async (engineId: AgentEngineId): Promise<Check[]> => {
    const checks: Check[] = [];
    const add = async (name: string, fn: () => Promise<void>) =>
        checks.push(await runCheck(name, fn));

    const pausedFixture = async () => {
        const fixture = engineFixture(engineId, "PLAN_AND_APPROVE");
        const started = await fixture.start();
        const planEvents = await drain(started.adapter.streamEvents(started.sessionId));
        assert(planEvents.some((e) => e.type === "plan"), "plan event streamed");
        const pause = await started.adapter.pauseForApproval(started.sessionId);
        return { ...started, pause, ...fixture };
    };

    await add("plan-mode-makes-NO-tracked-file-change-before-approval", async () => {
        const { sandbox, pause } = await pausedFixture();
        const tracked = await sandbox.trackedPaths();
        assert(
            JSON.stringify(tracked) === JSON.stringify(INITIAL_TRACKED),
            `tracked set must be untouched pre-approval, got ${JSON.stringify(tracked)}`
        );
        assert(pause.plan.includes("Plan v1"), "plan text returned");
    });

    await add("pause-checkpoints-workspace-for-recovery", async () => {
        const { sandbox, pause } = await pausedFixture();
        assert(pause.checkpointId === "ckpt_1", "checkpoint id returned");
        const last = sandbox.checkpoints.at(-1)!;
        assert(last.reason === "awaiting-approval", "checkpoint reason persisted");
        assert("README.md" in last.files, "workspace snapshotted for recovery");
    });

    await add("resume-rejects-wrong-plan-version-and-changes-nothing", async () => {
        const { sessionId, sandbox, adapter, pause } = await pausedFixture();
        const error = await expectEngineError(
            () => adapter.resume(sessionId, { approvedPlanVersion: pause.planVersion + 1, approvedBaseCommit: "base-1" }),
            "STALE_APPROVAL"
        );
        assert((error.details as any).currentPlanVersion === 1, "error explains the mismatch");
        const tracked = await sandbox.trackedPaths();
        assert(JSON.stringify(tracked) === JSON.stringify(INITIAL_TRACKED), "rejected resume changed NOTHING");
    });

    await add("resume-rejects-wrong-base-commit-and-changes-nothing", async () => {
        const { sessionId, sandbox, adapter, pause } = await pausedFixture();
        await expectEngineError(
            () => adapter.resume(sessionId, { approvedPlanVersion: pause.planVersion, approvedBaseCommit: "base-moved-9" }),
            "STALE_APPROVAL"
        );
        const tracked = await sandbox.trackedPaths();
        assert(JSON.stringify(tracked) === JSON.stringify(INITIAL_TRACKED), "rejected resume changed NOTHING");
    });

    await add("exact-approval-resume-streams-implementation-to-completion", async () => {
        const { sessionId, sandbox, adapter, pause } = await pausedFixture();
        await adapter.resume(sessionId, {
            approvedPlanVersion: pause.planVersion,
            approvedBaseCommit: "base-1",
        });
        const events = await drain(adapter.streamEvents(sessionId));
        assert(events.some((e) => e.type === "file_change"), "implementation streams file changes");
        const completed = events.find((e) => e.type === "completed");
        assert(completed, "streams to completion after the EXACT approval");
        assert((completed!.data as any).headCommit === "head-of-base-1", "head recorded");
        const tracked = await sandbox.trackedPaths();
        assert(tracked.length === INITIAL_TRACKED.length + 2, "tracked changes only AFTER approval");
    });

    await add("cancelled-awaiting-session-can-never-be-resumed", async () => {
        const { sessionId, adapter, pause } = await pausedFixture();
        await adapter.cancel(sessionId);
        await expectEngineError(
            () => adapter.resume(sessionId, { approvedPlanVersion: pause.planVersion, approvedBaseCommit: "base-1" }),
            "SESSION_CANCELLED"
        );
    });

    return checks;
};

const runSandboxConformanceChecks = async (): Promise<Check[]> => {
    const checks: Check[] = [];
    const add = async (name: string, fn: () => Promise<void>) =>
        checks.push(await runCheck(name, fn));
    const spec = { repository: "acme/web", baseCommit: "base-1" };

    await add("provision-is-one-shot", async () => {
        const factory = createFakeSandboxFactory();
        const sandbox = factory.create("run_s1", spec);
        assert(sandbox.state === "NEW", "fresh sandbox is NEW");
        await sandbox.provision();
        assert(sandbox.state === "RUNNING", "provision checks out the repo");
        let thrown: unknown = null;
        try {
            await sandbox.provision();
        } catch (error) {
            thrown = error;
        }
        assert(thrown instanceof SandboxError && thrown.code === "ALREADY_PROVISIONED", "second provision rejected");
    });

    await add("pause-resume-roundtrip-preserves-workspace", async () => {
        const factory = createFakeSandboxFactory();
        const { sandbox } = await factory.connectOrRecreate("run_s2", spec);
        await sandbox.writeTrackedFile("src/new.ts", "export const a = 1;\n");
        await sandbox.pause();
        assert(sandbox.state === "PAUSED", "paused");
        await sandbox.resume();
        assert((await sandbox.readTrackedFile("src/new.ts"))?.includes("export const a"), "workspace preserved");
    });

    await add("kill-is-terminal-for-operations", async () => {
        const factory = createFakeSandboxFactory();
        const { sandbox } = await factory.connectOrRecreate("run_s3", spec);
        await sandbox.kill();
        assert(sandbox.state === "KILLED", "killed");
        let thrown: unknown = null;
        try {
            await sandbox.writeTrackedFile("src/x.ts", "x");
        } catch (error) {
            thrown = error;
        }
        assert(thrown instanceof SandboxError && thrown.code === "KILLED", "writes rejected after kill");
        await sandbox.kill(); // idempotent
    });

    await add("checkpoint-includes-untracked-artifacts", async () => {
        const factory = createFakeSandboxFactory();
        const { sandbox } = await factory.connectOrRecreate("run_s4", spec);
        await sandbox.writeTrackedFile("src/mod.ts", "export const m = 1;\n");
        await sandbox.writeArtifact("progress/notes.md", "halfway\n");
        const checkpoint = await sandbox.checkpoint("stage-boundary");
        assert("src/mod.ts" in checkpoint.files, "tracked file in checkpoint");
        assert("progress/notes.md" in checkpoint.files, "UNTRACKED artifact in checkpoint (recovery needs it)");
        assert(checkpoint.tracked.includes("src/mod.ts") && !checkpoint.tracked.includes("progress/notes.md"), "tracked set excludes artifacts");
        assert(checkpoint.id === "ckpt_1", "checkpoint ids are monotonic");
    });

    await add("connect-or-recreate-resumes-paused-machine-first", async () => {
        const factory = createFakeSandboxFactory();
        const first = await factory.connectOrRecreate("run_s6", spec);
        await first.sandbox.pause();
        const second = await factory.connectOrRecreate("run_s6", spec);
        assert(second.sandbox === first.sandbox, "connect BEFORE replacing");
        assert(second.recreated === false, "same machine, not a replacement");
        assert(second.sandbox.state === "RUNNING", "paused machine auto-resumed");
    });

    await add("lost-machine-is-recreated-from-last-checkpoint", async () => {
        const factory = createFakeSandboxFactory();
        const first = await factory.connectOrRecreate("run_s8", spec);
        await first.sandbox.writeTrackedFile("src/kept.ts", "kept\n");
        await first.sandbox.checkpoint("stage-boundary");
        await first.sandbox.writeTrackedFile("src/lost.ts", "lost\n");
        await first.sandbox.kill();
        const recreated = await factory.connectOrRecreate("run_s8", spec);
        assert(recreated.recreated === true, "replacement created only after the machine is lost");
        assert(recreated.sandbox !== first.sandbox, "fresh machine");
        const files = recreated.sandbox.snapshotFiles();
        assert("src/kept.ts" in files, "last checkpoint restored");
        assert(!("src/lost.ts" in files), "writes after the last checkpoint are gone (documented recovery point)");
        assert(recreated.sandbox.state === "RUNNING", "recreated machine is live");
    });

    await add("tracked-changes-are-observable", async () => {
        const factory = createFakeSandboxFactory();
        const { sandbox } = await factory.connectOrRecreate("run_s10", spec);
        assert(JSON.stringify(await sandbox.trackedPaths()) === JSON.stringify(INITIAL_TRACKED), "initial tracked set");
        await sandbox.writeTrackedFile("src/feature.ts", "export const f = 1;\n");
        const tracked = await sandbox.trackedPaths();
        assert(tracked.includes("src/feature.ts"), "tracked change visible to the contract");
    });

    await add("sandbox-exposes-no-credential-surface", async () => {
        const factory = createFakeSandboxFactory();
        const { sandbox } = await factory.connectOrRecreate("run_s12", spec);
        const names = [...Object.keys(sandbox), ...Object.getOwnPropertyNames(Object.getPrototypeOf(sandbox))];
        for (const name of names) {
            assert(
                !/(token|secret|password|apikey|credential|privatekey)/i.test(name),
                `property '${name}' looks like a credential surface`
            );
        }
    });

    return checks;
};

describe("fake sandbox satisfies the Sandbox contract", () => {
    test("every sandbox conformance check passes", async () => {
        const checks = await runSandboxConformanceChecks();
        const failed = checks.filter((c) => !c.passed);
        expect(checks.length).toBeGreaterThanOrEqual(8);
        expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    });
});

describe("fake engine adapters satisfy the EngineAdapter contract IDENTICALLY", () => {
    const results = new Map<string, Check[]>();

    test("engine catalogue under test is the available set (CODEX, CLAUDE_CODE, OPENCODE)", () => {
        expect(AVAILABLE_ENGINES.sort()).toEqual(["CLAUDE_CODE", "CODEX", "OPENCODE"]);
        expect(PAA_ENGINES.sort()).toEqual(["CLAUDE_CODE", "CODEX"]);
    });

    test("every available-engine adapter passes the full shared checklist", async () => {
        for (const engineId of AVAILABLE_ENGINES) {
            const checks = await runEngineConformanceChecks(engineId);
            results.set(engineId, checks);
            const failed = checks.filter((c) => !c.passed);
            expect(failed.map((f) => `${engineId}/${f.name}: ${f.detail}`)).toEqual([]);
        }
        expect(results.get("CODEX")!.length).toBeGreaterThanOrEqual(10);
    });

    test("checklists are IDENTICAL across fake engine implementations (same checks, same outcomes)", () => {
        const signatures: Array<[string, string[]]> = [...results.entries()].map(
            ([engineId, checks]): [string, string[]] => [
                engineId,
                checks.map((c) => `${c.name}=${c.passed}`),
            ]
        );
        const [firstEngine, firstSig] = signatures[0] as [string, string[]];
        for (const [engineId, signature] of signatures.slice(1)) {
            expect(signature).toEqual(firstSig);
            expect(engineId.length).toBeGreaterThan(0);
        }
    });

    test("PLAN_AND_APPROVE engines share an IDENTICAL plan-mode checklist (no tracked change before approval, exact-match resume gates)", async () => {
        const signatures: Array<[string, string[]]> = [];
        for (const engineId of PAA_ENGINES) {
            const checks = await runPlanModeConformanceChecks(engineId);
            const failed = checks.filter((c) => !c.passed);
            expect(failed.map((f) => `${engineId}/${f.name}: ${f.detail}`)).toEqual([]);
            signatures.push([engineId, checks.map((c) => `${c.name}=${c.passed}`)]);
        }
        expect(signatures.length).toBe(2);
        expect(signatures[1]![1]).toEqual(signatures[0]![1]);
    });
});

describe("PI + registry gating: never shipped, never substituted", () => {
    test("PI is catalogued unavailable with an explicit never-substitute reason", () => {
        const spec = ENGINE_CAPABILITIES.PI;
        expect(spec.available).toBe(false);
        expect(spec.reason).toContain("NEVER substituted");
        expect(ENGINE_CAPABILITIES.PI.models.every((m) => !m.available)).toBe(true);
    });

    test("the container registry exposes ONLY fake adapters and no PI entry", () => {
        const registry = createFakeOnlyRegistry();
        expect(registry.describe()).toEqual([
            "CLAUDE_CODE=fake:CLAUDE_CODE",
            "CODEX=fake:CODEX",
            "OPENCODE=fake:OPENCODE",
        ]);
        expect(registry.get("PI")).toBeUndefined();
    });

    test("require('PI') fails with the catalog reason and substitutes nothing", () => {
        const registry = createFakeOnlyRegistry();
        let thrown: unknown = null;
        try {
            registry.require("PI");
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(EngineError);
        const error = thrown as EngineError;
        expect(error.code).toBe("UNSUPPORTED_CAPABILITY");
        expect(error.message).toContain("has not shipped");
        expect((error.details as any).substituted).toBe(false);
        expect((error.details as any).registeredAdapters).toEqual(["CODEX", "CLAUDE_CODE", "OPENCODE"]);
    });

    test("unknown engines also fail without substitution", () => {
        const registry = createFakeOnlyRegistry();
        expect(() => registry.require("CLAUDE")).toThrowError(/never substituted|no adapter exists/i);
    });
});
