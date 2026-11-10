import { useCallback, useEffect, useRef, useState } from "react";
import { clipEncoderApis, startClipEncoder } from "@/lib/clip/engine";
import { clipRecorderSupported, startClipRecorder } from "@/lib/clip/recorder";
import type { ClipEngine, ClipEngineEvents } from "@/lib/clip/types";

/**
 * A rolling buffer of the last N seconds of a screen share, kept encoded.
 *
 * Two engines can keep it. `lib/clip/engine.ts` runs one H.264 encoder in a
 * worker — in hardware where there is any — and cuts clips on keyframes, so a
 * clip is within two seconds of the length asked for and the cost to a machine
 * that is also running a game is a fraction of a core. It needs WebCodecs. Where
 * that is missing (Firefox, Safari, an insecure page, a browser with no H.264
 * encoder) `lib/clip/recorder.ts` does it with two staggered MediaRecorders,
 * which work everywhere and cost several times as much.
 *
 * It stays off until asked for: even the cheap engine encodes for as long as
 * it is armed.
 */

/** Whether this browser can record a share at all, by either engine. */
export function clipBufferSupported(): boolean {
  return clipEncoderApis() || clipRecorderSupported();
}

export interface ClipBuffer {
  /** A recorder is genuinely running — not merely requested. */
  armed: boolean;
  /** Roughly how much footage is available right now. */
  bufferedSecs: number;
  /** Why arming failed, when it did. */
  error: string | null;
  /** What it is recording as, for a tooltip: "1080p60 · hardware". */
  detail: string | null;
  takeClip: () => Promise<{ blob: Blob; seconds: number } | null>;
}

export function useClipBuffer(
  stream: MediaStream | null,
  enabled: boolean,
  lengthSecs: number,
): ClipBuffer {
  const engineRef = useRef<ClipEngine | null>(null);
  const [armed, setArmed] = useState(false);
  const [bufferedSecs, setBufferedSecs] = useState(0);
  const [startError, setStartError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // A fixed property of the browser, so it is derived rather than tracked.
  const supported = clipBufferSupported();
  const error = supported ? startError : "This browser cannot record video";

  useEffect(() => {
    if (!enabled || !stream || !supported) return;

    let cancelled = false;
    const events: ClipEngineEvents = {
      onArmed: setArmed,
      onBuffered: setBufferedSecs,
      onError: setStartError,
      onDetail: setDetail,
    };

    const fallBack = () => {
      if (cancelled) return;
      if (!clipRecorderSupported()) {
        setStartError("This browser cannot record video");
        return;
      }
      engineRef.current = startClipRecorder(stream, lengthSecs, events);
    };

    void startClipEncoder(stream, lengthSecs, events, (reason) => {
      // It gave up part-way: carry on the slow way rather than not at all.
      console.warn("[clip] falling back to MediaRecorder:", reason);
      engineRef.current = null;
      setArmed(false);
      setBufferedSecs(0);
      fallBack();
    }).then((engine) => {
      if (cancelled) {
        engine?.stop();
      } else if (engine) {
        engineRef.current = engine;
      } else {
        fallBack();
      }
    });

    return () => {
      cancelled = true;
      engineRef.current?.stop();
      engineRef.current = null;
      setArmed(false);
      setBufferedSecs(0);
      setDetail(null);
    };
  }, [stream, enabled, lengthSecs, supported]);

  const takeClip = useCallback(async () => engineRef.current?.take() ?? null, []);

  return { armed, bufferedSecs, error, detail, takeClip };
}
