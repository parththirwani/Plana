import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Check, MailOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AppShell, OrgMark } from "@/components/plana/app-shell";
import {
  EmptyState,
  Icon,
  PrimaryButton,
  RoleBadge,
  SecondaryButton,
  Surface,
  timeAgo,
} from "@/components/plana/ui-kit";
import { usePlana } from "@/lib/plana-store";
import { Authed } from "@/lib/auth-guard";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/app/invitations")({
  head: () => ({
    meta: [
      { title: "Plana" },
      {
        name: "description",
        content: "Workspace invitations waiting for your decision.",
      },
      { property: "og:title", content: "Invitations · Plana" },
      {
        property: "og:description",
        content: "Accept or decline workspace invitations in Plana.",
      },
    ],
  }),
  component: () => (
    <Authed>
      <Invitations />
    </Authed>
  ),
});

const msg = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

function Invitations() {
  const invitations = usePlana((s) => s.invitations);
  const invitationsLoading = usePlana((s) => s.invitationsLoading);
  const loadInvitations = usePlana((s) => s.loadInvitations);
  const acceptInvitation = usePlana((s) => s.acceptInvitation);
  const declineInvitation = usePlana((s) => s.declineInvitation);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadInvitations();
  }, [loadInvitations]);

  const onAccept = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const org = await acceptInvitation(id);
      navigate({ to: "/app/org/$orgId", params: { orgId: org.id } });
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  const onDecline = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await declineInvitation(id);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell title="Invitations" breadcrumb={["Invitations"]}>
      {error && (
        <p className="mb-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {invitationsLoading && invitations.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : invitations.length === 0 ? (
        <EmptyState
          icon={MailOpen}
          title="No invitations"
          body="When an admin invites you to a workspace, it appears here for you to accept or decline."
        />
      ) : (
        <div className="max-w-2xl space-y-3">
          {invitations.map((inv) => (
            <Surface key={inv.id} className="fade-up flex items-center gap-4 p-4">
              <OrgMark name={inv.organizationName} size={40} src={inv.organizationImage} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold">{inv.organizationName}</p>
                  <RoleBadge role={inv.role} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Invited {timeAgo(inv.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <PrimaryButton disabled={busy === inv.id} onClick={() => void onAccept(inv.id)}>
                  <Icon icon={Check} /> Accept
                </PrimaryButton>
                <SecondaryButton disabled={busy === inv.id} onClick={() => void onDecline(inv.id)}>
                  <Icon icon={X} /> Decline
                </SecondaryButton>
              </div>
            </Surface>
          ))}
        </div>
      )}
    </AppShell>
  );
}
