//! Moderation tools: invite limits, timeouts, the rules gate, reports, bulk
//! deletion and automod.

#[allow(dead_code)] // shared with the other test binaries; not every helper is used here
mod common;

use common::*;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

/// Posts a message as `token`, answering the status and the body.
async fn send(
    client: &Client,
    base_url: &str,
    token: &str,
    room_id: &str,
    body: &str,
) -> (StatusCode, Value) {
    let response = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/send/m.room.message/{}",
            base_url,
            room_id,
            rand::random::<u32>()
        ))
        .header("authorization", bearer(token))
        .json(&json!({ "msgtype": "m.text", "body": body }))
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// The caller's permissions in a room, with what is restricting them.
async fn my_permissions(client: &Client, base_url: &str, token: &str, room_id: &str) -> Value {
    client
        .get(format!("{}/api/rooms/{}/permissions", base_url, room_id))
        .header("authorization", bearer(token))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

async fn create_invite(
    client: &Client,
    base_url: &str,
    token: &str,
    room_id: &str,
    body: Value,
) -> String {
    let response = client
        .post(format!("{}/api/rooms/{}/invites", base_url, room_id))
        .header("authorization", bearer(token))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.unwrap()["code"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn accept_invite(client: &Client, base_url: &str, token: &str, code: &str) -> StatusCode {
    client
        .post(format!("{}/api/invites/{}/accept", base_url, code))
        .header("authorization", bearer(token))
        .send()
        .await
        .unwrap()
        .status()
}

#[tokio::test]
async fn invite_max_uses_counts_joins_not_clicks_or_members() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (_, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (_, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let (_, carol) = register_user(&client, base, "carol", PASSWORD).await;
    let (_, dave) = register_user(&client, base, "dave", PASSWORD).await;
    let room_id = create_room(&client, base, &alice, "Limited", None, false).await;

    // Out of range is refused rather than clamped.
    let too_many = client
        .post(format!("{}/api/rooms/{}/invites", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({ "max_uses": 5000 }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_many.status(), StatusCode::BAD_REQUEST);

    let code = create_invite(&client, base, &alice, &room_id, json!({ "max_uses": 2 })).await;

    // Opening the link is not a use.
    let info = client
        .get(format!("{}/api/invites/{}", base, code))
        .send()
        .await
        .unwrap();
    assert_eq!(info.status(), StatusCode::OK);

    assert_eq!(
        accept_invite(&client, base, &bob, &code).await,
        StatusCode::OK
    );
    // A member using it again is let through without spending a use.
    assert_eq!(
        accept_invite(&client, base, &bob, &code).await,
        StatusCode::OK
    );
    assert_eq!(
        accept_invite(&client, base, &carol, &code).await,
        StatusCode::OK
    );
    assert_eq!(
        accept_invite(&client, base, &dave, &code).await,
        StatusCode::GONE
    );

    let info = client
        .get(format!("{}/api/invites/{}", base, code))
        .send()
        .await
        .unwrap();
    assert_eq!(info.status(), StatusCode::GONE);

    let list: Value = client
        .get(format!("{}/api/rooms/{}/invites", base, room_id))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let invite = &list["invites"][0];
    assert_eq!(invite["max_uses"], 2);
    assert_eq!(invite["uses"], 2);

    // An unlimited invite still counts who joined through it.
    let open = create_invite(&client, base, &alice, &room_id, json!({})).await;
    assert_eq!(
        accept_invite(&client, base, &dave, &open).await,
        StatusCode::OK
    );
    let list: Value = client
        .get(format!("{}/api/rooms/{}/invites", base, room_id))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let open_invite = list["invites"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["code"] == open)
        .unwrap();
    assert_eq!(open_invite["max_uses"], 0);
    assert_eq!(open_invite["uses"], 1);
}

#[tokio::test]
async fn timeouts_stop_posting_and_respect_the_hierarchy() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (alice_id, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (bob_id, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let (carol_id, carol) = register_user(&client, base, "carol", PASSWORD).await;
    let room_id = create_room(
        &client,
        base,
        &alice,
        "Timeouts",
        Some(vec![bob_id.clone(), carol_id.clone()]),
        false,
    )
    .await;

    // A plain member cannot time anyone out.
    let refused = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/timeout",
            base, room_id, bob_id
        ))
        .header("authorization", bearer(&carol))
        .json(&json!({ "duration_secs": 600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    // Nobody times out the owner — not even the owner.
    let owner = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/timeout",
            base, room_id, alice_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "duration_secs": 600 }))
        .send()
        .await
        .unwrap();
    assert_ne!(owner.status(), StatusCode::OK);

    // Out-of-range durations are refused.
    let too_long = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/timeout",
            base, room_id, bob_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "duration_secs": 30 * 24 * 60 * 60 }))
        .send()
        .await
        .unwrap();
    assert_eq!(too_long.status(), StatusCode::BAD_REQUEST);

    let timed_out = client
        .put(format!(
            "{}/api/rooms/{}/members/{}/timeout",
            base, room_id, bob_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "duration_secs": 600, "reason": "cool off" }))
        .send()
        .await
        .unwrap();
    assert_eq!(timed_out.status(), StatusCode::OK);

    let (status, body) = send(&client, base, &bob, &room_id, "still here").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "timed_out");

    // The restriction is reported with the permissions, and they are off.
    let perms = my_permissions(&client, base, &bob, &room_id).await;
    assert!(perms["restriction"]["timeout_until"].as_i64().unwrap() > 0);
    assert_eq!(perms["permissions"]["send_messages"], false);
    assert_eq!(perms["permissions"]["add_reactions"], false);
    assert_eq!(perms["permissions"]["connect"], false);
    assert_eq!(perms["permissions"]["view_channel"], true);

    // The member list says so, for everyone.
    let members: Value = client
        .get(format!("{}/api/rooms/{}/members", base, room_id))
        .header("authorization", bearer(&carol))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let bob_entry = members["members"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["user_id"] == bob_id)
        .unwrap();
    assert!(bob_entry["timeout_until"].as_i64().unwrap() > 0);

    // Others are unaffected.
    let (status, _) = send(&client, base, &carol, &room_id, "hi").await;
    assert_eq!(status, StatusCode::OK);

    // Leaving and coming back does not shake it off.
    let code = create_invite(&client, base, &alice, &room_id, json!({})).await;
    let left = client
        .post(format!(
            "{}/_matrix/client/r0/rooms/{}/leave",
            base, room_id
        ))
        .header("authorization", bearer(&bob))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(left.status(), StatusCode::OK);
    assert_eq!(
        accept_invite(&client, base, &bob, &code).await,
        StatusCode::OK
    );
    let (status, body) = send(&client, base, &bob, &room_id, "new me").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "timed_out");

    let lifted = client
        .delete(format!(
            "{}/api/rooms/{}/members/{}/timeout",
            base, room_id, bob_id
        ))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap();
    assert_eq!(lifted.status(), StatusCode::OK);
    let (status, _) = send(&client, base, &bob, &room_id, "back").await;
    assert_eq!(status, StatusCode::OK);

    // It is in the audit log.
    let audit: Value = client
        .get(format!(
            "{}/api/rooms/{}/audit?action=member",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let actions: Vec<&str> = audit["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    assert!(actions.contains(&"member.timed_out"));
    assert!(actions.contains(&"member.timeout_removed"));
}

#[tokio::test]
async fn the_rules_gate_holds_members_until_they_accept() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (_, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (bob_id, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let room_id = create_room(
        &client,
        base,
        &alice,
        "Rules",
        Some(vec![bob_id.clone()]),
        false,
    )
    .await;

    // Only the owner can change moderation settings.
    let refused = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&bob))
        .json(&json!({ "rules_required": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    // Required but empty is no gate: nothing to accept.
    let saved = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({ "rules_required": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let (status, _) = send(&client, base, &bob, &room_id, "before rules").await;
    assert_eq!(status, StatusCode::OK);

    let saved = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({
            "rules": "Be kind.",
            "automod": { "enabled": true, "blocked_words": ["Secret", "secret"] },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    let (status, body) = send(&client, base, &bob, &room_id, "hello").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "rules_pending");
    // The owner is never held.
    let (status, _) = send(&client, base, &alice, &room_id, "welcome").await;
    assert_eq!(status, StatusCode::OK);

    // A member sees the rules but not the automod word list.
    let public: Value = client
        .get(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&bob))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["rules"], "Be kind.");
    assert_eq!(public["rules_required"], true);
    assert!(public.get("automod").is_none());
    let full: Value = client
        .get(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(full["automod"]["blocked_words"], json!(["secret"]));

    let perms = my_permissions(&client, base, &bob, &room_id).await;
    assert_eq!(perms["restriction"]["rules_pending"], true);

    let accepted = client
        .post(format!("{}/api/rooms/{}/rules/accept", base, room_id))
        .header("authorization", bearer(&bob))
        .send()
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::OK);
    let (status, _) = send(&client, base, &bob, &room_id, "hello").await;
    assert_eq!(status, StatusCode::OK);

    // Rewording the rules does not send anyone back through the gate.
    let _ = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({ "rules": "Be very kind." }))
        .send()
        .await
        .unwrap();
    let (status, _) = send(&client, base, &bob, &room_id, "still fine").await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn reports_reach_moderators_and_close_together() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (alice_id, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (bob_id, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let (carol_id, carol) = register_user(&client, base, "carol", PASSWORD).await;
    let room_id = create_room(
        &client,
        base,
        &alice,
        "Reports",
        Some(vec![bob_id.clone(), carol_id.clone()]),
        false,
    )
    .await;

    let (_, sent) = send(&client, base, &bob, &room_id, "buy cheap watches").await;
    let event_id = sent["event_id"].as_str().unwrap().to_string();

    let report = |token: String, event: String, reason: &'static str| {
        let client = client.clone();
        let url = format!("{}/api/rooms/{}/reports", base, room_id);
        async move {
            client
                .post(url)
                .header("authorization", bearer(&token))
                .json(&json!({ "event_id": event, "reason": reason }))
                .send()
                .await
                .unwrap()
                .status()
        }
    };

    // Your own message is not yours to report.
    assert_eq!(
        report(bob.clone(), event_id.clone(), "me").await,
        StatusCode::BAD_REQUEST
    );

    let mut alice_ws = ws_connect_authenticated(&server.ws_url, &alice).await;
    assert_eq!(
        report(carol.clone(), event_id.clone(), "spam").await,
        StatusCode::OK
    );
    let announced = recv_event_type(&mut alice_ws, "m.room.reports").await;
    assert_eq!(announced["open_count"], 1);
    // Reporting it again updates the one report rather than adding another.
    assert_eq!(
        report(carol.clone(), event_id.clone(), "spam!!").await,
        StatusCode::OK
    );
    assert_eq!(
        report(alice.clone(), event_id.clone(), "also spam").await,
        StatusCode::OK
    );

    // Members cannot read the queue.
    let refused = client
        .get(format!("{}/api/rooms/{}/reports", base, room_id))
        .header("authorization", bearer(&carol))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    let queue: Value = client
        .get(format!("{}/api/rooms/{}/reports", base, room_id))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(queue["open_count"], 2);
    let items = queue["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let carols = items.iter().find(|r| r["reporter"] == carol_id).unwrap();
    assert_eq!(carols["reason"], "spam!!");
    assert_eq!(carols["body"], "buy cheap watches");
    assert_eq!(carols["reported_user"], bob_id);
    assert_eq!(carols["message_exists"], true);
    let report_id = carols["report_id"].as_str().unwrap().to_string();

    // Resolving one, with the message deleted, closes both.
    let resolved = client
        .post(format!(
            "{}/api/rooms/{}/reports/{}/resolve",
            base, room_id, report_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "status": "resolved", "delete_message": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(resolved.status(), StatusCode::OK);
    let queue: Value = client
        .get(format!(
            "{}/api/rooms/{}/reports?status=closed",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(queue["open_count"], 0);
    let closed = queue["items"].as_array().unwrap();
    assert_eq!(closed.len(), 2);
    assert!(closed.iter().all(|r| r["message_deleted"] == true));
    assert!(closed.iter().all(|r| r["resolved_by"] == alice_id));

    // A deleted message cannot be reported.
    assert_eq!(
        report(carol.clone(), event_id.clone(), "again").await,
        StatusCode::NOT_FOUND
    );

    // A room can turn reports off.
    let _ = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({ "reports_enabled": false }))
        .send()
        .await
        .unwrap();
    let (_, sent) = send(&client, base, &bob, &room_id, "another").await;
    let other = sent["event_id"].as_str().unwrap().to_string();
    assert_eq!(
        report(carol.clone(), other, "x").await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn bulk_delete_removes_one_persons_recent_messages() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (alice_id, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (bob_id, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let (carol_id, carol) = register_user(&client, base, "carol", PASSWORD).await;
    let room_id = create_room(
        &client,
        base,
        &alice,
        "Cleanup",
        Some(vec![bob_id.clone(), carol_id.clone()]),
        false,
    )
    .await;

    for i in 0..3 {
        let (status, _) = send(&client, base, &bob, &room_id, &format!("spam {i}")).await;
        assert_eq!(status, StatusCode::OK);
    }
    let (_, kept) = send(&client, base, &carol, &room_id, "a real message").await;

    // A member without manage_messages cannot.
    let refused = client
        .post(format!(
            "{}/api/rooms/{}/messages/bulk-delete",
            base, room_id
        ))
        .header("authorization", bearer(&carol))
        .json(&json!({ "user_id": bob_id, "since_secs": 3600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);

    // Nobody bulk-deletes the owner.
    let owner = client
        .post(format!(
            "{}/api/rooms/{}/messages/bulk-delete",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "user_id": alice_id, "since_secs": 3600 }))
        .send()
        .await
        .unwrap();
    assert_eq!(owner.status(), StatusCode::FORBIDDEN);

    // Works on someone who is no longer a member — the usual case after a ban.
    let banned = client
        .post(format!("{}/api/rooms/{}/ban/{}", base, room_id, bob_id))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap();
    assert_eq!(banned.status(), StatusCode::OK);

    let done: Value = client
        .post(format!(
            "{}/api/rooms/{}/messages/bulk-delete",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .json(&json!({ "user_id": bob_id, "since_secs": 3600 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(done["deleted"], 3);

    let history: Value = client
        .get(format!(
            "{}/_matrix/client/r0/rooms/{}/messages?limit=50",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // Deleted messages are left out of history; only notices of Bob remain.
    let left: Vec<&Value> = history["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["sender"] == bob_id && m["content"]["msgtype"] != "m.system")
        .collect();
    assert!(left.is_empty(), "{left:?}");
    let kept_id = kept["event_id"].as_str().unwrap();
    assert!(history["chunk"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["event_id"] == kept_id && m["content"]["body"] == "a real message"));
}

#[tokio::test]
async fn automod_blocks_filtered_messages_and_can_time_out() {
    let server = spawn_server().await;
    let client = Client::new();
    let base = &server.base_url;

    let (_, alice) = register_user(&client, base, "alice", PASSWORD).await;
    let (bob_id, bob) = register_user(&client, base, "bob", PASSWORD).await;
    let room_id = create_room(
        &client,
        base,
        &alice,
        "Filtered",
        Some(vec![bob_id.clone()]),
        false,
    )
    .await;

    let saved = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({
            "automod": {
                "enabled": true,
                "blocked_words": ["scam*"],
                "block_invites": true,
                "block_repeats": true,
            },
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);

    let (status, body) = send(&client, base, &bob, &room_id, "total SCAMMER here").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "automod");
    assert_eq!(body["rule"], "blocked_word");

    let (status, body) = send(&client, base, &bob, &room_id, "join discord.gg/abcdef").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["rule"], "invite");

    // The same message twice in a row is a repeat.
    let (status, sent) = send(&client, base, &bob, &room_id, "hello there").await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = send(&client, base, &bob, &room_id, "hello there").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["rule"], "repeat");

    // Editing a message into something filtered is refused as well.
    let event_id = sent["event_id"].as_str().unwrap();
    let edited = client
        .put(format!(
            "{}/_matrix/client/r0/rooms/{}/edit/{}/1",
            base, room_id, event_id
        ))
        .header("authorization", bearer(&bob))
        .json(&json!({ "body": "scam link inside" }))
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), StatusCode::FORBIDDEN);

    // The owner manages messages, so automod leaves them alone.
    let (status, _) = send(&client, base, &alice, &room_id, "warning: scams about").await;
    assert_eq!(status, StatusCode::OK);

    // With a timeout set, tripping a filter also times the sender out.
    let _ = client
        .put(format!("{}/api/rooms/{}/moderation", base, room_id))
        .header("authorization", bearer(&alice))
        .json(&json!({
            "automod": { "enabled": true, "blocked_words": ["scam*"], "timeout_secs": 600 },
        }))
        .send()
        .await
        .unwrap();
    let (status, body) = send(&client, base, &bob, &room_id, "scam").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["timeout_until"].as_i64().unwrap() > 0);
    let (status, body) = send(&client, base, &bob, &room_id, "an innocent message").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "timed_out");

    // Each block is in the audit log, naming the filter and not the words.
    let audit: Value = client
        .get(format!(
            "{}/api/rooms/{}/audit?action=automod",
            base, room_id
        ))
        .header("authorization", bearer(&alice))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = audit["items"].as_array().unwrap();
    assert!(entries.len() >= 4);
    assert!(entries.iter().all(|e| e["target_id"] == bob_id));
    assert!(entries
        .iter()
        .all(|e| !e["detail"].as_str().unwrap_or("").contains("scam")));
}
