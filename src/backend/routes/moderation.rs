//! Moderation routes: timeouts, the room's moderation settings, accepting its
//! rules, reports, and bulk deletion. What they enforce lives in `backend/moderation.rs`; this file is
//! how owners and moderators apply it.

use super::super::{
    audit,
    dto::{
        BulkDeleteRequest, CreateReportRequest, ReportsQuery, ResolveReportRequest,
        TimeoutMemberRequest, UpdateModerationRequest,
    },
    helpers::{
        broadcast_to_room, channel_permissions, effective_permissions, error_response,
        extract_token, generate_id, get_user_from_token, get_user_role, now_millis, rate_limited,
        send_to_user,
    },
    moderation::{public_view, MAX_TIMEOUT_SECS},
    ratelimit,
    state::{
        AppState, AutomodSettings, CustomRoleRecord, MemberCustomRoleRecord, MemberTimeoutRecord,
        ReportRecord, RolePermissions, RoomMemberRecord, RoomRecord,
    },
    ws::voice_webrtc::teardown_voice_publisher,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

type ApiError = (StatusCode, Json<Value>);

fn caller(state: &AppState, headers: &HeaderMap) -> Result<String, ApiError> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))
}

async fn is_member(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let rm = state.room_members.read().await;
    rm.get(room_id)
        .is_some_and(|m| m.iter().any(|u| u == user_id))
}

/// Whether `actor` may act on `target` with the permission `holds` checks —
/// the same hierarchy kicking and banning use: nobody acts on the owner or on
/// themselves, and moderators do not act on each other.
async fn may_act_on(
    state: &AppState,
    room_id: &str,
    actor: &str,
    target: &str,
    holds: fn(&RolePermissions) -> bool,
    what: &str,
) -> Result<(), ApiError> {
    if !is_member(state, room_id, actor).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    if !holds(&effective_permissions(state, room_id, actor).await) {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            &format!("You do not have permission to {what} in this room"),
        ));
    }
    if !is_member(state, room_id, target).await {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "That user is not a member of this room",
        ));
    }
    if actor == target {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "You cannot do that to yourself",
        ));
    }
    let actor_role = get_user_role(state, room_id, actor).await;
    let target_role = get_user_role(state, room_id, target).await;
    if target_role == "owner" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Cannot do that to the owner",
        ));
    }
    if actor_role == "moderator" && target_role == "moderator" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Moderators cannot do that to other moderators",
        ));
    }
    Ok(())
}

/// "1h", "3d" — how long a timeout is, for the audit log.
fn describe_duration(secs: i64) -> String {
    match secs {
        s if s % 86_400 == 0 => format!("{}d", s / 86_400),
        s if s % 3_600 == 0 => format!("{}h", s / 3_600),
        s if s % 60 == 0 => format!("{}m", s / 60),
        s => format!("{s}s"),
    }
}

/// Set a member's timeout and tell the room. Shared by the route and by
/// automod, which times people out on its own authority.
pub(crate) async fn apply_timeout(
    state: &Arc<AppState>,
    room_id: &str,
    actor: &str,
    target: &str,
    duration_secs: i64,
    reason: &str,
) -> i64 {
    let until = now_millis() + duration_secs * 1000;
    let _ = state
        .db
        .collection::<MemberTimeoutRecord>("member_timeouts")
        .replace_one(
            doc! { "_id": MemberTimeoutRecord::key(room_id, target) },
            MemberTimeoutRecord {
                id: MemberTimeoutRecord::key(room_id, target),
                room_id: room_id.to_string(),
                user_id: target.to_string(),
                until,
            },
        )
        .upsert(true)
        .await;

    // Speaking is refused from here on at the publish path; cut the audio
    // already flowing too, if they are talking in this room right now.
    let in_voice_here = {
        let vc = state.voice_channels.read().await;
        vc.values()
            .any(|members| members.get(target).is_some_and(|m| m.room_id == room_id))
    };
    if in_voice_here {
        let _ = teardown_voice_publisher(state, target).await;
    }

    broadcast_to_room(
        state,
        room_id,
        &json!({
            "type": "m.room.member.timeout",
            "room_id": room_id,
            "user_id": target,
            "timeout_until": until,
            "sender": actor,
        }),
    )
    .await;

    let mut detail = format!("for {}", describe_duration(duration_secs));
    let reason = reason.trim();
    if !reason.is_empty() {
        detail.push_str(": ");
        detail.extend(reason.chars().take(200));
    }
    audit::record(
        state,
        room_id,
        actor,
        audit::AuditAction::MemberTimedOut,
        target,
        &detail,
    )
    .await;
    until
}

