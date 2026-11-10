/**
 * The clip buffer's encoder, in a worker so none of it is on the page's thread.
 *
 * The page hands over the share's frames (and its sound, if it has any) as
 * streams — Chromium moves a `MediaStreamTrackProcessor`'s readable across
 * whole, so the frames never pass through the page — and the worker keeps the
 * last stretch of them encoded and, on request, muxes a clip. See `ring.ts`
 * for what is kept and `mp4.ts` for the file.
 *
 * One encoder runs, and as light a one as the machine offers: a hardware H.264
 * encoder if there is one, else software, at a frame rate and size it can carry
 * without being noticed (`profile.ts`). The two overlapping MediaRecorders this
 * replaces cost about two and a half cores on a 1080p60 share.
 */
import { ClipRing, type RingSample } from "./ring";
import { muxMp4 } from "./mp4";
import { avcCodecStrings, chooseClipProfile, CLIP_KEYFRAME_SECS, type ClipProfile } from "./profile";
import type { ClipWorkerReply, ClipWorkerRequest } from "./types";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ClipWorkerRequest>) => void) | null;
  postMessage: (reply: ClipWorkerReply) => void;
};

const KEYFRAME_US = CLIP_KEYFRAME_SECS * 1e6;
/** Frames the encoder may be behind by before new ones are dropped instead.
 *  A clip with a skipped frame is nothing; a share that stutters because its
 *  clip buffer fell behind is the problem this exists to remove. */
const MAX_ENCODE_QUEUE = 4;
/** A share that resizes is re-opened at the new size, but no more often than this. */
const REOPEN_MIN_US = 2e6;
const OPUS_BITRATE = 128_000;
/** libopus's own look-ahead at 48 kHz, for an encoder that does not say. */
const DEFAULT_PRE_SKIP = 312;
const BUFFERED_REPORT_US = 1e6;

const nowUs = () => performance.now() * 1000;

const ring = new ClipRing(30e6);

interface VideoState {
  encoder: VideoEncoder;
  profile: ClipProfile;
  hardware: boolean;
  sourceFps: number | null;
  /** The size frames arrive at, which need not be the size they are encoded at. */
  sourceWidth: number;
  sourceHeight: number;
  /** The encoder's picture-decoding header, from its first keyframe. */
  avcC: Uint8Array | null;
  /** Frame times are the capture's; this puts the first on the worker's clock. */
  firstNative: number;
  anchorUs: number;
  lastKeyNative: number;
  lastEncodedNative: number;
  /** When the next frame is due, so a 60 fps share is thinned to 30 by taking
   *  the frame nearest each tick, not by measuring from the last one taken. */
  nextDue: number;
  /** The newest frame, kept so a still screen can be encoded again. */
  held: VideoFrame | null;
  heldNative: number;
  lastArrivalUs: number;
  openedAtUs: number;
  /** Which encoder this is: output from one that has been replaced is ignored. */
  generation: number;
}

interface AudioState {
  encoder: AudioEncoder;
  channels: number;
  /** Filled in from the encoder's header once it has produced one. */
  header: { preSkip: number };
}

let video: VideoState | null = null;
let audio: AudioState | null = null;
let generation = 0;
let failed = false;
let endedAtUs: number | null = null;
let readyPosted = false;
let lastBufferedUs = 0;
let keepAlive: ReturnType<typeof setInterval> | null = null;

const post = (reply: ClipWorkerReply) => scope.postMessage(reply);

function fail(message: string) {
  if (failed) return;
  failed = true;
  console.warn("[clip] encoder stopped:", message);
  stopVideo();
  post({ type: "failed", message });
}

function stopVideo() {
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
  const current = video;
  video = null;
  generation++;
  if (!current) return;
  current.held?.close();
  try {
    if (current.encoder.state !== "closed") current.encoder.close();
  } catch {
    // Already gone.
  }
}

const bytesOf = (source: AllowSharedBufferSource): Uint8Array =>
  ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice()
    : new Uint8Array(source).slice();

// ─── Picture ────────────────────────────────────────────────────────────────

