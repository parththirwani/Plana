import { Reveal } from "./Reveal";
import { BoardMockup, BrowserFrame } from "./BoardMockup";
import { cn } from "@/lib/utils";

const rows = [
  {
    eyebrow: "Boards",
    title: "Move work forward, visually",
    body: "Drag-and-drop boards that mirror how your team actually thinks. Pick up a card, drop it where it belongs, and the plan updates for everyone.",
    variant: "board" as const,
  },
  {
    eyebrow: "Ownership",
    title: "Know who owns what",
    body: "Clear roles and assignees, so accountability is never a guessing game. Everyone can see the work; the right people can change it.",
    variant: "people" as const,
  },
  {
    eyebrow: "Details",
    title: "Never lose the thread",
    body: "Every comment, deadline, and detail stays attached to the work itself. Open a card and the whole story is right there.",
    variant: "card" as const,
  },
];

function PeopleMock() {
  const people = [
    { n: "Jordan Tate", r: "Admin", c: "bg-accent/15 text-accent" },
    { n: "Mira Kaur", r: "Moderator", c: "bg-emerald-100 text-emerald-700" },
    { n: "Sam Lowe", r: "Member", c: "bg-amber-100 text-amber-700" },
    { n: "Ava Reyes", r: "Member", c: "bg-sky-100 text-sky-700" },
  ];
  return (
    <div className="space-y-2 bg-background p-6">
      {people.map((p) => (
        <div
          key={p.n}
          className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3 shadow-hair"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold",
                p.c,
              )}
            >
              {p.n
                .split(" ")
                .map((x) => x[0])
                .join("")}
            </span>
            <span className="truncate text-sm font-medium">{p.n}</span>
          </div>
          <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            {p.r}
          </span>
        </div>
      ))}
    </div>
  );
}

function DetailMock() {
  return (
    <div className="bg-background p-6">
      <div className="rounded-xl border border-border bg-card p-5 shadow-hair">
        <span className="inline-flex rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
          High
        </span>
        <h4 className="mt-2 text-base font-semibold tracking-tight">Ship the new board view</h4>
        <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span className="rounded-md bg-muted px-2 py-1">Due Sep 12</span>
          <span className="rounded-md bg-muted px-2 py-1">Assigned to Mira</span>
        </div>
        <div className="mt-5 space-y-3 border-t border-border pt-4">
          {[
            ["MK", "Columns feel much calmer now. Moving to review."],
            ["JT", "Nice I'll take a look before standup."],
          ].map(([i, t]) => (
            <div key={t} className="flex gap-3">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                {i}
              </span>
              <p className="text-xs leading-relaxed text-muted-foreground">{t}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function Spotlight() {
  return (
    <section id="product" className="section-y">
      <div className="container-page space-y-20 md:space-y-28">
        {rows.map((r, i) => (
          <Reveal key={r.title}>
            <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div className={cn(i % 2 === 1 && "lg:order-2")}>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-accent">
                  {r.eyebrow}
                </p>
                <h3 className="mt-3 text-2xl font-semibold tracking-tight sm:text-4xl">
                  {r.title}
                </h3>
                <p className="mt-4 max-w-md text-muted-foreground">{r.body}</p>
              </div>
              <BrowserFrame className={cn(i % 2 === 1 && "lg:order-1")} label="plana.app">
                {r.variant === "board" && <BoardMockup compact />}
                {r.variant === "people" && <PeopleMock />}
                {r.variant === "card" && <DetailMock />}
              </BrowserFrame>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
