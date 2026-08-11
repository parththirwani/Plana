import { cn } from "@/lib/utils";
import { TaskCard, DemoAvatar } from "./TaskCard";

type Card = {
  title: string;
  tag?: { label: string; tone: "urgent" | "high" | "medium" | "low" };
  people?: string[];
};

function IssueCard({ card }: { card: Card }) {
  return (
    <TaskCard
      title={card.title}
      {...(card.tag ? { tag: card.tag } : {})}
      {...(card.people ? { people: card.people } : {})}
    />
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
  const gridCols = compact
    ? "grid-cols-[repeat(2,minmax(200px,1fr))] sm:grid-cols-[repeat(3,minmax(200px,1fr))]"
    : "grid-cols-[repeat(2,minmax(200px,1fr))] sm:grid-cols-[repeat(3,minmax(200px,1fr))] md:grid-cols-[repeat(4,minmax(200px,1fr))]";
  return (
    <div className="overflow-x-auto bg-white p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-tight">Product</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Northwind team</p>
        </div>
        <div className="flex -space-x-2">
          {["JT", "AR", "MK", "SL"].map((p, i) => (
            <DemoAvatar key={p} initials={p} index={i} />
          ))}
        </div>
      </div>
      <div className={cn("grid", gridCols, "gap-4 sm:gap-5")}>
        {cols.map((c) => (
          <div key={c.name} className="rounded-xl bg-background/80 p-3">
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-3 w-[3px] shrink-0 rounded-full bg-border" />
                <span className="truncate text-[11px] font-semibold text-foreground">{c.name}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">{c.count}</span>
            </div>
            <div className="space-y-3">
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