/**
 * An encoder for frames of this size. Hardware first: it is free to the CPU and
 * lets a 60 fps share keep its 60. Software next, held to a rate it can carry.
 * `softwareOnly` is for after a hardware encoder has failed in use, which a
 * config check cannot predict.
 */
async function pickEncoder(
  width: number,
  height: number,
  sourceFps: number | null,
  softwareOnly: boolean,
): Promise<{ config: VideoEncoderConfig; profile: ClipProfile; hardware: boolean } | null> {
  const attempts: Array<{ hardware: boolean; preference: NonNullable<VideoEncoderConfig["hardwareAcceleration"]> }> = [];
  if (!softwareOnly) attempts.push({ hardware: true, preference: "prefer-hardware" });
  attempts.push({ hardware: false, preference: "prefer-software" });
  for (const { hardware, preference } of attempts) {
    const profile = chooseClipProfile({ width, height }, { hardware, sourceFps });
    for (const codec of avcCodecStrings(profile)) {
      const config: VideoEncoderConfig = {
        codec,
        width: profile.width,
        height: profile.height,
        bitrate: profile.bitrate,
        framerate: profile.fps,
        hardwareAcceleration: preference,
        latencyMode: "realtime",
        // Length-prefixed, which is how an MP4 holds it.
        avc: { format: "avc" },
      };
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, profile, hardware };
      } catch {
        // Treated as unsupported; the next string may be fine.
      }
    }
  }
  return null;
}

async function openVideo(width: number, height: number, sourceFps: number | null, softwareOnly = false) {
  stopVideo();
  ring.clear();
  readyPosted = false;
  const mine = ++generation;
  const picked = await pickEncoder(width, height, sourceFps, softwareOnly);
  if (mine !== generation) return;
  if (!picked) {
    fail("This browser cannot encode H.264");
    return;
  }

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => onVideoOutput(mine, chunk, metadata),
    error: (err) => onVideoError(mine, err),
  });
  try {
    encoder.configure(picked.config);
  } catch (err) {
    fail(err instanceof Error ? err.message : "Could not start the video encoder");
    return;
  }
  video = {
    encoder,
    profile: picked.profile,
    hardware: picked.hardware,
    sourceFps,
    sourceWidth: width,
    sourceHeight: height,
    avcC: null,
    firstNative: 0,
    anchorUs: 0,
    lastKeyNative: -Infinity,
    lastEncodedNative: -Infinity,
    nextDue: -Infinity,
    held: null,
    heldNative: 0,
    lastArrivalUs: nowUs(),
    openedAtUs: nowUs(),
    generation: mine,
  };
  keepAlive ??= setInterval(onTick, 500);
}

function onVideoError(mine: number, err: DOMException) {
  if (mine !== generation || !video) return;
  const { sourceWidth, sourceHeight, sourceFps, hardware } = video;
  console.warn("[clip] video encoder error:", err.message);
  if (hardware) {
    // A hardware encoder that passed its config check and then fell over (a
    // driver, a session limit): carry on in software rather than give up.
    void openVideo(sourceWidth, sourceHeight, sourceFps, true);
  } else {
    fail(err.message || "The video encoder stopped");
  }
}

function onVideoOutput(mine: number, chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata) {
  const v = video;
  if (mine !== generation || !v) return;
  const description = metadata?.decoderConfig?.description;
  if (description && !v.avcC) v.avcC = bytesOf(description);
  const data = new Uint8Array(chunk.byteLength);
  chunk.copyTo(data);
  const sample: RingSample = {
    data,
    ts: v.anchorUs + (chunk.timestamp - v.firstNative),
    dur: 0,
    key: chunk.type === "key",
  };
  ring.addVideo(sample, nowUs());
  if (!readyPosted && v.avcC) {
    readyPosted = true;
    const detail = `${v.profile.height}p${v.profile.fps} · ${v.hardware ? "hardware" : "software"}`;
    console.info(
      `[clip] ${v.profile.width}x${v.profile.height} @${v.profile.fps} fps, ${(v.profile.bitrate / 1e6).toFixed(1)} Mbps, H.264 (${v.hardware ? "hardware" : "software"})`,
    );
    post({ type: "ready", detail });
  }
  reportBuffered();
}

