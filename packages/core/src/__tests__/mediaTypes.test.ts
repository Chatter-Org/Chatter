import { describe, expect, it } from "vitest";
import { videoPlaybackUrl } from "../mediaTypes";

const FOLDER = "0123456789abcdef0123456789abcdef";

describe("videoPlaybackUrl", () => {
  it("gives every upload the server rewrites a cache key the year-long cached copy does not have", () => {
    for (const name of ["clip.webm", "clip.mp4", "phone.MOV", "a.m4v", "rip.mkv", "old.avi", "a.wmv", "a.flv", "b.ts"]) {
      expect(videoPlaybackUrl(`https://x/external/${FOLDER}/${name}`)).toBe(
        `https://x/external/${FOLDER}/${name}?cache=2`,
      );
      expect(videoPlaybackUrl(`/external/${FOLDER}/${name}`)).toBe(`/external/${FOLDER}/${name}?cache=2`);
    }
  });

  it("keeps a query and a fragment the URL already had", () => {
    expect(videoPlaybackUrl(`/external/${FOLDER}/clip.WEBM?t=1`)).toBe(`/external/${FOLDER}/clip.WEBM?t=1&cache=2`);
    expect(videoPlaybackUrl(`/external/${FOLDER}/clip.mp4#t=5`)).toBe(`/external/${FOLDER}/clip.mp4?cache=2#t=5`);
  });

  it("leaves sidecars, encrypted uploads and other servers' videos alone", () => {
    for (const url of [
      `/external/${FOLDER}/a.webm.thumb.jpg`,
      `/external/${FOLDER}/a.mp4@subs.json`,
      `/external/${FOLDER}/random.enc`,
      `/external/${FOLDER}/song.ogg`,
      "/external/not-a-folder/clip.mp4",
      "https://cdn.example.com/clip.mp4?sig=abc",
      "https://example.com/videos/clip.webm",
    ]) {
      expect(videoPlaybackUrl(url)).toBe(url);
    }
  });
});
