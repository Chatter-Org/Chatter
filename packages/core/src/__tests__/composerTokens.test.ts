import { describe, expect, it } from "vitest";
import {
  completeToken,
  findShortcodeMatches,
  resolveShortcodes,
  roomShortcodes,
  tokenAtCaret,
} from "../composerTokens";

describe("tokenAtCaret", () => {
  it("finds a mention being typed", () => {
    expect(tokenAtCaret("hey @al", 7)).toEqual({ kind: "mention", query: "al", start: 4, end: 7 });
    expect(tokenAtCaret("@", 1)).toEqual({ kind: "mention", query: "", start: 0, end: 1 });
  });

  it("ignores an @ inside a word, like an email address", () => {
    expect(tokenAtCaret("me@example", 10)).toBeNull();
  });

  it("finds a shortcode being typed", () => {
    expect(tokenAtCaret("nice :thu", 9)).toEqual({ kind: "emoji", query: "thu", start: 5, end: 9 });
    expect(tokenAtCaret(":s", 2)).toEqual({ kind: "emoji", query: "s", start: 0, end: 2 });
  });

  it("does not treat URLs, times or a bare colon as emoji", () => {
    expect(tokenAtCaret("https://exa", 11)).toBeNull();
    expect(tokenAtCaret("at 10:30", 8)).toBeNull();
    expect(tokenAtCaret("note:", 5)).toBeNull();
    expect(tokenAtCaret("re:abc", 6)).toBeNull();
  });

  it("only looks before the caret", () => {
    expect(tokenAtCaret("@al and more", 3)).toEqual({ kind: "mention", query: "al", start: 0, end: 3 });
    expect(tokenAtCaret("@al and more", 12)).toBeNull();
  });
});

describe("completeToken", () => {
  it("replaces the token and adds a space", () => {
    const token = tokenAtCaret("hi @al", 6)!;
    expect(completeToken("hi @al", token, "@alice_dev")).toEqual({ text: "hi @alice_dev ", caret: 14 });
  });

  it("keeps the text after the caret and does not double a space", () => {
    const token = tokenAtCaret("hi :smi there", 7)!;
    expect(completeToken("hi :smi there", token, "😄")).toEqual({ text: "hi 😄 there", caret: 6 });
  });
});

describe("shortcodes", () => {
  it("matches by prefix, shortest names first", () => {
    const names = findShortcodeMatches({ smile: "😄", smiley: "😃", smirk: "😏", grin: "😁" }, "smi").map((m) => m.name);
    expect(names).toEqual(["smile", "smirk", "smiley"]);
  });

  it("lets a room's alias override a standard one", () => {
    expect(roomShortcodes({ smile: "/emoji/abc.png" }).smile).toBe("/emoji/abc.png");
  });

  it("resolves known names on send and leaves unknown ones", () => {
    const codes = roomShortcodes({ party: "/emoji/party.png" });
    expect(resolveShortcodes("hi :smile: :party: :nope:", codes)).toBe("hi 😄 :emoji{/emoji/party.png}: :nope:");
  });
});
