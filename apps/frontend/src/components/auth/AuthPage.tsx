import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ApiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const isEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value);

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const isSignup = mode === "signup";
  const navigate = useNavigate();
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const init = useAuthStore((s) => s.init);
  const signin = useAuthStore((s) => s.signin);
  const signup = useAuthStore((s) => s.signup);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (status === "authenticated" && user) {
      navigate({ to: user.onboardingCompleted ? "/app" : "/onboarding" });
    }
  }, [status, user, navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!isEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < 5) {
      setError("Password must be at least 5 characters.");
      return;
    }

    setSubmitting(true);
    try {
      if (isSignup) {
        const u = await signup(email.trim(), password);
        navigate({ to: u.onboardingCompleted ? "/app" : "/onboarding" });
      } else {
        const u = await signin(email.trim(), password);
        navigate({ to: u.onboardingCompleted ? "/app" : "/onboarding" });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2">
          <img
            src="/logo.png"
            alt="Plana"
            width={230}
            height={256}
            decoding="async"
            className="size-8 object-contain"
          />
          <span className="text-base font-semibold tracking-tight">Plana</span>
        </Link>

        <Card>
          <CardHeader>
            <CardTitle>{isSignup ? "Create your account" : "Welcome back"}</CardTitle>
            <CardDescription>
              {isSignup
                ? "Start planning your team's work in minutes."
                : "Sign in to continue to your workspace."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  placeholder="At least 5 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
              </Button>
            </form>
          </CardContent>
          <CardFooter className="justify-center text-sm text-muted-foreground">
            {isSignup ? (
              <>
                Already have an account?{" "}
                <Link to="/login" className="ml-1 font-medium text-primary hover:underline">
                  Sign in
                </Link>
              </>
            ) : (
              <>
                New to Plana?{" "}
                <Link to="/signup" className="ml-1 font-medium text-primary hover:underline">
                  Create an account
                </Link>
              </>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
