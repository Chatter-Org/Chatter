import { describe, it, expect } from "vitest";
import { contrastRatio, readableOn } from "@/lib/color";

const LIGHT = "#ffffff";
const LIGHT_CARD = "#f4f4f5";
const DARK = "#0a0a0a";
const DARK_CARD = "#171717";

describe("readableOn", () => {
  it("leaves a colour that already reads alone", () => {
    expect(readableOn("#1d4ed8", [LIGHT])).toBe("#1d4ed8");
    expect(readableOn("#facc15", [DARK])).toBe("#facc15");
  });

  it("darkens a pale dark-theme colour for a light theme, on every surface", () => {
    for (const hex of ["#facc15", "#4ade80", "#9ca3af", "#60a5fa", "#f87171"]) {
      const out = readableOn(hex, [LIGHT, LIGHT_CARD]);
      expect(contrastRatio(out, LIGHT)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(out, LIGHT_CARD)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("lightens a deep light-theme colour for a dark theme", () => {
    for (const hex of ["#1e3a8a", "#7f1d1d", "#14532d", "#000080"]) {
      const out = readableOn(hex, [DARK, DARK_CARD]);
      expect(contrastRatio(out, DARK_CARD)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("moves no further than it has to", () => {
    // Just short of the target should come back just past it, not as black.
    const out = readableOn("#4ade80", [LIGHT]);
    expect(contrastRatio(out, LIGHT)).toBeLessThan(5.2);
  });

  it("keeps the hue: a blue stays blue", () => {
    const out = readableOn("#93c5fd", [LIGHT]);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(out.slice(i, i + 2), 16));
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });

  it("honours a lower target for borders", () => {
    const out = readableOn("#facc15", [LIGHT], 3);
    expect(contrastRatio(out, LIGHT)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(out, LIGHT)).toBeLessThan(4.5);
  });

  it("passes through what is not a hex colour", () => {
    expect(readableOn("rebeccapurple", [LIGHT])).toBe("rebeccapurple");
    expect(readableOn("#fc0", [LIGHT])).not.toBe("#fc0");
  });
});
