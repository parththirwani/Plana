import { createFileRoute } from "@tanstack/react-router";
import { AuthPage } from "@/components/auth/AuthPage";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [{ title: "Sign in — Plana" }, { name: "description", content: "Sign in to Plana." }],
  }),
  component: LoginPage,
});

function LoginPage() {
  return <AuthPage mode="login" />;
}