/// PUT /api/rooms/{room_id}/members/{user_id}/timeout
///
/// Needs `kick_members`: a timeout is the lighter form of the same power.
pub(crate) async fn timeout_member(
    State(state): State<Arc<AppState>>,
    Path((room_id, target)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<TimeoutMemberRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    may_act_on(
        &state,
        &room_id,
        &user_id,
        &target,
        |p| p.kick_members,
        "time out members",
    )
    .await?;
    if !(60..=MAX_TIMEOUT_SECS).contains(&req.duration_secs) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "A timeout lasts between one minute and 28 days",
        ));
    }
    let until = apply_timeout(
        &state,
        &room_id,
        &user_id,
        &target,
        req.duration_secs,
        &req.reason,
    )
    .await;
    Ok(Json(json!({ "timeout_until": until })))
}

/// DELETE /api/rooms/{room_id}/members/{user_id}/timeout
pub(crate) async fn remove_timeout(
    State(state): State<Arc<AppState>>,
    Path((room_id, target)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    may_act_on(
        &state,
        &room_id,
        &user_id,
        &target,
        |p| p.kick_members,
        "time out members",
    )
    .await?;
    let _ = state
        .db
        .collection::<MemberTimeoutRecord>("member_timeouts")
        .delete_one(doc! { "_id": MemberTimeoutRecord::key(&room_id, &target) })
        .await;
    broadcast_to_room(
        &state,
        &room_id,
        &json!({
            "type": "m.room.member.timeout",
            "room_id": room_id,
            "user_id": target,
            "timeout_until": 0,
            "sender": user_id,
        }),
    )
    .await;
    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::MemberTimeoutRemoved,
        &target,
        "",
    )
    .await;
    Ok(Json(json!({ "timeout_until": 0 })))
}

/// The longest rules can be. A rules page longer than this is not going to
/// be read before anyone clicks "I agree".
const MAX_RULES_LEN: usize = 8000;
const MAX_BLOCKED_WORDS: usize = 500;
const MAX_BLOCKED_WORD_LEN: usize = 64;

async fn load_room(state: &AppState, room_id: &str) -> Result<RoomRecord, ApiError> {
    state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))
}

/// Whether `user_id` moderates the room: the owner, a moderator, or anyone
/// whose roles let them manage messages or remove members. They read the full
/// moderation settings and review reports.
async fn moderates(state: &AppState, room_id: &str, user_id: &str) -> bool {
    let role = get_user_role(state, room_id, user_id).await;
    if role == "owner" || role == "moderator" {
        return true;
    }
    let perms = effective_permissions(state, room_id, user_id).await;
    perms.manage_messages || perms.kick_members || perms.ban_members
}

/// Trim, lowercase, drop blanks and duplicates — the list is matched
/// case-insensitively, so two spellings of one word are one entry.
fn clean_word_list(words: &[String]) -> Result<Vec<String>, ApiError> {
    let mut out: Vec<String> = Vec::new();
    for word in words {
        let word = word.trim().to_lowercase();
        if word.is_empty() || word == "*" || out.contains(&word) {
            continue;
        }
        if word.chars().count() > MAX_BLOCKED_WORD_LEN {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                &format!("Blocked words are at most {MAX_BLOCKED_WORD_LEN} characters"),
            ));
        }
        out.push(word);
    }
    if out.len() > MAX_BLOCKED_WORDS {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            &format!("At most {MAX_BLOCKED_WORDS} blocked words"),
        ));
    }
    Ok(out)
}

