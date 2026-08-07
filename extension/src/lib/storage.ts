import {
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  type LocalHistoryEntry,
  type Settings,
} from "../shared/types.js";

/**
 * chrome.storage.local wrapper with typed defaults. Falls back to in-memory
 * defaults when the API is unavailable (tests, stripped contexts) so the
 * sidebar still renders.
 */

const MAX_LOCAL_HISTORY = 100;

function storageAvailable(): boolean {
  return typeof chrome !== "undefined" && !!chrome.storage?.local;
}

async function read<T>(key: string): Promise<T | undefined> {
  if (!storageAvailable()) return undefined;
  const stored = await chrome.storage.local.get(key);
  return (stored[key] as T | undefined) ?? undefined;
}

async function write(key: string, value: unknown): Promise<void> {
  if (!storageAvailable()) return;
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings(): Promise<Settings> {
  const stored = await read<Partial<Settings>>(STORAGE_KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await write(STORAGE_KEYS.settings, next);
  return next;
}

export async function isOnboarded(): Promise<boolean> {
  const onboarding = await read<{ completed?: boolean }>(STORAGE_KEYS.onboarding);
  return onboarding?.completed === true;
}

export async function completeOnboarding(): Promise<void> {
  await write(STORAGE_KEYS.onboarding, { completed: true });
}

/** Local prompt history (spec §5.1 / §5.4 snippet source — never synced). */
export async function getLocalHistory(): Promise<LocalHistoryEntry[]> {
  const history = await read<LocalHistoryEntry[]>(STORAGE_KEYS.history);
  return Array.isArray(history) ? history : [];
}

export async function appendLocalHistory(entry: LocalHistoryEntry): Promise<void> {
  const history = await getLocalHistory();
  // De-dupe consecutive identical prompts (typing/score refreshes).
  const last = history[0];
  if (last && last.prompt === entry.prompt && last.platform === entry.platform) {
    history[0] = { ...entry, createdAt: last.createdAt, rating: entry.rating ?? last.rating };
  } else {
    history.unshift(entry);
  }
  await write(STORAGE_KEYS.history, history.slice(0, MAX_LOCAL_HISTORY));
}

/** Record a thumbs rating against the most recent matching local entry. */
export async function rateLocalHistory(
  prompt: string,
  platform: string,
  rating: number,
): Promise<void> {
  const history = await getLocalHistory();
  const idx = history.findIndex(
    (h) => h.prompt === prompt && h.platform === platform && h.rating === null,
  );
  if (idx >= 0) {
    history[idx] = { ...history[idx]!, rating };
    await write(STORAGE_KEYS.history, history.slice(0, MAX_LOCAL_HISTORY));
  }
}

export async function clearLocalHistory(): Promise<void> {
  await write(STORAGE_KEYS.history, []);
}
