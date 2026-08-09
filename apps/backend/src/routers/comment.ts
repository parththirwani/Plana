import { Router } from "express";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { prisma } from "@repo/db/db";
import { createComment, updateComment } from "../schema/comment";
import { notifyBoard } from "../lib/notify";
import { boardForIssue } from "./issue";
import { getMembership, isAuthorized } from "./organization";

const router = Router();

const shapeComment = (comment: any) => ({
    id: comment.id,
    content: comment.content,
    issueId: comment.issueId,
    authorId: comment.authorId,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    author: comment.author
        ? {
              id: comment.author.id,
              email: comment.author.email,
              name: comment.author.name,
              avatarUrl: comment.author.avatarUrl,
          }
        : null,
});

const commentWithAuthor = async (id: string) =>
    prisma.comment.findUnique({
        where: { id },
        include: { author: true },
    });

const issueBoard = async (issueId: string) => {
    const issue = await prisma.issue.findUnique({ where: { id: issueId } });
    return issue ? boardForIssue(issue) : null;
};

router.post(
    "/issues/:id/comments",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = createComment.safeParse(req.body);
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
            if (!isAuthorized(membership, "MEMBER")) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            const created = await prisma.comment.create({
                data: {
                    content: parsedBody.data.content,
                    issueId: issue.id,
                    authorId: req.user.userId,
                },
            });

            const comment = await commentWithAuthor(created.id);

            void notifyBoard(board.id, "comment.created", req.user.userId, {
                comment: shapeComment(comment),
            });

            return res.status(201).json({
                message: "Comment created successfully",
                comment: shapeComment(comment),
            });
        } catch (error) {
            console.error("Create comment error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.get(
    "/issues/:id/comments",
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
            if (!isAuthorized(membership, "MEMBER")) {
                return res.status(403).json({
                    message: "You are not a member of this organization",
                });
            }

            const comments = await prisma.comment.findMany({
                where: { issueId: issue.id },
                include: { author: true },
            });
            comments.sort(
                (a, b) =>
                    new Date(a.createdAt).getTime() -
                    new Date(b.createdAt).getTime()
            );

            return res.status(200).json({
                message: "Comments fetched successfully",
                comments: comments.map(shapeComment),
            });
        } catch (error) {
            console.error("List comments error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

const canMutate = (
    membership: { role: string } | null,
    commentAuthorId: string,
    userId: string
) =>
    isAuthorized(membership, "MEMBER") &&
    (commentAuthorId === userId || isAuthorized(membership, "MODERATOR"));

router.patch(
    "/comments/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const parsedBody = updateComment.safeParse(req.body);
            if (!parsedBody.success) {
                return res.status(400).json({
                    message: "Fields not according to schema",
                });
            }

            const comment = await prisma.comment.findUnique({
                where: { id: req.params.id as string },
            });
            if (!comment) {
                return res.status(404).json({ message: "Comment not found" });
            }

            const board = await issueBoard(comment.issueId);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!canMutate(membership, comment.authorId, req.user.userId)) {
                return res.status(403).json({
                    message: "Only the author or moderators can edit this comment",
                });
            }

            await prisma.comment.update({
                where: { id: comment.id },
                data: { content: parsedBody.data.content },
            });

            const updated = await commentWithAuthor(comment.id);

            void notifyBoard(board.id, "comment.updated", req.user.userId, {
                comment: shapeComment(updated),
            });

            return res.status(200).json({
                message: "Comment updated successfully",
                comment: shapeComment(updated),
            });
        } catch (error) {
            console.error("Update comment error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.delete(
    "/comments/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ message: "Unauthorized" });
            }

            const comment = await prisma.comment.findUnique({
                where: { id: req.params.id as string },
            });
            if (!comment) {
                return res.status(404).json({ message: "Comment not found" });
            }

            const board = await issueBoard(comment.issueId);
            if (!board) {
                return res.status(404).json({ message: "Board not found" });
            }

            const membership = await getMembership(
                board.organizationId,
                req.user.userId
            );
            if (!canMutate(membership, comment.authorId, req.user.userId)) {
                return res.status(403).json({
                    message: "Only the author or moderators can delete this comment",
                });
            }

            await prisma.comment.delete({ where: { id: comment.id } });

            void notifyBoard(board.id, "comment.deleted", req.user.userId, {
                id: comment.id,
            });

            return res.status(200).json({
                message: "Comment deleted successfully",
            });
        } catch (error) {
            console.error("Delete comment error:", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    }
);

export default router;
