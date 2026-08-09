import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Custom glyph set for Plana.
 * Rules: 24px grid, single 1.5px stroke, round caps/joins, 2px corner radius
 * family, no fills, no gradients. Shapes are abstractions of the product's
 * own UI — cards, columns, rows, threads — not stock symbols.
 */

type GlyphProps = SVGProps<SVGSVGElement>;

function Base({ children, className, ...props }: GlyphProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-full", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

/** Three columns of a board, uneven fill height. */
export function GlyphColumns(props: GlyphProps) {
  return (
    <Base {...props}>
      <rect x="3" y="4" width="5" height="16" rx="2" />
      <rect x="9.5" y="4" width="5" height="16" rx="2" />
      <rect x="16" y="4" width="5" height="16" rx="2" />
      <path d="M4.5 8.5h2M11 8.5h2M17.5 8.5h2M4.5 12h2M11 12h2" />
    </Base>
  );
}

/** A card being carried between two slots. */
export function GlyphCardMove(props: GlyphProps) {
  return (
    <Base {...props}>
      <rect x="2.75" y="6" width="9" height="8" rx="2" />
      <path d="M5 9h4.5M5 11.5h2.5" />
      <path d="M15 18.5h5a1 1 0 0 0 1-1V9" />
      <path d="M19 11 21 8.6 23 11" transform="translate(-2)" />
    </Base>
  );
}

/** Rows of people with an access marker — roles and permissions. */
export function GlyphRoster(props: GlyphProps) {
  return (
    <Base {...props}>
      <rect x="3" y="4.5" width="18" height="6" rx="2" />
      <rect x="3" y="13.5" width="18" height="6" rx="2" />
      <circle cx="6.75" cy="7.5" r="1.25" />
      <circle cx="6.75" cy="16.5" r="1.25" />
      <path d="M15.5 7.5h2.5M15.5 16.5h2.5" />
    </Base>
  );
}

/** Dot-and-line connection mark — updates travelling between people. */
export function GlyphSync(props: GlyphProps) {
  return (
    <Base {...props}>
      <circle cx="5" cy="7" r="2" />
      <circle cx="19" cy="17" r="2" />
      <circle cx="5" cy="17" r="2" />
      <path d="M7 7h6.5a2 2 0 0 1 2 2v6" />
      <path d="M7 17h9" />
    </Base>
  );
}

/** A card with a thread attached to it. */
export function GlyphThread(props: GlyphProps) {
  return (
    <Base {...props}>
      <rect x="3" y="3.75" width="12" height="9.5" rx="2" />
      <path d="M6 7h6M6 10h3.5" />
      <path d="M9.5 20.25v-2.5h-.75a2 2 0 0 1 0 0h9.25a2 2 0 0 0 2-2v-3.5a2 2 0 0 0-2-2h-6.5" />
    </Base>
  );
}

/** Workspace mark — an outer frame holding smaller members. */
export function GlyphWorkspace(props: GlyphProps) {
  return (
    <Base {...props}>
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <circle cx="9" cy="9.5" r="1.75" />
      <path d="M7 15.5c.4-1.2 1.2-1.8 2.4-1.8M13.5 9.5h4M13.5 14.5h4" />
    </Base>
  );
}

/** Long right arrow used in CTAs. */
export function GlyphArrow({ className, ...props }: GlyphProps) {
  return (
    <Base className={className} {...props}>
      <path d="M4 12h15M14 7l5 5-5 5" />
    </Base>
  );
}

/** Bare tick, no circle. */
export function GlyphTick(props: GlyphProps) {
  return (
    <Base {...props}>
      <path d="M5 12.5 9.5 17 19 7.5" />
    </Base>
  );
}

export function GlyphMenu(props: GlyphProps) {
  return (
    <Base {...props}>
      <path d="M4 8h16M4 16h16" />
    </Base>
  );
}

export function GlyphClose(props: GlyphProps) {
  return (
    <Base {...props}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Base>
  );
}

/** Priority mark: ascending bars, count encodes level. */
export function GlyphPriority({ level, ...props }: GlyphProps & { level: 1 | 2 | 3 }) {
  return (
    <Base {...props}>
      <path d="M5 16.5v-3" />
      {level > 1 && <path d="M12 16.5v-6.5" />}
      {level > 2 && <path d="M19 16.5v-10" />}
      {level < 2 && <path d="M12 16.5v0M19 16.5v0" strokeOpacity="0.35" />}
      {level === 2 && <path d="M19 16.5v0" strokeOpacity="0.35" />}
    </Base>
  );
}

/** Consistent container for every glyph on the page. */
export function IconTile({
  children,
  className,
  size = "md",
}: {
  children: React.ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-xl border border-accent/15 bg-accent-soft/70 text-accent",
        size === "md" ? "size-11 p-[11px]" : "size-9 p-2.5",
        className,
      )}
    >
      {children}
    </span>
  );
}
