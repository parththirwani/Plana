/**
 * RUN STATE MACHINE — PROOFS AGAINST REAL POSTGRES (CP-A / CP-B / CP-D).
 *
 * The unit suites run against an in-memory Prisma stand-in. That stand-in is a
 * faithful *shape* mock and it is deliberately not a transaction manager: it has
 * no locks, no rollback and no unique-index enforcement across concurrent
 * statements. Which means every claim this correction pass actually rests on —
 * "atomic", "serializable", "a zombie cannot write" — is unprovable in the mock,
 * and pretending otherwise would be the same self-approval the review called
 * out. These tests therefore run the SAME production entry points against a
 * real Postgres, where `SELECT … FOR UPDATE` blocks, a rolled-back transaction
 * really erases its writes and a unique index is the thing that decides a race.
 *
 * What is proved here (and cannot be faked):
 *   CP-A  launch is one transaction: run row + `run.created` event + the
 *         per-issue slot + the caller's enqueue step commit together, or nothing
 *         does; a concurrent same-key launch replays instead of duplicating.
 *   CP-A' "at most one active run per issue" is decided by the database.
 *   CP-B  `expectedFrom` is a real lost-update guard, and ownership is enforced
 *         by a fencing token that Postgres — not the worker — minted.
 *   CP-D  a lease renewal is accepted for the current token and rejected for a
 *         fenced-out one, with an audit row only for the accepted case.
 *
 * HOW TO RUN (skipped, never failed, when the URL is absent, so `bun test` stays
 * green without a database):
 *
 *   psql -h /var/run/postgresql -d postgres -c 'CREATE DATABASE plana_cp_proof_test OWNER root'
 *   cd packages/db && DATABASE_URL=$SCRATCH bunx prisma migrate deploy
 *   cd apps/backend
 *   PLANA_PG_TEST_URL="postgresql://root:pw@127.0.0.1:5432/plana_cp_proof_test?schema=public" \
 *   DATABASE_URL="$PLANA_PG_TEST_URL" bun test src/test-integration
 *
 * Run this directory in its own invocation. The unit suites `mock.module`
 * `@repo/db/db`; these tests need the real singleton, and `DATABASE_URL` (not
 * this file) selects the database the singleton connects to. Because a wrong
 * `DATABASE_URL` would point a destructive suite at someone's development data,
 * `beforeAll` reads `current_database()` back out of the live connection and
 * refuses to run unless it matches the database named in `PLANA_PG_TEST_URL`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { prisma, type Prisma } from "@repo/db/db";
import {
    claimRunLease,
    renewRunLease,
    type RunOwnership,
} from "../runs/stateMachine";
import { createRun, transitionRun } from "../runs/runRepository";

const TEST_URL = process.env.PLANA_PG_TEST_URL ?? "";
const enabled = TEST_URL.length > 0;
const suite = enabled ? describe : describe.skip;

/** Database name the live connection must report before anything is written. */
const expectedDatabase = (): string => {
    const withoutQuery = TEST_URL.split("?")[0] ?? "";
    return (withoutQuery.split("/").pop() ?? "").trim();
};

const runError = async (promise: Promise<unknown>): Promise<Error> => {
    try {
        await promise;
    } catch (error) {
        return error as Error;
    }
    throw new Error("expected the call to fail, but it succeeded");
};

const codeOf = (error: unknown) => (error as { code?: string }).code;

