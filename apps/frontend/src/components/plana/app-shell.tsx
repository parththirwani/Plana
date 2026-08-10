import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Bell,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  LayoutGrid,
  LogOut,
  Mail,
  Settings,
  Users,
  UserRound,
  Check,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { usePlana } from "@/lib/plana-store";
import { useAuthStore } from "@/lib/auth-store";
import { GhostButton, Icon, IconBox, RoleBadge, UserAvatar } from "./ui-kit";

function OrgMark({ name, size = 28, src }: { name: string; size?: number; src?: string | null }) {
  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center rounded-lg object-cover"
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="inline-flex items-center justify-center rounded-lg bg-primary-soft font-semibold text-primary"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

export { OrgMark };

function NotificationsBell() {
  const notifications = usePlana((s) => s.notifications);
  const markRead = usePlana((s) => s.markNotificationsRead);
  const realtimeStatus = usePlana((s) => s.realtimeStatus);
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((v) => !v);
          if (!open) markRead();
        }}
        className="relative rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}
      >
        <Icon icon={Bell} />
        {realtimeStatus === "disconnected" && (
          <span
            className="absolute -top-0.5 -left-0.5 h-2 w-2 animate-pulse rounded-full bg-destructive"
            aria-label="Realtime disconnected retrying"
            title="Realtime disconnected retrying"
          />
        )}
        {realtimeStatus === "connecting" && (
          <span
            className="absolute -top-0.5 -left-0.5 h-2 w-2 animate-pulse rounded-full bg-amber-400"
            aria-label="Realtime connecting"
            title="Realtime connecting"
          />
        )}
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="fade-up absolute right-0 z-30 mt-1 w-80 rounded-xl border border-border bg-popover p-1 shadow-panel">
          <p className="label-eyebrow px-2 pt-1.5 pb-1">Notifications</p>
          {realtimeStatus === "disconnected" && (
            <p className="px-2 pb-1 text-xs text-destructive">Realtime disconnected retrying…</p>
          )}
          {notifications.length === 0 ? (
            <p className="px-2 pb-2 text-sm text-muted-foreground">
              No notifications yet. Activity on boards you're viewing shows up here.
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {notifications.slice(0, 50).map((n) => (
                <div key={n.id} className="rounded-lg px-2 py-1.5">
                  <p className={cn("text-sm", n.read ? "text-muted-foreground" : "font-medium")}>
                    {n.text}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(n.at, { addSuffix: true })}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { NotificationsBell };

export function AppShell({
  orgId,
  title,
  breadcrumb,
  action,
  children,
  fullHeight,
}: {
  orgId?: string;
  title: string;
  breadcrumb?: string[];
  action?: ReactNode;
  children: ReactNode;
  fullHeight?: boolean;
}) {
  const orgs = usePlana((s) => s.orgs);
  const loadOrgs = usePlana((s) => s.loadOrgs);
  const invitations = usePlana((s) => s.invitations);
  const loadInvitations = usePlana((s) => s.loadInvitations);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const didInit = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [orgMenu, setOrgMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const org = orgs.find((o) => o.id === orgId);
  const myOrgs = orgs;
  const settingsPath = org ? `/app/org/${org.id}/settings` : null;
  const activeTab =
    settingsPath && location.pathname === settingsPath
      ? typeof (location.search as { tab?: unknown }).tab === "string"
        ? (location.search as { tab: string }).tab
        : "General"
      : null;

  useEffect(() => {
    if (!didInit.current) {
      didInit.current = true;
      void loadOrgs();
      void loadInvitations();
    }
  }, [loadOrgs, loadInvitations]);

  if (!user) return null;

  const handleLogout = async () => {
    await logout();
    navigate({ to: "/login" });
  };

  const nav = [
    {
      label: "Boards",
      icon: LayoutGrid,
      to: org ? `/app/org/${org.id}` : "/app",
      search: undefined,
      active: org ? location.pathname === `/app/org/${org.id}` : location.pathname === "/app",
    },
    {
      label: "Members",
      icon: Users,
      to: settingsPath ?? "/app",
      search: settingsPath ? ({ tab: "Members" } as const) : undefined,
      active: activeTab === "Members",
    },
    {
      label: "Settings",
      icon: Settings,
      to: settingsPath ?? "/app",
      search: settingsPath ? ({ tab: "General" } as const) : undefined,
      active: activeTab !== null && activeTab !== "Members",
    },
  ] as const;

  const navItems = [
    {
      label: "Invitations",
      icon: Mail,
      to: "/app/invitations",
      search: undefined,
      active: location.pathname === "/app/invitations",
    },
    ...(org
      ? nav
      : [
          {
            label: "Organizations",
            icon: LayoutGrid,
            to: "/app",
            search: undefined,
            active: location.pathname === "/app",
          },
        ]),
  ] as const;

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          "sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        <div
          className={cn("flex items-center gap-2 py-4", collapsed ? "justify-center px-0" : "px-4")}
        >
          {collapsed ? (
            <button
              onClick={() => setCollapsed(false)}
              className="group rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Expand sidebar"
              title="Expand sidebar"
            >
              <img
                src="/logo.png"
                alt="Plana"
                width={230}
                height={256}
                decoding="async"
                className="h-4 w-4 object-contain group-hover:hidden"
              />
              <Icon icon={ChevronsRight} className="hidden group-hover:block" />
            </button>
          ) : (
            <>
              <Link to="/app" className="flex items-center gap-2">
                <img
                  src="/logo.png"
                  alt="Plana"
                  width={230}
                  height={256}
                  decoding="async"
                  className="h-4 w-4 object-contain"
                />
                <span className="text-sm font-semibold tracking-tight">Plana</span>
              </Link>
              <button
                onClick={() => setCollapsed(true)}
                className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Collapse sidebar"
              >
                <Icon icon={ChevronsLeft} />
              </button>
            </>
          )}
        </div>

        {org && (
          <div className="relative px-3">
            <button
              onClick={() => setOrgMenu((v) => !v)}
              className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface p-2 text-left transition-colors hover:bg-muted"
            >
              <OrgMark name={org.name} size={24} src={org.orgImage} />
              {!collapsed && (
                <>
                  <span className="truncate text-sm font-medium">{org.name}</span>
                  <Icon icon={ChevronDown} className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </>
              )}
            </button>
            {orgMenu && (
              <div className="fade-up absolute top-full left-3 z-30 mt-1 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-panel">
                {myOrgs.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => {
                      setOrgMenu(false);
                      navigate({ to: "/app/org/$orgId", params: { orgId: o.id } });
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <OrgMark name={o.name} size={20} src={o.orgImage} />
                    <span className="truncate">{o.name}</span>
                    {o.id === org.id && (
                      <Icon icon={Check} className="ml-auto h-3.5 w-3.5 text-primary" />
                    )}
                  </button>
                ))}
                <Link
                  to="/app"
                  onClick={() => setOrgMenu(false)}
                  className="mt-1 block border-t border-border px-2 pt-2 pb-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  All organizations
                </Link>
              </div>
            )}
          </div>
        )}

        <nav className="mt-4 flex flex-col gap-1 px-3">
          {!collapsed && <p className="label-eyebrow px-2 pb-1">Workspace</p>}
          {navItems.map((item) => (
            <Link
              key={item.label}
              to={item.to}
              {...(item.search ? { search: item.search } : {})}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted hover:text-foreground",
                item.active ? "bg-primary-soft text-primary" : "text-muted-foreground",
              )}
            >
              <IconBox icon={item.icon} size="sm" />
              {!collapsed && <span className="truncate">{item.label}</span>}
              {!collapsed && item.label === "Invitations" && invitations.length > 0 && (
                <span className="ml-auto rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {invitations.length}
                </span>
              )}
            </Link>
          ))}
        </nav>

        <div className="relative mt-auto border-t border-border p-3">
          <button
            onClick={() => setUserMenu((v) => !v)}
            className="flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors hover:bg-muted"
          >
            <UserAvatar user={user} size={28} ring />
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {user.name ?? user.email}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {orgId ? (org?.role ?? "Guest") : user.email}
                </span>
              </span>
            )}
          </button>
          {userMenu && (
            <div className="fade-up absolute bottom-full left-3 z-30 mb-1 w-52 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-panel">
              <Link
                to="/app/profile"
                onClick={() => setUserMenu(false)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted"
              >
                <Icon icon={UserRound} /> Profile
              </Link>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Icon icon={LogOut} /> Log out
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-border bg-background/85 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            {breadcrumb && breadcrumb.length > 0 && (
              <p className="truncate text-xs text-muted-foreground">{breadcrumb.join(" / ")}</p>
            )}
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <NotificationsBell />
            {action}
          </div>
        </header>
        <main className={cn("min-w-0 flex-1", fullHeight ? "overflow-hidden" : "px-6 py-6")}>
          {children}
        </main>
      </div>
    </div>
  );
}

export { GhostButton };
