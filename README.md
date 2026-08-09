# Plana

Plana is a Trello-style project management app. Teams organize work into **organizations → boards → sections (columns) → issues (cards)**, with live collaboration so everyone sees changes as they happen.

## Features

- **Organizations**: create and join teams, each with their own boards and members.
- **Roles & permissions**: `ADMIN`, `MODERATOR`, `MEMBER` with granular controls over who can edit boards, manage members, and change settings.
- **Kanban boards**: drag-and-drop cards between columns, reorder columns, create/edit/delete boards, sections, and issues.
- **Issues**: title, description, priority (`None/Low/Medium/High/Urgent`), due date, and assignees.
- **Comments**: threaded discussion on every issue; authors and moderators can edit or delete.
- **Live collaboration**: board changes sync to every connected teammate in real time, with an avatar shown next to the change.
- **Onboarding & profile**: simple email/password auth, first-time onboarding to set name and avatar, editable profile.

## Screens

1. Auth (sign up / sign in)
2. Onboarding
3. Home / Organizations
4. Org settings (general, members, danger zone)
5. Boards list
6. Board (kanban)
7. Issue detail
8. Profile

## Roles & permissions

| Action | Member | Moderator | Admin |
|---|---|---|---|
| View org / boards / issues | ✅ | ✅ | ✅ |
| Create/delete comments | ✅ | ✅ | ✅ |
| Edit/delete own comments | ✅ | ✅ | ✅ |
| Edit/delete any comment | ❌ | ✅ | ✅ |
| Create/update/delete boards, sections, issues | ❌ | ✅ | ✅ |
| Move / assign issues | ❌ | ✅ | ✅ |
| Update org / invite / remove members / change roles | ❌ | ❌ | ✅ |
| Leave org | ✅ | ✅ | ✅ (unless last admin) |

The last remaining admin in an organization can never be demoted, removed, or leave.

## Project structure

```
apps/
  backend/     # Express REST API
  websocket/   # Bun WebSocket server (realtime board events)
packages/
  db/          # Prisma + Postgres schema
```

## Tech stack

- **API:** Express (Node.js), REST, JSON responses shaped as `{ message, ...payload }`
- **Realtime:** Bun WebSocket server, one socket per board
- **Database:** PostgreSQL via Prisma
- **Auth:** httpOnly session cookie (1h expiry)

## API overview

Base URL: `/api/v1`

| Resource | Endpoints |
|---|---|
| Auth | `POST /auth/signup`, `POST /auth/signin`, `POST /auth/logout`, `GET /auth/me` |
| Onboarding & profile | `POST /onboarding`, `GET /profile`, `PUT /profile` |
| Organizations | `POST /organizations`, `GET /organizations`, `GET /organizations/:id`, `GET /organizations/by-slug/:slug`, `PUT /organizations/:id`, `DELETE /organizations/:id` |
| Members | `GET /organizations/:id/members`, `POST /organizations/:id/members`, `PATCH /organizations/:id/members/:userId`, `DELETE /organizations/:id/members/:userId`, `POST /organizations/:id/leave` |
| Boards | `POST /organizations/:id/boards`, `GET /organizations/:id/boards`, `GET /boards/:id`, `PUT /boards/:id`, `DELETE /boards/:id` |
| Sections | `POST /boards/:id/sections`, `PATCH /sections/:id`, `DELETE /sections/:id` |
| Issues | `POST /sections/:id/issues`, `PATCH /issues/:id`, `DELETE /issues/:id`, `POST /issues/:id/move`, `PUT /issues/:id/assignees` |
| Comments | `POST /issues/:id/comments`, `GET /issues/:id/comments`, `PATCH /comments/:id`, `DELETE /comments/:id` |

Standard HTTP status codes: `400` invalid body, `401` unauthenticated, `403` unauthorized (org existence is never leaked to non-members), `404` not found, `409` conflict.

### Realtime events

Connect to `wss://<host>/ws?boardId=<boardId>` (auth via the session cookie or a `token` query param). Each message:

```json
{
  "boardId": "…",
  "event": "board.updated | section.created | issue.moved | comment.created | …",
  "actor": { "id": "…", "name": "…", "avatarUrl": "…" },
  "data": { }
}
```

## Getting started

```bash
# install dependencies
bun install   # or npm install / pnpm install

# set up the database
cd packages/db
bunx prisma migrate dev

# run the backend API
cd apps/backend
bun run dev

# run the websocket server
cd apps/websocket
bun run dev
```
