/**
 * Streamer mode: the camera avatar drawn over your own screen share, at a
 * place and size you choose. Like the avatar camera it is all done on this
 * device — each frame of the capture is redrawn with the avatar on top, and
 * that is what gets published — so the SFU, every viewer and every clip see
 * an ordinary screen share with the avatar already in it. While it is on the
 * camera is only read for the face; no camera of its own is published.
 *
 * Chromium only (Chrome, Edge, the desktop app): the breakout box keeps the
 * frames coming while the sharer's tab is hidden, which it nearly always is
 * mid-share, where the canvas-stream fallback the camera uses would stall.
 */
import { avatarStore } from "@/lib/avatarStore";
import type { BreakoutBox } from "@/lib/backgroundBlur";
import type { StreamerWorkerReply, StreamerWorkerRequest } from "@/lib/streamerWorker";
import {
  readAvatar,
  readAvatarArms,
  readAvatarLook,
  readAvatarZoom,
  readCameraAvatar,
  type AvatarLook,
} from "@/lib/cameraBackgrounds";

const STORAGE_KEY = "chatter_streamer_mode";
export const STREAMER_MODE_CHANGE_EVENT = "chatter-streamer-mode-change";

/** The avatar's side as a share of the screen's height. */
export const STREAMER_SIZE = { min: 0.15, max: 0.6, default: 0.35 } as const;

/** Where the avatar goes. `x` and `y` are shares of the room left beside and
 *  below it (0 the left or top edge, 1 the right or bottom), so it stays in the
 *  same corner, and on the screen, whatever the screen's shape or its size. */
export interface StreamerPlacement {
  x: number;
  y: number;
  size: number;
}

export interface StreamerSettings {
  on: boolean;
  /** Which of this device's avatars; null is the camera picker's. */
  avatarId: string | null;
  /** The camera that follows the face; null is the default one. */
  deviceId: string | null;
  placement: StreamerPlacement;
}

const DEFAULTS: StreamerSettings = {
  on: false,
  avatarId: null,
  deviceId: null,
  placement: { x: 1, y: 1, size: STREAMER_SIZE.default },
};

/** The face is followed at the camera avatar's rate. */
const AVATAR_FPS = 30;

const unit = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

export function readStreamerMode(): StreamerSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<StreamerSettings>;
    const p = (parsed.placement ?? {}) as Partial<StreamerPlacement>;
    const size = typeof p.size === "number" ? p.size : STREAMER_SIZE.default;
    return {
      on: parsed.on === true,
      avatarId: typeof parsed.avatarId === "string" ? parsed.avatarId : null,
      deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : null,
      placement: {
        x: unit(p.x, DEFAULTS.placement.x),
        y: unit(p.y, DEFAULTS.placement.y),
        size: Math.min(STREAMER_SIZE.max, Math.max(STREAMER_SIZE.min, size)),
      },
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveStreamerMode(settings: StreamerSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered; it starts from the defaults next time.
  }
}

/** The avatar streamer mode will use: its own choice, else the camera's. */
export function streamerAvatarId(settings: StreamerSettings): string | null {
  return settings.avatarId ?? readCameraAvatar();
}

export function streamerModeSupported(): boolean {
  const box = globalThis as unknown as BreakoutBox;
  return (
    !!avatarStore &&
    !!box.MediaStreamTrackProcessor &&
    !!box.MediaStreamTrackGenerator &&
    typeof VideoFrame !== "undefined"
  );
}

export interface StreamerShare {
  /** The capture with the avatar on it, to publish in its place. */
  track: MediaStreamTrack;
  setPlacement: (placement: StreamerPlacement) => void;
  setZoom: (zoom: number) => void;
  setArmTracking: (on: boolean) => void;
  setLook: (look: AvatarLook) => void;
  /** The share's frame rate, which the frames going out are kept to. */
  setFps: (fps: number) => void;
  /** Stops the avatar and its camera. The capture is the caller's to stop. */
  stop: () => void;
}

/**
 * Turns on the camera and the avatar and puts it over `screen`, at up to
 * `fps` frames a second. The drawing is all done in a worker
 * (`streamerWorker.ts`), so a heavy avatar does not slow the page: it is
 * handed the screen's and the camera's frames and draws the track returned.
 * Anything that fails throws, with the camera already off again; the share
 * can go ahead without the avatar, since nothing private was going to be in
 * it.
 */
export async function startStreamerShare(
  screen: MediaStreamTrack,
  settings: StreamerSettings,
  fps: number,
): Promise<StreamerShare> {
  const avatarId = streamerAvatarId(settings);
  if (!avatarId) throw new Error("Pick an avatar for streamer mode first.");
  if (!streamerModeSupported()) throw new Error("Streamer mode needs Chrome, Edge or the desktop app.");
  const box = globalThis as unknown as Required<BreakoutBox>;
  // Enough to read a face; more only costs the landmarker time.
  const camera = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : {}),
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: AVATAR_FPS },
    },
  });
  const source = camera.getVideoTracks()[0];
  let worker: Worker | null = null;
  let generator: MediaStreamTrack | null = null;
  try {
    const model = await readAvatar(avatarId);
    const out = new box.MediaStreamTrackGenerator({ kind: "video" });
    generator = out;
    const started = new Worker(new URL("./streamerWorker.ts", import.meta.url), { type: "module" });
    worker = started;
    const send = (message: StreamerWorkerRequest, transfer: Transferable[] = []) =>
      started.postMessage(message, transfer);
    const screenFrames = new box.MediaStreamTrackProcessor({ track: screen, maxBufferSize: 1 }).readable;
    const cameraFrames = new box.MediaStreamTrackProcessor({ track: source, maxBufferSize: 1 }).readable;
    const ready = new Promise<void>((resolve, reject) => {
      started.onmessage = ({ data }: MessageEvent<StreamerWorkerReply>) => {
        if (data.type === "ready") resolve();
        else reject(new Error(data.message || "Your avatar couldn't be drawn."));
      };
      started.onerror = (event) => {
        event.preventDefault();
        console.warn("[streamer-mode] worker failed:", event.message);
        reject(new Error("Your avatar couldn't be drawn."));
      };
    });
    send(
      {
        type: "start",
        screen: screenFrames,
        camera: cameraFrames,
        out: out.writable,
        model,
        zoom: readAvatarZoom(avatarId),
        arms: readAvatarArms(),
        look: readAvatarLook(avatarId),
        placement: settings.placement,
        fps,
        avatarFps: AVATAR_FPS,
      },
      [screenFrames, cameraFrames, out.writable, model],
    );
    await ready;

    let stopped = false;
    return {
      track: out,
      setPlacement: (placement) => send({ type: "placement", placement }),
      setZoom: (zoom) => send({ type: "zoom", zoom }),
      setArmTracking: (on) => send({ type: "arms", on }),
      setLook: (look) => send({ type: "look", look }),
      setFps: (rate) => send({ type: "fps", fps: rate }),
      stop: () => {
        if (stopped) return;
        stopped = true;
        started.terminate();
        out.stop();
        source.stop();
      },
    };
  } catch (err) {
    worker?.terminate();
    generator?.stop();
    source.stop();
    throw err;
  }
}
