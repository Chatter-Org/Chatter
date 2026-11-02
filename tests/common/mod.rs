use axum::Router;
use chatter::backend::app::{build_app, build_state_in};
use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{net::TcpListener, task::JoinHandle, time::timeout};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use totp_rs::{Algorithm, Secret, TOTP};

pub type WsStream = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

pub struct TestServer {
    pub base_url: String,
    pub ws_url: String,
    database: String,
    handle: JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.abort();
        // Drop the test's database, so runs don't pile them up. On its own
        // thread and runtime: this runs inside the test's runtime, which
        // cannot be blocked on from here.
        let database = std::mem::take(&mut self.database);
        let _ = std::thread::spawn(move || {
            let uri = std::env::var("MONGODB_URI")
                .unwrap_or_else(|_| "mongodb://localhost:27017".to_string());
            tokio::runtime::Runtime::new().unwrap().block_on(async {
                if let Ok(client) = mongodb::Client::with_uri_str(&uri).await {
                    let _ = client.database(&database).drop().await;
                }
            });
        })
        .join();
    }
}

pub async fn spawn_server() -> TestServer {
    // A database of its own: every test registers its own "alice".
    let database = format!("chatter_test_{:016x}", rand::random::<u64>());
    let app: Router = build_app(build_state_in(&database).await);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // Served as production serves it (app.rs), with the peer address attached:
    // registration and the rate limits read it, and without it every such
    // route answered 500.
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });

    TestServer {
        base_url: format!("http://{}", addr),
        ws_url: format!("ws://{}/ws", addr),
        database,
        handle,
    }
}

/// Percent-encodes an id for a URL. Channel ids start with `#`, which a URL
/// would otherwise read as the start of its fragment and drop.
#[allow(dead_code)] // each test binary compiles this module; only one uses it
pub fn esc(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

pub fn bearer(token: &str) -> String {
    format!("Bearer {}", token)
}

/// A password the registration rules accept.
pub const PASSWORD: &str = "password1";

/// The current code for a TOTP secret, as an authenticator app would show it.
pub fn totp_code(secret: &str, username: &str) -> String {
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        Secret::Encoded(secret.to_string()).to_bytes().unwrap(),
        Some("Chatter".to_string()),
        username.to_string(),
    )
    .unwrap()
    .generate_current()
    .unwrap()
}

