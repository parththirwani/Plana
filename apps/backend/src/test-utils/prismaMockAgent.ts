import type { MockSeed } from "./prismaMock";

export type MockAgentRun = {
    id: string;
    issueId: string;
    organizationId: string;
    createdBy: string;
    engine: string;
    model: string;
    options: Record<string, unknown>;
    executionMode: string;
    repository: string;
    baseCommit: string | null;
    branchName: string;
    status: string;
    activeIssueId: string | null;
    /// Instant the worker first started executing (CP-D resume detection).
    /// Optional so pre-existing seeds keep compiling — the fake defaults it to
    /// null, which is exactly what the column means for a never-started run.
    attemptedAt?: string | null;
    planVersion: number;
    owner: string | null;
    leaseExpiresAt: Date | string | null;
    fencingToken: number;
    idempotencyKey: string;
    createdAt: string;
    updatedAt: string;
};

export type MockRunEvent = {
    id: string;
    runId: string;
    sequence: number;
    type: string;
    data: unknown;
    createdAt: string;
};

export type MockRunApproval = {
    id: string;
    runId: string;
    planVersion: number;
    decision: string;
    baseCommit: string;
    decidedBy: string;
    decidedAt: string;
};

export type MockAgentJob = {
    id: string;
    type: string;
    runId: string | null;
    payload: Record<string, unknown>;
    status: string;
    idempotencyKey: string | null;
    attempts: number;
    maxAttempts: number;
    availableAt: string;
    lockedBy: string | null;
    lockedAt: string | null;
    leaseExpiresAt: string | null;
    fencingToken: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
};

export type MockOrgAgentConfig = {
    id: string;
    organizationId: string;
    allowedRepositories: string[];
    defaultEngine: string | null;
    defaultModel: string | null;
    defaultExecutionMode: string;
    runBudgetUsd: number;
    dailyOrgBudgetUsd: number;
    createdAt: string;
    updatedAt: string;
};

export const num = (value: unknown) =>
    value instanceof Date ? value.getTime() : (value as any);

export const uniqueViolation = (target: string) => ({
    code: "P2002",
    meta: { target: target.split(", ") },
    message: `Unique constraint failed on the fields: (\`${target}\`)`,
});

export const matchesWhere = (value: unknown, clause: any) => {
    if (clause === undefined) return true;
    if (clause && typeof clause === "object" && !Array.isArray(clause)) {
        if ("in" in clause) {
            return (clause as any).in.includes(value);
        }
        if ("equals" in clause) {
            return value === (clause as any).equals;
        }
        for (const op of ["gt", "gte", "lt", "lte"] as const) {
            if (op in clause) {
                const a = num(value);
                const b = num(clause[op]);
                if (op === "gt" && !(a > b)) return false;
                if (op === "gte" && !(a >= b)) return false;
                if (op === "lt" && !(a < b)) return false;
                if (op === "lte" && !(a <= b)) return false;
            }
        }
        if (["gt", "gte", "lt", "lte"].some((op) => op in clause)) {
            return true;
        }
        return value === clause;
    }
    return value === clause;
};

export const applyOrderBy = (rows: any[], orderBy: any) => {
    if (!orderBy) return rows;
    const entries: any[] = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
        for (const entry of entries) {
            for (const key of Object.keys(entry)) {
                const dir = entry[key] === "desc" ? -1 : 1;
                const av = num(a[key]);
                const bv = num(b[key]);
                if (av < bv) return -1 * dir;
                if (av > bv) return 1 * dir;
            }
        }
        return 0;
    });
};

export const applyPage = (rows: any[], skip?: number, take?: number) => {
    let result = rows;
    if (typeof skip === "number") result = result.slice(skip);
    if (typeof take === "number") result = result.slice(0, take);
    return result;
};

export type MockActiveSlot = {
    issueId: string;
    organizationId: string;
    runId: string;
    acquiredAt: string;
};

export type MockLeaseRenewal = {
    id: string;
    runId: string;
    machineId: string;
    fencingToken: number;
    leaseExpiresAt: string;
    reason: string;
    createdAt: string;
};

