/**
 * What Chatter sounds like.
 *
 * Every effect the app plays goes through here, for two reasons. A room can
 * ship its own pack, so the URL for an event is not a constant any more — it
 * depends on which room you are in. And a listener can turn the whole lot down
 * or off, which only works if there is one place that honours the setting.
 *
 * Sounds are best-effort throughout. A browser that has not been interacted
 * with yet refuses to play audio at all, and that must never surface as an
 * error: the sound is the garnish, not the event.
 */

import {
  BUILT_IN,
  EVENT_GAIN,
  clampVolume,
  loadSoundSettings,
  takeDeferredArrivalSound,
  resolveSound,
  type SoundEvent,
  type SoundPack,
} from "@chatter/core/soundRules";

export * from "@chatter/core/soundRules";

// ─── The reversed leave sound ────────────────────────────────────────────────

/** Decoded once and reused: reversing a buffer per leave would be audible. */
let reversedJoinBuffer: AudioBuffer | null = null;
let reversingInFlight = false;

async function getReversedJoinBuffer(): Promise<AudioBuffer | null> {
  if (reversedJoinBuffer) return reversedJoinBuffer;
  if (reversingInFlight) return null;
  reversingInFlight = true;
  try {
    const ctx = new AudioContext();
    const response = await fetch(BUILT_IN["voice-join"]!);
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      buffer.getChannelData(c).reverse();
    }
    reversedJoinBuffer = buffer;
    await ctx.close();
    return reversedJoinBuffer;
  } catch {
    // Let a later leave try again.
    reversingInFlight = false;
    return null;
  }
}

// ─── Pre-decoded effects ─────────────────────────────────────────────────────
// A stream start has to land with the stream, and `new Audio(url)` fetches and
// decodes on every play — a noticeable beat late on a cold cache. So the file
// is decoded once, up front, and played from memory on one long-lived context.

let sharedCtx: AudioContext | null = null;
const decoded = new Map<string, AudioBuffer>();
const decoding = new Map<string, Promise<AudioBuffer | null>>();

function audioContext(): AudioContext {
  if (!sharedCtx) sharedCtx = new AudioContext();
  return sharedCtx;
}

function decodeSound(url: string): Promise<AudioBuffer | null> {
  const ready = decoded.get(url);
  if (ready) return Promise.resolve(ready);
  let pending = decoding.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((response) => response.arrayBuffer())
      // Decoded offline: a live context made at page load, before any click,
      // only starts suspended and warns. The buffer plays on any context.
      .then((data) => new OfflineAudioContext(2, 1, 48000).decodeAudioData(data))
      .then((buffer) => {
        decoded.set(url, buffer);
        return buffer;
      })
      .catch(() => null)
      .finally(() => decoding.delete(url));
    decoding.set(url, pending);
  }
  return pending;
}

async function playDecoded(url: string, volume: number) {
  const buffer = await decodeSound(url);
  if (!buffer) return;
  try {
    const ctx = audioContext();
    // Suspended until the page has been interacted with; anyone in a call has.
    if (ctx.state === "suspended") void ctx.resume();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
  } catch {
    // Autoplay policy, or no audio device.
  }
}

/** Events played from a decoded buffer rather than an `<audio>` element. */
const PRE_DECODED: ReadonlySet<SoundEvent> = new Set(["stream-start"]);

/** Warm what a first sound would otherwise wait on: the reversed join, and
 *  the built-in files of the pre-decoded events. */
export function prewarmSounds() {
  void getReversedJoinBuffer();
  for (const event of PRE_DECODED) {
    const url = BUILT_IN[event];
    if (url) void decodeSound(url);
  }
}

async function playReversedJoin(volume: number) {
  const buffer = await getReversedJoinBuffer();
  if (!buffer) return;
  try {
    const ctx = new AudioContext();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    source.onended = () => void ctx.close();
  } catch {
    // Autoplay policy, or no audio device.
  }
}

/** Play whatever was held, once. A second call after it is nothing. */
export function playDeferredArrivalSound() {
  const sound = takeDeferredArrivalSound();
  if (sound) playSoundUrl(sound.url, sound.gain);
}

// ─── Playback ────────────────────────────────────────────────────────────────

/** Play an arbitrary sound file, honouring the listener's settings. */
export function playSoundUrl(url: string, gain = 1) {
  if (!url) return;
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;
  try {
    const audio = new Audio(url);
    audio.volume = clampVolume(settings.volume * gain);
    void audio.play().catch(() => {});
  } catch {
    // Nothing to recover: a sound that will not play is not an error.
  }
}

/**
 * Play one of the app's effects, using the room's pack where it has one.
 *
 * `pack` is the room's overrides — pass `roomInfo.sounds`. Omitting it plays
 * the built-in sound, which is right for anything not scoped to a room.
 */
export function playSound(event: SoundEvent, pack?: SoundPack) {
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;

  const gain = EVENT_GAIN[event];
  const url = resolveSound(event, pack);
  if (url === null) {
    void playReversedJoin(clampVolume(settings.volume * gain));
    return;
  }
  if (PRE_DECODED.has(event)) {
    // A room's replacement is decoded on its first play and instant after.
    void playDecoded(url, clampVolume(settings.volume * gain));
    return;
  }
  playSoundUrl(url, gain);
}
