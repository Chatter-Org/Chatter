use super::super::{
    helpers::{
        auth_cookie_headers, create_access_token, create_refresh_token, error_response,
        extract_token, get_user_from_token, now_secs,
    },
    state::{
        AppState, RefreshTokenRecord, SteamFlow, SteamLoginCode, TotpAttemptRecord, UserRecord,
    },
};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Redirect, Response},
};
use mongodb::bson::doc;
use rand::Rng;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};

const STEAM_OPENID_ENDPOINT: &str = "https://steamcommunity.com/openid/login";
const STEAM_ID_PREFIX: &str = "https://steamcommunity.com/openid/id/";
const CALLBACK_PATH: &str = "/api/auth/steam/callback";
/// The cookie tying a callback to the browser that started the flow.
const FLOW_COOKIE: &str = "steam_flow";
/// How long a started sign-in or link may take at Steam's end.
const FLOW_TTL_SECS: f64 = 600.0;
/// How long a sign-in code waits to be exchanged. Long enough to type an
/// authenticator code, which is asked for at the exchange.
const LOGIN_CODE_TTL_SECS: f64 = 300.0;

/// This server's public origin, from `SERVER_URL` only.
///
/// It used to fall back to the request's `Host` and `X-Forwarded-Proto`, which
/// a caller chooses. Checking `return_to` against an origin the caller names
/// checks nothing, so Steam needs `SERVER_URL` set — as the README has always
/// said it does.
fn server_url() -> Option<String> {
    std::env::var("SERVER_URL")
        .ok()
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
}

/// Where to send the browser back to: the app's root, with `query`.
fn back_to_app(query: &str) -> Response {
    let base = server_url().unwrap_or_default();
    Redirect::temporary(&format!("{base}/?{query}")).into_response()
}

fn build_steam_openid_url(return_to: &str, realm: &str) -> String {
    let params = [
        ("openid.ns", "http://specs.openid.net/auth/2.0"),
        ("openid.mode", "checkid_setup"),
        ("openid.return_to", return_to),
        ("openid.realm", realm),
        (
            "openid.identity",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
        (
            "openid.claimed_id",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
    ];
    let query: String = params
        .iter()
        .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{STEAM_OPENID_ENDPOINT}?{query}")
}

/// Start a flow: remember its state and hand back the URL to send the browser
/// to, and the cookie that binds the flow to that browser.
async fn start_flow(
    state: &AppState,
    base_url: &str,
    mode: &str,
    link_user: Option<String>,
) -> (String, HeaderValue) {
    let flow_state = hex::encode(rand::thread_rng().gen::<[u8; 32]>());
    {
        let now = now_secs();
        let mut flows = state.steam_flows.write().await;
        flows.retain(|_, f| f.expires_at > now);
        flows.insert(
            flow_state.clone(),
            SteamFlow {
                link_user,
                expires_at: now + FLOW_TTL_SECS,
            },
        );
    }
    let return_to = format!("{base_url}{CALLBACK_PATH}?mode={mode}&state={flow_state}");
    // Lax, not Strict: the callback is a top-level navigation arriving from
    // steamcommunity.com, which a Strict cookie is withheld from.
    let secure = if base_url.starts_with("https://") {
        "; Secure"
    } else {
        ""
    };
    let cookie = HeaderValue::from_str(&format!(
        "{FLOW_COOKIE}={flow_state}; HttpOnly; SameSite=Lax; Path={CALLBACK_PATH}; Max-Age={}{secure}",
        FLOW_TTL_SECS as u64
    ))
    .expect("hex and fixed text make a valid header");
    (build_steam_openid_url(&return_to, base_url), cookie)
}

fn flow_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.split(';').find_map(|part| {
                part.trim()
                    .strip_prefix(FLOW_COOKIE)
                    .and_then(|rest| rest.strip_prefix('='))
                    .map(String::from)
            })
        })
}

