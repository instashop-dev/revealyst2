import { DEFAULT_SETTINGS, STORAGE_KEYS, type Settings } from "../shared/types.js";

/**
 * chrome.storage.local wrapper with typed defaults. Falls back to in-memory
 * defaults when the API is unavailable (tests, stripped contexts) so the
 * sidebar still renders.
 */

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
