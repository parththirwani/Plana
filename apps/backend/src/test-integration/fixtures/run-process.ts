import { recordApproval } from "../../runs/approvals";
import { prisma } from "@repo/db/db";
import { createRun, transitionRun } from "../../runs/runRepository";
import { setRunEventPublisher } from "../../runs/realtime";
import { getJobStore, closeJobStore } from "../../jobs/jobStore";
import { createRunWorker } from "../../worker/runWorker";
import { createFakeOnlyRegistry } from "../../adapters/registry";
process.env.AGENT_EXECUTION_MODE = "fake";
setRunEventPublisher(async () => {});
const [mode, arg] = process.argv.slice(2);
try {
    if (mode === "transition") {
        const run = await prisma.agentRun.findUniqueOrThrow({
            where: { id: arg! },
        });
        console.log("READY");
        for await (const _ of Bun.stdin.stream()) break;
        try {
            await transitionRun({
                runId: run.id,
                expectedFrom: run.status,
                to: "PROVISIONING",
            });
            console.log("RESULT " + JSON.stringify({ unexpected: true }));
        } catch (error) {
            console.log(
                "RESULT " +
                    JSON.stringify({
                        code: (error as { code?: string }).code,
                        status: (
                            await prisma.agentRun.findUniqueOrThrow({
                                where: { id: run.id },
                            })
                        ).status,
                    }),
            );
        }
    } else if (mode === "launch") {
        const input = JSON.parse(arg!);
        const result = await createRun({
            ...input,
            onEnqueue: async (tx) => {
                await getJobStore().enqueue(
                    {
                        runId: input.id,
                        type: "agent.run.execute",
                        idempotencyKey: `start:${input.id}`,
                        payload: { reason: "created" },
                    },
                    tx,
                );
            },
        });
        console.log(
            "RESULT " +
                JSON.stringify({ id: result.run.id, created: result.created }),
        );
    } else if (mode === "approve") {
        const decision = await recordApproval(JSON.parse(arg!));
        console.log(
            "RESULT " +
                JSON.stringify({
                    replayed: decision.replayed,
                    status: decision.run.status,
                }),
        );
    } else {
        const registry = createFakeOnlyRegistry();
        if (mode === "crash")
            registry.require("CODEX").start = async () => {
                console.log("STARTED");
                return new Promise(() => {});
            };
        const worker = createRunWorker({ registry, leaseMs: 1000 });
        console.log("RESULT " + JSON.stringify(await worker.runOnce()));
    }
} finally {
    await closeJobStore();
    await prisma.$disconnect();
}
