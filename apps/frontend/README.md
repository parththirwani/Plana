# Plana: Effortless Teamwork

Build a landing page for Plana, a Trello-style project management tool for teams (organizations → boards → kanban sections → issues, with live collaboration via WebSocket).

Design direction

Aesthetic: minimal, light theme, generous whitespace, YC/modern-AI-SaaS style (think Linear, Vercel, Ramp, Ashby marketing sites).

Typography-led design: large, confident, tight-tracking headlines (Inter, Geist, or Satoshi), clear type hierarchy, a lot of the visual interest should come from type size/weight contrast rather than heavy graphics.

Palette: off-white/white background (#FAFAFA / #FFFFFF), near-black text (#0A0A0A), one accent color (indigo or violet, e.g. #5B5BD6) used sparingly for CTAs, links, and highlights. Soft neutral grays for borders/cards.

Components/interactions: take inspiration from Aceternity UI and Godly.website patterns — subtle scroll-reveal animations, gradient-bordered cards, spotlight/glow hover effects, marquee logo strips, animated tab switchers, bento-grid feature layouts. Keep animations tasteful and fast (150–300ms), not gimmicky.

Spacing: generous section padding (100–160px vertical on desktop), max content width ~1200px, centered.

Corners/shadows: rounded-xl to rounded-2xl cards, very soft shadows (shadow-sm/shadow-md), 1px hairline borders in light gray.

Page sections

Nav bar — sticky, transparent-to-white on scroll, logo "Plana" left, links (Product, Features, Pricing, Docs) center, "Sign in" + "Get started" (accent button) right.

Hero

Small pill badge above headline (e.g. "Now with real-time collaboration").

Headline: something like "Project management that moves at the speed of your team."

Subheadline: one or two lines on boards, kanban, roles, and live sync.

Two CTAs: primary "Get started free" (accent, filled), secondary "See how it works" (outline/ghost).

Below the fold of the hero: a large product screenshot/mockup of the kanban board (columns = sections, draggable cards = issues, avatar chips for assignees, priority tags). Use a bento/browser-chrome frame with soft shadow and slight perspective tilt on scroll.

Logo strip — "Trusted by teams at" with a muted grayscale marquee of placeholder logos.

Feature bento grid (3–4 cards, Aceternity-style bento layout, one larger hero card + smaller supporting cards):

Kanban boards — drag-and-drop sections and issues, reorder columns, live sync across the team.

Roles & permissions — Admin / Moderator / Member with granular controls.

Real-time collaboration — WebSocket-powered live updates, presence avatars, optimistic UI.

Comments & context — threaded comments, due dates, priority levels, assignees, all on one card.

"How it works" — 3-step section with numbered steps and small illustrations/icons:

Create an organization and invite your team.

Spin up boards and sections for your workflow.

Drag, assign, comment — everyone sees updates instantly.

Product deep-dive / feature spotlight — alternating left/right image+text rows (2–3 rows): e.g. "Move fast with drag-and-drop", "Know who owns what" (assignees + roles), "Never lose context" (comments + issue detail modal). Each row: short headline, 2-sentence description, screenshot mockup.

Social proof — 3-column testimonial cards (quote, name, role, avatar) in bordered rounded cards with subtle hover lift.

Pricing (optional simple 3-tier: Free / Team / Enterprise) — clean cards, one highlighted with accent border and "Most popular" badge.

Final CTA band — full-width section, near-black or accent-tinted background, large centered headline ("Start organizing your team's work today"), single CTA button.

Footer — logo, short tagline, columns (Product, Company, Resources, Legal), social icons, muted copyright line.

Content/product facts to reflect accurately

Plana organizes work as Organizations → Boards → Sections (columns) → Issues (cards).

Roles: Admin, Moderator, Member — Admins manage org settings/members/roles, Moderators manage boards/sections/issues, Members can view and comment.

Issues support priority (None/Low/Medium/High/Urgent), due dates, assignees, and comments.

Realtime board updates via WebSocket — changes from teammates appear live with an actor avatar.

Auth is simple email/password with an onboarding step to set name/avatar.

Technical notes for Lovable

Fully responsive (mobile: stack bento grid, collapse nav into a menu button).

Use scroll-triggered fade/slide-up animations on section entry (Framer Motion or CSS intersection-observer style).

Buttons: solid accent primary, outline secondary, both with subtle hover scale/opacity transition.

All images/screenshots can be placeholder mockups styled as browser windows (rounded top bar with 3 dots) showing a simplified kanban board UI in the same color palette.

No dark mode needed — light theme only.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/6f8b5914-d47c-483f-bfeb-59dd5e3ad116).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
