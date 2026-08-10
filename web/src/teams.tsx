import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api/client.js";
import { useAuth } from "./auth/session.js";
import type { Team } from "./api/types.js";

/**
 * Loads the signed-in user's teams once on mount (and on demand via
 * `refresh`) so the nav guard, route guard and pages share one source of
 * truth for team membership/roles.
 */
interface TeamsState {
  teams: Team[];
  loading: boolean;
  refresh: () => void;
}

const TeamsContext = createContext<TeamsState | undefined>(undefined);

export function TeamsProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  // Start "loading" when a session exists (true on mount/login) so the team
  // route guard never redirects before the membership list has arrived.
  const [loading, setLoading] = useState<boolean>(() => Boolean(session));
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!session) {
      setTeams([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .myTeams(session.token)
      .then((res) => {
        if (!cancelled) setTeams(res.teams);
      })
      .catch(() => {
        if (!cancelled) setTeams([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, reloadKey]);

  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const value = useMemo(() => ({ teams, loading, refresh }), [teams, loading, refresh]);
  return <TeamsContext.Provider value={value}>{children}</TeamsContext.Provider>;
}

export function useTeams(): TeamsState {
  const ctx = useContext(TeamsContext);
  if (!ctx) throw new Error("useTeams must be used within TeamsProvider");
  return ctx;
}