fn clean_automod(mut automod: AutomodSettings) -> Result<AutomodSettings, ApiError> {
    automod.blocked_words = clean_word_list(&automod.blocked_words)?;
    if automod.max_mentions > 100 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "The mention limit is at most 100",
        ));
    }
    if !(0..=MAX_TIMEOUT_SECS).contains(&automod.timeout_secs) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "An automod timeout lasts at most 28 days",
        ));
    }
    Ok(automod)
}

/// GET /api/rooms/{room_id}/moderation
///
/// Moderators get everything; members get what `public_view` shows them.
pub(crate) async fn get_moderation_settings(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    let room = load_room(&state, &room_id).await?;
    if moderates(&state, &room_id, &user_id).await {
        let mut out = serde_json::to_value(&room.moderation).unwrap_or_default();
        // `rules_required` is the owner's switch as they set it, so it stays on
        // for an owner who turns it on before writing any rules; whether the
        // gate is actually in force is said separately.
        out["rules_gate_active"] = json!(super::super::moderation::rules_gate_active(&room));
        return Ok(Json(out));
    }
    Ok(Json(public_view(&room)))
}

/// PUT /api/rooms/{room_id}/moderation
///
/// Owner only: these settings decide what everyone else, moderators
/// included, is held to.
pub(crate) async fn update_moderation_settings(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<UpdateModerationRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    let room = load_room(&state, &room_id).await?;
    if room.is_dm {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "DMs have no moderation settings",
        ));
    }
    if get_user_role(&state, &room_id, &user_id).await != "owner" {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can change moderation settings",
        ));
    }

    let mut settings = room.moderation.clone();
    let mut changed: Vec<&str> = Vec::new();
    if let Some(rules) = req.rules {
        let rules = rules.trim().to_string();
        if rules.chars().count() > MAX_RULES_LEN {
            return Err(error_response(
                StatusCode::BAD_REQUEST,
                &format!("Rules are at most {MAX_RULES_LEN} characters"),
            ));
        }
        settings.rules = rules;
        changed.push("rules");
    }
    if let Some(required) = req.rules_required {
        settings.rules_required = required;
        changed.push("rules_required");
    }
    if let Some(enabled) = req.reports_enabled {
        settings.reports_enabled = enabled;
        changed.push("reports_enabled");
    }
    if let Some(automod) = req.automod {
        settings.automod = clean_automod(automod)?;
        changed.push("automod");
    }
    if changed.is_empty() {
        return Ok(Json(serde_json::to_value(&settings).unwrap_or_default()));
    }

    let bson = mongodb::bson::to_bson(&settings)
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save"))?;
    state
        .db
        .collection::<RoomRecord>("rooms")
        .update_one(
            doc! { "_id": &room_id },
            doc! { "$set": { "moderation": bson } },
        )
        .await
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Could not save"))?;

    let updated = RoomRecord {
        moderation: settings.clone(),
        ..room
    };
    broadcast_to_room(
        &state,
        &room_id,
        &json!({
            "type": "m.room.moderation",
            "room_id": room_id,
            "sender": user_id,
            "content": public_view(&updated),
        }),
    )
    .await;
    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::ModerationSettingsUpdated,
        &room_id,
        &format!("changed: {}", changed.join(", ")),
    )
    .await;

    Ok(Json(serde_json::to_value(&settings).unwrap_or_default()))
}

