/**
 * This device's side of end-to-end encrypted DMs: whether encryption is set up
 * and unlocked, the room keys it holds, the contacts' keys it trusts, and
 * sealing and opening messages. The design note is `docs/design/e2e-dms.md`;
 * the cryptography is `crypto.ts`.
 *
 * Status, as the app shows it:
 * - `off` — nobody is signed in, or it has not been asked yet.
 * - `setup` — the account has never set up encryption.
 * - `locked` — it has, on another device or before a sign-out, and this one
 *   needs the passphrase.
 * - `ready` — this device holds the seed.
 * - `error` — the server could not be asked. Tried again on the next start.
 *
 * Three things are kept on the device, per account: the seed (forgotten on
 * sign-out), the contacts' keys as first seen ("pins"), and which rooms are
 * encrypted. The last two are what let this device notice the server lying:
 * a contact whose keys changed, or an encrypted room said to be plaintext.
 * Room keys are kept in memory only and fetched again each session.
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
  newIdentity,
  newMessageId,
  newRoomKey,
  openBackup,
  openMessage,
  passphraseProblem,
  publicIdentity,
  sameBytes,
  sealBackup,
  sealMessage,
  toB64,
  unwrapRoomKey,
  wrapRoomKey,
  type Identity,
  type MessagePlaintext,
  type SealedMessage,
} from "./crypto";
import { configureMessageCrypto, type E2eMessageState, type SealedSend, type SealMeta } from "./hooks";

export type E2eStatus = "off" | "setup" | "locked" | "ready" | "error";

/** What a message says in place of its text when it cannot be shown. */
export const E2E_UNREADABLE: Record<Exclude<E2eMessageState, "ok" | "unverified">, string> = {
  locked: "🔒 Unlock encrypted messages to read this",
  missing: "🔒 This message's key isn't on this device",
  broken: "🔒 This message couldn't be decrypted",
  forged: "⚠️ This message isn't what it claims to be, so it isn't shown",
};

type PublicKeys = { enc: Uint8Array; sign: Uint8Array };

let me: string | null = null;
let identity: Identity | null = null;
let status: E2eStatus = "off";
/** The seed this device kept no longer matches the account's keys: they were
 *  replaced from somewhere else. */
let keysReplacedElsewhere = false;
/** Bumped by every sign-in and sign-out, so work started for one account
 *  cannot land in the next. */
let generation = 0;
const listeners = new Set<() => void>();

const encryptedRooms = new Set<string>();
const roomKeys = new Map<string, Map<number, Uint8Array>>();
const roomEpochs = new Map<string, { epoch: number; rotate: boolean }>();
/** Members' public keys as this device trusts them. `null` is "asked, and
 *  they have none". */
const publicKeys = new Map<string, PublicKeys | null>();
/** Contacts' keys as first seen, kept on the device. */
let pins: Record<string, { enc_pub: string; sign_pub: string }> = {};
/** Contacts whose keys the server now gives differently from their pin: the
 *  keys it gives, waiting for the person to accept them. */
const changedKeys = new Map<string, PublicKeys>();
let changedKeysSnapshot: string[] = [];
const roomSyncs = new Map<string, Promise<void>>();
/** Opened bodies by event id, for quoting in a reply: the server cannot
 *  quote what it cannot read, so the reply carries the quote sealed. */
const openedBodies = new Map<string, string>();
/** What each opened message was sealed with besides its text, by event id:
 *  an edit must carry the same, and no other event may carry its `mid`. */
const openedMeta = new Map<string, { mid: string; in_reply_to?: string; thread_id?: string; spoiler?: boolean }>();
const midOwners = new Map<string, string>();
const OPENED_KEPT = 2000;
const REPLY_QUOTE_CHARS = 100;

const seedName = (userId: string) => `e2e-seed:${userId}`;
const pinsName = (userId: string) => `e2e-pins:${userId}`;
const roomsName = (userId: string) => `e2e-rooms:${userId}`;

function notify() {
  for (const listener of listeners) listener();
}

function setStatus(next: E2eStatus) {
  if (status === next) return;
  status = next;
  notify();
}

export function getE2eStatus(): E2eStatus {
  return status;
}

export function getKeysReplacedElsewhere(): boolean {
  return keysReplacedElsewhere;
}

/** Contacts whose keys have changed since this device first saw them. The
 *  same array until it changes, so it can be a React snapshot. */
export function getChangedKeys(): string[] {
  return changedKeysSnapshot;
}

