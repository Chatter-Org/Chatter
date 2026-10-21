/**
 * The bits of a message being typed that the composer offers to finish:
 * `@someone` and `:shortcode:`. Plain text in, plain text out, so any
 * composer can use them — the mobile app's TextInput, the web's textarea —
 * and they cannot disagree about what counts as a mention or an emoji.
 */

import { STANDARD_SHORTCODES } from "./emojiShortcodes";

export type ComposerToken =
  /** `@que|` — complete to a member or role name. */
  | { kind: "mention"; query: string; start: number; end: number }
  /** `:smi|` — complete to an emoji. */
  | { kind: "emoji"; query: string; start: number; end: number };

/**
 * The token the caret sits at the end of, or null. `start` is the index of
 * the `@` or `:`, `end` the caret.
 */
export function tokenAtCaret(text: string, caret: number): ComposerToken | null {
  const before = text.slice(0, caret);
  const mention = /(?:^|\s)@(\w*)$/.exec(before);
  if (mention) return { kind: "mention", query: mention[1], start: caret - mention[1].length - 1, end: caret };
  // One colon and at least one name character after it. A URL's "://" and a
  // time like "10:30" are not emoji: the colon must not follow "/" or a digit.
  const emoji = /(?:^|[^\w/:]):([a-zA-Z0-9_]+)$/.exec(before);
  if (emoji && !/^\d+$/.test(emoji[1])) {
    return { kind: "emoji", query: emoji[1], start: caret - emoji[1].length - 1, end: caret };
  }
  return null;
}

/** Replace a token with what was picked. Returns the new text and where the
 *  caret goes (just after the insertion and its trailing space). */
export function completeToken(text: string, token: ComposerToken, insert: string): { text: string; caret: number } {
  const after = text.slice(token.end);
  const spacer = after.startsWith(" ") ? "" : " ";
  const next = text.slice(0, token.start) + insert + spacer + after;
  return { text: next, caret: token.start + insert.length + 1 };
}

/** Standard shortcodes plus a room's own aliases; the room's win. */
export function roomShortcodes(roomAliases?: Record<string, string> | null): Record<string, string> {
  return { ...STANDARD_SHORTCODES, ...(roomAliases ?? {}) };
}

/** A room alias's value is an image path or URL rather than a character. */
export function isShortcodeImage(value: string): boolean {
  return value.startsWith("/") || value.startsWith("http");
}

/** Shortcodes starting with `query`, closest names first. */
export function findShortcodeMatches(
  shortcodes: Record<string, string>,
  query: string,
  limit = 8,
): { name: string; value: string }[] {
  const needle = query.toLowerCase();
  return Object.entries(shortcodes)
    .filter(([name]) => name.toLowerCase().startsWith(needle))
    .sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit)
    .map(([name, value]) => ({ name, value }));
}

/** What a shortcode becomes in a sent message: the character, or for a room's
 *  image emoji the marker the message format reads. */
export function shortcodeInsert(value: string): string {
  return isShortcodeImage(value) ? `:emoji{${value}}:` : value;
}

/** Turn every known `:name:` in a message into its emoji, as it is sent. */
export function resolveShortcodes(body: string, shortcodes: Record<string, string>): string {
  return body.replace(/:([a-zA-Z0-9_]+):/g, (match, name: string) => {
    const value = shortcodes[name];
    return value ? shortcodeInsert(value) : match;
  });
}
