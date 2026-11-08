import { createKeyedSerialLocks } from "../lib/serialLock";

// Per-run critical sections (CP3).
//
// Two distinct keyed locks exist on purpose:
//   withRunSection       — guards the AgentRun ROW: read status -> validate the
//                          transition -> write status. Mirrors the row lock a
//                          `SELECT ... FOR UPDATE` + UPDATE in one transaction
//                          would give us in Postgres, so two workers can never
//                          both "win" the same transition.
//   withRunEventSection  — guards RunEvent sequence allocation only.
//
// Acquisition order is ALWAYS run -> event (never event -> run), which makes a
// deadlock between the two impossible; appendRunEvent therefore only ever takes
// the event section and is safe to call while holding the run section.
export const withRunSection = createKeyedSerialLocks();
export const withRunEventSection = createKeyedSerialLocks();
