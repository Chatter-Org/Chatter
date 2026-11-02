//! End-to-end encrypted DMs. The design note is `docs/design/e2e-dms.md`.
//!
//! The server is a mailbox here, never a party to the conversation. It stores
//! and relays three things it cannot read:
//!
//! - **Identities.** Each account's public keys (X25519 to receive room keys,
//!   Ed25519 to sign) and a backup of the secret they come from, sealed under a
//!   passphrase the server never sees. A new device unlocks the backup.
//! - **Room keys.** A DM's symmetric key, one per *epoch*, wrapped separately
//!   to each member's public key and signed by the member who made it. A new
//!   epoch is made by a member's client whenever membership changes.
//! - **Messages.** `content.e2e` holds the sealed text; `content.body` is a
//!   fixed placeholder, so everything that reads bodies — push, search,
//!   automod, previews, older apps — sees that and nothing else.
//!
//! What the server can check it does: shapes and sizes, that a message is
//! sealed under the epoch members are on, and that a new epoch reaches every
//! member who has keys. What it cannot check — signatures, that a wrap opens —
//! the clients check.

use super::super::{
    helpers::{
        broadcast_to_room, error_response, extract_token, generate_id, get_user_from_token,
        now_millis, rate_limited, send_to_user,
    },
    ratelimit,
    state::{AppState, RoomRecord, UserRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use base64::Engine;
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

/// What an encrypted message's `body` says, to anything that cannot open it.
/// The wording is for older apps, which render it as the message.
pub(crate) const PLACEHOLDER_BODY: &str = "🔒 Encrypted message — update Chatter to read it";
/// What a push notification says for one.
pub(crate) const PUSH_BODY: &str = "🔒 Encrypted message";

const IDENTITIES: &str = "e2e_identities";
const ROOM_KEYS: &str = "e2e_room_keys";

/// Sealed message text, ~4000 characters of UTF-8 plus its JSON wrapping.
const MAX_CIPHERTEXT_B64: usize = 64 * 1024;
/// Attachments ride beside the ciphertext (uploads are not encrypted yet).
const MAX_ATTACHMENTS: usize = 10;
const MAX_ATTACHMENT_URL: usize = 2048;
const MAX_KEY_QUERY: usize = 100;
/// The passphrase KDF's cost is the client's to choose, within reason: high
/// enough to be worth something, low enough that a phone can unlock.
const SCRYPT_MIN_LOG_N: u32 = 14;
const SCRYPT_MAX_LOG_N: u32 = 20;

// ─── Records ────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct IdentityBackup {
    /// Only `scrypt` so far; the field is there so it can change.
    pub(crate) kdf: String,
    pub(crate) log_n: u32,
    pub(crate) r: u32,
    pub(crate) p: u32,
    pub(crate) salt: String,
    pub(crate) nonce: String,
    pub(crate) ct: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct IdentityRecord {
    #[serde(rename = "_id")]
    pub(crate) user_id: String,
    pub(crate) enc_pub: String,
    pub(crate) sign_pub: String,
    pub(crate) backup: IdentityBackup,
    pub(crate) updated_at: i64,
}

/// One member's copy of one epoch's room key.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct RoomKeyRecord {
    /// `room|epoch|user`, so a member holds at most one copy of an epoch.
    #[serde(rename = "_id")]
    pub(crate) id: String,
    pub(crate) room_id: String,
    pub(crate) epoch: i64,
    pub(crate) user_id: String,
    /// The member whose client made this copy, and signed it.
    pub(crate) sender: String,
    pub(crate) eph: String,
    pub(crate) nonce: String,
    pub(crate) ct: String,
    pub(crate) sig: String,
    pub(crate) created_at: i64,
}

/// `content.e2e` on a message.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct SealedContent {
    pub(crate) v: u32,
    pub(crate) epoch: i64,
    pub(crate) nonce: String,
    pub(crate) ct: String,
    pub(crate) sig: String,
}

// ─── Checks shared with the message routes ──────────────────────────────────

fn refusal(status: StatusCode, errcode: &str, detail: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "errcode": errcode, "error": detail })))
}

fn b64_bytes(value: &str, max_b64: usize) -> Option<Vec<u8>> {
    if value.len() > max_b64 {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

fn is_key(value: &str, len: usize) -> bool {
    b64_bytes(value, 128).is_some_and(|b| b.len() == len)
}

/// The epoch a send has to be sealed under, or the refusal that tells the
/// client to fetch or make a new one.
fn epoch_refusal(room: &RoomRecord) -> (StatusCode, Json<Value>) {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "errcode": "M_E2E_EPOCH",
            "error": "This conversation's key has changed",
            "epoch": room.e2e_epoch,
            "rotate": room.e2e_rotate || room.e2e_epoch < 0,
        })),
    )
}

