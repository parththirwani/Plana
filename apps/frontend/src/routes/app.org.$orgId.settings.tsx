import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Mail, Settings2, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell, OrgMark } from "@/components/plana/app-shell";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  EmptyState,
  Field,
  GhostButton,
  Icon,
  PrimaryButton,
  RoleBadge,
  SecondaryButton,
  Surface,
  UserAvatar,
  inputClass,
} from "@/components/plana/ui-kit";
import { FileUpload, readImageDataUrl } from "@/components/plana/file-upload";
import { roleFor, usePlana } from "@/lib/plana-store";
import { useAuthStore } from "@/lib/auth-store";
import type { Role } from "@/lib/plana-types";
import { Authed } from "@/lib/auth-guard";
import { ApiError } from "@/lib/api";

const TABS = ["General", "Members", "Danger zone"] as const;
type Tab = (typeof TABS)[number];

const settingsSearch = (search: unknown): { tab: Tab } => {
  const s = search as { tab?: unknown };
  const tab: Tab = s?.tab === "Members" || s?.tab === "Danger zone" ? s.tab : "General";
  return { tab };
};

export const Route = createFileRoute("/app/org/$orgId/settings")({
  validateSearch: settingsSearch,
  head: () => ({
    meta: [
      { title: "Plana" },
      { name: "description", content: "Manage the workspace profile, members and roles." },
      { property: "og:title", content: "Organization settings · Plana" },
      {
        property: "og:description",
        content: "Manage the workspace profile, members and roles in Plana.",
      },
    ],
  }),
  component: () => (
    <Authed>
      <OrgSettings />
    </Authed>
  ),
});
const ROLES: Role[] = ["MEMBER", "MODERATOR", "ADMIN"];

const msg = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

