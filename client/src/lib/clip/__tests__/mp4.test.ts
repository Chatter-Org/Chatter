import { describe, it, expect } from "vitest";
import { muxMp4, type Mp4Sample } from "../mp4";

// A small reader for the boxes a player walks, so the file is checked the way
// one would read it rather than against its own writer.
interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
  children: Box[];
}
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts"]);

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let at = start;
  while (at < end) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(
      view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7),
    );
    expect(size).toBeGreaterThanOrEqual(8);
    const box: Box = { type, start: at, end: at + size, body: at + 8, children: [] };
    if (CONTAINERS.has(type)) box.children = readBoxes(view, box.body, box.end);
    boxes.push(box);
    at += size;
  }
  expect(at).toBe(end);
  return boxes;
}

const find = (boxes: Box[], type: string) => boxes.find((b) => b.type === type)!;
const merged = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

/** A frame whose bytes name it, so a lookup by offset can tell them apart. */
const frame = (label: number, ts: number, key: boolean, size = 10): Mp4Sample => ({
  data: new Uint8Array(size).fill(label),
  ts,
  dur: 0,
  key,
});

const AVCC = Uint8Array.of(1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0);

interface Track {
  handler: string;
  timescale: number;
  duration: number;
  sizes: number[];
  syncs: number[] | null;
  offsets: number[];
  perChunk: number[];
  stts: Array<[number, number]>;
  edit: number[][] | null;
  tkhdDuration: number;
}

function readTrack(view: DataView, trak: Box): Track {
  const mdia = find(trak.children, "mdia");
  const mdhd = find(mdia.children, "mdhd");
  const hdlr = find(mdia.children, "hdlr");
  const stbl = find(find(mdia.children, "minf").children, "stbl");
  const get = (type: string) => stbl.children.find((b) => b.type === type);

  const stsz = get("stsz")!;
  const count = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => view.getUint32(stsz.body + 12 + i * 4));

  const stss = get("stss");
  const syncs = stss
    ? Array.from({ length: view.getUint32(stss.body + 4) }, (_, i) => view.getUint32(stss.body + 8 + i * 4))
    : null;

  const stco = get("stco")!;
  const offsets = Array.from({ length: view.getUint32(stco.body + 4) }, (_, i) => view.getUint32(stco.body + 8 + i * 4));

  const stsc = get("stsc")!;
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => [
    view.getUint32(stsc.body + 8 + i * 12),
    view.getUint32(stsc.body + 12 + i * 12),
  ]);
  const perChunk: number[] = [];
  for (let chunk = 1; chunk <= offsets.length; chunk++) {
    const run = [...runs].reverse().find(([first]) => first <= chunk)!;
    perChunk.push(run[1]);
  }

  const stts = get("stts")!;
  const sttsRuns = Array.from({ length: view.getUint32(stts.body + 4) }, (_, i) => [
    view.getUint32(stts.body + 8 + i * 8),
    view.getUint32(stts.body + 12 + i * 8),
  ] as [number, number]);

  const edts = trak.children.find((b) => b.type === "edts");
  const edit = edts
    ? (() => {
        const elst = find(edts.children, "elst");
        return Array.from({ length: view.getUint32(elst.body + 4) }, (_, i) => [
          view.getUint32(elst.body + 8 + i * 12),
          view.getInt32(elst.body + 12 + i * 12),
        ]);
      })()
    : null;

  const tkhd = find(trak.children, "tkhd");
  return {
    handler: String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(hdlr.body + 8 + i))),
    timescale: view.getUint32(mdhd.body + 12),
    duration: view.getUint32(mdhd.body + 16),
    sizes,
    syncs,
    offsets,
    perChunk,
    stts: sttsRuns,
    edit,
    tkhdDuration: view.getUint32(tkhd.body + 20),
  };
}