function reportBuffered() {
  const now = nowUs();
  if (now - lastBufferedUs < BUFFERED_REPORT_US) return;
  lastBufferedUs = now;
  post({ type: "buffered", secs: ring.coverageUs(endedAtUs ?? now) / 1e6 });
}

/**
 * Hands one frame to the encoder, as a keyframe when a clip would otherwise be
 * unable to start soon enough. Takes the frame's place on the worker's clock
 * from the first one.
 */
function encodeFrame(v: VideoState, frame: VideoFrame, native: number, forceKey: boolean) {
  if (v.lastEncodedNative === -Infinity) {
    v.firstNative = native;
    v.anchorUs = nowUs();
  }
  const key = forceKey || native - v.lastKeyNative >= KEYFRAME_US;
  const input = native === frame.timestamp ? frame : new VideoFrame(frame, { timestamp: native });
  try {
    v.encoder.encode(input, { keyFrame: key });
  } finally {
    if (input !== frame) input.close();
  }
  if (key) v.lastKeyNative = native;
  v.lastEncodedNative = native;
}

async function ingest(frame: VideoFrame, sourceFps: number | null) {
  const arrival = nowUs();
  const width = frame.displayWidth;
  const height = frame.displayHeight;
  let v = video;
  const resized = !!v && (v.sourceWidth !== width || v.sourceHeight !== height);
  if (!v || (resized && arrival - v.openedAtUs >= REOPEN_MIN_US)) {
    // A new size is a new picture to encode: what was buffered cannot join it.
    await openVideo(width, height, sourceFps);
    v = video;
  }
  if (!v || failed) {
    frame.close();
    return;
  }

  v.lastArrivalUs = arrival;
  const native = Math.max(frame.timestamp, v.lastEncodedNative + 1);
  // Taking a frame whenever one is a period past the last gives 33 and 50 ms
  // gaps on a 60 fps source (a frame 29.9 ms on is "too soon", so the next is
  // 50 ms on). A frame is due near its tick instead, a quarter period early at
  // most, and the ticks keep their own time.
  const period = 1e6 / v.profile.fps;
  const due = native >= v.nextDue - period * 0.25;
  // Dropped at the door, before the encoder: the capture goes on at its own
  // rate whatever this keeps up with.
  if (due && v.encoder.encodeQueueSize <= MAX_ENCODE_QUEUE) {
    encodeFrame(v, frame, native, false);
    v.nextDue = native - v.nextDue > period ? native + period : v.nextDue + period;
    v.heldNative = native;
  } else {
    v.heldNative = Math.max(v.heldNative, native);
  }
  // The newest frame is the one a still screen is showing, encoded or not.
  v.held?.close();
  v.held = frame;
}

/**
 * A screen that does not change sends no frames, and a clip can start only on a
 * keyframe — so after a quiet spell the oldest keyframe would be older than the
 * window, and a clip would run as long as the screen had been still. The last
 * frame is encoded again instead, as a keyframe, as often as one is due.
 */
function onTick() {
  const v = video;
  if (!v || !v.held || failed || endedAtUs !== null) return;
  const now = nowUs();
  const idle = now - v.lastArrivalUs;
  if (idle >= KEYFRAME_US && v.encoder.encodeQueueSize <= MAX_ENCODE_QUEUE) {
    const native = Math.max(v.heldNative + idle, v.lastEncodedNative + 1);
    try {
      encodeFrame(v, v.held, native, true);
      v.nextDue = native + 1e6 / v.profile.fps;
      v.heldNative = native;
      v.lastArrivalUs = now;
    } catch (err) {
      console.warn("[clip] could not repeat the last frame:", err);
    }
  }
  ring.trim(now);
  reportBuffered();
}

