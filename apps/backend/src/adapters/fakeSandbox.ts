import { SandboxError, type ExecResult, type FakeCheckpoint, type Sandbox, type SandboxState,
} from "./contract";

// FAKE in-memory sandbox (CP5). This is what the worker drives in tests — it
// is NOT a claim that E2B was exercised (see the UNVERIFIED ledger). It models
// the parts the run lifecycle depends on:
//
//   * one machine per run; connect-or-recreate BEFORE replacing;
//   * pause preserves the filesystem; kill loses it except via checkpoints;
//   * checkpoints include untracked artifacts (recovery needs them) and there
//     are no credentials anywhere to leak;
//   * tracked-file changes are observable so PLAN_AND_APPROVE can be proven
//     to touch nothing before approval.

export const DEFAULT_REPO_FILES: Record<string, string> = {
    "README.md": "# demo repository\n",
    "src/index.ts": "export const main = () => 0;\n",
    "package.json": `{ "name": "demo", "scripts": { "test": "bun test" } }\n`,
};

export type FakeSandboxSpec = {
    repository: string;
    baseCommit: string;
    headCommit?: string;
    initialFiles?: Record<string, string>;
    tracked?: string[];
};

class FakeSandbox implements Sandbox {
    readonly runId: string;
    readonly repository: string;
    readonly baseCommit: string;
    readonly calls: string[] = [];

    private _state: SandboxState = "NEW";
    private _files: Record<string, string>;
    private _tracked: Set<string>;
    private _headCommit: string | null;
    private _checkpoints: FakeCheckpoint[] = [];

    constructor(runId: string, spec: FakeSandboxSpec) {
        this.runId = runId;
        this.repository = spec.repository;
        this.baseCommit = spec.baseCommit;
        this._files = { ...(spec.initialFiles ?? DEFAULT_REPO_FILES) };
        this._tracked = new Set(spec.tracked ?? Object.keys(this._files));
        this._headCommit = spec.headCommit ?? spec.baseCommit;
    }

    get state(): SandboxState {
        return this._state;
    }

    get headCommit(): string | null {
        return this._headCommit;
    }

    get checkpoints(): readonly FakeCheckpoint[] {
        return this._checkpoints;
    }

    restoreWorkspace(spec: FakeSandboxSpec) {
        if (spec.initialFiles) {
            this._files = { ...spec.initialFiles };
            this._tracked = new Set(
                spec.tracked ?? Object.keys(spec.initialFiles),
            );
            this._headCommit = spec.headCommit ?? spec.baseCommit;
        }
    }

    /** Test observability: full current workspace including artifacts. */
    snapshotFiles(): Record<string, string> {
        return { ...this._files };
    }

    private requireRunning(op: string): void {
        if (this._state === "KILLED") {
            throw new SandboxError("KILLED", `sandbox for ${this.runId} is killed; cannot ${op}`,
            );
        }
        if (this._state !== "RUNNING") {
            throw new SandboxError("NOT_RUNNING", `sandbox for ${this.runId} is ${this._state}; cannot ${op}`,
            );
        }
    }

    async provision(): Promise<void> {
        if (this._state !== "NEW") {
            throw new SandboxError(
                "ALREADY_PROVISIONED",
                `sandbox for ${this.runId} already provisioned (${this._state})`,
            );
        }
        this.calls.push("provision");
        this._state = "RUNNING";
    }

    async pause(): Promise<void> {
        this.requireRunning("pause");
        this.calls.push("pause");
        this._state = "PAUSED";
    }

    async resume(): Promise<void> {
        if (this._state === "KILLED") {
            throw new SandboxError("KILLED", `sandbox for ${this.runId} is killed`,
            );
        }
        if (this._state !== "PAUSED") {
            throw new SandboxError("NOT_PAUSED", `sandbox for ${this.runId} is ${this._state}`,
            );
        }
        this.calls.push("resume");
        this._state = "RUNNING";
    }

    async kill(): Promise<void> {
        if (this._state === "KILLED") return;
        this.calls.push("kill");
        this._state = "KILLED";
    }

