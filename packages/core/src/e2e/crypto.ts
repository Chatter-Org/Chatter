/**
 * The cryptography behind end-to-end encrypted DMs, and nothing else: no
 * network, no state. `session.ts` decides when each of these runs.
 *
 * - An account's **identity** is one random 32-byte seed. Its X25519 key
 *   (receives room keys) and Ed25519 key (signs) are derived from it, so the
 *   seed is the only thing a backup has to carry.
 * - The **backup** is the seed sealed with XChaCha20-Poly1305 under a key
 *   scrypt derives from the person's passphrase.
 * - A **room key** is 32 random bytes per epoch, wrapped to each member with an
 *   ephemeral X25519 exchange (a sealed box) and signed by whoever made it.
 * - A **message** is its JSON sealed under the room key, bound to the room,
 *   epoch and sender, and signed by the sender.
 *
 * Every byte string on the wire is standard base64. The server checks the
 * lengths these produce (`routes/e2e.rs`); change both together.
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8 } from "@noble/ciphers/utils.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// ─── Encoding ───────────────────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Standard, padded base64. Written out because `btoa` is not on every
 *  platform the core runs on, and works on strings rather than bytes. */
export function toB64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

export function fromB64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const c of clean) {
    const v = B64_INDEX.get(c);
    if (v === undefined) throw new Error("Not base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

const utf8 = (text: string) => utf8ToBytes(text);
/** Labels and ids joined with a separator none of them can contain. */
const bind = (...parts: (string | number)[]) => utf8(parts.join("\u0000"));

// ─── Identity ───────────────────────────────────────────────────────────────

export interface Identity {
  seed: Uint8Array;
  encPriv: Uint8Array;
  encPub: Uint8Array;
  signPriv: Uint8Array;
  signPub: Uint8Array;
}

/** The public half, as the server stores and hands it out. */
export interface PublicIdentity {
  enc_pub: string;
  sign_pub: string;
}

export function identityFromSeed(seed: Uint8Array): Identity {
  const encPriv = hkdf(sha256, seed, undefined, utf8("chatter/e2e/x25519"), 32);
  const signPriv = hkdf(sha256, seed, undefined, utf8("chatter/e2e/ed25519"), 32);
  return {
    seed,
    encPriv,
    encPub: x25519.getPublicKey(encPriv),
    signPriv,
    signPub: ed25519.getPublicKey(signPriv),
  };
}

export function newIdentity(): Identity {
  return identityFromSeed(randomBytes(32));
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return { enc_pub: toB64(identity.encPub), sign_pub: toB64(identity.signPub) };
}

// ─── Passphrase backup ──────────────────────────────────────────────────────

export interface IdentityBackup {
  kdf: "scrypt";
  log_n: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
}

/** 128 MiB and a few seconds on a laptop. The backup sits on the server, so
 *  whoever holds the database can guess at it offline for as long as they
 *  like; this is what each guess costs them. Stored with the backup, so it
 *  can be raised for new backups without stranding old ones. */
export const BACKUP_KDF = { log_n: 17, r: 8, p: 1 } as const;

/** A passphrase shorter than this is refused before it is ever used. */
export const MIN_PASSPHRASE_LENGTH = 12;

/** Why a passphrase is too weak to protect a backup anyone with the database
 *  can attack offline, or null when it will do. Length matters most; this
 *  also turns away the shapes a guesser tries first. */
export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters`;
  if (new Set(passphrase.toLowerCase()).size < 6) return "Use more different characters";
  if (/^(.+?)\1+$/.test(passphrase)) return "Don't repeat the same thing over and over";
  if (/^[0-9]+$/.test(passphrase)) return "Use words or letters, not only numbers";
  return null;
}

async function passphraseKey(passphrase: string, salt: Uint8Array, params: { log_n: number; r: number; p: number }) {
  return scryptAsync(passphrase.normalize("NFKC"), salt, {
    N: 2 ** params.log_n,
    r: params.r,
    p: params.p,
    dkLen: 32,
    // Yield to the event loop now and then, so the dialog keeps painting.
    asyncTick: 20,
  });
}

/** The account id goes into the seal, so a backup cannot be passed off as
 *  someone else's. */
const backupAad = (userId: string) => bind("chatter/e2e/backup/v1", userId);

export async function sealBackup(seed: Uint8Array, passphrase: string, userId: string): Promise<IdentityBackup> {
  const salt = randomBytes(16);
  const nonce = randomBytes(24);
  const key = await passphraseKey(passphrase, salt, BACKUP_KDF);
  const ct = xchacha20poly1305(key, nonce, backupAad(userId)).encrypt(seed);
  return { kdf: "scrypt", ...BACKUP_KDF, salt: toB64(salt), nonce: toB64(nonce), ct: toB64(ct) };
}

/** The seed, or null for a wrong passphrase. */
export async function openBackup(backup: IdentityBackup, passphrase: string, userId: string): Promise<Uint8Array | null> {
  if (backup.kdf !== "scrypt") return null;
  const key = await passphraseKey(passphrase, fromB64(backup.salt), backup);
  try {
    return xchacha20poly1305(key, fromB64(backup.nonce), backupAad(userId)).decrypt(fromB64(backup.ct));
  } catch {
    return null;
  }
}

// ─── Room keys ──────────────────────────────────────────────────────────────

export interface WrappedRoomKey {
  eph: string;
  nonce: string;
  ct: string;
  sig: string;
}

export interface WrapContext {
  roomId: string;
  epoch: number;
  /** Who the copy is for. */
  recipient: string;
  /** Who made it. */
  sender: string;
}

const wrapAad = (c: WrapContext) => bind("chatter/e2e/room-key/v1", c.roomId, c.epoch, c.recipient, c.sender);

export function newRoomKey(): Uint8Array {
  return randomBytes(32);
}

function wrapKey(shared: Uint8Array, eph: Uint8Array, recipientPub: Uint8Array) {
  return hkdf(sha256, shared, concatBytes(eph, recipientPub), utf8("chatter/e2e/wrap"), 32);
}

export function wrapRoomKey(
  roomKey: Uint8Array,
  recipientEncPub: Uint8Array,
  context: WrapContext,
  sender: Identity,
): WrappedRoomKey {
  const ephPriv = x25519.utils.randomSecretKey();
  const eph = x25519.getPublicKey(ephPriv);
  const key = wrapKey(x25519.getSharedSecret(ephPriv, recipientEncPub), eph, recipientEncPub);
  const nonce = randomBytes(24);
  const aad = wrapAad(context);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(roomKey);
  const sig = ed25519.sign(concatBytes(aad, eph, nonce, ct), sender.signPriv);
  return { eph: toB64(eph), nonce: toB64(nonce), ct: toB64(ct), sig: toB64(sig) };
}

/**
 * The room key, or null when this copy is not for `me`, was not made by the
 * holder of `senderSignPub`, or has been tampered with.
 *
 * The signature is what stops the server handing out a key of its own
 * making: it can wrap to anyone's public key, but it cannot sign as a member.
 */
export function unwrapRoomKey(
  wrapped: WrappedRoomKey,
  context: WrapContext,
  me: Identity,
  senderSignPub: Uint8Array,
): Uint8Array | null {
  try {
    const eph = fromB64(wrapped.eph);
    const nonce = fromB64(wrapped.nonce);
    const ct = fromB64(wrapped.ct);
    const aad = wrapAad(context);
    if (!ed25519.verify(fromB64(wrapped.sig), concatBytes(aad, eph, nonce, ct), senderSignPub)) return null;
    const key = wrapKey(x25519.getSharedSecret(me.encPriv, eph), eph, me.encPub);
    return xchacha20poly1305(key, nonce, aad).decrypt(ct);
  } catch {
    return null;
  }
}

// ─── Messages ───────────────────────────────────────────────────────────────

/** `content.e2e` on a message. */
export interface SealedMessage {
  v: 1;
  epoch: number;
  nonce: string;
  ct: string;
  sig: string;
}

/**
 * What is sealed: the text, what the server would otherwise have quoted from
 * the message it replies to, and everything about the message the server
 * could otherwise rearrange — which message it answers, which thread it is
 * in, whether it is a spoiler — next to an id of its own (`mid`), kept by its
 * edits, so the server cannot replay it as another message or pass one
 * message off as an edit of another.
 */
export interface MessagePlaintext {
  body: string;
  reply_to_body?: string;
  mid?: string;
  in_reply_to?: string;
  thread_id?: string;
  spoiler?: boolean;
}

export interface MessageContext {
  roomId: string;
  epoch: number;
  sender: string;
}

const messageAad = (c: MessageContext) => bind("chatter/e2e/message/v1", c.roomId, c.epoch, c.sender);

export function sealMessage(
  plaintext: MessagePlaintext,
  roomKey: Uint8Array,
  context: MessageContext,
  sender: Identity,
): SealedMessage {
  const nonce = randomBytes(24);
  const aad = messageAad(context);
  const ct = xchacha20poly1305(roomKey, nonce, aad).encrypt(utf8(JSON.stringify(plaintext)));
  const sig = ed25519.sign(concatBytes(aad, nonce, ct), sender.signPriv);
  return { v: 1, epoch: context.epoch, nonce: toB64(nonce), ct: toB64(ct), sig: toB64(sig) };
}

export type OpenedMessage =
  | { ok: true; plaintext: MessagePlaintext; verified: boolean }
  | { ok: false };

/**
 * Decrypt a message. `verified` is whether the sender's signature checks out
 * against `senderSignPub`; a message can open and still not verify, when the
 * sender has since reset their keys, and is shown with a warning rather than
 * hidden.
 */
export function openMessage(
  sealed: SealedMessage,
  roomKey: Uint8Array,
  context: MessageContext,
  senderSignPub: Uint8Array | null,
): OpenedMessage {
  try {
    const nonce = fromB64(sealed.nonce);
    const ct = fromB64(sealed.ct);
    const aad = messageAad(context);
    const raw = xchacha20poly1305(roomKey, nonce, aad).decrypt(ct);
    const parsed = JSON.parse(bytesToUtf8(raw));
    if (typeof parsed?.body !== "string") return { ok: false };
    const plaintext: MessagePlaintext = { body: parsed.body };
    for (const field of ["reply_to_body", "mid", "in_reply_to", "thread_id"] as const) {
      if (typeof parsed[field] === "string") plaintext[field] = parsed[field];
    }
    if (parsed.spoiler === true) plaintext.spoiler = true;
    let verified = false;
    if (senderSignPub) {
      try {
        verified = ed25519.verify(fromB64(sealed.sig), concatBytes(aad, nonce, ct), senderSignPub);
      } catch {}
    }
    return { ok: true, plaintext, verified };
  } catch {
    return { ok: false };
  }
}

/** A fresh id for a message, sealed inside it. */
export function newMessageId(): string {
  return toB64(randomBytes(16));
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
