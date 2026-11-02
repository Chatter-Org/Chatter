/**
 * Voice messages: a recording from the composer, uploaded as an ordinary file
 * and posted as its link, the same as any other attachment.
 *
 * What makes one a voice message rather than an audio file somebody attached
 * is only its name, so nothing on the server or in the message format had to
 * change. Older clients see an audio attachment and play it as one.
 */

/** The file name every recording is uploaded under, before its extension. The
 *  upload's random folder keeps them apart. */
export const VOICE_MESSAGE_BASENAME = "voice-message";

/** The longest recording the composer takes before it stops on its own. */
export const VOICE_MESSAGE_MAX_SECONDS = 5 * 60;

const VOICE_MESSAGE_URL = /\/voice-message\.(weba|oga|m4a)(\?.*)?$/i;

export function isVoiceMessageUrl(url: string): boolean {
  return VOICE_MESSAGE_URL.test(url);
}

/**
 * The recording format to ask `MediaRecorder` for, and the extension to save it
 * under — the first this browser can record.
 *
 * The extensions are the audio-only ones (`weba`, `oga`) on purpose: `.webm`
 * and `.ogg` are drawn as videos. Opus first, because it is the smallest for
 * speech; Safari records only MP4 (AAC). `null` when nothing is supported.
 */
export function voiceRecordingFormat(
  isTypeSupported: (mime: string) => boolean,
): { mimeType: string; extension: string } | null {
  const candidates = [
    { mimeType: "audio/webm;codecs=opus", extension: "weba" },
    { mimeType: "audio/ogg;codecs=opus", extension: "oga" },
    { mimeType: "audio/mp4", extension: "m4a" },
  ];
  return candidates.find((c) => isTypeSupported(c.mimeType)) ?? null;
}

/**
 * Reduce decoded samples to `bars` heights between 0 and 1 for the waveform.
 *
 * Each bar is the loudest sample in its slice, scaled so the loudest bar is
 * full height — a quiet recording is still readable. A floor keeps silence
 * visible as a line rather than a gap.
 */
export function waveformPeaks(samples: ArrayLike<number>, bars: number): number[] {
  const out = new Array<number>(bars).fill(0);
  if (samples.length === 0 || bars <= 0) return out;
  const per = samples.length / bars;
  for (let bar = 0; bar < bars; bar++) {
    const start = Math.floor(bar * per);
    const end = Math.max(start + 1, Math.floor((bar + 1) * per));
    let peak = 0;
    for (let i = start; i < end && i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[bar] = peak;
  }
  const max = Math.max(...out);
  const floor = 0.06;
  return out.map((v) => (max > 0 ? floor + (1 - floor) * (v / max) : floor));
}

/** `m:ss` for a length in seconds. */
export function formatVoiceTime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