/** Called on every status or key-change update. Returns the unsubscribe. */
export function subscribeE2e(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── What the device keeps ──────────────────────────────────────────────────

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    const raw = await host.secretGet(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePins() {
  if (me) void host.secretSet(pinsName(me), JSON.stringify(pins)).catch(() => {});
}

function saveRooms() {
  if (me) void host.secretSet(roomsName(me), JSON.stringify([...encryptedRooms])).catch(() => {});
}

/** Remember that a room is encrypted, for good. */
function markEncrypted(roomId: string) {
  if (encryptedRooms.has(roomId)) return;
  encryptedRooms.add(roomId);
  saveRooms();
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * Find out where this account stands, for the account signed in as `userId`.
 * The seed this device kept is used only if it still matches the keys the
 * server holds. One that does not is kept, not deleted: a server answer alone
 * must not be able to wipe this device's keys.
 */
export async function startE2e(userId: string): Promise<E2eStatus> {
  if (me !== userId) clearSession();
  me = userId;
  const gen = generation;
  try {
    const [record, stored, storedPins, storedRooms] = await Promise.all([
      apiE2eGetIdentity(),
      host.secretGet(seedName(userId)).catch(() => null),
      readJson<typeof pins>(pinsName(userId), {}),
      readJson<string[]>(roomsName(userId), []),
    ]);
    if (gen !== generation) return status;
    pins = { ...storedPins, ...pins };
    for (const roomId of storedRooms) encryptedRooms.add(roomId);
    keysReplacedElsewhere = false;
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
      keysReplacedElsewhere = true;
    }
    identity = null;
    setStatus("locked");
    notify();
  } catch {
    if (gen === generation) setStatus("error");
  }
  return status;
}

async function adopt(next: Identity) {
  identity = next;
  keysReplacedElsewhere = false;
  if (me) await host.secretSet(seedName(me), toB64(next.seed)).catch(() => {});
  // Anything opened as "locked" can be opened now; keys fetched before are
  // still good, but rooms are re-asked so copies made meanwhile arrive.
  roomSyncs.clear();
  setStatus("ready");
  notify();
}

/**
 * Make this account's keys and back them up under `passphrase`. `totpCode`
 * (authenticator or recovery code) is required by the server: a signed-in
 * session alone must not be able to change who can read the account's DMs.
 *
 * `replace` starts over when the passphrase is lost: every key wrapped to the
 * old identity is dropped by the server, so messages from before are lost to
 * this account, and members hand it the current keys again once they accept
 * its new ones.
 */
export async function setUpE2e(passphrase: string, totpCode: string, replace = false): Promise<void> {
  if (!me) throw new Error("Not signed in");
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const next = newIdentity();
  const backup = await sealBackup(next.seed, passphrase, me);
  try {
    await apiE2ePutIdentity({ ...publicIdentity(next), backup }, totpCode, replace);
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
  keysReplacedElsewhere = false;
  encryptedRooms.clear();
  roomKeys.clear();
  roomEpochs.clear();
  publicKeys.clear();
  pins = {};
  changedKeys.clear();
  changedKeysSnapshot = [];
  roomSyncs.clear();
  openedBodies.clear();
  openedMeta.clear();
  midOwners.clear();
}

/** Signing out: this device forgets the seed, so the next person at it
 *  cannot read the conversation without the passphrase. The pins and the
 *  list of encrypted rooms stay: they are not secret, and they are what
 *  catches the server lying on the next sign-in. */
export async function stopE2e(): Promise<void> {
  const userId = me;
  clearSession();
  me = null;
  setStatus("off");
  if (userId) await host.secretDelete(seedName(userId)).catch(() => {});
}

// ─── Contacts' keys ─────────────────────────────────────────────────────────

function sameKeys(a: { enc_pub: string; sign_pub: string }, b: { enc_pub: string; sign_pub: string }) {
  return a.enc_pub === b.enc_pub && a.sign_pub === b.sign_pub;
}

function publishChanged() {
  changedKeysSnapshot = [...changedKeys.keys()];
  notify();
}

/**
 * Members' keys, checked against what this device first saw for them.
 *
 * Someone seen for the first time is pinned. Someone whose keys differ from
 * their pin keeps being trusted with the *pinned* keys — nothing is wrapped
 * to the new ones, and messages signed with them do not verify — until the
 * person here accepts the change (`acceptKeyChange`). A real reset and an
 * impostor look the same from here; only the people involved can tell.
 */
async function loadPublicKeys(userIds: string[]): Promise<void> {
  const wanted = [...new Set(userIds)].filter((id) => id && !publicKeys.has(id));
  if (me && identity && wanted.includes(me)) publicKeys.set(me, { enc: identity.encPub, sign: identity.signPub });
  const others = wanted.filter((id) => id !== me);
  let pinsChanged = false;
  let changed = false;
  for (let i = 0; i < others.length; i += 100) {
    const batch = others.slice(i, i + 100);
    const keys = await apiE2eQueryKeys(batch);
    for (const id of batch) {
      const k = keys[id];
      const pin = pins[id];
      if (!k) {
        publicKeys.set(id, pin ? { enc: fromB64(pin.enc_pub), sign: fromB64(pin.sign_pub) } : null);
        continue;
      }
      if (!pin) {
        pins[id] = { enc_pub: k.enc_pub, sign_pub: k.sign_pub };
        pinsChanged = true;
      } else if (!sameKeys(pin, k)) {
        changedKeys.set(id, { enc: fromB64(k.enc_pub), sign: fromB64(k.sign_pub) });
        changed = true;
      } else if (changedKeys.delete(id)) {
        changed = true;
      }
      const trusted = pins[id];
      publicKeys.set(id, { enc: fromB64(trusted.enc_pub), sign: fromB64(trusted.sign_pub) });
    }
  }
  if (pinsChanged) savePins();
  if (changed) publishChanged();
}

/** Trust a contact's new keys. Their messages under them verify from now
 *  on, and they are handed this device's room keys again. */
export async function acceptKeyChange(userId: string): Promise<void> {
  const next = changedKeys.get(userId);
  if (!next) return;
  pins[userId] = { enc_pub: toB64(next.enc), sign_pub: toB64(next.sign) };
  publicKeys.set(userId, next);
  changedKeys.delete(userId);
  savePins();
  publishChanged();
  for (const roomId of encryptedRooms) {
    if (roomKeys.has(roomId)) void syncRoomKeys(roomId, true).catch(() => {});
  }
}

/** Raised instead of sending a key to someone whose keys changed. */
export class E2eKeysChangedError extends Error {
  readonly userIds: string[];
  constructor(userIds: string[]) {
    super("Someone's encryption keys changed. Review the change in this conversation before sending.");
    this.userIds = userIds;
  }
}

// ─── Rooms and their keys ───────────────────────────────────────────────────

/**
 * Record what the room list says about encryption, so a send knows to seal
 * before it is sent rather than after the server refuses it. Only ever adds:
 * a room once seen encrypted stays encrypted here whatever the server says
 * later, or a server could turn encryption off by saying so.
 */
export function noteRoomEncryption(roomId: string, e2e: boolean): void {
  if (e2e) markEncrypted(roomId);
}

export function isRoomEncrypted(roomId: string): boolean {
  return encryptedRooms.has(roomId);
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
    if (encryptedRooms.has(roomId)) {
      throw new Error("The server says this encrypted conversation isn't encrypted. Nothing will be sent in the clear.");
    }
    return;
  }
  markEncrypted(roomId);
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

/**
 * Open this account's copies of the room's keys.
 *
 * Every copy must be signed by its maker's trusted keys. The current epoch's,
 * which this device will *send* under, must also come from someone in the
 * room whose keys have not changed: otherwise anyone the server vouched for
 * could hand this device a key of their own and read what it sends. Older
 * epochs are only read with, and may come from someone who has since left.
 */
function openCopies(roomId: string, room: E2eRoomState) {
  if (!identity || !me) return;
  const members = new Set((room.members ?? []).map((m) => m.user_id));
  const held = roomKeys.get(roomId) ?? new Map<number, Uint8Array>();
  for (const copy of room.keys ?? []) {
    if (held.has(copy.epoch)) continue;
    const signer = publicKeys.get(copy.sender);
    if (!signer) continue;
    if (copy.epoch === room.epoch && (!members.has(copy.sender) || changedKeys.has(copy.sender))) continue;
    const key = unwrapRoomKey(copy, { roomId, epoch: copy.epoch, recipient: me, sender: copy.sender }, identity, signer.sign);
    if (key) held.set(copy.epoch, key);
  }
  roomKeys.set(roomId, held);
}

/** Make the room's next key and give every member who can hold one a copy.
 *  Refused while any of them has changed keys: the new key would go to
 *  whoever holds those. */
async function startEpoch(roomId: string, epoch: number, recipients: string[]) {
  if (!identity || !me) return;
  const unreviewed = recipients.filter((id) => changedKeys.has(id));
  if (unreviewed.length > 0) throw new E2eKeysChangedError(unreviewed);
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
 *  possible for a device holding the key itself, and never for someone whose
 *  keys changed until that is accepted — a stolen session that replaced an
 *  account's keys must not be handed the conversation automatically. */
async function handOut(roomId: string, room: E2eRoomState) {
  if (!identity || !me || room.epoch === undefined || room.epoch < 0) return;
  const key = roomKeys.get(roomId)?.get(room.epoch);
  if (!key) return;
  const owed = (room.members ?? []).filter(
    (m) => m.has_identity && !m.has_key && publicKeys.get(m.user_id) && !changedKeys.has(m.user_id),
  );
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
    markEncrypted(roomId);
    return false;
  }
  if (!type.startsWith("m.e2e.")) return false;
  if (!roomId || type === IGNORED.type) return true;
  // Asked again next time, and checked against the pin then.
  if (type === "m.e2e.identity" && msg.user_id) publicKeys.delete(msg.user_id);
  if (status !== "ready") return true;
  const delay = type === "m.e2e.room_key" ? 0 : Math.random() * 1500;
  setTimeout(() => {
    void (async () => {
      // A key change is surfaced at once, not on the next room open.
      if (type === "m.e2e.identity" && msg.user_id) await loadPublicKeys([msg.user_id]).catch(() => {});
      await syncRoomKeys(roomId, true);
    })().catch(() => {});
  }, delay);
  return true;
}

// ─── Messages ───────────────────────────────────────────────────────────────

type Sealable = { type?: string; event_id?: string; room_id?: string; sender?: string; thread_id?: string; content?: any };

/** Message types the server makes itself, which are not sealed and are not
 *  anyone's words. */
const SERVER_MSGTYPES = new Set(["m.system", "m.poll", "m.poll_results"]);

function sealedOf(msg: Sealable): SealedMessage | null {
  const sealed = msg.content?.e2e;
  return sealed && typeof sealed === "object" ? (sealed as SealedMessage) : null;
}

/** A person's message, sent in the clear into a room that is encrypted. */
function plaintextInEncryptedRoom(roomId: string, msg: Sealable): boolean {
  if (!encryptedRooms.has(roomId) || sealedOf(msg) || !msg.content) return false;
  if (msg.type && msg.type !== "m.room.message" && msg.type !== "m.thread.message") return false;
  return !SERVER_MSGTYPES.has(msg.content.msgtype);
}

/** Whether this message can be opened right now, without asking the server
 *  for anything. */
function openableNow(roomId: string, msg: Sealable): boolean {
  const sealed = sealedOf(msg);
  if (!sealed || !identity) return true;
  return !!roomKeys.get(roomId)?.has(sealed.epoch) && (!msg.sender || publicKeys.has(msg.sender));
}

function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  if (map.size > OPENED_KEPT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Whether what was sealed agrees with what the server says about the message.
 * Messages from before `mid` was sealed carry none of this and are taken as
 * they are.
 */
function bindingHolds(msg: Sealable, p: MessagePlaintext): boolean {
  if (p.mid === undefined) return true;
  if ((p.in_reply_to ?? undefined) !== (msg.content?.in_reply_to ?? undefined)) return false;
  if ((p.thread_id ?? undefined) !== (msg.thread_id ?? undefined)) return false;
  if (msg.event_id) {
    // The same sealed message under another event is a replay; an edit must
    // keep the id of the message it edits.
    const owner = midOwners.get(p.mid);
    if (owner !== undefined && owner !== msg.event_id) return false;
    const known = openedMeta.get(msg.event_id);
    if (known && known.mid !== p.mid) return false;
  }
  return true;
}

function openOne<T extends Sealable>(roomId: string, msg: T): T {
  const unreadable = (state: keyof typeof E2E_UNREADABLE): T => ({
    ...msg,
    content: { ...msg.content, body: E2E_UNREADABLE[state], reply_to_body: undefined, e2e_state: state },
  });
  const sealed = sealedOf(msg);
  if (!sealed) return plaintextInEncryptedRoom(roomId, msg) ? unreadable("forged") : msg;
  if (!identity) return unreadable("locked");
  const key = roomKeys.get(roomId)?.get(sealed.epoch);
  if (!key) return unreadable("missing");
  const signer = msg.sender ? publicKeys.get(msg.sender) : undefined;
  const opened = openMessage(sealed, key, { roomId, epoch: sealed.epoch, sender: msg.sender ?? "" }, signer?.sign ?? null);
  if (!opened.ok) return unreadable("broken");
  const p = opened.plaintext;
  if (!bindingHolds(msg, p)) return unreadable("forged");
  if (msg.event_id) {
    remember(openedBodies, msg.event_id, p.body);
    if (p.mid !== undefined) {
      remember(midOwners, p.mid, msg.event_id);
      remember(openedMeta, msg.event_id, { mid: p.mid, in_reply_to: p.in_reply_to, thread_id: p.thread_id, spoiler: p.spoiler });
    }
  }
  const inReplyTo = msg.content?.in_reply_to as string | undefined;
  const replyQuote = p.reply_to_body ?? (inReplyTo ? openedBodies.get(inReplyTo)?.slice(0, REPLY_QUOTE_CHARS) : undefined);
  return {
    ...msg,
    content: {
      ...msg.content,
      body: p.body,
      // The server's quote is the parent's placeholder; never show that.
      reply_to_body: inReplyTo ? (replyQuote ?? "🔒 Encrypted message") : msg.content?.reply_to_body,
      // Sealed, so the server cannot reveal a spoiler by dropping the flag.
      ...(p.mid !== undefined ? { spoiler: p.spoiler === true } : {}),
      e2e_state: opened.verified ? "ok" : "unverified",
    },
  };
}

/** Fetch whatever is needed to open these messages, then open them. */
async function openMany<T extends Sealable>(roomId: string, events: T[]): Promise<T[]> {
  const sealed = events.filter((e) => sealedOf(e));
  if (sealed.length > 0) {
    markEncrypted(roomId);
    if (identity) {
      try {
        if (sealed.some((e) => !roomKeys.get(roomId)?.has(sealedOf(e)!.epoch))) await syncRoomKeys(roomId);
        await loadPublicKeys(sealed.map((e) => e.sender ?? "").filter(Boolean));
      } catch {}
    }
  }
  // Oldest first, so a message's own id is known before any edit or replay of it.
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

/** What an edit that must not be applied becomes: nothing handles it. */
const IGNORED = { type: "m.e2e.ignored" };

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
  if (msg?.type === "m.room.edit") {
    const target = openedMeta.get(msg.edits);
    return {
      message: {
        type: "m.room.message",
        event_id: msg.edits,
        sender: msg.sender,
        thread_id: target?.thread_id,
        content: { e2e: msg.new_e2e, body: msg.new_body, in_reply_to: target?.in_reply_to },
      },
      put: (opened) => {
        const state = opened.content.e2e_state as E2eMessageState | undefined;
        // An edit in the clear, or one that is not an edit of this message,
        // changes nothing.
        if (state === "forged") return { ...IGNORED, room_id: msg.room_id };
        return { ...msg, new_body: opened.content.body, new_e2e_state: state };
      },
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
  if (!part || !msg.room_id) return msg;
  const opened = openOne(msg.room_id, part.message);
  return opened === part.message ? msg : part.put(opened);
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

async function seal(roomId: string, body: string, meta: SealMeta = {}): Promise<SealedSend | null> {
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

  let plaintext: MessagePlaintext;
  if (meta.edits) {
    // An edit is the same message with new text: same id, same reply, same
    // thread, same spoiler — or the binding check refuses it everywhere.
    const original = openedMeta.get(meta.edits);
    if (!original) throw new Error("This message can't be edited from here. Reload and try again.");
    plaintext = { body, mid: original.mid };
    if (original.in_reply_to) plaintext.in_reply_to = original.in_reply_to;
    if (original.thread_id) plaintext.thread_id = original.thread_id;
    if (original.spoiler) plaintext.spoiler = true;
    const quote = original.in_reply_to ? openedBodies.get(original.in_reply_to) : undefined;
    if (quote !== undefined) plaintext.reply_to_body = quote.slice(0, REPLY_QUOTE_CHARS);
  } else {
    plaintext = { body, mid: newMessageId() };
    if (meta.inReplyTo) {
      plaintext.in_reply_to = meta.inReplyTo;
      const quote = openedBodies.get(meta.inReplyTo);
      if (quote !== undefined) plaintext.reply_to_body = quote.slice(0, REPLY_QUOTE_CHARS);
    }
    if (meta.threadId) plaintext.thread_id = meta.threadId;
    if (meta.spoiler) plaintext.spoiler = true;
  }
  return {
    e2e: sealMessage(plaintext, key, { roomId, epoch: current.epoch, sender: me }, identity),
    attachments: uploadLinks(body),
  };
}

async function recover(roomId: string, errcode: string | undefined): Promise<boolean> {
  if (errcode === "M_E2E_REQUIRED") {
    // The room list was behind: this room is encrypted.
    markEncrypted(roomId);
    if (identity) await syncRoomKeys(roomId, true).catch(() => {});
    return true;
  }
  if (errcode === "M_E2E_EPOCH" || errcode === "M_E2E_MEMBERS") {
    await syncRoomKeys(roomId, true);
    return true;
  }
  return false;
}

configureMessageCrypto({
  seal,
  recover,
  open: (roomId, events) => openMany(roomId, events as Sealable[]) as Promise<typeof events>,
});