/// Check that an OpenID response is an assertion Steam made *for this
/// server*, before asking Steam whether it signed it. Returns the Steam64 id.
///
/// Steam's `is_valid:true` only says Steam signed the response. It says
/// nothing about who it was signed for: any site with a "Sign in through
/// Steam" button collects assertions for its visitors, and replayed here one
/// used to sign the visitor in to their Chatter account. So `return_to` must
/// be this server's callback and its query must be the one this request
/// arrived with (which carries our single-use state), the provider must be
/// Steam, and every one of those fields must be among the signed ones.
fn assertion_for_us(params: &HashMap<String, String>, callback_url: &str) -> Result<String, ()> {
    let get = |k: &str| params.get(k).map(String::as_str).ok_or(());
    if get("openid.mode")? != "id_res" || get("openid.op_endpoint")? != STEAM_OPENID_ENDPOINT {
        return Err(());
    }

    let signed: Vec<&str> = get("openid.signed")?.split(',').collect();
    for field in [
        "op_endpoint",
        "claimed_id",
        "identity",
        "return_to",
        "response_nonce",
    ] {
        if !signed.contains(&field) {
            return Err(());
        }
    }

    let return_to = url::Url::parse(get("openid.return_to")?).map_err(|_| ())?;
    let mut bare = return_to.clone();
    bare.set_query(None);
    bare.set_fragment(None);
    if bare.as_str() != callback_url {
        return Err(());
    }
    // OpenID 2.0 §11.1: every parameter in return_to must be present, with
    // the same value, in the request that arrived.
    for (k, v) in return_to.query_pairs() {
        if params.get(k.as_ref()) != Some(&v.into_owned()) {
            return Err(());
        }
    }

    let claimed_id = get("openid.claimed_id")?;
    if get("openid.identity")? != claimed_id {
        return Err(());
    }
    let steam64 = claimed_id.strip_prefix(STEAM_ID_PREFIX).ok_or(())?;
    if steam64.is_empty() || !steam64.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    steam64.parse::<u64>().map_err(|_| ())?;
    Ok(steam64.to_string())
}

/// Verify an OpenID response: ours (see `assertion_for_us`), and signed by
/// Steam, which only Steam's check_authentication can say. Returns the
/// Steam64 id.
async fn verify_steam_openid(
    params: &HashMap<String, String>,
    callback_url: &str,
) -> Result<String, ()> {
    let steam64 = assertion_for_us(params, callback_url)?;

    // Only the openid.* fields go back to Steam, with the mode swapped.
    let verify_params: Vec<(String, String)> = params
        .iter()
        .filter(|(k, _)| k.starts_with("openid."))
        .map(|(k, v)| {
            let v = if k == "openid.mode" {
                "check_authentication".to_string()
            } else {
                v.clone()
            };
            (k.clone(), v)
        })
        .collect();

    let client = reqwest::Client::new();
    let resp = client
        .post(STEAM_OPENID_ENDPOINT)
        .form(&verify_params)
        .send()
        .await
        .map_err(|_| ())?;

    let body = resp.text().await.map_err(|_| ())?;
    if !body.lines().any(|line| line.trim() == "is_valid:true") {
        return Err(());
    }
    Ok(steam64)
}

async fn store_refresh_token(state: &AppState, token: &str, user_id: &str) {
    use rand::Rng;
    let session_id = hex::encode(rand::thread_rng().gen::<[u8; 16]>());
    let collection = state.db.collection::<RefreshTokenRecord>("refresh_tokens");
    let record = RefreshTokenRecord {
        token: token.to_string(),
        user_id: user_id.to_string(),
        expires_at: chrono::Utc::now() + chrono::Duration::days(7),
        ip_address: "Unknown".to_string(),
        user_agent: "Unknown".to_string(),
        created_at: chrono::Utc::now().timestamp_millis(),
        session_id,
    };
    let _ = collection.insert_one(record).await;
}

/// GET /api/auth/steam/login
/// Redirects the browser to Steam's OpenID login page.
/// Requires SERVER_URL env var set to the public server URL.
pub(crate) async fn steam_login(State(state): State<Arc<AppState>>) -> Response {
    let Some(base_url) = server_url() else {
        return back_to_app("steam_error=not_configured");
    };
    let (steam_url, cookie) = start_flow(&state, &base_url, "login", None).await;
    let mut resp = Redirect::temporary(&steam_url).into_response();
    resp.headers_mut().append(header::SET_COOKIE, cookie);
    resp
}