/// What a send or an edit stores in place of the text it was given.
pub(crate) struct Surface {
    /// The placeholder, then any attachment links one per line: the links are
    /// what keeps the uploads (`media::attachment_folders` reads bodies), and
    /// what an older app can still show.
    pub(crate) body: String,
    pub(crate) sealed: SealedContent,
}

/// Judge a send or edit against the room's encryption.
///
/// `Ok(None)` is a plaintext room and a plaintext message, which carry on as
/// they always have. An encrypted room takes only sealed messages: a plaintext
/// one from an app that predates encryption would otherwise land in the clear
/// in a conversation everyone believes is private.
pub(crate) fn check_send(
    room: &RoomRecord,
    sealed: Option<&SealedContent>,
    attachments: Option<&[String]>,
) -> Result<Option<Surface>, (StatusCode, Json<Value>)> {
    let Some(sealed) = sealed else {
        if room.e2e {
            return Err(refusal(
                StatusCode::BAD_REQUEST,
                "M_E2E_REQUIRED",
                "This conversation is end-to-end encrypted. Update Chatter to send messages here.",
            ));
        }
        return Ok(None);
    };
    if !room.e2e {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "M_E2E_NOT_ENCRYPTED",
            "This conversation is not end-to-end encrypted",
        ));
    }
    let well_formed = sealed.v == 1
        && is_key(&sealed.nonce, 24)
        && is_key(&sealed.sig, 64)
        && b64_bytes(&sealed.ct, MAX_CIPHERTEXT_B64).is_some_and(|b| b.len() > 16);
    if !well_formed {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "M_E2E_BAD",
            "Malformed encrypted message",
        ));
    }
    if room.e2e_epoch < 0 || room.e2e_rotate || sealed.epoch != room.e2e_epoch {
        return Err(epoch_refusal(room));
    }

    let attachments = attachments.unwrap_or_default();
    // Each must be exactly one upload link and nothing else: this field is in
    // the clear, so it must not be a way to post text beside the ciphertext.
    let all_uploads = attachments.len() <= MAX_ATTACHMENTS
        && attachments.iter().all(|url| {
            url.len() <= MAX_ATTACHMENT_URL
                && !url.chars().any(char::is_whitespace)
                && super::media::attachment_folders(url).len() == 1
        });
    if !all_uploads {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "M_E2E_BAD",
            "Attachments must be links to uploads",
        ));
    }
    let mut body = PLACEHOLDER_BODY.to_string();
    for url in attachments {
        body.push('\n');
        body.push_str(url);
    }
    Ok(Some(Surface {
        body,
        sealed: sealed.clone(),
    }))
}

/// Membership of an encrypted room changed: the next message waits on a new
/// key. Told to the room so whichever member's client is online makes one.
pub(crate) async fn membership_changed(state: &AppState, room_id: &str) {
    let rooms = state.db.collection::<RoomRecord>("rooms");
    let changed = rooms
        .update_one(
            doc! { "_id": room_id, "e2e": true, "e2e_epoch": { "$gte": 0 } },
            doc! { "$set": { "e2e_rotate": true } },
        )
        .await
        .map(|r| r.matched_count > 0)
        .unwrap_or(false);
    if changed {
        broadcast_to_room(
            state,
            room_id,
            &json!({ "type": "m.e2e.rotate", "room_id": room_id }),
        )
        .await;
    }
}

/// The account is going away: its keys go with it.
pub(crate) async fn forget_user(state: &AppState, user_id: &str) {
    let _ = state
        .db
        .collection::<IdentityRecord>(IDENTITIES)
        .delete_one(doc! { "_id": user_id })
        .await;
    let _ = state
        .db
        .collection::<RoomKeyRecord>(ROOM_KEYS)
        .delete_many(doc! { "user_id": user_id })
        .await;
}

/// The room is going away: so do the keys to it.
pub(crate) async fn forget_room(state: &AppState, room_id: &str) {
    let _ = state
        .db
        .collection::<RoomKeyRecord>(ROOM_KEYS)
        .delete_many(doc! { "room_id": room_id })
        .await;
}

// ─── Identity ───────────────────────────────────────────────────────────────

