import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two devices talking through a fake of the server's key routes
 * (`routes/e2e.rs`), which keeps the rules that matter here: an epoch starts
 * only when one is owed and reaches every member with keys, copies of the
 * current one go only to members without one, and a send is refused unless
 * it is sealed under the current epoch.
 */

type Copy = { epoch: number; user_id: string; sender: string; eph: string; nonce: string; ct: string; sig: string };

const server = {
  identities: new Map<string, any>(),
  rooms: new Map<string, { epoch: number; rotate: boolean; members: string[] }>(),
  copies: [] as Copy[],
  /** Who the next request comes from. Each device sets it before acting. */
  caller: "",
  sends: [] as any[],
};

class E2eRequestError extends Error {
  status: number;
  errcode?: string;
  constructor(message: string, status: number, errcode?: string) {
    super(message);
    this.status = status;
    this.errcode = errcode;
  }
}

vi.mock("../api", () => ({
  E2eRequestError,
  apiE2eGetIdentity: async () => server.identities.get(server.caller) ?? null,
  apiE2ePutIdentity: async (identity: any, replace: boolean) => {
    if (server.identities.has(server.caller) && !replace) throw new E2eRequestError("exists", 409, "M_E2E_EXISTS");
    server.identities.set(server.caller, identity);
    if (replace) server.copies = server.copies.filter((c) => c.user_id !== server.caller);
  },
  apiE2eQueryKeys: async (ids: string[]) =>
    Object.fromEntries(
      ids.filter((id) => server.identities.has(id)).map((id) => {
        const { enc_pub, sign_pub } = server.identities.get(id);
        return [id, { enc_pub, sign_pub }];
      }),
    ),
  apiE2eGetRoom: async (roomId: string) => {
    const room = server.rooms.get(roomId)!;
    return {
      e2e: true,
      epoch: room.epoch,
      rotate: room.rotate || room.epoch < 0,
      keys: server.copies.filter((c) => c.user_id === server.caller && c.sender !== undefined).filter((c) => keyRoom.get(c) === roomId),
      members: room.members.map((m) => ({
        user_id: m,
        has_identity: server.identities.has(m),
        has_key: server.copies.some((c) => keyRoom.get(c) === roomId && c.epoch === room.epoch && c.user_id === m),
      })),
    };
  },
  apiE2ePostRoomKeys: async (roomId: string, epoch: number, keys: any[]) => {
    const room = server.rooms.get(roomId)!;
    const owed = room.members.filter((m) => server.identities.has(m)).sort();
    const given = keys.map((k) => k.user_id).sort();
    const rotateOwed = room.rotate || room.epoch < 0;
    if (rotateOwed && epoch === room.epoch + 1) {
      if (JSON.stringify(owed) !== JSON.stringify(given)) throw new E2eRequestError("members", 409, "M_E2E_MEMBERS");
      room.epoch = epoch;
      room.rotate = false;
    } else if (epoch !== room.epoch || epoch < 0) {
      throw new E2eRequestError("epoch", 409, "M_E2E_EPOCH");
    }
    for (const k of keys) {
      if (server.copies.some((c) => keyRoom.get(c) === roomId && c.epoch === epoch && c.user_id === k.user_id)) continue;
      const copy = { ...k, epoch, sender: server.caller };
      keyRoom.set(copy, roomId);
      server.copies.push(copy);
    }
  },
}));

const keyRoom = new WeakMap<Copy, string>();

/** A device: its own module instances, so its keys are its own. */
async function device(userId: string) {
  vi.resetModules();
  const platform = await import("../platform");
  const secrets = new Map<string, string>();
  platform.configureHost({
    secretGet: async (name) => secrets.get(name) ?? null,
    secretSet: async (name, value) => void secrets.set(name, value),
    secretDelete: async (name) => void secrets.delete(name),
  });
  const session = await import("../e2e/session");
  const hooks = await import("../e2e/hooks");
  const as = async <T>(fn: () => Promise<T>): Promise<T> => {
    server.caller = userId;
    return fn();
  };
  /** Seal as this device and deliver as the server would store it. */
  const send = (roomId: string, body: string, inReplyTo?: string) =>
    as(async () => {
      // As `sendMaybeSealed` in api.ts: a send under a stale epoch is
      // refused, the session catches up, and the message is sealed again.
      const room = server.rooms.get(roomId)!;
      let sealed = await hooks.messageCrypto().seal(roomId, body, inReplyTo);
      if (sealed && (sealed.e2e.epoch !== room.epoch || room.rotate)) {
        expect(await hooks.messageCrypto().recover(roomId, "M_E2E_EPOCH")).toBe(true);
        sealed = await hooks.messageCrypto().seal(roomId, body, inReplyTo);
      }
      if (!sealed || sealed.e2e.epoch !== room.epoch || room.rotate) throw new Error("refused");
      const event = {
        event_id: `$${server.sends.length}`,
        room_id: roomId,
        sender: userId,
        type: "m.room.message",
        content: { msgtype: "m.text", body: "placeholder", e2e: sealed.e2e, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}) },
      };
      server.sends.push(event);
      return { event, sealed };
    });
  const read = (roomId: string, events: any[]) => as(() => hooks.messageCrypto().open(roomId, events));
  return { session, secrets, as, send, read };
}

