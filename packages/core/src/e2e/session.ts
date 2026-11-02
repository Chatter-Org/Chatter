/**
 * This device's side of end-to-end encrypted DMs: whether encryption is set up
 * and unlocked, the room keys it holds, and sealing and opening messages. The
 * design note is `docs/design/e2e-dms.md`; the cryptography is `crypto.ts`.
 *
 * Status, as the app shows it:
 * - `off` — nobody is signed in, or it has not been asked yet.
 * - `setup` — the account has never set up encryption.
 * - `locked` — it has, on another device or before a sign-out, and this one
 *   needs the passphrase.
 * - `ready` — this device holds the seed.
 * - `error` — the server could not be asked. Tried again on the next start.
 *
 * Room keys are kept in memory only and fetched again each session: the seed
 * is the one secret the device stores.
 */

import {
  apiE2eGetIdentity,
  apiE2eGetRoom,
  apiE2ePostRoomKeys,
  apiE2ePutIdentity,
  apiE2eQueryKeys,
  E2eRequestError,
  type E2eRoomState,
} from "../api";
import { host } from "../platform";
import {
  fromB64,
  identityFromSeed,
  MIN_PASSPHRASE_LENGTH,
  newIdentity,
  newRoomKey,
  openBackup,
  openMessage,
  publicIdentity,
  sameBytes,
  sealBackup,
  sealMessage,
  toB64,
  unwrapRoomKey,
  wrapRoomKey,
  type Identity,
  type SealedMessage,
} from "./crypto";
import { configureMessageCrypto, type E2eMessageState, type SealedSend } from "./hooks";

export type E2eStatus = "off" | "setup" | "locked" | "ready" | "error";

/** What a sealed message says in place of its text when it cannot be opened. */
export const E2E_UNREADABLE: Record<Exclude<E2eMessageState, "ok" | "unverified">, string> = {
  locked: "🔒 Unlock encrypted messages to read this",
  missing: "🔒 This message's key isn't on this device",
  broken: "🔒 This message couldn't be decrypted",
};

let me: string | null = null;
let identity: Identity | null = null;
let status: E2eStatus = "off";
/** Bumped by every sign-in and sign-out, so work started for one account
 *  cannot land in the next. */
let generation = 0;
const listeners = new Set<() => void>();

const encryptedRooms = new Set<string>();
const roomKeys = new Map<string, Map<number, Uint8Array>>();
const roomEpochs = new Map<string, { epoch: number; rotate: boolean }>();
/** Members' public keys. `null` is "asked, and they have none". */
const publicKeys = new Map<string, { enc: Uint8Array; sign: Uint8Array } | null>();
const roomSyncs = new Map<string, Promise<void>>();
/** Opened bodies by event id, for quoting in a reply: the server cannot
 *  quote what it cannot read, so the reply carries the quote sealed. */
const openedBodies = new Map<string, string>();
const OPENED_BODIES_KEPT = 2000;
const REPLY_QUOTE_CHARS = 100;

const secretName = (userId: string) => `e2e-seed:${userId}`;

function setStatus(next: E2eStatus) {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener();
}

export function getE2eStatus(): E2eStatus {
  return status;
}