fn caller(state: &AppState, headers: &HeaderMap) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))
}

/// The caller, held to `quota` for this kind of key request.
async fn limited_caller(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    kind: &str,
    quota: ratelimit::Quota,
) -> Result<String, (StatusCode, Json<Value>)> {
    let user_id = caller(state, headers)?;
    ratelimit::check(state, &format!("e2e-{kind}:{user_id}"), quota)
        .await
        .map_err(|retry_after| rate_limited(retry_after, "Too many encryption requests"))?;
    Ok(user_id)
}

fn identity_json(record: &IdentityRecord) -> Value {
    json!({ "enc_pub": record.enc_pub, "sign_pub": record.sign_pub })
}

#[derive(Deserialize)]
pub(crate) struct PutIdentityRequest {
    pub(crate) enc_pub: String,
    pub(crate) sign_pub: String,
    pub(crate) backup: IdentityBackup,
    /// Replace an identity that already exists: the passphrase was lost, or
    /// it is being changed. Required, so two devices setting up at once
    /// cannot silently overwrite each other.
    #[serde(default)]
    pub(crate) replace: bool,
    /// A current TOTP code or a recovery code. Keys decide who can read the
    /// account's conversations, so a session token alone — stolen, or left
    /// signed in somewhere — must not be enough to change them.
    #[serde(default)]
    pub(crate) totp_code: String,
}

/// GET /api/e2e/identity — the caller's own identity and backup, or null.
pub(crate) async fn get_identity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = caller(&state, &headers)?;
    let record = state
        .db
        .collection::<IdentityRecord>(IDENTITIES)
        .find_one(doc! { "_id": &user_id })
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not load keys"))?;
    Ok(Json(json!({ "identity": record })))
}

/// PUT /api/e2e/identity — publish the caller's keys and backup.
///
/// A replacement keeps nothing of the old identity: every room key wrapped to
/// it is deleted, and the caller's rooms are told so a member re-wraps the
/// current key to the new one. History under older keys is lost to them —
/// that is what losing the passphrase costs.
pub(crate) async fn put_identity(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<PutIdentityRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = limited_caller(&state, &headers, "identity", ratelimit::E2E_IDENTITY).await?;
    let b = &req.backup;
    let valid = is_key(&req.enc_pub, 32)
        && is_key(&req.sign_pub, 32)
        && b.kdf == "scrypt"
        && (SCRYPT_MIN_LOG_N..=SCRYPT_MAX_LOG_N).contains(&b.log_n)
        && (1..=16).contains(&b.r)
        && (1..=4).contains(&b.p)
        && b64_bytes(&b.salt, 128).is_some_and(|s| (16..=64).contains(&s.len()))
        && is_key(&b.nonce, 24)
        // The 32-byte secret and its tag.
        && is_key(&b.ct, 48);
    if !valid {
        return Err(error_response(StatusCode::BAD_REQUEST, "Malformed keys"));
    }

    let user = state
        .db
        .collection::<UserRecord>("users")
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;
    let username = user_id
        .split(':')
        .next()
        .unwrap_or(&user_id)
        .trim_start_matches('@');
    super::auth::verify_totp_or_recovery(req.totp_code.trim(), &user, username, &state).await?;

    let coll = state.db.collection::<IdentityRecord>(IDENTITIES);
    let record = IdentityRecord {
        user_id: user_id.clone(),
        enc_pub: req.enc_pub,
        sign_pub: req.sign_pub,
        backup: req.backup,
        updated_at: now_millis(),
    };
    if req.replace {
        coll.replace_one(doc! { "_id": &user_id }, &record)
            .upsert(true)
            .await
            .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save"))?;
        let _ = state
            .db
            .collection::<RoomKeyRecord>(ROOM_KEYS)
            .delete_many(doc! { "user_id": &user_id })
            .await;
    } else if coll.insert_one(&record).await.is_err() {
        return Err(refusal(
            StatusCode::CONFLICT,
            "M_E2E_EXISTS",
            "Encryption is already set up for this account",
        ));
    }

    // Every encrypted room the caller is in has a member who can now be
    // handed the current key. A replacement is also said in the conversation
    // itself, where everyone sees it: new keys are exactly what someone
    // impersonating the account would bring.
    let event = json!({ "type": "m.e2e.identity", "user_id": user_id, "replaced": req.replace });
    let display = username.to_string();
    for room_id in encrypted_rooms_of(&state, &user_id).await {
        let mut event = event.clone();
        event["room_id"] = json!(room_id);
        broadcast_to_room(&state, &room_id, &event).await;
        if req.replace {
            let notice = json!({
                "type": "m.room.message",
                "room_id": room_id,
                "sender": user_id,
                "content": {
                    "msgtype": "m.system",
                    "body": format!("{display} reset their encryption keys"),
                },
                "event_id": generate_id("$"),
                "origin_server_ts": now_millis(),
            });
            if let Ok(doc) = mongodb::bson::to_document(&notice) {
                let _ = state
                    .db
                    .collection::<mongodb::bson::Document>("messages")
                    .insert_one(doc)
                    .await;
            }
            broadcast_to_room(&state, &room_id, &notice).await;
        }
    }
    Ok(Json(json!({ "ok": true })))
}

