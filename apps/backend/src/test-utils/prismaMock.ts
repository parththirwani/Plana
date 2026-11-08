import { createAgentFakes, matchesWhere } from "./prismaMockAgent";
import type {
    MockAgentRun,
    MockRunApproval,
    MockOrgAgentConfig,
    MockRunEvent,
    MockAgentJob,
} from "./prismaMockAgent";

export type {
    MockAgentRun,
    MockRunApproval,
    MockOrgAgentConfig,
    MockRunEvent,
    MockAgentJob,
};

export type MockUser = {
    id: string;
    email: string;
    password: string;
    name: string | null;
    avatarUrl: string | null;
    onboardingCompleted: boolean;
};

export type MockOrg = {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    orgImage: string | null;
};

export type MockMembership = {
    id: string;
    userId: string;
    organizationId: string;
    role: string;
};

export type MockInvitation = {
    id: string;
    organizationId: string;
    email: string;
    role: string;
};

export type MockBoard = {
    id: string;
    title: string;
    description: string | null;
    organizationId: string;
    defaultRepository?: string | null;
};

export type MockSection = {
    id: string;
    title: string;
    order: number;
    boardId: string;
};

export type MockIssue = {
    id: string;
    title: string;
    description: string | null;
    order: number;
    priority: string;
    dueDate: Date | string | null;
    sectionId: string;
    assigneeIds: string[];
    repository?: string | null;
};

export type MockComment = {
    id: string;
    content: string;
    issueId: string;
    authorId: string;
    createdAt: string;
    updatedAt: string;
};

export type MockSeed = {
    users?: MockUser[];
    organizations?: MockOrg[];
    memberships?: MockMembership[];
    invitations?: MockInvitation[];
    boards?: MockBoard[];
    sections?: MockSection[];
    issues?: MockIssue[];
    comments?: MockComment[];
    agentRuns?: MockAgentRun[];
    runEvents?: MockRunEvent[];
    runApprovals?: MockRunApproval[];
    orgAgentConfigs?: MockOrgAgentConfig[];
    agentJobs?: MockAgentJob[];
};

