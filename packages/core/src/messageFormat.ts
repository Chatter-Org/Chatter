/**
 * What a message body says, as data: the formatting Chatter supports, parsed
 * once and drawn by each client in its own way (HTML on the web, native text
 * on a phone).
 *
 * Chatter's message format is its own, not Markdown:
 *
 *   ```lang … ```     a code block (language optional)
 *   **bold**          _italic_ (not inside a word)      %%%strobe%%%
 *   @name             a user, or a role when `name` is one of the room's roles
 *   https://…         a link — except media, uploads and links to messages or
 *                     forum posts, which are drawn as cards instead and so are
 *                     left out of the text
 *   :emoji{url}:      a custom emoji
 *
 * The rules mirror client/src/components/MessageItem.tsx (processMessageBody,
 * parseMessageSegments, extractMediaUrls), which they were taken from.
 */

import type { MatrixMessage, RoomInfo } from "./api";
import type { AppState } from "./store/types";
import { parseForumLink } from "./forumLinks";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./mediaTypes";
import { parseMessageLink } from "./messageLinks";
import { displayUserId } from "./utils";

// ─── Inline ───────────────────────────────────────────────────────────────────

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "strobe"; children: InlineNode[] }
  | {
      type: "mention";
      /** As written, without the "@". */
      name: string;
      kind: "user" | "role";
      /** A user mention of the person reading. */
      self: boolean;
      /** A role's colour, "" for none. */
      color: string;
    }
  | { type: "link"; url: string; /** Shortened for display. */ display: string }
  | { type: "emoji"; url: string; /** The room's alias for it, when it has one. */ alias?: string };

export type BodyBlock =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "code"; code: string; language?: string };

export interface FormatOptions {
  /** The reader's user id, so a mention of them stands out. */
  currentUserId?: string | null;
  /** Lowercase role name → colour ("" for none); see mentions.ts mentionRoleColors. */
  roleColors?: Map<string, string>;
  /** Custom emoji URL → alias, for naming an emoji. */
  emojiAliases?: Record<string, string>;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;
const YOUTUBE_RE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([\w-]{11})/;
const CODE_BLOCK_RE = /```(?:(\w+)\n|\n?)([\s\S]*?)```/g;
const CUSTOM_EMOJI_RE = /:emoji\{([^}]+)\}:/g;

/** Where a URL is drawn as something other than a link. */
function urlIsDrawnElsewhere(url: string): boolean {
  return (
    IMAGE_EXTENSIONS.test(url) ||
    VIDEO_EXTENSIONS.test(url) ||
    !!youTubeId(url) ||
    /\/external\//.test(url) ||
    !!parseMessageLink(url) ||
    !!parseForumLink(url)
  );
}

export function youTubeId(url: string): string | null {
  return url.match(YOUTUBE_RE)?.[1] ?? null;
}

/** A body split into code blocks and the text between them. */
export function splitCodeBlocks(body: string): ({ type: "text"; text: string } | { type: "code"; code: string; language?: string })[] {
  const out: ({ type: "text"; text: string } | { type: "code"; code: string; language?: string })[] = [];
  let last = 0;
  for (const m of body.matchAll(CODE_BLOCK_RE)) {
    if (m.index! > last) out.push({ type: "text", text: body.slice(last, m.index) });
    out.push({ type: "code", code: m[2], language: m[1] || undefined });
    last = m.index! + m[0].length;
  }
  if (last < body.length) out.push({ type: "text", text: body.slice(last) });
  return out;
}

// Atoms (emoji, mentions, links) are lifted out of the text before formatting
// is read, so a `_` in a URL or a `*` in an emoji URL never starts a style —
// the same order the web applies them in.
const ATOM = "\u0000";

/** Parse one run of text (no code blocks) into inline nodes. */
export function parseInline(text: string, options: FormatOptions = {}): InlineNode[] {
  const atoms: InlineNode[] = [];
  const hold = (node: InlineNode) => `${ATOM}${atoms.push(node) - 1}${ATOM}`;
  const selfName = options.currentUserId ? displayUserId(options.currentUserId).toLowerCase() : null;

  let s = text.replace(CUSTOM_EMOJI_RE, (_m, url: string) =>
    hold({ type: "emoji", url, alias: options.emojiAliases?.[url] }),
  );
  s = s.replace(URL_RE, (url: string) => {
    if (urlIsDrawnElsewhere(url)) return "";
    return hold({ type: "link", url, display: url.length > 60 ? url.slice(0, 57) + "..." : url });
  });
  s = s.replace(/@(\w+)/g, (_m, name: string) => {
    const roleColor = options.roleColors?.get(name.toLowerCase());
    if (roleColor !== undefined) {
      // Only a plain colour value: it is drawn as a colour, never interpreted.
      const color = /^#?[a-zA-Z0-9]+$/.test(roleColor) ? roleColor : "";
      return hold({ type: "mention", name, kind: "role", self: false, color });
    }
    return hold({ type: "mention", name, kind: "user", self: name.toLowerCase() === selfName, color: "" });
  });

  return styled(s, atoms);
}

const STYLES: { type: "strobe" | "bold" | "italic"; re: RegExp }[] = [
  { type: "strobe", re: /%%%(.+?)%%%/ },
  { type: "bold", re: /\*\*(.+?)\*\*/ },
  // Not inside a word, so snake_case and URLs stay as they are.
  { type: "italic", re: /(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/ },
];

/** Read the formatting markers, earliest first; nested styles recurse. */
function styled(s: string, atoms: InlineNode[]): InlineNode[] {
  let best: { type: "strobe" | "bold" | "italic"; m: RegExpExecArray } | null = null;
  for (const { type, re } of STYLES) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.m.index)) best = { type, m };
  }
  if (!best) return unatom(s, atoms);
  const { type, m } = best;
  return [
    ...unatom(s.slice(0, m.index), atoms),
    { type, children: styled(m[1], atoms) },
    ...styled(s.slice(m.index + m[0].length), atoms),
  ];
}

