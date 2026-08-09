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

export type MockSeed = {
    users?: MockUser[];
    organizations?: MockOrg[];
    memberships?: MockMembership[];
};

const createPrismaMock = () => {
    let users: MockUser[] = [];
    let organizations: MockOrg[] = [];
    let memberships: MockMembership[] = [];
    let idSeq = 0;
    const nextId = (prefix: string) => `${prefix}_${++idSeq}`;

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
                    (where?.organizationId === undefined ||
                        m.organizationId === where.organizationId) &&
                    (where?.userId === undefined || m.userId === where.userId) &&
                    (where?.role === undefined || m.role === where.role)
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
        $transaction: async (fn: any) => fn(prisma),
    };

    return {
        prisma,
        reset: (seed: MockSeed = {}) => {
            users = seed.users ?? [];
            organizations = seed.organizations ?? [];
            memberships = seed.memberships ?? [];
            idSeq = 0;
        },
    };
};

export const prismaMock = createPrismaMock();
