# Cloud agents foundation verification

Verified on 2026-11-08 at implementation/test commit `1735366d96f0468b1c656c8d1e19684cbf432386`, following correction commit `958a7fe9587e065276f44c5ef42c074459e3e005`. This report covers the 17 foundation findings from the review of PR #3, not completion of the full cloud-agents architecture.

Environment: Bun 1.4.2, Prisma 7.9.1 with the generated client, PostgreSQL 17.11 in a disposable Docker container. All eight migrations applied to a new `plana_release_test` database. No cloud/provider credentials were used.

## Initial foundation commands and observed results

Commands run from the named package directory:

| Directory | Command | Expected | Observed |
| --- | --- | --- | --- |
| Repository | `bun install --frozen-lockfile` | Dependencies install without lockfile changes | Pass |
| `packages/db` | `bunx prisma generate` | Client generated for the committed schema | Pass |
| `packages/db` | `bunx prisma migrate deploy` | All migrations apply to an empty database | Eight migrations applied |
| `apps/backend` | `bun run check-types` | No generated-client type errors | Pass, zero errors |
| `apps/backend` | `bun run test` | All unit regressions pass | 279 pass, 0 fail, no skips |
| `apps/backend` | `bun run test:agents:pg` | Both real-database suites pass in separate processes | State machine 5/0; HTTP/queue/process foundation 14/0 |
| `apps/websocket` | `bun test` | Existing realtime checks pass | 19 pass, 0 fail |
| `apps/frontend` | `bun run build` | Existing application builds | Pass |
| `apps/frontend` | `bun run lint` | No new diagnostics against the recorded baseline | Same two `__root.tsx:86,93` Prettier errors and nine warnings |
| Repository | `actionlint .github/workflows/agent-foundation.yml` | Valid workflow | Pass via the installed `rhysd/actionlint` Docker image |
| Repository | `git diff --check` and changed-file inspection | No whitespace errors or unrelated frontend edits | Pass; zero frontend files changed |

For PostgreSQL tests, both `DATABASE_URL` and `PLANA_PG_TEST_URL` were set to the same loopback disposable `plana_release_test` database. `AGENT_EXECUTION_MODE=fake` and `NODE_ENV=test` were explicit. The suites refuse mismatched/non-test URLs and clean up their own fixtures. See [local setup](cloud-agents-local.md) for repeatable provisioning instructions.

Expected injected enqueue exceptions produce HTTP 500 responses inside fault-injection tests. The tests assert that state/events/jobs rolled back and that retry succeeds; those log messages are not failed tests. Compact output is recorded in [the evidence excerpt](evidence/cloud-agents-foundation.txt).

## Original finding disposition

The numbers below follow the original 17-finding review, not the later PR comment's renumbering.

