import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";
import {
    createOrg,
    updateOrg,
    inviteMember,
    roleChange,
} from "../schema/organization";
import { normalizeEmail } from "../schema/auth";
import { slugify } from "../lib/slug";

const router = Router();

const ROLE_LEVEL: Record<string, number> = {
    MEMBER: 1,
    MODERATOR: 2,
    ADMIN: 3,
};

const uniqueSlug = async (name: string, excludeId?: string) => {
    const base = slugify(name);
    let slug = base;
    let i = 2;

    while (true) {
        const existing = await prisma.organization.findUnique({
            where: { slug },
        });
        if (!existing || existing.id === excludeId) {
            return slug;
        }
        slug = `${base}-${i++}`;
    }
};

export const getMembership = (organizationId: string, userId: string) =>
    prisma.membership.findFirst({
        where: { organizationId, userId },
    });

const roleLevel = (role: string) => ROLE_LEVEL[role] ?? 0;

export const isAuthorized = (
    membership: { role: string } | null,
    minRole: string
) =>
    membership !== null && roleLevel(membership.role) >= roleLevel(minRole);

const isLastAdmin = async (organizationId: string) =>
    (await prisma.membership.count({
        where: { organizationId, role: "ADMIN" },
    })) <= 1;

router.post(
    "/",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = createOrg.safeParse(req.body);

            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            if (!req.user) {
                return res.status(401).json({
                    message: "Unauthorized",
                });
            }

            const { name, description, orgImage } = parsedBody.data;
            const slug = await uniqueSlug(name);
            const userId = req.user.userId;

            const organization = await prisma.$transaction(async (tx) => {
                const org = await tx.organization.create({
                    data: { name, slug, description, orgImage },
                });

                await tx.membership.create({
                    data: {
                        userId,
                        organizationId: org.id,
                        role: "ADMIN",
                    },
                });

                return org;
            });

            return res.status(201).json({
                message: "Organization created successfully",
                organization: {
                    ...organization,
                    role: "ADMIN",
                },
            });
        } catch (error) {
            console.error("Create org error:", error);

            return res.status(500).json({
                message: "Internal server error",
            });
        }
    }
);

router.get("/", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const memberships = await prisma.membership.findMany({
            where: { userId: req.user.userId },
            include: { organization: true },
        });

        return res.status(200).json({
            message: "Organizations fetched successfully",
            organizations: memberships.map((m) => ({
                id: m.organization.id,
                name: m.organization.name,
                slug: m.organization.slug,
                description: m.organization.description,
                orgImage: m.organization.orgImage,
                role: m.role,
            })),
        });
    } catch (error) {
        console.error("Get orgs error:", error);

        return res.status(500).json({ message: "Internal server error" });
    }
});

router.get(
    "/by-slug/:slug",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const slug = req.params.slug as string;

            const organization = await prisma.organization.findUnique({
                where: { slug },
            });

            if (!organization) {
                return res.status(404).json({ message: "Organization not found" });
            }

            const membership = await getMembership(
                organization.id,
                req.user.userId
            );

            if (!membership) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            return res.status(200).json({
                message: "Organization fetched successfully",
                organization: {
                    ...organization,
                    role: membership.role,
                },
            });
        } catch (error) {
            console.error("Get org by slug error:", error);

            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.get("/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const organizationId = req.params.id as string;

        const membership = await getMembership(organizationId, req.user.userId);

        if (!membership) {
            return res.status(403).json({
                message: "You are not a member of this organization",
            });
        }

        const organization = await prisma.organization.findUnique({
            where: { id: organizationId },
        });

        if (!organization) {
            return res.status(404).json({ message: "Organization not found" });
        }

        return res.status(200).json({
            message: "Organization fetched successfully",
            organization: {
                ...organization,
                role: membership.role,
            },
        });
    } catch (error) {
        console.error("Get org error:", error);

        return res.status(500).json({ message: "Internal server error" });
    }
});

router.put("/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const parsedBody = updateOrg.safeParse(req.body);

        if (!parsedBody.success) {
            return res.status(400).json({ message: "Fields not according to schema" });
        }

        const organizationId = req.params.id as string;
        const membership = await getMembership(organizationId, req.user.userId);

        if (!isAuthorized(membership, "ADMIN")) {
            return res.status(403).json({
                message: "Only admins can update the organization",
            });
        }

        const { name, description, orgImage } = parsedBody.data;

        const organization = await prisma.organization.update({
            where: { id: organizationId },
            data: {
                ...(name !== undefined && { name }),
                ...(name !== undefined && {
                    slug: await uniqueSlug(name, organizationId),
                }),
                ...(description !== undefined && { description }),
                ...(orgImage !== undefined && { orgImage }),
            },
        });

        return res.status(200).json({
            message: "Organization updated successfully",
            organization,
        });
    } catch (error) {
        console.error("Update org error:", error);

        return res.status(500).json({ message: "Internal server error" });
    }
});

