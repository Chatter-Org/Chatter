/**
 * The last stretch of a share, kept as encoded frames and cut on keyframes.
 *
 * Video is held in groups of pictures — a keyframe and what follows it, until
 * the next keyframe — because a decoder can start only on a keyframe. Trimming
 * drops whole groups from the front, oldest first, and only while the group
 * after would still leave the whole window behind it. So the footage kept is
 * always at least the window and less than a window plus one group: with a
 * keyframe every `CLIP_KEYFRAME_SECS`, a "30 second" clip is 30 to 32.
 *
 * The old recorder buffer could only hand over one recorder's entire output, up
 * to twice the setting, and ran two encoders to do it. Here one encoder runs and
 * the cut lands within a group of the request.
 *
 * Times are microseconds on one clock, the worker's, for both streams.
 */

export interface RingSample {
  data: Uint8Array;
  /** When it starts. */
  ts: number;
  /** How long it lasts; zero for video, which is measured by the next sample. */
  dur: number;
  key: boolean;
}

interface Group {
  startTs: number;
  samples: RingSample[];
}

export interface RingSnapshot {
  /** Starts on a keyframe. */
  video: RingSample[];
  /** Whatever sound overlaps the video. */
  audio: RingSample[];
  /** Where the clip starts: the first keyframe's time. */
  startTs: number;
}

export class ClipRing {
  private groups: Group[] = [];
  private audio: RingSample[] = [];
  private byteCount = 0;
  private windowUs: number;

  constructor(windowUs: number) {
    this.windowUs = windowUs;
  }

  setWindow(windowUs: number) {
    this.windowUs = windowUs;
  }

  /** Encoded bytes held, for a sense of what the buffer costs. */
  get bytes() {
    return this.byteCount;
  }

  /** Whether there is a keyframe to start a clip from. */
  get hasVideo() {
    return this.groups.length > 0;
  }

  /**
   * Adds one encoded frame. `nowUs` is the live edge, which is the sample's own
   * time for a stream that is moving and later for one that has stood still.
   * Anything before the first keyframe is dropped: nothing could play it.
   */
  addVideo(sample: RingSample, nowUs: number) {
    if (sample.key) {
      this.groups.push({ startTs: sample.ts, samples: [sample] });
    } else {
      const group = this.groups[this.groups.length - 1];
      if (!group) return;
      group.samples.push(sample);
    }
    this.byteCount += sample.data.byteLength;
    this.trim(nowUs);
  }

  addAudio(sample: RingSample, nowUs: number) {
    this.audio.push(sample);
    this.byteCount += sample.data.byteLength;
    this.trim(nowUs);
  }

  /** Drops what is older than the window needs. Also run on its own, to let a
   *  buffer on a still screen shed footage as time passes. */
  trim(nowUs: number) {
    while (this.groups.length > 1 && nowUs - this.groups[1].startTs >= this.windowUs) {
      const old = this.groups.shift()!;
      for (const s of old.samples) this.byteCount -= s.data.byteLength;
    }
    // Sound is kept as far back as the picture, no further. With no picture at
    // all it is held to a window so that a share that never draws cannot grow
    // it without end.
    const keepFrom = this.groups.length > 0 ? this.groups[0].startTs : nowUs - this.windowUs;
    let drop = 0;
    while (drop < this.audio.length && this.audio[drop].ts + this.audio[drop].dur <= keepFrom) {
      this.byteCount -= this.audio[drop].data.byteLength;
      drop++;
    }
    if (drop > 0) this.audio.splice(0, drop);
  }

  /** How much time the footage covers up to `nowUs`. */
  coverageUs(nowUs: number): number {
    const first = this.groups[0];
    return first ? Math.max(0, nowUs - first.startTs) : 0;
  }

  /**
   * Everything a clip is made of, or null while there is no keyframe. The
   * arrays are copies of the lists, not of the frames; nothing here is changed.
   */
  snapshot(endUs: number): RingSnapshot | null {
    const first = this.groups[0];
    if (!first) return null;
    const video = this.groups.flatMap((g) => g.samples);
    const startTs = first.startTs;
    const audio = this.audio.filter((s) => s.ts + s.dur > startTs && s.ts < endUs);
    return { video, audio, startTs };
  }

  clear() {
    this.groups = [];
    this.audio = [];
    this.byteCount = 0;
  }
}
