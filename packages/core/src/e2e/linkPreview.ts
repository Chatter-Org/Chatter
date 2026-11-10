/**
 * Link previews for end-to-end encrypted conversations, made by the sender.
 *
 * In a plaintext room every reader asks the server for a link's preview, so
 * the server fetches the page and learns the link. In an encrypted room that
 * would hand the server what the seal is for, so it is not done. Instead the
 * sender's device fetches the page itself (`host.fetchForPreview`), reads its
 * title, description and picture, and seals them into the message:
 *
 * - The server never sees the link, the page, or the picture. The picture is
 *   uploaded like any encrypted file (`apiUploadEncryptedFile`), and its link,
 *   with the key, rides inside the sealed preview.
 * - Readers fetch nothing from the linked site. Drawing the preview asks only
 *   the server, for an opaque `.enc` file, so the site cannot see who read it.
 * - The site the card names is taken from the link in the message by the
 *   reader, never from what the page or the sender says it is.
 *
 * Only a platform that can read another site's page makes one: the desktop
 * app (bridge feature `link-preview@1`). A browser cannot, and sends none.
 * That platform must enforce, on every request and every redirect:
 * https only; no cookies or credentials; no loopback, private, link-local,
 * CGNAT or multicast address, checked after DNS resolution; at most 5
 * redirects; `page` answers only an HTML type, cut to `PAGE_BYTES`; `image`
 * answers only png, jpeg, gif or webp, refused over `IMAGE_BYTES`; a few
 * seconds at most; no script run.
 */

import { isServerUrl } from "../api";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "../mediaTypes";
import { host } from "../platform";
import { PREVIEW_LIMITS, type SealedLinkPreview } from "./crypto";
import { apiUploadEncryptedFile, encryptedFileKind, parseEncryptedFileLink } from "./files";

export const PAGE_BYTES = 1024 * 1024;
export const IMAGE_BYTES = 2 * 1024 * 1024;
/** How long a send waits for a preview not already made while typing. */
const SEND_WAIT_MS = 3000;
/** Typing pauses this long before a link in the draft is looked at. */
const PREFETCH_DELAY_MS = 700;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;

/** What the renderer finds in a body (`extractMediaUrls` in MessageItem). */
const URL_IN_TEXT = /(https?:\/\/[^\s]+)/g;
const YOUTUBE = /(?:youtube\.com\/(?:watch\?.*v=|shorts\/)|youtu\.be\/)([\w-]{11})/;
const PREVIEW_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

/**
 * The link in `body` a preview would be made for: the first one that would
 * otherwise get a plain link card. Links to this server (messages, forum
 * posts, uploads), YouTube and direct media all draw their own way. Only
 * https, and only a name on the public internet: an address or a name like
 * `router` or `nas.local` stays out, before the platform checks it again.
 */
export function previewLink(body: string): string | null {
  const stripped = body.replace(/:emoji\{[^}]+\}:/g, "");
  for (const link of stripped.match(URL_IN_TEXT) ?? []) {
    if (isServerUrl(link) || /\/external\//.test(link)) continue;
    if (YOUTUBE.test(link) || IMAGE_EXTENSIONS.test(link) || AUDIO_EXTENSIONS.test(link) || VIDEO_EXTENSIONS.test(link)) {
      continue;
    }
    // The first plain link is the one a card is drawn for; it gets a preview
    // or nothing.
    return isPublicHttps(link) ? link : null;
  }
  return null;
}

function isPublicHttps(link: string): boolean {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || link.length > PREVIEW_LIMITS.url) return false;
  const name = url.hostname.toLowerCase();
  // An IP address (v4, or v6 in brackets), a single label, or a name kept
  // for local networks.
  if (/^[\d.]+$/.test(name) || name.startsWith("[")) return false;
  if (!name.includes(".")) return false;
  return !/\.(local|localhost|internal|lan|home|corp|intranet|arpa)$/.test(name);
}