/// POST /api/rooms/{room_id}/rules/accept
///
/// Accepting is once per member: rewording the rules later does not send
/// everyone back through the gate.
pub(crate) async fn accept_rules(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    let now = now_millis();
    let _ = state
        .db
        .collection::<RoomMemberRecord>("room_members")
        .update_one(
            doc! { "room_id": &room_id, "user_id": &user_id, "rules_accepted_at": { "$in": [0_i64, null] } },
            doc! { "$set": { "rules_accepted_at": now } },
        )
        .await;
    Ok(Json(json!({ "accepted": true })))
}

/// Everyone who reviews reports in a room, for telling them about one. Built
/// from the role caches and the custom roles that grant moderation, rather
/// than by resolving every member's permissions one by one.
async fn reviewers(state: &AppState, room_id: &str) -> Vec<String> {
    let mut out: HashSet<String> = HashSet::new();
    {
        let roles = state.room_roles.read().await;
        if let Some(room_roles) = roles.get(room_id) {
            for (user, role) in room_roles {
                if role == "owner" || role == "moderator" {
                    out.insert(user.clone());
                }
            }
        }
    }
    if let Ok(Some(room)) = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
    {
        out.insert(room.creator);
    }
    let mut role_ids: Vec<String> = Vec::new();
    if let Ok(mut cursor) = state
        .db
        .collection::<CustomRoleRecord>("custom_roles")
        .find(doc! { "room_id": room_id })
        .await
    {
        while let Ok(Some(role)) = cursor.try_next().await {
            let p = &role.permissions;
            if p.manage_messages || p.kick_members || p.ban_members {
                role_ids.push(role.role_id);
            }
        }
    }
    if !role_ids.is_empty() {
        if let Ok(mut cursor) = state
            .db
            .collection::<MemberCustomRoleRecord>("member_custom_roles")
            .find(doc! { "room_id": room_id, "role_id": { "$in": &role_ids } })
            .await
        {
            while let Ok(Some(rec)) = cursor.try_next().await {
                out.insert(rec.user_id);
            }
        }
    }
    let members: HashSet<String> = {
        let rm = state.room_members.read().await;
        rm.get(room_id)
            .map(|m| m.iter().cloned().collect())
            .unwrap_or_default()
    };
    out.into_iter().filter(|u| members.contains(u)).collect()
}

async fn open_report_count(state: &AppState, room_id: &str) -> u64 {
    state
        .db
        .collection::<ReportRecord>("reports")
        .count_documents(doc! { "room_id": room_id, "status": "open" })
        .await
        .unwrap_or(0)
}

/// Tell the room's reviewers how many reports are open. `new_report` is set
/// when one has just arrived, so a client can say so rather than only
/// updating a badge.
async fn announce_reports(state: &AppState, room_id: &str, new_report: Option<&str>) {
    let open_count = open_report_count(state, room_id).await;
    let mut event = json!({
        "type": "m.room.reports",
        "room_id": room_id,
        "open_count": open_count,
    });
    if let Some(report_id) = new_report {
        event["new_report_id"] = json!(report_id);
    }
    for user in reviewers(state, room_id).await {
        send_to_user(state, &user, &event).await;
    }
}

/// The longest a report's reason can be.
const MAX_REASON_LEN: usize = 500;

