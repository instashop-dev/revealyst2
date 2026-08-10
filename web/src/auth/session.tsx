import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "../api/client.js";
import type { Session, User } from "../api/types.js";

const SESSION_KEY = "revealyst:session";
const IMPERSONATION_KEY = "revealyst:impersonation";

interface AuthState {
  /** The active session — the impersonated one while impersonating. */
  session: Session | null;
  user: User | null;
  loading: boolean;
  /** True while the app creator is acting as another user. */
  impersonating: boolean;
  login(token: string): Promise<void>;
  /** App creator only: switch into a session as the given user. */
  impersonate(session: Session): void;
  /** Return from impersonation to the app creator's own session. */
  exitImpersonation(): void;
  logout(): void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function readJson(key: string): Session | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
}

/**
 * Impersonation rides on top of the real session: the app creator's session
 * stays in `revealyst:session` while an impersonated session lives in
 * `revealyst:impersonation`. Exiting impersonation (or an expired
 * impersonated token) drops the impersonation and falls back to the creator's
 * own session — no magic-link re-login needed.
 */
function readSessions(): { real: Session | null; impersonation: Session | null } {
  const real = readJson(SESSION_KEY);
  const impersonation = readJson(IMPERSONATION_KEY);
  if (impersonation && !real) {
    // Orphaned impersonation without the underlying admin session — discard.
    localStorage.removeItem(IMPERSONATION_KEY);
    return { real, impersonation: null };
  }
  return { real, impersonation };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [{ real, impersonation }, setStored] = useState(() => readSessions());
  const [loading, setLoading] = useState(false);

  const active = impersonation ?? real;
  const sessionToken = active?.token;

  // Revalidate the active token on change; when an impersonated token dies,
  // fall back to the real session instead of logging out.
  useEffect(() => {
    if (!sessionToken) return;
    setLoading(true);
    api
      .me(sessionToken)
      .then((user) =>
        setStored((s) => {
          // Write the resolved profile only into the slot that still holds
          // the token we validated — exiting impersonation mid-flight must
          // not splice the impersonated profile into the real session.
          if (s.impersonation?.token === sessionToken) {
            return { ...s, impersonation: { ...s.impersonation, user } };
          }
          if (s.real?.token === sessionToken) {
            return { ...s, real: { ...s.real, user } };
          }
          return s;
        }),
      )
      .catch(() => {
        // Expired/invalid token: drop only the slot that owned the dead
        // token. A dead impersonated token falls back to the real session —
        // its SESSION_KEY must survive so the admin isn't logged out on the
        // next reload. A dead real session logs out entirely.
        setStored((s) => {
          if (s.impersonation?.token === sessionToken) {
            localStorage.removeItem(IMPERSONATION_KEY);
            return { real: s.real, impersonation: null };
          }
          if (s.real?.token === sessionToken) {
            localStorage.removeItem(IMPERSONATION_KEY);
            localStorage.removeItem(SESSION_KEY);
            return { real: null, impersonation: null };
          }
          return s;
        });
      })
      .finally(() => setLoading(false));
  }, [sessionToken]);

  const login = useCallback(async (token: string) => {
    const next = await api.verifyMagicToken(token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    localStorage.removeItem(IMPERSONATION_KEY);
    setStored({ real: next, impersonation: null });
  }, []);

  const impersonate = useCallback((session: Session) => {
    localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(session));
    setStored((s) => ({ real: s.real, impersonation: session }));
  }, []);

  const exitImpersonation = useCallback(() => {
    localStorage.removeItem(IMPERSONATION_KEY);
    setStored((s) => ({ real: s.real, impersonation: null }));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(IMPERSONATION_KEY);
    setStored({ real: null, impersonation: null });
  }, []);

  const value = useMemo(
    () => ({
      session: active,
      user: active?.user ?? null,
      loading,
      impersonating: impersonation !== null,
      login,
      impersonate,
      exitImpersonation,
      logout,
    }),
    [active, loading, impersonation, login, impersonate, exitImpersonation, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