export const createAgentFakes = (nextId: (prefix: string) => string) => {
    let agentRuns: MockAgentRun[] = [];
    let runEvents: MockRunEvent[] = [];
    let runApprovals: MockRunApproval[] = [];
    let orgAgentConfigs: MockOrgAgentConfig[] = [];
    let agentJobs: MockAgentJob[] = [];
    let activeSlots: MockActiveSlot[] = [];
    let leaseRenewals: MockLeaseRenewal[] = [];

    /** Full agent-state snapshot. The state machine runs every mutation in one
     *  interactive `$transaction`, and the mock MUST share that semantics: a
     *  rolled-back launch has to leave no run row, no event and no slot, or the
     *  mock would silently bless exactly the stranded-active-run bug the real
     *  implementation is designed to prevent. */
    const snapshotAgentState = () => ({
        agentRuns: agentRuns.map((r) => ({ ...r })),
        runEvents: runEvents.map((e) => ({ ...e })),
        runApprovals: runApprovals.map((a) => ({ ...a })),
        orgAgentConfigs: orgAgentConfigs.map((c) => ({ ...c })),
        agentJobs: agentJobs.map((j) => ({ ...j })),
        activeSlots: activeSlots.map((s) => ({ ...s })),
        leaseRenewals: leaseRenewals.map((r) => ({ ...r })),
    });

    const restoreAgentState = (state: ReturnType<typeof snapshotAgentState>) => {
        agentRuns = state.agentRuns.map((r) => ({ ...r }));
        runEvents = state.runEvents.map((e) => ({ ...e }));
        runApprovals = state.runApprovals.map((a) => ({ ...a }));
        orgAgentConfigs = state.orgAgentConfigs.map((c) => ({ ...c }));
        agentJobs = state.agentJobs.map((j) => ({ ...j }));
        activeSlots = state.activeSlots.map((s) => ({ ...s }));
        leaseRenewals = state.leaseRenewals.map((r) => ({ ...r }));
    };

    const matchAgentRun = (run: MockAgentRun, where: any) =>
        (where?.id === undefined || run.id === where.id) &&
        matchesWhere(run.issueId, where?.issueId) &&
        matchesWhere(run.organizationId, where?.organizationId) &&
        matchesWhere(run.status, where?.status) &&
        matchesWhere(run.engine, where?.engine) &&
        matchesWhere(run.executionMode, where?.executionMode) &&
        matchesWhere(run.idempotencyKey, where?.idempotencyKey) &&
        (where?.activeIssueId === undefined ||
            run.activeIssueId === where.activeIssueId) &&
        (where?.owner === undefined || run.owner === where.owner) &&
        // `OR` over partial clauses: the lease claim admits "already mine",
        // "nobody's" or "expired", and at least one branch must match. Without
        // this the mock would silently reject every claim that a real
        // Postgres accepts, and the lease tests would prove nothing.
        (where?.OR === undefined ||
            (Array.isArray(where.OR) &&
                where.OR.some((branch: any) => matchAgentRun(run, branch)))) &&
        (where?.AND === undefined ||
            (Array.isArray(where.AND) &&
                where.AND.every((branch: any) => matchAgentRun(run, branch))));

    /**
     * UNIQUE-index parity for AgentRun. `activeIssueId` (one active run per
     * issue) was already enforced here; `(organizationId, idempotencyKey)` is the
     * other Postgres unique index the launch path depends on: with a mock that
     * silently allowed a duplicate key, two concurrent launches would both
     * "succeed" and the atomic-replay behaviour the mock is supposed to model
     * would never be exercised.
     */
    const assertAgentRunUnique = (candidate: any, excludeId?: string) => {
        if (
            candidate.activeIssueId !== undefined &&
            candidate.activeIssueId !== null &&
            agentRuns.some(
                (r) =>
                    r.id !== excludeId &&
                    r.activeIssueId === candidate.activeIssueId
            )
        ) {
            throw uniqueViolation("activeIssueId");
        }
        if (
            candidate.organizationId !== undefined &&
            candidate.idempotencyKey !== undefined &&
            agentRuns.some(
                (r) =>
                    r.id !== excludeId &&
                    r.organizationId === candidate.organizationId &&
                    r.idempotencyKey === candidate.idempotencyKey
            )
        ) {
            throw uniqueViolation("organizationId, idempotencyKey");
        }
    };

    const matchRunEvent = (event: MockRunEvent, where: any) =>
        (where?.id === undefined || event.id === where.id) &&
        matchesWhere(event.runId, where?.runId) &&
        matchesWhere(event.sequence, where?.sequence) &&
        matchesWhere(event.type, where?.type);

    const matchRunApproval = (approval: MockRunApproval, where: any) =>
        (where?.id === undefined || approval.id === where.id) &&
        matchesWhere(approval.runId, where?.runId) &&
        matchesWhere(approval.planVersion, where?.planVersion) &&
        matchesWhere(approval.decision, where?.decision) &&
        matchesWhere(approval.decidedBy, where?.decidedBy);

    const organizationAgentConfig = {
        findUnique: async ({ where }: { where: any }) => {
            if (where?.id) {
                return orgAgentConfigs.find((c) => c.id === where.id) ?? null;
            }
            if (where?.organizationId) {
                return (
                    orgAgentConfigs.find(
                        (c) => c.organizationId === where.organizationId
                    ) ?? null
                );
            }
            return null;
        },
        findFirst: async ({ where }: { where: any }) =>
            orgAgentConfigs.find(
                (c) =>
                    (where?.organizationId === undefined ||
                        c.organizationId === where.organizationId) &&
                    matchesWhere(c.defaultEngine, where?.defaultEngine)
            ) ?? null,
        findMany: async ({ where }: { where: any }) =>
            orgAgentConfigs.filter(
                (c) =>
                    where?.organizationId === undefined ||
                    c.organizationId === where.organizationId
            ),
        create: async ({ data }: { data: any }) => {
            if (
                orgAgentConfigs.some(
                    (c) => c.organizationId === data.organizationId
                )
            ) {
                throw uniqueViolation("organizationId");
            }
            const now = new Date().toISOString();
            const config: MockOrgAgentConfig = {
                id: data.id ?? nextId("oac"),
                organizationId: data.organizationId,
                allowedRepositories: data.allowedRepositories ?? [],
                defaultEngine: data.defaultEngine ?? null,
                defaultModel: data.defaultModel ?? null,
                defaultExecutionMode: data.defaultExecutionMode ?? "IMPLEMENT",
                runBudgetUsd: data.runBudgetUsd ?? 5,
                dailyOrgBudgetUsd: data.dailyOrgBudgetUsd ?? 25,
                createdAt: now,
                updatedAt: now,
            };
            orgAgentConfigs.push(config);
            return config;
        },
        update: async ({ where, data }: { where: any; data: any }) => {
            const config = orgAgentConfigs.find(
                (c) =>
                    (where?.id !== undefined && c.id === where.id) ||
                    (where?.organizationId !== undefined &&
                        c.organizationId === where.organizationId)
            )!;
            Object.assign(config, data, {
                updatedAt: new Date().toISOString(),
            });
            return config;
        },
        upsert: async ({
            where,
            create,
            update,
        }: {
            where: any;
            create: any;
            update: any;
        }) => {
            const existing = orgAgentConfigs.find(
                (c) =>
                    (where?.id !== undefined && c.id === where.id) ||
                    (where?.organizationId !== undefined &&
                        c.organizationId === where.organizationId)
            );
            if (existing) {
                Object.assign(existing, update, {
                    updatedAt: new Date().toISOString(),
                });
                return existing;
            }
            return organizationAgentConfig.create({
                data: { ...create, organizationId: where.organizationId },
            });
        },
        delete: async ({ where }: { where: any }) => {
            const config = orgAgentConfigs.find(
                (c) =>
                    (where?.id !== undefined && c.id === where.id) ||
                    (where?.organizationId !== undefined &&
                        c.organizationId === where.organizationId)
            )!;
            orgAgentConfigs = orgAgentConfigs.filter(
                (c) => c.id !== config.id
            );
            return config;
        },
    };

/** Resolve a Prisma numeric field update (`{ increment / decrement / set }`)
 *  against the value the row currently holds. Lease claims raise the fencing
 *  token with `increment`, which is only correct relative to that row. */
const resolveNumericUpdate = (current: unknown, update: any): unknown => {
    if (update !== null && typeof update === "object" && !Array.isArray(update)) {
        if ("increment" in update)
            return Number(current ?? 0) + Number(update.increment);
        if ("decrement" in update)
            return Number(current ?? 0) - Number(update.decrement);
        if ("multiply" in update)
            return Number(current ?? 0) * Number(update.multiply);
        if ("set" in update && Object.keys(update).length === 1) return update.set;
    }
    return update;
};

/** Column names whose stored form must be an ISO string, so `matchesWhere`
 *  compares like with like (the state machine writes ISO strings). */
const ISO_COLUMNS = new Set(["leaseExpiresAt", "attemptedAt"]);

const isoColumn = (key: string, value: unknown) =>
    ISO_COLUMNS.has(key) && value instanceof Date ? value.toISOString() : value;

const iso = (value: unknown): string | null =>
    value === null || value === undefined
        ? null
        : value instanceof Date
          ? value.toISOString()
          : String(value);

const applyRunFields = (target: Record<string, any>, data: Record<string, any>) => {
    for (const [key, value] of Object.entries(data)) {
        target[key] = isoColumn(
            key,
            resolveNumericUpdate(target[key], value)
        );
    }
    return target;
};

const agentRun = {
        findUnique: async ({ where }: { where: any }) => {
            if (where?.id) {
                return agentRuns.find((r) => r.id === where.id) ?? null;
            }
            if (where?.activeIssueId !== undefined) {
                return (
                    agentRuns.find(
                        (r) => r.activeIssueId === where.activeIssueId
                    ) ?? null
                );
            }
            const compound = where?.organizationId_idempotencyKey;
            if (compound) {
                return (
                    agentRuns.find(
                        (r) =>
                            r.organizationId === compound.organizationId &&
                            r.idempotencyKey === compound.idempotencyKey
                    ) ?? null
                );
            }
            return null;
        },
        findUniqueOrThrow: async (args: { where: any }) => {
            const found = await agentRun.findUnique(args);
            if (!found) throw new Error(`agentRun not found: ${JSON.stringify(args.where)}`);
            return found;
        },
        findFirst: async ({ where }: { where: any }) =>
            agentRuns.find((r) => matchAgentRun(r, where)) ?? null,
        findMany: async ({
            where,
            orderBy,
            skip,
            take,
        }: {
            where: any;
            orderBy?: any;
            skip?: number;
            take?: number;
        }) =>
            applyPage(
                applyOrderBy(
                    agentRuns.filter((r) => matchAgentRun(r, where)),
                    orderBy
                ),
                skip,
                take
            ),
        count: async ({ where }: { where: any }) =>
            agentRuns.filter((r) => matchAgentRun(r, where)).length,
        create: async ({ data }: { data: any }) => {
            assertAgentRunUnique(data, undefined);
            const now = new Date().toISOString();
            const run: MockAgentRun = {
                id: data.id ?? nextId("run"),
                issueId: data.issueId,
                organizationId: data.organizationId,
                createdBy: data.createdBy,
                engine: data.engine,
                model: data.model,
                options: data.options ?? {},
                executionMode: data.executionMode ?? "IMPLEMENT",
                repository: data.repository,
                baseCommit: data.baseCommit ?? null,
                branchName: data.branchName,
                status: data.status ?? "QUEUED",
                activeIssueId: data.activeIssueId ?? null,
                attemptedAt: data.attemptedAt ?? null,
                planVersion: data.planVersion ?? 0,
                owner: data.owner ?? null,
                leaseExpiresAt: data.leaseExpiresAt ?? null,
                fencingToken: data.fencingToken ?? 0,
                idempotencyKey: data.idempotencyKey,
                createdAt: now,
                updatedAt: now,
            };
            agentRuns.push(run);
            return run;
        },
        update: async ({ where, data }: { where: any; data: any }) => {
            const run = agentRuns.find((r) => matchAgentRun(r, where))!;
            const merged = { ...run, ...data };
            assertAgentRunUnique(merged, run.id);
            applyRunFields(run, { ...data, updatedAt: new Date().toISOString() });
            return { ...run };
        },
        /** CONDITIONAL write — the shape the run state machine's guard uses
         *  (`where: { id, status }`). The count is the guard's answer: a status
         *  that moved underneath the caller matches zero rows, so a stale write
         *  changes nothing instead of overwriting the newer state. `{ increment }`
         *  and ISO columns go through the same applier as `update`. */
        updateMany: async ({ where, data }: { where: any; data: any }) => {
            const matches = agentRuns.filter((r) => matchAgentRun(r, where));
            for (const run of matches) {
                assertAgentRunUnique({ ...run, ...data }, run.id);
                applyRunFields(run, {
                    ...data,
                    updatedAt: new Date().toISOString(),
                });
            }
            return { count: matches.length, updated: matches.map((r) => ({ ...r })) };
        },
        delete: async ({ where }: { where: any }) => {
            const run = agentRuns.find((r) => r.id === where.id)!;
            agentRuns = agentRuns.filter((r) => r.id !== where.id);
            runEvents = runEvents.filter((e) => e.runId !== where.id);
            runApprovals = runApprovals.filter((a) => a.runId !== where.id);
            return run;
        },
    };

    const runEvent = {
        findFirst: async ({ where }: { where: any }) =>
            runEvents.find((e) => matchRunEvent(e, where)) ?? null,
        findMany: async ({
            where,
            orderBy,
            skip,
            take,
        }: {
            where: any;
            orderBy?: any;
            skip?: number;
            take?: number;
        }) =>
            applyPage(
                applyOrderBy(
                    runEvents.filter((e) => matchRunEvent(e, where)),
                    orderBy ?? { sequence: "asc" }
                ),
                skip,
                take
            ),
        count: async ({ where }: { where: any }) =>
            runEvents.filter((e) => matchRunEvent(e, where)).length,
        create: async ({ data }: { data: any }) => {
            if (
                runEvents.some(
                    (e) =>
                        e.runId === data.runId &&
                        e.sequence === data.sequence
                )
            ) {
                throw uniqueViolation("runId, sequence");
            }
            const event: MockRunEvent = {
                id: data.id ?? nextId("evt"),
                runId: data.runId,
                sequence: data.sequence,
                type: data.type,
                data: data.data ?? {},
                createdAt: new Date().toISOString(),
            };
            runEvents.push(event);
            return event;
        },
        /** Bulk append: the transactional event writer persists a status change
         *  and its companion events with ONE createMany, so the whole audit
         *  trail of a transition is a single atomic write (and a rolled-back
         *  transition leaves none of them behind). */
        createMany: async ({
            data,
            skipDuplicates,
        }: {
            data: any;
            skipDuplicates?: boolean;
        }) => {
            const rows = Array.isArray(data) ? data : [data];
            let count = 0;
            for (const row of rows) {
                const clash = runEvents.some(
                    (e) => e.runId === row.runId && e.sequence === row.sequence
                );
                if (clash) {
                    if (skipDuplicates) continue;
                    throw uniqueViolation("runId, sequence");
                }
                runEvents.push({
                    id: row.id ?? nextId("evt"),
                    runId: row.runId,
                    sequence: row.sequence,
                    type: row.type,
                    data: row.data ?? {},
                    createdAt: row.createdAt ?? new Date().toISOString(),
                });
                count += 1;
            }
            return { count };
        },
    };

    const runApproval = {
        findUnique: async ({ where }: { where: any }) => {
            if (where?.id) {
                return runApprovals.find((a) => a.id === where.id) ?? null;
            }
            const compound = where?.runId_planVersion;
            if (compound) {
                return (
                    runApprovals.find(
                        (a) =>
                            a.runId === compound.runId &&
                            a.planVersion === compound.planVersion
                    ) ?? null
                );
            }
            return null;
        },
        findFirst: async ({ where }: { where: any }) =>
            runApprovals.find((a) => matchRunApproval(a, where)) ?? null,
        findMany: async ({
            where,
            orderBy,
        }: {
            where: any;
            orderBy?: any;
        }) =>
            applyOrderBy(
                runApprovals.filter((a) => matchRunApproval(a, where)),
                orderBy
            ),
        count: async ({ where }: { where: any }) =>
            runApprovals.filter((a) => matchRunApproval(a, where)).length,
        create: async ({ data }: { data: any }) => {
            if (
                runApprovals.some(
                    (a) =>
                        a.runId === data.runId &&
                        a.planVersion === data.planVersion
                )
            ) {
                throw uniqueViolation("runId, planVersion");
            }
            const approval: MockRunApproval = {
                id: data.id ?? nextId("apv"),
                runId: data.runId,
                planVersion: data.planVersion,
                decision: data.decision,
                baseCommit: data.baseCommit,
                decidedBy: data.decidedBy,
                decidedAt: new Date().toISOString(),
            };
            runApprovals.push(approval);
            return approval;
        },
        update: async ({ where, data }: { where: any; data: any }) => {
            const approval = runApprovals.find((a) => a.id === where.id)!;
            Object.assign(approval, data);
            return approval;
        },
        delete: async ({ where }: { where: any }) => {
            const approval = runApprovals.find((a) => a.id === where.id)!;
            runApprovals = runApprovals.filter((a) => a.id !== where.id);
            return approval;
        },
    };

    const matchAgentJob = (job: MockAgentJob, where: any) =>
        (where?.id === undefined || job.id === where.id) &&
        matchesWhere(job.type, where?.type) &&
        (where?.runId === undefined || job.runId === where.runId) &&
        matchesWhere(job.status, where?.status) &&
        matchesWhere(job.idempotencyKey, where?.idempotencyKey) &&
        (where?.lockedBy === undefined || job.lockedBy === where.lockedBy) &&
        matchesWhere(job.availableAt, where?.availableAt) &&
        matchesWhere(job.leaseExpiresAt, where?.leaseExpiresAt);

    const assertAgentJobUnique = (candidate: any, excludeId?: string) => {
        if (
            candidate.idempotencyKey !== undefined &&
            candidate.idempotencyKey !== null &&
            agentJobs.some(
                (j) =>
                    j.id !== excludeId &&
                    j.idempotencyKey === candidate.idempotencyKey
            )
        ) {
            throw uniqueViolation("idempotencyKey");
        }
    };

    const agentJob = {
        findUnique: async ({ where }: { where: any }) => {
            if (where?.id !== undefined) {
                return agentJobs.find((j) => j.id === where.id) ?? null;
            }
            if (where?.idempotencyKey !== undefined) {
                return (
                    agentJobs.find(
                        (j) => j.idempotencyKey === where.idempotencyKey
                    ) ?? null
                );
            }
            return null;
        },
        findFirst: async ({ where }: { where: any }) =>
            agentJobs.find((j) => matchAgentJob(j, where)) ?? null,
        findMany: async ({
            where,
            orderBy,
            skip,
            take,
        }: {
            where: any;
            orderBy?: any;
            skip?: number;
            take?: number;
        }) =>
            applyPage(
                applyOrderBy(
                    agentJobs.filter((j) => matchAgentJob(j, where)),
                    orderBy
                ),
                skip,
                take
            ),
        count: async ({ where }: { where: any }) =>
            agentJobs.filter((j) => matchAgentJob(j, where)).length,
        create: async ({ data }: { data: any }) => {
            assertAgentJobUnique(data, undefined);
            const now = new Date().toISOString();
            const job: MockAgentJob = {
                id: data.id ?? nextId("job"),
                type: data.type,
                runId: data.runId ?? null,
                payload: data.payload ?? {},
                status: data.status ?? "QUEUED",
                idempotencyKey: data.idempotencyKey ?? null,
                attempts: data.attempts ?? 0,
                maxAttempts: data.maxAttempts ?? 5,
                availableAt: data.availableAt ?? now,
                lockedBy: data.lockedBy ?? null,
                lockedAt: data.lockedAt ?? null,
                leaseExpiresAt: data.leaseExpiresAt ?? null,
                fencingToken: data.fencingToken ?? 0,
                lastError: data.lastError ?? null,
                createdAt: now,
                updatedAt: now,
            };
            agentJobs.push(job);
            return job;
        },
        update: async ({ where, data }: { where: any; data: any }) => {
            const job = agentJobs.find((j) => j.id === where.id)!;
            assertAgentJobUnique({ ...job, ...data }, job.id);
            Object.assign(job, data, {
                updatedAt: new Date().toISOString(),
            });
            return job;
        },
        deleteMany: async ({ where }: { where: any }) => {
            const removed = agentJobs.filter((j) => matchAgentJob(j, where));
            agentJobs = agentJobs.filter((j) => !matchAgentJob(j, where));
            return { count: removed.length };
        },
    };

    /** Per-issue admission ticket. PRIMARY KEY(issueId) plus the UNIQUE(runId)
     *  the schema declares; the launch path inserts here and a duplicate is the
     *  DB-level backstop for "one active run per issue". */

    const runLeaseRenewal = {
        create: async ({ data }: { data: any }) => {
            const renewal: MockLeaseRenewal = {
                id: data.id ?? nextId("lrn"),
                runId: data.runId,
                machineId: data.machineId,
                fencingToken: data.fencingToken,
                leaseExpiresAt: iso(data.leaseExpiresAt) ?? "",
                reason: data.reason ?? "",
                createdAt: new Date().toISOString(),
            };
            leaseRenewals.push(renewal);
            return { ...renewal };
        },
        findMany: async ({ where }: { where?: any } = {}) =>
            leaseRenewals.filter(
                (r) =>
                    (where?.runId === undefined || r.runId === where.runId) &&
                    (where?.machineId === undefined || r.machineId === where.machineId)
            ),
        count: async ({ where }: { where?: any } = {}) =>
            leaseRenewals.filter(
                (r) => where?.runId === undefined || r.runId === where.runId
            ).length,
    };

    return {
        agentRun,
        runEvent,
        runApproval,
        organizationAgentConfig,
        agentJob,
        runLeaseRenewal,
        snapshotAgentState,
        restoreAgentState,
        /** The rows a `SELECT … FOR UPDATE` lock statement would return. The
         *  mock cannot block, but it can hand back the identical projection, so
         *  the state machine's lock path runs the same code here as against a
         *  live Postgres. */
        lockedRunRows: (issueId?: string, runId?: string) =>
            agentRuns
                .filter(
                    (r) =>
                        (issueId === undefined || r.activeIssueId === issueId) &&
                        (runId === undefined || r.id === runId)
                )
                .map((r) => ({ ...r })),
        allRows: () => [
            ...agentRuns,
            ...runEvents,
            ...runApprovals,
            ...orgAgentConfigs,
            ...agentJobs,
        ],
        resetAgentState: (seed: MockSeed) => {
            agentRuns = seed.agentRuns ?? [];
            runEvents = seed.runEvents ?? [];
            runApprovals = seed.runApprovals ?? [];
            orgAgentConfigs = seed.orgAgentConfigs ?? [];
            agentJobs = seed.agentJobs ?? [];
            activeSlots = (seed as any).activeSlots ?? [];
            leaseRenewals = (seed as any).leaseRenewals ?? [];
        },
        deleteRunsForIssue: (issueId: string) => {
            const runIds = agentRuns
                .filter((r) => r.issueId === issueId)
                .map((r) => r.id);
            agentRuns = agentRuns.filter((r) => r.issueId !== issueId);
            runEvents = runEvents.filter((e) => !runIds.includes(e.runId));
            runApprovals = runApprovals.filter((a) =>
                !runIds.includes(a.runId)
            );
            agentJobs = agentJobs.filter((j) => !runIds.includes(j.runId!));
        },
        deleteRunsForOrganization: (organizationId: string) => {
            const runIds = agentRuns
                .filter((r) => r.organizationId === organizationId)
                .map((r) => r.id);
            agentRuns = agentRuns.filter(
                (r) => r.organizationId !== organizationId
            );
            runEvents = runEvents.filter((e) => !runIds.includes(e.runId));
            runApprovals = runApprovals.filter((a) =>
                !runIds.includes(a.runId)
            );
            agentJobs = agentJobs.filter((j) => !runIds.includes(j.runId!));
            orgAgentConfigs = orgAgentConfigs.filter(
                (c) => c.organizationId !== organizationId
            );
        },
    };
};
