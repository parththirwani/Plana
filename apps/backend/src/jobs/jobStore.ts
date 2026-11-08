import { Pool } from "pg";
import { createMemoryJobStore } from "./memoryJobStore";
import { createPostgresJobStore, type JobSqlClient } from "./postgresJobStore";
import type { JobStore } from "./types";

// Process-wide job store seam, mirroring the injectable-pool pattern in
// src/lib/notify.ts (setNotifyPool): tests and the worker bootstrap inject an
// explicit store; production wiring falls back to Postgres when DATABASE_URL
// is configured.
//
// IMPORTANT (unverified ledger): with no DATABASE_URL the fallback is the
// in-memory store, which is NOT durable across restarts. It exists so dev and
// tests run without a database; a real deployment must run migrations and set
// DATABASE_URL so getJobStore() returns the Postgres repository.

let activeStore: JobStore | null = null;
let warned = false;

export const setJobStore = (store: JobStore | null): void => {
    activeStore = store;
};

export const createDefaultJobStore = (): JobStore => {
    if (process.env.DATABASE_URL) {
        const pool: JobSqlClient = new Pool({
            connectionString: process.env.DATABASE_URL,
        });
        return createPostgresJobStore(pool);
    }
    if (!warned) {
        warned = true;
        console.warn(
            "[jobs] DATABASE_URL is not set: using the in-memory job store. " +
                "Jobs will NOT survive a restart. Never use this mode in production."
        );
    }
    return createMemoryJobStore();
};

export const getJobStore = (): JobStore => {
    if (!activeStore) {
        activeStore = createDefaultJobStore();
    }
    return activeStore;
};
