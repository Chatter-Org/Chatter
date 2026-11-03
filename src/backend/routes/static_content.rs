use super::super::state::{AppState, InviteRecord, RoomRecord};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Json, Response},
};
use mongodb::bson::doc;
use serde_json::{json, Value};
use std::sync::Arc;

/// The page's Content-Security-Policy, scoped to scripts: where the client's
/// code may come from, so markup that slips into a message cannot run.
///
/// It matters more since DMs became end-to-end encrypted — a script running
/// in the page can read the encryption seed — and it covers only what an
/// injected script would need. Images, media, connections and frames are left
/// alone, because the client legitimately loads those from anywhere (link
/// embeds, GIFs, YouTube, Steam art).
///
/// - `'self'`: the bundle. `'sha256-…'`: the inline theme script in
///   `index.html`, hashed from the file actually served so a rebuild that
///   changes it cannot break the page.
/// - `https://www.gstatic.com`: the Google Cast sender and what it loads.
/// - `'wasm-unsafe-eval'`: the camera and blur models (MediaPipe) are wasm.
/// - `worker-src blob:`: their timer workers are made from blobs.
/// - `blob:` in `script-src`: worklets are checked against `script-src`, and
///   the desktop app builds its screen-share audio worklet from a blob. Only a
///   script already running can make a blob URL, so injected markup gains
///   nothing from it.
fn content_security_policy(html: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let inline = regex::Regex::new(r"(?s)<script>(.*?)</script>").unwrap();
    let hashes: Vec<String> = inline
        .captures_iter(html)
        .map(|c| {
            let digest = Sha256::digest(c[1].as_bytes());
            format!(
                "'sha256-{}'",
                base64::engine::general_purpose::STANDARD.encode(digest)
            )
        })
        .collect();
    format!(
        "script-src 'self' {} https://www.gstatic.com 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'",
        hashes.join(" ")
    )
}

/// The client's page, with its script policy.
fn client_page(html: String) -> Response {
    let policy = content_security_policy(&html);
    ([(header::CONTENT_SECURITY_POLICY, policy)], Html(html)).into_response()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub(crate) async fn serve_client() -> Response {
    let html = tokio::fs::read_to_string("client/dist/index.html")
        .await
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());
    client_page(html)
}

pub(crate) async fn serve_invite_page(
    State(state): State<Arc<AppState>>,
    Path(code): Path<String>,
    headers: HeaderMap,
) -> Response {
    let html = tokio::fs::read_to_string("client/dist/index.html")
        .await
        .unwrap_or_else(|_| "<h1>No client found.</h1>".to_string());

    // Build base URL from request headers so relative icon_url paths become absolute
    let base_url = {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("localhost");
        let is_local = host.starts_with("localhost") || host.starts_with("127.");
        let scheme = if is_local { "http" } else { "https" };
        format!("{}://{}", scheme, host)
    };

    let room_info = async {
        let inv_coll = state.db.collection::<InviteRecord>("invites");
        let invite = inv_coll
            .find_one(doc! { "_id": &code })
            .await
            .ok()
            .flatten()?;
        let rooms_coll = state.db.collection::<RoomRecord>("rooms");
        let room = rooms_coll
            .find_one(doc! { "_id": &invite.room_id })
            .await
            .ok()
            .flatten()?;
        Some((room.name, room.icon_url))
    }
    .await;

    let final_html = if let Some((room_name, icon_url)) = room_info {
        let escaped_name = html_escape(&room_name);
        let title = format!("Join {} on Chatter", escaped_name);
        let description = format!("You've been invited to join {}", escaped_name);
        let page_url = html_escape(&format!("{}/invite/{}", base_url, code));

        let image_tags = if !icon_url.is_empty() {
            // Make relative paths absolute so crawlers (Discord, etc.) can fetch the image
            let abs_url = if icon_url.starts_with('/') {
                format!("{}{}", base_url, icon_url)
            } else {
                icon_url.clone()
            };
            let escaped_url = html_escape(&abs_url);
            format!(
                "    <meta property=\"og:image\" content=\"{}\" />\n    <meta name=\"twitter:image\" content=\"{}\" />\n    <meta name=\"twitter:card\" content=\"summary\" />\n",
                escaped_url, escaped_url
            )
        } else {
            "    <meta name=\"twitter:card\" content=\"summary\" />\n".to_string()
        };

        let og = format!(
            "    <meta property=\"og:title\" content=\"{}\" />\n    <meta property=\"og:description\" content=\"{}\" />\n    <meta property=\"og:type\" content=\"website\" />\n    <meta property=\"og:url\" content=\"{}\" />\n    <meta name=\"twitter:title\" content=\"{}\" />\n    <meta name=\"twitter:description\" content=\"{}\" />\n{}",
            title, description, page_url, title, description, image_tags
        );

        html.replace("</head>", &format!("{}</head>", og))
    } else {
        html
    };

    client_page(final_html)
}

/// Files the browser fetches from the site root by name rather than through
/// the hashed `/assets` bundle: the manifest, the app icons, and the service
/// worker. The worker in particular has to be served from the root or its
/// scope cannot cover the whole app.
///
/// Each is registered under its own literal route rather than a pattern, so
/// the name never comes from the caller and cannot walk out of `client/dist`.
pub(crate) async fn serve_dist_file(name: &str, content_type: &'static str) -> Response {
    match tokio::fs::read(format!("client/dist/{name}")).await {
        Ok(bytes) => (
            [
                (header::CONTENT_TYPE, content_type),
                // These are fetched by a stable name, so a long-lived cached
                // copy would outlive the deploy that changed it.
                (header::CACHE_CONTROL, "no-cache"),
            ],
            bytes,
        )
            .into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

pub(crate) async fn versions() -> Json<Value> {
    Json(json!({
        "versions": ["r0.5.0", "r0.6.0", "r0.6.1"]
    }))
}

pub(crate) async fn build_version() -> Json<Value> {
    Json(json!({ "version": env!("BUILD_TIMESTAMP") }))
}

#[cfg(test)]
mod csp_tests {
    use super::content_security_policy;
    use base64::Engine;
    use sha2::{Digest, Sha256};

    #[test]
    fn allows_the_inline_scripts_it_was_served_with_and_no_others() {
        let html = "<head><script>paint()</script><script src=\"https://www.gstatic.com/cast.js\" async></script></head>";
        let policy = content_security_policy(html);
        let expected = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(b"paint()"));
        assert!(policy.contains(&format!("'sha256-{expected}'")));
        assert!(policy.starts_with("script-src 'self' "));
        assert!(!policy.contains("unsafe-inline"));
        assert!(policy.contains("object-src 'none'"));
        // The desktop app's screen-share audio worklet is loaded from a blob.
        assert!(policy.contains("'wasm-unsafe-eval' blob:;"));
    }
}
