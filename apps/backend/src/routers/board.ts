import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";
import {
    createBoard,
    updateBoard,
    createSection,
    updateSection,
} from "../schema/board";
import { reindex, moveTo } from "../lib/reindex";
import { notifyBoard } from "../lib/notify";
import { getMembership, isAuthorized } from "./organization";
import { shapeIssue } from "./issue";

const router = Router();

const boardById = (id: string) => prisma.board.findUnique({ where: { id } });

const orderedSections = async (boardId: string) =>
    (await prisma.section.findMany({ where: { boardId } })).sort(
        (a, b) => a.order - b.order
    );

router.post(
    "/organizations/:id/boards",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = createBoard.safeParse(req.body);
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

            if (!isAuthorized(membership, "MEMBER")) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can create boards",
                });
            }

            const board = await prisma.board.create({
                data: { ...parsedBody.data, organizationId },
            });

            void notifyBoard(board.id, "board.created", req.user.userId, {
                board,
            });

            return res.status(201).json({
                message: "Board created successfully",
                board,
            });
        } catch (error) {
            console.error("Create board error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.get(
    "/organizations/:id/boards",
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

            if (!isAuthorized(membership, "MEMBER")) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            const boards = await prisma.board.findMany({
                where: { organizationId },
            });

            return res.status(200).json({
                message: "Boards fetched successfully",
                boards,
            });
        } catch (error) {
            console.error("List boards error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.get(
    "/boards/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const board = await boardById(req.params.id as string);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MEMBER")) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            const sections = await orderedSections(board.id);
            const issues = await prisma.issue.findMany({
                where: { sectionId: { in: sections.map((s) => s.id) } },
                include: { assignees: true },
            });
            const bySection = new Map<string, typeof issues>();
            for (const section of sections) {
                bySection.set(section.id, []);
            }
            for (const issue of issues) {
                bySection.get(issue.sectionId)?.push(issue);
            }
            for (const list of bySection.values()) {
                list.sort((a, b) => a.order - b.order);
            }

            return res.status(200).json({
                message: "Board fetched successfully",
                board: {
                    ...board,
                    sections: sections.map((section) => ({
                        ...section,
                        issues: (bySection.get(section.id) ?? []).map(
                            shapeIssue
                        ),
                    })),
                },
            });
        } catch (error) {
            console.error("Get board error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.put(
    "/boards/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = updateBoard.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const board = await boardById(req.params.id as string);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can update boards",
                });
            }

            const { title, description } = parsedBody.data;
            const updated = await prisma.board.update({
                where: { id: board.id },
                data: {
                    ...(title !== undefined && { title }),
                    ...(description !== undefined && { description }),
                },
            });

            void notifyBoard(board.id, "board.updated", req.user.userId, {
                board: updated,
            });

            return res.status(200).json({
                message: "Board updated successfully",
                board: updated,
            });
        } catch (error) {
            console.error("Update board error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.delete(
    "/boards/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const board = await boardById(req.params.id as string);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can delete boards",
                });
            }

            await prisma.board.delete({ where: { id: board.id } });

            void notifyBoard(board.id, "board.deleted", req.user.userId, {
                id: board.id,
            });

            return res.status(200).json({
                message: "Board deleted successfully",
            });
        } catch (error) {
            console.error("Delete board error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.post(
    "/boards/:id/sections",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = createSection.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const board = await boardById(req.params.id as string);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can create sections",
                });
            }

            const order = (
                await prisma.section.findMany({ where: { boardId: board.id } })
            ).length;

            const section = await prisma.section.create({
                data: { ...parsedBody.data, order, boardId: board.id },
            });

            void notifyBoard(board.id, "section.created", req.user.userId, {
                section,
            });

            return res.status(201).json({
                message: "Section created successfully",
                section,
            });
        } catch (error) {
            console.error("Create section error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.patch(
    "/sections/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = updateSection.safeParse(req.body);
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

            const board = await boardById(section.boardId);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can update sections",
                });
            }

            const { title, order } = parsedBody.data;

            if (order !== undefined) {
                const updates = moveTo(
                    await orderedSections(board.id),
                    section.id,
                    order
                );
                await prisma.$transaction(
                    updates.map((s) =>
                        prisma.section.update({
                            where: { id: s.id },
                            data: { order: s.order },
                        })
                    )
                );
            }

            if (title !== undefined) {
                await prisma.section.update({
                    where: { id: section.id },
                    data: { title },
                });
            }

            const updated = await prisma.section.findUnique({
                where: { id: section.id },
            });

            void notifyBoard(board.id, "section.updated", req.user.userId, {
                section: updated,
            });

            return res.status(200).json({
                message: "Section updated successfully",
                section: updated,
            });
        } catch (error) {
            console.error("Update section error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.delete(
    "/sections/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const section = await prisma.section.findUnique({
                where: { id: req.params.id as string },
            });
            if (!section) {
                return res.status(404).json({ message: "Section not found" });
            }

            const board = await boardById(section.boardId);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!isAuthorized(membership, "MODERATOR")) {
                return res.status(403).json({
                    message: "Only admins and moderators can delete sections",
                });
            }

            await prisma.section.delete({ where: { id: section.id } });

            const updates = reindex(await orderedSections(board.id));
            await prisma.$transaction(
                updates.map((s) =>
                    prisma.section.update({
                        where: { id: s.id },
                        data: { order: s.order },
                    })
                )
            );

            void notifyBoard(board.id, "section.deleted", req.user.userId, {
                id: section.id,
            });

            return res.status(200).json({
                message: "Section deleted successfully",
            });
        } catch (error) {
            console.error("Delete section error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

export default router;
