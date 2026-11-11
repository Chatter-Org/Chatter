import { describe, expect, it } from "vitest";
import { videoPlaybackUrl } from "../mediaTypes";

describe("videoPlaybackUrl", () => {
  it("gives a WebM a cache key the year-long cached copy does not have", () => {
    expect(videoPlaybackUrl("https://x/external/abc/clip.webm")).toBe("https://x/external/abc/clip.webm?indexed=1");
    expect(videoPlaybackUrl("/external/abc/clip.WEBM?t=1")).toBe("/external/abc/clip.WEBM?t=1&indexed=1");
  });

  it("leaves every other video alone", () => {
    for (const url of ["/external/abc/clip.mp4", "/external/abc/a.webm.thumb.jpg", "/external/abc/a.mov"]) {
      expect(videoPlaybackUrl(url)).toBe(url);
    }
  });
});
