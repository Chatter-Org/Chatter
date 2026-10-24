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
import { getVoiceSettings, subscribeVoiceSettings } from "@chatter/core/voice/settings";

export * from "@chatter/core/soundRules";

// ─── The effects context ─────────────────────────────────────────────────────
// Effects used to be a fresh `new Audio(url)` per play, and the leave sound a
// fresh AudioContext per play. Both were late — a fetch and decode, or a
// context spinning up, between the event and the noise — and both were quietly
// dropped whenever the browser had not been clicked recently enough for its
// liking. So: one context for every effect, made on the first click and kept
// running, playing buffers that were decoded before they were needed.

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

let effectsCtx: (AudioContext & SinkCapable) | null = null;

function outputSinkId(): string {
  const id = getVoiceSettings().outputDeviceId;
  // "" is the system default for AudioContext.setSinkId.
  return id === "default" ? "" : id;
}

/** Effects go where the call goes. On the system default while the call was
 *  on a headset, every effect "never played" for the person wearing it. */
function applySink() {
  if (!effectsCtx?.setSinkId) return;
  effectsCtx.setSinkId(outputSinkId()).catch(() => {});
}

function getEffectsCtx(): (AudioContext & SinkCapable) | null {
  if (effectsCtx && effectsCtx.state !== "closed") return effectsCtx;
  try {
    effectsCtx = new AudioContext({ latencyHint: "interactive" });
  } catch {
    return null;
  }
  applySink();
  return effectsCtx;
}

/**
 * Bring the context back if it has stopped, the same as the voice engine does
 * for its own: it starts suspended without a gesture, and a browser suspends
 * it again (iOS on a call or the lock screen, some others on a device change).
 */
function resumeEffects() {
  const ctx = effectsCtx;
  if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
  void ctx.resume().catch(() => {});
}

if (typeof window !== "undefined") {
  // A context made inside a click is allowed to run; one made later by a
  // socket message only is if the page was clicked first. Making it here
  // means the first effect never has to start it.
  const onGesture = () => {
    getEffectsCtx();
    resumeEffects();
  };
  window.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
  window.addEventListener("keydown", onGesture, { capture: true, passive: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumeEffects();
  });
  subscribeVoiceSettings(applySink);
}

/** Wait briefly for the context to run. A source started on a suspended
 *  context does not fail — it waits, and goes off whenever the context next
 *  resumes, a stale noise at a random moment. Better none at all. */
async function runningCtx(): Promise<AudioContext | null> {
  const ctx = getEffectsCtx();
  if (!ctx) return null;
  if (ctx.state === "running") return ctx;
  try {
    await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 250))]);
  } catch {
    // Refused: no gesture yet.
  }
  return (ctx.state as AudioContextState) === "running" ? ctx : null;
}

function startBuffer(ctx: AudioContext, buffer: AudioBuffer, volume: number) {
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(ctx.destination);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
  source.start();
}

// ─── Decoded buffers ─────────────────────────────────────────────────────────

/** Enough for the built-ins, a few rooms' packs and the stings of the people
 *  you share calls with. Least recently played goes first. */
const MAX_DECODED = 64;
const decoded = new Map<string, AudioBuffer>();
const decoding = new Map<string, Promise<AudioBuffer | null>>();

function cachedBuffer(key: string): AudioBuffer | undefined {
  const buffer = decoded.get(key);
  if (buffer) {
    decoded.delete(key);
    decoded.set(key, buffer);
  }
  return buffer;
}

function remember(key: string, buffer: AudioBuffer) {
  decoded.set(key, buffer);
  while (decoded.size > MAX_DECODED) {
    decoded.delete(decoded.keys().next().value!);
  }
}

function decodeSound(url: string): Promise<AudioBuffer | null> {
  const ready = cachedBuffer(url);
  if (ready) return Promise.resolve(ready);
  let pending = decoding.get(url);
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.arrayBuffer();
      // Decoded offline: a live context made at page load, before any click,
      // only starts suspended and warns. The buffer plays on any context.
      const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(data);
      remember(url, buffer);
      return buffer;
    } catch {
      // Not there, not audio, or no Web Audio at all. A later play tries again.
      return null;
    } finally {
      decoding.delete(url);
    }
  })();
  decoding.set(url, pending);
  return pending;
}

/** The built-in leave sound: the join sound backwards, derived once. */
async function reversedJoinBuffer(): Promise<AudioBuffer | null> {
  const url = BUILT_IN["voice-join"]!;
  const key = `${url}#reversed`;
  const ready = cachedBuffer(key);
  if (ready) return ready;
  const join = await decodeSound(url);
  if (!join) return null;
  try {
    // A copy: the forward buffer is the join sound, still in use.
    const reversed = new AudioBuffer({
      numberOfChannels: join.numberOfChannels,
      length: join.length,
      sampleRate: join.sampleRate,
    });
    for (let c = 0; c < join.numberOfChannels; c++) {
      reversed.copyToChannel(join.getChannelData(c).slice().reverse(), c);
    }
    remember(key, reversed);
    return reversed;
  } catch {
    return null;
  }
}

/**
 * Decode these now, so their first play is as quick as any other. With no
 * list, the built-in effects; core passes the rooms' packs as they load.
 */
export function prewarmSounds(urls?: string[]) {
  if (!urls) {
    void reversedJoinBuffer();
    urls = Object.values(BUILT_IN).filter((u): u is string => !!u);
  }
  for (const url of new Set(urls.map((u) => u.trim()).filter(Boolean))) {
    void decodeSound(url);
  }
}

// ─── Playback ────────────────────────────────────────────────────────────────

/** The fallback for a sound not decoded yet: an element streams it rather
 *  than waiting for the whole file, so it is no later than it ever was. */
function playElement(url: string, volume: number) {
  try {
    const audio = new Audio(url) as HTMLAudioElement & SinkCapable;
    audio.volume = volume;
    const sink = outputSinkId();
    const routed = sink && audio.setSinkId ? audio.setSinkId(sink).catch(() => {}) : Promise.resolve();
    void routed.then(() => audio.play()).catch(() => {});
  } catch {
    // Nothing to recover: a sound that will not play is not an error.
  }
}

async function playBuffer(buffer: AudioBuffer, volume: number): Promise<boolean> {
  const ctx = await runningCtx();
  if (!ctx) return false;
  try {
    startBuffer(ctx, buffer, volume);
    return true;
  } catch {
    return false;
  }
}

async function playDecodedOrElement(url: string, volume: number) {
  const buffer = cachedBuffer(url);
  if (buffer && (await playBuffer(buffer, volume))) return;
  // Not decoded yet, or Web Audio would not run: play it the old way now, and
  // have the buffer ready for next time.
  playElement(url, volume);
  if (!buffer) void decodeSound(url);
}

async function playReversedJoin(volume: number) {
  const asked = performance.now();
  const buffer = await reversedJoinBuffer();
  // A leave heard a second after the person left is not about them any more.
  if (!buffer || performance.now() - asked > 1000) return;
  await playBuffer(buffer, volume);
}

/** Play whatever was held, once. A second call after it is nothing. */
export function playDeferredArrivalSound() {
  const sound = takeDeferredArrivalSound();
  if (sound) playSoundUrl(sound.url, sound.gain);
}

/** Play an arbitrary sound file, honouring the listener's settings. */
export function playSoundUrl(url: string, gain = 1) {
  if (!url) return;
  const settings = loadSoundSettings();
  if (!settings.enabled || settings.volume === 0) return;
  void playDecodedOrElement(url, clampVolume(settings.volume * gain));
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
  playSoundUrl(url, gain);
}