/// POST /api/rooms/{room_id}/reports
///
/// Any member who can see a message can report it, unless the room has
/// turned reports off. Reporting the same message again replaces the reason
/// rather than stacking up a second report.
pub(crate) async fn create_report(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<CreateReportRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    let room = load_room(&state, &room_id).await?;
    if room.is_dm {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Direct messages have no moderators to report to",
        ));
    }
    if !room.moderation.reports_enabled {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "This room does not take reports",
        ));
    }
    if let Err(retry_after) =
        ratelimit::check(&state, &format!("report:{user_id}"), ratelimit::REPORT).await
    {
        return Err(rate_limited(
            retry_after,
            "You are reporting messages too quickly",
        ));
    }

    let msg = state
        .db
        .collection::<mongodb::bson::Document>("messages")
        .find_one(
            doc! { "event_id": &req.event_id, "room_id": &room_id, "redacted": { "$ne": true } },
        )
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Message not found"))?;
    let channel_id = msg.get_str("channel_id").unwrap_or("").to_string();
    // A message in a channel you cannot see does not exist, as far as you are
    // concerned — the same 404 as one that does not.
    if !channel_id.is_empty()
        && !channel_permissions(&state, &room_id, &channel_id, &user_id)
            .await
            .view_channel
    {
        return Err(error_response(StatusCode::NOT_FOUND, "Message not found"));
    }
    let sender = msg.get_str("sender").unwrap_or("").to_string();
    if sender == user_id {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "You cannot report your own message",
        ));
    }
    let body: String = msg
        .get_document("content")
        .ok()
        .and_then(|c| c.get_str("body").ok())
        .unwrap_or("")
        .chars()
        .take(4000)
        .collect();
    let reason: String = req.reason.trim().chars().take(MAX_REASON_LEN).collect();

    let reports = state.db.collection::<ReportRecord>("reports");
    let existing = reports
        .find_one(doc! {
            "room_id": &room_id,
            "event_id": &req.event_id,
            "reporter": &user_id,
            "status": "open",
        })
        .await
        .ok()
        .flatten();
    let report_id = if let Some(existing) = existing {
        let _ = reports
            .update_one(
                doc! { "_id": &existing.report_id },
                doc! { "$set": { "reason": &reason } },
            )
            .await;
        existing.report_id
    } else {
        let record = ReportRecord {
            report_id: generate_id("rep_"),
            room_id: room_id.clone(),
            event_id: req.event_id.clone(),
            channel_id,
            thread_id: msg.get_str("thread_id").unwrap_or("").to_string(),
            reporter: user_id.clone(),
            reported_user: sender,
            reason,
            body,
            message_ts: msg
                .get_i64("origin_server_ts")
                .or_else(|_| msg.get_i32("origin_server_ts").map(i64::from))
                .unwrap_or(0),
            created_at: now_millis(),
            status: "open".to_string(),
            resolved_by: String::new(),
            resolved_at: 0,
            message_deleted: false,
        };
        reports.insert_one(&record).await.map_err(|_| {
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not save the report",
            )
        })?;
        announce_reports(&state, &room_id, Some(&record.report_id)).await;
        record.report_id
    };

    Ok(Json(json!({ "report_id": report_id })))
}

fn report_json(r: &ReportRecord, message_exists: bool) -> Value {
    json!({
        "report_id": r.report_id,
        "event_id": r.event_id,
        "channel_id": r.channel_id,
        "thread_id": r.thread_id,
        "reporter": r.reporter,
        "reported_user": r.reported_user,
        "reason": r.reason,
        "body": r.body,
        "message_ts": r.message_ts,
        "created_at": r.created_at,
        "status": r.status,
        "resolved_by": r.resolved_by,
        "resolved_at": r.resolved_at,
        "message_deleted": r.message_deleted,
        "message_exists": message_exists,
    })
}

