# Agent walkthrough videos

[Product UI walkthrough, 58 seconds](agent-team-ui.mp4) records the integrated product UI: admin team defaults and approved repositories, per-card harness/model selection, a simulated sandbox paused for approval, member read-only plan/settings views, and admin approval through completion and cleanup.

[Earlier foundation walkthrough, 29 seconds](agent-foundation-demo.mp4) records the earlier temporary demonstration UI connected to the backend. It predates the product UI above and is retained for context.

Both recordings use the real agent HTTP API, durable worker, and PostgreSQL with synthetic accounts and repository fixtures. Engines, sandbox filesystems, checks, and publication acknowledgements are simulated. No E2B VM, real model call, or GitHub PR is created. Idle waits were trimmed, and demo-only delays make lifecycle transitions visible. There is no narration.

The PNG is a still from the product UI recording, used as a linked poster in the PR description.
