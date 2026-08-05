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

interface AuthState {
  session: Session | null;
  user: User | null;
  loading: boolean;
  login(token: string): Promise<void>;
  logout(): void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function readSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    api
      .me(session.token)
      .then((user) => setSession((s) => (s ? { ...s, user } : s)))
      .catch(() => {
        // Token invalid/expired → drop the session (magic link flow restarts).
        localStorage.removeItem(SESSION_KEY);
        setSession(null);
      })
      .finally(() => setLoading(false));
  }, [session?.token]);

  const login = useCallback(async (token: string) => {
    const next = await api.verifyMagicToken(token);
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    setSession(next);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, user: session?.user ?? null, loading, login, logout }),
    [session, loading, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
