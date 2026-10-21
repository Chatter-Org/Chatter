import { describe, it, expect } from "vitest";
import {
  decodeChannelLinks,
  encodeChannelLinks,
  findChannelMatches,
  plainChannelLinks,
  type LinkableChannel,
} from "@/lib/channelLinks";

const channels: LinkableChannel[] = [
  { channel_id: "#_gen", name: "general", channel_type: "text" },
  { channel_id: "#_gc", name: "general chat", channel_type: "text" },
  { channel_id: "#_mem", name: "memes", channel_type: "text" },
];

describe("encodeChannelLinks", () => {
  it("turns a channel's name into its id", () => {
    expect(encodeChannelLinks("see #memes!", channels)).toBe("see <##_mem>!");
    expect(encodeChannelLinks("#MEMES", channels)).toBe("<##_mem>");
  });

  it("prefers the longest name, so names may hold spaces", () => {
    expect(encodeChannelLinks("#general chat now", channels)).toBe("<##_gc> now");
    expect(encodeChannelLinks("#general now", channels)).toBe("<##_gen> now");
  });

  it("needs a whole name and a # that starts a word", () => {
    expect(encodeChannelLinks("#generally", channels)).toBe("#generally");
    expect(encodeChannelLinks("a#memes", channels)).toBe("a#memes");
    expect(encodeChannelLinks("http://x.io/#memes", channels)).toBe("http://x.io/#memes");
    expect(encodeChannelLinks("#nope", channels)).toBe("#nope");
  });

  it("leaves fenced code alone", () => {
    const text = "```\n#memes\n``` #memes";
    expect(encodeChannelLinks(text, channels)).toBe("```\n#memes\n``` <##_mem>");
  });
});

describe("reading links back", () => {
  it("names a channel the reader can see and hides one they cannot", () => {
    const body = "<##_mem> and <##_secret>";
    expect(plainChannelLinks(body, channels)).toBe("#memes and #unknown");
  });

  it("decodes for editing without losing a link the editor cannot resolve", () => {
    const body = "<##_mem> and <##_secret>";
    expect(decodeChannelLinks(body, channels)).toBe("#memes and <##_secret>");
    expect(encodeChannelLinks(decodeChannelLinks(body, channels), channels)).toBe(body);
  });
});

describe("findChannelMatches", () => {
  it("lists prefix matches before substring ones", () => {
    expect(findChannelMatches(channels, "me").map((c) => c.name)).toEqual(["memes"]);
    expect(findChannelMatches(channels, "chat").map((c) => c.name)).toEqual(["general chat"]);
  });
});
