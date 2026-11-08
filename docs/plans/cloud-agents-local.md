# Cloud agents local foundation

This implements implementation-sequence step 1 of [the architecture plan](cloud-agents-architecture.md). It runs simulated engines against persistent PostgreSQL jobs. Real engine, E2B, GitHub publisher, gateway, storage, budget enforcement, and agent message composition remain incomplete. A fake publication acknowledgement creates no GitHub branch or PR.

## Start locally

From the repository root:

```sh
bun install --frozen-lockfile
docker compose up -d db
export DATABASE_URL='postgresql://trello:trello@127.0.0.1:5432/trello'
export AGENT_EXECUTION_MODE=fake
(cd packages/db && bunx prisma generate && bunx prisma migrate deploy)
```

Use the matching mapped port if PostgreSQL already occupies port 5432. Keep `DATABASE_URL` and `AGENT_EXECUTION_MODE=fake` in each API/worker shell. PostgreSQL jobs do not have an automatic in-memory fallback.

Start the existing frontend, API, and WebSocket services using their usual scripts. Start the separate worker:

```sh
cd apps/backend
bun run agent:worker
```

The worker checks the database before logging a JSON `status: ready` message. SIGINT/SIGTERM stop polling, interrupt the current attempt, release ownership, and close connections. A forced process death is recovered from the durable job, run stage, session export, and workspace checkpoint after lease expiry.

Without explicit fake mode, capability discovery marks engines unavailable and the default worker refuses to start. Production adapters must be supplied with sandbox, validation/review, and publisher implementations; none is enabled by this PR.

## Configure and launch

Create an account, organization, board, and card through the application.

1. Open **Organization settings → Agents**. An admin can approve repositories and save the team default harness, model, and run mode. Each organization has its own policy. Defaults are suggestions for a new run, not a restriction to a single harness.
2. Open a card and select **Agents**. Choose Codex, Claude Code, OpenCode, or Pi, an available model, supported options, an approved repository, and a run mode. Unavailable choices show the server reason. No engine or model is silently substituted.
3. Admins and moderators can launch, approve/reject a persisted plan, cancel, or resume a blocked/limited run. Members can read plans and activity. Run history and sandbox lifecycle events come from the persisted API, with polling for updates and cleanup receipts.

The UI uses locally served product logos, keyboard-accessible controls, team-scoped requests, and user-scoped query caches. Simulation notices remain visible; a successful fake run does not provision E2B, call a model provider, or create a real GitHub PR. Start the worker separately as described above.

The same operations are available through the normal authenticated API:

| Method and path | Required role | Body |
| --- | --- | --- |
| `GET /api/v1/organizations/:id/agent-config` | Member | Team policy, engine capabilities and simulation status |
| `PUT /api/v1/organizations/:id/agent-config` | Admin | `{"allowedRepositories":["example/demo"]}` |
| `PATCH /api/v1/boards/:id/agent-repository` | Moderator/admin | `{"repository":"example/demo"}` |
| `PATCH /api/v1/issues/:id/agent-repository` | Moderator/admin | The same body, or `{"repository":null}` to clear the override |
| `GET /api/v1/issues/:id/agent-runs/capabilities` | Member | Returns `simulation: true` in fake mode |
| `POST /api/v1/issues/:id/agent-runs` | Moderator/admin | Launch selection below |

Example launch body:

```json
{
  "engine": "PI",
  "model": "pi-1",
  "executionMode": "PLAN_AND_APPROVE",
  "idempotencyKey": "local-demo-1"
}
```

Fake model fixtures are Codex `gpt-5`/`gpt-5-mini`, Claude Code `claude-sonnet-4`, OpenCode `opencode-linear`, and Pi `pi-1`. These identifiers do not assert provider availability. All four fake adapters support both execution modes.

Use a new idempotency key for a new run and the same key for a retry. The selected repository must be organization-approved; the card override precedes the board default. Fake mode does not clone that repository or execute its actual code.

Read `GET /api/v1/agent-runs/:id` and `GET /api/v1/agent-runs/:id/events?afterSequence=0&limit=50`. Members can read; moderators/admins operate the run:

- `POST /agent-runs/:id/approvals` with `{"planVersion":1,"decision":"APPROVED"}` approves the exact persisted plan/context. Changed card requirements or base commit queue regeneration and return 409. Repeated matching decisions replay the original result.
- `POST /agent-runs/:id/messages` with `{"text":"Also cover the denied request"}` persists input and schedules delivery. The heartbeat delivers input even while an engine stream is quiet. Finalizing runs reject new messages explicitly.
- `POST /agent-runs/:id/cancel` persists cancellation and cleanup together. Cleanup also works while paused and after restart; it never creates a replacement machine.
- `POST /agent-runs/:id/resume` coalesces active execution, or creates a new resume operation. `BLOCKED` and `LIMIT_REACHED` retain the card slot and resume the same run. Real budget accounting and authorized allowance increases are still part of implementation step 4.

Every path above has the `/api/v1` prefix. The existing `/issues/:id/explain` action is unchanged.

## Persistence and delivery

Run transitions, their events, and companion jobs commit together. Worker writes check the run lease and queue fencing token inside the same transaction. The worker renews both leases, stops writes after ownership loss, and backs off failed infrastructure attempts. Crashed attempts count toward the configured retry cap. Exhaustion produces a persisted blocker; resume does not erase session usage or checkpoints.

Session exports and fake workspace checkpoints live in `AgentRun.runtime`. A new worker restores that data instead of acknowledging work it cannot find in memory. Inbox receipts are monotonic across heartbeat and stream snapshots. The original task snapshot remains available for audit; plan context also binds the current card requirements and selected base.

The worker requires valid engine completion, independent validation and review evidence, and a persisted publication artifact. Intent is part of a fenced transition. Completion and cleanup follow a matching publisher acknowledgement. A pending or failed publisher retains recoverable work. The default checks and publisher are explicitly fake; passing them does not verify a real repository or cloud release.

## Verification

Unit tests and generated-client typechecking:

```sh
(cd packages/db && bunx prisma generate)
(cd apps/backend && bun run check-types && bun run test)
(cd apps/websocket && bun test)
```

Provision a separate disposable database whose name contains `_test`, then apply all migrations. Point both variables at that same database and run each PostgreSQL suite in its own process:

```sh
export DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:5432/plana_ci_test'
export PLANA_PG_TEST_URL="$DATABASE_URL"
(cd packages/db && bunx prisma migrate deploy)
(cd apps/backend && bun run test:agents:pg)
```

The suites insert fixtures and delete their own fixtures. They refuse mismatched/non-test URLs. They exercise actual HTTP rollback, concurrent requests, PostgreSQL failure/retry SQL, lease renewal, crash exhaustion, two-process admission and cancellation, cross-process session/message restoration, SIGKILL recovery, quiet-engine input, publication fencing, and worker startup/shutdown.

`.github/workflows/agent-foundation.yml` runs generation, fresh migrations, backend typechecking/unit tests, both PostgreSQL suites, and WebSocket tests. The PostgreSQL checks do not depend on provider credentials.
