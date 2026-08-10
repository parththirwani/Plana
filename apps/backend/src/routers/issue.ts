import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";
import {
    createIssue,
    updateIssue,
    moveIssue,
    setAssignees,
} from "../schema/issue";
import { reindex } from "../lib/reindex";
import { notifyBoard } from "../lib/notify";
import { getMembership, isAuthorized } from "./organization";

const router = Router();

export const shapeIssue = (issue: any) => ({
    id: issue.id,
    title: issue.title,
    description: issue.description,
    order: issue.order,
    priority: issue.priority,
    dueDate: issue.dueDate,
    sectionId: issue.sectionId,
    assignees: (issue.assignees ?? []).map((a: any) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        avatarUrl: a.avatarUrl,
    })),
});

const issueWithAssignees = async (id: string) =>
    prisma.issue.findUnique({ where: { id }, include: { assignees: true } });

export const boardForIssue = async (issue: { sectionId: string }) => {
    const section = await prisma.section.findUnique({
        where: { id: issue.sectionId },
    });
    return section
        ? prisma.board.findUnique({ where: { id: section.boardId } })
        : null;
};

router.post(
    "/sections/:id/issues",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = createIssue.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const section = await prisma.section.findUnique({
                where: { id: req.params.id as string },
            });
            if (!section) {
                return res.status(404).json({ message: "Section not found" });
            }

            const board = await prisma.board.findUnique({
                where: { id: section.boardId },
            });
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can create issues",
                });
            }

            const order = (
                await prisma.issue.findMany({
                    where: { sectionId: section.id },
                })
            ).length;

            const issue = await prisma.issue.create({
                data: { ...parsedBody.data, order, sectionId: section.id },
            });

            const created = await issueWithAssignees(issue.id);

            void notifyBoard(board.id, "issue.created", req.user.userId, {
                issue: shapeIssue(created),
                sectionTitle: section.title,
            });

            return res.status(201).json({
                message: "Issue created successfully",
                issue: shapeIssue(created),
            });
        } catch (error) {
            console.error("Create issue error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.patch(
    "/issues/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = updateIssue.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const issue = await prisma.issue.findUnique({
                where: { id: req.params.id as string },
            });
            if (!issue) {
                return res.status(404).json({ message: "Issue not found" });
            }

            const board = await boardForIssue(issue);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can update issues",
                });
            }

            const { title, description, priority, dueDate } = parsedBody.data;
            await prisma.issue.update({
                where: { id: issue.id },
                data: {
                    ...(title !== undefined && { title }),
                    ...(description !== undefined && { description }),
                    ...(priority !== undefined && { priority }),
                    ...(dueDate !== undefined && { dueDate }),
                },
            });

            const updated = await issueWithAssignees(issue.id);

            void notifyBoard(board.id, "issue.updated", req.user.userId, {
                issue: shapeIssue(updated),
            });

            return res.status(200).json({
                message: "Issue updated successfully",
                issue: shapeIssue(updated),
            });
        } catch (error) {
            console.error("Update issue error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.delete(
    "/issues/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const issue = await prisma.issue.findUnique({
                where: { id: req.params.id as string },
            });
            if (!issue) {
                return res.status(404).json({ message: "Issue not found" });
            }

            const board = await boardForIssue(issue);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can delete issues",
                });
            }

            await prisma.issue.delete({ where: { id: issue.id } });

            const remaining = (
                await prisma.issue.findMany({
                    where: { sectionId: issue.sectionId },
                })
            ).sort((a, b) => a.order - b.order);

            await prisma.$transaction(
                reindex(remaining).map((i) =>
                    prisma.issue.update({
                        where: { id: i.id },
                        data: { order: i.order },
                    })
                )
            );

            void notifyBoard(board.id, "issue.deleted", req.user.userId, {
                id: issue.id,
            });

            return res.status(200).json({
                message: "Issue deleted successfully",
            });
        } catch (error) {
            console.error("Delete issue error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.post(
    "/issues/:id/move",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = moveIssue.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const issue = await prisma.issue.findUnique({
                where: { id: req.params.id as string },
            });
            if (!issue) {
                return res.status(404).json({ message: "Issue not found" });
            }

            const currentSection = await prisma.section.findUnique({
                where: { id: issue.sectionId },
            });
            if (!currentSection) {
                return res.status(404).json({ message: "Section not found" });
            }

            const targetSection = await prisma.section.findUnique({
                where: { id: parsedBody.data.sectionId },
            });
            if (!targetSection) {
                return res.status(404).json({ message: "Section not found" });
            }

            if (currentSection.boardId !== targetSection.boardId) {
                return res.status(400).json({
                    message: "Cannot move issues across boards",
                });
            }

            const board = await prisma.board.findUnique({
                where: { id: currentSection.boardId },
            });
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can move issues",
                });
            }

            const siblings = (
                await prisma.issue.findMany({
                    where: { sectionId: targetSection.id },
                })
            ).sort((a, b) => a.order - b.order);

            const withoutMoved = siblings.filter((i) => i.id !== issue.id);
            const at = Math.max(
                0,
                Math.min(
                    parsedBody.data.order ?? withoutMoved.length,
                    withoutMoved.length
                )
            );
            withoutMoved.splice(at, 0, issue);

            await prisma.$transaction(
                withoutMoved.map((i, pos) =>
                    prisma.issue.update({
                        where: { id: i.id },
                        data: {
                            order: pos,
                            ...(i.id === issue.id && {
                                sectionId: targetSection.id,
                            }),
                        },
                    })
                )
            );

            const updated = await issueWithAssignees(issue.id);

            void notifyBoard(board.id, "issue.moved", req.user.userId, {
                issue: shapeIssue(updated),
                fromSectionTitle: currentSection.title,
                toSectionTitle: targetSection.title,
            });

            return res.status(200).json({
                message: "Issue moved successfully",
                issue: shapeIssue(updated),
            });
        } catch (error) {
            console.error("Move issue error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.put(
    "/issues/:id/assignees",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = setAssignees.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const issue = await prisma.issue.findUnique({
                where: { id: req.params.id as string },
            });
            if (!issue) {
                return res.status(404).json({ message: "Issue not found" });
            }

            const board = await boardForIssue(issue);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can assign issues",
                });
            }

            const assigneeIds = [...new Set(parsedBody.data.assigneeIds)];

            const memberships = await prisma.membership.findMany({
                where: {
                    organizationId: board.organizationId,
                    userId: { in: assigneeIds },
                },
            });
            if (memberships.length !== assigneeIds.length) {
                return res.status(400).json({
                    message: "Some users are not members of this organization",
                });
            }

            await prisma.issue.update({
                where: { id: issue.id },
                data: { assignees: { set: assigneeIds.map((id) => ({ id })) } },
            });

            const updated = await issueWithAssignees(issue.id);

            void notifyBoard(board.id, "issue.assignees", req.user.userId, {
                issue: shapeIssue(updated),
            });

            return res.status(200).json({
                message: "Assignees updated successfully",
                issue: shapeIssue(updated),
            });
        } catch (error) {
            console.error("Set assignees error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

export default router;
