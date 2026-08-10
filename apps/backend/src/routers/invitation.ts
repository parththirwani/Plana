import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";

const router = Router();


const isForUser = (email: string, invitationEmail: string) =>
    email.toLowerCase() === invitationEmail.toLowerCase();

router.get("/", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const invitations = await prisma.invitation.findMany({
            where: { email: req.user.email },
            include: { organization: true },
        });

        return res.status(200).json({
            message: "Invitations fetched successfully",
            invitations: invitations.map((i) => ({
                id: i.id,
                organizationId: i.organizationId,
                organizationName: i.organization.name,
                organizationImage: i.organization.orgImage,
                role: i.role,
                createdAt: i.createdAt,
            })),
        });
    } catch (error) {
        console.error("List invitations error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
});

router.post("/:id/accept", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const { userId } = req.user;
        const invitation = await prisma.invitation.findUnique({
            where: { id: req.params.id as string },
            include: { organization: true },
        });

        if (!invitation || !isForUser(req.user.email, invitation.email)) {
            return res.status(404).json({ message: "Invitation not found" });
        }

        const membership = await prisma.membership.findFirst({
            where: { organizationId: invitation.organizationId, userId },
        });

        if (membership) {
            await prisma.invitation.delete({ where: { id: invitation.id } });
            return res.status(409).json({ message: "You are already a member" });
        }

        await prisma.$transaction(async (tx) => {
            await tx.membership.create({
                data: {
                    userId,
                    organizationId: invitation.organizationId,
                    role: invitation.role,
                },
            });
            await tx.invitation.delete({ where: { id: invitation.id } });
        });

        return res.status(200).json({
            message: "Invitation accepted",
            organization: {
                id: invitation.organization.id,
                name: invitation.organization.name,
                slug: invitation.organization.slug,
                description: invitation.organization.description,
                orgImage: invitation.organization.orgImage,
                role: invitation.role,
            },
        });
    } catch (error) {
        console.error("Accept invitation error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
});

router.post("/:id/decline", authMiddleware, async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ message: "Unauthorized" });
        }

        const invitation = await prisma.invitation.findUnique({
            where: { id: req.params.id as string },
        });

        if (!invitation || !isForUser(req.user.email, invitation.email)) {
            return res.status(404).json({ message: "Invitation not found" });
        }

        await prisma.invitation.delete({ where: { id: invitation.id } });

        return res.status(200).json({ message: "Invitation declined" });
    } catch (error) {
        console.error("Decline invitation error:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
});

export default router;