/** Text with its held atoms put back. */
function unatom(s: string, atoms: InlineNode[]): InlineNode[] {
  if (!s) return [];
  const out: InlineNode[] = [];
  const parts = s.split(ATOM);
  // Odd positions are atom indices: "a\u00000\u0000b" → ["a", "0", "b"].
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const atom = atoms[Number(part)];
      if (atom) out.push(atom);
    } else if (part) {
      const prev = out[out.length - 1];
      if (prev?.type === "text") prev.text += part;
      else out.push({ type: "text", text: part });
    }
  });
  return out;
}

/** A whole body as blocks: code blocks, and paragraphs of inline nodes. */
export function parseBody(body: string, options: FormatOptions = {}): BodyBlock[] {
  return splitCodeBlocks(body).flatMap((seg): BodyBlock[] => {
    if (seg.type === "code") return [seg];
    const children = parseInline(seg.text, options);
    return children.length ? [{ type: "paragraph", children }] : [];
  });
}

/** The plain text a body reads as — for previews, notifications, replies. */
export function plainText(body: string): string {
  return body
    .replace(CUSTOM_EMOJI_RE, ":emoji:")
    .replace(/```(?:\w+\n|\n?)([\s\S]*?)```/g, "$1")
    .replace(/%%%(.+?)%%%/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_(.+?)_(?![a-zA-Z0-9])/g, "$1");
}

// ─── Media ────────────────────────────────────────────────────────────────────

export interface BodyMedia {
  images: string[];
  videos: string[];
  audios: string[];
  /** Uploads that are not media: drawn as file cards. */
  files: string[];
  /** Ordinary links, for link previews. */
  links: string[];
  youtubeIds: string[];
  /** Links to messages and forum posts, drawn as cards of their own. */
  messageLinks: string[];
  forumLinks: string[];
}

/** The URLs in a body, sorted by how each is drawn. */
export function extractMedia(body: string): BodyMedia {
  const media: BodyMedia = { images: [], videos: [], audios: [], files: [], links: [], youtubeIds: [], messageLinks: [], forumLinks: [] };
  // Custom emoji are inline, never full-size media.
  const stripped = body.replace(CUSTOM_EMOJI_RE, "");
  for (const url of stripped.match(URL_RE) ?? []) {
    if (parseMessageLink(url)) media.messageLinks.push(url);
    else if (parseForumLink(url)) media.forumLinks.push(url);
    else if (youTubeId(url)) media.youtubeIds.push(youTubeId(url)!);
    else if (IMAGE_EXTENSIONS.test(url)) media.images.push(url);
    else if (AUDIO_EXTENSIONS.test(url)) media.audios.push(url);
    else if (VIDEO_EXTENSIONS.test(url)) media.videos.push(url);
    else if (/\/external\//.test(url)) media.files.push(url);
    else media.links.push(url);
  }
  return media;
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

/** Within this, a sender's consecutive messages share one header. */
const GROUP_WINDOW_MS = 60_000;

/** Whether `msg` continues `prev`'s group (no avatar or name of its own). */
export function groupsWith(prev: MatrixMessage | undefined, msg: MatrixMessage): boolean {
  return (
    !!prev &&
    prev.content.msgtype !== "m.system" &&
    msg.content.msgtype !== "m.system" &&
    prev.sender === msg.sender &&
    msg.origin_server_ts - prev.origin_server_ts < GROUP_WINDOW_MS
  );
}

/** Whether a day divider goes above `msg`. */
export function startsNewDay(prev: MatrixMessage | undefined, msg: MatrixMessage): boolean {
  if (!prev) return true;
  const a = new Date(prev.origin_server_ts);
  const b = new Date(msg.origin_server_ts);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}

/** Whether a message has been deleted. */
export function isDeletedMessage(msg: MatrixMessage): boolean {
  return !!msg.redacted || msg.content.body === "[deleted]";
}

/**
 * The colour a sender's name is drawn in, before any adjustment for the theme:
 * the room's owner or moderator colour for those roles, otherwise their first
 * custom role that has a colour. Undefined draws the default.
 */
export function senderNameColor(
  state: Pick<AppState, "roomMembers" | "memberCustomRoles" | "customRoles">,
  roomInfo: Pick<RoomInfo, "owner_name_color" | "mod_name_color"> | undefined,
  sender: string,
): string | undefined {
  const role = state.roomMembers.find((m) => m.userId === sender)?.role || "member";
  if (role === "owner" && roomInfo?.owner_name_color) return roomInfo.owner_name_color;
  if (role === "moderator" && roomInfo?.mod_name_color) return roomInfo.mod_name_color;
  for (const roleId of state.memberCustomRoles[sender] || []) {
    const color = state.customRoles.find((r) => r.role_id === roleId)?.color;
    if (color) return color;
  }
  return undefined;
}

/**
 * Who a message is from when it is not a member: a bot or a webhook names
 * itself and brings its own picture, and is marked BOT or HOOK beside the
 * name (MessageItem). Null for an ordinary member.
 */
export function externalSender(m: MatrixMessage): { badge: "BOT" | "HOOK"; name: string; avatarUrl?: string } | null {
  if (m.content.webhook === true) {
    return { badge: "HOOK", name: m.content.webhook_name || "Webhook", avatarUrl: m.content.webhook_avatar_url || undefined };
  }
  if (m.content.bot === true) {
    return { badge: "BOT", name: m.content.bot_name || "Bot", avatarUrl: m.content.bot_avatar_url || undefined };
  }
  return null;
}