    async checkpoint(reason: string): Promise<FakeCheckpoint> {
        if (this._state === "KILLED") {
            throw new SandboxError("KILLED", `sandbox for ${this.runId} is killed; cannot checkpoint`,
            );
        }
        this.calls.push(`checkpoint:${reason}`);
        const checkpoint: FakeCheckpoint = {
            id: `ckpt_${this._checkpoints.length + 1}`,
            at: new Date().toISOString(),
            reason,
            files: { ...this._files },
            tracked: [...this._tracked],
            headCommit: this._headCommit,
        };
        this._checkpoints.push(checkpoint);
        return checkpoint;
    }

    async writeTrackedFile(path: string, content: string): Promise<boolean> {
        this.requireRunning(`write tracked file ${path}`);
        this.calls.push(`write-tracked:${path}`);
        this._files[path] = content;
        this._tracked.add(path);
        return true;
    }

    async writeArtifact(path: string, content: string): Promise<boolean> {
        this.requireRunning(`write artifact ${path}`);
        this.calls.push(`write-artifact:${path}`);
        this._files[path] = content;
        return true;
    }

    async readTrackedFile(path: string): Promise<string | null> {
        this.requireRunning(`read ${path}`);
        if (!this._tracked.has(path)) return null;
        return this._files[path] ?? null;
    }

    async trackedPaths(): Promise<string[]> {
        if (this._state === "KILLED") {
            throw new SandboxError("KILLED", `sandbox for ${this.runId} is killed`,
            );
        }
        return [...this._tracked].sort();
    }

    async exec(command: string): Promise<ExecResult> {
        this.requireRunning(`exec ${command}`);
        this.calls.push(`exec:${command}`);
        if (command.startsWith("git commit --fake-head "))
            this._headCommit = command.slice("git commit --fake-head ".length);
        const stdout = command.includes("test")
            ? "1 test pass / 0 fail"
            : command.includes("diff")
              ? [...this._tracked].join("\n")
              : "ok";
        return { ok: true, stdout };
    }
}

export type FakeSandboxHandle = FakeSandbox;

export type { SandboxFactory } from "./contract";
import type { SandboxFactory } from "./contract";

export const createFakeSandboxFactory = () => {
    const registry = new Map<string, FakeSandbox>();
    let createdCount = 0;

    const factory = {
        connectOrRecreate: async (runId: string, spec: FakeSandboxSpec) => {
            const existing = registry.get(runId);
            if (existing && existing.state !== "KILLED") {
                existing.restoreWorkspace(spec);
                if (existing.state === "PAUSED") {
                    await existing.resume();
                    return { sandbox: existing, recreated: false };
                }
                return { sandbox: existing, recreated: false };
            }
            // Lost/killed machine: recreate from the LAST checkpoint when one
            // exists (recovery semantics), otherwise a clean checkout.
            const spec2: FakeSandboxSpec = {
                repository: existing?.repository ?? spec.repository,
                baseCommit: existing?.baseCommit ?? spec.baseCommit,
                tracked: existing?.checkpoints.at(-1)?.tracked ?? spec.tracked,
                initialFiles: existing
                    ? { ...(existing.checkpoints.at(-1)?.files ?? {}) }
                    : spec.initialFiles,
                headCommit: existing?.headCommit ?? undefined,
            };
            const fresh = new FakeSandbox(runId, spec2);
            createdCount += 1;
            registry.set(runId, fresh);
            await fresh.provision();
            fresh.calls.push(existing ? "recreated" : "provisioned-fresh");
            return { sandbox: fresh, recreated: Boolean(existing) };
        },

        create: (runId: string, spec: FakeSandboxSpec) => {
            const sandbox = new FakeSandbox(runId, spec);
            createdCount += 1;
            registry.set(runId, sandbox);
            return sandbox;
        },

        destroy: async(runId:string) => {
            // A tombstone lets tests inspect a deletion performed by another
            // process. It has no provision() call and consumes no machine slot.
            const sandbox=registry.get(runId)??new FakeSandbox(runId,{repository:"",baseCommit:"",initialFiles:{}});
            registry.set(runId,sandbox);
            await sandbox.kill();
        },
        byRun: (runId: string) => registry.get(runId),

        get createdCount() {
            return createdCount;
        },
    };

    return factory;
};

export type FakeSandboxFactory = ReturnType<typeof createFakeSandboxFactory>;
