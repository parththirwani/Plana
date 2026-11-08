// FIFO critical-section lock.
//
// Sections run one at a time, in call order, so a check-then-mutate sequence
// cannot be interleaved by another async caller that awaited at a different
// point. This is the in-process analogue of the serialization a single
// Postgres statement (INSERT ... / UPDATE ... WHERE ...) or
// SELECT ... FOR UPDATE gives us in production; the durable-queue store and
// the run repository both guard their critical sections with it so the
// semantics in tests match the semantics the SQL provides in production.
//
// The lock is NOT re-entrant: never acquire it while already holding it on the
// same call stack. Modules that need two per-run sections keep a strict
// acquisition order (see src/runs/sections.ts).
export type SerialLock = <T>(section: () => T | Promise<T>) => Promise<T>;

export const createSerialLock = (): SerialLock => {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(section: () => T | Promise<T>): Promise<T> => {
        const result = tail.then(section, section);
        tail = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    };
};

// One lock per key (run id, job id, ...). Entries are ref-counted and dropped
// once a key's queue drains, so a long-lived process never leaks a map entry
// per run.
export type KeyedSerialLocks = <T>(
    key: string,
    section: () => T | Promise<T>
) => Promise<T>;

type KeyEntry = { lock: SerialLock; queued: number };

export const createKeyedSerialLocks = (): KeyedSerialLocks => {
    const entries = new Map<string, KeyEntry>();
    return <T>(key: string, section: () => T | Promise<T>): Promise<T> => {
        let entry = entries.get(key);
        if (!entry) {
            entry = { lock: createSerialLock(), queued: 0 };
            entries.set(key, entry);
        }
        const current = entry;
        // Counted synchronously, before any await, so an entry can never be
        // evicted while callers are still queued behind it.
        current.queued += 1;
        return current.lock(section).finally(() => {
            current.queued -= 1;
            if (current.queued === 0 && entries.get(key) === current) {
                entries.delete(key);
            }
        });
    };
};