/// GET /api/steam/link-url (auth required)
/// Returns a Steam OpenID URL the client should navigate to in order to link
/// their Steam account to their existing Chatter account.
///
/// The account travels as a random single-use state held here, not as a
/// token in the URL: the URL goes to Steam and into browser history, and it
/// used to carry a working access token.
pub(crate) async fn steam_link_url(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let base_url = server_url().filter(|_| !state.steam_api_key.is_empty());
    let Some(base_url) = base_url else {
        return Err(error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Steam integration not configured",
        ));
    };

    let (steam_url, cookie) = start_flow(&state, &base_url, "link", Some(user_id)).await;
    let mut resp = Json(json!({ "url": steam_url })).into_response();
    resp.headers_mut().append(header::SET_COOKIE, cookie);
    Ok(resp)
}

/// GET /api/auth/steam/callback
/// Handles the OpenID redirect from Steam. Depending on `mode` query param:
///   - "login": find user by steam_id, redirect to SPA with a one-time code
///   - "link": attach steam_id to the account that started the flow
pub(crate) async fn steam_callback(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let Some(base_url) = server_url() else {
        return back_to_app("steam_error=not_configured");
    };
    let mode = params.get("mode").cloned().unwrap_or_default();

    // The flow must be one this server started, in this browser, and not
    // already finished. Taken out before anything else so it cannot be used
    // twice, whatever happens next.
    let flow_state = params.get("state").cloned().unwrap_or_default();
    let flow = state.steam_flows.write().await.remove(&flow_state);
    let flow = match flow {
        Some(flow)
            if flow.expires_at > now_secs()
                && flow_cookie(&headers).as_deref() == Some(flow_state.as_str())
                && flow.link_user.is_some() == (mode == "link") =>
        {
            flow
        }
        _ => return back_to_app("steam_error=invalid_state"),
    };

    let callback_url = format!("{base_url}{CALLBACK_PATH}");
    let steam64_id = match verify_steam_openid(&params, &callback_url).await {
        Ok(id) => id,
        Err(_) => return back_to_app("steam_error=verification_failed"),
    };

    let users = state.db.collection::<UserRecord>("users");

    if let Some(user_id) = flow.link_user {
        // Ensure no other account already has this Steam ID
        if users
            .find_one(doc! { "steam_id": &steam64_id })
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return back_to_app("steam_error=already_linked");
        }

        let _ = users
            .update_one(
                doc! { "_id": &user_id },
                doc! { "$set": { "steam_id": &steam64_id } },
            )
            .await;

        return back_to_app("steam_linked=true");
    }

    let user = match users
        .find_one(doc! { "steam_id": &steam64_id })
        .await
        .ok()
        .flatten()
    {
        Some(u) => u,
        None => return back_to_app("steam_error=no_account"),
    };

    if user.disabled {
        return back_to_app("steam_error=account_disabled");
    }

    // A one-time code rather than tokens in the URL. Nothing is issued until
    // it is exchanged, which is where two-factor is asked for.
    let code = hex::encode(rand::thread_rng().gen::<[u8; 32]>());
    {
        let now = now_secs();
        let mut codes = state.steam_login_codes.write().await;
        codes.retain(|_, c| c.expires_at > now);
        codes.insert(
            code.clone(),
            SteamLoginCode {
                user_id: user.user_id.clone(),
                expires_at: now + LOGIN_CODE_TTL_SECS,
            },
        );
    }

    back_to_app(&format!("steam_code={code}"))
}

