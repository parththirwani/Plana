import { cn } from "@/lib/utils";
import { GlyphPriority } from "./Glyphs";

type Tone = "urgent" | "high" | "medium" | "low";

type Card = {
  title: string;
  tag?: { label: string; tone: Tone };
  people?: string[];
};

const toneClass: Record<Tone, string> = {
  urgent: "border-rose-200/70 text-rose-600",
  high: "border-amber-200/80 text-amber-700",
  medium: "border-accent/25 text-accent",
  low: "border-border text-muted-foreground",
};

const toneLevel: Record<Tone, 1 | 2 | 3> = { urgent: 3, high: 3, medium: 2, low: 1 };

const avatarTone = [
  "bg-accent/10 text-accent border-accent/20",
  "bg-emerald-50 text-emerald-700 border-emerald-200/70",
  "bg-amber-50 text-amber-700 border-amber-200/70",
  "bg-sky-50 text-sky-700 border-sky-200/70",
];

function Avatar({ initials, i }: { initials: string; i: number }) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full border text-[10px] font-medium ring-2 ring-white",
        avatarTone[i % avatarTone.length],
      )}
    >
      {initials}
    </span>
  );
}

function IssueCard({ card }: { card: Card }) {
  return (
    <div className="rounded-xl border border-border bg-white p-3 shadow-hair transition-shadow duration-200 hover:shadow-soft">
      {card.tag && (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-0.5 text-[10px] font-medium",
            toneClass[card.tag.tone],
          )}
        >
          <span className="size-3">
            <GlyphPriority level={toneLevel[card.tag.tone]} strokeWidth={2.25} />
          </span>
          {card.tag.label}
        </span>
      )}
      <p className="mt-2 text-[13px] font-medium leading-snug text-foreground">{card.title}</p>
      <div className="mt-3 flex items-center justify-between">
        <div className="flex -space-x-2">
          {(card.people ?? []).map((p, i) => (
            <Avatar key={p} initials={p} i={i} />
          ))}
        </div>
        <span className="h-1 w-8 rounded-full bg-muted" />
      </div>
    </div>
  );
}

const columns: { name: string; count: number; cards: Card[] }[] = [
  {
    name: "To do",
    count: 4,
    cards: [
      { title: "Design new homepage", tag: { label: "Medium", tone: "medium" }, people: ["AR"] },
      { title: "Write launch copy", people: ["MK", "JT"] },
    ],
  },
  {
    name: "In progress",
    count: 3,
    cards: [
      {
        title: "Fix login bug",
        tag: { label: "High", tone: "urgent" },
        people: ["JT", "AR", "MK"],
      },
      { title: "Plan the team offsite", tag: { label: "Medium", tone: "medium" }, people: ["SL"] },
    ],
  },
  {
    name: "In review",
    count: 2,
    cards: [
      { title: "Review onboarding flow", tag: { label: "High", tone: "high" }, people: ["MK"] },
    ],
  },
  {
    name: "Done",
    count: 8,
    cards: [{ title: "Pick a launch date", people: ["SL", "AR"] }],
  },
];

export function BrowserFrame({
  children,
  className,
  label,
  style,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-white shadow-lifted",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-background/80 px-4 py-3">
        <span className="size-2.5 rounded-full border border-border" />
        <span className="size-2.5 rounded-full border border-border" />
        <span className="size-2.5 rounded-full border border-border" />
        {label && (
          <div className="mx-auto hidden rounded-md bg-muted px-3 py-1 text-[11px] text-muted-foreground sm:block">
            {label}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

export function BoardMockup({ compact = false }: { compact?: boolean }) {
  const cols = compact ? columns.slice(0, 3) : columns;
  return (
    <div className="bg-white p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">Product</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Northwind team</p>
        </div>
        <div className="flex -space-x-2">
          {["JT", "AR", "MK", "SL"].map((p, i) => (
            <Avatar key={p} initials={p} i={i} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        {cols.map((c) => (
          <div key={c.name} className="rounded-xl bg-background/80 p-2.5">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-3 w-[3px] shrink-0 rounded-full bg-border" />
                <span className="truncate text-[11px] font-semibold text-foreground">{c.name}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">{c.count}</span>
            </div>
            <div className="space-y-2">
              {c.cards.map((card) => (
                <IssueCard key={card.title} card={card} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