suite("run state machine against real Postgres", () => {
    beforeAll(async () => {
        const rows = await prisma.$queryRawUnsafe<{ database: string }[]>(
            "SELECT current_database() AS database"
        );
        const actual = rows[0]?.database ?? "";
        const expected = expectedDatabase();
        if (actual !== expected) {
            // Loud refusal, not a skip: silently writing into the wrong
            // database is the failure mode this guard exists to prevent.
            throw new Error(
                `Integration proofs connect to "${actual}" but PLANA_PG_TEST_URL names ` +
                    `"${expected}". Set DATABASE_URL to the same scratch database.`
            );
        }
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    /**
     * A full seed chain, because AgentRun's FKs really exist here: run → issue →
     * section → board → organization, and run → user. Unique-ish slugs/emails let
     * the suite run repeatedly against the same scratch database.
     */
    const seed = async () => {
        const tag = crypto.randomUUID().slice(0, 8);
        const organization = await prisma.organization.create({
            data: { name: `Org ${tag}`, slug: `org-${tag}` },
        });
        const user = await prisma.user.create({
            data: {
                email: `run-${tag}@example.test`,
                password: "not-a-real-hash",
                name: "Runner",
            },
        });
        const board = await prisma.board.create({
            data: { title: `Board ${tag}`, organizationId: organization.id },
        });
        const section = await prisma.section.create({
            data: { title: `Section ${tag}`, boardId: board.id },
        });
        const issue = await prisma.issue.create({
            data: { title: `Issue ${tag}`, sectionId: section.id },
        });
        return { organization, user, issue };
    };

    /** Launch through the production entry point; the enqueue step is the
     *  caller's in-transaction work (a job row) and is counted to prove it runs
     *  exactly once, inside the winning transaction only. */
    const launch = async (
        seedData: Awaited<ReturnType<typeof seed>>,
        idempotencyKey: string,
        onEnqueue?: (db: Prisma.TransactionClient) => Promise<void>
    ) =>
        createRun({
            issueId: seedData.issue.id,
            organizationId: seedData.organization.id,
            createdBy: seedData.user.id,
            engine: "CODEX",
            model: "gpt-5",
            repository: "plana/app",
            executionMode: "IMPLEMENT",
            idempotencyKey,
            ...(onEnqueue ? { onEnqueue } : {}),
        });

    test("CP-A: two concurrent launches with one idempotency key produce exactly one run, one event, one slot and one enqueue step", async () => {
        const seeded = await seed();
        const key = `idem-${crypto.randomUUID()}`;
        let steps = 0;
        const step = async (db: Prisma.TransactionClient) => {
            steps += 1;
            await db.agentJob.create({
                data: {
                    type: "agent.run.execute",
                    idempotencyKey: `job-${seeded.issue.id}`,
                },
            });
        };

        const [a, b] = await Promise.all([
            launch(seeded, key, step),
            launch(seeded, key, step),
        ]);

        // Same run, decided by the unique index rather than by luck: the loser
        // replays the winner's committed row instead of inserting its own.
        expect(a.run.id).toBe(b.run.id);
        expect([a.created, b.created].filter(Boolean).length).toBe(1);

        expect(
            await prisma.agentRun.count({ where: { issueId: seeded.issue.id } })
        ).toBe(1);
        expect(
            await prisma.agentRun.count({
                where: { activeIssueId: seeded.issue.id },
            })
        ).toBe(1);
        expect(
            await prisma.runEvent.count({ where: { runId: a.run.id } })
        ).toBe(1);
        expect(
            await prisma.runEvent.findFirst({ where: { runId: a.run.id } })
        ).toMatchObject({ type: "run.created", sequence: 1 });
        // The issue is occupied: `activeIssueId` is the unique flag every
        // admission decision reads, and it is set by the same INSERT as the row.
        expect(
            await prisma.agentRun.count({
                where: { activeIssueId: seeded.issue.id },
            })
        ).toBe(1);
        // The enqueue step is part of the launch, not a follow-up: it ran once.
        expect(steps).toBe(1);
        expect(
            await prisma.agentJob.count({
                where: { idempotencyKey: `job-${seeded.issue.id}` },
            })
        ).toBe(1);
    });

    test("CP-A: a launch whose enqueue step throws leaves no run, no event and no occupancy (all-or-nothing)", async () => {
        const seeded = await seed();
        const eventsBefore = await prisma.runEvent.count();
        const failing = () =>
            launch(seeded, `boom-${crypto.randomUUID()}`, async () => {
                throw new Error("enqueue rejected");
            });

        const error = await runError(failing());
        expect((error as Error).message).toContain("enqueue rejected");

        expect(
            await prisma.agentRun.count({ where: { issueId: seeded.issue.id } })
        ).toBe(0);
        expect(
            await prisma.agentRun.count({
                where: { activeIssueId: seeded.issue.id },
            })
        ).toBe(0);
        // Nothing orphaned either. The `run.created` event (and, in a launch that
        // claims the issue, the occupancy flag) were written before the step threw,
        // and they are gone: the abort was a rollback, not a cleanup pass.
        expect(eventsBefore).toBe(await prisma.runEvent.count());

        // And the aborted launch did not poison the issue: a fresh launch works.
        const retry = await launch(seeded, `retry-${crypto.randomUUID()}`);
        expect(retry.created).toBe(true);
        expect(
            await prisma.agentRun.count({ where: { issueId: seeded.issue.id } })
        ).toBe(1);
        expect(
            await prisma.agentRun.count({
                where: { activeIssueId: seeded.issue.id },
            })
        ).toBe(1);
    });

    test("CP-A: two launches with different keys for one issue — the database decides there is one active run", async () => {
        const seeded = await seed();
        const results = await Promise.allSettled([
            launch(seeded, `k1-${crypto.randomUUID()}`),
            launch(seeded, `k2-${crypto.randomUUID()}`),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        // Distinct keys are distinct INTENTS, so exactly one may be admitted and
        // the other must be refused with the typed error, not silently replayed.
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe(
            "ACTIVE_RUN_EXISTS"
        );

        expect(
            await prisma.agentRun.count({ where: { issueId: seeded.issue.id } })
        ).toBe(1);
    });

    test("CP-B: concurrent transitions sharing one expectedFrom — one wins, the loser is told it raced", async () => {
        const seeded = await seed();
        const { run } = await launch(seeded, `race-${crypto.randomUUID()}`);

        const attempt = () =>
            transitionRun({
                runId: run.id,
                to: "PROVISIONING",
                expectedFrom: "QUEUED",
                actorId: seeded.user.id,
            });
        const results = await Promise.allSettled([attempt(), attempt()]);
        const won = results.filter((r) => r.status === "fulfilled");
        const lost = results.filter((r) => r.status === "rejected");

        expect(won.length).toBe(1);
        expect(lost.length).toBe(1);
        const reason = (lost[0] as PromiseRejectedResult).reason as {
            code?: string;
            details?: { raced?: boolean; actualStatus?: string };
        };
        expect(reason.code).toBe("ILLEGAL_TRANSITION");
        // The guard does not merely fail; it reports what the row actually said,
        // so the caller can re-decide instead of guessing.
        expect(reason.details?.raced).toBe(true);
        expect(reason.details?.actualStatus).toBe("PROVISIONING");

        const after = await prisma.agentRun.findUniqueOrThrow({
            where: { id: run.id },
        });
        expect(after.status).toBe("PROVISIONING");

        // One status change, one audit event — the loser wrote nothing.
        const changed = await prisma.runEvent.findMany({
            where: { runId: run.id, type: "run.status.changed" },
            orderBy: { sequence: "asc" },
        });
        expect(changed.length).toBe(1);
        const sequences = await prisma.runEvent.findMany({
            where: { runId: run.id },
            select: { sequence: true },
            orderBy: { sequence: "asc" },
        });
        expect(sequences.map((s) => s.sequence)).toEqual([1, 2]);
    });

    test("CP-B/CP-D: a reclaimed lease fences the old worker out of every further write", async () => {
        const seeded = await seed();
        const { run } = await launch(seeded, `fence-${crypto.randomUUID()}`);
        const machine = `worker-${crypto.randomUUID().slice(0, 8)}`;

        const first = await claimRunLease(prisma, {
            runId: run.id,
            machineId: `${machine}-a`,
            leaseTtlMillis: 60_000,
            expectedStatus: "QUEUED",
        });
        // Claiming must not itself move the run; ownership and status are
        // separate concerns (a claim that also advanced status could not be
        // replayed safely after a crash).
        expect(
            (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }))
                .status
        ).toBe("QUEUED");

        // A live lease is NOT stealable — that is the point of having one. The
        // retry path is a worker whose predecessor went quiet, so the reclaim
        // happens after the lease lapsed: pass a `now` beyond A's expiry. Postgres
        // mints the new token by incrementing the column, so ordering is a
        // property of the row, not of either worker's clock.
        await expect(
            claimRunLease(prisma, {
                runId: run.id,
                machineId: `${machine}-b`,
                leaseTtlMillis: 60_000,
                expectedStatus: "QUEUED",
            })
        ).rejects.toThrow();

        const second = await claimRunLease(prisma, {
            runId: run.id,
            machineId: `${machine}-b`,
            leaseTtlMillis: 60_000,
            expectedStatus: "QUEUED",
            now: new Date(Date.now() + 5 * 60_000),
        });
        expect(second.fencingToken).toBeGreaterThan(first.fencingToken);

        // The zombie's write is refused INSIDE the transaction that would have
        // written it — no status change, no event, nothing to undo.
        const zombie = await runError(
            transitionRun({
                runId: run.id,
                to: "PROVISIONING",
                expectedFrom: "QUEUED",
                claim: first satisfies RunOwnership,
            })
        );
        expect(codeOf(zombie)).toBe("STALE_CLAIM");
        expect(
            (await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } }))
                .status
        ).toBe("QUEUED");
        expect(
            await prisma.runEvent.count({
                where: { runId: run.id, type: "run.status.changed" },
            })
        ).toBe(0);

        // Renewal follows the same rule: the current token extends, the fenced
        // one is refused, and ONLY the accepted renewal leaves an audit row.
        expect(
            await renewRunLease(prisma, {
                runId: run.id,
                claim: first,
                leaseTtlMillis: 60_000,
                reason: "zombie heartbeat",
            })
        ).toBe(false);
        expect(
            await renewRunLease(prisma, {
                runId: run.id,
                claim: second,
                leaseTtlMillis: 60_000,
                reason: "still streaming",
            })
        ).toBe(true);
        const renewals = await prisma.runLeaseRenewal.findMany({
            where: { runId: run.id },
            orderBy: { createdAt: "asc" },
        });
        expect(renewals.length).toBe(1);
        expect(renewals[0]).toMatchObject({
            machineId: `${machine}-b`,
            fencingToken: second.fencingToken,
        });

        // The owner Postgres recognises can still move the run.
        const moved = await transitionRun({
            runId: run.id,
            to: "PROVISIONING",
            expectedFrom: "QUEUED",
            claim: second,
        });
        expect(moved.status).toBe("PROVISIONING");
        expect(
            await prisma.runEvent.count({
                where: { runId: run.id, type: "run.status.changed" },
            })
        ).toBe(1);
    });
});
