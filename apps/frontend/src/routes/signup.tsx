import { createFileRoute } from "@tanstack/react-router";
import { AuthPage } from "@/components/auth/AuthPage";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Plana" },
      { name: "description", content: "Create your Plana account and start planning." },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  return <AuthPage mode="signup" />;
}
