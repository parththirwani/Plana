import { Router, type Response } from "express";
import { prisma } from "@repo/db/db";
import { authMiddleware, type AuthenticatedRequest } from "../middleware/auth";
import { getMembership, isAuthorized } from "./organization";
import { boardForIssue } from "./issue";
import {
    createAgentRun,
    approveAgentRun,
    sendRunMessage,
    cancelAgentRun,
} from "../schema/agentRun";
import {
    listEngineSpecs,
    validateRunSelection,
} from "../adapters/capabilities";
import {
    createRun,
    cancelRun,
    getRunById,
    listRunsForIssue,
    shapeRun,
} from "../runs/runRepository";
import { appendRunEvent, readRunEvents } from "../runs/eventLog";
import { shapeRunEvent } from "../runs/events";
import { recordApproval } from "../runs/approvals";
import { isTerminalRunStatus } from "../runs/status";
import { runErrorFrom, type RunError } from "../runs/errors";
import { getJobStore } from "../jobs/jobStore";

// Agent-run HTTP API (CP4). Mounted at /api/v1 in index.ts.
//
// Ground rules enforced here:
//   * handlers only persist state + enqueue durable jobs — NO engine, sandbox
//     or GitHub work happens inline;
//   * authz mirrors the existing routers: getMembership + isAuthorized, 403
//     for missing role / non-members (same as GET /boards/:id), 404 for
//     missing entities; launch/approve/cancel/resume/message need MODERATOR,
//     reads need org membership;
//   * unsupported engine/model/option/answers 400 with an explicit disabled
//     reason from the capability contract — nothing is ever substituted;
//   * responses use the `{ message, ...payload }` shape + README status codes;
//     RunError codes from the run layer map onto 400/403/404/409 below.

const RUN_ERROR_STATUS: Record<RunError["code"], number> = {
    INVALID_INPUT: 400,
    UNSUPPORTED_CAPABILITY: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    ACTIVE_RUN_EXISTS: 409,
    STALE_APPROVAL: 409,
    ILLEGAL_TRANSITION: 409,
    TERMINAL_STATE: 409,
    INTERNAL: 500,
};

