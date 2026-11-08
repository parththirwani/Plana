# Plana cloud agents architecture

Status: proposed architecture, implementation not yet verified.

## 1. Summary and agreed behavior

Build a durable task execution system around Plana's existing Kanban cards. Plana manages assignments, permissions, budgets, and progress. E2B supplies an isolated Linux machine for each active task. The selected coding engine runs inside that machine.

Reference discussion: BizzyAgent Machine Spawn Location, thread `f0289426-41b7-4297-adc8-d934875e5123`, environment `c5a5dd44-4b38-4beb-a463-7a6c821aa50a`.

The first release supports:

- Four selectable engines: Codex, Claude Code, OpenCode, and Pi.
- Two execution modes: **Implement** and **Plan and approve**.
- Plana-managed E2B and model credentials.
- Organization-approved repositories, with a board default and card override.
- Automatic implementation, validation, branch publication, and PR creation. Humans review and merge.
- Local development and testing without deploying Plana.

The current `/issues/:id/explain` action remains available. Execution becomes a separate feature backed by persistent jobs.

"Doesn't stop" means work survives a closed browser, disconnected chat, and recoverable process failures. Tasks still stop at explicit approval gates, budget limits, cancellation, or genuine blockers. Prompts cannot guarantee uninterrupted execution or correct code; recovery and quality checks must also exist outside the model.

## 2. Infrastructure and execution

### Local development first

Extend Docker Compose with PostgreSQL, the agent worker, and MinIO for artifacts. Run the existing frontend, API, and WebSocket server locally.

The worker calls E2B over the internet. E2B hosts the actual agent machines. A public HTTPS tunnel exposes only the local integration routes needed for GitHub callbacks, webhooks, and authenticated sandbox communication. The tunnel does not expose PostgreSQL, MinIO administration, or internal worker administration.

Local testing uses real E2B and model accounts and therefore incurs provider usage. Also provide fake engine and sandbox adapters for integration tests without cloud charges.

Later deployment uses the same containers, managed PostgreSQL, and S3-compatible storage. Selecting a production hosting vendor is outside this implementation.

### Permanent Plana services

- **API:** authenticates users, validates repository access, creates runs, handles approvals and GitHub integration.
- **Worker:** schedules jobs, provisions E2B machines, supervises engines, checks results, and publishes changes.
- **PostgreSQL:** stores run state, durable jobs, chat events, approvals, checkpoints, and usage.
- **Object storage:** holds patches, Git bundles, engine session files, and larger logs.
- **Existing WebSocket service:** delivers progress notifications to board members.

Keep task execution outside HTTP request handlers.

Use PostgreSQL jobs with transactional creation, `FOR UPDATE SKIP LOCKED` claiming, expiring leases, and fencing tokens. A replacement worker must acquire ownership before controlling a run. GitHub publication also checks current ownership. Store a publication intent and reconcile its branch and PR before retrying external operations; database fencing alone cannot make an external GitHub request exactly once.

### Task lifecycle

1. A moderator or admin selects **Assign agent** on a card.
2. The launch form selects engine, model, supported reasoning options, execution mode, repository, and budget.
3. Plana checks permissions and reserves budget, then creates a queued run.
4. The worker creates an E2B machine from a versioned template.
5. The worker checks out the selected repository at a recorded base commit.
6. The engine inspects the repository and executes the chosen mode.
7. Plana validates the resulting changes and publishes a task branch and PR.
8. The card displays the PR, validation results, usage, and final summary.

Each run has its own sandbox and branch, named `plana/<issue-id>/<run-id>`. Allow only one active run per card, enforced in the database. Separate cards may work on the same repository through separate branches.

Track queued, provisioning, planning, awaiting approval, implementing, validating, reviewing, publishing, completed, blocked, limit reached, failed, and cancelled states. Record recovery attempts separately from the logical run. Waiting for approval or input retains the card's active run; an explicit resume continues it rather than creating a competing run.

### Execution modes

**Implement:** inspect, make a working plan, edit, test, review, and open a PR without routine permission prompts.

**Plan and approve:** inspect the repository without modifying its tracked files, save a proposed plan, and enter `AWAITING_APPROVAL`. Pause the sandbox while waiting. Approval records the exact plan version, issue context, and base commit. Resume implementation only against that approved version.

If the card's requirements or base commit change before approval, regenerate the plan and request approval again. Ordinary tool permission prompts must resolve through policy; a genuine missing decision becomes a persisted blocker rather than an unattended terminal prompt.

