# Frontend Integration Plan — Trello-like app

## Status

### Phase 1 — Merge plana-board into apps/frontend ✅ DONE
- plana components/types/styles merged; `plana-board/` deleted; routes moved under `/app`; `app.tsx` placeholder removed; `routeTree.gen.ts` regenerated.

### Phase 2 — Backend-aligned types + full API client ✅ DONE
- `plana-types.ts` rewritten to real backend shapes (Role/Priority enums, User, Organization, Member, Board, Section, Issue, Comment, BoardDetail).
- `api.ts` covers every endpoint: onboarding, profile, orgs, members (invite/role/remove), leave, boards, sections, issues (move/assignees), comments, plus `getWsToken`.

### Phase 3 — zustand data store (replace PlanaProvider) ✅ DONE
- `plana-store.ts` (zustand) with `orgs`, `boards`, `members`, `board`, `comments`; actions wrap `api.ts` then refetch. No optimistic cache.
- `auth-guard.tsx` (`useAuthGuard`/`Authed`) gates all `/app/*` routes; auth flow redirects to `/onboarding` when `!onboardingCompleted`.

### Phase 4 — Rewrite the 6 screens ✅ DONE
- Dashboard (`/app`), Boards (`/app/org/$id`), Settings (General/Members/Danger), Board kanban with drag-drop + section/board create-rename-delete, IssuePanel (comments add/edit/delete, assignees, priority, due date, delete issue), Profile + logout, Onboarding.
- Member invite by email only (role always MEMBER); 403/404/409 surfaced.

### Phase 5 — WebSocket realtime ✅ DONE
- Backend `GET /api/v1/ws-token` (authMiddleware) returns a fresh 1h JWT.
- `lib/board-socket.ts` — `connectBoardSocket(boardId)` fetches the token and opens `ws://<host>:9000/ws?boardId=..&token=..` directly (no vite proxy); applies `board.*`, `section.*`, `issue.*`, `comment.*` events to the plana-store; `live-glow` on the changed card; socket closed on unmount.
- Fake `simulateTeammateChange` gone (never present in merged code).

### Phase 6 — Cleanup & verify ✅ DONE
- `bun install` prunes the lockfile; dead mock code removed; `vite.config.ts` `/api` proxy kept (no WS proxy).
- `tsc --noEmit` + eslint (no new errors) + prettier across all three apps.
- Live smoke (`bun run smoke` from `apps/backend`): signup → onboarding → org → board → sections → issues → move → assignees → comments → role change → ws-token → **WS event relay across two sockets** → logout, DB cleaned up.

## Reality check

Two frontend apps exist:

- `apps/frontend` — landing page + auth (zustand `auth-store`, `/api` dev proxy, WS-ready `setUnauthorizedHandler`).
- `apps/frontend/plana-board` — full dashboard/boards mock on a `PlanaProvider` React context. No auth, no API. Its types are invented (`org.members`, `board.memberIds`, `issue.assigneeIds`, `"Admin"`/`"None"` casing) — none match the backend.

Plan: merge plana-board into apps/frontend and rewrite against the real backend shapes.

Backend coverage (confirmed from routers): auth, onboarding, profile, orgs (CRUD / members / invite / role / remove / leave), boards, sections, issues (move / assignees), comments, and the WebSocket relay on `:9000`.

## Phase 1 — Merge plana-board into apps/frontend, delete the duplicate

- Copy `plana-board/src/components/plana/{app-shell,issue-panel,ui-kit}.tsx` and `plana-board/src/lib/plana-types.ts` into `apps/frontend/src/`.
- Add plana-board's missing CSS to `apps/frontend/src/styles.css`: `--surface`, `--primary-soft`, `--destructive-soft`, `--priority-*`, `--shadow-panel`, `--ease-spring` + utilities `label-eyebrow`, `card-hover`, `live-glow`, `slide-over-in`, `fade-up`. Keep the landing palette/tokens.
- Route moves (files under `src/routes/`):
  - `index.tsx` → `app.index.tsx` (orgs dashboard)
  - `org.$orgId.index.tsx` → `app.org.$orgId.index.tsx`
  - `org.$orgId.settings.tsx` → `app.org.$orgId.settings.tsx`
  - `board.$boardId.tsx` → `app.board.$boardId.tsx`
  - `profile.tsx` → `app.profile.tsx`
  - Delete placeholder `app.tsx`.
  - Rewrite all internal `to="/" | "/org/.." | "/board/.." | "/profile"` to `/app`-prefixed.
