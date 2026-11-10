import { describe, it, expect } from "vitest";
import { ClipRing, type RingSample } from "../ring";

const SEC = 1_000_000;

const frame = (ts: number, key: boolean, size = 100): RingSample => ({
  data: new Uint8Array(size),
  ts,
  dur: 0,
  key,
});
const packet = (ts: number): RingSample => ({ data: new Uint8Array(10), ts, dur: 20_000, key: true });

/** 30 fps with a keyframe every 2 s, for `secs` seconds from `from`. */
function feed(ring: ClipRing, secs: number, from = 0) {
  const frames = secs * 30;
  for (let i = 0; i < frames; i++) {
    const ts = from + Math.round((i * SEC) / 30);
    ring.addVideo(frame(ts, i % 60 === 0), ts);
  }
}

describe("ClipRing", () => {
  it("holds everything while the window is not yet full", () => {
    const ring = new ClipRing(30 * SEC);
    feed(ring, 10);
    const snap = ring.snapshot(10 * SEC)!;
    expect(snap.video).toHaveLength(300);
    expect(snap.startTs).toBe(0);
    expect(ring.coverageUs(10 * SEC)).toBe(10 * SEC);
  });

  it("keeps the whole window, and no more than one group extra", () => {
    const ring = new ClipRing(30 * SEC);
    feed(ring, 100);
    const now = 100 * SEC;
    const snap = ring.snapshot(now)!;
    const span = (now - snap.startTs) / SEC;
    expect(span).toBeGreaterThanOrEqual(30);
    // The group before the cut is kept only because the window is not yet
    // behind the next one, so a group is the most it can run over by.
    expect(span).toBeLessThanOrEqual(32);
  });

  it("always starts a clip on a keyframe", () => {
    const ring = new ClipRing(15 * SEC);
    for (const total of [20, 33, 47, 61]) {
      const r = new ClipRing(15 * SEC);
      feed(r, total);
      expect(r.snapshot(total * SEC)!.video[0].key).toBe(true);
    }
    feed(ring, 40);
    expect(ring.snapshot(40 * SEC)!.video[0].key).toBe(true);
  });

  it("drops frames that arrive before any keyframe", () => {
    const ring = new ClipRing(30 * SEC);
    ring.addVideo(frame(0, false), 0);
    ring.addVideo(frame(33_000, false), 33_000);
    expect(ring.hasVideo).toBe(false);
    expect(ring.snapshot(SEC)).toBeNull();
    ring.addVideo(frame(66_000, true), 66_000);
    expect(ring.snapshot(SEC)!.video).toHaveLength(1);
  });

  it("measures the window to now, and keeps the last keyframe before it", () => {
    const ring = new ClipRing(30 * SEC);
    feed(ring, 10);
    // Nothing is drawn for a minute, then the screen is redrawn. The window
    // opened at 40 s and no keyframe falls after that but this new one at 70:
    // the clip must start on one, so the last before the window is kept (the
    // group at 8 s, whose picture is the one on screen throughout) and the
    // older groups go.
    ring.addVideo(frame(70 * SEC, true), 70 * SEC);
    const snap = ring.snapshot(70 * SEC)!;
    expect(snap.startTs).toBe(8 * SEC);
    expect(snap.video[snap.video.length - 1].ts).toBe(70 * SEC);
    expect(snap.video.length).toBe(60 + 1); // the group at 8 s, and the new key
  });

  it("releases the bytes of what it drops", () => {
    const ring = new ClipRing(10 * SEC);
    feed(ring, 60);
    // 12 s of 100-byte frames at most, never the whole minute.
    expect(ring.bytes).toBeLessThanOrEqual(12 * 30 * 100);
    expect(ring.bytes).toBeGreaterThanOrEqual(10 * 30 * 100);
  });

  it("keeps sound only as far back as the picture", () => {
    const ring = new ClipRing(10 * SEC);
    for (let i = 0; i < 60 * 50; i++) {
      const ts = i * 20_000;
      ring.addAudio(packet(ts), ts);
      if (i % 2 === 0) {
        const vts = Math.round(((i / 2) * SEC) / 25);
        ring.addVideo(frame(vts, (i / 2) % 50 === 0), vts);
      }
    }
    const snap = ring.snapshot(60 * SEC)!;
    expect(snap.audio[0].ts + snap.audio[0].dur).toBeGreaterThan(snap.startTs);
    // Within a packet of the picture's start.
    expect(snap.startTs - snap.audio[0].ts).toBeLessThanOrEqual(20_000);
    expect(snap.audio.length).toBeLessThan(13 * 50);
  });

  it("holds sound to a window when no picture ever comes", () => {
    const ring = new ClipRing(10 * SEC);
    for (let i = 0; i < 120 * 50; i++) ring.addAudio(packet(i * 20_000), i * 20_000);
    expect(ring.bytes).toBeLessThanOrEqual(10 * 50 * 10 + 10);
    expect(ring.snapshot(120 * SEC)).toBeNull();
  });

  it("cuts the sound at the end of the clip", () => {
    const ring = new ClipRing(30 * SEC);
    feed(ring, 5);
    for (let i = 0; i < 300; i++) ring.addAudio(packet(i * 20_000), i * 20_000);
    const snap = ring.snapshot(4 * SEC)!;
    expect(snap.audio[snap.audio.length - 1].ts).toBeLessThan(4 * SEC);
  });

  it("follows a window that changes", () => {
    const ring = new ClipRing(60 * SEC);
    feed(ring, 100);
    ring.setWindow(15 * SEC);
    ring.trim(100 * SEC);
    const span = (100 * SEC - ring.snapshot(100 * SEC)!.startTs) / SEC;
    expect(span).toBeGreaterThanOrEqual(15);
    expect(span).toBeLessThan(17);
  });

  it("starts over when cleared", () => {
    const ring = new ClipRing(30 * SEC);
    feed(ring, 5);
    ring.clear();
    expect(ring.hasVideo).toBe(false);
    expect(ring.bytes).toBe(0);
    expect(ring.coverageUs(5 * SEC)).toBe(0);
  });
});
