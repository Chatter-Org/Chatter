/**
 * A clip as an MP4: one H.264 track and, if there was sound, one Opus track.
 *
 * Written in one go from frames already in memory, so unlike a recorder's
 * stream the file can be complete: the index leads the data (it starts playing
 * at once and seeks), and it carries its real length. Nothing else is
 * supported — no B-frames, one picture size, one sample description — because
 * the realtime encoder this is fed makes none of them.
 *
 * Opus rather than AAC: WebCodecs has no AAC encoder on most of the platforms
 * the web client runs on, and Opus in MP4 plays in Chromium, Firefox and Safari.
 * The tracks are interleaved, a second of one then a second of the other, so a
 * player reading from the front is never waiting on the far end of the file.
 */

export interface Mp4Sample {
  data: Uint8Array;
  /** Microseconds on any clock the two tracks share. */
  ts: number;
  /** Microseconds; used for audio. Video is timed by the next frame. */
  dur: number;
  key: boolean;
}

export interface Mp4Video {
  width: number;
  height: number;
  /** The AVCDecoderConfigurationRecord, as the encoder hands it over. */
  avcC: Uint8Array;
  samples: Mp4Sample[];
}

export interface Mp4Audio {
  channels: number;
  /** Samples the decoder throws away from the front, from the encoder's header. */
  preSkip: number;
  samples: Mp4Sample[];
}

export interface Mp4Input {
  video: Mp4Video;
  audio?: Mp4Audio | null;
  /** Where the clip ends: the last frame lasts until then. */
  endUs: number;
}

const MOVIE_TIMESCALE = 1000;
const VIDEO_TIMESCALE = 90_000;
const AUDIO_TIMESCALE = 48_000;
/** Samples are grouped into chunks of about this long, per track. */
const CHUNK_US = 1_000_000;

// ─── Bytes ──────────────────────────────────────────────────────────────────

const u8 = (n: number) => Uint8Array.of(n & 0xff);
const u16 = (n: number) => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n: number) => new Uint8Array(n);

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const p of parts) size += p.byteLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.byteLength), ascii(type), body]);
}

/** A "full box": a version byte and 24 bits of flags before the payload. */
function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version), u8(flags >>> 16), u16(flags & 0xffff), ...payload);
}

const MATRIX = concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
]);

// ─── Timing ─────────────────────────────────────────────────────────────────

interface TrackSample {
  data: Uint8Array;
  key: boolean;
  /** In the track's own timescale, counted from its first sample. */
  ticks: number;
  /** When it starts, for interleaving. */
  startUs: number;
}

/**
 * Durations that add up exactly: each sample lasts until the next one starts,
 * rounded from the same running total, so a rounding error never accumulates
 * over a thousand frames.
 */
function timeSamples(
  samples: Mp4Sample[],
  timescale: number,
  endUs: number,
): { items: TrackSample[]; durations: number[]; totalTicks: number } {
  const first = samples[0].ts;
  const toTicks = (us: number) => Math.round(((us - first) * timescale) / 1e6);
  const items: TrackSample[] = samples.map((s) => ({
    data: s.data,
    key: s.key,
    ticks: toTicks(s.ts),
    startUs: s.ts,
  }));
  const durations = items.map((s, i) => {
    const next = i + 1 < items.length ? items[i + 1].ticks : toTicks(endUs);
    return Math.max(1, next - s.ticks);
  });
  return { items, durations, totalTicks: durations.reduce((a, b) => a + b, 0) };
}

const runLengths = (values: number[]): Array<[count: number, value: number]> => {
  const runs: Array<[number, number]> = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  return runs;
};

