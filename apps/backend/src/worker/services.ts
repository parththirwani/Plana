import type { Sandbox } from "../adapters/contract";
import type { AgentRunRow } from "../runs/dbTypes";
import type { RunRuntime, CheckEvidence, PublicationAck } from "./runtime";

export type Checks = {
    validate(sandbox: Sandbox, signal: AbortSignal): Promise<CheckEvidence>;
    review(
        sandbox: Sandbox,
        artifact: NonNullable<RunRuntime["artifact"]>,
        signal: AbortSignal,
    ): Promise<CheckEvidence>;
};
export type Publisher = {
    // Implementations must reconcile by run/branch/head before retrying an
    // external operation, and call authorize immediately before each effect.
    publish(input: {
        run: AgentRunRow;
        artifact: NonNullable<RunRuntime["artifact"]>;
        headCommit: string;
        authorize: () => Promise<void>;
        signal: AbortSignal;
    }): Promise<PublicationAck | null>;
};
export const fakeChecks: Checks = {
    validate: async (sandbox, signal) => {
        signal.throwIfAborted();
        const r = await sandbox.exec("bun test");
        return {
            ok: r.ok,
            command: "bun test",
            output: r.stdout,
            source: "worker",
            mode: "fake",
        };
    },
    review: async (sandbox, _artifact, signal) => {
        signal.throwIfAborted();
        const r = await sandbox.exec("git diff --check");
        return {
            ok: r.ok,
            command: "git diff --check (fake fresh review)",
            output: r.stdout,
            source: "worker",
            mode: "fake",
        };
    },
};
export const fakePublisher: Publisher = {
    publish: async ({ run, headCommit, authorize, signal }) => {
        signal.throwIfAborted();
        await authorize();
        return {
            id: `fake:${run.id}:${headCommit}`,
            headCommit,
            branch: run.branchName,
        };
    },
};