const respondRunError = (res: Response, error: unknown) => {
    const runError = runErrorFrom(error);
    if (!runError) {
        console.error("Agent run request failed:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
    const status = RUN_ERROR_STATUS[runError.code] ?? 400;
    return res.status(status).json({
        message: runError.message,
        code: runError.code,
        ...runError.details,
    });
};

const unauthorized = (res: Response) => {
    return res.status(401).json({ message: "Unauthorized" });
};

const requireIssueAccess = async (
    res: Response,
    req: AuthenticatedRequest,
    issueId: string,
    minRole: "MEMBER" | "MODERATOR"
): Promise<
    | { ok: true; userId: string; organizationId: string; issue: any; board: any }
    | { ok: false }
> => {
    if (!req.user) {
        unauthorized(res);
        return { ok: false };
    }
    const issue = await prisma.issue.findUnique({ where: { id: issueId } });
    if (!issue) {
        res.status(404).json({ message: "Issue not found" });
        return { ok: false };
    }
    const board = await boardForIssue(issue as any);
    if (!board) {
        res.status(404).json({ message: "Board not found" });
        return { ok: false };
    }
    const membership = await getMembership(board.organizationId, req.user.userId);
    if (!membership || !isAuthorized(membership, "MEMBER")) {
        res.status(403).json({
            message: "Only organization members can access agent runs",
        });
        return { ok: false };
    }
    if (!isAuthorized(membership, minRole)) {
        res.status(403).json({
            message: "Only admins and moderators can launch or operate agent runs",
        });
        return { ok: false };
    }
    return {
        ok: true,
        userId: req.user.userId,
        organizationId: board.organizationId,
        issue,
        board,
    };
};

const requireRunAccess = async (
    res: Response,
    req: AuthenticatedRequest,
    runId: string,
    minRole: "MEMBER" | "MODERATOR"
): Promise<{ ok: true; userId: string; run: any } | { ok: false }> => {
    if (!req.user) {
        unauthorized(res);
        return { ok: false };
    }
    const run = await getRunById(runId);
    if (!run) {
        res.status(404).json({ message: "Run not found" });
        return { ok: false };
    }
    const membership = await getMembership(run.organizationId, req.user.userId);
    if (!membership || !isAuthorized(membership, "MEMBER")) {
        res.status(403).json({
            message: "Only organization members can access this run",
        });
        return { ok: false };
    }
    if (!isAuthorized(membership, minRole)) {
        res.status(403).json({
            message: "Only admins and moderators can launch or operate agent runs",
        });
        return { ok: false };
    }
    return { ok: true, userId: req.user.userId, run };
};

const configForOrg = (organizationId: string) =>
    prisma.organizationAgentConfig.findUnique({ where: { organizationId } });

const nowIso = () => new Date().toISOString();

const router = Router();

// ---------------------------------------------------------------- create ---

router.post(
    "/issues/:id/agent-runs",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = createAgentRun.safeParse(req.body);
            if (!parsedBody.success) {
                return res
                    .status(400)
                    .json({ message: "Fields not according to schema" });
            }
            const access = await requireIssueAccess(
                res,
                req,
                req.params.id as string,
                "MODERATOR"
            );
            if (!access.ok) return res;

            const body = parsedBody.data;

            // The capability contract is the only source of truth: a rejected
            // selection answers 400 with the explicit reason and NOTHING is
            // substituted or auto-switched.
            const selection = validateRunSelection({
                engine: body.engine,
                model: body.model,
                options: body.options,
                executionMode: body.executionMode,
            });
            if (!selection.ok) {
                return res.status(400).json({
                    message: selection.issue.reason,
                    code: selection.issue.code,
                    field: selection.issue.field,
                    requested: selection.issue.requested,
                    ...(selection.issue.available
                        ? { available: selection.issue.available }
                        : {}),
                });
            }

            const config = await configForOrg(access.organizationId);
            const allowedRepositories = config?.allowedRepositories ?? [];
            const repository =
                body.repository ??
                access.issue.repository ??
                access.board.defaultRepository ??
                null;
            if (!repository) {
                return res.status(400).json({
                    message:
                        "No repository selected: configure the org agent config, the board default repository or the issue override, or pass repository",
                    code: "UNSUPPORTED_CAPABILITY",
                    field: "repository",
                });
            }
            if (!allowedRepositories.includes(repository)) {
                return res.status(400).json({
                    message:
                        allowedRepositories.length === 0
                            ? `Organization has no agent configuration yet, so no repositories are allowed; repository '${repository}' cannot be used`
                            : `Repository '${repository}' is not in the organization's allowed repositories`,
                    code: "UNSUPPORTED_CAPABILITY",
                    field: "repository",
                    requested: repository,
                    available: allowedRepositories,
                });
            }

            const result = await createRun({
                issueId: access.issue.id,
                organizationId: access.organizationId,
                createdBy: access.userId,
                engine: body.engine,
                model: body.model,
                options: body.options ?? {},
                executionMode: body.executionMode ?? "IMPLEMENT",
                repository,
                idempotencyKey: body.idempotencyKey,
            });

            if (result.replayed) {
                return res.status(200).json({
                    message:
                        "Run already exists for this idempotency key",
                    run: shapeRun(result.run),
                    replayed: true,
                });
            }

            // Durable enqueue only — the worker (CP5) claims it later. No
            // engine/sandbox/GitHub call happens in this request.
            const { job } = await getJobStore().enqueue({
                type: "agent.run.execute",
                runId: result.run.id,
                idempotencyKey: `run:${result.run.id}:start`,
                payload: {
                    reason: "created",
                    executionMode: result.run.executionMode,
                },
            });

            return res.status(201).json({
                message: "Run queued successfully",
                run: shapeRun(result.run),
                queued: { jobId: job.id, type: job.type, status: job.status },
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

// ------------------------------------------------------- list / read -------

router.get(
    "/issues/:id/agent-runs",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const access = await requireIssueAccess(
                res,
                req,
                req.params.id as string,
                "MEMBER"
            );
            if (!access.ok) return res;
            const runs = await listRunsForIssue(access.issue.id);
            return res.status(200).json({
                message: "Agent runs fetched successfully",
                runs: runs.map(shapeRun),
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

router.get(
    "/issues/:id/agent-runs/capabilities",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const access = await requireIssueAccess(
                res,
                req,
                req.params.id as string,
                "MEMBER"
            );
            if (!access.ok) return res;
            const config = await configForOrg(access.organizationId);
            return res.status(200).json({
                message: "Agent capabilities fetched successfully",
                engines: listEngineSpecs(),
                allowedRepositories: config?.allowedRepositories ?? [],
                repositories: {
                    boardDefault: access.board.defaultRepository ?? null,
                    issueOverride: access.issue.repository ?? null,
                },
                defaults: {
                    engine: config?.defaultEngine ?? null,
                    model: config?.defaultModel ?? null,
                    executionMode: config?.defaultExecutionMode ?? "IMPLEMENT",
                    runBudgetUsd: config?.runBudgetUsd ?? null,
                },
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

router.get(
    "/agent-runs/:id",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MEMBER"
            );
            if (!access.ok) return res;
            return res.status(200).json({
                message: "Run fetched successfully",
                run: shapeRun(access.run),
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

router.get(
    "/agent-runs/:id/events",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MEMBER"
            );
            if (!access.ok) return res;
            const afterSequence = Number(req.query.afterSequence ?? 0);
            const limit = Number(req.query.limit ?? 50);
            const page = await readRunEvents({
                runId: access.run.id,
                afterSequence: Number.isFinite(afterSequence)
                    ? afterSequence
                    : 0,
                limit: Number.isFinite(limit) ? limit : undefined,
            });
            return res.status(200).json({
                message: "Run events fetched successfully",
                ...page,
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

// ------------------------------------------------------------ approvals ----

router.post(
    "/agent-runs/:id/approvals",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = approveAgentRun.safeParse(req.body);
            if (!parsedBody.success) {
                return res
                    .status(400)
                    .json({ message: "Fields not according to schema" });
            }
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MODERATOR"
            );
            if (!access.ok) return res;

            const result = await recordApproval({
                runId: access.run.id,
                planVersion: parsedBody.data.planVersion,
                decision: parsedBody.data.decision,
                decidedBy: access.userId,
                ...(parsedBody.data.baseCommit !== undefined
                    ? { baseCommit: parsedBody.data.baseCommit }
                    : {}),
            });

            return res.status(result.replayed ? 200 : 201).json({
                message: result.replayed
                    ? "Approval already recorded"
                    : "Approval recorded successfully",
                approval: result.approval,
                run: shapeRun(result.run),
                replayed: result.replayed,
                ...(result.job ? { jobId: result.job.id } : {}),
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

// ------------------------------------------------------------- messages ----

router.post(
    "/agent-runs/:id/messages",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = sendRunMessage.safeParse(req.body);
            if (!parsedBody.success) {
                return res
                    .status(400)
                    .json({ message: "Fields not according to schema" });
            }
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MODERATOR"
            );
            if (!access.ok) return res;
            if (isTerminalRunStatus(access.run.status)) {
                return res.status(409).json({
                    message: `Run is ${access.run.status}; finished runs cannot receive messages`,
                    code: "TERMINAL_STATE",
                    status: access.run.status,
                });
            }

            const event = await appendRunEvent({
                runId: access.run.id,
                type: "run.message",
                issueId: access.run.issueId,
                status: access.run.status,
                data: {
                    kind: "user-message",
                    authorId: access.userId,
                    text: parsedBody.data.text,
                },
            });
            const { job } = await getJobStore().enqueue({
                type: "agent.run.message",
                runId: access.run.id,
                payload: { eventSequence: event.sequence, text: parsedBody.data.text },
            });

            return res.status(201).json({
                message: "Run message recorded successfully",
                event: shapeRunEvent(event),
                jobId: job.id,
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

// -------------------------------------------------------------- cancel -----

router.post(
    "/agent-runs/:id/cancel",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const parsedBody = cancelAgentRun.safeParse(req.body ?? {});
            if (!parsedBody.success) {
                return res
                    .status(400)
                    .json({ message: "Fields not according to schema" });
            }
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MODERATOR"
            );
            if (!access.ok) return res;

            const run = await cancelRun({
                runId: access.run.id,
                actorId: access.userId,
                reason: parsedBody.data.reason,
            });

            // Cancel work that has not started. RUNNING jobs stay with their
            // fenced owner; the terminal run state + fencing tokens are what
            // stop late results from publishing (CP2/CP5 invariant).
            const store = getJobStore();
            const jobs = await store.listByRun(access.run.id);
            const cancelled: string[] = [];
            for (const job of jobs) {
                if (job.status !== "QUEUED") continue;
                const result = await store.cancelQueued(job.id, nowIso());
                if (result) cancelled.push(job.id);
            }

            return res.status(200).json({
                message: "Run cancelled successfully",
                run: shapeRun(run),
                cancelledJobIds: cancelled,
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

// -------------------------------------------------------------- resume -----

router.post(
    "/agent-runs/:id/resume",
    authMiddleware,
    async (req: AuthenticatedRequest, res) => {
        try {
            const access = await requireRunAccess(
                res,
                req,
                req.params.id as string,
                "MODERATOR"
            );
            if (!access.ok) return res;
            if (isTerminalRunStatus(access.run.status)) {
                return res.status(409).json({
                    message: `Run is ${access.run.status}; terminal states cannot be resumed`,
                    code: "TERMINAL_STATE",
                    status: access.run.status,
                });
            }

            const store = getJobStore();
            const jobs = await store.listByRun(access.run.id);
            const active = jobs.find(
                (job) => job.status === "QUEUED" || job.status === "RUNNING"
            );
            if (active) {
                return res.status(200).json({
                    message: "Run already has durable work scheduled",
                    run: shapeRun(access.run),
                    coalesced: true,
                    jobId: active.id,
                });
            }

            const { job } = await store.enqueue({
                type: "agent.run.execute",
                runId: access.run.id,
                idempotencyKey: `run:${access.run.id}:resume`,
                payload: {
                    reason: "manual-resume",
                    planVersion: access.run.planVersion,
                },
            });
            await appendRunEvent({
                runId: access.run.id,
                type: "run.message",
                issueId: access.run.issueId,
                status: access.run.status,
                data: {
                    kind: "resume-requested",
                    actorId: access.userId,
                    jobId: job.id,
                },
            });

            return res.status(200).json({
                message: "Run re-queued successfully",
                run: shapeRun(access.run),
                coalesced: false,
                jobId: job.id,
            });
        } catch (error) {
            return respondRunError(res, error);
        }
    }
);

export default router;
