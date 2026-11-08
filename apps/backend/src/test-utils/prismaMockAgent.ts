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

export const createAgentFakes = (nextId: (prefix: string) => string) => {
    let agentRuns: MockAgentRun[] = [];
    let runEvents: MockRunEvent[] = [];
    let runApprovals: MockRunApproval[] = [];
    let orgAgentConfigs: MockOrgAgentConfig[] = [];

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
        (where?.owner === undefined || run.owner === where.owner);

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
            const run = agentRuns.find((r) => r.id === where.id)!;
            const merged = { ...run, ...data };
            assertAgentRunUnique(merged, run.id);
            Object.assign(run, data, {
                updatedAt: new Date().toISOString(),
            });
            return run;
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

    return {
        agentRun,
        runEvent,
        runApproval,
        organizationAgentConfig,
        allRows: () => [
            ...agentRuns,
            ...runEvents,
            ...runApprovals,
            ...orgAgentConfigs,
        ],
        resetAgentState: (seed: MockSeed) => {
            agentRuns = seed.agentRuns ?? [];
            runEvents = seed.runEvents ?? [];
            runApprovals = seed.runApprovals ?? [];
            orgAgentConfigs = seed.orgAgentConfigs ?? [];
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
            orgAgentConfigs = orgAgentConfigs.filter(
                (c) => c.organizationId !== organizationId
            );
        },
    };
};
