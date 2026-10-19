/**
 * Seed a local Chatter server with accounts and content to develop against.
 *
 *   npx tsx scripts/seed-dev.mts [http://localhost:8000]
 *
 * Talks to the server through @chatter/core's own API wrappers, configured as
 * a native client would be (an origin and a refresh-token store), so it also
 * exercises that path. Safe to re-run: accounts that exist are signed in, and
 * the test server is created once.
 *
 * Credentials are generated on first run and kept outside the repository, in
 * ~/.chatter-dev/test-accounts.json, with each account's TOTP secret, so a
 * sign-in code can be computed later:
 *
 *   npx tsx scripts/seed-dev.mts --code alice_dev
 *
 * Never point this at a server other people use.
 */
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The core keeps small UI state in Web Storage; Node has none.
const memory = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: (i: number) => [...memory.keys()][i] ?? null,
  get length() {
    return memory.size;
  },
};

const api = await import("@chatter/core/api");

const DEV_DIR = path.join(os.homedir(), ".chatter-dev");
const ACCOUNTS_FILE = path.join(DEV_DIR, "test-accounts.json");

interface Account {
  username: string;
  password: string;
  totpSecret?: string;
  userId?: string;
}

// ─── TOTP (RFC 6238: SHA-1, 6 digits, 30 s — as routes/auth.rs builds it) ──────

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

function loadAccounts(): Account[] {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch {
    const make = (username: string): Account => ({
      username,
      password: randomBytes(18).toString("base64url"),
    });
    return [make("alice_dev"), make("bob_dev"), make("cara_dev")];
  }
}

function saveAccounts(accounts: Account[]) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2) + "\n", { mode: 0o600 });
}

/** Each account's session for this run. The server rate-limits sign-ins, so
 *  an account signs in once and the script switches between their tokens. */
const sessions = new Map<string, { access: string; refresh: string | null }>();

function useSession(account: Account) {
  const session = sessions.get(account.username)!;
  api.configureApi({
    refreshTokenStore: {
      get: () => session.refresh,
      set: (t) => void (session.refresh = t),
    },
  });
  api.setAccessToken(session.access);
}

async function signIn(account: Account): Promise<void> {
  if (sessions.has(account.username)) return useSession(account);
  const session = { access: "", refresh: null as string | null };
  sessions.set(account.username, session);
  useSession(account);
  if (!account.totpSecret) {
    const reg = await api.apiRegister(account.username, account.password, account.password);
    account.totpSecret = reg.totp_secret;
    account.userId = reg.user_id;
    const verified = await api.apiVerifyTotp(reg.user_id, totp(reg.totp_secret));
    session.access = verified.access_token;
    console.log(`registered ${account.username}${reg.is_admin ? " (server admin)" : ""}`);
  } else {
    const login = await api.apiLogin(account.username, account.password, totp(account.totpSecret));
    session.access = login.access_token;
    account.userId = login.user_id;
  }
  api.setAccessToken(session.access);
}

// ─── Content ──────────────────────────────────────────────────────────────────

const SERVER_NAME = "Mobile Test Server";
const LAST_MESSAGE = "Newest message — the timeline should open here.";

async function findOrCreateServer(owner: Account): Promise<string> {
  await signIn(owner);
  const joined = await api.apiGetJoinedRooms();
  const sync = await api.apiSync();
  for (const roomId of joined.joined_rooms) {
    const name = sync.rooms?.join?.[roomId]?.state.events.find((e: { type: string }) => e.type === "m.room.name");
    if (name?.content?.name === SERVER_NAME) return roomId;
  }
  const created = await api.apiCreateRoom(SERVER_NAME, "Where the mobile app is tested", ["dev"]);
  const roomId = created.room_id;
  console.log(`created ${SERVER_NAME} (${roomId})`);
  for (const [name, channel_type] of [
    ["announcements", "text"],
    ["random", "text"],
    ["help-forum", "forum"],
    ["Lounge", "voice"],
  ] as const) {
    await api.apiCreateChannel(roomId, { name, channel_type });
  }
  return roomId;
}

