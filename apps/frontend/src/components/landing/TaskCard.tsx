import { cn } from "@/lib/utils";
import { GlyphPriority } from "./Glyphs";

type Tone = "urgent" | "high" | "medium" | "low";

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

export function DemoAvatar({ initials, index }: { initials: string; index: number }) {
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full border text-[10px] font-medium",
        "ring-2 ring-white",
        avatarTone[index % avatarTone.length],
      )}
    >
      {initials}
    </span>
  );
}

export function TaskCard({
  title,
  tag,
  people,
  dragging = false,
}: {
  title: string;
  tag?: { label: string; tone: Tone };
  people?: string[];
  dragging?: boolean;
}) {
  return (
    <div
      className={cn(
        "select-none rounded-xl border border-border bg-white p-4 shadow-hair transition-shadow duration-200",
        dragging ? "shadow-lifted" : "hover:shadow-soft",
      )}
    >
      {tag && (
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[10px] font-medium",
            toneClass[tag.tone],
          )}
        >
          <span className="size-3">
            <GlyphPriority level={toneLevel[tag.tone]} strokeWidth={2.25} />
          </span>
          {tag.label}
        </span>
      )}
      <p className="mt-3 text-[13px] font-medium leading-snug text-foreground">{title}</p>
      <div className="mt-4 flex items-center justify-between">
        <div className="flex -space-x-2">
          {(people ?? []).map((p, i) => (
            <DemoAvatar key={p} initials={p} index={i} />
          ))}
        </div>
        <span className="ml-3 h-1 w-8 shrink-0 rounded-full bg-muted" />
      </div>
    </div>
  );
}
