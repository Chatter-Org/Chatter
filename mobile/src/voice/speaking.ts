import { useEffect, useState } from "react";

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

/** The talking set, sampled while `active` — only something on screen reads it. */
export function useSpeaking(active: boolean, me: string | null, localSpeaking: () => boolean): Set<string> {
  const [speaking, setSpeaking] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!active) {
      setSpeaking(new Set());
      return;
    }
    const tick = () => {
      const next = new Set(remote);
      if (me) {
        if (localSpeaking()) next.add(me);
        else next.delete(me);
      }
      setSpeaking((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next));
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [active, me, localSpeaking]);
  return speaking;
}
