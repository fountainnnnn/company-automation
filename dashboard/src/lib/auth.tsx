import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import type { Profile } from "./types";

interface AuthState {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function loadProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,full_name,role")
    .eq("id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as Profile;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  /** Which user the loaded profile belongs to, so we fetch once per identity. */
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    let active = true;

    /**
     * Fetch a profile at most once per user. Supabase re-fires auth events on
     * token refresh and on tab focus with the *same* user; refetching then meant
     * a new profile object every time, which churned the context value for every
     * consumer — and because loadProfile returns null on any transient failure,
     * one blip blanked `isAdmin` and the sidebar dropped its admin section.
     * A failure leaves the previous profile in place and allows a later retry.
     */
    async function syncProfile(userId: string) {
      if (loadedFor.current === userId) return;
      loadedFor.current = userId;
      const p = await loadProfile(userId);
      if (!active) return;
      if (p) setProfile(p);
      else loadedFor.current = null;
    }

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) await syncProfile(data.session.user.id);
      if (active) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!active) return;
      setSession(next);
      if (!next) {
        loadedFor.current = null;
        setProfile(null);
        return;
      }
      void syncProfile(next.user.id);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      profile,
      loading,
      isAdmin: profile?.role === "admin",
      signIn: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      },
      signOut: async () => {
        await supabase.auth.signOut();
      },
    }),
    [session, profile, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
