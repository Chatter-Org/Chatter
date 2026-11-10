import { describe, it, expect } from "vitest";
import { avcCodecStrings, avcLevel, chooseClipProfile } from "../profile";

describe("chooseClipProfile", () => {
  it("leaves a 1080p share at 1080p and holds software to 30 fps", () => {
    const p = chooseClipProfile({ width: 1920, height: 1080 }, { hardware: false, sourceFps: 60 });
    expect(p).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    // About 8 Mbps: enough for a game, not enough to fill a channel's quota.
    expect(p.bitrate).toBeGreaterThan(7_000_000);
    expect(p.bitrate).toBeLessThan(9_000_000);
  });

  it("follows a 60 fps share when a hardware encoder takes it", () => {
    const p = chooseClipProfile({ width: 1920, height: 1080 }, { hardware: true, sourceFps: 60 });
    expect(p.fps).toBe(60);
    expect(p.bitrate).toBe(12_000_000);
  });

  it("does not raise a 30 fps share to 60 because the encoder could", () => {
    expect(chooseClipProfile({ width: 1920, height: 1080 }, { hardware: true, sourceFps: 30 }).fps).toBe(30);
    // A received share does not say; it is taken for 30.
    expect(chooseClipProfile({ width: 1920, height: 1080 }, { hardware: true }).fps).toBe(30);
    expect(chooseClipProfile({ width: 1920, height: 1080 }, { hardware: true, sourceFps: null }).fps).toBe(30);
  });

  it("shrinks a bigger picture into 1080p without bending it", () => {
    const p = chooseClipProfile({ width: 3840, height: 2160 }, { hardware: false });
    expect(p).toMatchObject({ width: 1920, height: 1080 });
    const wide = chooseClipProfile({ width: 3440, height: 1440 }, { hardware: false });
    expect(wide.width).toBe(1920);
    expect(wide.height).toBe(802);
    expect(Math.abs(wide.width / wide.height - 3440 / 1440)).toBeLessThan(0.01);
  });

  it("never enlarges a small window, and keeps both sides even", () => {
    const p = chooseClipProfile({ width: 801, height: 601 }, { hardware: false });
    expect(p.width).toBe(800);
    expect(p.height).toBe(600);
    expect(chooseClipProfile({ width: 640, height: 360 }, { hardware: false })).toMatchObject({
      width: 640,
      height: 360,
    });
  });

  it("scales the bitrate with the picture, between a floor and a ceiling", () => {
    const small = chooseClipProfile({ width: 320, height: 180 }, { hardware: false });
    const mid = chooseClipProfile({ width: 1280, height: 720 }, { hardware: false });
    expect(small.bitrate).toBe(1_500_000);
    expect(mid.bitrate).toBeGreaterThan(3_000_000);
    expect(mid.bitrate).toBeLessThan(4_000_000);
  });

  it("copes with a tall window", () => {
    const p = chooseClipProfile({ width: 600, height: 2400 }, { hardware: false });
    expect(p.height).toBe(1080);
    expect(p.width).toBe(270);
  });
});

describe("avcLevel", () => {
  it("names the level 1080p30 needs, and the one 1080p60 needs", () => {
    expect(avcLevel(1920, 1080, 30)).toBe(0x28); // 4.0
    expect(avcLevel(1920, 1080, 60)).toBe(0x2a); // 4.2
  });

  it("takes smaller pictures at lower levels", () => {
    expect(avcLevel(1280, 720, 30)).toBe(0x1f); // 3.1
    expect(avcLevel(1280, 720, 60)).toBe(0x20); // 3.2
  });
});

describe("avcCodecStrings", () => {
  it("lists High, Main, then Baseline, each at the right level", () => {
    const strings = avcCodecStrings({ width: 1920, height: 1080, fps: 60, bitrate: 1 });
    expect(strings).toEqual(["avc1.64002a", "avc1.4d002a", "avc1.42e02a"]);
  });
});