/// POST /api/auth/steam/exchange
/// Exchanges a one-time `steam_code` (from the OpenID callback redirect) for
/// session tokens.
///
/// Signing in through Steam is a different first factor, not a way around the
/// second: an account with two-factor set up answers `{ "requires_totp":
/// true }` until `totp_code` (an authenticator or recovery code) comes with
/// the code. The code is consumed only when tokens are issued, and expires
/// after five minutes.
pub(crate) async fn steam_exchange(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Response, (StatusCode, Json<Value>)> {
    let code = body
        .get("code")
        .and_then(|v| v.as_str())
        .ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Missing code"))?;
    let totp_code = body
        .get("totp_code")
        .and_then(|v| v.as_str())
        .filter(|c| !c.is_empty());

    let record = state.steam_login_codes.read().await.get(code).cloned();
    let record =
        record.ok_or_else(|| error_response(StatusCode::NOT_FOUND, "Invalid or expired code"))?;
    if now_secs() > record.expires_at {
        state.steam_login_codes.write().await.remove(code);
        return Err(error_response(StatusCode::GONE, "Code has expired"));
    }

    let user = state
        .db
        .collection::<UserRecord>("users")
        .find_one(doc! { "_id": &record.user_id })
        .await
        .ok()
        .flatten()
        .filter(|u| !u.disabled)
        .ok_or_else(|| error_response(StatusCode::FORBIDDEN, "Account is unavailable"))?;

    if user.totp_verified && !user.totp_secret.is_empty() {
        let Some(totp_code) = totp_code else {
            return Ok(Json(json!({ "requires_totp": true })).into_response());
        };
        // The same budget as a password sign-in, so going through Steam buys no
        // extra guesses at the code.
        {
            let now = now_secs();
            let mut attempts = state.totp_attempts.write().await;
            let entry =
                attempts
                    .entry(format!("login:{}", user.user_id))
                    .or_insert(TotpAttemptRecord {
                        count: 0,
                        window_start: now,
                    });
            if now - entry.window_start > 300.0 {
                entry.count = 0;
                entry.window_start = now;
            }
            if entry.count >= 10 {
                return Err(error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    "Too many login attempts. Try again in a few minutes.",
                ));
            }
            entry.count += 1;
        }
        let username = user
            .user_id
            .split(':')
            .next()
            .unwrap_or(&user.user_id)
            .trim_start_matches('@')
            .to_string();
        super::auth::verify_totp_or_recovery(totp_code, &user, &username, &state).await?;
    }

    // Removed atomically — of two exchanges racing for one code, one wins.
    if state.steam_login_codes.write().await.remove(code).is_none() {
        return Err(error_response(
            StatusCode::NOT_FOUND,
            "Invalid or expired code",
        ));
    }

    let access_token = create_access_token(&user.user_id, &state.jwt_secret);
    let refresh_token = create_refresh_token(&user.user_id, &state.jwt_secret);
    store_refresh_token(&state, &refresh_token, &user.user_id).await;

    Ok((
        auth_cookie_headers(&access_token, &refresh_token),
        Json(json!({
            "access_token":  access_token,
            "refresh_token": refresh_token,
            "user_id":       user.user_id,
            "is_admin":      user.is_admin,
            "totp_verified": user.totp_verified,
        })),
    )
        .into_response())
}

/// GET /api/steam/status (auth required)
/// Returns the current user's linked Steam ID (null if not linked) and hide_game flag.
pub(crate) async fn steam_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let users = state.db.collection::<UserRecord>("users");
    let user = users
        .find_one(doc! { "_id": &user_id })
        .await
        .ok()
        .flatten()
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "User not found"))?;

    Ok(Json(
        json!({ "steam_id": user.steam_id, "hide_game": user.hide_steam_game }),
    ))
}

/// PUT /api/steam/hide-game (auth required)
/// Toggles whether the user's currently playing game is shown to others.
pub(crate) async fn steam_set_hide_game(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let hide = body.get("hide").and_then(|v| v.as_bool()).unwrap_or(false);

    let users = state.db.collection::<UserRecord>("users");
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$set": { "hide_steam_game": hide } },
        )
        .await;

    // If hiding, clear the game from ephemeral presence immediately
    if hide {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            p.steam_game = None;
            p.desktop_game = None;
        }
    }

    Ok(Json(json!({ "success": true, "hide_game": hide })))
}

