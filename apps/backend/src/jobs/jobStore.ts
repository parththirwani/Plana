import { Pool } from "pg";
import { createPostgresJobStore, type JobSqlClient } from "./postgresJobStore";
import type { JobStore } from "./types";

// Tests inject a store. Runtime jobs always require PostgreSQL.

let activeStore: JobStore | null = null;

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
    throw new Error(
        "DATABASE_URL is required for durable agent jobs; tests must inject a store",
    );
};

export const getJobStore = (): JobStore => {
    if (!activeStore) {
        activeStore = createDefaultJobStore();
    }
    return activeStore;
};

export const closeJobStore = async () => {
    await activeStore?.close?.();
    activeStore = null;
};
