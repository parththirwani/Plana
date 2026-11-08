import { Router } from "express";
import { prisma } from "@repo/db/db";
import { z } from "zod";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { getMembership, isAuthorized } from "./organization";
import { boardForIssue } from "./issue";
import { listEngineSpecs, validateRunSelection } from "../adapters/capabilities";
const repository = z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(200);
const config = z
    .object({
        allowedRepositories: z.array(repository).max(100),
        defaultEngine: z
            .enum(["CODEX", "CLAUDE_CODE", "OPENCODE", "PI"])
            .nullable()
            .optional(),
        defaultModel: z.string().min(1).max(120).nullable().optional(),
        defaultExecutionMode: z
            .enum(["IMPLEMENT", "PLAN_AND_APPROVE"])
            .optional(),
        runBudgetUsd: z.number().positive().max(1000).optional(),
        dailyOrgBudgetUsd: z.number().positive().max(10000).optional(),
    })
    .strict();
const selection = z.object({ repository: repository.nullable() }).strict();
const router = Router();
router.get(
    "/organizations/:id/agent-config",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const organizationId = req.params.id as string;
            const membership = await getMembership(organizationId, req.user!.userId);
            if (!membership || !isAuthorized(membership, "MEMBER"))
                return res.status(403).json({ message: "Only organization members can view agent policy" });
            const agentConfig = await prisma.organizationAgentConfig.findUnique({ where: { organizationId } });
            return res.status(200).json({
                message: "Agent policy fetched",
                config: agentConfig,
                engines: listEngineSpecs(),
                simulation: process.env.AGENT_EXECUTION_MODE === "fake",
            });
        } catch (error) {
            console.error("Agent policy fetch failed", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    },
);
router.put(
    "/organizations/:id/agent-config",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const organizationId = req.params.id as string;
            const membership = await getMembership(
                organizationId,
                req.user!.userId,
            );
            if (!membership || !isAuthorized(membership, "ADMIN"))
                return res
                    .status(403)
                    .json({
                        message: "Only organization admins manage agent policy",
                    });
            const body = config.safeParse(req.body);
            if (!body.success)
                return res
                    .status(400)
                    .json({ message: "Fields not according to schema" });
            const existing = await prisma.organizationAgentConfig.findUnique({ where: { organizationId } });
            const engine = body.data.defaultEngine === undefined ? existing?.defaultEngine : body.data.defaultEngine;
            const model = body.data.defaultModel === undefined ? existing?.defaultModel : body.data.defaultModel;
            if (!!engine !== !!model)
                return res.status(400).json({ message: "Choose both a default harness and model, or clear both" });
            if (engine && model) {
                const selected = validateRunSelection({
                    engine, model,
                    executionMode: body.data.defaultExecutionMode ?? existing?.defaultExecutionMode ?? "IMPLEMENT",
                }, true);
                if (!selected.ok) return res.status(400).json({ message: selected.issue.reason });
            }
            // Persist the validated pair together, including on partial policy updates.
            const values = { ...body.data, defaultEngine: engine ?? null, defaultModel: model ?? null };
            const agentConfig = await prisma.organizationAgentConfig.upsert({
                where: { organizationId },
                create: { organizationId, ...values },
                update: values,
            });
            return res
                .status(200)
                .json({ message: "Agent policy saved", config: agentConfig });
        } catch (error) {
            console.error("Agent policy update failed", error);
            return res.status(500).json({ message: "Internal server error" });
        }
    },
);
for (const kind of ["boards", "issues"] as const) {
    router.patch(
        `/${kind}/:id/agent-repository`,
        authMiddleware,
        async (req: AuthenticatedRequest, res) => {
            try {
                const id = req.params.id as string;
                const body = selection.safeParse(req.body);
                if (!body.success)
                    return res
                        .status(400)
                        .json({ message: "Fields not according to schema" });
                const issue =
                    kind === "issues"
                        ? await prisma.issue.findUnique({ where: { id } })
                        : null;
                const board =
                    kind === "boards"
                        ? await prisma.board.findUnique({ where: { id } })
                        : issue
                          ? await boardForIssue(issue)
                          : null;
                if (!board)
                    return res
                        .status(404)
                        .json({ message: "Board or issue not found" });
                const membership = await getMembership(
                    board.organizationId,
                    req.user!.userId,
                );
                if (!membership || !isAuthorized(membership, "MODERATOR"))
                    return res.status(403).json({
                        message:
                            "Only admins and moderators select repositories",
                    });
                const policy = await prisma.organizationAgentConfig.findUnique({
                    where: { organizationId: board.organizationId },
                });
                if (
                    body.data.repository &&
                    !policy?.allowedRepositories.includes(body.data.repository)
                )
                    return res.status(400).json({
                        message:
                            "Repository is not allowed by organization policy",
                    });
                const result =
                    kind === "boards"
                        ? await prisma.board.update({
                              where: { id },
                              data: { defaultRepository: body.data.repository },
                          })
                        : await prisma.issue.update({
                              where: { id },
                              data: { repository: body.data.repository },
                          });
                return res.status(200).json({
                    message: "Agent repository saved",
                    [kind === "boards" ? "board" : "issue"]: result,
                });
            } catch (error) {
                console.error("Agent repository update failed", error);
                return res
                    .status(500)
                    .json({ message: "Internal server error" });
            }
        },
    );
}
export default router;
