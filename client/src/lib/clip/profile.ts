/**
 * What the clip encoder is asked for: how big, how fast, how many bits, and
 * which H.264 flavours to try in what order.
 *
 * The aim is the cheapest encode that still makes a clip worth posting. The
 * share itself is already pinned to 1080p (`SCREEN_MAX_WIDTH`), so the clip is
 * never bigger than that; the frame rate is where the cost is, so a machine
 * without a hardware encoder keeps to 30 and one with it follows the share.
 */

/** The share is pinned to this (`getScreenSharePublishProfile`); a clip never
 *  needs more, and a received share can be bigger. */
export const CLIP_MAX_WIDTH = 1920;
export const CLIP_MAX_HEIGHT = 1080;

/** A keyframe at least this often. A clip can only start on one, so this is
 *  also how much longer than asked for a clip can run. */
export const CLIP_KEYFRAME_SECS = 2;

/** Bits for each pixel of each frame. A hardware H.264 encoder is clean at this
 *  and a software one (OpenH264) soft but good: about 8Mbps at 1080p30. */
const BITS_PER_PIXEL = 0.13;
const MIN_BITRATE = 1_500_000;
const MAX_BITRATE = 12_000_000;

export interface ClipProfile {
  /** What goes into the file. */
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * The size, rate and bitrate to encode a `source`-sized share at.
 *
 * `hardware` is whether a hardware encoder will take the job: it costs the CPU
 * nothing, so it may keep the share's 60 where software is held to 30.
 * `sourceFps` is what the share was captured at, where that is known; a
 * received share does not say, and is taken for 30.
 */
export function chooseClipProfile(
  source: { width: number; height: number },
  options: { hardware: boolean; sourceFps?: number | null },
): ClipProfile {
  const scale = Math.min(1, CLIP_MAX_WIDTH / source.width, CLIP_MAX_HEIGHT / source.height);
  const width = even(source.width * scale);
  const height = even(source.height * scale);
  const fps = options.hardware && (options.sourceFps ?? 30) > 35 ? 60 : 30;
  const bitrate = Math.round(
    Math.min(MAX_BITRATE, Math.max(MIN_BITRATE, width * height * fps * BITS_PER_PIXEL)) / 100_000,
  ) * 100_000;
  return { width, height, fps, bitrate };
}

/** H.264 levels and what each can carry: [level_idc, max macroblocks per
 *  frame, max macroblocks per second]. */
const AVC_LEVELS: ReadonlyArray<readonly [number, number, number]> = [
  [0x1f, 3600, 108_000], // 3.1
  [0x20, 5120, 216_000], // 3.2
  [0x28, 8192, 245_760], // 4.0
  [0x2a, 8704, 522_240], // 4.2
  [0x32, 22_080, 589_824], // 5.0
  [0x33, 36_864, 983_040], // 5.1
  [0x34, 36_864, 2_073_600], // 5.2
];

/** The lowest level that holds the picture; an encoder refuses one too low. */
export function avcLevel(width: number, height: number, fps: number): number {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const level = AVC_LEVELS.find(([, maxFrame, maxRate]) => frame <= maxFrame && frame * fps <= maxRate);
  return (level ?? AVC_LEVELS[AVC_LEVELS.length - 1])[0];
}

/** Codec strings, best first: High, then Main, then Constrained Baseline, which
 *  is all some encoders have. */
export function avcCodecStrings(profile: ClipProfile): string[] {
  const level = avcLevel(profile.width, profile.height, profile.fps)
    .toString(16)
    .padStart(2, "0");
  return [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42e0${level}`];
}