// ─── Reading a page ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** One line of plain text, cut to `max`: no tags, no control characters. */
function clean(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const plain = decodeEntities(text.replace(/<[^>]*>/g, " "))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** A title that is a bot check or an error page, not the page. Same list as
 *  the server's (`looks_like_challenge` in `link_preview.rs`). */
function looksLikeChallenge(title: string): boolean {
  const t = title.toLowerCase();
  return [
    "just a moment",
    "attention required",
    "access denied",
    "403 forbidden",
    "are you a robot",
    "robot check",
    "captcha",
    "verify you are human",
    "verifying you are human",
    "security check",
    "ddos-guard",
    "please enable javascript",
    "please wait while",
  ].some((p) => t.includes(p));
}

export interface PageMeta {
  title?: string;
  description?: string;
  /** An absolute https address, resolved against the page. */
  image?: string;
}

/**
 * The page with comments, scripts and styles cut out, so a tag inside one
 * does not count. Scanned once, start to end: the page is whatever the link
 * points at, and a pattern that backtracks over an unclosed comment could
 * hold this tab for as long as its author liked.
 */
function withoutBlocks(html: string): string {
  const starts = /<!--|<script\b|<style\b/gi;
  const lower = html.toLowerCase();
  let out = "";
  let from = 0;
  for (let m = starts.exec(html); m; m = starts.exec(html)) {
    out += html.slice(from, m.index);
    const close = m[0] === "<!--" ? "-->" : m[0].toLowerCase() === "<script" ? "</script" : "</style";
    const end = lower.indexOf(close, m.index + m[0].length);
    if (end < 0) return out;
    from = end + close.length;
    starts.lastIndex = from;
  }
  return out + html.slice(from);
}

/** Each `<meta …>` tag, read with its quotes so a `>` inside one does not end
 *  it. One pass; a tag with an unclosed quote ends the search there. */
function metaTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  let at = lower.indexOf("<meta");
  while (at >= 0) {
    let quote = "";
    let i = at + 5;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    if (i >= text.length) break;
    if (/[\s/>]/.test(text[at + 5] ?? "")) tags.push(text.slice(at, i + 1));
    at = lower.indexOf("<meta", i + 1);
  }
  return tags;
}

/** The text of the first `<title>`, found without backtracking. */
function titleTag(text: string): string | undefined {
  const lower = text.toLowerCase();
  const open = lower.search(/<title[\s>]/);
  if (open < 0) return undefined;
  const start = lower.indexOf(">", open);
  const end = lower.indexOf("</title", start);
  return start < 0 || end < 0 ? undefined : text.slice(start + 1, end);
}

/** The preview a page offers: Open Graph first, then Twitter's tags, then
 *  the plain `<title>` and description. */
export function readPageMeta(html: string, pageUrl: string): PageMeta {
  const text = withoutBlocks(html);
  const meta = new Map<string, string>();
  for (const tag of metaTags(text)) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
      attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
    }
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const first = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => v && v.trim());
  const ogTitle = clean(first("og:title", "twitter:title"), PREVIEW_LIMITS.title);
  const plainTitle = clean(titleTag(text), PREVIEW_LIMITS.title);
  // A challenge page names itself only in <title>; the real page's tags win.
  const title = ogTitle ?? (plainTitle && !looksLikeChallenge(plainTitle) ? plainTitle : undefined);
  if (!title && plainTitle) return {};
  const description = clean(first("og:description", "twitter:description", "description"), PREVIEW_LIMITS.description);
  let image: string | undefined;
  const rawImage = first("og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src");
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage.trim()), pageUrl);
      if (resolved.protocol === "https:" && resolved.href.length <= PREVIEW_LIMITS.url) image = resolved.href;
    } catch {}
  }
  return { title, description, image };
}

function charsetOf(type: string, head: string): string {
  const fromType = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1];
  const fromPage = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  return (fromType ?? fromPage ?? "utf-8").toLowerCase();
}

