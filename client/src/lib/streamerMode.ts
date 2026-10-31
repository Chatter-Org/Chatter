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
import type { AvatarOverlay } from "@/lib/avatarCamera";
import { readAvatar, readAvatarArms, readAvatarZoom, readCameraAvatar } from "@/lib/cameraBackgrounds";

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

/** Above what any capture is shared at; the sender caps it to the chosen rate. */
const MAX_FPS = 60;
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
  /** Stops the avatar and its camera. The capture is the caller's to stop. */
  stop: () => void;
}

/**
 * Each frame of `screen` with the avatar drawn over it. A frame goes out when
 * either changes: a still screen sends few frames of its own, and the avatar
 * should keep moving over it.
 */
function composite(
  box: Required<BreakoutBox>,
  screen: MediaStreamTrack,
  avatar: AvatarOverlay,
  initial: StreamerPlacement,
): StreamerShare {
  const reader = new box.MediaStreamTrackProcessor({ track: screen, maxBufferSize: 1 }).readable.getReader();
  const generator = new box.MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("This computer can't draw streamer mode.");
  let placement = initial;
  // Held until the next one comes, so the avatar can be redrawn over it.
  let latest: VideoFrame | null = null;
  const minGapMs = (1000 / MAX_FPS) * 0.9;
  let lastMs = -Infinity;
  let writing = false;
  let stopped = false;

  const draw = () => {
    if (stopped || writing || !latest) return;
    const now = performance.now();
    if (now - lastMs < minGapMs) return;
    lastMs = now;
    const width = latest.displayWidth;
    const height = latest.displayHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(latest, 0, 0, width, height);
    const side = Math.round(Math.min(width, height * placement.size));
    ctx.drawImage(
      avatar.canvas,
      Math.round((width - side) * placement.x),
      Math.round((height - side) * placement.y),
      side,
      side,
    );
    writing = true;
    writer
      .write(new VideoFrame(canvas, { timestamp: Math.round(now * 1000) }))
      .catch(() => {})
      .finally(() => (writing = false));
  };
  avatar.onDraw = draw;

  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !frame) break;
      latest?.close();
      latest = frame;
      draw();
    }
    latest?.close();
    latest = null;
  })();

  return {
    track: generator,
    setPlacement: (next) => (placement = next),
    setZoom: avatar.setZoom,
    setArmTracking: avatar.setArmTracking,
    stop: () => {
      if (stopped) return;
      stopped = true;
      avatar.stop();
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
    },
  };
}

/**
 * Turns on the camera and the avatar and puts it over `screen`. Anything that
 * fails throws, with the camera already off again; the share can go ahead
 * without the avatar, since nothing private was going to be in it.
 */
export async function startStreamerShare(
  screen: MediaStreamTrack,
  settings: StreamerSettings,
): Promise<StreamerShare> {
  const avatarId = streamerAvatarId(settings);
  if (!avatarId) throw new Error("Pick an avatar for streamer mode first.");
  const box = globalThis as unknown as BreakoutBox;
  if (!streamerModeSupported()) throw new Error("Streamer mode needs Chrome, Edge or the desktop app.");
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
  try {
    const [{ startAvatarOverlay }, model] = await Promise.all([
      import("@/lib/avatarCamera"),
      readAvatar(avatarId),
    ]);
    const avatar = await startAvatarOverlay(source, AVATAR_FPS, model, {
      zoom: readAvatarZoom(avatarId),
      arms: readAvatarArms(),
    });
    try {
      return composite(box as Required<BreakoutBox>, screen, avatar, settings.placement);
    } catch (err) {
      avatar.stop();
      throw err;
    }
  } catch (err) {
    source.stop();
    throw err;
  }
}