- **Delete `apps/frontend/plana-board/` entirely** — its `vite.config.ts`, `package.json`, `node_modules`, `bun.lock`, `components.json`, `eslint.config.js`, `tsconfig.json`, `AGENTS.md`, `README.md`, `public`, `src` are the "vite files/settings not needed". One app, one vite setup.
- Regenerate `routeTree.gen.ts`.

## Phase 2 — Backend-aligned types + full API client

- Rework `plana-types.ts` to real shapes:
  - `Role = "ADMIN" | "MODERATOR" | "MEMBER"`
  - `Priority = "NONE" | "LOW" | "MEDIUM" | "HIGH" | "URGENT"`
  - `User { id, email, name, avatarUrl, onboardingCompleted }`
  - `Organization { id, name, slug, description, orgImage, role }`
  - `Member { id, userId, role, user }`
  - `Board { id, title, description, organizationId, createdAt, updatedAt }`
  - `Section { id, title, order, boardId }`
  - `Issue { id, title, description, order, priority, dueDate, sectionId, assignees[] }`
  - `Comment { id, content, issueId, authorId, createdAt, updatedAt, author }`
  - `BoardDetail`
  - Update `PRIORITIES`, `priorityColor`, `atLeast`.
- Extend `api.ts` with typed calls for every endpoint: onboarding, profile PUT, orgs (list/get/create/update/delete), members (list/invite/role/remove), leave, boards (list/get/create/update/delete), sections (create/update/delete), issues (create/update/delete/move/assignees), comments (list/create/update/delete), plus `getWsToken`.

## Phase 3 — zustand data store (replace PlanaProvider)

- New `src/lib/plana-store.ts` (zustand): `orgs`, `members`, `board` (BoardDetail|null), loading/error flags; actions wrap `api.ts` then **refetch the touched resource**.
  - `ponytail:` no optimistic cache — refetch is simpler and correct; WS reconciles remote changes.
- `useAuthGuard()` hook: init auth → redirect `/login` when unauthenticated. Used by all `/app/*` routes.
- Auth flow: AuthPage redirect → `/onboarding` if `!onboardingCompleted`, else `/app`.

## Phase 4 — Rewrite the 6 screens

- **Dashboard** (`/app`): load orgs; card = name/desc/role badge; create org.
  - `ponytail:` no member-count / avatar rows — backend org list has neither; add when needed (N+1 members calls).
- **Boards** (`/app/org/$id`): list/create/delete; search + updatedAt sort keep.
  - `ponytail:` drop `board.memberIds` avatar stack — not in backend board rows.
- **Settings**: General (name/desc/**orgImage URL**), Members (invite by email only — backend schema is `{ email }`, role always MEMBER, so remove the role selector; change role; remove), Danger (leave/delete). Surface 403/404/409 messages.
- **Board** (`/app/board/$id`): load BoardDetail; drag-drop move → compute target `order` index → `POST /move`; add section (rename + delete now that backend supports them); board edit/delete; card → IssuePanel.
- **IssuePanel**: comments fetched on open (`GET /issues/:id/comments`) + add/edit/delete; assignees via `PUT /issues/:id/assignees` (full list); **add Delete issue** (missing today).
- **Profile + AppShell**: real user from auth store; save via `PUT /profile`; **wire logout** (both places currently no-ops) → auth store → `/login`.
- **Onboarding** (`/onboarding`): name (+ avatar URL) → `POST /onboarding` → refresh user → `/app`.

## Phase 5 — WebSocket realtime (no vite proxy)

- Backend (only backend change): add `GET /api/v1/ws-token` (authMiddleware) returning a fresh 1h JWT.
- Frontend `lib/board-socket.ts`: `connectBoardSocket(boardId)` → `getWsToken()`, then
  `new WebSocket(\`${import.meta.env.VITE_WS_URL ?? "ws://localhost:9000"}/ws?boardId=..&token=..\`)`.
  Browser connects directly to `:9000` — no vite config involved.
- Apply relayed events (`issue.*`, `section.*`, `comment.*`, `board.*`) to the plana-store board; use `live-glow` on the changed card.
- Remove the fake `simulateTeammateChange`. Socket per board, closed on unmount.

## Phase 6 — Cleanup & verify

- `bun install` to prune lockfile; delete dead mock code; keep `vite.config.ts` `/api` proxy (no WS proxy).
- `tsc --noEmit` + lint (changed files only) + prettier.
- Live smoke: signup → onboarding → create org → board → sections → issues → move → assignees → comments → settings ops → WS event relay across two sockets → logout. Clean up test rows.

## Deliberate cuts (`ponytail:`)

- No board member avatars / org member counts.
- No image upload — URL fields only.
- Refetch-on-mutate, no optimistic reorder.
- No WS dev proxy — direct connection to `:9000` via a short-lived token.