function decodePage(bytes: Uint8Array, type: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  try {
    return new TextDecoder(charsetOf(type, head)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const baseType = (type: string) => type.toLowerCase().split(";")[0].trim();

function isHttps(link: string): boolean {
  try {
    return new URL(link).protocol === "https:";
  } catch {
    return false;
  }
}

// ─── Making one ─────────────────────────────────────────────────────────────

interface Page {
  title?: string;
  description?: string;
  picture?: { type: string; bytes: Uint8Array };
}

/** Pages read, by link. A draft and the send that follows it share one
 *  fetch, and a send retried after a refusal does not fetch again. */
const pages = new Map<string, { at: number; value: Promise<Page | null> }>();
/** Previews sealed, by room and link, with their pictures uploaded. Per room,
 *  so one upload is never shared by two conversations. */
const sealed = new Map<string, { at: number; value: Promise<SealedLinkPreview | null> }>();

/** The promise kept under `key`, or a new one from `make` kept in its place. */
function memo<T>(map: Map<string, { at: number; value: Promise<T> }>, key: string, make: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  map.delete(key);
  const value = make();
  map.set(key, { at: Date.now(), value });
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

async function readPage(link: string): Promise<Page | null> {
  const fetchFor = host.fetchForPreview;
  if (!fetchFor) return null;
  const res = await fetchFor(link, "page");
  if (!res || !isHttps(res.url) || !/^(text\/html|application\/xhtml\+xml)$/.test(baseType(res.type))) return null;
  const meta = readPageMeta(decodePage(res.bytes.subarray(0, PAGE_BYTES), res.type), res.url);
  let picture: Page["picture"];
  if (meta.image) {
    const img = await fetchFor(meta.image, "image").catch(() => null);
    const type = img ? baseType(img.type) : "";
    if (img && PREVIEW_IMAGE_TYPES.test(type) && img.bytes.length > 0 && img.bytes.length <= IMAGE_BYTES) {
      picture = { type, bytes: img.bytes };
    }
  }
  if (!meta.title && !meta.description && !picture) return null;
  return { title: meta.title, description: meta.description, picture };
}

const pageFor = (link: string): Promise<Page | null> => memo(pages, link, () => readPage(link).catch(() => null));

async function sealPreview(link: string): Promise<SealedLinkPreview | null> {
  const page = await pageFor(link);
  if (!page) return null;
  const preview: SealedLinkPreview = { url: link };
  if (page.title) preview.title = page.title;
  if (page.description) preview.description = page.description;
  if (page.picture) {
    const ext = page.picture.type.split("/")[1].replace("jpeg", "jpg");
    const file = new File([page.picture.bytes.slice().buffer as ArrayBuffer], `link-preview.${ext}`, { type: page.picture.type });
    const uploaded = await apiUploadEncryptedFile(file).catch(() => null);
    if (uploaded) preview.image = uploaded.url;
  }
  return preview.title || preview.description || preview.image ? preview : null;
}

let prefetchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Start reading the page a draft links to, once typing pauses, so the send
 * does not wait for it. Nothing is uploaded until the message is sent. A
 * link typed and never sent has still been fetched from this device, as a
 * browser would when opening it.
 */
export function prefetchLinkPreview(text: string): void {
  if (!host.fetchForPreview) return;
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    const link = previewLink(text);
    if (link) void pageFor(link);
  }, PREFETCH_DELAY_MS);
}

/**
 * The preview to seal into a message in `roomId`, or null. Waits a little
 * for one not already under way, then sends without it rather than hold the
 * message back.
 */
export async function linkPreviewForSend(roomId: string, body: string): Promise<SealedLinkPreview | null> {
  if (!host.fetchForPreview) return null;
  const link = previewLink(body);
  if (!link) return null;
  const preview = memo(sealed, `${roomId}\0${link}`, () => sealPreview(link).catch(() => null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SEND_WAIT_MS);
  });
  try {
    return await Promise.race([preview, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A sealed preview as a reader may show it, or undefined: its link must be
 * one the message itself carries, https, and its picture an encrypted upload
 * on this server of a type the page draws. A picture that is not is dropped
 * and the text kept.
 */
export function acceptedPreview(preview: SealedLinkPreview | undefined, body: string): SealedLinkPreview | undefined {
  if (!preview || !isHttps(preview.url)) return undefined;
  const links: string[] = body.match(URL_IN_TEXT) ?? [];
  if (!links.includes(preview.url)) return undefined;
  const shown: SealedLinkPreview = { url: preview.url };
  if (preview.title) shown.title = preview.title;
  if (preview.description) shown.description = preview.description;
  if (preview.image) {
    const info = parseEncryptedFileLink(preview.image);
    if (info && encryptedFileKind(info.type) === "image") shown.image = preview.image;
  }
  return shown.title || shown.description || shown.image ? shown : undefined;
}

/** For tests: forget every page and preview. */
export function resetLinkPreviews(): void {
  pages.clear();
  sealed.clear();
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = null;
}
