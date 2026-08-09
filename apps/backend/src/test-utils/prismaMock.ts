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

export type MockBoard = {
    id: string;
    title: string;
    description: string | null;
    organizationId: string;
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
};

export type MockSeed = {
    users?: MockUser[];
    organizations?: MockOrg[];
    memberships?: MockMembership[];
    boards?: MockBoard[];
    sections?: MockSection[];
    issues?: MockIssue[];
};

const createPrismaMock = () => {
    let users: MockUser[] = [];
    let organizations: MockOrg[] = [];
    let memberships: MockMembership[] = [];
    let boards: MockBoard[] = [];
    let sections: MockSection[] = [];
    let issues: MockIssue[] = [];
    let idSeq = 0;
    const allIds = () =>
        [
            ...users,
            ...organizations,
            ...memberships,
            ...boards,
            ...sections,
            ...issues,
        ].map((e: any) => e.id);
    const nextId = (prefix: string) => {
        let id: string;
        do {
            id = `${prefix}_${++idSeq}`;
        } while (allIds().includes(id));
        return id;
    };

    const matchesWhere = (value: unknown, clause: any) => {
        if (clause === undefined) return true;
        if (clause && typeof clause === "object" && "in" in clause) {
            return (clause as any).in.includes(value);
        }
        return value === clause;
    };

    const withAssignees = (issue: MockIssue) => ({
        ...issue,
        assignees: issue.assigneeIds
            .map((id) => users.find((u) => u.id === id))
            .filter(Boolean),
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
                                String(byEmail).toLowerCase()
                        ) ?? null
                    );
                }
                if (byId) return users.find((u) => u.id === byId) ?? null;
                return null;
            },
            findUnique: async ({ where }: { where: any }) =>
                users.find((u) => u.id === where?.id) ?? null,
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
                    return (
                        organizations.find((o) => o.id === byId) ?? null
                    );
                }
                if (bySlug) {
                    return (
                        organizations.find((o) => o.slug === bySlug) ?? null
                    );
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
                    (m) => m.organizationId !== where.id
                );
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
                    matchesWhere(m.role, where?.role)
                );
                if (include?.organization) {
                    return result.map((m) => ({
                        ...m,
                        organization:
                            organizations.find(
                                (o) => o.id === m.organizationId
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
                        (where?.role === undefined || m.role === where.role)
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
        board: {
            findUnique: async ({ where }: { where: any }) =>
                boards.find((b) => b.id === where?.id) ?? null,
            findMany: async ({ where }: { where: any }) =>
                boards.filter(
                    (b) =>
                        where?.organizationId === undefined ||
                        b.organizationId === where.organizationId
                ),
            create: async ({ data }: { data: any }) => {
                const board: MockBoard = {
                    id: data.id ?? nextId("brd"),
                    title: data.title,
                    description: data.description ?? null,
                    organizationId: data.organizationId,
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
                        where?.boardId === undefined || s.boardId === where.boardId
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
                    matchesWhere(i.sectionId, where?.sectionId)
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
                        typeof a === "string" ? a : a.id
                    );
                }
                return issue;
            },
            delete: async ({ where }: { where: any }) => {
                const issue = issues.find((i) => i.id === where.id)!;
                issues = issues.filter((i) => i.id !== where.id);
                return issue;
            },
        },
        $transaction: async (arg: any) =>
            Array.isArray(arg)
                ? await Promise.all(arg.map((op: any) => op))
                : arg(prisma),
    };

    return {
        prisma,
        reset: (seed: MockSeed = {}) => {
            users = seed.users ?? [];
            organizations = seed.organizations ?? [];
            memberships = seed.memberships ?? [];
            boards = seed.boards ?? [];
            sections = seed.sections ?? [];
            issues = seed.issues ?? [];
            idSeq = 0;
        },
    };
};

export const prismaMock = createPrismaMock();
