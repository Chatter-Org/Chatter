# End-to-end encrypted DMs

Identity keys, room keys and epochs, sealed messages, and what the server can and cannot see. Read before changing `routes/e2e.rs`, `packages/core/src/e2e/`, the message send/edit routes, or anything that reads a DM's message body.

## What is encrypted

- **Every DM and group DM created since this shipped** (`RoomRecord.e2e`, set in all three DM paths of `create_room`). DMs from before stay plaintext: there is no migration, and a 1:1 DM that already exists is reused as it was.
- **The text of messages, edits and thread replies, plus the quote of the message replied to.** Nothing else. The server still sees who is in a DM, who sent what and when, message sizes, reactions, pins, read markers, thread names, polls, and voice and video (the SFU terminates them).
- **Uploads are not encrypted yet.** An encrypted message's upload links travel beside the ciphertext in `attachments`. The server checks that each is a bare upload link, so the field cannot carry text. The UI says so on the lock icon and in the setup dialog.

## Keys (`e2e/crypto.ts`)

- An **identity** is one random 32-byte seed. HKDF derives an X25519 key (to receive room keys) and an Ed25519 key (to sign) from it. The seed is the only secret, so it is all the backup carries.
- The **backup** is the seed sealed with XChaCha20-Poly1305 under scrypt(passphrase), stored on the server (`e2e_identities`). Its AAD binds it to the account id. The KDF parameters are stored with it (`log_n` 15, `r` 8, `p` 1 today), and the server accepts `log_n` 14–20. The server never sees the passphrase: it is a separate secret from the login password, because the server sees the login password at every sign-in.
- A **room key** is 32 random bytes per **epoch**. It is wrapped to each member with an ephemeral X25519 exchange and XChaCha20-Poly1305 (a sealed box), with room, epoch, recipient and maker in the AAD, and **signed by the member who made it**. The signature is what stops the server inventing a key: it can encrypt to anyone's public key, but it cannot sign as a member. Copies live in `e2e_room_keys`, one per (room, epoch, member).
- A **message** is `{body, reply_to_body?}` as JSON, sealed under the epoch's key with room, epoch and sender in the AAD, and signed by the sender. `content.e2e = {v: 1, epoch, nonce, ct, sig}`.
- The server checks the byte lengths these produce (`is_key` in `routes/e2e.rs`). Change both sides together.

## Epochs

- A room starts at epoch `-1` and owes its first key. After that, **any membership change** (join, `add_to_dm`, leave, kick, ban, account deletion) sets `e2e_rotate` through `e2e::membership_changed` and broadcasts `m.e2e.rotate`. The next epoch keeps a removed member out of what follows and a new member out of what came before. New members get no history: that is by design.
- `POST /api/rooms/{id}/e2e/keys` either **starts** the next epoch or **hands out** the current one:
  - **Starting** requires that one is owed, `epoch` is current + 1, and there is a copy for exactly the members with keys (a missing or extra copy gets `M_E2E_MEMBERS`). It is a compare-and-set on the room, so when several online clients answer one broadcast, one wins and the rest get `M_E2E_EPOCH` and pick up the winner's key.
  - **Handing out** gives copies of the current epoch to members who have keys but no copy: someone who set up encryption after the epoch was made, or reset their keys. An existing copy is never overwritten.
- A send, edit or thread reply into an encrypted room must be sealed under the current epoch, with no rotation owed. Otherwise the server answers 409 `M_E2E_EPOCH`. The client catches up (`recover` → `syncRoomKeys`) and reseals once (`sendMaybeSealed` in `api.ts`).
- **Plaintext into an encrypted room is refused** (`M_E2E_REQUIRED`), and a seal into a plaintext room is too. Older apps (Android until phase 4) therefore cannot send in new DMs, and they show the placeholder for what they receive. Silently storing their plaintext in a conversation everyone believes is private would be worse.

## What the server stores in place of the text

- `content.body` is `e2e::PLACEHOLDER_BODY`, followed by any upload links one per line. Everything that reads bodies — push, automod, link previews, message-link cards, the reply quote, upload referencing and purge — sees that and nothing else, so none of it needed a second code path. The links are what keep the uploads (`media::attachment_folders` reads bodies), and what an older app can still show.
- Push for an encrypted room says `e2e::PUSH_BODY` (Web Push payloads are not end-to-end encrypted to the member's keys).
- Search for text and mentions skips sealed messages (`content.e2e` exists): their body is the placeholder, not their text. File and user search still work, and the client opens the results. Searching encrypted text would have to happen on the client, and is not built.
- Reports from an encrypted DM carry the placeholder. Moderators cannot read encrypted DMs, and message franking is not built.

## The client (`packages/core/src/e2e/session.ts`)

- Status: `setup` (never set up), `locked` (set up elsewhere, or signed out here), `ready` (this device holds the seed), `error`, or `off`. `startE2e` runs once per account on sign-in. A stored seed is used only if it still matches the server's public keys: a reset on another device makes it stale.
- The seed is kept through `host.secretGet/Set/Delete` (localStorage on the web and desktop, inert on mobile for now) and **deleted on sign-out**. Room keys are memory-only and fetched again each session.
- `api.ts` reaches the session through `e2e/hooks.ts`, because the session itself calls the API. Message loads (`apiGetMessages`, `apiGetMessagesAfter`, thread, pins, search) are opened there. Socket events are opened by `createE2eEventGate` in `wsHandler.ts` **before** anything reads them, so notifications, mentions and the timeline see the text. An event that needs a key fetched waits in line, and every event after it waits behind it, so a reaction or deletion never overtakes its message.
- An opened message has `content.e2e_state`: `ok`, `unverified` (it opens, but the signature does not match the sender's current keys — shown as "(unverified)"), `locked`, `missing` (no key for that epoch here, e.g. from before you joined), or `broken`. The last three replace the body with a `E2E_UNREADABLE` line.
- The reply quote is sealed inside the reply, taken from what the sender's client had opened. The server's `reply_to_body` is the parent's placeholder and is never shown.
- Socket events: `m.e2e.rotate` and `m.e2e.identity` (someone in the room can now be handed the key) make an online member's client sync the room after a random wait of up to 1.5 s, so they do not all race. `m.e2e.room_key` (a copy for you) syncs at once. Opening a DM and the first send also sync.

## Not built yet

- Phase 4: Android (keystore, `getRandomValues` polyfill, unlock UI). Until then Android shows encrypted DMs as locked and cannot send in them.
- Phase 5: fingerprint/safety-number verification, and a warning when a member's keys change. Until then a server that swaps a member's public key could read what is sent to them afterwards.
- Phase 6: encrypted uploads and voice messages (conflicts with server-side conversion and thumbnails).
- No forward secrecy within an epoch, and no encrypted history for new members.