async function seedMessages(roomId: string, accounts: Account[]) {
  const [alice, bob, cara] = accounts;
  await signIn(alice);
  const { channels } = await api.apiGetChannels(roomId);
  const text = channels.filter((c) => c.channel_type === "text");
  const general = text.find((c) => c.name === "general") ?? text[0];
  const forum = channels.find((c) => c.channel_type === "forum");
  // The last message posted marks a finished seed; a run that stopped part way
  // is easier to redo on a fresh database than to resume.
  const existing = await api.apiGetMessages(roomId, 5, undefined, undefined, general.channel_id);
  if (existing.chunk.some((m) => m.content?.body === LAST_MESSAGE)) {
    console.log("messages already seeded");
    return;
  }

  // The server rate-limits sending; wait as long as it asks and go again.
  const say = async (who: Account, body: string, channelId = general.channel_id, replyTo?: string): Promise<string> => {
    await signIn(who);
    for (;;) {
      try {
        const sent = await api.apiSendMessage(roomId, body, replyTo, false, channelId);
        return sent.event_id as string;
      } catch (e) {
        const wait = /try again in (\d+)s/.exec(String(e));
        if (!wait) throw e;
        await new Promise((r) => setTimeout(r, (Number(wait[1]) + 1) * 1000));
      }
    }
  };

  const hello = await say(alice, "Welcome to the **mobile test server** 👋 — this is where the app gets tried out.");
  await say(bob, "Hey! Trying _markdown_, `inline code`, ~~strikethrough~~ and a link: https://github.com");
  await say(cara, "```ts\nconst greeting = (name: string) => `hello ${name}`;\n```");
  await say(bob, `@${alice.username} does the reply preview show up on mobile?`, general.channel_id, hello);
  await say(alice, "> a quote, for the record\n\nand a spoiler: ||the cake is a lie||");
  for (let i = 1; i <= 60; i++) {
    await say(i % 2 ? bob : cara, `Filler message ${i} so there is history to scroll and page through.`);
  }
  await say(alice, LAST_MESSAGE);

  await signIn(cara);
  await api.apiAddReaction(roomId, hello, "🎉");
  await signIn(bob);
  await api.apiAddReaction(roomId, hello, "🎉");
  await api.apiAddReaction(roomId, hello, "👍");

  const random = text.find((c) => c.name === "random");
  if (random) await say(cara, "Something in #random, so there is an unread elsewhere.", random.channel_id);

  if (forum) {
    await signIn(alice);
    await api.apiCreateForumPost(roomId, "How do I report a bug?", "Post it here with steps to reproduce.", [], [], [], forum.channel_id, []);
  }
  console.log("seeded messages, reactions and a forum post");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args[0] === "--code") {
  const account = loadAccounts().find((a) => a.username === args[1]);
  if (!account?.totpSecret) throw new Error(`No seeded account ${args[1]}`);
  console.log(totp(account.totpSecret));
  process.exit(0);
}

const origin = args[0] ?? "http://localhost:8000";
const host = new URL(origin).hostname;
if (!["localhost", "127.0.0.1"].includes(host)) {
  throw new Error(`Refusing to seed ${origin}: this script is for a local development server only.`);
}
api.configureApi({ origin });

const accounts = loadAccounts();
try {
  for (const account of accounts) await signIn(account);
  saveAccounts(accounts);
  const roomId = await findOrCreateServer(accounts[0]);
  const invite = await api.apiCreateInvite(roomId);
  for (const member of accounts.slice(1)) {
    await signIn(member);
    try {
      await api.apiAcceptInvite(invite.code);
    } catch (e) {
      if (!String(e).includes("already")) throw e;
    }
  }
  await seedMessages(roomId, accounts);
  console.log(`\nDone. Accounts: ${accounts.map((a) => a.username).join(", ")} — passwords in ${ACCOUNTS_FILE}`);
} finally {
  saveAccounts(accounts);
}
