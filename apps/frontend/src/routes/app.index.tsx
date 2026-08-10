import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";
import { AppShell, OrgMark } from "@/components/plana/app-shell";
import {
  DashedTile,
  Field,
  Icon,
  PrimaryButton,
  RoleBadge,
  SecondaryButton,
  Surface,
  inputClass,
} from "@/components/plana/ui-kit";
import { usePlana } from "@/lib/plana-store";
import { useAuthStore } from "@/lib/auth-store";
import { Authed } from "@/lib/auth-guard";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Plana" },
      {
        name: "description",
        content: "Every Plana workspace you belong to, with your role at a glance.",
      },
      { property: "og:title", content: "Your organizations · Plana" },
      {
        property: "og:description",
        content: "Every Plana workspace you belong to, in one calm grid.",
      },
    ],
  }),
  component: () => (
    <Authed>
      <Home />
    </Authed>
  ),
});

function Home() {
  const orgs = usePlana((s) => s.orgs);
  const orgsLoading = usePlana((s) => s.orgsLoading);
  const error = usePlana((s) => s.error);
  const createOrg = usePlana((s) => s.createOrg);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setCreateError(null);
    try {
      const org = await createOrg({ name: name.trim() });
      setName("");
      setCreating(false);
      navigate({ to: "/app/org/$orgId", params: { orgId: org.id } });
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

  return (
    <AppShell
      title="Organizations"
      breadcrumb={[user?.name ?? user?.email ?? "Account"]}
      action={
        <PrimaryButton onClick={() => setCreating(true)}>
          <Icon icon={Plus} /> New organization
        </PrimaryButton>
      }
    >
      {creating && (
        <Surface className="fade-up mb-6 max-w-md p-4">
          <Field label="Organization name">
            <input
              autoFocus
              className={inputClass}
              value={name}
              placeholder="Northwind Studio"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {createError && (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {createError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <PrimaryButton onClick={create}>Create</PrimaryButton>
            <SecondaryButton onClick={() => setCreating(false)}>Cancel</SecondaryButton>
          </div>
        </Surface>
      )}

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      {orgsLoading && orgs.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {orgs.map((org) => (
            <Surface
              key={org.id}
              hover
              onClick={() => navigate({ to: "/app/org/$orgId", params: { orgId: org.id } })}
              className="flex min-h-[8.5rem] flex-col p-5"
            >
              <div className="flex items-start gap-3">
                <OrgMark name={org.name} size={40} src={org.orgImage} />
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold">{org.name}</h2>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                    {org.description || "No description yet."}
                  </p>
                </div>
              </div>
              <div className="mt-auto flex items-center pt-4">
                <span className="ml-auto">
                  <RoleBadge role={org.role} />
                </span>
              </div>
            </Surface>
          ))}
          <DashedTile icon={Plus} label="Create organization" onClick={() => setCreating(true)} />
        </div>
      )}

      {!orgsLoading && orgs.length === 0 && (
        <div className="mt-6">
          <Surface className="p-0">
            <div className="flex flex-col items-center px-6 py-14 text-center">
              <Icon icon={Building2} className="h-6 w-6 text-primary" />
              <h3 className="mt-3 text-base font-semibold">You're not in a workspace yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Create one for your team and invite people by email.
              </p>
            </div>
          </Surface>
        </div>
      )}
    </AppShell>
  );
}
