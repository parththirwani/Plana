# Plana — Frontend Build Prompt

Plana is a Trello-like project-management app (kanban boards). This document describes every feature of the backend API so you can build a frontend for it.

## 1. Overview

- Monorepo: `apps/backend` (Express REST API), `apps/websocket` (Bun WebSocket server), `packages/db` (Prisma + Postgres).
- REST base URL: `/api/v1`.
- Auth: **httpOnly cookie** (`token`, 1h, SameSite=lax, secure on HTTPS). Never send the token in a header or body. In the browser use `fetch(..., { credentials: "include" })` (or `withCredentials`).
- Realtime: WebSocket server relays board events to connected clients.
- Roles per organization: `ADMIN` > `MODERATOR` > `MEMBER`, gated by organization membership.

## 2. Screens to build

1. **Auth screen** — signup / signin forms (email + password), redirect based on `onboardingCompleted`.
2. **Onboarding screen** — first-time flow to set `name` and `avatarUrl` (shown when `onboardingCompleted === false`).
3. **Home / Organizations** — list of orgs the user belongs to (with role badge), create-org form, switch org.
4. **Org settings** — org name/description/image edit (ADMIN), members list, invite member by email, change role, remove member (ADMIN), leave org.
5. **Boards list** — boards of the selected org.
6. **Board (kanban)** — sections as columns, issues as cards; drag cards between sections and reorder within a section; drag sections to reorder; create/edit/delete sections, issues, boards; assign members to issues; priority + due date on cards; live updates via WebSocket.
7. **Issue detail** — expandable/modal card detail with description, priority, due date, assignees, comments (add/edit/delete).
8. **Profile** — edit name/avatar; logout.

## 3. Roles & permissions

| Action | MEMBER | MODERATOR | ADMIN |
|---|---|---|---|
| View org / boards / issues | ✅ | ✅ | ✅ |
| Create/delete comments | ✅ | ✅ | ✅ |
| Edit/delete own comments | ✅ | ✅ | ✅ |
| Edit/delete ANY comment | ❌ | ✅ | ✅ |
| Create/update/delete boards | ❌ | ✅ | ✅ |
| Create/update/delete sections | ❌ | ✅ | ✅ |
| Create/update/delete issues | ❌ | ✅ | ✅ |
| Move / assign issues | ❌ | ✅ | ✅ |
| Update org / invite / remove members / change roles | ❌ | ❌ | ✅ |
| Leave org | ✅ | ✅ | ✅ (unless last admin) |

- Last admin can never be demoted, removed, or leave (server blocks with 400).

## 4. HTTP conventions

- **400** — invalid/malformed body (zod validation).
- **401** — no/invalid/expired token.
- **403** — authenticated but not allowed; also used for non-members querying orgs (org existence is **not** leaked — a non-member gets 403 even for an unknown org).
- **404** — resource genuinely missing (board/section/issue/comment; user being invited not found).
- **409** — conflicts: duplicate email, user already a member, onboarding already completed.
- All JSON responses are `{ message: string, ...payload }`.

## 5. API reference

### Auth
| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/v1/auth/signup` | `{ email, password }` | 201 `{ user }` + cookie |
| POST | `/api/v1/auth/signin` | `{ email, password }` | 200 `{ user }` + cookie |
| POST | `/api/v1/auth/logout` | — | 200 (clears cookie) |
| GET | `/api/v1/auth/me` | — | 200 `{ user }` |

- `email` trimmed + lowercased; `password` min 5 chars; duplicate email → 409. `user` = `{ id, email, name, avatarUrl, onboardingCompleted }`.

### Onboarding & profile
| Method | Path | Body | Success |
|---|---|---|---|
| POST | `/api/v1/onboarding` | `{ name (3–50), avatarUrl? (url) }` | 200 `{ user }`; 409 if already done |
| PUT | `/api/v1/profile` | `{ name?, avatarUrl? }` | 200 `{ user }` |
| GET | `/api/v1/profile` | — | 200 `{ user }` |

### Organizations
| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/api/v1/organizations` | `{ name (1–50), description?, orgImage? }` | 201 `{ organization }` | Creator becomes ADMIN; auto slug |
| GET | `/api/v1/organizations` | — | 200 `{ organizations }` | Only user's orgs, each with `role` |
| GET | `/api/v1/organizations/:id` | — | 200 `{ organization }` | Member only |
| GET | `/api/v1/organizations/by-slug/:slug` | — | 200 `{ organization }` | Canonical lookup |
| PUT | `/api/v1/organizations/:id` | `{ name?, description?, orgImage? }` | 200 | ADMIN; slug regenerates on rename |
| DELETE | `/api/v1/organizations/:id` | — | 200 | ADMIN; cascades everything |
| GET | `/api/v1/organizations/:id/members` | — | 200 `{ members }` | Member only |
| POST | `/api/v1/organizations/:id/members` | `{ email }` | 201 `{ membership }` | ADMIN; 404 unknown user, 409 already member |
| PATCH | `/api/v1/organizations/:id/members/:userId` | `{ role: MEMBER\|MODERATOR\|ADMIN }` | 200 | ADMIN; last-admin demote blocked (400) |
| DELETE | `/api/v1/organizations/:id/members/:userId` | — | 200 | ADMIN; last-admin removal blocked (400) |
| POST | `/api/v1/organizations/:id/leave` | — | 200 | Any member; last admin blocked (400) |

