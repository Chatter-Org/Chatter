import { beforeEach, describe, expect, it } from "vitest";
import { configureHost } from "../platform";
import { extractMedia, groupsWith, parseBody, parseInline, plainText, startsNewDay } from "../messageFormat";
import type { MatrixMessage } from "../api";

beforeEach(() => configureHost({ origin: () => "https://chatter.example" }));

describe("parseInline", () => {
  it("reads bold, italic and strobe, nested", () => {
    expect(parseInline("a **b _c_** %%%d%%%")).toEqual([
      { type: "text", text: "a " },
      { type: "bold", children: [{ type: "text", text: "b " }, { type: "italic", children: [{ type: "text", text: "c" }] }] },
      { type: "text", text: " " },
      { type: "strobe", children: [{ type: "text", text: "d" }] },
    ]);
  });

  it("leaves underscores inside words alone", () => {
    expect(parseInline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
  });

  it("never reads a style out of a URL", () => {
    expect(parseInline("see https://x.example/_a_b_ ok")).toEqual([
      { type: "text", text: "see " },
      { type: "link", url: "https://x.example/_a_b_", display: "https://x.example/_a_b_" },
      { type: "text", text: " ok" },
    ]);
  });

  it("shortens a long link for display", () => {
    const url = "https://x.example/" + "a".repeat(80);
    const [node] = parseInline(url);
    expect(node).toMatchObject({ type: "link", url });
    expect((node as { display: string }).display).toHaveLength(60);
  });

  it("drops media, uploads and message links from the text: they draw as cards", () => {
    expect(parseInline("look https://x.example/cat.png and https://chatter.example/m/%24abc")).toEqual([
      { type: "text", text: "look  and " },
    ]);
  });

  it("tells the reader's own mention from someone else's, and a role from a user", () => {
    const nodes = parseInline("@alice @bob @mods", {
      currentUserId: "@alice:chatter.example",
      roleColors: new Map([["mods", "#ff0000"]]),
    });
    expect(nodes.filter((n) => n.type === "mention")).toEqual([
      { type: "mention", name: "alice", kind: "user", self: true, color: "" },
      { type: "mention", name: "bob", kind: "user", self: false, color: "" },
      { type: "mention", name: "mods", kind: "role", self: false, color: "#ff0000" },
    ]);
  });

  it("refuses a role colour that is not a plain colour", () => {
    const [node] = parseInline("@mods", { roleColors: new Map([["mods", "red;background:url(x)"]]) });
    expect(node).toMatchObject({ kind: "role", color: "" });
  });

  it("reads custom emoji, with the room's alias", () => {
    expect(parseInline("hi :emoji{/external/a/b.png}:", { emojiAliases: { "/external/a/b.png": "wave" } })).toEqual([
      { type: "text", text: "hi " },
      { type: "emoji", url: "/external/a/b.png", alias: "wave" },
    ]);
  });
});

describe("parseBody", () => {
  it("splits out code blocks, with their language", () => {
    expect(parseBody("before\n```ts\nconst a = 1;\n```\nafter")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "before\n" }] },
      { type: "code", code: "const a = 1;\n", language: "ts" },
      { type: "paragraph", children: [{ type: "text", text: "\nafter" }] },
    ]);
  });

  it("does not format inside a code block", () => {
    expect(parseBody("```\n**not bold**\n```")).toEqual([{ type: "code", code: "**not bold**\n", language: undefined }]);
  });
});

describe("extractMedia", () => {
  it("sorts a body's URLs by how each is drawn", () => {
    const media = extractMedia(
      "https://x.example/a.jpg https://x.example/b.mp4 https://x.example/c.mp3 " +
        "https://chatter.example/external/abc/doc.pdf https://youtu.be/dQw4w9WgXcQ https://github.com " +
        ":emoji{https://x.example/e.png}:",
    );
    expect(media).toMatchObject({
      images: ["https://x.example/a.jpg"],
      videos: ["https://x.example/b.mp4"],
      audios: ["https://x.example/c.mp3"],
      files: ["https://chatter.example/external/abc/doc.pdf"],
      youtubeIds: ["dQw4w9WgXcQ"],
      links: ["https://github.com"],
    });
  });
});

describe("timeline", () => {
  const msg = (sender: string, ts: number, msgtype = "m.text") =>
    ({ event_id: `$${ts}`, sender, origin_server_ts: ts, type: "m.room.message", content: { body: "x", msgtype } }) as unknown as MatrixMessage;

  it("groups a sender's messages within a minute", () => {
    expect(groupsWith(msg("@a:x", 0), msg("@a:x", 59_000))).toBe(true);
    expect(groupsWith(msg("@a:x", 0), msg("@a:x", 60_000))).toBe(false);
    expect(groupsWith(msg("@a:x", 0), msg("@b:x", 1000))).toBe(false);
    expect(groupsWith(msg("@a:x", 0, "m.system"), msg("@a:x", 1000))).toBe(false);
    expect(groupsWith(undefined, msg("@a:x", 0))).toBe(false);
  });

  it("starts a new day at midnight", () => {
    const evening = new Date(2026, 9, 17, 23, 59).getTime();
    const morning = new Date(2026, 9, 18, 0, 1).getTime();
    expect(startsNewDay(msg("@a:x", evening), msg("@a:x", morning))).toBe(true);
    expect(startsNewDay(msg("@a:x", morning), msg("@a:x", morning + 1000))).toBe(false);
    expect(startsNewDay(undefined, msg("@a:x", morning))).toBe(true);
  });
});

describe("plainText", () => {
  it("drops the markers and keeps the words", () => {
    expect(plainText("**hi** _there_ %%%you%%% :emoji{x}:")).toBe("hi there you :emoji:");
    const channels = [{ channel_id: "#_a", name: "general", channel_type: "text" as const }];
    expect(plainText("in <##_a> and <##_b>", channels)).toBe("in #general and #unknown");
  });
});