function OrgSettings() {
  const { orgId } = Route.useParams();
  const orgs = usePlana((s) => s.orgs);
  const members = usePlana((s) => s.members);
  const loadMembers = usePlana((s) => s.loadMembers);
  const updateOrg = usePlana((s) => s.updateOrg);
  const setMemberRole = usePlana((s) => s.changeMemberRole);
  const removeMember = usePlana((s) => s.removeMember);
  const inviteMember = usePlana((s) => s.inviteMember);
  const leaveOrg = usePlana((s) => s.leaveOrg);
  const deleteOrg = usePlana((s) => s.deleteOrg);
  const currentUser = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const search = Route.useSearch();
  const org = orgs.find((o) => o.id === orgId);
  const role = roleFor(orgs, orgId);
  const tab = search.tab;

  const setTab = (t: Tab) =>
    navigate({
      to: "/app/org/$orgId/settings",
      params: { orgId },
      search: { tab: t },
      replace: true,
    });
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [orgImage, setOrgImage] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    title: string;
    description?: string;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  useEffect(() => {
    void loadMembers(orgId);
  }, [orgId, loadMembers]);

  useEffect(() => {
    if (org) {
      setName(org.name);
      setDescription(org.description ?? "");
      setOrgImage(org.orgImage ?? "");
    }
  }, [org]);

  if (!org || !role) {
    return (
      <AppShell title="Settings">
        <EmptyState
          icon={Settings2}
          title="This workspace isn't available"
          body="It may have been deleted, or you no longer have access to it."
        />
      </AppShell>
    );
  }

  const isAdmin = role === "ADMIN";
  const dirty =
    name !== org.name ||
    description !== (org.description ?? "") ||
    orgImage !== (org.orgImage ?? "");

  const saveGeneral = async () => {
    setError(null);
    try {
      await updateOrg(org.id, {
        name: name.trim(),
        description: description.trim(),
        orgImage: orgImage.trim(),
      });
      setSent(true);
      window.setTimeout(() => setSent(false), 2000);
    } catch (e) {
      setError(msg(e));
    }
  };

  const sendInvite = async () => {
    if (!email.includes("@")) return;
    setError(null);
    try {
      await inviteMember(org.id, email.trim());
      setEmail("");
      setSent(true);
      window.setTimeout(() => setSent(false), 2000);
    } catch (e) {
      setError(msg(e));
    }
  };

  const changeRole = async (userId: string, newRole: Role) => {
    setError(null);
    try {
      await setMemberRole(org.id, userId, newRole);
    } catch (e) {
      setError(msg(e));
    }
  };

  const remove = async (userId: string) => {
    setError(null);
    try {
      await removeMember(org.id, userId);
    } catch (e) {
      setError(msg(e));
    }
  };

  const leave = async () => {
    setError(null);
    try {
      await leaveOrg(org.id);
      navigate({ to: "/app" });
    } catch (e) {
      setError(msg(e));
    }
  };

  const removeOrg = async () => {
    setError(null);
    try {
      await deleteOrg(org.id);
      navigate({ to: "/app" });
    } catch (e) {
      setError(msg(e));
    }
  };

  return (
    <AppShell orgId={orgId} title="Settings" breadcrumb={[org.name, "Settings"]}>
      <div className="max-w-3xl">
        <div className="mb-6 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors duration-200 ${
                tab === t
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {error && (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {tab === "General" && (
          <Surface className="fade-up space-y-4 p-6">
            <div className="flex items-center gap-4">
              <OrgMark name={org.name} size={56} src={orgImage} />
            </div>
            {isAdmin ? (
              <>
                <Field label="Name">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label="Description">
                  <textarea
                    rows={3}
                    className={`${inputClass} h-auto py-2`}
                    value={description}
                    placeholder="What this organization does"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field label="Image">
                  <FileUpload
                    onChange={(files) => {
                      const file = files[0];
                      if (!file) return;
                      readImageDataUrl(file)
                        .then(setOrgImage)
                        .catch((e) => setError(msg(e)));
                    }}
                  />
                  {orgImage && (
                    <GhostButton type="button" className="h-8" onClick={() => setOrgImage("")}>
                      Remove image
                    </GhostButton>
                  )}
                </Field>
                <PrimaryButton disabled={!dirty} onClick={saveGeneral}>
                  {sent ? "Saved" : "Save changes"}
                </PrimaryButton>
              </>
            ) : (
              <div className="space-y-3">
                <div>
                  <p className="label-eyebrow">Name</p>
                  <p className="text-sm">{org.name}</p>
                </div>
                <div>
                  <p className="label-eyebrow">Description</p>
                  <p className="text-sm text-muted-foreground">
                    {org.description || "No description yet."}
                  </p>
                </div>
              </div>
            )}
          </Surface>
        )}

        {tab === "Members" && (
          <div className="fade-up space-y-4">
            {isAdmin && (
              <Surface className="p-4">
                <p className="label-eyebrow mb-2">Invite someone</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    className={`${inputClass} w-64`}
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <PrimaryButton onClick={sendInvite}>
                    <Icon icon={Mail} /> Send invite
                  </PrimaryButton>
                </div>
                {sent && <p className="fade-up mt-2 text-xs text-primary">Invite sent.</p>}
              </Surface>
            )}

            <Surface className="divide-y divide-border overflow-hidden p-0">
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-3 px-4 py-3">
                  <UserAvatar user={m.user} size={32} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{m.user.name ?? m.user.email}</p>
                      {!isAdmin && <RoleBadge role={m.role} />}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  {isAdmin && (
                    <div className="ml-auto flex items-center gap-2">
                      <select
                        className={`${inputClass} w-32`}
                        value={m.role}
                        onChange={(e) => void changeRole(m.userId, e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0) + r.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                      {m.userId !== currentUser?.id && (
                        <GhostButton
                          aria-label={`Remove ${m.user.name ?? m.user.email}`}
                          onClick={() =>
                            setConfirm({
                              title: "Remove this member?",
                              description: "They will lose access to this organization.",
                              confirmLabel: "Remove",
                              onConfirm: () => remove(m.userId),
                            })
                          }
                        >
                          <Icon icon={Trash2} />
                        </GhostButton>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {members.length === 0 && (
                <div className="p-6">
                  <EmptyState
                    icon={Users}
                    title="Nobody here yet"
                    body="Invite a teammate by email and they'll appear in this list."
                  />
                </div>
              )}
            </Surface>
          </div>
        )}

        {tab === "Danger zone" && (
          <div className="fade-up rounded-2xl border border-destructive/25 bg-destructive-soft/40 p-6">
            <p className="label-eyebrow">Danger zone</p>
            <div className="mt-3 flex items-center gap-4">
              <div>
                <p className="text-sm font-medium">Leave this organization</p>
                <p className="text-xs text-muted-foreground">
                  You'll lose access to its boards until someone invites you back.
                </p>
              </div>
              <SecondaryButton
                className="ml-auto"
                onClick={() =>
                  setConfirm({
                    title: "Leave this organization?",
                    description:
                      "You will lose access to its boards until someone invites you back.",
                    confirmLabel: "Leave",
                    onConfirm: () => leave(),
                  })
                }
              >
                Leave
              </SecondaryButton>
            </div>
            {isAdmin && (
              <div className="mt-5 flex items-center gap-4 border-t border-destructive/20 pt-5">
                <div>
                  <p className="text-sm font-medium">Delete organization</p>
                  <p className="text-xs text-muted-foreground">
                    Permanently removes every board and card inside it.
                  </p>
                </div>
                <SecondaryButton
                  className="ml-auto border-destructive/30 text-destructive hover:bg-destructive-soft"
                  onClick={() =>
                    setConfirm({
                      title: "Delete this organization?",
                      description: "This permanently removes every board and card.",
                      onConfirm: () => removeOrg(),
                    })
                  }
                >
                  Delete
                </SecondaryButton>
              </div>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.title ?? ""}
        description={confirm?.description}
        confirmLabel={confirm?.confirmLabel}
        onConfirm={() => {
          confirm?.onConfirm();
        }}
      />
    </AppShell>
  );
}
