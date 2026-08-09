import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, completeOnboarding } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { FileUpload, readImageDataUrl } from "@/components/plana/file-upload";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/onboarding")({
  head: () => ({
    meta: [
      { title: "Set up your profile — Plana" },
      { name: "description", content: "Tell us your name to finish setting up Plana." },
    ],
  }),
  component: Onboarding,
});

function Onboarding() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const init = useAuthStore((s) => s.init);

  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === "idle") void init();
  }, [status, init]);

  useEffect(() => {
    if (status === "unauthenticated") navigate({ to: "/login" });
    else if (status === "authenticated" && user?.onboardingCompleted) navigate({ to: "/app" });
  }, [status, user, navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (name.trim().length < 3) {
      setError("Name must be at least 3 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const { user: updated } = await completeOnboarding(
        name.trim(),
        avatarUrl.trim() || undefined,
      );
      useAuthStore.setState({
        user: { ...user!, ...updated, onboardingCompleted: true },
      });
      navigate({ to: "/app" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <Card>
          <CardHeader>
            <CardTitle>Set up your profile</CardTitle>
            <CardDescription>One last step — what should your team call you?</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  autoFocus
                  autoComplete="name"
                  placeholder="Ada Okafor"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Avatar (optional)</Label>
                <FileUpload
                  onChange={(files) => {
                    const file = files[0];
                    if (!file) return;
                    readImageDataUrl(file)
                      .then(setAvatarUrl)
                      .catch((e) =>
                        setError(e instanceof Error ? e.message : "Couldn't read that image."),
                      );
                  }}
                />
                {avatarUrl && (
                  <button
                    type="button"
                    onClick={() => setAvatarUrl("")}
                    className="w-full text-center text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Remove avatar
                  </button>
                )}
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Saving…" : "Finish setup"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