beforeEach(() => {
  server.identities.clear();
  server.rooms.clear();
  server.copies = [];
  server.sends = [];
});

describe("e2e session", () => {
  it("sets up, locks on a new device and unlocks with the passphrase", async () => {
    const laptop = await device("@alice:x");
    expect(await laptop.as(() => laptop.session.startE2e("@alice:x"))).toBe("setup");
    await laptop.as(() => laptop.session.setUpE2e("correct horse battery"));
    expect(laptop.session.getE2eStatus()).toBe("ready");

    const phone = await device("@alice:x");
    expect(await phone.as(() => phone.session.startE2e("@alice:x"))).toBe("locked");
    expect(await phone.as(() => phone.session.unlockE2e("wrong passphrase"))).toBe(false);
    expect(await phone.as(() => phone.session.unlockE2e("correct horse battery"))).toBe(true);
    // Kept: the next start on this device needs no passphrase.
    expect(await phone.as(() => phone.session.startE2e("@alice:x"))).toBe("ready");

    // Signing out forgets it.
    await phone.session.stopE2e();
    expect(phone.secrets.size).toBe(0);
  }, 30_000);

  it("seals a DM that only its members can open, and hands the key to a late member", async () => {
    server.rooms.set("!dm", { epoch: -1, rotate: false, members: ["@alice:x", "@bob:x"] });
    const alice = await device("@alice:x");
    await alice.as(() => alice.session.startE2e("@alice:x"));
    await alice.as(() => alice.session.setUpE2e("alice passphrase"));
    alice.session.noteRoomEncryption("!dm", true);

    // Bob has not set up yet; the first key is made for Alice alone.
    const { event } = await alice.send("!dm", "hi bob");
    expect(server.rooms.get("!dm")!.epoch).toBe(0);
    expect(JSON.stringify(event)).not.toContain("hi bob");

    const bob = await device("@bob:x");
    await bob.as(() => bob.session.startE2e("@bob:x"));
    await bob.as(() => bob.session.setUpE2e("bob passphrase"));
    const [locked] = await bob.read("!dm", [event]);
    expect(locked.content.e2e_state).toBe("missing");

    // Alice's device answers Bob's arrival with a copy of the current key.
    await alice.as(() => alice.session.syncRoomKeys("!dm", true));
    const [opened] = await bob.read("!dm", [event]);
    expect(opened.content).toMatchObject({ body: "hi bob", e2e_state: "ok" });
  }, 30_000);

  it("makes a new key when membership changes, which a removed member cannot open", async () => {
    server.rooms.set("!group", { epoch: -1, rotate: false, members: ["@alice:x", "@bob:x", "@carol:x"] });
    const alice = await device("@alice:x");
    await alice.as(() => alice.session.startE2e("@alice:x"));
    await alice.as(() => alice.session.setUpE2e("alice passphrase"));
    const carol = await device("@carol:x");
    await carol.as(() => carol.session.startE2e("@carol:x"));
    await carol.as(() => carol.session.setUpE2e("carol passphrase"));
    alice.session.noteRoomEncryption("!group", true);

    const before = await alice.send("!group", "before carol left");
    expect((await carol.read("!group", [before.event]))[0].content.body).toBe("before carol left");

    // Carol leaves: the server owes the room a new epoch.
    const room = server.rooms.get("!group")!;
    room.members = ["@alice:x", "@bob:x"];
    room.rotate = true;

    const after = await alice.send("!group", "after carol left");
    expect(after.sealed.e2e.epoch).toBe(1);
    expect((await carol.read("!group", [after.event]))[0].content.e2e_state).toBe("missing");
    expect((await alice.read("!group", [after.event]))[0].content.body).toBe("after carol left");
  }, 30_000);

  it("quotes the message replied to inside the seal", async () => {
    server.rooms.set("!dm", { epoch: -1, rotate: false, members: ["@alice:x"] });
    const alice = await device("@alice:x");
    await alice.as(() => alice.session.startE2e("@alice:x"));
    await alice.as(() => alice.session.setUpE2e("alice passphrase"));
    alice.session.noteRoomEncryption("!dm", true);
    const first = await alice.send("!dm", "what time?");
    await alice.read("!dm", [first.event]);
    const reply = await alice.send("!dm", "noon", first.event.event_id);
    const [opened] = await alice.read("!dm", [{ ...reply.event, content: { ...reply.event.content, reply_to_body: "placeholder" } }]);
    expect(opened.content.reply_to_body).toBe("what time?");
  }, 30_000);
});

describe("uploadLinks", () => {
  it("finds the links the server would count as uploads", async () => {
    const { uploadLinks } = await import("../e2e/session");
    const upload = "https://chat.example/external/0123456789abcdef0123456789abcdef/cat.png";
    expect(uploadLinks(`look (${upload}) and https://elsewhere.example/x.png`)).toEqual([upload]);
    expect(uploadLinks("no links here")).toEqual([]);
  });
});
