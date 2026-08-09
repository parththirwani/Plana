import { create } from "zustand";
import {
  logout as logoutRequest,
  me,
  signin as signinRequest,
  signup as signupRequest,
} from "./api";
import type { User } from "./plana-types";

export type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated";

type AuthState = {
  user: User | null;
  status: AuthStatus;
  init: () => Promise<void>;
  signin: (email: string, password: string) => Promise<User>;
  signup: (email: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  clear: () => void;
};

export const useAuthStore = create<AuthState>()((set) => ({
  user: null,
  status: "idle",

  init: async () => {
    if (typeof window === "undefined") return;
    set({ status: "loading" });
    try {
      const { user } = await me();
      set({ user, status: "authenticated" });
    } catch {
      set({ user: null, status: "unauthenticated" });
    }
  },

  signin: async (email, password) => {
    const { user } = await signinRequest(email, password);
    set({ user, status: "authenticated" });
    return user;
  },

  signup: async (email, password) => {
    const { user } = await signupRequest(email, password);
    set({ user, status: "authenticated" });
    return user;
  },

  logout: async () => {
    try {
      await logoutRequest();
    } finally {
      set({ user: null, status: "unauthenticated" });
    }
  },

  clear: () => set({ user: null, status: "unauthenticated" }),
}));
