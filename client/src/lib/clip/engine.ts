/**
 * The clip buffer, on the page's side: starts the worker (`worker.ts`), hands it
 * the share's picture and sound, and asks it for clips. All the work is the
 * worker's; this holds the tracks and the plumbing.
 *
 * Needs WebCodecs and `MediaStreamTrackProcessor` (Chromium, which includes the
 * desktop app), a secure context, and an H.264 encoder. Without them
 * `startClipEncoder` answers null and the caller records with MediaRecorder
 * instead (`recorder.ts`) — which works anywhere, at several times the cost.
 */
import { avcCodecStrings, CLIP_MAX_HEIGHT, CLIP_MAX_WIDTH } from "./profile";
import type {
  ClipEngine,
  ClipEngineEvents,
  ClipWorkerReply,
  ClipWorkerRequest,
  TakenClipData,
} from "./types";

interface TrackProcessorBox {
  MediaStreamTrackProcessor?: new (init: {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }) => { readable: ReadableStream };
}

/** If nothing has been recorded by now, something is wrong — say so rather than
 *  letting the user wait for footage that will never arrive. */
const FIRST_FRAME_TIMEOUT_MS = 6000;
/** How often to look again for a track that was not there, or not live, yet. */
const POLL_MS = 2000;
/** Muxing a long clip is quick; this is for a worker that has died. */
const TAKE_TIMEOUT_MS = 20_000;

/** The browser has the parts an encoder engine is made of. Cheap and
 *  synchronous, for deciding whether to show clip settings at all. */
export function clipEncoderApis(): boolean {
  const box = globalThis as unknown as TrackProcessorBox;
  return (
    typeof Worker !== "undefined" &&
    typeof VideoEncoder !== "undefined" &&
    typeof AudioEncoder !== "undefined" &&
    typeof VideoFrame !== "undefined" &&
    !!box.MediaStreamTrackProcessor
  );
}

let usable: Promise<boolean> | null = null;

/** Whether an H.264 encoder and an Opus one exist here, asked once. The worker
 *  looks again at the real picture; this only decides which engine to start. */
export function clipEncoderUsable(): Promise<boolean> {
  usable ??= (async () => {
    if (!clipEncoderApis()) return false;
    try {
      for (const codec of avcCodecStrings({
        width: CLIP_MAX_WIDTH,
        height: CLIP_MAX_HEIGHT,
        fps: 30,
        bitrate: 8_000_000,
      })) {
        const video = await VideoEncoder.isConfigSupported({
          codec,
          width: CLIP_MAX_WIDTH,
          height: CLIP_MAX_HEIGHT,
          bitrate: 8_000_000,
          framerate: 30,
          latencyMode: "realtime",
          avc: { format: "avc" },
        });
        if (!video.supported) continue;
        const sound = await AudioEncoder.isConfigSupported({
          codec: "opus",
          sampleRate: 48_000,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        return !!sound.supported;
      }
    } catch {
      // Treated as unsupported.
    }
    return false;
  })();
  return usable;
}

/**
 * Starts buffering `stream`, or answers null when this browser cannot (the
 * caller falls back). `onFatal` is called, once, if the worker later finds it
 * cannot go on; the engine has already stopped itself by then.
 */
export async function startClipEncoder(
  stream: MediaStream,
  lengthSecs: number,
  events: ClipEngineEvents,
  onFatal: (reason: string) => void,
): Promise<ClipEngine | null> {
  if (!(await clipEncoderUsable())) return null;
  const box = globalThis as unknown as Required<TrackProcessorBox>;

  let worker: Worker;
  try {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }

  let stopped = false;
  let videoStarted = false;
  let audioStarted = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let nextTake = 0;
  const waiting = new Map<number, (clip: TakenClipData | null) => void>();
  // The worker reads clones, so letting go of them ends its reading without
  // touching the share the user is watching or sending.
  const clones: MediaStreamTrack[] = [];

  const send = (message: ClipWorkerRequest, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (poll) clearInterval(poll);
    if (watchdog) clearTimeout(watchdog);
    worker.terminate();
    for (const clone of clones) clone.stop();
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
  };

  const fatal = (reason: string) => {
    if (stopped) return;
    stop();
    onFatal(reason);
  };

  worker.onmessage = ({ data }: MessageEvent<ClipWorkerReply>) => {
    if (stopped) return;
    switch (data.type) {
      case "ready":
        if (watchdog) clearTimeout(watchdog);
        events.onArmed(true);
        events.onError(null);
        events.onDetail?.(data.detail);
        break;
      case "buffered":
        events.onBuffered(data.secs);
        break;
      case "clip": {
        const resolve = waiting.get(data.id);
        waiting.delete(data.id);
        resolve?.(data.blob ? { blob: data.blob, seconds: data.seconds } : null);
        break;
      }
      case "warning":
        events.onError(data.message);
        break;
      case "failed":
        fatal(data.message);
        break;
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fatal(event.message || "The clip recorder crashed");
  };

  const startVideo = () => {
    if (videoStarted) return;
    const track = stream.getVideoTracks().find((t) => t.readyState === "live");
    if (!track) {
      events.onError("The share has no live video track yet");
      return;
    }
    videoStarted = true;
    const clone = track.clone();
    clones.push(clone);
    const frames = new box.MediaStreamTrackProcessor({ track: clone, maxBufferSize: 2 })
      .readable as ReadableStream<VideoFrame>;
    const fps = track.getSettings().frameRate;
    send(
      {
        type: "start",
        video: frames,
        sourceFps: typeof fps === "number" && fps > 0 ? fps : null,
        windowSecs: lengthSecs,
      },
      [frames],
    );
    watchdog = setTimeout(() => {
      if (!stopped) events.onError("The recorder produced no data from this stream");
    }, FIRST_FRAME_TIMEOUT_MS);
  };

  // A received track stays muted until media actually flows, and a share
  // frequently negotiates audio that carries nothing, so sound joins only once
  // it is demonstrably live. It can turn up well after the picture does.
  const startAudio = () => {
    if (audioStarted || !videoStarted) return;
    const track = stream.getAudioTracks().find((t) => t.readyState === "live" && !t.muted);
    if (!track) return;
    audioStarted = true;
    const clone = track.clone();
    clones.push(clone);
    const blocks = new box.MediaStreamTrackProcessor({ track: clone, maxBufferSize: 50 })
      .readable as ReadableStream<AudioData>;
    send({ type: "audio", audio: blocks }, [blocks]);
  };

  const look = () => {
    if (stopped) return;
    startVideo();
    startAudio();
  };
  // A leg that fails to start waits for the next look, not for a whole window.
  poll = setInterval(look, POLL_MS);
  look();

  return {
    stop,
    take: () =>
      new Promise<TakenClipData | null>((resolve) => {
        if (stopped) {
          resolve(null);
          return;
        }
        const id = ++nextTake;
        const timer = setTimeout(() => {
          if (waiting.delete(id)) resolve(null);
        }, TAKE_TIMEOUT_MS);
        waiting.set(id, (clip) => {
          clearTimeout(timer);
          resolve(clip);
        });
        send({ type: "take", id });
      }),
  };
}