const createPrismaMock = () => {
    let users: MockUser[] = [];
    let organizations: MockOrg[] = [];
    let memberships: MockMembership[] = [];
    let invitations: MockInvitation[] = [];
    let boards: MockBoard[] = [];
    let sections: MockSection[] = [];
    let issues: MockIssue[] = [];
    let comments: MockComment[] = [];
    let idSeq = 0;
    const allIds = () =>
        [
            ...users,
            ...organizations,
            ...memberships,
            ...invitations,
            ...boards,
            ...sections,
            ...issues,
            ...comments,
            ...agents.allRows(),
        ].map((e: any) => e.id);
    const nextId = (prefix: string) => {
        let id: string;
        do {
            id = `${prefix}_${++idSeq}`;
        } while (allIds().includes(id));
        return id;
    };

    const agents = createAgentFakes(nextId);

    const withAssignees = (issue: MockIssue) => ({
        ...issue,
        assignees: issue.assigneeIds
            .map((id) => users.find((u) => u.id === id))
            .filter(Boolean),
    });

    const withAuthor = (comment: MockComment) => ({
        ...comment,
        author: users.find((u) => u.id === comment.authorId) ?? null,
    });

    const prisma = {
        user: {
            findFirst: async ({ where }: { where: any }) => {
                const byEmail = where?.email?.equals ?? where?.email;
                const byId = where?.id;
                if (byEmail) {
                    return (
                        users.find(
                            (u) =>
                                u.email.toLowerCase() ===
                                String(byEmail).toLowerCase(),
                        ) ?? null
                    );
                }
                if (byId) return users.find((u) => u.id === byId) ?? null;
                return null;
            },
            findUnique: async ({ where }: { where: any }) =>
                users.find((u) => u.id === where?.id) ?? null,
            update: async ({ where, data }: { where: any; data: any }) => {
                const user = users.find((u) => u.id === where.id)!;
                Object.assign(user, data);
                return user;
            },
            create: async ({ data }: { data: any }) => {
                const user: MockUser = {
                    id: data.id ?? nextId("usr"),
                    email: data.email,
                    password: data.password,
                    name: data.name ?? null,
                    avatarUrl: data.avatarUrl ?? null,
                    onboardingCompleted: data.onboardingCompleted ?? false,
                };
                users.push(user);
                return user;
            },
        },
        organization: {
            findUnique: async ({ where }: { where: any }) => {
                const byId = where?.id;
                const bySlug = where?.slug;
                if (byId) {
                    return organizations.find((o) => o.id === byId) ?? null;
                }
                if (bySlug) {
                    return organizations.find((o) => o.slug === bySlug) ?? null;
                }
                return null;
            },
            create: async ({ data }: { data: any }) => {
                const org: MockOrg = {
                    id: data.id ?? nextId("org"),
                    name: data.name,
                    slug: data.slug,
                    description: data.description ?? null,
                    orgImage: data.orgImage ?? null,
                };
                organizations.push(org);
                return org;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const org = organizations.find((o) => o.id === where.id)!;
                Object.assign(org, data);
                return org;
            },
            delete: async ({ where }: { where: any }) => {
                const org = organizations.find((o) => o.id === where.id)!;
                organizations = organizations.filter((o) => o.id !== where.id);
                memberships = memberships.filter(
                    (m) => m.organizationId !== where.id,
                );
                invitations = invitations.filter(
                    (i) => i.organizationId !== where.id,
                );
                agents.deleteRunsForOrganization(where.id);
                return org;
            },
        },
        membership: {
            findFirst: async ({ where }: { where: any }) => {
                const match = (m: MockMembership) =>
                    (where?.organizationId === undefined ||
                        m.organizationId === where.organizationId) &&
                    (where?.userId === undefined || m.userId === where.userId) &&
                    (where?.role === undefined || m.role === where.role);
                return memberships.find(match) ?? null;
            },
            findMany: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                let result = memberships.filter((m) =>
                    matchesWhere(m.organizationId, where?.organizationId) &&
                    matchesWhere(m.userId, where?.userId) &&
                    matchesWhere(m.role, where?.role),
                );
                if (include?.organization) {
                    return result.map((m) => ({
                        ...m,
                        organization:
                            organizations.find(
                                (o) => o.id === m.organizationId,
                            ) ?? null,
                    }));
                }
                if (include?.user) {
                    return result.map((m) => ({
                        ...m,
                        user: users.find((u) => u.id === m.userId) ?? null,
                    }));
                }
                return result;
            },
            count: async ({ where }: { where: any }) =>
                memberships.filter(
                    (m) =>
                        (where?.organizationId === undefined ||
                            m.organizationId === where.organizationId) &&
                        (where?.role === undefined || m.role === where.role),
                ).length,
            create: async ({ data }: { data: any }) => {
                const membership: MockMembership = {
                    id: data.id ?? nextId("mem"),
                    userId: data.userId,
                    organizationId: data.organizationId,
                    role: data.role,
                };
                memberships.push(membership);
                return membership;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const membership = memberships.find(
                    (m) => m.id === where.id
                )!;
                Object.assign(membership, data);
                return membership;
            },
            delete: async ({ where }: { where: any }) => {
                const membership = memberships.find(
                    (m) => m.id === where.id
                )!;
                memberships = memberships.filter((m) => m.id !== where.id);
                return membership;
            },
        },
        invitation: {
            findUnique: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                const invitation =
                    invitations.find((i) => i.id === where?.id) ?? null;
                if (invitation && include?.organization) {
                    return {
                        ...invitation,
                        organization:
                            organizations.find(
                                (o) => o.id === invitation.organizationId,
                            ) ?? null,
                    };
                }
                return invitation;
            },
            findFirst: async ({ where }: { where: any }) =>
                invitations.find(
                    (i) =>
                        (where?.organizationId === undefined ||
                            i.organizationId === where.organizationId) &&
                        (where?.email === undefined ||
                            i.email.toLowerCase() ===
                                String(where.email).toLowerCase()),
                ) ?? null,
            findMany: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                let result = invitations.filter(
                    (i) =>
                        where?.email === undefined ||
                        i.email.toLowerCase() ===
                            String(where.email).toLowerCase(),
                );
                if (include?.organization) {
                    return result.map((i) => ({
                        ...i,
                        organization:
                            organizations.find(
                                (o) => o.id === i.organizationId,
                            ) ?? null,
                    }));
                }
                return result;
            },
            create: async ({ data }: { data: any }) => {
                const invitation: MockInvitation = {
                    id: data.id ?? nextId("inv"),
                    organizationId: data.organizationId,
                    email: data.email,
                    role: data.role,
                };
                invitations.push(invitation);
                return invitation;
            },
            delete: async ({ where }: { where: any }) => {
                const invitation = invitations.find(
                    (i) => i.id === where.id
                )!;
                invitations = invitations.filter((i) => i.id !== where.id);
                return invitation;
            },
        },
        board: {
            findUnique: async ({ where }: { where: any }) =>
                boards.find((b) => b.id === where?.id) ?? null,
            findMany: async ({ where }: { where: any }) =>
                boards.filter(
                    (b) =>
                        where?.organizationId === undefined ||
                        b.organizationId === where.organizationId,
                ),
            create: async ({ data }: { data: any }) => {
                const board: MockBoard = {
                    id: data.id ?? nextId("brd"),
                    title: data.title,
                    description: data.description ?? null,
                    organizationId: data.organizationId,
                    defaultRepository: data.defaultRepository ?? null,
                };
                boards.push(board);
                return board;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const board = boards.find((b) => b.id === where.id)!;
                Object.assign(board, data);
                return board;
            },
            delete: async ({ where }: { where: any }) => {
                const board = boards.find((b) => b.id === where.id)!;
                boards = boards.filter((b) => b.id !== where.id);
                sections = sections.filter((s) => s.boardId !== where.id);
                return board;
            },
        },
        section: {
            findUnique: async ({ where }: { where: any }) =>
                sections.find((s) => s.id === where?.id) ?? null,
            findMany: async ({ where }: { where: any }) =>
                sections.filter(
                    (s) =>
                        where?.boardId === undefined || s.boardId === where.boardId,
                ),
            create: async ({ data }: { data: any }) => {
                const section: MockSection = {
                    id: data.id ?? nextId("sec"),
                    title: data.title,
                    order: data.order ?? 0,
                    boardId: data.boardId,
                };
                sections.push(section);
                return section;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const section = sections.find((s) => s.id === where.id)!;
                Object.assign(section, data);
                return section;
            },
            delete: async ({ where }: { where: any }) => {
                const section = sections.find((s) => s.id === where.id)!;
                sections = sections.filter((s) => s.id !== where.id);
                return section;
            },
        },
        issue: {
            findUnique: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                const issue =
                    issues.find((i) => i.id === where?.id) ?? null;
                return issue && include?.assignees
                    ? withAssignees(issue)
                    : issue;
            },
            findMany: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                let result = issues.filter((i) =>
                    matchesWhere(i.sectionId, where?.sectionId),
                );
                if (include?.assignees) {
                    result = result.map(withAssignees);
                }
                return result;
            },
            create: async ({ data }: { data: any }) => {
                const issue: MockIssue = {
                    id: data.id ?? nextId("iss"),
                    title: data.title,
                    description: data.description ?? null,
                    order: data.order ?? 0,
                    priority: data.priority ?? "NONE",
                    dueDate: data.dueDate ?? null,
                    sectionId: data.sectionId,
                    assigneeIds: [],
                    repository: data.repository ?? null,
                };
                issues.push(issue);
                return issue;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const issue = issues.find((i) => i.id === where.id)!;
                const { assignees, ...rest } = data;
                Object.assign(issue, rest);
                if (assignees?.set) {
                    issue.assigneeIds = assignees.set.map((a: any) =>
                        typeof a === "string" ? a : a.id,
                    );
                }
                return issue;
            },
            delete: async ({ where }: { where: any }) => {
                const issue = issues.find((i) => i.id === where.id)!;
                issues = issues.filter((i) => i.id !== where.id);
                comments = comments.filter((c) => c.issueId !== where.id);
                agents.deleteRunsForIssue(where.id);
                return issue;
            },
        },
        comment: {
            findUnique: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                const comment =
                    comments.find((c) => c.id === where?.id) ?? null;
                return comment && include?.author
                    ? withAuthor(comment)
                    : comment;
            },
            findMany: async ({
                where,
                include,
            }: {
                where: any;
                include?: any;
            }) => {
                let result = comments.filter((c) =>
                    matchesWhere(c.issueId, where?.issueId),
                );
                if (include?.author) {
                    result = result.map(withAuthor);
                }
                return result;
            },
            create: async ({ data }: { data: any }) => {
                const now = new Date().toISOString();
                const comment: MockComment = {
                    id: data.id ?? nextId("com"),
                    content: data.content,
                    issueId: data.issueId,
                    authorId: data.authorId,
                    createdAt: now,
                    updatedAt: now,
                };
                comments.push(comment);
                return comment;
            },
            update: async ({ where, data }: { where: any; data: any }) => {
                const comment = comments.find((c) => c.id === where.id)!;
                Object.assign(comment, data, {
                    updatedAt: new Date().toISOString(),
                });
                return comment;
            },
            delete: async ({ where }: { where: any }) => {
                const comment = comments.find((c) => c.id === where.id)!;
                comments = comments.filter((c) => c.id !== where.id);
                return comment;
            },
        },
        agentRun: agents.agentRun,
        runEvent: agents.runEvent,
        runApproval: agents.runApproval,
        organizationAgentConfig: agents.organizationAgentConfig,
        agentJob: agents.agentJob,
        runLeaseRenewal: agents.runLeaseRenewal,
        // ---------------------------------------------------------------------
        // Transactions
        // ---------------------------------------------------------------------
        //
        // The run state machine does its durability work in ONE interactive
        // transaction (run row + events + slot + queued job), so the mock MUST
        // share that semantics or it would bless exactly the bug the production
        // code is designed to prevent: a launch whose enqueue failed has to
        // leave NO run row, NO event and NO active slot behind here too, not just
        // against a live Postgres.
        $transaction: async (arg: any, _options?: any) => {
            if (Array.isArray(arg)) {
                return await Promise.all(arg.map((op: any) => op));
            }
            const snapshot = agents.snapshotAgentState();
            try {
                return await arg(prisma);
            } catch (error) {
                agents.restoreAgentState(snapshot);
                throw error;
            }
        },
        // ---------------------------------------------------------------------
        // Row locks
        // ---------------------------------------------------------------------
        //
        // `SELECT … FOR UPDATE` cannot block an in-memory mock, but the state
        // machine must still exercise the SAME lock path here as against a live
        // Postgres — so the two lock statements it issues are recognised and
        // answered with the identical projection a real database would return.
        // Any other statement is a hard error: a mock that quietly answers
        // unknown SQL would "pass" tests whose queries never ran.
        $queryRawUnsafe: async (sql: string, ...values: unknown[]) =>
            queryRawRunLock(sql, values, agents),
        $executeRawUnsafe: async (sql: string, ...values: unknown[]) =>
            queryRawRunLock(sql, values, agents).then((rows) => rows.length),
        $queryRaw: async (args: { sql?: string; values?: unknown[] }) =>
            queryRawRunLock(String(args?.sql ?? ""), args?.values ?? [], agents,
            ),
    };

    return {
        prisma,
        reset: (seed: MockSeed = {}) => {
            users = seed.users ?? [];
            organizations = seed.organizations ?? [];
            memberships = seed.memberships ?? [];
            invitations = seed.invitations ?? [];
            boards = seed.boards ?? [];
            sections = seed.sections ?? [];
            issues = seed.issues ?? [];
            comments = seed.comments ?? [];
            agents.resetAgentState(seed);
            idSeq = 0;
        },
    };
};

