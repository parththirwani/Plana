import { describe, test, expect, beforeEach } from "bun:test";
import { createMemoryJobStore } from "../jobs/memoryJobStore";
import {
    CANCEL_QUEUED_SQL,
    CLAIM_NEXT_SQL,
    COMPLETE_SQL,
    ENQUEUE_SQL,
    FAIL_SQL,
    RENEW_LEASE_SQL,
} from "../jobs/postgresJobStore";
import type { JobStore } from "../jobs/types";
import { prismaMock } from "../test-utils/prismaMock";
import type { MockAgentRun, MockIssue } from "../test-utils/prismaMock";

const T0 = Date.parse("2026-11-08T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

describe("durable job queue (CP2)", () => {
    let store: JobStore;

    beforeEach(() => {
        store = createMemoryJobStore();
    });

    const enqueueRunStart = (key: string, availableAt = at(0)) =>
        store.enqueue({
            type: "run.start",
            runId: `run_${key}`,
            payload: { note: key },
            idempotencyKey: key,
            availableAt,
        });

    test("enqueue is idempotent on the key, even under concurrency", async () => {
        const [a, b, c] = await Promise.all([
            enqueueRunStart("dup-key"),
            enqueueRunStart("dup-key"),
            enqueueRunStart("dup-key"),
        ]);
        const results = [a, b, c];
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(
            new Set(results.map((r) => r.job.id)).size,
            "duplicate enqueue must be a no-op returning the same job"
        ).toBe(1);
        expect(results.every((r) => r.job.status === "QUEUED")).toBe(true);

        const found = await store.findByIdempotencyKey("dup-key");
        expect(found?.id).toBe(a.job.id);

        // Null keys never deduplicate.
        const x = await store.enqueue({ type: "run.cleanup" });
        const y = await store.enqueue({ type: "run.cleanup" });
        expect(x.created && y.created).toBe(true);
        expect(x.job.id).not.toBe(y.job.id);
    });

    test("a claim assigns a strictly increasing fencing token, attempts and lease", async () => {
        const { job } = await enqueueRunStart("fence-1");
        const claim = await store.claimNext("worker_A", at(0), {
            leaseMs: 60_000,
        });
        expect(claim).not.toBeNull();
        expect(claim!.job.id).toBe(job.id);
        expect(claim!.job.status).toBe("RUNNING");
        expect(claim!.job.lockedBy).toBe("worker_A");
        expect(claim!.job.attempts).toBe(1);
        expect(claim!.fencingToken).toBe(1);
        expect(claim!.job.leaseExpiresAt).toBe(at(60));

        // A reclaim (after expiry below) must produce a STRICTLY larger token.
        const reclaim = await store.claimNext("worker_B", at(61));
        expect(reclaim).not.toBeNull();
        expect(reclaim!.job.id).toBe(job.id);
        expect(reclaim!.fencingToken).toBe(2);
        expect(reclaim!.job.attempts).toBe(2);
    });

    test("concurrent claimNext calls never hand the same job to two workers (SKIP LOCKED exclusivity)", async () => {
        for (const key of ["c1", "c2", "c3"]) {
            await enqueueRunStart(key);
        }
        const claimers = Array.from({ length: 8 }, (_, i) =>
            store.claimNext(`worker_${i}`, at(0), { leaseMs: 60_000 })
        );
        const claims = (await Promise.all(claimers)).filter(
            (c): c is NonNullable<typeof c> => c !== null
        );
        expect(claims).toHaveLength(3);
        expect(new Set(claims.map((c) => c.job.id)).size).toBe(3);
        expect(new Set(claims.map((c) => c.job.lockedBy)).size).toBe(3);

        // Leases are alive: nobody else can take anything.
        const later = await Promise.all(
            Array.from({ length: 4 }, (_, i) =>
                store.claimNext(`late_${i}`, at(30))
            )
        );
        expect(later.every((c) => c === null)).toBe(true);

        // After lease expiry a new round of owners takes over.
        const reclaimed = (
            await Promise.all(
                Array.from({ length: 3 }, (_, i) =>
                    store.claimNext(`reclaimer_${i}`, at(121))
                )
            )
        ).filter((c): c is NonNullable<typeof c> => c !== null);
        expect(reclaimed).toHaveLength(3);
        expect(
            reclaimed.every(
                (c) =>
                    c.fencingToken === 2 &&
                    c.job.lockedBy?.startsWith("reclaimer_")
            )
        ).toBe(true);
    });

    test("an expired lease transfers ownership and the stale owner can no longer mutate the job", async () => {
        const { job } = await enqueueRunStart("steal");
        const first = await store.claimNext("worker_A", at(0), {
            leaseMs: 60_000,
        });
        expect(first).not.toBeNull();

        // A stops renewing; B reclaims after expiry with a newer token.
        const second = await store.claimNext("worker_B", at(61));
        expect(second?.fencingToken).toBe(2);
        expect(second?.job.lockedBy).toBe("worker_B");

        // Zombie worker_A (stale fencing token) can do nothing.
        expect(await store.renewLease(job.id, "worker_A", 1, at(62))).toBeNull();
        expect(await store.complete(job.id, "worker_A", 1, at(62))).toBeNull();
        expect(
            await store.fail(job.id, "worker_A", 1, at(62), "zombie retry")
        ).toBeNull();
        // Even the right owner with the wrong token is fenced out.
        expect(await store.complete(job.id, "worker_B", 1, at(62))).toBeNull();

        const current = await store.get(job.id);
        expect(current?.status).toBe("RUNNING");
        expect(current?.lockedBy).toBe("worker_B");
        expect(current?.lastError).toBeNull();

        // The live owner completes; completion is terminal.
        const done = await store.complete(job.id, "worker_B", 2, at(63));
        expect(done?.status).toBe("COMPLETED");
        expect(done?.leaseExpiresAt).toBeNull();
        expect(
            await store.complete(job.id, "worker_B", 2, at(64))
        ).toBeNull();
        expect(await store.renewLease(job.id, "worker_B", 2, at(64))).toBeNull();
    });

    test("renewLease extends the lease and blocks reclaim until the extended expiry", async () => {
        const { job } = await enqueueRunStart("renew");
        const first = await store.claimNext("worker_A", at(0), {
            leaseMs: 30_000,
        });
        expect(first?.job.leaseExpiresAt).toBe(at(30));

        const renewed = await store.renewLease(
            job.id,
            "worker_A",
            first!.fencingToken,
            at(20),
            30_000
        );
        expect(renewed?.leaseExpiresAt).toBe(at(50));

        expect(await store.claimNext("worker_B", at(40))).toBeNull();
        const stolen = await store.claimNext("worker_B", at(51));
        expect(stolen?.job.lockedBy).toBe("worker_B");
        expect(stolen?.fencingToken).toBe(2);
    });

    test("fail retries until maxAttempts, respects the backoff, then terminally fails", async () => {
        const { job } = await store.enqueue({
            type: "run.start",
            idempotencyKey: "retry",
            maxAttempts: 2,
            availableAt: at(0),
        });

        const c1 = await store.claimNext("w1", at(0));
        expect(c1?.job.attempts).toBe(1);
        const f1 = await store.fail(
            job.id,
            "w1",
            c1!.fencingToken,
            at(1),
            "engine crashed",
            at(31)
        );
        expect(f1?.status).toBe("QUEUED");
        expect(f1?.availableAt).toBe(at(31));
        expect(f1?.lockedBy).toBeNull();
        expect(f1?.lastError).toBe("engine crashed");

        // Not claimable during backoff.
        expect(await store.claimNext("w2", at(30))).toBeNull();

        const c2 = await store.claimNext("w2", at(31));
        expect(c2?.job.attempts).toBe(2);
        const f2 = await store.fail(
            job.id,
            "w2",
            c2!.fencingToken,
            at(32),
            "still broken",
            at(61)
        );
        expect(f2?.status, "attempts(2) >= maxAttempts(2) must be terminal")
            .toBe("FAILED");
        expect(f2?.lastError).toBe("still broken");
        expect(await store.claimNext("w3", at(200))).toBeNull();
    });

    test("claims respect availableAt ordering and an optional type filter", async () => {
        await store.enqueue({
            type: "run.cleanup",
            idempotencyKey: "late",
            availableAt: at(10),
        });
        await store.enqueue({
            type: "run.start",
            idempotencyKey: "early",
            availableAt: at(0),
        });

        const first = await store.claimNext("w", at(0));
        expect(first?.job.idempotencyKey).toBe("early");

        // Type filter: only run.cleanup is eligible.
        const cleanupOnly = await Promise.all([
            store.claimNext("w2", at(10), { types: ["run.cleanup"] }),
        ]);
        expect(cleanupOnly[0]?.job.type).toBe("run.cleanup");

        // Release the first job; nothing claimable remains (the cleanup lease
        // is still alive at at(30)).
        const done = await store.complete(
            first!.job.id,
            "w",
            first!.fencingToken,
            at(20)
        );
        expect(done?.status).toBe("COMPLETED");
        expect(await store.claimNext("w3", at(30))).toBeNull();
    });

    test("cancel only affects QUEUED jobs; RUNNING/terminal jobs are untouched", async () => {
        const a = await store.enqueue({ type: "run.start", idempotencyKey: "ca" });
        const b = await store.enqueue({ type: "run.start", idempotencyKey: "cb" });

        const cancelled = await store.cancelQueued(a.job.id, at(1));
        expect(cancelled?.status).toBe("CANCELLED");
        expect(await store.cancelQueued(a.job.id, at(2))).toBeNull();

        const claimed = await store.claimNext("w", at(3));
        expect(claimed?.job.id).toBe(b.job.id);
        expect(await store.cancelQueued(b.job.id, at(4))).toBeNull();

        await store.complete(b.job.id, "w", claimed!.fencingToken, at(5));
        expect(await store.cancelQueued(b.job.id, at(6))).toBeNull();

        // CANCELLED jobs are never claimable.
        expect(await store.claimNext("w9", at(1000))).toBeNull();
    });

    test("listByRun groups jobs by run and get() returns a detached copy", async () => {
        const j1 = await store.enqueue({
            type: "run.start",
            runId: "run_x",
            availableAt: at(0),
        });
        await new Promise((r) => setTimeout(r, 5));
        const j2 = await store.enqueue({
            type: "run.publish",
            runId: "run_x",
            availableAt: at(1),
        });
        await store.enqueue({ type: "run.start", runId: "run_y" });

        const list = await store.listByRun("run_x");
        expect(list.map((j) => j.id)).toEqual([j1.job.id, j2.job.id]);

        const copy = await store.get(j1.job.id);
        (copy!.payload as Record<string, unknown>).mutated = true;
        expect((await store.get(j1.job.id))?.payload.mutated).toBeUndefined();
    });
});

describe("durable job queue Postgres SQL shape (pinned, CP2)", () => {
    test("claim SQL uses FOR UPDATE SKIP LOCKED with ordering, lease-expiry reclaim and fencing increment", () => {
        expect(CLAIM_NEXT_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
        expect(CLAIM_NEXT_SQL).toMatch(/ORDER BY "availableAt" ASC/);
        // Both eligibility arms: fresh queued jobs and expired leases.
        expect(CLAIM_NEXT_SQL).toMatch(/"status" = 'QUEUED'/);
        expect(CLAIM_NEXT_SQL).toMatch(
            /"status" = 'RUNNING' AND "leaseExpiresAt" <= \$\d/
        );
        // Strictly-increasing fencing token + attempts increment per claim.
        expect(CLAIM_NEXT_SQL).toMatch(
            /"fencingToken" = j\."fencingToken" \+ 1/
        );
        expect(CLAIM_NEXT_SQL).toMatch(/"attempts" = j\."attempts" \+ 1/);
        expect(CLAIM_NEXT_SQL).toMatch(/LIMIT 1\s+FOR UPDATE SKIP LOCKED/);
        expect(CLAIM_NEXT_SQL).toMatch(/RETURNING/);
    });

    test("mutating SQL guards on owner + fencing token; enqueue is idempotent on the key", () => {
        expect(ENQUEUE_SQL).toMatch(
            /ON CONFLICT \("idempotencyKey"\) WHERE "idempotencyKey" IS NOT NULL DO NOTHING/
        );
        for (const sql of [RENEW_LEASE_SQL, COMPLETE_SQL, FAIL_SQL]) {
            expect(sql).toMatch(/"status" = 'RUNNING'/);
            expect(sql).toMatch(/"lockedBy" = \$2/);
            expect(sql).toMatch(/"fencingToken" = \$3/);
        }
        // Fail retries while attempts < maxAttempts, else terminal FAILED.
        expect(FAIL_SQL).toMatch(/"attempts" < "maxAttempts"/);
        expect(FAIL_SQL).toMatch(/'QUEUED' ELSE 'FAILED'/);
        // Only QUEUED jobs can be cancelled.
        expect(CANCEL_QUEUED_SQL).toMatch(/"status" = 'QUEUED'/);
        expect(CANCEL_QUEUED_SQL).toMatch(/'CANCELLED'/);
    });
});

const prisma = prismaMock.prisma;

const makeIssue = (
    id: string,
    title: string,
    sectionId: string,
    order: number
): MockIssue => ({
    id,
    title,
    description: null,
    order,
    priority: "NONE",
    dueDate: null,
    sectionId,
    assigneeIds: [],
});

const makeRun = (id: string, issueId: string): MockAgentRun => ({
    id,
    issueId,
    organizationId: "org_1",
    createdBy: "alice",
    engine: "CODEX",
    model: "gpt-5-codex",
    options: {},
    executionMode: "IMPLEMENT",
    repository: "acme/webapp",
    baseCommit: null,
    branchName: `plana/${issueId}/${id}`,
    status: "QUEUED",
    activeIssueId: issueId,
    planVersion: 0,
    owner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    idempotencyKey: `key-${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
});

const seedJobs = () =>
    prismaMock.reset({
        users: [
            {
                id: "alice",
                email: "alice@example.com",
                password: "pw",
                name: null,
                avatarUrl: null,
                onboardingCompleted: false,
            },
        ],
        organizations: [
            {
                id: "org_1",
                name: "Acme",
                slug: "acme",
                description: null,
                orgImage: null,
            },
        ],
        memberships: [
            { id: "mem_alice", userId: "alice", organizationId: "org_1", role: "ADMIN" },
        ],
        boards: [
            {
                id: "brd_1",
                title: "Board",
                description: null,
                organizationId: "org_1",
                defaultRepository: null,
            },
        ],
        sections: [{ id: "sec_1", title: "Todo", order: 0, boardId: "brd_1" }],
        issues: [makeIssue("iss_1", "Card one", "sec_1", 0)],
    });

describe("agent job data layer via prismaMock (CP2)", () => {
    beforeEach(seedJobs);

    const seedRunWithJob = async () => {
        await prisma.agentRun.create({ data: makeRun("run_1", "iss_1") });
        return prisma.agentJob.create({
            data: {
                type: "run.start",
                runId: "run_1",
                idempotencyKey: "enqueue-run_1",
                availableAt: "2026-11-08T10:00:00.000Z",
            },
        });
    };

    test("creates jobs with queue defaults and enforces idempotencyKey uniqueness (P2002)", async () => {
        const job = await seedRunWithJob();
        expect(job.status).toBe("QUEUED");
        expect(job.attempts).toBe(0);
        expect(job.maxAttempts).toBe(5);
        expect(job.fencingToken).toBe(0);
        expect(job.runId).toBe("run_1");

        try {
            await prisma.agentJob.create({
                data: { type: "run.start", idempotencyKey: "enqueue-run_1" },
            });
            throw new Error("expected unique constraint violation");
        } catch (error: any) {
            expect(error?.code).toBe("P2002");
        }
        // Null keys never deduplicate.
        const a = await prisma.agentJob.create({ data: { type: "run.tick" } });
        const b = await prisma.agentJob.create({ data: { type: "run.tick" } });
        expect(a.id).not.toBe(b.id);

        const byKey = await prisma.agentJob.findUnique({
            where: { idempotencyKey: "enqueue-run_1" },
        });
        expect(byKey?.id).toBe(job.id);
        expect(await prisma.agentJob.count({ where: {} })).toBe(3);
    });

    test("queue-style queries: status filter, orderBy availableAt, lease reclaim candidates", async () => {
        await seedRunWithJob();
        await prisma.agentJob.create({
            data: {
                type: "run.publish",
                status: "RUNNING",
                lockedBy: "worker_A",
                fencingToken: 1,
                leaseExpiresAt: "2026-11-08T09:00:00.000Z", // expired
                availableAt: "2026-11-08T08:00:00.000Z",
            },
        });
        await prisma.agentJob.create({
            data: {
                type: "run.publish",
                status: "RUNNING",
                lockedBy: "worker_C",
                leaseExpiresAt: "2026-12-01T00:00:00.000Z", // alive
                availableAt: "2026-11-08T08:30:00.000Z",
            },
        });

        const queued = await prisma.agentJob.findMany({
            where: { status: "QUEUED" },
            orderBy: { availableAt: "asc" },
        });
        expect(queued.map((j: any) => j.type)).toEqual(["run.start"]);

        // Expired-lease reclaim candidates, mirroring the claim predicate.
        const expired = await prisma.agentJob.findMany({
            where: {
                status: "RUNNING",
                leaseExpiresAt: { lte: "2026-11-08T10:00:00.000Z" },
            },
        });
        expect(expired).toHaveLength(1);
        expect(expired[0].lockedBy).toBe("worker_A");

        // Simulated claim: bump owner + fencing token under the guard.
        const claimed = await prisma.agentJob.update({
            where: { id: expired[0].id },
            data: {
                lockedBy: "worker_B",
                fencingToken: expired[0].fencingToken + 1,
                attempts: expired[0].attempts + 1,
                leaseExpiresAt: "2026-11-08T10:01:00.000Z",
            },
        });
        expect(claimed.fencingToken).toBe(2);
        expect(await prisma.agentJob.count({ where: { status: "RUNNING" } })).toBe(2);
    });

    test("deleting an issue or organization cascades to agent jobs", async () => {
        const job = await seedRunWithJob();
        await prisma.issue.delete({ where: { id: "iss_1" } });
        expect(await prisma.agentJob.findUnique({ where: { id: job.id } })).toBeNull();

        await prisma.agentRun.create({ data: makeRun("run_2", "iss_1") });
        const survivor = await prisma.agentJob.create({
            data: { type: "run.start", runId: "run_2" },
        });
        await prisma.organization.delete({ where: { id: "org_1" } });
        expect(
            await prisma.agentJob.findUnique({ where: { id: survivor.id } })
        ).toBeNull();
    });
});
