/**
 * Voice and audio settings: one copy for the whole app, remembered in Web
 * Storage. Shared by the web client and the mobile app; each wraps
 * `subscribeVoiceSettings` in its own hook.
 */

/** "rnnoise" is the desktop app's ML noise suppression (native voice only). */
export type NoiseSuppressionMode = "none" | "browser" | "rnnoise";

export interface VoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppressionMode: NoiseSuppressionMode;
  autoGainControl: boolean;
  inputGainDb: number;
  inputVolume: number;
  outputVolume: number;
  inputMode: "open" | "ptt";
}

const STORAGE_KEY = "chatter_voice_settings";

const DEFAULT_SETTINGS: VoiceSettings = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  echoCancellation: true,
  noiseSuppressionMode: "browser",
  autoGainControl: true,
  inputGainDb: 0,
  inputVolume: 100,
  outputVolume: 100,
  inputMode: "open",
};

function read(): VoiceSettings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

// One copy for the whole page. Each hook used to keep its own, so a change in
// the settings dialog never reached the call already running: the device,
// volumes and gain were saved and then ignored until the next page load.
let current: VoiceSettings = typeof localStorage === "undefined" ? DEFAULT_SETTINGS : read();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

/** Subscribe to changes; returns the unsubscribe. */
export function subscribeVoiceSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the stored settings again — another tab (or window) changed them. */
export function reloadVoiceSettings(): void {
  current = read();
  emit();
}

export const DEFAULT_VOICE_SETTINGS = DEFAULT_SETTINGS;

export function getVoiceSettings(): VoiceSettings {
  return current;
}

export function updateVoiceSettings(updates: Partial<VoiceSettings>): void {
  current = { ...current, ...updates };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Still applies for this page; only remembering it is lost.
  }
  emit();
}

/** Linear gain to apply to the mic: input volume, plus manual gain when AGC is off. */
export function micGain(settings: VoiceSettings): number {
  const manual = settings.autoGainControl ? 1 : Math.pow(10, settings.inputGainDb / 20);
  return (settings.inputVolume / 100) * manual;
}
