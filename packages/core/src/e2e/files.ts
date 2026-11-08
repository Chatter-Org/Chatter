/**
 * Encrypted uploads: the file is sealed in this device before it leaves, the
 * server stores an opaque `<random>.enc`, and the key travels inside the
 * sealed message as the fragment of the file's link.
 *
 * - A file is cut into 1 MiB segments, each sealed with XChaCha20-Poly1305
 *   under a random per-file key. The nonce is a random per-file prefix and
 *   the segment's number, and the last segment is marked in the AAD, so the
 *   server can neither reorder, drop, nor truncate segments undetected.
 * - The link is `<upload url>#k=<key>&t=<type>&s=<size>&n=<name>`. A fragment
 *   is never sent to the server, and the message text it sits in is sealed,
 *   so only the conversation's members ever see the key, the name, or the
 *   type. The sender's signature over the message is what vouches for them.
 * - Whole files are held in memory to seal and to open: this is built for
 *   chat attachments, not for gigabytes.
 *
 * No state and no network except `apiUploadEncryptedFile`/`fetchEncryptedFile`.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { apiDiscardInterruptedUpload, apiGetAuthenticatedBytes, apiUploadFile } from "../api";
import { fingerprintFile, toUploadSource, type UploadSource } from "../uploadResume";
import { fromB64, toB64 } from "./crypto";

export const FILE_SEGMENT = 1024 * 1024;
const TAG = 16;
const PREFIX = 16;
const AAD_LABEL = utf8ToBytes("chatter/e2e/file/v1");

const aad = (last: boolean) => {
  const out = new Uint8Array(AAD_LABEL.length + 1);
  out.set(AAD_LABEL);
  out[AAD_LABEL.length] = last ? 1 : 0;
  return out;
};

function segmentNonce(prefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce.set(prefix);
  new DataView(nonce.buffer).setUint32(20, index);
  return nonce;
}

/** Seal `plain` under `key`: a random prefix, then each segment and its tag. */
export function sealFile(plain: Uint8Array, key: Uint8Array): Uint8Array {
  const prefix = randomBytes(PREFIX);
  const count = Math.max(1, Math.ceil(plain.length / FILE_SEGMENT));
  const out = new Uint8Array(PREFIX + plain.length + count * TAG);
  out.set(prefix);
  let offset = PREFIX;
  for (let i = 0; i < count; i++) {
    const segment = plain.subarray(i * FILE_SEGMENT, (i + 1) * FILE_SEGMENT);
    const sealed = xchacha20poly1305(key, segmentNonce(prefix, i), aad(i === count - 1)).encrypt(segment);
    out.set(sealed, offset);
    offset += sealed.length;
  }
  return out;
}

/** The file, or an error when it was tampered with, cut short, or is not
 *  sealed under `key`. */
