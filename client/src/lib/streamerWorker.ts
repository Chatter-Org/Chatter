/**
 * Streamer mode's drawing, in a worker so none of it is on the page's thread:
 * reading the face (MediaPipe waits on the GPU for each reading), drawing the
 * avatar, and redrawing every frame of the screen with it on top. The page
 * opens the camera and hands over the frames as streams — Chromium moves a
 * `MediaStreamTrackProcessor`'s readable and a `MediaStreamTrackGenerator`'s
 * writable across whole, so the frames themselves never pass through the
 * page — and keeps only the track that is published (`streamerMode.ts`).
 */
import { startAvatarOverlayScene, type AvatarOverlayScene } from "@/lib/avatarCamera";
import type { AvatarLook } from "@/lib/avatarLook";
import type { StreamerPlacement } from "@/lib/streamerMode";

export type StreamerWorkerRequest =
  | {
      type: "start";
      /** The capture's frames, the camera's, and where the drawn ones go. */
      screen: ReadableStream<VideoFrame>;
      camera: ReadableStream<VideoFrame>;
      out: WritableStream<VideoFrame>;
      model: ArrayBuffer;
      zoom: number;
      arms: boolean;
      look: AvatarLook;
      placement: StreamerPlacement;
      /** The share's frame rate, and the rate the face is followed at. */
      fps: number;
      avatarFps: number;
    }
  | { type: "placement"; placement: StreamerPlacement }
  | { type: "zoom"; zoom: number }
  | { type: "arms"; on: boolean }
  | { type: "look"; look: AvatarLook }
  | { type: "fps"; fps: number };

export type StreamerWorkerReply = { type: "ready" } | { type: "failed"; message: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<StreamerWorkerRequest>) => void) | null;
  postMessage: (reply: StreamerWorkerReply) => void;
};

/** Above what any capture is shared at. */
const MAX_FPS = 60;

const gapFor = (rate: number) => (1000 / Math.min(MAX_FPS, Math.max(1, rate))) * 0.9;

// Changes that land while the avatar loads are kept for when it has.
let placement: StreamerPlacement = { x: 1, y: 1, size: 0.35 };
let minGapMs = gapFor(30);
let scene: AvatarOverlayScene | null = null;
let pending: { zoom: number; arms: boolean; look: AvatarLook } | null = null;

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case "start":
      void start(data);
      break;
    case "placement":
      placement = data.placement;
      break;
    case "fps":
      minGapMs = gapFor(data.fps);
      break;
    case "zoom":
      if (scene) scene.setZoom(data.zoom);
      else if (pending) pending.zoom = data.zoom;
      break;
    case "arms":
      if (scene) scene.setArmTracking(data.on);
      else if (pending) pending.arms = data.on;
      break;
    case "look":
      if (scene) scene.setLook(data.look);
      else if (pending) pending.look = data.look;
      break;
  }
};

async function start(request: Extract<StreamerWorkerRequest, { type: "start" }>) {
  placement = request.placement;
  minGapMs = gapFor(request.fps);
  pending = { zoom: request.zoom, arms: request.arms, look: request.look };
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { alpha: false });
  try {
    if (!ctx) throw new Error("This computer can't draw streamer mode.");
    scene = await startAvatarOverlayScene(request.model, pending);
  } catch (err) {
    scope.postMessage({ type: "failed", message: err instanceof Error ? err.message : "" });
    return;
  }
  // Anything changed while it loaded.
  scene.setZoom(pending.zoom);
  scene.setArmTracking(pending.arms);
  scene.setLook(pending.look);
  pending = null;
  const avatar = scene;
  scope.postMessage({ type: "ready" });

  const writer = request.out.getWriter();
  // Held until the next one comes, so the avatar can be redrawn over it.
  let latest: VideoFrame | null = null;
  let lastMs = -Infinity;
  // Something has changed since the last frame went out.
  let dirty = false;
  let held: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let ended = false;

  // A frame goes out when the screen or the avatar changes, as a still screen
  // sends few frames of its own, but no faster than the share's rate: the two
  // do not keep time together. A change held back goes out once the gap is up.
  const draw = () => {
    if (ended || writing || !dirty || !latest || held) return;
    const now = performance.now();
    const wait = lastMs + minGapMs - now;
    if (wait > 0) {
      held = setTimeout(() => {
        held = null;
        draw();
      }, wait);
      return;
    }
    lastMs = now;
    dirty = false;
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
      .finally(() => {
        writing = false;
        draw();
      });
  };
  const changed = () => {
    dirty = true;
    draw();
  };

  // The face, at the avatar's own rate. A camera that ends (unplugged, or
  // the share stopping) leaves the avatar as it last was over the screen.
  void (async () => {
    const reader = request.camera.getReader();
    const minGapUs = (1_000_000 / request.avatarFps) * 0.9;
    let lastUs = -Infinity;
    while (!ended) {
      const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !frame) break;
      try {
        if (ended || frame.timestamp - lastUs < minGapUs) continue;
        const deltaS = lastUs === -Infinity ? 0 : (frame.timestamp - lastUs) / 1_000_000;
        lastUs = frame.timestamp;
        avatar.draw(frame, deltaS);
        changed();
      } finally {
        frame.close();
      }
    }
  })();

  // The screen; when it ends, so does the share, and the page stops this worker.
  const reader = request.screen.getReader();
  while (true) {
    const { value: frame, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
    if (done || !frame) break;
    latest?.close();
    latest = frame;
    changed();
  }
  ended = true;
  if (held) clearTimeout(held);
  latest?.close();
  latest = null;
  writer.close().catch(() => {});
}
