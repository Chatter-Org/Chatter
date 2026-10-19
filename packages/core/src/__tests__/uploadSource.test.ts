import { describe, expect, it } from "vitest";
import { fingerprintFile, toUploadSource, type UploadSource } from "../uploadResume";

describe("toUploadSource", () => {
  it("wraps a browser File so the web sends exactly what it always did", async () => {
    const file = new File(["hello world"], "note.txt", { type: "text/plain", lastModified: 42 });
    const source = toUploadSource(file);
    expect(source).toMatchObject({ name: "note.txt", size: 11, lastModified: 42 });
    expect(source.part()).toBe(file);
    const chunk = (await source.chunk(6, 11)) as Blob;
    expect(await chunk.text()).toBe("world");
  });

  it("passes a native source through untouched", () => {
    const native: UploadSource = {
      name: "clip.mp4",
      size: 3,
      part: () => ({ uri: "file:///clip.mp4", name: "clip.mp4", type: "video/mp4" }),
      chunk: async () => ({ uri: "file:///chunk", name: "clip.mp4", type: "application/octet-stream" }),
    };
    expect(toUploadSource(native)).toBe(native);
  });

  it("fingerprints a native source the way it fingerprints a File", () => {
    const file = new File(["abc"], "a.bin", { lastModified: 7 });
    expect(fingerprintFile({ name: "a.bin", size: 3, lastModified: 7 })).toBe(fingerprintFile(file));
  });
});
