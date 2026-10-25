use super::super::{
    audit,
    dto::CreateInviteRequest,
    helpers::{
        do_join_room, error_response, extract_token, get_user_from_token, now_millis, rate_limited,
    },
    ratelimit,
    state::{AppState, InviteRecord, RoomRecord},
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Json,
};
use futures_util::TryStreamExt;
use mongodb::bson::doc;
use rand::Rng;
use serde_json::{json, Value};
use std::sync::Arc;

/// The most uses one invite can be given. Past this it is an open door, and
/// "unlimited" says so more honestly.
const MAX_INVITE_USES: i64 = 1000;

const USED_UP: &str = "This invite has been used the maximum number of times";

fn invite_used_up(invite: &InviteRecord) -> bool {
    invite.max_uses > 0 && invite.uses >= invite.max_uses
}

/// What the audit log says about a new invite's limits.
fn invite_limits_detail(max_uses: i64, expires_in_days: Option<u64>) -> String {
    let mut parts = Vec::new();
    if max_uses > 0 {
        parts.push(format!("max uses {max_uses}"));
    }
    if let Some(days) = expires_in_days {
        parts.push(format!("expires in {days}d"));
    }
    parts.join(", ")
}

fn generate_invite_code() -> String {
    const CHARSET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| CHARSET[rng.gen_range(0..CHARSET.len())] as char)
        .collect()
}

pub(crate) async fn create_invite(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<CreateInviteRequest>>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    if let Err(retry_after) = ratelimit::check(
        &state,
        &format!("invite:{user_id}"),
        ratelimit::CREATE_INVITE,
    )
    .await
    {
        return Err(rate_limited(
            retry_after,
            "You are creating invites too quickly",
        ));
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can create invites",
        ));
    }
    if room.is_dm {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Cannot create invites for DM rooms",
        ));
    }

    let body = body.map(|Json(b)| b).unwrap_or_default();
    let expires_at = body
        .expires_in_days
        .map(|days| now_millis() + days as i64 * 24 * 60 * 60 * 1000);
    let max_uses = body.max_uses.unwrap_or(0);
    if !(0..=MAX_INVITE_USES).contains(&max_uses) {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            &format!("An invite can allow at most {MAX_INVITE_USES} uses"),
        ));
    }

    let code = generate_invite_code();
    let record = InviteRecord {
        code: code.clone(),
        room_id: room_id.clone(),
        creator: user_id.clone(),
        click_count: 0,
        created_at: now_millis(),
        expires_at,
        max_uses,
        uses: 0,
    };

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let _ = inv_coll.insert_one(record).await;

    audit::record(
        &state,
        &room_id,
        &user_id,
        audit::AuditAction::InviteCreated,
        &code,
        &invite_limits_detail(max_uses, body.expires_in_days),
    )
    .await;

    Ok(Json(
        json!({ "code": code, "expires_at": expires_at, "max_uses": max_uses }),
    ))
}

pub(crate) async fn list_invites(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can list invites",
        ));
    }

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let mut list: Vec<Value> = Vec::new();

    if let Ok(mut cursor) = inv_coll.find(doc! { "room_id": &room_id }).await {
        while let Ok(Some(inv)) = cursor.try_next().await {
            list.push(json!({
                "code": inv.code,
                "click_count": inv.click_count,
                "created_at": inv.created_at,
                "expires_at": inv.expires_at,
                "max_uses": inv.max_uses,
                "uses": inv.uses,
            }));
        }
    }

    Ok(Json(json!({ "invites": list })))
}

pub(crate) async fn delete_invite(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let invite = inv_coll
        .find_one(doc! { "_id": &code })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    if room.creator != user_id {
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Only the room owner can delete invites",
        ));
    }

    let _ = inv_coll.delete_one(doc! { "_id": &code }).await;

    audit::record(
        &state,
        &room.room_id,
        &user_id,
        audit::AuditAction::InviteDeleted,
        &code,
        "",
    )
    .await;

    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn get_invite_info(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let inv_coll = state.db.collection::<InviteRecord>("invites");

    // Increment click count
    let invite = inv_coll
        .find_one_and_update(
            doc! { "_id": &code },
            doc! { "$inc": { "click_count": 1_i64 } },
        )
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    if let Some(expires_at) = invite.expires_at {
        if now_millis() > expires_at {
            return Err(error_response(StatusCode::GONE, "Invite has expired"));
        }
    }
    if invite_used_up(&invite) {
        return Err(error_response(StatusCode::GONE, USED_UP));
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    let room = rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Room not found"))?;

    let rm = state.room_members.read().await;
    let member_count = rm.get(&invite.room_id).map(|m| m.len()).unwrap_or(0);

    Ok(Json(json!({
        "room_name": room.name,
        "icon_url": room.icon_url,
        "member_count": member_count,
    })))
}

pub(crate) async fn accept_invite(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let inv_coll = state.db.collection::<InviteRecord>("invites");
    let invite = inv_coll
        .find_one(doc! { "_id": &code })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invite not found"))?;

    if let Some(expires_at) = invite.expires_at {
        if now_millis() > expires_at {
            return Err(error_response(StatusCode::GONE, "Invite has expired"));
        }
    }

    let rooms_coll = state.db.collection::<RoomRecord>("rooms");
    if rooms_coll
        .find_one(doc! { "_id": &invite.room_id })
        .await
        .ok()
        .flatten()
        .is_none()
    {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "Room no longer exists",
        ));
    }

    // Someone already in the room is sent there without spending a use: a
    // member clicking the link again has not joined anyone.
    let already_member = {
        let rm = state.room_members.read().await;
        rm.get(&invite.room_id)
            .is_some_and(|m| m.contains(&user_id))
    };
    if already_member {
        return Ok(Json(json!({ "room_id": invite.room_id })));
    }

    // A limited invite's use is claimed before the join, in one conditional
    // update, so two people racing for the last use cannot both get it.
    let limited = invite.max_uses > 0;
    if limited {
        let claimed = inv_coll
            .update_one(
                doc! {
                    "_id": &code,
                    "$expr": { "$lt": [{ "$ifNull": ["$uses", 0] }, "$max_uses"] },
                },
                doc! { "$inc": { "uses": 1_i64 } },
            )
            .await
            .map(|r| r.modified_count == 1)
            .unwrap_or(false);
        if !claimed {
            return Err(error_response(StatusCode::GONE, USED_UP));
        }
    }

    match do_join_room(&state, &invite.room_id, &user_id).await {
        Err(msg) => {
            // Refused (a ban), so the use it claimed goes back.
            if limited {
                let _ = inv_coll
                    .update_one(doc! { "_id": &code }, doc! { "$inc": { "uses": -1_i64 } })
                    .await;
            }
            return Err(error_response(StatusCode::FORBIDDEN, msg));
        }
        Ok(_) if !limited => {
            let _ = inv_coll
                .update_one(doc! { "_id": &code }, doc! { "$inc": { "uses": 1_i64 } })
                .await;
        }
        Ok(_) => {}
    }

    Ok(Json(json!({ "room_id": invite.room_id })))
}
