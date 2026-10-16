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

// ponytail: one magic-email global bot. Multi-bot / org-scoped agents would
// need a `kind` enum column on User; upgrade when that's actually wanted.
const ensureAgent = async () => {
    const email = "plana-agent@plana.ai";
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return existing;
    return prisma.user.create({
        data: { email, password: crypto.randomUUID(), name: "Plana Agent" },
    });
};

// ponytail: synchronous single request, no stream/retry. Add streaming when
// prompt latency or token-usage cost makes the wait and truncation hurt.
const askAgent = async (title: string, description: string | null): Promise<string> => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return "Plana Agent isn't configured (missing OPENROUTER_API_KEY).";
    try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: process.env.OPENROUTER_MODEL ?? "openrouter/auto",
                messages: [
                    {
                        role: "user",
                        content:
                            `Explain this task so a new team member can start on it. ` +
                            `Keep it under 1800 characters.\n\nTitle: ${title}\n` +
                            `Description: ${description ?? "(none)"}`,
                    },
                ],
            }),
        });
        if (!res.ok) {
            console.error("OpenRouter error:", res.status);
            return "The AI couldn't respond right now. Try again in a moment.";
        }
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        return (data.choices?.[0]?.message?.content ?? "").slice(0, 2000).trim();
    } catch (error) {
        console.error("Askagent error:", error);
        return "The AI Agent couldn't reach OpenRouter right now.";
    }
};

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

router.post(
    "/issues/:id/explain",
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
                    message: "Only admins and moderators can ask the Plana Agent",
                });
            }

            const agent = await ensureAgent();
            const content = await askAgent(issue.title, issue.description);
            if (!content) {
                return res.status(502).json({
                    message: "The Plana Agent produced no explanation.",
                });
            }

            const created = await prisma.comment.create({
                data: {
                    content,
                    issueId: issue.id,
                    authorId: agent.id,
                },
            });

            const comment = await commentWithAuthor(created.id);

            void notifyBoard(board.id, "comment.created", agent.id, {
                comment: shapeComment(comment),
            });

            return res.status(201).json({
                message: "Plana Agent explained the task",
                comment: shapeComment(comment),
            });
        } catch (error) {
            console.error("Ask agent error:", error);
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