/**
 * Recognise the two `SELECT … FOR UPDATE` statements the run state machine
 * issues (lock the ISSUE's active-run row for admission; lock a RUN row for a
 * guarded transition) and return the same column projection a real Postgres
 * would. Unknown SQL throws instead of returning `[]`: an in-memory mock that
 * silently accepted arbitrary statements would let a test pass whose query never
 * actually ran.
 */
const LOCK_ISSUE_SLOT_MARKER = `WHERE "activeIssueId" = $1 FOR UPDATE`;
// The advisory admission lock reserves nothing here (single-threaded mock), but
// it must be RECOGNISED: throwing on unknown SQL is the discipline that keeps a
// test from passing without running its statement, so new statements get named
// here rather than silently tolerated.
const LOCK_ISSUE_ADMISSION_MARKER = `SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) IS NULL`;
const LOCK_RUN_ROW_MARKER = `WHERE "id" = $1 FOR UPDATE`;

export const RUN_LOCK_COLUMNS = [
    "id",
    "issueId",
    "organizationId",
    "status",
    "activeIssueId",
    "planVersion",
    "baseCommit",
    "branchName",
    "owner",
    "leaseExpiresAt",
    "fencingToken",
    "attemptedAt",
] as const;

const projectRunLockRow = (run: Record<string, unknown>) =>
    Object.fromEntries(
        RUN_LOCK_COLUMNS.filter((column) => column in run).map((column) => [
            column,
            run[column],
        ]),
    );

const queryRawRunLock = (
    sql: string,
    values: readonly unknown[],
    agents: any,
): Promise<any[]> => {
    const statement = sql.replace(/\s+/g, " ").trim();
    const first = values[0];
    if (statement.includes('FROM "AgentJob"'))
        return Promise.resolve(agents.lockedJobRows(String(first)));
    if (statement.includes(LOCK_ISSUE_ADMISSION_MARKER)) {
        return Promise.resolve([]);
    }
    if (statement.includes(LOCK_ISSUE_SLOT_MARKER)) {
        return Promise.resolve(
            agents.lockedRunRows(String(first)).map(projectRunLockRow),
        );
    }
    if (statement.includes(LOCK_RUN_ROW_MARKER)) {
        return Promise.resolve(
            agents.lockedRunRows(undefined, String(first)).map(projectRunLockRow),
        );
    }
    throw new Error(
        `prismaMock: unsupported raw statement: ${statement.slice(0, 160)}`,
    );
};

export const prismaMock = createPrismaMock();