/** Called on every status change. Returns the unsubscribe. */
export function subscribeE2e(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * Find out where this account stands, for the account signed in as `userId`.
 * The seed this device kept is used only if it still matches the keys the
 * server holds: a reset on another device makes it stale.
 */
export async function startE2e(userId: string): Promise<E2eStatus> {
  if (me !== userId) clearSession();
  me = userId;
  const gen = generation;
  try {
    const [record, stored] = await Promise.all([apiE2eGetIdentity(), host.secretGet(secretName(userId)).catch(() => null)]);
    if (gen !== generation) return status;
    if (!record) {
      identity = null;
      setStatus("setup");
      return status;
    }
    if (stored) {
      const local = identityFromSeed(fromB64(stored));
      if (sameBytes(local.encPub, fromB64(record.enc_pub)) && sameBytes(local.signPub, fromB64(record.sign_pub))) {
        identity = local;
        setStatus("ready");
        return status;
      }
      await host.secretDelete(secretName(userId)).catch(() => {});
    }
    identity = null;
    setStatus("locked");
  } catch {
    if (gen === generation) setStatus("error");
  }
  return status;
}

async function adopt(next: Identity) {
  identity = next;
  if (me) await host.secretSet(secretName(me), toB64(next.seed)).catch(() => {});
  // Anything opened as "locked" can be opened now; keys fetched before are
  // still good, but rooms are re-asked so copies made meanwhile arrive.
  roomSyncs.clear();
  setStatus("ready");
}

/**
 * Make this account's keys and back them up under `passphrase`.
 *
 * `replace` starts over when the passphrase is lost: every key wrapped to the
 * old identity is dropped by the server, so messages from before are lost to
 * this account, and members hand it the current keys again.
 */
export async function setUpE2e(passphrase: string, replace = false): Promise<void> {
  if (!me) throw new Error("Not signed in");
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const next = newIdentity();
  const backup = await sealBackup(next.seed, passphrase, me);
  try {
    await apiE2ePutIdentity({ ...publicIdentity(next), backup }, replace);
  } catch (err) {
    if (err instanceof E2eRequestError && err.errcode === "M_E2E_EXISTS") {
      // Set up on another device a moment ago.
      setStatus("locked");
      throw new Error("Encryption was just set up on another device. Unlock it with that passphrase.");
    }
    throw err;
  }
  if (replace) {
    roomKeys.clear();
    roomEpochs.clear();
  }
  publicKeys.delete(me);
  await adopt(next);
}

/** Unlock with the passphrase. False when it is the wrong one. */
export async function unlockE2e(passphrase: string): Promise<boolean> {
  if (!me) throw new Error("Not signed in");
  const record = await apiE2eGetIdentity();
  if (!record) {
    setStatus("setup");
    throw new Error("Encryption isn't set up for this account yet");
  }
  const seed = await openBackup(record.backup, passphrase, me);
  if (!seed) return false;
  const next = identityFromSeed(seed);
  if (!sameBytes(next.encPub, fromB64(record.enc_pub)) || !sameBytes(next.signPub, fromB64(record.sign_pub))) {
    return false;
  }
  await adopt(next);
  return true;
}

function clearSession() {
  generation++;
  identity = null;
  encryptedRooms.clear();
  roomKeys.clear();
  roomEpochs.clear();
  publicKeys.clear();
  roomSyncs.clear();
  openedBodies.clear();
}

/** Signing out: this device forgets the seed, so the next person at it
 *  cannot read the conversation without the passphrase. */
export async function stopE2e(): Promise<void> {
  const userId = me;
  clearSession();
  me = null;
  setStatus("off");
  if (userId) await host.secretDelete(secretName(userId)).catch(() => {});
}

// ─── Rooms and their keys ───────────────────────────────────────────────────

/** Record what the room list says about encryption, so a send knows to seal
 *  before it is sent rather than after the server refuses it. */
export function noteRoomEncryption(roomId: string, e2e: boolean): void {
  if (e2e) encryptedRooms.add(roomId);
  else encryptedRooms.delete(roomId);
}

export function isRoomEncrypted(roomId: string): boolean {
  return encryptedRooms.has(roomId);
}

async function loadPublicKeys(userIds: string[], refresh = false): Promise<void> {
  const wanted = [...new Set(userIds)].filter((id) => refresh || !publicKeys.has(id));
  for (let i = 0; i < wanted.length; i += 100) {
    const batch = wanted.slice(i, i + 100);
    const keys = await apiE2eQueryKeys(batch);
    for (const id of batch) {
      const k = keys[id];
      publicKeys.set(id, k ? { enc: fromB64(k.enc_pub), sign: fromB64(k.sign_pub) } : null);
    }
  }
}

/**
 * Bring this device up to date with a room: open the copies of its keys the
 * server holds for this account, then do whatever the room is owed — a new
 * epoch after a membership change, or copies of the current one for members
 * who set up encryption after it was made.
 *
 * One at a time per room; a caller that needs what happened *after* some
 * event (a refused send) passes `fresh` to queue behind any sync in flight.
 */
export function syncRoomKeys(roomId: string, fresh = false): Promise<void> {
  const running = roomSyncs.get(roomId);
  if (running && !fresh) return running;
  const gen = generation;
  const next = (running ?? Promise.resolve())
    .catch(() => {})
    .then(() => runRoomSync(roomId, gen))
    .finally(() => {
      if (roomSyncs.get(roomId) === next) roomSyncs.delete(roomId);
    });
  roomSyncs.set(roomId, next);
  return next;
}

async function runRoomSync(roomId: string, gen: number, attempt = 0): Promise<void> {
  if (!identity || !me || gen !== generation) return;
  const room = await apiE2eGetRoom(roomId);
  if (gen !== generation) return;
  if (!room.e2e) {
    encryptedRooms.delete(roomId);
    return;
  }
  encryptedRooms.add(roomId);
  const epoch = room.epoch ?? -1;
  roomEpochs.set(roomId, { epoch, rotate: !!room.rotate });

  const members = room.members ?? [];
  const keyed = members.filter((m) => m.has_identity).map((m) => m.user_id);
  await loadPublicKeys([...keyed, ...(room.keys ?? []).map((k) => k.sender)]);
  if (gen !== generation) return;
  openCopies(roomId, room);

  try {
    if (room.rotate) await startEpoch(roomId, epoch + 1, keyed);
    else await handOut(roomId, room);
  } catch (err) {
    // Someone else got there first, or membership moved under us: look
    // again, a couple of times, and take whatever they made.
    const raced = err instanceof E2eRequestError && (err.errcode === "M_E2E_EPOCH" || err.errcode === "M_E2E_MEMBERS");
    if (raced && attempt < 2) return runRoomSync(roomId, gen, attempt + 1);
    throw err;
  }
}

function openCopies(roomId: string, room: E2eRoomState) {
  if (!identity || !me) return;
  const held = roomKeys.get(roomId) ?? new Map<number, Uint8Array>();
  for (const copy of room.keys ?? []) {
    if (held.has(copy.epoch)) continue;
    const signer = publicKeys.get(copy.sender);
    if (!signer) continue;
    const key = unwrapRoomKey(copy, { roomId, epoch: copy.epoch, recipient: me, sender: copy.sender }, identity, signer.sign);
    if (key) held.set(copy.epoch, key);
  }
  roomKeys.set(roomId, held);
}

/** Make the room's next key and give every member who can hold one a copy. */
async function startEpoch(roomId: string, epoch: number, recipients: string[]) {
  if (!identity || !me) return;
  const key = newRoomKey();
  const copies = recipients.flatMap((userId) => {
    const pub = publicKeys.get(userId);
    if (!pub) return [];
    return [{ user_id: userId, ...wrapRoomKey(key, pub.enc, { roomId, epoch, recipient: userId, sender: me! }, identity!) }];
  });
  await apiE2ePostRoomKeys(roomId, epoch, copies);
  roomKeys.get(roomId)?.set(epoch, key);
  roomEpochs.set(roomId, { epoch, rotate: false });
}

/** Copies of the current key for members who have keys but no copy. Only
 *  possible for a device holding the key itself. */
async function handOut(roomId: string, room: E2eRoomState) {
  if (!identity || !me || room.epoch === undefined || room.epoch < 0) return;
  const key = roomKeys.get(roomId)?.get(room.epoch);
  if (!key) return;
  const owed = (room.members ?? []).filter((m) => m.has_identity && !m.has_key && publicKeys.get(m.user_id));
  if (owed.length === 0) return;
  const epoch = room.epoch;
  const copies = owed.map((m) => ({
    user_id: m.user_id,
    ...wrapRoomKey(key, publicKeys.get(m.user_id)!.enc, { roomId, epoch, recipient: m.user_id, sender: me! }, identity!),
  }));
  await apiE2ePostRoomKeys(roomId, epoch, copies);
}

/**
 * The socket's encryption events. Answered after a short random wait, so the
 * members who are all online at once do not all race to make the same key —
 * one wins either way, but there is no need to make the server referee.
 */
export function handleE2eEvent(msg: { type?: string; room_id?: string; user_id?: string; content?: any }): boolean {
  const type = msg.type ?? "";
  const roomId = msg.room_id;
  if (type === "m.room.created" && roomId && msg.content?.e2e) {
    encryptedRooms.add(roomId);
    return false;
  }
  if (!type.startsWith("m.e2e.") || !roomId) return false;
  if (type === "m.e2e.identity" && msg.user_id) publicKeys.delete(msg.user_id);
  if (status !== "ready") return true;
  const delay = type === "m.e2e.room_key" ? 0 : Math.random() * 1500;
  setTimeout(() => void syncRoomKeys(roomId, true).catch(() => {}), delay);
  return true;
}

// ─── Messages ───────────────────────────────────────────────────────────────

type Sealable = { event_id?: string; room_id?: string; sender?: string; content?: any };

function sealedOf(msg: Sealable): SealedMessage | null {
  const sealed = msg.content?.e2e;
  return sealed && typeof sealed === "object" ? (sealed as SealedMessage) : null;
}

/** Whether this message can be opened right now, without asking the server
 *  for anything. */
function openableNow(roomId: string, msg: Sealable): boolean {
  const sealed = sealedOf(msg);
  if (!sealed || !identity) return true;
  return !!roomKeys.get(roomId)?.has(sealed.epoch) && (!msg.sender || publicKeys.has(msg.sender));
}

function remember(eventId: string | undefined, body: string) {
  if (!eventId) return;
  openedBodies.delete(eventId);
  openedBodies.set(eventId, body);
  if (openedBodies.size > OPENED_BODIES_KEPT) {
    const oldest = openedBodies.keys().next().value;
    if (oldest !== undefined) openedBodies.delete(oldest);
  }
}

function openOne<T extends Sealable>(roomId: string, msg: T): T {
  const sealed = sealedOf(msg);
  if (!sealed) return msg;
  const unreadable = (state: keyof typeof E2E_UNREADABLE): T => ({
    ...msg,
    content: { ...msg.content, body: E2E_UNREADABLE[state], reply_to_body: undefined, e2e_state: state },
  });
  if (!identity) return unreadable("locked");
  const key = roomKeys.get(roomId)?.get(sealed.epoch);
  if (!key) return unreadable("missing");
  const signer = msg.sender ? publicKeys.get(msg.sender) : undefined;
  const opened = openMessage(sealed, key, { roomId, epoch: sealed.epoch, sender: msg.sender ?? "" }, signer?.sign ?? null);
  if (!opened.ok) return unreadable("broken");
  remember(msg.event_id, opened.plaintext.body);
  const inReplyTo = msg.content?.in_reply_to as string | undefined;
  const replyQuote =
    opened.plaintext.reply_to_body ?? (inReplyTo ? openedBodies.get(inReplyTo)?.slice(0, REPLY_QUOTE_CHARS) : undefined);
  return {
    ...msg,
    content: {
      ...msg.content,
      body: opened.plaintext.body,
      // The server's quote is the parent's placeholder; never show that.
      reply_to_body: inReplyTo ? (replyQuote ?? "🔒 Encrypted message") : msg.content?.reply_to_body,
      e2e_state: opened.verified ? "ok" : "unverified",
    },
  };
}

/** Fetch whatever is needed to open these messages, then open them. */
async function openMany<T extends Sealable>(roomId: string, events: T[]): Promise<T[]> {
  const sealed = events.filter((e) => sealedOf(e));
  if (sealed.length === 0) return events;
  encryptedRooms.add(roomId);
  if (identity) {
    try {
      if (sealed.some((e) => !roomKeys.get(roomId)?.has(sealedOf(e)!.epoch))) await syncRoomKeys(roomId);
      await loadPublicKeys(sealed.map((e) => e.sender ?? "").filter(Boolean));
    } catch {}
  }
  return events.map((e) => openOne(roomId, e));
}

/**
 * Open the encrypted parts of a socket event, keeping events in order.
 *
 * Most of the time everything needed is already here and the event is handed
 * on at once. When it is not — the first message after a new key — that event
 * and every one after it wait in line until it is ready, so nothing overtakes
 * it: a reaction or deletion arriving behind a message must not be applied
 * before the message itself.
 */
export function createE2eEventGate(handle: (msg: any) => void): (msg: any) => void {
  let queue: Promise<void> | null = null;
  return (msg: any) => {
    const ready = !queue && eventOpenableNow(msg);
    if (ready) {
      handle(openEventNow(msg));
      return;
    }
    const prev = queue ?? Promise.resolve();
    const next: Promise<void> = prev
      .then(async () => handle(await openEvent(msg)))
      .catch(() => {})
      .finally(() => {
        if (queue === next) queue = null;
      });
    queue = next;
  };
}

/** The part of a socket event that can carry sealed text, as a message,
 *  and how to put the opened message back. */
function sealedPartOf(msg: any): { message: Sealable; put: (opened: any) => any } | null {
  if (msg?.type === "m.room.message") {
    return { message: msg, put: (opened) => opened };
  }
  if (msg?.type === "m.thread.message") {
    return {
      message: msg,
      put: (opened) => {
        const root = msg.thread_id ? openedBodies.get(msg.thread_id) : undefined;
        return root !== undefined ? { ...opened, thread_root_body: root.slice(0, REPLY_QUOTE_CHARS) } : opened;
      },
    };
  }
  if (msg?.type === "m.room.edit" && msg.new_e2e) {
    return {
      message: { event_id: msg.edits, sender: msg.sender, content: { e2e: msg.new_e2e, body: msg.new_body } },
      put: (opened) => ({ ...msg, new_body: opened.content.body, new_e2e_state: opened.content.e2e_state }),
    };
  }
  if (msg?.type === "m.room.pinned" && msg.message) {
    return { message: msg.message, put: (opened) => ({ ...msg, message: opened }) };
  }
  return null;
}

function eventOpenableNow(msg: any): boolean {
  const part = sealedPartOf(msg);
  return !part || !msg.room_id || openableNow(msg.room_id, part.message);
}

function openEventNow(msg: any): any {
  const part = sealedPartOf(msg);
  if (!part || !msg.room_id || !sealedOf(part.message)) return msg;
  return part.put(openOne(msg.room_id, part.message));
}

async function openEvent(msg: any): Promise<any> {
  const part = sealedPartOf(msg);
  if (part && msg.room_id) await openMany(msg.room_id, [part.message]);
  return openEventNow(msg);
}

/** Upload links in a body, as the server reads them (`media::attachment_folders`):
 *  a whitespace-separated token naming a file in a 32-hex upload folder. */
export function uploadLinks(body: string): string[] {
  const links = body
    .split(/\s+/)
    .map((t) => t.replace(/^[([<"']+/, "").replace(/[.,)\]>"'!?]+$/, ""))
    .filter((t) => /\/external\/[0-9a-f]{32}\/[^/]/i.test(t));
  return [...new Set(links)];
}

async function seal(roomId: string, body: string, inReplyTo?: string): Promise<SealedSend | null> {
  if (!encryptedRooms.has(roomId)) return null;
  if (!identity || !me) {
    throw new Error(
      status === "setup"
        ? "Set up encrypted messages to send in this conversation"
        : "Unlock encrypted messages to send in this conversation",
    );
  }
  let current = roomEpochs.get(roomId);
  if (!current || current.rotate || !roomKeys.get(roomId)?.has(current.epoch)) {
    await syncRoomKeys(roomId, true);
    current = roomEpochs.get(roomId);
  }
  const key = current ? roomKeys.get(roomId)?.get(current.epoch) : undefined;
  if (!current || !key) throw new Error("This conversation's key hasn't reached this device yet. Try again in a moment.");
  const replyQuote = inReplyTo ? openedBodies.get(inReplyTo)?.slice(0, REPLY_QUOTE_CHARS) : undefined;
  return {
    e2e: sealMessage(
      replyQuote !== undefined ? { body, reply_to_body: replyQuote } : { body },
      key,
      { roomId, epoch: current.epoch, sender: me },
      identity,
    ),
    attachments: uploadLinks(body),
  };
}

async function recover(roomId: string, errcode: string | undefined): Promise<boolean> {
  if (errcode === "M_E2E_REQUIRED") {
    // The room list was behind: this room is encrypted.
    encryptedRooms.add(roomId);
    if (identity) await syncRoomKeys(roomId, true).catch(() => {});
    return true;
  }
  if (errcode === "M_E2E_EPOCH" || errcode === "M_E2E_MEMBERS") {
    await syncRoomKeys(roomId, true).catch(() => {});
    return true;
  }
  return false;
}

configureMessageCrypto({
  seal,
  recover,
  open: (roomId, events) => openMany(roomId, events as Sealable[]) as Promise<typeof events>,
});
