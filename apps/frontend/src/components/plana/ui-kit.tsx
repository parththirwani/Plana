import type { LucideIcon } from "lucide-react";
import { CalendarDays } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Priority, Role, User } from "@/lib/plana-types";
import { priorityColor } from "@/lib/plana-types";

/* ---------- Icons ---------- */

export function Icon({ icon: I, className }: { icon: LucideIcon; className?: string }) {
  return <I strokeWidth={1.6} className={cn("h-4 w-4", className)} aria-hidden />;
}

export function IconBox({
  icon,
  active,
  size = "md",
  className,
}: {
  icon: LucideIcon;
  active?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "h-6 w-6 rounded-md",
    md: "h-8 w-8 rounded-lg",
    lg: "h-12 w-12 rounded-xl",
  };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center border transition-colors duration-200",
        sizes[size],
        active
          ? "border-primary/30 bg-primary-soft text-primary"
          : "border-border bg-surface text-muted-foreground",
        className,
      )}
    >
      <Icon icon={icon} className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
    </span>
  );
}

/* ---------- Buttons ---------- */

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";

export function PrimaryButton({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        base,
        "h-9 bg-primary px-3.5 text-primary-foreground shadow-soft hover:brightness-110 active:scale-[0.98]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        base,
        "h-9 border border-border bg-surface px-3.5 text-foreground hover:bg-muted active:scale-[0.98]",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        base,
        "h-9 px-3 text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Surfaces ---------- */

export function Surface({
  className,
  children,
  hover,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      {...props}
      className={cn(
        "rounded-2xl border border-border bg-surface shadow-soft",
        hover && "card-hover cursor-pointer",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DashedTile({
  label,
  onClick,
  icon,
  className,
}: {
  label: string;
  onClick: () => void;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex min-h-[8.5rem] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-transparent text-sm text-muted-foreground transition-all duration-200 hover:border-primary/40 hover:bg-primary-soft/50 hover:text-primary",
        className,
      )}
    >
      <IconBox icon={icon} />
      {label}
    </button>
  );
}

/* ---------- Avatars ---------- */

const palette = [
  "bg-[oklch(0.93_0.03_285)] text-[oklch(0.4_0.14_285)]",
  "bg-[oklch(0.93_0.03_200)] text-[oklch(0.4_0.12_200)]",
  "bg-[oklch(0.93_0.03_140)] text-[oklch(0.4_0.12_140)]",
  "bg-[oklch(0.93_0.03_60)] text-[oklch(0.42_0.12_60)]",
  "bg-[oklch(0.93_0.03_20)] text-[oklch(0.45_0.14_20)]",
];

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function UserAvatar({
  user,
  size = 28,
  ring,
  className,
}: {
  user: Pick<User, "id" | "name" | "email" | "avatarUrl">;
  size?: number;
  ring?: boolean;
  className?: string;
}) {
  const idx = user.id.charCodeAt(user.id.length - 1) % palette.length;
  const displayName = user.name ?? user.email;
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={displayName}
        title={displayName}
        style={{ width: size, height: size }}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full object-cover select-none",
          ring && "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
          className,
        )}
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.36) }}
      title={displayName}
      className={cn(
        "inline-flex items-center justify-center rounded-full font-semibold select-none",
        palette[idx],
        ring && "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
        className,
      )}
    >
      {initials(displayName)}
    </span>
  );
}

export function AvatarStack({
  users,
  size = 24,
  max = 4,
}: {
  users: Pick<User, "id" | "name" | "email" | "avatarUrl">[];
  size?: number;
  max?: number;
}) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <div className="flex items-center">
      {shown.map((u, i) => (
        <UserAvatar
          key={u.id}
          user={u}
          size={size}
          className={cn("border border-surface", i > 0 && "-ml-2")}
        />
      ))}
      {rest > 0 && (
        <span
          style={{ width: size, height: size, fontSize: size * 0.36 }}
          className="-ml-2 inline-flex items-center justify-center rounded-full border border-surface bg-muted font-medium text-muted-foreground"
        >
          +{rest}
        </span>
      )}
    </div>
  );
}

/* ---------- Badges ---------- */

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        role === "ADMIN"
          ? "border-primary/25 bg-primary-soft text-primary"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {role}
    </span>
  );
}

export function PriorityTag({ priority }: { priority: Priority }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("h-2 w-2 rounded-full", priorityColor[priority])} />
      {priority}
    </span>
  );
}

export function DueDate({ date }: { date: string }) {
  const overdue = new Date(date) < new Date(new Date().toDateString());
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        overdue ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon icon={CalendarDays} className="h-3.5 w-3.5" />
      {new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
    </span>
  );
}

/* ---------- Misc ---------- */

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="label-eyebrow">{children}</p>;
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="fade-up flex flex-col items-center justify-center rounded-2xl border border-dashed border-border px-6 py-14 text-center">
      <IconBox icon={icon} size="lg" active />
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="label-eyebrow">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "h-9 w-full rounded-lg border border-border bg-surface px-3 text-sm outline-none transition-colors duration-200 placeholder:text-muted-foreground focus:border-primary/40 focus:ring-2 focus:ring-ring/25";

export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}