/// Whether this room is end-to-end encrypted.
pub(crate) async fn is_encrypted(state: &AppState, room_id: &str) -> bool {
    state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id, "e2e": true })
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Drop any drafts this account has in encrypted rooms. Drafts are refused
/// there now; these are ones saved before that.
pub(crate) async fn purge_encrypted_drafts(state: &AppState, user_id: &str) {
    let rooms = encrypted_rooms_of(state, user_id).await;
    if rooms.is_empty() {
        return;
    }
    let _ = state
        .db
        .collection::<mongodb::bson::Document>("drafts")
        .delete_many(doc! { "user_id": user_id, "room_id": { "$in": &rooms } })
        .await;
}

async fn encrypted_rooms_of(state: &AppState, user_id: &str) -> Vec<String> {
    let room_ids: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.iter()
            .filter(|(_, members)| members.iter().any(|m| m == user_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    };
    if room_ids.is_empty() {
        return vec![];
    }
    let mut out = vec![];
    if let Ok(mut cursor) = state
        .db
        .collection::<RoomRecord>("rooms")
        .find(doc! { "_id": { "$in": &room_ids }, "e2e": true })
        .await
    {
        while let Ok(Some(room)) = cursor.try_next().await {
            out.push(room.room_id);
        }
    }
    out
}

#[derive(Deserialize)]
pub(crate) struct KeyQueryRequest {
    pub(crate) user_ids: Vec<String>,
}

/// POST /api/e2e/keys/query — public keys for these accounts. Ones with none
/// are left out. Public keys are public; any signed-in account may ask.
pub(crate) async fn query_keys(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<KeyQueryRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    limited_caller(&state, &headers, "keys", ratelimit::E2E_KEYS).await?;
    if req.user_ids.len() > MAX_KEY_QUERY {
        return Err(error_response(StatusCode::BAD_REQUEST, "Too many users"));
    }
    let mut keys = serde_json::Map::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<IdentityRecord>(IDENTITIES)
        .find(doc! { "_id": { "$in": &req.user_ids } })
        .await
    {
        while let Ok(Some(record)) = cursor.try_next().await {
            keys.insert(record.user_id.clone(), identity_json(&record));
        }
    }
    Ok(Json(json!({ "keys": keys })))
}

// ─── Room keys ──────────────────────────────────────────────────────────────

async fn encrypted_room_for_member(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Result<(RoomRecord, Vec<String>), (StatusCode, Json<Value>)> {
    let members: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.get(room_id).cloned().unwrap_or_default()
    };
    if !members.iter().any(|m| m == user_id) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;
    Ok((room, members))
}

/// Which of these accounts have published keys.
async fn with_identity(state: &AppState, user_ids: &[String]) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<IdentityRecord>(IDENTITIES)
        .find(doc! { "_id": { "$in": user_ids } })
        .await
    {
        while let Ok(Some(record)) = cursor.try_next().await {
            out.insert(record.user_id);
        }
    }
    out
}

