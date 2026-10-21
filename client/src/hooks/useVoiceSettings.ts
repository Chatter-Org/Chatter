// The settings store moved to the shared core; this adds the React hook and
// the browser's cross-tab sync.
import { useSyncExternalStore } from "react";
import {
  DEFAULT_VOICE_SETTINGS,
  getVoiceSettings,
  reloadVoiceSettings,
  subscribeVoiceSettings,
  updateVoiceSettings,
} from "@chatter/core/voice/settings";

export * from "@chatter/core/voice/settings";

const STORAGE_KEY = "chatter_voice_settings";

// Another tab changing them is the same person changing them.
function onStorage(e: StorageEvent): void {
  if (e.key === STORAGE_KEY) reloadVoiceSettings();
}

let tabs = 0;
function subscribe(listener: () => void): () => void {
  const unsubscribe = subscribeVoiceSettings(listener);
  if (tabs++ === 0) window.addEventListener("storage", onStorage);
  return () => {
    unsubscribe();
    if (--tabs === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useVoiceSettings() {
  const settings = useSyncExternalStore(subscribe, getVoiceSettings, () => DEFAULT_VOICE_SETTINGS);
  return { settings, updateSettings: updateVoiceSettings };
}