async function readVideo(stream: ReadableStream<VideoFrame>, sourceFps: number | null) {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      try {
        await ingest(value, sourceFps);
      } catch (err) {
        value.close();
        if (video) {
          console.warn("[clip] a frame could not be encoded:", err);
          onVideoError(video.generation, err instanceof DOMException ? err : new DOMException(String(err)));
        }
      }
    }
  } catch (err) {
    console.warn("[clip] the share's frames stopped:", err);
  }
  // The share is over. What was kept stays takeable until the page lets go.
  endedAtUs = nowUs();
  if (keepAlive) clearInterval(keepAlive);
  keepAlive = null;
}

// ─── Sound ──────────────────────────────────────────────────────────────────

async function openAudio(first: AudioData): Promise<boolean> {
  const config: AudioEncoderConfig = {
    codec: "opus",
    sampleRate: first.sampleRate,
    numberOfChannels: first.numberOfChannels,
    bitrate: OPUS_BITRATE,
  };
  // Opus takes mono or stereo at a few rates. Anything else is left out: a clip
  // without sound is better than no clip, and better than a wrong one.
  if (first.numberOfChannels > 2) return false;
  try {
    if (!(await AudioEncoder.isConfigSupported(config)).supported) return false;
  } catch {
    return false;
  }
  const header = { preSkip: DEFAULT_PRE_SKIP };
  const firstNative = first.timestamp;
  // The block has just been captured, so it began a block ago.
  const anchorUs = nowUs() - first.duration;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description) {
        const head = bytesOf(description);
        // "OpusHead", version, channels, then the pre-skip, little-endian.
        if (head.byteLength >= 12 && head[0] === 0x4f && head[1] === 0x70) {
          header.preSkip = head[10] | (head[11] << 8);
        }
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      ring.addAudio(
        { data, ts: anchorUs + (chunk.timestamp - firstNative), dur: chunk.duration ?? 20_000, key: true },
        nowUs(),
      );
    },
    error: (err) => {
      // The picture is worth keeping without it.
      console.warn("[clip] audio encoder error:", err.message);
      audio = null;
    },
  });
  try {
    encoder.configure(config);
  } catch {
    return false;
  }
  audio = { encoder, channels: first.numberOfChannels, header };
  return true;
}

async function readAudio(stream: ReadableStream<AudioData>) {
  const reader = stream.getReader();
  let usable = true;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      try {
        if (usable && !audio) usable = await openAudio(value);
        if (usable && audio && audio.encoder.state === "configured") audio.encoder.encode(value);
      } catch (err) {
        console.warn("[clip] a block of sound could not be encoded:", err);
      } finally {
        value.close();
      }
    }
  } catch (err) {
    console.warn("[clip] the share's sound stopped:", err);
  }
}

// ─── Clips ──────────────────────────────────────────────────────────────────

function take(id: number) {
  const v = video;
  const end = endedAtUs ?? nowUs();
  const snapshot = v && v.avcC ? ring.snapshot(end) : null;
  if (!v || !v.avcC || !snapshot) {
    post({ type: "clip", id, blob: null, seconds: 0 });
    return;
  }
  try {
    const last = snapshot.video[snapshot.video.length - 1];
    // The last frame lasts until now: a still screen is a long frame.
    const endUs = Math.max(end, last.ts + 1000);
    const parts = muxMp4({
      video: {
        width: v.profile.width,
        height: v.profile.height,
        avcC: v.avcC,
        samples: snapshot.video,
      },
      audio:
        audio && snapshot.audio.length > 0
          ? { channels: audio.channels, preSkip: audio.header.preSkip, samples: snapshot.audio }
          : null,
      endUs,
    });
    post({
      type: "clip",
      id,
      blob: new Blob(parts as BlobPart[], { type: "video/mp4" }),
      seconds: (endUs - snapshot.startTs) / 1e6,
    });
  } catch (err) {
    console.warn("[clip] could not make the clip:", err);
    post({ type: "clip", id, blob: null, seconds: 0 });
  }
}

scope.onmessage = ({ data }) => {
  switch (data.type) {
    case "start":
      ring.setWindow(data.windowSecs * 1e6);
      void readVideo(data.video, data.sourceFps);
      break;
    case "audio":
      void readAudio(data.audio);
      break;
    case "take":
      take(data.id);
      break;
  }
};