/// GET /api/rooms/{room_id}/e2e
///
/// Everything a member's client needs to read and write here: the current
/// epoch, whether a new one is owed, the caller's copies of every epoch's key,
/// and which members are owed a copy of the current one.
pub(crate) async fn get_room_e2e(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = caller(&state, &headers)?;
    let (room, members) = encrypted_room_for_member(&state, &room_id, &user_id).await?;
    if !room.e2e {
        return Ok(Json(json!({ "e2e": false })));
    }

    let coll = state.db.collection::<RoomKeyRecord>(ROOM_KEYS);
    let mut keys = vec![];
    if let Ok(mut cursor) = coll
        .find(doc! { "room_id": &room_id, "user_id": &user_id })
        .await
    {
        while let Ok(Some(k)) = cursor.try_next().await {
            keys.push(json!({
                "epoch": k.epoch,
                "sender": k.sender,
                "eph": k.eph,
                "nonce": k.nonce,
                "ct": k.ct,
                "sig": k.sig,
            }));
        }
    }

    let mut holders = HashSet::new();
    if room.e2e_epoch >= 0 {
        if let Ok(mut cursor) = coll
            .find(doc! { "room_id": &room_id, "epoch": room.e2e_epoch })
            .await
        {
            while let Ok(Some(k)) = cursor.try_next().await {
                holders.insert(k.user_id);
            }
        }
    }
    let ready = with_identity(&state, &members).await;
    let member_rows: Vec<Value> = members
        .iter()
        .map(|m| {
            json!({
                "user_id": m,
                "has_identity": ready.contains(m),
                "has_key": holders.contains(m),
            })
        })
        .collect();

    Ok(Json(json!({
        "e2e": true,
        "epoch": room.e2e_epoch,
        "rotate": room.e2e_rotate || room.e2e_epoch < 0,
        "keys": keys,
        "members": member_rows,
    })))
}

#[derive(Deserialize)]
pub(crate) struct WrappedKey {
    pub(crate) user_id: String,
    pub(crate) eph: String,
    pub(crate) nonce: String,
    pub(crate) ct: String,
    pub(crate) sig: String,
}

#[derive(Deserialize)]
pub(crate) struct PostRoomKeysRequest {
    pub(crate) epoch: i64,
    pub(crate) keys: Vec<WrappedKey>,
}

