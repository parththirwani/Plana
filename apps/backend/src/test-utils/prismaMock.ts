export type MockUser = {
    id: string;
    email: string;
    password: string;
    name: string | null;
    avatarUrl: string | null;
    onboardingCompleted: boolean;
};

const createPrismaMock = () => {
    let users: MockUser[] = [];

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
                    id: data.id ?? `usr_${users.length + 1}`,
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
            findUnique: async () => null,
            create: async () => null,
        },
        membership: {
            create: async () => null,
        },
        $transaction: async (fn: any) => fn(prisma),
    };

    return {
        prisma,
        reset: (seed: MockUser[] = []) => {
            users = seed;
        },
    };
};

export const prismaMock = createPrismaMock();
