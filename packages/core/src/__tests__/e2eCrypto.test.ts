import { describe, expect, it } from "vitest";
import {
  fromB64,
  identityFromSeed,
  newIdentity,
  newRoomKey,
  openBackup,
  openMessage,
  sameBytes,
  sealBackup,
  sealMessage,
  toB64,
  unwrapRoomKey,
  wrapRoomKey,
} from "../e2e/crypto";

describe("base64", () => {
  it("round-trips every length and matches the standard alphabet", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(sameBytes(fromB64(toB64(bytes)), bytes)).toBe(true);
      expect(toB64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

describe("identity", () => {
  it("derives the same keys from the same seed", () => {
    const a = newIdentity();
    const b = identityFromSeed(a.seed);
    expect(sameBytes(a.encPub, b.encPub)).toBe(true);
    expect(sameBytes(a.signPub, b.signPub)).toBe(true);
  });

  it("opens its backup with the passphrase and nothing else", async () => {
    const me = newIdentity();
    const backup = await sealBackup(me.seed, "correct horse", "@alice:x");
    expect(fromB64(backup.ct).length).toBe(48);
    const seed = await openBackup(backup, "correct horse", "@alice:x");
    expect(seed && sameBytes(seed, me.seed)).toBe(true);
    expect(await openBackup(backup, "wrong horse", "@alice:x")).toBeNull();
    // Bound to its account: the server cannot pass it off as someone else's.
    expect(await openBackup(backup, "correct horse", "@mallory:x")).toBeNull();
  }, 20_000);
});

describe("room keys", () => {
  const alice = newIdentity();
  const bob = newIdentity();
  const context = { roomId: "!dm", epoch: 0, recipient: "@bob:x", sender: "@alice:x" };

  it("reach the member they were wrapped to, signed by whoever made them", () => {
    const key = newRoomKey();
    const wrapped = wrapRoomKey(key, bob.encPub, context, alice);
    expect(fromB64(wrapped.ct).length).toBe(48);
    const opened = unwrapRoomKey(wrapped, context, bob, alice.signPub);
    expect(opened && sameBytes(opened, key)).toBe(true);
  });

  it("refuse a copy signed by anyone but its claimed maker", () => {
    // What the server could do on its own: wrap a key it chose to bob.
    const server = newIdentity();
    const forged = wrapRoomKey(newRoomKey(), bob.encPub, context, server);
    expect(unwrapRoomKey(forged, context, bob, alice.signPub)).toBeNull();
  });

  it("refuse a copy moved to another room, epoch or member", () => {
    const wrapped = wrapRoomKey(newRoomKey(), bob.encPub, context, alice);
    expect(unwrapRoomKey(wrapped, { ...context, roomId: "!other" }, bob, alice.signPub)).toBeNull();
    expect(unwrapRoomKey(wrapped, { ...context, epoch: 1 }, bob, alice.signPub)).toBeNull();
    expect(unwrapRoomKey(wrapped, context, alice, alice.signPub)).toBeNull();
  });
});

describe("messages", () => {
  const alice = newIdentity();
  const key = newRoomKey();
  const context = { roomId: "!dm", epoch: 3, sender: "@alice:x" };

  it("open under the key, room, epoch and sender they were sealed for", () => {
    const sealed = sealMessage({ body: "hi bob", reply_to_body: "hey" }, key, context, alice);
    const opened = openMessage(sealed, key, context, alice.signPub);
    expect(opened).toEqual({ ok: true, plaintext: { body: "hi bob", reply_to_body: "hey" }, verified: true });

    expect(openMessage(sealed, newRoomKey(), context, alice.signPub).ok).toBe(false);
    // The server names the sender; one it lies about does not open.
    expect(openMessage(sealed, key, { ...context, sender: "@mallory:x" }, alice.signPub).ok).toBe(false);
    expect(openMessage(sealed, key, { ...context, roomId: "!elsewhere" }, alice.signPub).ok).toBe(false);
  });

  it("open but do not verify against another signing key", () => {
    const sealed = sealMessage({ body: "hi" }, key, context, alice);
    const opened = openMessage(sealed, key, context, newIdentity().signPub);
    expect(opened.ok && opened.verified).toBe(false);
    expect(opened.ok && opened.plaintext.body).toBe("hi");
  });

  it("do not open after tampering", () => {
    const sealed = sealMessage({ body: "hi" }, key, context, alice);
    const ct = fromB64(sealed.ct);
    ct[0] ^= 1;
    expect(openMessage({ ...sealed, ct: toB64(ct) }, key, context, alice.signPub).ok).toBe(false);
  });
});