/// POST /api/rooms/{room_id}/e2e/keys
///
/// Either starts the next epoch — `epoch` is one past the current one, a new
/// one is owed, and there is a copy for every member with keys — or hands
/// copies of the current epoch to members who have none yet. Anything else is
/// a client working from a stale view, told the epoch to catch up to.
///
/// Starting an epoch is a compare-and-set on the room, so when two members'
/// clients both answer a membership change, one wins and the other picks up
/// the winner's key.
pub(crate) async fn post_room_keys(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<PostRoomKeysRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = limited_caller(&state, &headers, "keys", ratelimit::E2E_KEYS).await?;
    let (room, members) = encrypted_room_for_member(&state, &room_id, &user_id).await?;
    if !room.e2e {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            "M_E2E_NOT_ENCRYPTED",
            "This conversation is not end-to-end encrypted",
        ));
    }
    let ready = with_identity(&state, &members).await;
    if !ready.contains(&user_id) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Set up encryption before sharing keys",
        ));
    }
    let well_formed = req.keys.iter().all(|k| {
        is_key(&k.eph, 32) && is_key(&k.nonce, 24) && is_key(&k.ct, 48) && is_key(&k.sig, 64)
    });
    let recipients: HashSet<&String> = req.keys.iter().map(|k| &k.user_id).collect();
    if !well_formed || recipients.len() != req.keys.len() {
        return Err(error_response(StatusCode::BAD_REQUEST, "Malformed keys"));
    }

    let rotate_owed = room.e2e_rotate || room.e2e_epoch < 0;
    let coll = state.db.collection::<RoomKeyRecord>(ROOM_KEYS);
    let starting = rotate_owed && req.epoch == room.e2e_epoch + 1;
    let filling = req.epoch == room.e2e_epoch && req.epoch >= 0;

    if starting {
        // Exactly the members who can hold a key: one left out would be shut
        // out of the conversation, and a copy for someone not in it would
        // hand them every message that follows.
        let owed: HashSet<&String> = ready.iter().collect();
        if recipients != owed {
            return Err(refusal(
                StatusCode::CONFLICT,
                "M_E2E_MEMBERS",
                "The conversation's members have changed",
            ));
        }
        let won = state
            .db
            .collection::<RoomRecord>("rooms")
            .update_one(
                doc! { "_id": &room_id, "e2e_epoch": room.e2e_epoch, "e2e_rotate": room.e2e_rotate },
                doc! { "$set": { "e2e_epoch": req.epoch, "e2e_rotate": false } },
            )
            .await
            .map(|r| r.modified_count > 0)
            .unwrap_or(false);
        if !won {
            let fresh = state
                .db
                .collection::<RoomRecord>("rooms")
                .find_one(doc! { "_id": &room_id })
                .await
                .ok()
                .flatten()
                .unwrap_or(room);
            return Err(epoch_refusal(&fresh));
        }
    } else if !filling {
        return Err(epoch_refusal(&room));
    } else if recipients.iter().any(|r| !ready.contains(*r)) {
        return Err(refusal(
            StatusCode::CONFLICT,
            "M_E2E_MEMBERS",
            "The conversation's members have changed",
        ));
    }

    let ts = now_millis();
    let mut delivered = vec![];
    for k in req.keys {
        let record = RoomKeyRecord {
            id: format!("{}|{}|{}", room_id, req.epoch, k.user_id),
            room_id: room_id.clone(),
            epoch: req.epoch,
            user_id: k.user_id.clone(),
            sender: user_id.clone(),
            eph: k.eph,
            nonce: k.nonce,
            ct: k.ct,
            sig: k.sig,
            created_at: ts,
        };
        // A copy that is already there stays: the first one made is the one
        // its holder may already have read messages with.
        if coll.insert_one(&record).await.is_ok() {
            delivered.push(k.user_id);
        }
    }

    let event = json!({ "type": "m.e2e.room_key", "room_id": room_id, "epoch": req.epoch });
    if starting {
        broadcast_to_room(&state, &room_id, &event).await;
    } else {
        for recipient in &delivered {
            send_to_user(&state, recipient, &event).await;
        }
    }
    Ok(Json(json!({ "epoch": req.epoch, "delivered": delivered })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(e2e: bool, epoch: i64, rotate: bool) -> RoomRecord {
        let mut value = json!({
            "_id": "!r", "name": "", "topic": "", "creator": "@a:x", "is_dm": true,
            "tags": [], "icon_url": "", "custom_emojis": [],
        });
        value["e2e"] = json!(e2e);
        value["e2e_epoch"] = json!(epoch);
        value["e2e_rotate"] = json!(rotate);
        serde_json::from_value(value).unwrap()
    }

    fn b64(n: usize) -> String {
        base64::engine::general_purpose::STANDARD.encode(vec![7u8; n])
    }

    fn sealed(epoch: i64) -> SealedContent {
        SealedContent {
            v: 1,
            epoch,
            nonce: b64(24),
            ct: b64(40),
            sig: b64(64),
        }
    }

    const UPLOAD: &str = "https://chat.example/external/0123456789abcdef0123456789abcdef/cat.png";

    #[test]
    fn plaintext_rooms_take_plaintext_and_refuse_ciphertext() {
        let plain = room(false, -1, false);
        assert!(check_send(&plain, None, None).unwrap().is_none());
        let err = check_send(&plain, Some(&sealed(0)), None).err().unwrap();
        assert_eq!(err.1 .0["errcode"], "M_E2E_NOT_ENCRYPTED");
    }

    #[test]
    fn encrypted_rooms_refuse_plaintext() {
        let err = check_send(&room(true, 0, false), None, None).err().unwrap();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1 .0["errcode"], "M_E2E_REQUIRED");
    }

    #[test]
    fn a_send_waits_on_the_current_epoch() {
        for (r, epoch) in [
            (room(true, -1, false), 0),
            (room(true, 2, true), 2),
            (room(true, 2, false), 1),
        ] {
            let err = check_send(&r, Some(&sealed(epoch)), None).err().unwrap();
            assert_eq!(err.0, StatusCode::CONFLICT);
            assert_eq!(err.1 .0["errcode"], "M_E2E_EPOCH");
        }
        let surface = check_send(&room(true, 2, false), Some(&sealed(2)), None)
            .unwrap()
            .unwrap();
        assert_eq!(surface.body, PLACEHOLDER_BODY);
    }

    #[test]
    fn attachments_must_be_bare_upload_links() {
        let r = room(true, 0, false);
        let surface = check_send(&r, Some(&sealed(0)), Some(&[UPLOAD.to_string()]))
            .unwrap()
            .unwrap();
        assert_eq!(surface.body, format!("{PLACEHOLDER_BODY}\n{UPLOAD}"));
        for smuggled in [
            "secret words".to_string(),
            format!("{UPLOAD} secret"),
            "https://elsewhere.example/cat.png".to_string(),
        ] {
            assert!(check_send(&r, Some(&sealed(0)), Some(&[smuggled])).is_err());
        }
    }

    #[test]
    fn malformed_ciphertext_is_refused() {
        let r = room(true, 0, false);
        let mut bad = sealed(0);
        bad.nonce = b64(12);
        assert!(check_send(&r, Some(&bad), None).is_err());
        let mut bad = sealed(0);
        bad.v = 2;
        assert!(check_send(&r, Some(&bad), None).is_err());
    }
}
