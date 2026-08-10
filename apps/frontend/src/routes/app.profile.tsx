import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { AppShell } from "@/components/plana/app-shell";
import {
  Field,
  GhostButton,
  Icon,
  PrimaryButton,
  Surface,
  UserAvatar,
  inputClass,
} from "@/components/plana/ui-kit";
import { FileUpload, readImageDataUrl } from "@/components/plana/file-upload";
import { useAuthStore } from "@/lib/auth-store";
import { Authed } from "@/lib/auth-guard";
import { ApiError, updateProfile } from "@/lib/api";

export const Route = createFileRoute("/app/profile")({
  head: () => ({
    meta: [
      { title: "Plana" },
      { name: "description", content: "Update your name and avatar in Plana." },
      { property: "og:title", content: "Your profile · Plana" },
      { property: "og:description", content: "Update your name and avatar in Plana." },
    ],
  }),
  component: () => (
    <Authed>
      <Profile />
    </Authed>
  ),
});

function Profile() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [name, setName] = useState(user?.name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user?.avatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const { user: updated } = await updateProfile({
        name: name.trim(),
        avatarUrl: avatarUrl.trim(),
      });
      useAuthStore.setState({ user: { ...user, ...updated } });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: "/login" });
  };

  return (
    <AppShell title="Profile" breadcrumb={["Account"]}>
      <div className="mx-auto max-w-lg">
        <Surface className="p-6">
          <div className="flex flex-col items-center">
            <UserAvatar user={{ id: user.id, name, email: user.email, avatarUrl }} size={72} ring />
          </div>

          <div className="mt-6 space-y-4">
            <Field label="Name">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setSaved(false);
                }}
              />
            </Field>
            <Field label="Avatar">
              <FileUpload
                onChange={(files) => {
                  const file = files[0];
                  if (!file) return;
                  readImageDataUrl(file)
                    .then((url) => {
                      setAvatarUrl(url);
                      setSaved(false);
                    })
                    .catch((e) =>
                      setError(e instanceof Error ? e.message : "Couldn't read that image."),
                    );
                }}
              />
              {avatarUrl && (
                <GhostButton type="button" className="h-8" onClick={() => setAvatarUrl("")}>
                  Remove avatar
                </GhostButton>
              )}
            </Field>
            <Field label="Email">
              <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                {user.email}
              </p>
            </Field>
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <PrimaryButton className="w-full" onClick={save} disabled={saving}>
              {saved ? "Saved" : "Save changes"}
            </PrimaryButton>
          </div>
        </Surface>

        <div className="mt-6 flex justify-center">
          <GhostButton onClick={handleLogout}>
            <Icon icon={LogOut} /> Log out
          </GhostButton>
        </div>
      </div>
    </AppShell>
  );
}
