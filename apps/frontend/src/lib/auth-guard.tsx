import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { useAuthStore } from "./auth-store";

export function useAuthGuard() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const init = useAuthStore((s) => s.init);
  const navigate = useNavigate();

  useEffect(() => {
    if (status === "idle") void init();
  }, [status, init]);

  useEffect(() => {
    if (status === "unauthenticated") navigate({ to: "/login" });
  }, [status, navigate]);

  return status === "authenticated" && user !== null;
}

export function Authed({ children }: { children: ReactNode }) {
  const ready = useAuthGuard();
  if (!ready) return null;
  return <>{children}</>;
}