/** Samples grouped into chunks of about a second, by when they start. */
function chunkSamples(items: TrackSample[]): TrackSample[][] {
  const chunks: TrackSample[][] = [];
  let current: TrackSample[] = [];
  let began = 0;
  for (const s of items) {
    if (current.length > 0 && s.startUs - began >= CHUNK_US) {
      chunks.push(current);
      current = [];
    }
    if (current.length === 0) began = s.startUs;
    current.push(s);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── Track description ──────────────────────────────────────────────────────

interface TrackPlan {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  durations: number[];
  totalTicks: number;
  items: TrackSample[];
  chunks: TrackSample[][];
  /** The sample entry (avc1 or Opus) inside the stsd. */
  entry: Uint8Array;
  width: number;
  height: number;
  /** Silence at the front, in the movie's timescale, as an empty edit. */
  leadMs: number;
}

function sampleTable(track: TrackPlan, chunkOffsets: number[]): Uint8Array {
  const timing = runLengths(track.durations);
  const stts = fullBox(
    "stts", 0, 0,
    u32(timing.length),
    ...timing.flatMap(([count, delta]) => [u32(count), u32(delta)]),
  );
  const syncs = track.items.flatMap((s, i) => (s.key ? [i + 1] : []));
  // Every audio sample is a sync sample, which is what leaving stss out means.
  const stss =
    track.kind === "video"
      ? fullBox("stss", 0, 0, u32(syncs.length), ...syncs.map(u32))
      : null;

  const perChunk = track.chunks.map((c) => c.length);
  const stscRuns: Array<[firstChunk: number, count: number]> = [];
  perChunk.forEach((count, i) => {
    if (stscRuns.length === 0 || stscRuns[stscRuns.length - 1][1] !== count) stscRuns.push([i + 1, count]);
  });
  const stsc = fullBox(
    "stsc", 0, 0,
    u32(stscRuns.length),
    ...stscRuns.flatMap(([first, count]) => [u32(first), u32(count), u32(1)]),
  );
  const stsz = fullBox(
    "stsz", 0, 0,
    u32(0), u32(track.items.length),
    ...track.items.map((s) => u32(s.data.byteLength)),
  );
  const stco = fullBox("stco", 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32));
  const stsd = fullBox("stsd", 0, 0, u32(1), track.entry);
  return box("stbl", stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco);
}

function trackBox(track: TrackPlan, chunkOffsets: number[]): Uint8Array {
  const movieTicks = Math.round((track.totalTicks * MOVIE_TIMESCALE) / track.timescale);
  const trackMs = track.leadMs + movieTicks;
  const tkhd = fullBox(
    "tkhd", 0, 3,
    u32(0), u32(0), u32(track.id), u32(0), u32(trackMs),
    zeros(8), u16(0), u16(0), u16(track.kind === "audio" ? 0x0100 : 0), u16(0),
    MATRIX,
    u32(track.width * 0x10000), u32(track.height * 0x10000),
  );
  // A track that starts after the movie does says so with an empty edit: media
  // time -1 is "show nothing", then the whole track follows.
  const edts =
    track.leadMs > 0
      ? box(
          "edts",
          fullBox(
            "elst", 0, 0,
            u32(2),
            u32(track.leadMs), u32(0xffffffff), u16(1), u16(0),
            u32(movieTicks), u32(0), u16(1), u16(0),
          ),
        )
      : null;
  const mdhd = fullBox(
    "mdhd", 0, 0,
    u32(0), u32(0), u32(track.timescale), u32(track.totalTicks), u16(0x55c4), u16(0),
  );
  const hdlr = fullBox(
    "hdlr", 0, 0,
    u32(0), ascii(track.kind === "video" ? "vide" : "soun"), zeros(12),
    ascii(track.kind === "video" ? "VideoHandler\0" : "SoundHandler\0"),
  );
  const mediaHeader =
    track.kind === "video"
      ? fullBox("vmhd", 0, 1, u16(0), zeros(6))
      : fullBox("smhd", 0, 0, u16(0), u16(0));
  const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
  const minf = box("minf", mediaHeader, dinf, sampleTable(track, chunkOffsets));
  return box("trak", tkhd, ...(edts ? [edts] : []), box("mdia", mdhd, hdlr, minf));
}

function avc1Entry(video: Mp4Video): Uint8Array {
  return box(
    "avc1",
    zeros(6), u16(1), // data reference
    zeros(16), // pre-defined, reserved
    u16(video.width), u16(video.height),
    u32(0x00480000), u32(0x00480000), // 72 dpi
    u32(0), u16(1), // one frame per sample
    zeros(32), // compressor name
    u16(0x0018), u16(0xffff),
    box("avcC", video.avcC),
  );
}

function opusEntry(audio: Mp4Audio): Uint8Array {
  return box(
    "Opus",
    zeros(6), u16(1),
    zeros(8),
    u16(audio.channels), u16(16), u16(0), u16(0),
    u32(AUDIO_TIMESCALE * 0x10000),
    box(
      "dOps",
      u8(0), u8(audio.channels), u16(audio.preSkip),
      u32(AUDIO_TIMESCALE), u16(0), u8(0),
    ),
  );
}

// ─── The file ───────────────────────────────────────────────────────────────

/**
 * The file's bytes as parts to hand to a `Blob`: the headers are new, and the
 * frames are the ones passed in, not copies.
 */
export function muxMp4(input: Mp4Input): Uint8Array[] {
  const { video, audio, endUs } = input;
  if (video.samples.length === 0) throw new Error("A clip needs at least one frame");
  const startUs = video.samples[0].ts;

  const v = timeSamples(video.samples, VIDEO_TIMESCALE, endUs);
  const tracks: TrackPlan[] = [
    {
      id: 1, kind: "video", timescale: VIDEO_TIMESCALE,
      durations: v.durations, totalTicks: v.totalTicks, items: v.items, chunks: chunkSamples(v.items),
      entry: avc1Entry(video), width: video.width, height: video.height, leadMs: 0,
    },
  ];
  if (audio && audio.samples.length > 0) {
    const a = timeSamples(audio.samples, AUDIO_TIMESCALE, audio.samples[audio.samples.length - 1].ts + audio.samples[audio.samples.length - 1].dur);
    // Sound that begins a little after the picture does is delayed to match.
    // One that began just before it is not pulled back: the difference is the
    // length of a packet at most.
    const leadMs = Math.max(0, Math.round((audio.samples[0].ts - startUs) / 1000));
    tracks.push({
      id: 2, kind: "audio", timescale: AUDIO_TIMESCALE,
      durations: a.durations, totalTicks: a.totalTicks, items: a.items, chunks: chunkSamples(a.items),
      entry: opusEntry(audio), width: 0, height: 0, leadMs,
    });
  }

  // The order of the data: every chunk of every track, by when it starts.
  const layout = tracks
    .flatMap((track, trackIndex) => track.chunks.map((samples, chunkIndex) => ({ trackIndex, chunkIndex, samples })))
    .sort((x, y) => x.samples[0].startUs - y.samples[0].startUs || x.trackIndex - y.trackIndex);

  const ftyp = box("ftyp", ascii("isom"), u32(512), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));

  const buildMoov = (offsets: number[][]): Uint8Array => {
    const movieMs = Math.max(
      ...tracks.map((t) => t.leadMs + Math.round((t.totalTicks * MOVIE_TIMESCALE) / t.timescale)),
    );
    const mvhd = fullBox(
      "mvhd", 0, 0,
      u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(movieMs),
      u32(0x00010000), u16(0x0100), u16(0), zeros(8),
      MATRIX, zeros(24), u32(tracks.length + 1),
    );
    return box("moov", mvhd, ...tracks.map((t, i) => trackBox(t, offsets[i])));
  };

  // The index comes first, and its size does not depend on the offsets in it,
  // so it is built once with placeholders to learn where the data begins.
  const placeholder = tracks.map((t) => t.chunks.map(() => 0));
  const dataStart = ftyp.byteLength + buildMoov(placeholder).byteLength + 8;

  const offsets = tracks.map((t) => t.chunks.map(() => 0));
  const body: Uint8Array[] = [];
  let at = dataStart;
  for (const { trackIndex, chunkIndex, samples } of layout) {
    offsets[trackIndex][chunkIndex] = at;
    for (const s of samples) {
      body.push(s.data);
      at += s.data.byteLength;
    }
  }

  return [ftyp, buildMoov(offsets), concat([u32(at - dataStart + 8), ascii("mdat")]), ...body];
}