| # | Fix | Evidence |
| --- | --- | --- |
| 1 | Failure SQL uses the PostgreSQL enum type. | Real queue failure/retry/renewal/exhaustion test executes the statements. |
| 2 | Actual HTTP launch, approval, message and cancellation commands enqueue through the same Prisma transaction as state/events. | Injected enqueue outages against the actual HTTP handlers roll back; retry and concurrent approval requests succeed once. |
| 3 | Row locks and expected-state guards retain terminal finality. | A separate stale process reads QUEUED, cancellation commits, then its attempted transition is rejected. Two launch processes also admit/enqueue once. |
| 4 | Both leases renew; worker writes check run and queue fencing inside their transaction. Intent is part of the guarded transition. | Slow engine work renews both leases in real PostgreSQL. Reclaimed ownership prevents intent. Unit checks also steal the queue claim and reject the old writer. |
| 5 | Durable session exports, workspace checkpoints and input receipts replace reliance on the process cache. | Separate worker processes plan, restore messages, approve, implement and complete. Heartbeat inbox tests cover an engine waiting silently for input. |
| 6 | Dispatch follows persisted stage; attempts resume intermediate work. | SIGKILL during provisioning followed by replacement-worker recovery completes with one provisioning transition and attempt count two. |
| 7 | Completion, independent validation and independent review evidence are required. | Failed validation, review rejection, empty output and a mismatched head cannot produce intent or COMPLETED. Checks are explicitly simulated in fake mode. |
| 8 | Workspace artifact and intent persist before publication. Matching publisher acknowledgement precedes completion and cleanup. | A pending publisher retains the active slot, artifact and machine; replacement acknowledgement completes once. Base/head and artifact paths are checked. |
| 9 | Cancellation persists an idempotent cleanup job; a heartbeat interrupts silent streams. Factory destruction never provisions a machine. | A replacement process cleans an idle cancelled approval run. Unit tests cover silent-stream cancellation and zero machine creations during restart cleanup. |
| 10 | Only COMPLETED, FAILED and CANCELLED are final. Blocked/limited runs retain occupancy and remember their prior stage. | Both paused statuses resume the same run without resetting persisted runtime data. |
| 11 | Runs retain task inputs and pass them to the engine. Plans/approvals bind a fingerprint of requirements, repository override, selected repository and base. | Changed requirements reject approval and queue a new plan. Changes after approval are checked again before implementation. |
| 12 | Approval decisions serialize transactionally; matching repeats replay, including after completion. | Concurrent HTTP requests and two separate approval processes record one decision and one execution job. |
| 13 | Generated enums/JSON boundaries remain typed. | Generated-client typecheck passes with the new schema. |
| 14 | Bounded replay advances only over returned events. | Partial-page and zero-capacity tests retain every continuation sequence. |
| 15 | Expired crash claims respect maxAttempts; failures persist backoff and retry hints. Exhausted runs become resumable blockers. | Real SQL cap/renewal tests, real exhausted-run reconciliation/resume, and persisted provider retry-hint unit test. |
| 16 | Four fake engines support both modes. Production capabilities/default worker fail closed. | Shared conformance checks run for all four; missing real implementations are not advertised as available. |
| 17 | New resume operations have distinct keys and coalesce only active execution work. | A completed resume cannot shadow a later one; concurrent active resumes coalesce. |

Existing human-feature test files were retained. Tests whose old expectations deliberately rejected Pi or treated BLOCKED/LIMIT_REACHED as final were updated to the corrected behavior, rather than claiming those obsolete expectations still passed. The final unit count is the previous 255 plus 24 added cases.

The largest authored file remains below 1,000 lines. New code is split across commands, task context, transaction-bound queue insertion, runtime/recovery, supervision, artifact policy, and provider-neutral service contracts.

## Explicitly incomplete release work

This verifies the local foundation and its fake adapter contracts. It does not verify real E2B lifecycle, real Codex/Claude Code/OpenCode/Pi behavior, native-provider recovery, GitHub App onboarding or publication, gateway credentials/metering, budget reservations/quotas, production artifact storage/retention, skills, or agent message composition. Those are architecture implementation steps 2–6 and remain incomplete.

Fake checks execute against the fake sandbox; a fake acknowledgement creates no real branch or PR. Real adapters must be qualified together with real validation/review, credential-separated publication, revocation, network restrictions, recovery and cleanup before production execution is enabled. The architecture's full release checklist remains unchecked.


## Team harness UI follow-up

The product now includes **Organization settings → Agents** and **Card → Agents**. This replaces the temporary demonstration UI. Each organization stores its approved repositories and default harness/model/run mode. Admins edit policy; admins and moderators operate runs; members view plans and activity. The API enforces these roles even when requests bypass the UI. The selection UI uses locally served Codex, Claude, OpenCode, and Pi logos, with sources/license documented in `apps/frontend/public/harnesses/README.md`.

Rechecked on 2026-11-08 after adding this UI:

- Backend generated-client typecheck passes; unit/API suite **284 pass, 0 fail**.
- Five added API regressions cover team policy visibility, outsider/member restrictions, invalid default pairs, saved defaults in capabilities, and clearing defaults.
- Frontend typecheck passes; **10 component/selection tests pass**. These use server-rendered components and capability fixtures. They cover role-specific controls, supported selections, plan visibility, persisted sandbox phases, and final-run restrictions. They are not an interactive browser end-to-end proof.
- Frontend production build passes. ESLint on every changed/new frontend TypeScript file passes. Full lint retains the original two Prettier errors and nine warnings.
- All eight migrations apply to a fresh `plana_ui_test` PostgreSQL database. The two integration suites still pass **5 + 14 tests**, including real process boundaries. WebSocket suite remains **19 pass, 0 fail**.
- CI now also runs frontend typechecking, the component/selection tests, and a production build.

Engine execution is still simulated. Real E2B provisioning, real provider model calls, real GitHub publication, metering/budget enforcement, and the message composition UI remain incomplete. A launch button does not claim those integrations exist.