/// Registers and confirms the TOTP code, as the sign-up form does. Returns the
/// user id, an access token, and the TOTP secret (which logging in needs).
pub async fn register_user_with_secret(
    client: &Client,
    base_url: &str,
    username: &str,
    password: &str,
) -> (String, String, String) {
    let response = client
        .post(format!("{}/_matrix/client/r0/register", base_url))
        .json(&json!({
            "username": username,
            "password": password,
            "device_id": format!("{}-device", username)
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let user_id = body["user_id"].as_str().unwrap().to_string();
    let secret = body["totp_secret"].as_str().unwrap().to_string();

    let response = client
        .post(format!("{}/api/totp/verify", base_url))
        .json(&json!({"user_id": user_id, "code": totp_code(&secret, username)}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    let token = body["access_token"].as_str().unwrap().to_string();
    (user_id, token, secret)
}

pub async fn register_user(
    client: &Client,
    base_url: &str,
    username: &str,
    password: &str,
) -> (String, String) {
    let (user_id, token, _) = register_user_with_secret(client, base_url, username, password).await;
    (user_id, token)
}

pub async fn create_room(
    client: &Client,
    base_url: &str,
    token: &str,
    name: &str,
    invite: Option<Vec<String>>,
    is_direct: bool,
) -> String {
    let response = client
        .post(format!("{}/_matrix/client/r0/createRoom", base_url))
        .header("authorization", bearer(token))
        .json(&json!({
            "name": name,
            "topic": "",
            "invite": invite,
            "is_direct": is_direct
        }))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.unwrap();
    body["room_id"].as_str().unwrap().to_string()
}

pub async fn ws_connect_authenticated(ws_url: &str, token: &str) -> WsStream {
    let (mut socket, _) = connect_async(ws_url).await.unwrap();
    socket
        .send(Message::Text(json!({"access_token": token}).to_string()))
        .await
        .unwrap();
    socket
}

pub async fn recv_json(ws: &mut WsStream) -> Value {
    loop {
        let next_msg = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for websocket message")
            .expect("websocket stream ended")
            .expect("websocket read error");

        match next_msg {
            Message::Text(text) => {
                let text = text.to_string();
                return serde_json::from_str(&text).expect("text message should be valid JSON");
            }
            Message::Binary(bin) => {
                return serde_json::from_slice(&bin)
                    .expect("binary message in contract tests should be valid JSON");
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Close(frame) => {
                panic!("unexpected websocket close: {:?}", frame);
            }
        }
    }
}

pub async fn recv_event_type(ws: &mut WsStream, event_type: &str) -> Value {
    recv_matching(ws, |event| {
        event.get("type").and_then(Value::as_str) == Some(event_type)
    })
    .await
}

pub async fn recv_matching<F>(ws: &mut WsStream, predicate: F) -> Value
where
    F: Fn(&Value) -> bool,
{
    loop {
        let event = recv_json(ws).await;
        if predicate(&event) {
            return event;
        }
    }
}

// ─── End-to-end encryption ───────────────────────────────────────────────────
//
// The server never opens anything it is given, so these are byte strings of
// the right lengths rather than real keys: what the server checks is shape.

#[allow(dead_code)]
pub const B64_16: &str = "BwcHBwcHBwcHBwcHBwcHBw==";
#[allow(dead_code)]
pub const B64_24: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
#[allow(dead_code)]
pub const B64_32: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
#[allow(dead_code)]
pub const B64_48: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
#[allow(dead_code)]
pub const B64_64: &str =
    "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBw==";

/// Publish an identity for the account behind `token`, confirmed with a
/// code from its TOTP `secret` as the server requires.
#[allow(dead_code)]
pub async fn put_e2e_identity(
    client: &Client,
    base_url: &str,
    token: &str,
    username: &str,
    secret: &str,
) {
    let response = client
        .put(format!("{base_url}/api/e2e/identity"))
        .header("authorization", bearer(token))
        .json(&json!({
            "enc_pub": B64_32,
            "sign_pub": B64_32,
            "backup": {
                "kdf": "scrypt", "log_n": 15, "r": 8, "p": 1,
                "salt": B64_16, "nonce": B64_24, "ct": B64_48,
            },
            "totp_code": totp_code(secret, username),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

/// A wrapped room key for `user_id`, as `POST /api/rooms/{id}/e2e/keys` takes it.
#[allow(dead_code)]
pub fn wrapped_key(user_id: &str) -> Value {
    json!({ "user_id": user_id, "eph": B64_32, "nonce": B64_24, "ct": B64_48, "sig": B64_64 })
}

/// Start `epoch` in an encrypted room, with a copy for each of `user_ids`.
#[allow(dead_code)]
pub async fn post_room_keys(
    client: &Client,
    base_url: &str,
    token: &str,
    room_id: &str,
    epoch: i64,
    user_ids: &[&str],
) -> reqwest::Response {
    let keys: Vec<Value> = user_ids.iter().map(|u| wrapped_key(u)).collect();
    client
        .post(format!("{base_url}/api/rooms/{}/e2e/keys", esc(room_id)))
        .header("authorization", bearer(token))
        .json(&json!({ "epoch": epoch, "keys": keys }))
        .send()
        .await
        .unwrap()
}

/// A sealed message body under `epoch`, as a client sends it.
#[allow(dead_code)]
pub fn sealed_message(epoch: i64) -> Value {
    json!({
        "msgtype": "m.text",
        "body": "",
        "e2e": { "v": 1, "epoch": epoch, "nonce": B64_24, "ct": B64_48, "sig": B64_64 },
    })
}