export function openFile(data: Uint8Array, key: Uint8Array): Uint8Array {
  if (data.length < PREFIX + TAG) throw new Error("Not an encrypted file");
  const prefix = data.subarray(0, PREFIX);
  const body = data.subarray(PREFIX);
  const count = Math.ceil(body.length / (FILE_SEGMENT + TAG));
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const segment = body.subarray(i * (FILE_SEGMENT + TAG), (i + 1) * (FILE_SEGMENT + TAG));
    const plain = xchacha20poly1305(key, segmentNonce(prefix, i), aad(i === count - 1)).decrypt(segment);
    parts.push(plain);
    total += plain.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ─── Links ──────────────────────────────────────────────────────────────────

export interface EncryptedFileInfo {
  /** The upload's address, without the fragment. */
  url: string;
  key: Uint8Array;
  name: string;
  type: string;
  size: number;
}

const ENCRYPTED_URL = /\/external\/[0-9a-f]{32}\/[^/?#]+\.enc$/i;
const MAX_NAME = 200;

const b64url = (bytes: Uint8Array) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => {
  const std = text.replace(/-/g, "+").replace(/_/g, "/");
  return fromB64(std + "=".repeat((4 - (std.length % 4)) % 4));
};
/** Percent-encoded so nothing in it is whitespace or punctuation a sentence
 *  would trim off the end of a link. */
const field = (text: string) =>
  encodeURIComponent(text).replace(/[!'()*.]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function encryptedFileLink(info: EncryptedFileInfo): string {
  const name = info.name.slice(0, MAX_NAME);
  return `${info.url}#k=${b64url(info.key)}&t=${field(info.type)}&s=${info.size}&n=${field(name)}`;
}

/** What a link in a message says about an encrypted file, or null when it is
 *  not one. */
export function parseEncryptedFileLink(link: string): EncryptedFileInfo | null {
  const hash = link.indexOf("#");
  if (hash < 0) return null;
  const url = link.slice(0, hash);
  if (!ENCRYPTED_URL.test(url)) return null;
  try {
    const params = new Map<string, string>();
    for (const pair of link.slice(hash + 1).split("&")) {
      const eq = pair.indexOf("=");
      if (eq > 0) params.set(pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1)));
    }
    const key = fromB64url(params.get("k") ?? "");
    if (key.length !== 32) return null;
    const size = Number(params.get("s"));
    return {
      url,
      key,
      name: (params.get("n") || "file").slice(0, MAX_NAME),
      type: (params.get("t") ?? "").toLowerCase(),
      size: Number.isFinite(size) && size >= 0 ? size : 0,
    };
  } catch {
    return null;
  }
}

// ─── Kinds ──────────────────────────────────────────────────────────────────

/** What the page is willing to draw from a sender-chosen type. SVG is left
 *  out on purpose: a blob URL of one, opened in its own tab, runs its scripts
 *  as the app. */
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/;
const VIDEO_TYPES = /^video\/(mp4|webm|ogg|quicktime)$/;
const AUDIO_TYPES = /^audio\/(mpeg|mp3|ogg|wav|x-wav|webm|mp4|aac|flac|x-m4a|opus)$/;

export type EncryptedFileKind = "image" | "video" | "audio" | "file";

export function encryptedFileKind(type: string): EncryptedFileKind {
  if (IMAGE_TYPES.test(type)) return "image";
  if (VIDEO_TYPES.test(type)) return "video";
  if (AUDIO_TYPES.test(type)) return "audio";
  return "file";
}

const GUESSED: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4", weba: "audio/webm", oga: "audio/ogg", opus: "audio/ogg",
};

function typeOf(file: { name: string; type?: string }): string {
  if (file.type) return file.type.toLowerCase().split(";")[0].trim();
  return GUESSED[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

// ─── Upload and download ────────────────────────────────────────────────────

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function readAll(source: UploadSource): Promise<Uint8Array> {
  const part = await source.chunk(0, source.size);
  if (typeof Blob === "undefined" || !(part instanceof Blob)) {
    throw new Error("This device can't encrypt files yet");
  }
  return new Uint8Array(await part.arrayBuffer());
}

/**
 * Seal a file here and upload the result as `<random>.enc`. Resolves with the
 * link to put in the message: the upload's address and, after `#`, the key and
 * what the file is called. Nothing about the file but its size reaches the
 * server.
 *
 * Every attempt is sealed afresh under a new key and a new name, so it never
 * resumes a half-sent earlier one; a failed attempt's leftover is discarded.
 */
export async function apiUploadEncryptedFile(
  file: File | UploadSource,
  onProgress?: (pct: number) => void,
): Promise<{ url: string }> {
  const source = toUploadSource(file);
  const plain = await readAll(source);
  const key = randomBytes(32);
  const data = sealFile(plain, key);
  const blob = new Blob([data.buffer as ArrayBuffer], { type: "application/octet-stream" });
  const sealed: UploadSource = {
    name: `${hex(randomBytes(12))}.enc`,
    size: data.length,
    lastModified: Date.now(),
    part: () => blob,
    chunk: async (start, end) => blob.slice(start, end),
  };
  try {
    const { url } = await apiUploadFile(sealed, onProgress);
    return {
      url: encryptedFileLink({
        url,
        key,
        name: source.name,
        type: typeOf(file as { name: string; type?: string }),
        size: plain.length,
      }),
    };
  } catch (err) {
    await apiDiscardInterruptedUpload(fingerprintFile(sealed)).catch(() => {});
    throw err;
  }
}

/** The decrypted file behind a link from a message. Typed only as something
 *  the page draws (see `IMAGE_TYPES`); anything else is a plain download. */
export async function fetchEncryptedFile(link: string): Promise<{ blob: Blob; info: EncryptedFileInfo }> {
  const info = parseEncryptedFileLink(link);
  if (!info) throw new Error("Not an encrypted file link");
  const plain = openFile(await apiGetAuthenticatedBytes(info.url), info.key);
  const kind = encryptedFileKind(info.type);
  const blob = new Blob([plain.buffer as ArrayBuffer], { type: kind === "file" ? "application/octet-stream" : info.type });
  return { blob, info };
}
