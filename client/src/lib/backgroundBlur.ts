/**
 * Background blur for the camera, or an image in place of the background,
 * done entirely in the sender's browser: the SFU forwards the result like any
 * other camera and never knows.
 *
 * MediaPipe's selfie segmenter says, for each frame, how likely each pixel is
 * to be the person. The frame is drawn sharp through that mask with either
 * itself blurred or the image behind it on a canvas, and the canvas's own
 * track is what gets published.
 *
 * The runtime (13 MB of WASM) and the model are served from this server's
 * hashed /assets rather than a CDN — a self-hosted server may have no route to
 * one, and a camera feature should not tell Google who is on a call. This file
 * is only ever loaded by dynamic import, so nobody downloads any of it until
 * they first turn an effect on.
 */
import { ImageSegmenter, type ImageSegmenterResult } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import modelAssetPath from "@/assets/models/selfie_segmenter.tflite?url";

/** How hard the background is blurred, in output pixels at 720p. */
const BLUR_PX_AT_720 = 14;

/**
 * The background is blurred at this fraction of the frame's size and then
 * stretched back up. A blur throws the detail away anyway, so it looks the
 * same, and blurring a full 720p frame was most of the cost of each frame.
 */
const BACKGROUND_SCALE = 1 / 4;

/** Blurring is done at no more than this; the camera is asked for 720p. */
const MAX_WIDTH = 1280;
const MAX_HEIGHT = 720;

export interface BlurredCamera {
  /** The blurred camera, to publish and preview in place of the source. */
  track: MediaStreamTrack;
  /** Stops the blur and the source camera with it. */
  stop: () => void;
}

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** One segmenter for the page; building it is the slow part. */
function loadSegmenter(): Promise<ImageSegmenter> {
  segmenterPromise ??= (async () => {
    // FilesetResolver would look for the files beside each other under one
    // base URL; Vite hashes each name separately, so they are named directly.
    const fileset = { wasmLoaderPath, wasmBinaryPath };
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: { modelAssetPath, delegate },
      runningMode: "VIDEO" as const,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
    } catch {
      // No usable WebGL (a blocklisted driver, a VM): slower, still works.
      return await ImageSegmenter.createFromOptions(fileset, options("CPU"));
    }
  })().catch((err) => {
    segmenterPromise = null;
    throw err;
  });
  return segmenterPromise;
}

/**
 * Chromium's raw-frame access to a track ("breakout box"): read a camera's
 * frames as they arrive, and make a track out of frames written to it. Not in
 * TypeScript's DOM types, since only Chromium has it.
 */
export interface BreakoutBox {
  MediaStreamTrackProcessor?: new (init: {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }) => { readable: ReadableStream<VideoFrame> };
  MediaStreamTrackGenerator?: new (init: {
    kind: "video";
  }) => MediaStreamTrack & { writable: WritableStream<VideoFrame> };
}

/**
 * Draws a frame with its background blurred, or replaced by `image`, onto
 * `canvas`.
 *
 * The person is the frame kept only where the mask says they are; behind them
 * goes the image, or the frame blurred at a quarter size and stretched back up.
 */
