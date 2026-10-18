/**
 * Which sound an event makes, shared by every client.
 *
 * Playback differs per platform (Web Audio in the browser, native audio on a
 * phone) and stays with each app; what a room's pack or a member's entrance
 * sting resolves to does not, so it lives here.
 */

/** The effects a room's pack can replace. Keep in sync with PACK_EVENTS in backend/sounds.rs. */
export type SoundEvent = "mention" | "voice-join" | "voice-leave" | "mute" | "unmute";

/** A room's overrides: event name -> `/external/...` URL. */
export type SoundPack = Partial<Record<SoundEvent, string>>;

/**
 * What plays when a room has said nothing.
 *
 * `voice-leave` has no file of its own: the built-in leave sound is the join
 * sound played backwards, which is why it is derived at runtime rather than
 * shipped. A pack that overrides it is played normally.
 */
export const BUILT_IN: Record<SoundEvent, string | null> = {
  mention: "/external/vc-join.wav",
  "voice-join": "/external/vc-join.wav",
  "voice-leave": null,
  mute: "/external/mute.wav",
  unmute: "/external/unmute.wav",
};

/**
 * Per-event loudness, relative to the listener's master volume.
 *
 * Mute and unmute fire on your own keypress and can fire many times a minute,
 * so they have always been mixed well below the others. That is a property of
 * the sound rather than of any one call site, so it lives here — and it
 * applies to a room's replacement too, or a pack could undo it.
 */
export const EVENT_GAIN: Record<SoundEvent, number> = {
  mention: 1,
  "voice-join": 1,
  "voice-leave": 1,
  mute: 0.3,
  unmute: 0.3,
};

/** The longest a chosen sound may run. Mirrors MAX_SOUND_SECS in
 *  backend/sounds.rs, which is the authority — this is only for the hint
 *  shown next to the picker. */
export const MAX_SOUND_SECS = 5;

/**
 * What an arrival in a voice channel sounds like: the member's own entrance
 * sting where they have one, otherwise the room's join sound.
 *
 * A room's pack replaces the *generic* join sound — the one that plays for
 * someone with nothing of their own. It is not a way for a room to decide what
 * one of its members sounds like, so a pack never displaces a sting, and never
 * plays alongside one: an arrival makes a single noise.
 *
 * A room that wants no stings at all switches them off, and the server then
 * sends none — this is never handed one to weigh against a pack.
 */
export function arrivalSound(
  entranceSting: string | undefined | null,
  pack?: SoundPack,
): { url: string; gain: number } | null {
  const sting = entranceSting?.trim();
  if (sting) return { url: sting, gain: 1 };
  const url = resolveSound("voice-join", pack);
  return url === null ? null : { url, gain: EVENT_GAIN["voice-join"] };
}

export function resolveSound(event: SoundEvent, pack?: SoundPack): string | null {
  const override = pack?.[event]?.trim();
  if (override) return override;
  return BUILT_IN[event];
}

// ─── The listener's settings ─────────────────────────────────────────────────
// Kept on the device, as on the web (the same key), and honoured by whichever
// platform plays the sound.

const SETTINGS_KEY = "chatter_sound_settings";

export interface SoundSettings {
  /** Master switch for every effect, including entrance stings. */
  enabled: boolean;
  /** 0–1, applied to every sound this module plays. */
  volume: number;
}

export const DEFAULT_SOUND_SETTINGS: SoundSettings = { enabled: true, volume: 0.7 };

export function loadSoundSettings(): SoundSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SOUND_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SoundSettings>;
    return {
      enabled: parsed.enabled ?? DEFAULT_SOUND_SETTINGS.enabled,
      // Clamp rather than trust: a stored value out of range would either be
      // silent or painfully loud, and neither is recoverable from in the UI.
      volume: clampVolume(parsed.volume ?? DEFAULT_SOUND_SETTINGS.volume),
    };
  } catch {
    return DEFAULT_SOUND_SETTINGS;
  }
}

export function saveSoundSettings(settings: SoundSettings) {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...settings, volume: clampVolume(settings.volume) }),
    );
  } catch {
    // Storage blocked: the setting holds for this session only.
  }
}

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_SOUND_SETTINGS.volume;
  return Math.min(1, Math.max(0, volume));
}

/**
 * An arrival sound waiting for the connection it announces.
 *
 * Your own sting is triggered by the server registering the join, which happens
 * before any audio is negotiated — so it played into a call you could not yet
 * hear or be heard in, and finished before anyone arrived. Held here instead,
 * and released when the voice publisher actually connects.
 *
 * Module state beside the store, like `screenStreamsMap`: nothing renders from
 * it, and a re-render must not replay a sound.
 */
let pendingArrival: { url: string; gain: number } | null = null;

/** Hold an arrival sound until the connection it announces is up. */
export function deferArrivalSound(sound: { url: string; gain: number } | null) {
  pendingArrival = sound;
}

/** Take whatever was held, once — for the platform to play. A second call
 *  after it is null. */
export function takeDeferredArrivalSound(): { url: string; gain: number } | null {
  const sound = pendingArrival;
  pendingArrival = null;
  return sound;
}

/** Forget it — the call being announced is not happening. */
export function dropDeferredArrivalSound() {
  pendingArrival = null;
}