/// GET /api/rooms/{room_id}/reports?status=open|closed|all
///
/// Moderators only. Newest first, paged like the other listings.
pub(crate) async fn list_reports(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ReportsQuery>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await || !moderates(&state, &room_id, &user_id).await
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only moderators can review reports",
        ));
    }
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let offset = query.offset.unwrap_or(0);
    let mut filter = doc! { "room_id": &room_id };
    match query.status.as_deref().unwrap_or("open") {
        "open" => {
            filter.insert("status", "open");
        }
        "closed" => {
            filter.insert("status", doc! { "$ne": "open" });
        }
        _ => {}
    }

    let reports = state.db.collection::<ReportRecord>("reports");
    let mut page: Vec<ReportRecord> = Vec::new();
    if let Ok(mut cursor) = reports
        .find(filter)
        .sort(doc! { "created_at": -1 })
        .skip(offset)
        .limit(limit + 1)
        .await
    {
        while let Ok(Some(r)) = cursor.try_next().await {
            page.push(r);
        }
    }
    let has_more = page.len() as i64 > limit;
    page.truncate(limit as usize);

    // Whether each message is still there, so the queue can offer deleting it
    // only where there is something left to delete.
    let event_ids: Vec<&str> = page.iter().map(|r| r.event_id.as_str()).collect();
    let mut live: HashSet<String> = HashSet::new();
    if !event_ids.is_empty() {
        if let Ok(mut cursor) = state
            .db
            .collection::<mongodb::bson::Document>("messages")
            .find(doc! {
                "room_id": &room_id,
                "event_id": { "$in": &event_ids },
                "redacted": { "$ne": true },
            })
            .projection(doc! { "event_id": 1 })
            .await
        {
            while let Ok(Some(d)) = cursor.try_next().await {
                if let Ok(id) = d.get_str("event_id") {
                    live.insert(id.to_string());
                }
            }
        }
    }

    let items: Vec<Value> = page
        .iter()
        .map(|r| report_json(r, live.contains(&r.event_id)))
        .collect();
    Ok(Json(json!({
        "items": items,
        "has_more": has_more,
        "next_offset": offset + items.len() as u64,
        "open_count": open_report_count(&state, &room_id).await,
    })))
}

/// POST /api/rooms/{room_id}/reports/{report_id}/resolve
///
/// Closes the report — and every other open report of the same message, since
/// one decision answers them all — optionally deleting the message.
pub(crate) async fn resolve_report(
    State(state): State<Arc<AppState>>,
    Path((room_id, report_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<ResolveReportRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await || !moderates(&state, &room_id, &user_id).await
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only moderators can review reports",
        ));
    }
    if req.status != "resolved" && req.status != "dismissed" {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "status must be resolved or dismissed",
        ));
    }
    let reports = state.db.collection::<ReportRecord>("reports");
    let report = reports
        .find_one(doc! { "_id": &report_id, "room_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Report not found"))?;

    let mut deleted = false;
    if req.delete_message {
        let msg = state
            .db
            .collection::<mongodb::bson::Document>("messages")
            .find_one(doc! { "event_id": &report.event_id, "room_id": &room_id, "redacted": { "$ne": true } })
            .await
            .ok()
            .flatten();
        if let Some(msg) = msg {
            // The same hierarchy as deleting it directly: a moderator does not
            // delete the owner's words.
            let actor_role = get_user_role(&state, &room_id, &user_id).await;
            let sender = msg.get_str("sender").unwrap_or("").to_string();
            if actor_role != "owner" && get_user_role(&state, &room_id, &sender).await == "owner" {
                return Err(error_response(
                    StatusCode::FORBIDDEN,
                    "Moderators cannot delete the owner's messages",
                ));
            }
            super::messages::perform_redaction(
                &state,
                &room_id,
                &user_id,
                &report.event_id,
                &msg,
                true,
            )
            .await;
            deleted = true;
        }
    }

    let now = now_millis();
    let mut set = doc! {
        "status": &req.status,
        "resolved_by": &user_id,
        "resolved_at": now,
    };
    if deleted {
        set.insert("message_deleted", true);
    }
    let _ = reports
        .update_many(
            doc! { "room_id": &room_id, "event_id": &report.event_id, "status": "open" },
            doc! { "$set": set },
        )
        .await;

    announce_reports(&state, &room_id, None).await;
    let detail = match (req.status.as_str(), deleted) {
        (_, true) => "resolved, message deleted",
        ("dismissed", _) => "dismissed",
        _ => "resolved",
    };
    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::ReportResolved,
        &report.reported_user,
        detail,
    )
    .await;

    Ok(Json(
        json!({ "status": req.status, "message_deleted": deleted }),
    ))
}

