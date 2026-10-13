//! Per-user read markers and the unread counts derived from them.
//!
//! Unread state used to live only in the client reducer, so a refresh wiped it
//! and every channel read as caught up. A marker records the timestamp a user
//! last read a channel; unread counts are whatever arrived after it.

use super::super::{
    helpers::{
        error_response, extract_token, get_allowed_channel_ids, get_user_from_token, mention_token,
        now_millis, regex_escape,
    },
    push::role_names_by_user,
    state::{AppState, ChannelRecord, RoomRecord, ThreadRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Deserialize)]
pub(crate) struct MarkReadRequest {
    /// Empty or absent for rooms whose messages carry no channel_id (DMs).
    pub(crate) channel_id: Option<String>,
    /// Set instead of `channel_id` to mark one thread read rather than the
    /// channel it hangs in. A thread's replies are not in the channel's
    /// timeline, so scrolling the channel to its bottom says nothing about
    /// having read them — and a mention in a thread would stay dismissed.
    pub(crate) thread_id: Option<String>,
    /// Marker position; defaults to now. Clamped so a marker never moves backwards.
    pub(crate) ts: Option<i64>,
}

/// A marker's key: the channel it covers, or the thread it covers when one is
/// named. One collection holds both because both answer the same question —
/// whatever carries this key and arrived after this timestamp is still unseen.
fn marker_id(user_id: &str, scope: &str) -> String {
    format!("{user_id}|{scope}")
}

/// Record that `user_id` has read `channel_id` up to a point in time.
///
/// Markers only ever move forward: reading an older channel view must not
/// resurrect messages the user already dismissed elsewhere.
pub(crate) async fn mark_read(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<MarkReadRequest>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    {
        let rm = state.room_members.read().await;
        if !rm
            .get(&room_id)
            .map(|m| m.contains(&user_id))
            .unwrap_or(false)
        {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "Not a member of this room",
            ));
        }
    }

    let thread_id = req.thread_id.unwrap_or_default();
    let channel_id = if thread_id.is_empty() {
        req.channel_id.unwrap_or_default()
    } else {
        String::new()
    };
    let ts = req.ts.unwrap_or_else(now_millis);
    let id = if thread_id.is_empty() {
        marker_id(&user_id, &channel_id)
    } else {
        marker_id(&user_id, &thread_id)
    };

    let coll = state.db.collection::<Document>("read_markers");
    let existing = coll
        .find_one(doc! { "_id": &id })
        .await
        .ok()
        .flatten()
        .and_then(|d| d.get_i64("last_read_ts").ok())
        .unwrap_or(0);
    if ts <= existing {
        return Ok(Json(json!({ "last_read_ts": existing })));
    }

    let mut sets = doc! {
        "user_id": &user_id,
        "room_id": &room_id,
        "last_read_ts": ts,
    };
    // Which kind of marker this is has to be stated rather than implied by the
    // key: the unread scan reads every marker a user owns in one pass and
    // cannot tell a thread id from a channel id by looking at it.
    if thread_id.is_empty() {
        sets.insert("channel_id", &channel_id);
    } else {
        sets.insert("thread_id", &thread_id);
    }

    let _ = coll
        .update_one(doc! { "_id": &id }, doc! { "$set": sets })
        .upsert(true)
        .await;

    Ok(Json(json!({ "last_read_ts": ts })))
}

/// Whether a message is a mention of the reader, as an aggregation expression.
/// The same judgement the live client makes (`wsHandler.ts`, the
/// `m.room.message` branch) — change both together, or a refresh moves a ping
/// somewhere else or drops it: named directly, named through a role they hold
/// (unless the sender could not ping roles), answered by a reply, or in a DM.
fn mention_expr(mention: &str, user_id: &str, roles: &[String], is_dm: bool) -> Bson {
    if is_dm {
        return Bson::Boolean(true);
    }
    let body = doc! { "$ifNull": ["$content.body", ""] };
    let mut any = vec![
        Bson::Document(doc! { "$regexMatch": {
            "input": body.clone(),
            "regex": regex_escape(mention),
        }}),
        Bson::Document(doc! { "$eq": ["$content.reply_to_sender", user_id] }),
    ];
    // The client reads `@word` tokens and compares them to role names, so
    // only a role name that is a word can ever be matched.
    let names: Vec<String> = roles
        .iter()
        .filter(|r| !r.is_empty() && r.chars().all(|c| c.is_alphanumeric() || c == '_'))
        .map(|r| regex_escape(r))
        .collect();
    if !names.is_empty() {
        any.push(Bson::Document(doc! { "$and": [
            { "$ne": ["$content.suppress_role_mentions", true] },
            { "$regexMatch": {
                "input": body,
                "regex": format!("@(?:{})(?![\\p{{L}}\\p{{N}}_])", names.join("|")),
                "options": "i",
            }},
        ]}));
    }
    Bson::Document(doc! { "$or": any })
}

