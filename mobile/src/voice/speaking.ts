import { useSyncExternalStore } from "react";

/**
 * Who is talking. Others come from the server's `voice_speaking` frames — it
 * already measures every publisher to fill the slots, so it knows about people
 * outside them too — and this device from its own microphone, so the ring
 * answers at once instead of after a round trip. (The web's
 * useSpeakingDetection, without the window events.)
 */

let remote = new Set<string>();

/** Fed every socket frame by the provider. */
export function noteSpeakingFrame(frame: { type?: string; speaking?: unknown }): void {
  if (frame.type === "voice_speaking" && Array.isArray(frame.speaking)) remote = new Set(frame.speaking as string[]);
}

export function clearSpeaking(): void {
  remote = new Set();
}

const POLL_MS = 150;

const NOBODY = new Set<string>();
let lastSample = NOBODY;

/**
 * The talking set now. It stays the same Set until someone starts or stops,
 * which is what lets useSyncExternalStore skip a render on every quiet poll.
 */
function sampleSpeaking(me: string | null, localSpeaking: () => boolean): Set<string> {
  const next = new Set(remote);
  if (me) {
    if (localSpeaking()) next.add(me);
    else next.delete(me);
  }
  const same = next.size === lastSample.size && [...next].every((id) => lastSample.has(id));
  if (!same) lastSample = next;
  return lastSample;
}

function pollSpeaking(onChange: () => void): () => void {
  const id = setInterval(onChange, POLL_MS);
  return () => clearInterval(id);
}

const pollNothing = () => () => {};

/** The talking set, sampled while `active` — only something on screen reads it. */
export function useSpeaking(active: boolean, me: string | null, localSpeaking: () => boolean): Set<string> {
  return useSyncExternalStore(active ? pollSpeaking : pollNothing, () =>
    active ? sampleSpeaking(me, localSpeaking) : NOBODY,
  );
}
