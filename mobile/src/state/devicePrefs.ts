import { useSyncExternalStore } from "react";

/**
 * Settings that belong to this phone rather than the account — how much it
 * plays and fetches on its own. Remembered in local storage, read anywhere
 * through `useDevicePrefs`.
 */
export interface DevicePrefs {
  /** Animated pictures and emoji move by themselves; off, they hold their
   *  first frame until opened. */
  autoplayAnimated: boolean;
  /** Fetch a card for an ordinary link in a message (title, picture). */
  linkPreviews: boolean;
  /** Buzz to confirm a gesture (swipe to reply, holding a message). */
  haptics: boolean;
}

const KEY = "chatter_device_prefs";
const DEFAULTS: DevicePrefs = { autoplayAnimated: true, linkPreviews: true, haptics: true };

function read(): DevicePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

let current = read();
const listeners = new Set<() => void>();

export function getDevicePrefs(): DevicePrefs {
  return current;
}

export function updateDevicePrefs(patch: Partial<DevicePrefs>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Holds for this run.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDevicePrefs(): DevicePrefs {
  return useSyncExternalStore(subscribe, getDevicePrefs);
}