function parse(parts: Uint8Array[]) {
  const bytes = merged(parts);
  const view = new DataView(bytes.buffer);
  const top = readBoxes(view, 0, bytes.byteLength);
  const moov = find(top, "moov");
  const tracks = moov.children.filter((b) => b.type === "trak").map((t) => readTrack(view, t));
  const mvhd = find(moov.children, "mvhd");
  return {
    bytes,
    top,
    tracks,
    movieTimescale: view.getUint32(mvhd.body + 12),
    movieDuration: view.getUint32(mvhd.body + 16),
  };
}

/** 30 frames a second with a keyframe every `gop`. */
function video(count: number, gop = 10, startUs = 5_000_000) {
  return Array.from({ length: count }, (_, i) =>
    frame(i + 1, startUs + Math.round((i * 1e6) / 30), i % gop === 0, 10 + i),
  );
}

describe("muxMp4", () => {
  it("writes ftyp, then the index, then the data", () => {
    const frames = video(30);
    const { top } = parse(
      muxMp4({ video: { width: 1280, height: 720, avcC: AVCC, samples: frames }, endUs: 6_000_000 }),
    );
    expect(top.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
  });

  it("has a track whose sizes, key frames and length describe the frames", () => {
    const frames = video(30);
    const { tracks, movieTimescale, movieDuration } = parse(
      muxMp4({ video: { width: 1280, height: 720, avcC: AVCC, samples: frames }, endUs: 6_000_000 }),
    );
    expect(tracks).toHaveLength(1);
    const [v] = tracks;
    expect(v.handler).toBe("vide");
    expect(v.sizes).toEqual(frames.map((f) => f.data.byteLength));
    // Frames 1, 11 and 21 start a group.
    expect(v.syncs).toEqual([1, 11, 21]);
    // A second of footage: 90000 ticks of the media clock, 1000 ms of the movie's.
    expect(v.duration).toBe(90_000);
    expect(v.stts.reduce((n, [count, delta]) => n + count * delta, 0)).toBe(90_000);
    expect(movieTimescale).toBe(1000);
    expect(movieDuration).toBe(1000);
    expect(v.tkhdDuration).toBe(1000);
  });

  it("lets the last frame last until the clip ends", () => {
    // A still screen: one frame, and the clip ends four seconds later.
    const { tracks, movieDuration } = parse(
      muxMp4({
        video: { width: 640, height: 360, avcC: AVCC, samples: [frame(1, 1_000_000, true)] },
        endUs: 5_000_000,
      }),
    );
    expect(tracks[0].stts).toEqual([[1, 360_000]]);
    expect(movieDuration).toBe(4000);
  });

  it("does not let rounding build up over a long run of frames", () => {
    // 59.94 fps frames do not land on whole ticks; the total still must.
    const frames = Array.from({ length: 600 }, (_, i) => frame(1, Math.round((i * 1e6 * 1001) / 60000), i === 0, 4));
    const endUs = Math.round((600 * 1e6 * 1001) / 60000);
    const { tracks } = parse(
      muxMp4({ video: { width: 640, height: 360, avcC: AVCC, samples: frames }, endUs }),
    );
    const total = tracks[0].stts.reduce((n, [count, delta]) => n + count * delta, 0);
    expect(total).toBe(Math.round((endUs * 90_000) / 1e6));
  });

  it("points every chunk at its own bytes in the data", () => {
    const frames = video(90, 30);
    const { bytes, tracks, top } = parse(
      muxMp4({ video: { width: 1280, height: 720, avcC: AVCC, samples: frames }, endUs: 8_000_000 }),
    );
    const [v] = tracks;
    expect(v.perChunk.reduce((a, b) => a + b, 0)).toBe(90);
    // Three seconds in chunks of a second.
    expect(v.offsets).toHaveLength(3);
    const mdat = top.find((b) => b.type === "mdat")!;
    let sample = 0;
    v.offsets.forEach((offset, chunk) => {
      let at = offset;
      for (let i = 0; i < v.perChunk[chunk]; i++, sample++) {
        expect(at).toBeGreaterThanOrEqual(mdat.body);
        expect(at + v.sizes[sample]).toBeLessThanOrEqual(mdat.end);
        expect(bytes[at]).toBe(sample + 1);
        expect(bytes[at + v.sizes[sample] - 1]).toBe(sample + 1);
        at += v.sizes[sample];
      }
    });
  });

  it("adds an Opus track, interleaved, whose data is found where it says", () => {
    const frames = video(60, 30);
    const packets: Mp4Sample[] = Array.from({ length: 100 }, (_, i) => ({
      data: new Uint8Array(20).fill(200 + (i % 50)),
      ts: 5_000_000 + i * 20_000,
      dur: 20_000,
      key: true,
    }));
    const { bytes, tracks, movieDuration } = parse(
      muxMp4({
        video: { width: 1280, height: 720, avcC: AVCC, samples: frames },
        audio: { channels: 2, preSkip: 312, samples: packets },
        endUs: 7_000_000,
      }),
    );
    expect(tracks.map((t) => t.handler)).toEqual(["vide", "soun"]);
    const [v, a] = tracks;
    expect(a.timescale).toBe(48_000);
    expect(a.syncs).toBeNull();
    expect(a.sizes).toHaveLength(100);
    expect(a.duration).toBe(100 * 960);
    expect(a.edit).toBeNull();
    expect(movieDuration).toBe(2000);

    // Chunks of the two tracks alternate in the data, earliest first.
    const all = [
      ...v.offsets.map((offset) => ({ offset, track: "v" })),
      ...a.offsets.map((offset) => ({ offset, track: "a" })),
    ].sort((x, y) => x.offset - y.offset);
    expect(all.map((c) => c.track).join("")).toBe("vava");
    // And the first audio chunk really holds audio.
    expect(bytes[a.offsets[0]]).toBe(200);
    expect(bytes[v.offsets[0]]).toBe(1);
  });

  it("delays sound that began after the picture with an empty edit", () => {
    const frames = video(60, 30);
    const packets: Mp4Sample[] = Array.from({ length: 50 }, (_, i) => ({
      data: new Uint8Array(8).fill(9),
      // 400 ms after the first frame.
      ts: 5_400_000 + i * 20_000,
      dur: 20_000,
      key: true,
    }));
    const { tracks } = parse(
      muxMp4({
        video: { width: 1280, height: 720, avcC: AVCC, samples: frames },
        audio: { channels: 2, preSkip: 312, samples: packets },
        endUs: 7_000_000,
      }),
    );
    const a = tracks[1];
    // Nothing for 400 ms (media time -1), then the audio from its start.
    expect(a.edit).toEqual([
      [400, -1],
      [1000, 0],
    ]);
    expect(a.tkhdDuration).toBe(1400);
  });

  it("keeps a gap in the sound as a gap", () => {
    const frames = video(60, 30);
    const at = (ms: number) => 5_000_000 + ms * 1000;
    const packets: Mp4Sample[] = [0, 20, 40, 540, 560].map((ms) => ({
      data: new Uint8Array(8).fill(9),
      ts: at(ms),
      dur: 20_000,
      key: true,
    }));
    const { tracks } = parse(
      muxMp4({
        video: { width: 1280, height: 720, avcC: AVCC, samples: frames },
        audio: { channels: 2, preSkip: 312, samples: packets },
        endUs: 7_000_000,
      }),
    );
    // The packet before the gap lasts until the next one starts: 500 ms at
    // 48 kHz, so everything after it still lands where it was heard.
    const durations = tracks[1].stts.flatMap(([count, delta]) => Array(count).fill(delta));
    expect(durations).toEqual([960, 960, 24_000, 960, 960]);
  });

  it("refuses to make a clip of nothing", () => {
    expect(() =>
      muxMp4({ video: { width: 640, height: 360, avcC: AVCC, samples: [] }, endUs: 1 }),
    ).toThrow();
  });
});
