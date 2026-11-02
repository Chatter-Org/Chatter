import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getVoiceSettings } from "@chatter/core/voice/settings";
import {
  VOICE_MESSAGE_BASENAME,
  VOICE_MESSAGE_MAX_SECONDS,
  voiceRecordingFormat,
} from "@chatter/core/voiceMessage";

/** Open the mic the voice settings name, as a call would, falling back to the
 *  default one when that device is gone. */
async function openMic(): Promise<MediaStream> {
  const s = getVoiceSettings();
  const constraints = (deviceId: string): MediaStreamConstraints => ({
    audio: {
      deviceId: deviceId !== "default" ? { exact: deviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppressionMode !== "none",
      autoGainControl: s.autoGainControl,
    },
    video: false,
  });
  try {
    return await navigator.mediaDevices.getUserMedia(constraints(s.inputDeviceId));
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (s.inputDeviceId === "default" || (name !== "OverconstrainedError" && name !== "NotFoundError")) throw err;
    return navigator.mediaDevices.getUserMedia(constraints("default"));
  }
}

export interface VoiceRecorder {
  recording: boolean;
  /** Seconds recorded so far. */
  elapsed: number;
  /** Recent input loudness, 0–1, newest last — the bar's live meter. */
  levels: number[];
  start: () => Promise<void>;
  /** Stop and hand back the recording as a file ready to upload. */
  finish: () => Promise<File | null>;
  cancel: () => void;
}

const LEVEL_HISTORY = 32;

/**
 * Records one voice message from the mic. Stops on its own at
 * `VOICE_MESSAGE_MAX_SECONDS`, calling `onLimit` with the finished file.
 */
export function useVoiceRecorder(onLimit?: (file: File) => void): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const session = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ctx: AudioContext | null;
    chunks: Blob[];
    extension: string;
    mimeType: string;
    timer: number;
    startedAt: number;
  } | null>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;

  // Takes the session out of the ref first, so a second finish or cancel —
  // the time limit landing as Send is pressed — finds nothing to do.
  const take = useCallback(() => {
    const s = session.current;
    if (!s) return null;
    session.current = null;
    clearInterval(s.timer);
    return s;
  }, []);

  const release = useCallback((s: NonNullable<typeof session.current>) => {
    s.stream.getTracks().forEach((t) => t.stop());
    s.ctx?.close().catch(() => {});
    setRecording(false);
    setElapsed(0);
    setLevels([]);
  }, []);

  const finish = useCallback(async (): Promise<File | null> => {
    const s = take();
    if (!s) return null;
    if (s.recorder.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => {
        s.recorder.addEventListener("stop", () => resolve(), { once: true });
      });
      s.recorder.stop();
      await stopped;
    }
    release(s);
    const blob = new Blob(s.chunks, { type: s.mimeType.split(";")[0] });
    if (blob.size === 0) return null;
    return new File([blob], `${VOICE_MESSAGE_BASENAME}.${s.extension}`, { type: blob.type });
  }, [take, release]);

  const cancel = useCallback(() => {
    const s = take();
    if (!s) return;
    if (s.recorder.state !== "inactive") s.recorder.stop();
    release(s);
  }, [take, release]);

  const start = useCallback(async () => {
    if (session.current || starting.current) return;
    const format =
      typeof MediaRecorder === "undefined" ? null : voiceRecordingFormat((m) => MediaRecorder.isTypeSupported(m));
    if (!format || !navigator.mediaDevices?.getUserMedia) {
      toast.error("This browser can't record voice messages");
      return;
    }
    let stream: MediaStream;
    starting.current = true;
    try {
      stream = await openMic();
    } catch (err) {
      const name = (err as DOMException)?.name;
      toast.error(
        name === "NotAllowedError"
          ? "Microphone access was denied"
          : "Couldn't open the microphone",
      );
      return;
    } finally {
      starting.current = false;
    }
    // Gone while the permission prompt was up.
    if (!mounted.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const recorder = new MediaRecorder(stream, { mimeType: format.mimeType, audioBitsPerSecond: 48000 });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    });

    // A level meter, so it is obvious the mic is picking something up.
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
    } catch {
      ctx = null;
      analyser = null;
    }
    const samples = new Float32Array(analyser?.fftSize ?? 0);

    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const secs = (performance.now() - startedAt) / 1000;
      setElapsed(secs);
      if (analyser) {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const v of samples) peak = Math.max(peak, Math.abs(v));
        setLevels((prev) => [...prev.slice(-(LEVEL_HISTORY - 1)), Math.min(1, peak * 1.6)]);
      }
      if (secs >= VOICE_MESSAGE_MAX_SECONDS) {
        void finish().then((file) => {
          if (file) onLimitRef.current?.(file);
        });
      }
    }, 100);

    session.current = { recorder, stream, ctx, chunks, timer, startedAt, ...format };
    // Sliced every second so a long recording is not one buffer held until
    // the end.
    recorder.start(1000);
    setRecording(true);
  }, [finish]);

  // Leaving the composer mid-recording drops it and lets go of the mic.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancel();
    };
  }, [cancel]);

  return { recording, elapsed, levels, start, finish, cancel };
}
