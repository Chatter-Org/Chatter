// The shared core keeps a copy of this folder's media contract (types.ts) for
// its VoiceEngine; types.ts itself stays put because the desktop app copies it
// by path. These assignments fail to compile if the two drift apart.
import type * as Canonical from "./types";
import type * as Core from "@chatter/core/voice/media";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>() => undefined as unknown as T;

export const contractInSync = [
  check<Same<Canonical.VoiceMediaBackend, Core.VoiceMediaBackend>>(),
  check<Same<Canonical.VoicePeer, Core.VoicePeer>>(),
  check<Same<Canonical.LocalMic, Core.LocalMic>>(),
  check<Same<Canonical.MicOptions, Core.MicOptions>>(),
] as const;