function makeCompositor(
  segmenter: ImageSegmenter,
  width: number,
  height: number,
  image?: ImageBitmap,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  const blurPx = Math.max(4, Math.round((BLUR_PX_AT_720 * height) / 720));
  const background = document.createElement("canvas");
  background.width = Math.max(1, Math.round(width * BACKGROUND_SCALE));
  background.height = Math.max(1, Math.round(height * BACKGROUND_SCALE));
  const backgroundCtx = background.getContext("2d");
  const smallBlurPx = Math.max(1, blurPx * BACKGROUND_SCALE);
  // Drawn slightly oversized so the blur does not pull the transparent
  // outside of the canvas in at the edges.
  const bleed = smallBlurPx * 2;

  // The mask arrives at the model's own size (256²) and is stretched to the
  // frame when drawn, which also softens its edge — a hard edge round hair
  // and shoulders is what makes blur look cut out.
  const maskCanvas = document.createElement("canvas");
  const maskCtx = maskCanvas.getContext("2d");
  if (!ctx || !backgroundCtx || !maskCtx) {
    throw new Error("This browser cannot draw the blurred camera");
  }
  backgroundCtx.filter = `blur(${smallBlurPx}px)`;

  // An image is drawn once, cropped to fill the frame the way a camera image
  // would be, and reused for every frame.
  let backdrop: HTMLCanvasElement | null = null;
  if (image) {
    backdrop = document.createElement("canvas");
    backdrop.width = width;
    backdrop.height = height;
    const backdropCtx = backdrop.getContext("2d");
    if (!backdropCtx) throw new Error("This browser cannot draw the camera's background");
    const cover = Math.max(width / image.width, height / image.height);
    const w = image.width * cover;
    const h = image.height * cover;
    backdropCtx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  let maskImage: ImageData | null = null;
  let lastTimestamp = 0;

  const compose = (frame: HTMLVideoElement | VideoFrame, result: ImageSegmenterResult) => {
    // A one-class model: its single mask is how sure it is each pixel is the person.
    const mask = result.confidenceMasks?.[0];
    if (!mask) {
      ctx.drawImage(frame, 0, 0, width, height);
      return;
    }
    const confidence = mask.getAsFloat32Array();
    if (!maskImage || maskImage.width !== mask.width || maskImage.height !== mask.height) {
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
      maskImage = maskCtx.createImageData(mask.width, mask.height);
    }
    const px = maskImage.data;
    for (let i = 0; i < confidence.length; i++) px[i * 4 + 3] = confidence[i] * 255;
    maskCtx.putImageData(maskImage, 0, 0);

    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(frame, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(maskCanvas, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-over";
    if (backdrop) {
      ctx.drawImage(backdrop, 0, 0);
    } else {
      backgroundCtx.drawImage(
        frame,
        -bleed,
        -bleed,
        background.width + bleed * 2,
        background.height + bleed * 2,
      );
      ctx.drawImage(background, 0, 0, width, height);
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const draw = (frame: HTMLVideoElement | VideoFrame, timestampMs: number) => {
    // The segmenter refuses a timestamp that does not move forward.
    lastTimestamp = Math.max(timestampMs, lastTimestamp + 1);
    try {
      segmenter.segmentForVideo(frame, lastTimestamp, (result) => compose(frame, result));
    } catch {
      // A frame the segmenter could not take still goes out, just unblurred.
      ctx.globalCompositeOperation = "copy";
      ctx.drawImage(frame, 0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    }
  };

  return { canvas, draw };
}

/** The size frames are blurred at: the camera's own, at most 720p. */
function outputSize(source: MediaStreamTrack): { width: number; height: number } {
  const { width = MAX_WIDTH, height = MAX_HEIGHT } = source.getSettings();
  const scale = Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/**
 * Chromium (Chrome, Edge, the desktop app): the camera's frames in, blurred
 * frames out, as they come. Nothing here waits on the page painting, so it
 * keeps going in a background tab — a canvas stream sends a frame only when
 * the page repaints, and a hidden tab hardly does, which froze the camera for
 * everyone the moment the sender looked at another tab.
 */
function blurWithBreakoutBox(
  box: Required<BreakoutBox>,
  segmenter: ImageSegmenter,
  source: MediaStreamTrack,
  fps: number,
  image?: ImageBitmap,
): BlurredCamera {
  const { width, height } = outputSize(source);
  const { canvas, draw } = makeCompositor(segmenter, width, height, image);
  // A buffer of one: when blurring falls behind, the oldest frame is dropped
  // rather than the call drifting further and further behind the camera.
  const reader = new box.MediaStreamTrackProcessor({ track: source, maxBufferSize: 1 }).readable.getReader();
  const generator = new box.MediaStreamTrackGenerator({ kind: "video" });
  const writer = generator.writable.getWriter();
  // A camera running faster than asked (a 60 fps camera, blur at 30) has
  // the extra frames skipped rather than blurred.
  const minGapUs = (1_000_000 / fps) * 0.9;
  let lastUs = -Infinity;
  let stopped = false;

  void (async () => {
    while (!stopped) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      try {
        if (frame.timestamp - lastUs < minGapUs) continue;
        lastUs = frame.timestamp;
        draw(frame, frame.timestamp / 1000);
        // The generator closes the frames written to it.
        await writer.write(new VideoFrame(canvas, { timestamp: frame.timestamp }));
      } catch {
        // The track was stopped under us; the loop's condition ends it.
      } finally {
        frame.close();
      }
    }
  })();

  return {
    track: generator,
    stop: () => {
      if (stopped) return;
      stopped = true;
      reader.cancel().catch(() => {});
      writer.close().catch(() => {});
      generator.stop();
      source.stop();
    },
  };
}

/**
 * Firefox and Safari: the camera played into a video element, blurred onto a
 * canvas on a worker's clock, and the canvas streamed. The worker's timer is
 * not throttled in a background tab as a page's is, but the canvas stream still
 * sends only when the page paints, so here the camera can stall while the
 * sender's tab is hidden.
 */
async function blurWithCanvasStream(
  segmenter: ImageSegmenter,
  source: MediaStreamTrack,
  fps: number,
  image?: ImageBitmap,
): Promise<BlurredCamera> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([source]);
  await video.play();

  const { width, height } = outputSize(source);
  const { canvas, draw } = makeCompositor(segmenter, width, height, image);
  const track = canvas.captureStream(fps).getVideoTracks()[0];

  const tickSource = `setInterval(() => postMessage(0), ${Math.max(1, Math.round(1000 / fps))});`;
  const tickUrl = URL.createObjectURL(new Blob([tickSource], { type: "text/javascript" }));
  const ticker = new Worker(tickUrl);
  ticker.onmessage = () => {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) draw(video, performance.now());
  };

  let stopped = false;
  return {
    track,
    stop: () => {
      if (stopped) return;
      stopped = true;
      ticker.terminate();
      URL.revokeObjectURL(tickUrl);
      source.stop();
      track.stop();
      video.srcObject = null;
    },
  };
}

/**
 * Blur `source`'s background — or, given `image`, put that behind the person
 * instead, closing it once drawn — at up to `fps` frames a second. A camera
 * unplugged or revoked ends `source`, not the returned track: whoever holds
 * the source watches it and calls `stop`.
 */
export async function blurBackground(
  source: MediaStreamTrack,
  fps: number,
  image?: ImageBitmap,
): Promise<BlurredCamera> {
  try {
    const segmenter = await loadSegmenter();
    const box = globalThis as unknown as BreakoutBox;
    if (box.MediaStreamTrackProcessor && box.MediaStreamTrackGenerator && typeof VideoFrame !== "undefined") {
      return blurWithBreakoutBox(box as Required<BreakoutBox>, segmenter, source, fps, image);
    }
    return await blurWithCanvasStream(segmenter, source, fps, image);
  } finally {
    // Copied onto the compositor's own canvas by now, so it is done with.
    image?.close();
  }
}