/// Unread and mention counts for every room the caller has joined.
///
/// One aggregation per visible channel; both counts come back together so a
/// mention scan costs no extra round trip. `thread_mentions` answers alongside
/// them, keyed by thread rather than channel, because a thread's unread is not
/// its channel's unread.
pub(crate) async fn get_unreads(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let joined_rooms: Vec<String> = {
        let rm = state.room_members.read().await;
        rm.iter()
            .filter(|(_, members)| members.contains(&user_id))
            .map(|(room_id, _)| room_id.clone())
            .collect()
    };

    // Markers for this user. A thread's marker is kept apart from its channel's
    // because the two answer different questions: reading a channel never put a
    // thread's replies on screen, so it must not dismiss what was said in one.
    let markers_coll = state.db.collection::<Document>("read_markers");
    let mut markers: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut thread_markers: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    if let Ok(mut cursor) = markers_coll.find(doc! { "user_id": &user_id }).await {
        while let Ok(Some(d)) = cursor.try_next().await {
            let last_read_ts = d.get_i64("last_read_ts").unwrap_or(0);
            if let Some(thread_id) = d.get_str("thread_id").ok().map(String::from) {
                thread_markers.insert(thread_id, last_read_ts);
            } else {
                let channel_id = d.get_str("channel_id").unwrap_or("").to_string();
                markers.insert(channel_id, last_read_ts);
            }
        }
    }

    let channels_coll = state.db.collection::<ChannelRecord>("channels");
    let threads_coll = state.db.collection::<ThreadRecord>("threads");
    let messages_coll = state.db.collection::<Document>("messages");
    let mention = mention_token(&user_id);

    // Every message in a DM is addressed to the reader, so in a DM every
    // unread is a mention — what the live client and push both already say.
    // Counting only `@name` here turned a DM's red badge into a plain unread
    // the moment the page was refreshed.
    let mut dm_rooms: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<RoomRecord>("rooms")
        .find(doc! { "_id": { "$in": &joined_rooms }, "is_dm": true })
        .await
    {
        while let Ok(Some(room)) = cursor.try_next().await {
            dm_rooms.insert(room.room_id);
        }
    }

    let mut unreads: Vec<Value> = Vec::new();
    let mut thread_mentions: Vec<Value> = Vec::new();
    for room_id in &joined_rooms {
        let allowed = get_allowed_channel_ids(&state, room_id, &user_id).await;
        let is_dm = dm_rooms.contains(room_id);
        let roles = role_names_by_user(&state, room_id, std::slice::from_ref(&user_id))
            .await
            .remove(&user_id)
            .unwrap_or_default();
        let is_mention = mention_expr(&mention, &user_id, &roles, is_dm);

        // Channel ids to tally. A room with no channels carries its messages
        // with an empty channel_id, so "" is its one bucket. A room that has
        // channels does not get that bucket: no view of it shows a message
        // without a channel, so one counted there (from before channels, or
        // a webhook with none) could never be read and lit the room forever.
        let mut channel_ids: Vec<String> = Vec::new();
        let mut has_text_channels = false;
        if let Ok(mut cursor) = channels_coll.find(doc! { "room_id": room_id }).await {
            while let Ok(Some(ch)) = cursor.try_next().await {
                if ch.channel_type != "text" {
                    continue;
                }
                has_text_channels = true;
                if let Some(ref allowed) = allowed {
                    if !allowed.contains(&ch.channel_id) {
                        continue;
                    }
                }
                channel_ids.push(ch.channel_id);
            }
        }
        if !has_text_channels {
            channel_ids.push(String::new());
        }

        for channel_id in channel_ids {
            let since = markers.get(&channel_id).copied().unwrap_or(0);
            let mut match_doc = doc! {
                "room_id": room_id,
                "type": "m.room.message",
                "origin_server_ts": { "$gt": since },
                "sender": { "$ne": &user_id },
                "content.msgtype": { "$ne": "m.system" },
                // A deleted message keeps its row, and was counted.
                "redacted": { "$ne": true },
                // Thread replies are stored with no channel_id, so without
                // this every one of them counted toward the channel-less
                // bucket of whatever room it was in. A thread is unread on its
                // own terms; see the threads listing.
                "thread_id": { "$exists": false },
            };
            if channel_id.is_empty() {
                match_doc.insert("channel_id", doc! { "$exists": false });
            } else {
                match_doc.insert("channel_id", &channel_id);
            }

            let pipeline = vec![
                doc! { "$match": match_doc },
                doc! { "$group": {
                    "_id": Value::Null.to_string(),
                    "count": { "$sum": 1 },
                    "mentions": { "$sum": { "$cond": [is_mention.clone(), 1, 0] } },
                    // Newest unread message in this channel, so a client can
                    // answer "which channel saw the most recent unread" and
                    // land on it rather than only counting how many.
                    "latest_ts": { "$max": "$origin_server_ts" },
                }},
            ];

            let Ok(mut cursor) = messages_coll.aggregate(pipeline).await else {
                continue;
            };
            if let Ok(Some(row)) = cursor.try_next().await {
                let count = row.get_i32("count").unwrap_or(0);
                let mentions = row.get_i32("mentions").unwrap_or(0);
                if count > 0 {
                    unreads.push(json!({
                        "room_id": room_id,
                        "channel_id": channel_id,
                        "count": count,
                        "mentions": mentions,
                        "latest_ts": row.get_i64("latest_ts").unwrap_or(0),
                    }));
                }
            }
        }

        // Unread mentions inside threads, which the channel tally above
        // deliberately leaves out. A reply carries no channel_id, so the thread
        // record is what says a thread has something new in it — and it is
        // measured against the thread's own marker, since reading a channel
        // never showed anyone a reply. Threads are grouped by the marker they
        // share so the scan is one aggregation per distinct marker rather than
        // one per thread.
        let mut by_since: std::collections::HashMap<i64, Vec<String>> =
            std::collections::HashMap::new();
        if let Ok(mut cursor) = threads_coll.find(doc! { "room_id": room_id }).await {
            while let Ok(Some(record)) = cursor.try_next().await {
                // A thread is exactly as private as the channel it hangs in, so
                // a hidden one has no row to wear a badge.
                if let Some(ref allowed) = allowed {
                    if !record.channel_id.is_empty() && !allowed.contains(&record.channel_id) {
                        continue;
                    }
                }
                let since = thread_markers.get(&record.thread_id).copied().unwrap_or(0);
                // Nothing has landed since this thread was last read.
                if record.last_activity_ts <= since {
                    continue;
                }
                by_since.entry(since).or_default().push(record.thread_id);
            }
        }

        for (since, thread_ids) in &by_since {
            let pipeline = vec![
                doc! { "$match": doc! {
                    "room_id": room_id,
                    "type": "m.room.message",
                    "thread_id": { "$in": &thread_ids },
                    "origin_server_ts": { "$gt": since },
                    "sender": { "$ne": &user_id },
                    "content.msgtype": { "$ne": "m.system" },
                    "redacted": { "$ne": true },
                }},
                doc! { "$group": {
                    "_id": "$thread_id",
                    "mentions": { "$sum": {
                        "$cond": [
                            { "$regexMatch": {
                                "input": { "$ifNull": ["$content.body", ""] },
                                "regex": regex_escape(&mention),
                            }},
                            1,
                            0,
                        ]
                    }},
                }},
            ];

            let Ok(mut cursor) = messages_coll.aggregate(pipeline).await else {
                continue;
            };
            while let Ok(Some(row)) = cursor.try_next().await {
                let mentions = row.get_i32("mentions").unwrap_or(0);
                if mentions == 0 {
                    continue;
                }
                let thread_id = row.get_str("_id").unwrap_or("").to_string();
                thread_mentions.push(json!({
                    "thread_id": thread_id,
                    "mentions": mentions,
                }));
            }
        }
    }

    Ok(Json(
        json!({ "unreads": unreads, "thread_mentions": thread_mentions }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_id_is_scoped_per_user_and_channel() {
        assert_eq!(marker_id("@a:h", "#c"), "@a:h|#c");
        assert_ne!(marker_id("@a:h", "#c"), marker_id("@b:h", "#c"));
    }

    #[test]
    fn a_thread_marker_never_shadows_a_channels() {
        // Both kinds live in one collection and are read in a single pass, so a
        // thread id must be incapable of naming a channel. Thread ids are minted
        // with a leading `$`, channel ids with `!`, `#` or `@`.
        assert_ne!(
            marker_id("@a:h", "$event"),
            marker_id("@a:h", "!channel:localhost")
        );
        assert_ne!(
            marker_id("@a:h", "$event"),
            marker_id("@a:h", "#channel:localhost")
        );
    }
}