router.delete("/:id", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const organizationId = req.params.id as string;
        const membership = await getMembership(organizationId, req.user.userId);

        if (!isAuthorized(membership, "ADMIN")) {
            return res.status(403).json({
                message: "Only admins can delete the organization",
            });
        }

        await prisma.organization.delete({ where: { id: organizationId } });

        return res.status(200).json({
            message: "Organization deleted successfully",
        });
    } catch (error) {
        console.error("Delete org error:", error);

        return res.status(500).json({ message: "Internal server error" });
    }
});

router.get("/:id/members", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const organizationId = req.params.id as string;
        const membership = await getMembership(organizationId, req.user.userId);

        if (!membership) {
            return res.status(403).json({
                message: "You are not a member of this organization",
            });
        }

        const memberships = await prisma.membership.findMany({
            where: { organizationId },
            include: { user: true },
        });

        return res.status(200).json({
            message: "Members fetched successfully",
            members: memberships.map((m) => ({
                id: m.id,
                userId: m.userId,
                role: m.role,
                user: {
                    id: m.user.id,
                    email: m.user.email,
                    name: m.user.name,
                    avatarUrl: m.user.avatarUrl,
                },
            })),
        });
    } catch (error) {
        console.error("Get members error:", error);

        return res.status(500).json({ message: "Internal server error" });
    }
});

router.post(
    "/:id/members",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = inviteMember.safeParse(req.body);

            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const organizationId = req.params.id as string;
            const membership = await getMembership(
                organizationId,
                req.user.userId
            );

            if (!isAuthorized(membership, "ADMIN")) {
                return res.status(403).json({
                    message: "Only admins can invite members",
                });
            }

            const email = normalizeEmail(parsedBody.data.email);

            const user = await prisma.user.findFirst({
                where: { email: { equals: email, mode: "insensitive" } },
            });

            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            const existing = await prisma.membership.findFirst({
                where: { organizationId, userId: user.id },
            });

            if (existing) {
                return res.status(409).json({
                    message: "User is already a member",
                });
            }

            const created = await prisma.membership.create({
                data: {
                    userId: user.id,
                    organizationId,
                    role: "MEMBER",
                },
            });

            return res.status(201).json({
                message: "Member invited successfully",
                membership: {
                    id: created.id,
                    userId: created.userId,
                    role: created.role,
                    user: {
                        id: user.id,
                        email: user.email,
                        name: user.name,
                        avatarUrl: user.avatarUrl,
                    },
                },
            });
        } catch (error) {
            console.error("Invite member error:", error);

            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.patch(
    "/:id/members/:userId",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = roleChange.safeParse(req.body);

            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const organizationId = req.params.id as string;
            const targetUserId = req.params.userId as string;

            const requester = await getMembership(
                organizationId,
                req.user.userId
            );

            if (!isAuthorized(requester, "ADMIN")) {
                return res.status(403).json({
                    message: "Only admins can change member roles",
                });
            }

            const target = await prisma.membership.findFirst({
                where: { organizationId, userId: targetUserId },
            });

            if (!target) {
                return res.status(404).json({
                    message: "Member not found in this organization",
                });
            }

            const { role } = parsedBody.data;

            if (target.role === "ADMIN" && role !== "ADMIN") {
                if (await isLastAdmin(organizationId)) {
                    return res.status(400).json({
                        message: "Cannot demote the last admin of the organization",
                    });
                }
            }

            const updated = await prisma.membership.update({
                where: { id: target.id },
                data: { role },
            });

            return res.status(200).json({
                message: "Member role updated successfully",
                membership: {
                    id: updated.id,
                    userId: updated.userId,
                    role: updated.role,
                },
            });
        } catch (error) {
            console.error("Change role error:", error);

            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.delete(
    "/:id/members/:userId",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const organizationId = req.params.id as string;
            const targetUserId = req.params.userId as string;

            const requester = await getMembership(
                organizationId,
                req.user.userId
            );

            if (!isAuthorized(requester, "ADMIN")) {
                return res.status(403).json({
                    message: "Only admins can remove members",
                });
            }

            const target = await prisma.membership.findFirst({
                where: { organizationId, userId: targetUserId },
            });

            if (!target) {
                return res.status(404).json({
                    message: "Member not found in this organization",
                });
            }

            if (target.role === "ADMIN") {
                if (await isLastAdmin(organizationId)) {
                    return res.status(400).json({
                        message: "Cannot remove the last admin of the organization",
                    });
                }
            }

            await prisma.membership.delete({ where: { id: target.id } });

            return res.status(200).json({
                message: "Member removed successfully",
            });
        } catch (error) {
            console.error("Remove member error:", error);

            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.post(
    "/:id/leave",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const organizationId = req.params.id as string;

            const membership = await getMembership(
                organizationId,
                req.user.userId
            );

            if (!membership) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            if (membership.role === "ADMIN") {
                if (await isLastAdmin(organizationId)) {
                    return res.status(400).json({
                        message: "Cannot leave: transfer admin to another member first",
                    });
                }
            }

            await prisma.membership.delete({ where: { id: membership.id } });

            return res.status(200).json({
                message: "Left organization successfully",
            });
        } catch (error) {
            console.error("Leave org error:", error);

            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

export default router;
