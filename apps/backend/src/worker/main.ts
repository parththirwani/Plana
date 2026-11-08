import { prisma } from "@repo/db/db";
import { closeJobStore } from "../jobs/jobStore";
import { createRunWorker } from "./runWorker";

// Explicit fake mode is required until qualified provider implementations exist.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const shutdown = new AbortController();
process.once("SIGINT", () => shutdown.abort(new Error("Worker stopping")));
process.once("SIGTERM", () => shutdown.abort(new Error("Worker stopping")));
const worker = createRunWorker({ signal: shutdown.signal });
await prisma.agentRun.findFirst({ select: { id: true, runtime: true } });
await prisma.agentJob.count();
console.log(
    JSON.stringify({
        service: "agent-worker",
        status: "ready",
        mode: process.env.AGENT_EXECUTION_MODE,
        owner: worker.owner,
    }),
);
try {
    while (!shutdown.signal.aborted) {
        try {
            const outcome = await worker.runOnce();
            if (outcome) console.log(JSON.stringify(outcome));
            else
                await new Promise<void>((resolve) => {
                    const done = () => {
                        clearTimeout(timer);
                        shutdown.signal.removeEventListener("abort", done);
                        resolve();
                    };
                    const timer = setTimeout(done, 500);
                    shutdown.signal.addEventListener("abort", done, {
                        once: true,
                    });
                    if (shutdown.signal.aborted) done();
                });
        } catch (error) {
            console.error("Worker polling failed", error);
            if (!shutdown.signal.aborted)
                await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
} finally {
    await closeJobStore();
    await prisma.$disconnect();
}