/// The most messages one bulk deletion removes. Past this a raid is better
/// met by a ban and a second pass than by one request that runs for minutes.
const MAX_BULK_DELETE: i64 = 1000;
/// How far back a bulk deletion reaches.
const MAX_BULK_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// POST /api/rooms/{room_id}/messages/bulk-delete
///
/// Deletes one person's recent messages — the cleanup after spam. Works on
/// someone who has already left or been banned, which is usually when it is
/// wanted; while they are still a member, the usual hierarchy applies.
pub(crate) async fn bulk_delete_messages(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    Json(req): Json<BulkDeleteRequest>,
) -> Result<Json<Value>, ApiError> {
    let user_id = caller(&state, &headers)?;
    if !is_member(&state, &room_id, &user_id).await {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Not a member of this room",
        ));
    }
    if !effective_permissions(&state, &room_id, &user_id)
        .await
        .manage_messages
    {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You do not have permission to delete others' messages in this room",
        ));
    }
    if !(1..=MAX_BULK_WINDOW_SECS).contains(&req.since_secs) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Bulk deletion reaches back at most 7 days",
        ));
    }
    let actor_role = get_user_role(&state, &room_id, &user_id).await;
    if is_member(&state, &room_id, &req.user_id).await {
        let target_role = get_user_role(&state, &room_id, &req.user_id).await;
        if target_role == "owner" || (actor_role == "moderator" && target_role == "moderator") {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "You cannot delete that member's messages",
            ));
        }
    } else if load_room(&state, &room_id).await?.creator == req.user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "You cannot delete that member's messages",
        ));
    }

    let mut filter = doc! {
        "room_id": &room_id,
        "sender": &req.user_id,
        "origin_server_ts": { "$gte": now_millis() - req.since_secs * 1000 },
        "redacted": { "$ne": true },
        // Join and leave notices carry the member as sender but are the
        // server's words, not theirs.
        "content.msgtype": { "$ne": "m.system" },
    };
    if let Some(channel_id) = req.channel_id.as_deref().filter(|c| !c.is_empty()) {
        filter.insert("channel_id", channel_id);
    }
    let msg_coll = state.db.collection::<mongodb::bson::Document>("messages");
    let mut messages: Vec<mongodb::bson::Document> = Vec::new();
    if let Ok(mut cursor) = msg_coll
        .find(filter)
        .sort(doc! { "origin_server_ts": -1 })
        .limit(MAX_BULK_DELETE)
        .await
    {
        while let Ok(Some(d)) = cursor.try_next().await {
            messages.push(d);
        }
    }

    for msg in &messages {
        let Ok(event_id) = msg.get_str("event_id") else {
            continue;
        };
        super::messages::perform_redaction(&state, &room_id, &user_id, event_id, msg, true).await;
    }

    let deleted = messages.len();
    if deleted > 0 {
        audit::record(
            &state,
            &room_id,
            &user_id,
            audit::AuditAction::MessagesBulkDeleted,
            &req.user_id,
            &format!(
                "{deleted} message{} from the last {}",
                if deleted == 1 { "" } else { "s" },
                describe_duration(req.since_secs)
            ),
        )
        .await;
    }
    Ok(Json(json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::{clean_word_list, describe_duration};

    #[test]
    fn word_lists_are_trimmed_lowercased_and_deduplicated() {
        let words = vec![
            " Spam ".to_string(),
            "spam".to_string(),
            "".to_string(),
            "*".to_string(),
            "scam*".to_string(),
        ];
        assert_eq!(clean_word_list(&words).unwrap(), vec!["spam", "scam*"]);
        assert!(clean_word_list(&["x".repeat(65)]).is_err());
    }

    #[test]
    fn durations_read_in_their_largest_whole_unit() {
        assert_eq!(describe_duration(60), "1m");
        assert_eq!(describe_duration(3_600), "1h");
        assert_eq!(describe_duration(7 * 86_400), "7d");
        assert_eq!(describe_duration(90), "90s");
    }
}