/// DELETE /api/steam/unlink (auth required)
/// Removes the Steam ID from the current user's account.
pub(crate) async fn steam_unlink(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let token = extract_token(&headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    let user_id = get_user_from_token(&state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))?;

    let users = state.db.collection::<UserRecord>("users");
    let _ = users
        .update_one(
            doc! { "_id": &user_id },
            doc! { "$unset": { "steam_id": "" } },
        )
        .await;

    // Clear game from ephemeral presence
    {
        let mut up = state.user_presence.write().await;
        if let Some(p) = up.get_mut(&user_id) {
            // The desktop app's report stands without Steam.
            p.steam_game = p.desktop_game.clone();
            p.steam_appid = None;
        }
    }

    Ok(Json(json!({ "success": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALLBACK: &str = "https://chat.example.com/api/auth/steam/callback";

    /// The request Steam sends back after a sign-in this server started.
    fn response(return_to: &str, extra: &[(&str, &str)]) -> HashMap<String, String> {
        let mut params: HashMap<String, String> = [
            ("openid.ns", "http://specs.openid.net/auth/2.0"),
            ("openid.mode", "id_res"),
            ("openid.op_endpoint", STEAM_OPENID_ENDPOINT),
            (
                "openid.claimed_id",
                "https://steamcommunity.com/openid/id/76561197960287930",
            ),
            (
                "openid.identity",
                "https://steamcommunity.com/openid/id/76561197960287930",
            ),
            ("openid.return_to", return_to),
            ("openid.response_nonce", "2026-11-02T10:00:00Zabc"),
            ("openid.assoc_handle", "1234567890"),
            (
                "openid.signed",
                "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
            ),
            ("openid.sig", "c2lnbmF0dXJl"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        for (k, v) in extra {
            params.insert(k.to_string(), v.to_string());
        }
        params
    }

    fn ours() -> HashMap<String, String> {
        response(
            &format!("{CALLBACK}?mode=login&state=abc123"),
            &[("mode", "login"), ("state", "abc123")],
        )
    }

    #[test]
    fn an_assertion_made_for_this_server_is_accepted() {
        assert_eq!(
            assertion_for_us(&ours(), CALLBACK).as_deref(),
            Ok("76561197960287930")
        );
    }

    #[test]
    fn an_assertion_made_for_another_site_is_refused() {
        // What any site with a Steam button holds for each of its visitors.
        let params = response(
            "https://evil.example/steam/return?mode=login&state=abc123",
            &[("mode", "login"), ("state", "abc123")],
        );
        assert!(assertion_for_us(&params, CALLBACK).is_err());
    }

    #[test]
    fn the_request_must_carry_the_state_return_to_names() {
        let mut params = ours();
        params.insert("state".into(), "a-different-flow".into());
        assert!(assertion_for_us(&params, CALLBACK).is_err());
        params.remove("state");
        assert!(assertion_for_us(&params, CALLBACK).is_err());
    }

    #[test]
    fn only_steam_may_vouch_for_a_steam_id() {
        let mut params = ours();
        params.insert(
            "openid.op_endpoint".into(),
            "https://evil.example/openid".into(),
        );
        assert!(assertion_for_us(&params, CALLBACK).is_err());

        let mut params = ours();
        let foreign = "https://evil.example/openid/id/76561197960287930";
        params.insert("openid.claimed_id".into(), foreign.into());
        params.insert("openid.identity".into(), foreign.into());
        assert!(assertion_for_us(&params, CALLBACK).is_err());
    }

    #[test]
    fn the_checked_fields_must_be_signed() {
        let mut params = ours();
        params.insert(
            "openid.signed".into(),
            "signed,op_endpoint,claimed_id,identity,response_nonce".into(),
        );
        assert!(assertion_for_us(&params, CALLBACK).is_err());
    }

    #[test]
    fn a_setup_or_cancel_response_is_not_an_assertion() {
        let mut params = ours();
        params.insert("openid.mode".into(), "cancel".into());
        assert!(assertion_for_us(&params, CALLBACK).is_err());
    }

    #[test]
    fn the_flow_cookie_is_read_by_exact_name() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("steam_flowx=nope; steam_flow=abc123; other=1"),
        );
        assert_eq!(flow_cookie(&headers).as_deref(), Some("abc123"));
    }
}
