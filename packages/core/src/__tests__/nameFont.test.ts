/**
 * The client's copy of the server's `valid_name_font_url` rule. The cases are
 * the server's own (helpers.rs): what an upload answers with must pass, and an
 * escape from the CSS string must not, whatever the server once let through.
 */
import { describe, it, expect } from "vitest";
import { isSafeNameFontUrl } from "../nameFont";

describe("isSafeNameFontUrl", () => {
  it("accepts what an upload answers with", () => {
    expect(isSafeNameFontUrl("/external/a1b2/My%20Font.woff2")).toBe(true);
    expect(isSafeNameFontUrl("https://chat.example/external/a1b2/font.ttf")).toBe(true);
    expect(isSafeNameFontUrl("http://localhost:8000/external/a1b2/font.otf")).toBe(true);
  });

  it("rejects an escape from the CSS string", () => {
    expect(isSafeNameFontUrl("/external/a/f.ttf'); } :root { --x: url('https://evil/x")).toBe(false);
    expect(isSafeNameFontUrl('/external/a/f.ttf") x')).toBe(false);
    expect(isSafeNameFontUrl("/external/a/f ttf")).toBe(false);
  });

  it("rejects anything outside /external/", () => {
    expect(isSafeNameFontUrl("/api/me")).toBe(false);
    expect(isSafeNameFontUrl("/external/../api/x.ttf")).toBe(false);
    expect(isSafeNameFontUrl("https://elsewhere.example/font.ttf")).toBe(false);
  });

  it("treats nothing as no font", () => {
    expect(isSafeNameFontUrl("")).toBe(false);
    expect(isSafeNameFontUrl(undefined)).toBe(false);
    expect(isSafeNameFontUrl(`/external/${"a".repeat(520)}.ttf`)).toBe(false);
  });
});