- `organization` = `{ id, name, slug, description, orgImage, role }`; `members` = `{ id, userId, role, user: { id, email, name, avatarUrl } }`.

### Boards & sections
| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/api/v1/organizations/:id/boards` | `{ title (1–100), description? }` | 201 `{ board }` | MODERATOR+ |
| GET | `/api/v1/organizations/:id/boards` | — | 200 `{ boards }` | Member |
| GET | `/api/v1/boards/:id` | — | 200 `{ board }` | Board detail incl. sections + issues + assignees |
| PUT | `/api/v1/boards/:id` | `{ title?, description? }` | 200 | MODERATOR+ |
| DELETE | `/api/v1/boards/:id` | — | 200 | MODERATOR+ |
| POST | `/api/v1/boards/:id/sections` | `{ title (1–100) }` | 201 `{ section }` | MODERATOR+; appended last |
| PATCH | `/api/v1/sections/:id` | `{ title?, order? }` | 200 | MODERATOR+; `order` reorders the column |
| DELETE | `/api/v1/sections/:id` | — | 200 | MODERATOR+; remaining columns renumbered |

- Board detail shape: `{ id, title, description, organizationId, sections: [{ id, title, order, issues: [...] }] }` where each issue is shaped as below (comments are **not** included here).

### Issues
| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/api/v1/sections/:id/issues` | `{ title (1–200), description?, priority?, dueDate? }` | 201 `{ issue }` | MODERATOR+; appended last |
| PATCH | `/api/v1/issues/:id` | `{ title?, description?, priority?, dueDate? }` | 200 `{ issue }` | MODERATOR+ |
| DELETE | `/api/v1/issues/:id` | — | 200 | MODERATOR+; siblings renumbered |
| POST | `/api/v1/issues/:id/move` | `{ sectionId, order? }` | 200 `{ issue }` | MODERATOR+; same-board only (400 cross-board) |
| PUT | `/api/v1/issues/:id/assignees` | `{ assigneeIds: string[] }` | 200 `{ issue }` | MODERATOR+; only org members assignable |

- `priority`: `NONE | LOW | MEDIUM | HIGH | URGENT` (default `NONE`).
- `dueDate`: ISO date or `null`.
- Issue shape: `{ id, title, description, order, priority, dueDate, sectionId, assignees: [{ id, email, name, avatarUrl }] }`.

### Comments
| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/api/v1/issues/:id/comments` | `{ content (1–2000) }` | 201 `{ comment }` | Member |
| GET | `/api/v1/issues/:id/comments` | — | 200 `{ comments }` | Member; ordered by createdAt |
| PATCH | `/api/v1/comments/:id` | `{ content }` | 200 `{ comment }` | Author or MODERATOR+ |
| DELETE | `/api/v1/comments/:id` | — | 200 | Author or MODERATOR+ |

- Comment shape: `{ id, content, issueId, authorId, createdAt, updatedAt, author: { id, email, name, avatarUrl } }`.

## 6. Realtime (WebSocket)

- Endpoint: `wss://<host>/ws?boardId=<boardId>` (or `ws://` locally).
- Auth: JWT via `?token=` query param **or** the `token` cookie.
- Errors: 401 unauthenticated, 400 missing `boardId`, 403 not a board member.
- Connect **one socket per board**; a client may hold multiple sockets. Messages sent by the client are ignored (subscription is fixed at connect).
- Server sends one JSON payload per event:
  ```json
  {
    "boardId": "…",
    "event": "board.created | board.updated | board.deleted | section.created | section.updated | section.deleted | issue.created | issue.updated | issue.deleted | issue.moved | issue.assignees | comment.created | comment.updated | comment.deleted",
    "actor": { "id": "…", "name": "…", "avatarUrl": "…" },
    "data": { }
  }
  ```
- `data` for issue events contains the full issue shape (with assignees); comment events contain the full comment shape (with author). `board.deleted`, `section.deleted`, `issue.deleted`, `comment.deleted` carry `{ id }`. Use `actor` to render the acting user's avatar next to the change and to ignore events the current user already applied optimistically.
- Only events for boards the socket is subscribed to are relayed.

## 7. Suggested UX notes

- Optimistically apply card moves, then reconcile with the WS event for the same board.
- Show a small avatar chip (actor) when a remote user's change arrives.
- Keep board data locally keyed by `boardId`; apply events by `event` prefix (e.g. `issue.updated` replaces the issue in its section).
- Handle cookie expiry: on any `401`, redirect to auth.