### Engine installation and adapters

Create one base E2B image and four engine-specific variants. Install only the selected engine in its variant.

The base image includes Git, ripgrep, Node LTS, Bun, Python, build tools, and headless Chromium. Install repository dependencies after checkout using its lockfile. Additional languages use explicitly configured template variants.

Engine integrations:

- Codex through the Codex SDK and its pinned CLI runtime. [Official documentation](https://developers.openai.com/codex/sdk/)
- Claude Code through the Claude Agent SDK. [Official documentation](https://code.claude.com/docs/en/agent-sdk/overview)
- OpenCode through its SDK and authenticated headless server. [Official documentation](https://opencode.ai/docs/sdk/)
- Pi through its pinned programmatic SDK or RPC runtime. Resolve and pin the supported distribution in the initial compatibility test before implementing its adapter.

All four implement the same internal adapter contract: capabilities, start, send input, resume, cancel, stream events, export session, and report usage.

Expose only models available to Plana's provider accounts. Do not copy T3's model catalog or assume a model available in T3 is available through Plana's credentials. Unsupported engine options remain disabled with an explanation. Never switch engines silently.

Each adapter must prove authentication, gateway routing, policy enforcement, session export, recovery, cancellation, and usage reporting before it is enabled. Where native resume is unavailable, the adapter must support a new session with the restored workspace and saved progress.

### Recovery and persistence

Persist event sequences, engine session identifiers, acceptance criteria, completed steps, remaining work, test results, and workspace checkpoints.

- Renew worker leases every 15 seconds; reconcile ownership after a 60-second lapse.
- Retry transient infrastructure failures up to three times with backoff and provider `Retry-After` handling.
- Reconnect to the existing sandbox before creating a replacement.
- Export workspace and session checkpoints every five minutes and at stage boundaries. Include untracked and binary changes required for recovery, while excluding credentials and disposable dependency directories.
- If a sandbox is lost, restore the last checkpoint into a new machine.
- If native engine resume fails, start a new engine session using the restored workspace and saved progress.
- Reconcile published branch heads and PRs before retrying publication to prevent duplicates.
- Cancellation stops the engine process, prevents later publication, releases reservations, and cleans up the machine. A late engine result cannot override cancellation.

E2B pause preserves filesystem and process memory, but external checkpoints remain necessary for disaster recovery. [E2B persistence](https://docs.e2b.dev/sandbox/persistence)

## 3. GitHub access, sandbox rules, and quality

### GitHub onboarding

Register a Plana GitHub App. An organization admin connects it from Plana settings and installs it on selected personal or organization repositories.

Verify both sides of the connection: Plana administrator permission and GitHub authorization to manage the installation. Bind the installation through signed, expiring state and server-side verification, rather than trusting a callback's installation ID.

Request:

- Repository metadata read.
- Contents read/write.
- Pull requests read/write.
- Checks and commit statuses read.

Do not request administration, secrets, workflow modification, or branch-protection bypass.

Store installation and repository IDs. Keep the app private key in server-side secret storage. Mint installation tokens for the specific repository and required operation; GitHub installation tokens expire after one hour. [GitHub authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

### Separate editing from publication

The sandbox receives repository-scoped read credentials for checkout. It does not receive GitHub write credentials or the GitHub App private key. Never put credentials in clone URLs, logs, exported sessions, or checkpoints. Remove temporary checkout credentials before launching the engine and refresh them only for authorized fetch operations.

The worker retrieves the completed workspace as a Git bundle or patch, validates it in a disposable publisher checkout, and pushes only the assigned task branch. The publisher never executes repository scripts or hooks. Validate artifact paths, intended base and head commits, branch destination, and excluded files before publication.

The worker creates or updates the PR through GitHub's API. Reject workflow-file modifications in v1 and report that they require a separate authorized workflow.

Verify webhook signatures and deduplicate delivery IDs. Handle installation removal, repository removal, suspension, checks, reviews, and PR state changes. Recheck installation access before resuming or publishing. Stop affected active runs and remove their runtime access when a revocation arrives.

Honor branch protections. Never force-push published history, push directly to the default branch, approve the agent's own PR, or merge automatically.

### Enforced sandbox boundaries

- One task and repository per sandbox.
- Run repository commands as an unprivileged user.
- Keep Plana database credentials, E2B account credentials, and production secrets outside the machine.
- Use short-lived, run-scoped access to a model gateway. The gateway injects provider credentials and enforces model and spending limits.
- Restrict outbound traffic to the gateway, approved GitHub endpoints, and configured dependency registries.
- Block cloud metadata and private network destinations; require authentication for exposed sandbox services.
- Disable automatic loading of repository-provided MCP servers, plugins, hooks, and executable extensions.
- Treat repository setup and dependency lifecycle scripts as untrusted code. Execute them only inside the task sandbox with the same restricted access and budget.

E2B provides network restrictions; configure them explicitly because outbound internet access is enabled by default. [E2B networking](https://docs.e2b.dev/network/internet-access)

Repository instructions guide coding conventions. They cannot override Plana's access, publication, or budget policies. Enforce critical boundaries through credentials, gateway authorization, network restrictions, and the external publisher, rather than relying on prompts or shell-command pattern matching.

### Default skills

Package a small, versioned Plana skill set for every engine:

- **Repository orientation:** inspect instructions, architecture, scripts, and lockfiles.
- **Task planning:** derive acceptance criteria and record reasonable assumptions.
- **Implementation:** follow existing patterns and keep changes within the card's scope.
- **Verification:** run appropriate checks, add meaningful regression tests, and distinguish existing failures.
- **Change review:** inspect the diff for correctness, authorization mistakes, missing tests, and unrelated edits.
- **Delivery and recovery:** save progress, prepare the commit and PR summary, and report blockers precisely.

Load frontend, database, security, and browser-testing skills when relevant. Organization admins can add reviewed skills. Record the skill versions used by each run.

### Rules for autonomous work

Instruct every engine to:

- Continue until the acceptance criteria and delivery checks are satisfied.
- Resolve routine implementation choices from repository evidence.
- Ask only when missing information materially affects correctness or authorization.
- Save progress before context compaction or session restart.
- Treat failed commands as evidence to investigate.
- Never hide failures, remove checks to obtain a pass, or claim unrun tests passed.
- Never treat an assistant's final message as proof that the task is complete.

The worker independently verifies completion. Allow three repair cycles after failed validation, within the task's budget. Then preserve the changes and report the unresolved failure.

Open a normal PR only when required checks pass. If checks remain failing or unavailable, publish recoverable work as a clearly marked draft PR. A separate fresh review session checks the final diff and acceptance criteria before publication. Include review and repair usage in the same run budget.

## 4. Plana interfaces, limits, and rollout

### Data and API changes

Add organization-level GitHub connections, allowed repositories, engine configuration, and budget settings. Add board repository defaults and an optional card override.

Store separate records for agent runs, attempts, ordered events, approvals, checkpoints, artifacts, usage reservations, usage entries, and durable jobs. Runs retain their original task inputs and configuration for audit and recovery.

Keep agent assignment separate from human `User` assignees. Use an explicit system actor for comments and realtime events rather than a password-bearing bot account. Adapt existing comment authorship and event actor serialization without changing existing human comments.

Add endpoints for:

- Engine capabilities and allowed repositories.
- Creating and listing a card's runs.
- Reading run state and paginated events.
- Sending run messages, approving a plan version, cancelling, and resuming.
- GitHub connection callbacks and webhooks.

Run creation accepts engine, model, supported options, mode, repository, and requested limits. Use idempotency keys for creation and approval. Admins manage connections and policy; moderators and admins launch, approve, cancel, and resume within that policy. Board members can read run details under existing board authorization rules.

Add `agent.run.updated` and `agent.event.available` notifications to the existing board event system. Notifications carry IDs and sequence numbers; clients fetch persisted events. This fits the current PostgreSQL notification size limits and supports replay after reconnecting. Persist events before notifications; clients must also refetch on reconnect because notifications are not durable.

The card's agent panel shows plan approval, activity, files changed, tests, usage, blockers, and PR status. Keep execution state separate from freely named Kanban columns. Do not automatically mark a card done when the agent finishes.

### Initial operating limits

Use configurable defaults:

- One active run per card.
- Two active machines per organization.
- Ten active machines globally during the pilot.
- A default machine size of 2 vCPU and 4 GiB RAM.
- A 45-minute cumulative active execution allowance per run, including retries and repair sessions.
- A $5 provider-spend allowance per run and $25 daily organization allowance, measured in USD. Use UTC for daily accounting.
- Three validation repair cycles and three infrastructure retries.
- Seven days of paused workspace retention and 30 days of logs and artifacts.

Reserve spending atomically across concurrent runs. Meter model usage through the gateway and sandbox allocation time separately. Stop new billable work before the allowance is exhausted, reserving headroom for in-flight calls and cleanup. Model gateway requests must have bounded output and concurrency so reservations can cover their maximum estimated charge. Reconcile estimates with provider-reported usage; do not present a provider invoice as an exact real-time balance.

At the limit, save progress and enter `LIMIT_REACHED`. A moderator can increase the allowance within organization policy and resume. Waiting for approval pauses compute but does not erase previously consumed time or spend. Retention cleanup exports required state before killing a paused machine and records when only archived recovery remains available.

As checked during planning on 2026-11-08, E2B lists a one-hour continuous runtime and 20 concurrent sandboxes for Hobby. Pro lists 24 hours and a baseline of 100 concurrent sandboxes, with higher capacity available. The $100 starting credit is one-time. Provider limits apply to Plana's account, not individually to every Plana user. Recheck account-specific limits and prices before release. [E2B billing and limits](https://docs.e2b.dev/billing)

### Implementation sequence

1. Add run models, durable jobs, event replay, permissions, and fake adapters.
2. Add GitHub App onboarding, repository selection, and the credential-separated publisher.
3. Build E2B templates and qualify all four engine adapters.
4. Add both execution modes, checkpoints, recovery, cancellation, and budget enforcement.
5. Add card controls, plan approvals, skills, validation, review, and PR reporting.
6. Complete local cloud testing before enabling an organization pilot.

## 5. Completion verification checklist

All boxes start unchecked. Check a box only after recording the implementation commit, exact command or manual procedure, date, expected result, observed result, and a link or path to redacted evidence. Store that evidence in a verification report beside this plan. Do not include credentials or private repository code in committed evidence. A written plan, a mocked happy path, or an engine's own success message does not verify the full implementation.

### 5.1 Local setup and compatibility

- [ ] Start a clean local installation from documented setup instructions. Apply migrations to a new database, start the frontend, API, WebSocket service, worker, PostgreSQL, and MinIO, and confirm their health. Expected: all required services work without a hosted Plana deployment.
- [ ] Run the existing backend smoke checks, WebSocket tests, frontend lint, type checks, and build using the scripts available in the implementation. Record exact commands and any established baseline failures. Expected: no unexplained regressions in login, organizations, boards, cards, comments, or `/issues/:id/explain`.
- [ ] Connect the HTTPS tunnel and a disposable GitHub App installation. Expected: callbacks and signed webhooks arrive, while database, storage administration, and internal worker routes remain inaccessible publicly.
- [ ] Qualify Codex, Claude Code, OpenCode, and Pi individually with real credentials. Expected: each pinned engine starts in E2B, routes through the gateway, streams events, reports usage, exports recovery state, and cancels without an interactive terminal prompt. Record engine and template versions.
- [ ] Request an unavailable model and unsupported engine option. Expected: a clear validation error or disabled option, with no silent fallback or machine charge.

### 5.2 Card-to-PR behavior

- [ ] Set a board default repository and a permitted card override, then try an unapproved repository. Expected: each allowed run uses the correct repository and the unapproved selection fails before provisioning.
- [ ] Run a small bug-fix card in Implement mode once with each engine against a disposable private repository. Expected: the changed behavior has a meaningful test, checks and fresh review run, and exactly one task branch and PR appear per run. The default branch remains unchanged.
- [ ] Run Plan and approve mode and inspect tracked files before approval. Expected: no tracked changes, a saved plan version, and a paused machine. Approve as a moderator and confirm implementation starts against that exact plan.
- [ ] Change the card requirements or advance the selected base before approving a saved plan. Expected: stale approval fails and the agent generates a new plan requiring approval.
- [ ] Send the same launch and approval requests twice, including concurrent requests. Expected: one active run, one approval transition, and no duplicate machine or publication.
- [ ] Complete a task while a human moves the card between custom Kanban columns. Expected: run state remains correct and the agent does not mark the card done automatically.

### 5.3 Durability and recovery

- [ ] Close the browser during execution and reopen it. Expected: the task continues and the UI reconstructs state and missing events from persisted sequence numbers.
- [ ] Restart the API and WebSocket services during execution. Expected: the task continues; clients reconnect without losing persisted messages or duplicating actions.
- [ ] Kill the owning worker and start two replacement workers. Expected: ownership recovers after lease expiry, only one worker controls the run, and the old owner cannot publish after losing its lease.
- [ ] Terminate a sandbox after a checkpoint that includes an untracked file and a binary change. Expected: a replacement restores the recorded base, workspace changes, and progress, then completes the task. Report the checkpoint recovery window rather than claiming zero data loss.
- [ ] Make native engine session resume fail. Expected: a fresh session continues from saved progress and restored files without silently changing engines.
- [ ] Interrupt publication after a push and again after PR creation but before saving the response. Expected: recovery finds the existing branch and PR and does not duplicate either.
- [ ] Cancel during model execution, validation, and queued publication. Expected: processes stop, gateway access ends, reservations release correctly, and no later output revives or publishes the cancelled run.

### 5.4 Authorization and sandbox boundaries

- [ ] Attempt cross-organization access to run creation, events, artifacts, approvals, messages, and cancellation. Expected: every attempt fails under existing non-disclosure rules. Verify ordinary members cannot launch or approve runs.
- [ ] Attempt installation binding with expired or altered state and another account's installation ID. Expected: binding fails. Replay a valid callback and webhook; expected: no duplicate connection or work.
- [ ] Remove repository access or suspend the GitHub installation while queued and while active. Expected: affected work stops, credentials cannot refresh, and publication fails safely. Invalid webhook signatures are rejected.
- [ ] Inspect the sandbox and exported files for Plana database secrets, E2B keys, GitHub write credentials, and provider keys. Expected: none are present. Scan logs, session exports, bundles, patches, and artifacts as well.
- [ ] Try to contact cloud metadata, private addresses, an unapproved external domain, and an unauthenticated sandbox service. Expected: network or authentication policy blocks each attempt.
- [ ] Add repository instructions requesting secret disclosure, a malicious plugin, and an executable engine hook. Expected: instructions cannot override policy and repository integrations do not autoload. Dependency setup remains restricted to the sandbox.
- [ ] Attempt to publish workflow changes, a default-branch update, a force-push, and an artifact with an invalid destination or path. Expected: the external publisher rejects each operation without executing repository hooks.

### 5.5 Quality, quotas, and cleanup

- [ ] Introduce a failing regression test and an unrelated existing failure. Expected: the agent investigates and reports both accurately, never claims an unrun check passed, and does not delete tests to obtain a pass.
- [ ] Force validation to fail through three repair cycles. Expected: repair stops at the configured cap, work is preserved, and the PR remains a clearly marked draft with failures and reproduction details.
- [ ] Inspect a passing delivery. Expected: task-scoped changes, recorded acceptance criteria, test evidence, a fresh review, commit identity, and a PR summary that matches the final diff. No automatic merge or self-approval occurs.
- [ ] Start concurrent runs across cards and organizations. Expected: per-card, per-organization, and global machine limits hold; excess work stays queued. Test database races rather than only sequential requests.
- [ ] Set small spend and active-time limits, including concurrent model requests and retries. Expected: reservations prevent new work beyond allowances, in-flight usage is accounted for, progress is saved, and the run enters `LIMIT_REACHED`.
- [ ] Increase an allowance within policy and resume. Expected: accumulated spend and active time remain recorded. A moderator cannot exceed the organization's configured limits.
- [ ] Simulate provider throttling and transient E2B failures. Expected: bounded retries honor backoff and `Retry-After`, preserve one logical run, and report exhausted retries clearly.
- [ ] Advance retention timestamps in a test environment and run cleanup. Expected: expired paused machines are killed, expired logs and artifacts are deleted according to policy, retained recovery state is explicit, and no machine or credential remains orphaned.

### 5.6 Release gate

- [ ] Produce a verification report containing evidence for every checklist item, including all four real engine runs. Record unresolved defects and the exact tested implementation commit.
- [ ] Recheck current E2B limits, engine authentication support, model pricing, GitHub permissions, and gateway compatibility. Expected: configured capabilities match the accounts actually used by Plana.
- [ ] Demonstrate the complete flow from a locally hosted Plana card to a tested, reviewed PR in a selected private repository. Expected: no deployed Plana server is required, no credentials leak, and closing the browser does not stop work.

The implementation is complete only when every required item above passes with evidence. Marking a provider unavailable or deferring an acceptance scenario must remain an explicit incomplete item; it does not satisfy the agreed four-engine release.
