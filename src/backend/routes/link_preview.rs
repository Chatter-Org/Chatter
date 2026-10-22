//! Link previews: the card drawn under a message that links to a web page.
//!
//! `GET /api/link-preview?url=` fetches the page server-side and answers with
//! `{title, description, image, site_name}`, every field optional. A page that
//! yields nothing answers the same shape with every field null, and the
//! clients draw no card — so there is no error a client has to tell apart.
//!
//! Getting a card out of the open web is mostly about not being turned away:
//!
//! - Sites hand Open Graph tags to the crawlers they recognise and challenge
//!   everyone else, so the page is asked for as Discord's crawler, then
//!   Facebook's, then a plain browser, until one gets a real page.
//! - Some sites refuse every crawler but publish oEmbed — Reddit, TikTok,
//!   X/Twitter, Spotify and others. Those are asked through oEmbed first, and
//!   any page that advertises an oEmbed endpoint has it used to fill the gaps.
//! - Only the `<head>` is read, streamed and capped, rather than a whole page
//!   that can be megabytes of script.
//! - One fetch per URL however many clients ask at once: a new message is
//!   seen by everyone in the channel at the same moment, and that many
//!   identical requests is how a site's rate limit gets tripped.
//!
//! Every hop — redirects and oEmbed endpoints included — is resolved once,
//! checked against private addresses and pinned, so a link cannot reach the
//! server's own network (SSRF) or swap its DNS answer between the check and
//! the fetch.

use super::super::{
    dto::LinkPreviewQuery,
    helpers::{error_response, extract_token, get_user_from_token},
    state::{AppState, CachedPreview, PreviewEntry},
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json},
};
use regex::Regex;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

/// How long a preview with something in it is kept.
const HIT_TTL: Duration = Duration::from_secs(12 * 60 * 60);
/// How long "this page gave nothing" is kept: long enough that a channel
/// full of clients does not re-fetch it, short enough that a site that was
/// briefly down gets another chance.
const MISS_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_MAX: usize = 5000;
/// The whole preview, every attempt included.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// Most pages close `</head>` well before this; some (YouTube, shops) put
/// hundreds of kilobytes of inline script ahead of their meta tags.
const MAX_HTML_BYTES: usize = 1536 * 1024;
const MAX_JSON_BYTES: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 10;
const MAX_URL_LEN: usize = 2048;

const UA_DISCORD: &str = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const UA_FACEBOOK: &str =
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const UA_BROWSER: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ACCEPT_HTML: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

impl PreviewEntry {
    fn expired(&self, now: Instant) -> bool {
        match self.cell.get() {
            // In flight: the fetch is bounded by TOTAL_TIMEOUT, so it ends.
            None => false,
            Some(p) if p.has_content() => now.duration_since(self.created) > HIT_TTL,
            Some(_) => now.duration_since(self.created) > MISS_TTL,
        }
    }
}

impl CachedPreview {
    fn has_content(&self) -> bool {
        self.title.is_some() || self.description.is_some() || self.image.is_some()
    }

    /// Fill this preview's missing fields from another.
    fn fill_from(&mut self, other: CachedPreview) {
        if self.title.is_none() {
            self.title = other.title;
        }
        if self.description.is_none() {
            self.description = other.description;
        }
        if self.image.is_none() {
            self.image = other.image;
        }
        if self.site_name.is_none() {
            self.site_name = other.site_name;
        }
    }
}

pub(crate) async fn link_preview(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LinkPreviewQuery>,
) -> impl IntoResponse {
    let token = match extract_token(&headers) {
        Some(t) => t,
        None => return error_response(StatusCode::UNAUTHORIZED, "Missing token"),
    };
    if get_user_from_token(&state, &token).is_none() {
        return error_response(StatusCode::UNAUTHORIZED, "Invalid token");
    }

    let Some(url) = normalize_link(&query.url) else {
        return error_response(StatusCode::BAD_REQUEST, "Invalid URL");
    };
    let key = url.to_string();

    let now = Instant::now();
    let cached = state
        .link_previews
        .read()
        .await
        .get(&key)
        .filter(|e| !e.expired(now))
        .map(|e| e.cell.clone());
    let cell = match cached {
        Some(cell) => cell,
        None => {
            let mut cache = state.link_previews.write().await;
            // Someone else may have started it between the two locks.
            match cache.get(&key).filter(|e| !e.expired(now)) {
                Some(e) => e.cell.clone(),
                None => {
                    if cache.len() >= CACHE_MAX {
                        evict(&mut cache, now);
                    }
                    let cell = Arc::new(tokio::sync::OnceCell::new());
                    cache.insert(
                        key,
                        PreviewEntry {
                            created: now,
                            cell: cell.clone(),
                        },
                    );
                    cell
                }
            }
        }
    };

    let preview = cell
        .get_or_init(|| async {
            tokio::time::timeout(TOTAL_TIMEOUT, fetch_preview(&url))
                .await
                .unwrap_or_default()
        })
        .await;

    (
        StatusCode::OK,
        Json(serde_json::to_value(preview).unwrap_or_default()),
    )
}

/// Make room in a full cache: drop what has expired, then the oldest quarter
/// of what is left. In-flight entries stay, or their waiters would be orphaned
/// and a second fetch started.
fn evict(cache: &mut HashMap<String, PreviewEntry>, now: Instant) {
    cache.retain(|_, e| !e.expired(now));
    if cache.len() < CACHE_MAX * 3 / 4 {
        return;
    }
    let mut done: Vec<(Instant, String)> = cache
        .iter()
        .filter(|(_, e)| e.cell.initialized())
        .map(|(k, e)| (e.created, k.clone()))
        .collect();
    done.sort();
    for (_, k) in done.into_iter().take(CACHE_MAX / 4) {
        cache.remove(&k);
    }
}

/// The link as the server should fetch it, or None if it is not one.
///
/// Clients pick links out of a message by "everything up to whitespace", so
/// a link written in prose arrives carrying its punctuation: `(https://a.b/c).`
/// A closing bracket is kept when it closes one inside the link, as in
/// Wikipedia's `/wiki/Rust_(programming_language)`. The fragment is dropped:
/// it never reaches the site, and keeping it would cache one page many times.
pub(crate) fn normalize_link(raw: &str) -> Option<url::Url> {
    let mut s = raw.trim().trim_start_matches(['<', '(', '[', '"', '\'']);
    loop {
        let before = s.len();
        s = s.trim_end_matches(['.', ',', ';', ':', '!', '?', '"', '\'', '*', '_', '~', '>']);
        for (open, close) in [('(', ')'), ('[', ']')] {
            if s.ends_with(close) && s.matches(close).count() > s.matches(open).count() {
                s = &s[..s.len() - 1];
            }
        }
        if s.len() == before {
            break;
        }
    }
    if s.is_empty() || s.len() > MAX_URL_LEN {
        return None;
    }
    let mut url = url::Url::parse(s).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return None;
    }
    url.set_fragment(None);
    Some(url)
}

async fn fetch_preview(url: &url::Url) -> CachedPreview {
    // A site that refuses crawlers but speaks oEmbed is asked that way first.
    let mut preview = match known_oembed_endpoint(url) {
        Some(endpoint) => fetch_oembed(&endpoint, is_twitter(url)).await,
        None => CachedPreview::default(),
    };
    if preview.title.is_some() {
        return finish(preview, url);
    }

    let mut discovered = None;
    if let Some((page, oembed)) = fetch_page(url).await {
        preview.fill_from(page);
        discovered = oembed;
    }
    if preview.title.is_none() || preview.image.is_none() {
        if let Some(endpoint) = discovered {
            preview.fill_from(fetch_oembed(&endpoint, false).await);
        }
    }
    finish(preview, url)
}

/// The last touches every preview gets: a site name if nothing gave one.
fn finish(mut preview: CachedPreview, url: &url::Url) -> CachedPreview {
    if preview.has_content() && preview.site_name.is_none() {
        preview.site_name = url
            .host_str()
            .map(|h| h.strip_prefix("www.").unwrap_or(h).to_string());
    }
    preview
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/// The page's preview and the oEmbed endpoint it advertises, if any.
///
/// Each user agent is tried in turn until one is answered with a page that
/// says something — not an error, and not a bot challenge dressed as a page.
async fn fetch_page(url: &url::Url) -> Option<(CachedPreview, Option<String>)> {
    for ua in [UA_DISCORD, UA_FACEBOOK, UA_BROWSER] {
        let Ok((resp, final_url)) = safe_fetch(url, ua, ACCEPT_HTML).await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();

        // A direct link to an image that has no image extension (so the
        // client did not draw it itself): the image is the preview.
        if content_type.starts_with("image/") {
            return Some((
                CachedPreview {
                    image: Some(final_url.to_string()),
                    ..Default::default()
                },
                None,
            ));
        }
        let is_html = content_type.is_empty()
            || content_type.contains("text/html")
            || content_type.contains("application/xhtml");
        if !is_html {
            // A PDF, a JSON API, a download: no other agent will change that.
            return None;
        }

        let bytes = read_head(resp).await;
        let html = decode_html(&bytes, &content_type);
        let page = parse_page(&html, &final_url);
        if page.blocked || (page.preview.title.is_none() && page.preview.image.is_none()) {
            continue;
        }
        return Some((page.preview, page.oembed));
    }
    None
}

/// Read until `</head>` or the cap, whichever comes first.
async fn read_head(mut resp: reqwest::Response) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        // Look back a few bytes so a `</head` split across chunks is found.
        let search_from = buf.len().saturating_sub(6);
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_HTML_BYTES {
            buf.truncate(MAX_HTML_BYTES);
            break;
        }
        if buf[search_from..]
            .windows(6)
            .any(|w| w.eq_ignore_ascii_case(b"</head"))
        {
            break;
        }
    }
    buf
}

/// Decode a page by its declared charset: the header's, else the page's own
/// `<meta charset>`, else UTF-8 (which also covers a byte-order mark).
fn decode_html(bytes: &[u8], content_type: &str) -> String {
    let from_header = content_type
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("charset="))
        .next()
        .map(|cs| cs.trim_matches(['"', '\'']).to_string());
    let declared = from_header.or_else(|| {
        // The declaration must be in the first 1024 bytes by the spec; a
        // little more leeway costs nothing.
        let start = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).into_owned();
        meta_charset(&start)
    });
    let encoding = declared
        .and_then(|label| encoding_rs::Encoding::for_label(label.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned()
}

fn meta_charset(html: &str) -> Option<String> {
    for tag in META_TAG.find_iter(html) {
        let attrs = parse_attrs(tag.as_str());
        if let Some(cs) = attrs.get("charset") {
            return Some(cs.clone());
        }
        let is_content_type = attrs
            .get("http-equiv")
            .is_some_and(|v| v.eq_ignore_ascii_case("content-type"));
        if is_content_type {
            let content = attrs.get("content").map(|c| c.to_ascii_lowercase());
            let cs = content
                .as_deref()
                .and_then(|c| c.split("charset=").nth(1))
                .and_then(|c| c.split(';').next())
                .map(str::trim)
                .unwrap_or_default();
            if !cs.is_empty() {
                return Some(cs.to_string());
            }
        }
    }
    None
}

static COMMENT_OR_SCRIPT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<!--.*?-->|<script\b.*?</script\s*>|<style\b.*?</style\s*>").unwrap()
});
/// A tag, with `>` allowed inside quoted attribute values — descriptions
/// contain them, and a tag cut short there loses its `content`.
static META_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>"#).unwrap());
static LINK_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)<link\b(?:[^>"']|"[^"]*"|'[^']*')*>"#).unwrap());
static ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#)
        .unwrap()
});
static TITLE_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title\s*>").unwrap());
static ANY_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]*>").unwrap());
static BR_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
static NUMERIC_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#([xX]?)([0-9a-fA-F]+);").unwrap());

/// A tag's attributes, names lowercased, values entity-decoded and trimmed.
fn parse_attrs(tag: &str) -> HashMap<String, String> {
    let mut attrs = HashMap::new();
    for caps in ATTR.captures_iter(tag) {
        let value = caps
            .get(2)
            .or_else(|| caps.get(3))
            .or_else(|| caps.get(4))
            .map_or("", |m| m.as_str());
        attrs
            .entry(caps[1].to_ascii_lowercase())
            .or_insert_with(|| decode_html_entities(value.trim()));
    }
    attrs
}

struct ParsedPage {
    preview: CachedPreview,
    oembed: Option<String>,
    /// The page is a bot challenge or an error page, not the one linked.
    blocked: bool,
}

fn parse_page(html: &str, page_url: &url::Url) -> ParsedPage {
    let html = COMMENT_OR_SCRIPT.replace_all(html, " ");

    // key (property / name / itemprop, lowercased) -> content; first wins.
    let mut meta: HashMap<String, String> = HashMap::new();
    for tag in META_TAG.find_iter(&html) {
        let attrs = parse_attrs(tag.as_str());
        let Some(content) = attrs.get("content").filter(|c| !c.is_empty()) else {
            continue;
        };
        for key_attr in ["property", "name", "itemprop"] {
            if let Some(key) = attrs.get(key_attr) {
                meta.entry(key.to_ascii_lowercase())
                    .or_insert_with(|| content.clone());
            }
        }
    }
    let first = |keys: &[&str]| keys.iter().find_map(|k| meta.get(*k).cloned());

    let mut image_src = None;
    let mut oembed = None;
    for tag in LINK_TAG.find_iter(&html) {
        let attrs = parse_attrs(tag.as_str());
        let (Some(rel), Some(href)) = (attrs.get("rel"), attrs.get("href")) else {
            continue;
        };
        let rel = rel.to_ascii_lowercase();
        let kind = attrs.get("type").map(|t| t.to_ascii_lowercase());
        if rel == "image_src" && image_src.is_none() {
            image_src = Some(href.clone());
        }
        if rel.split_whitespace().any(|r| r == "alternate")
            && kind.as_deref() == Some("application/json+oembed")
            && oembed.is_none()
        {
            oembed = page_url.join(href).ok().map(|u| u.to_string());
        }
    }

    let og_title = first(&["og:title", "twitter:title"]);
    let title_tag = TITLE_TAG
        .captures(&html)
        .map(|c| decode_html_entities(&ANY_TAG.replace_all(&c[1], "")));
    let blocked = og_title.is_none() && title_tag.as_deref().is_some_and(looks_like_challenge);

    let title = og_title
        .or_else(|| first(&["title", "dc.title"]))
        .or(title_tag)
        .and_then(|t| clip(&t, 300));
    let description = first(&[
        "og:description",
        "twitter:description",
        "description",
        "dc.description",
    ])
    .and_then(|d| clip(&d, 500));
    let image = first(&[
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
        "twitter:image:src",
        "thumbnail",
        "image",
    ])
    .or(image_src)
    // Relative to where the page ended up, not to the link that led there.
    .and_then(|img| page_url.join(img.trim()).ok())
    .filter(|u| matches!(u.scheme(), "http" | "https"))
    .map(|u| u.to_string());
    let site_name = first(&[
        "og:site_name",
        "application-name",
        "al:android:app_name",
        "al:ios:app_name",
        "twitter:site",
    ])
    .and_then(|s| clip(&s, 100));

    ParsedPage {
        preview: CachedPreview {
            title,
            description,
            image,
            site_name,
        },
        oembed,
        blocked,
    }
}

/// The titles of the interstitials served instead of a page to a client the
/// site does not trust. Previewing one would show "Just a moment..." as if
/// it were what was linked.
fn looks_like_challenge(title: &str) -> bool {
    let t = title.to_lowercase();
    [
        "just a moment",
        "attention required",
        "access denied",
        "403 forbidden",
        "are you a robot",
        "robot check",
        "captcha",
        "verify you are human",
        "verifying you are human",
        "security check",
        "ddos-guard",
        "please enable javascript",
        "please wait while",
    ]
    .iter()
    .any(|p| t.contains(p))
}

// ---------------------------------------------------------------------------
// oEmbed
// ---------------------------------------------------------------------------

fn host_is(url: &url::Url, domain: &str) -> bool {
    url.host_str().is_some_and(|h| {
        let h = h.to_ascii_lowercase();
        h == domain || h.ends_with(&format!(".{domain}"))
    })
}

fn is_twitter(url: &url::Url) -> bool {
    host_is(url, "twitter.com") || host_is(url, "x.com")
}

/// The oEmbed endpoint for sites known to refuse crawlers or to say more
/// through oEmbed than through their pages.
fn known_oembed_endpoint(url: &url::Url) -> Option<String> {
    let enc = |u: &str| urlencoding::encode(u).into_owned();
    if is_twitter(url) {
        if !url.path().contains("/status/") {
            return None;
        }
        // The endpoint knows tweets by their twitter.com address, whichever
        // host the link used.
        let tweet = format!("https://twitter.com{}", url.path());
        return Some(format!(
            "https://publish.x.com/oembed?url={}&omit_script=true&dnt=true",
            enc(&tweet)
        ));
    }
    let link = url.as_str();
    let endpoint = if host_is(url, "reddit.com") || host_is(url, "redd.it") {
        "https://www.reddit.com/oembed?url="
    } else if host_is(url, "tiktok.com") {
        "https://www.tiktok.com/oembed?url="
    } else if host_is(url, "vimeo.com") {
        "https://vimeo.com/api/oembed.json?url="
    } else if host_is(url, "open.spotify.com") {
        "https://open.spotify.com/oembed?url="
    } else if host_is(url, "soundcloud.com") {
        "https://soundcloud.com/oembed?format=json&url="
    } else if host_is(url, "youtube.com") || host_is(url, "youtu.be") {
        "https://www.youtube.com/oembed?format=json&url="
    } else if host_is(url, "flickr.com") || host_is(url, "flic.kr") {
        "https://www.flickr.com/services/oembed?format=json&url="
    } else {
        return None;
    };
    Some(format!("{endpoint}{}", enc(link)))
}

async fn fetch_oembed(endpoint: &str, tweet: bool) -> CachedPreview {
    let Ok(endpoint) = url::Url::parse(endpoint) else {
        return CachedPreview::default();
    };
    let Ok((resp, _)) = safe_fetch(&endpoint, UA_DISCORD, "application/json").await else {
        return CachedPreview::default();
    };
    if !resp.status().is_success() {
        return CachedPreview::default();
    }
    let bytes = read_capped(resp, MAX_JSON_BYTES).await;
    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return CachedPreview::default();
    };
    let field = |k: &str| {
        json[k]
            .as_str()
            .map(decode_html_entities)
            .and_then(|s| clip(&s, 300))
    };

    if tweet {
        // The tweet's text is only in the embed HTML: its first paragraph.
        let description = json["html"].as_str().and_then(|h| {
            let start = h.find("<p")?;
            let end = h[start..].find("</p>").map_or(h.len(), |e| start + e);
            let text = BR_TAG.replace_all(&h[start..end], "\n");
            let text = ANY_TAG.replace_all(&text, "");
            clip(&decode_html_entities(&text), 500)
        });
        return CachedPreview {
            title: field("author_name"),
            description,
            image: None,
            site_name: Some("X".to_string()),
        };
    }

    let image = json["thumbnail_url"]
        .as_str()
        .and_then(|u| url::Url::parse(u).ok())
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .map(|u| u.to_string());
    let author = field("author_name");
    CachedPreview {
        title: field("title").or_else(|| author.clone()),
        description: author.filter(|_| json["title"].is_string()),
        image,
        site_name: field("provider_name"),
    }
}

async fn read_capped(mut resp: reqwest::Response, cap: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        buf.extend_from_slice(&chunk);
        if buf.len() > cap {
            return Vec::new();
        }
    }
    buf
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/// Text for display: collapse whitespace and cut to `max` characters; None if
/// nothing is left. Entities are decoded once more here, since plenty of
/// sites escape their meta content twice (`&amp;quot;`), and what comes out
/// is drawn as text, never as markup.
fn clip(s: &str, max: usize) -> Option<String> {
    let s = decode_html_entities(s);
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    if s.chars().count() <= max {
        return Some(s);
    }
    let cut: String = s.chars().take(max - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// Decode the HTML entities found in titles and descriptions, numeric ones
/// included.
fn decode_html_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let named = s
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&mdash;", "\u{2014}")
        .replace("&ndash;", "\u{2013}")
        .replace("&laquo;", "\u{00AB}")
        .replace("&raquo;", "\u{00BB}")
        .replace("&hellip;", "\u{2026}")
        .replace("&rsquo;", "\u{2019}")
        .replace("&lsquo;", "\u{2018}")
        .replace("&rdquo;", "\u{201D}")
        .replace("&ldquo;", "\u{201C}")
        .replace("&middot;", "\u{00B7}")
        .replace("&bull;", "\u{2022}")
        .replace("&copy;", "\u{00A9}")
        .replace("&reg;", "\u{00AE}")
        .replace("&trade;", "\u{2122}");
    let numeric = NUMERIC_ENTITY.replace_all(&named, |caps: &regex::Captures| {
        let code = if caps[1].is_empty() {
            caps[2].parse::<u32>().ok()
        } else {
            u32::from_str_radix(&caps[2], 16).ok()
        };
        code.and_then(char::from_u32)
            .map(|c| c.to_string())
            .unwrap_or_else(|| caps[0].to_string())
    });
    // Last, so "&amp;lt;" stays "&lt;" rather than becoming "<".
    numeric.replace("&amp;", "&")
}

// ---------------------------------------------------------------------------
// Fetching safely
// ---------------------------------------------------------------------------

/// True if the address is private, loopback, link-local or otherwise
/// reserved — somewhere a server-side fetch must never be pointed.
fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()          // 127.0.0.0/8
            || v4.is_private()        // 10/8, 172.16/12, 192.168/16
            || v4.is_link_local()     // 169.254/16
            || v4.is_broadcast()      // 255.255.255.255
            || v4.is_unspecified()    // 0.0.0.0
            || v4.is_multicast()      // 224/4
            || o[0] == 0              // 0/8
            || o[0] >= 240            // 240/4 (reserved)
            || o[0] == 100 && (o[1] & 0xC0) == 64  // 100.64/10 (CGNAT)
            || o[0] == 192 && o[1] == 0 && o[2] == 0 // 192.0.0/24 (IETF)
            || o[0] == 198 && (o[1] == 18 || o[1] == 19) // 198.18/15 (benchmark)
        }
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            v6.is_loopback()          // ::1
            || v6.is_unspecified()    // ::
            || v6.is_multicast()      // ff00::/8
            || (segments[0] & 0xFE00) == 0xFC00 // fc00::/7 (unique local)
            || (segments[0] & 0xFFC0) == 0xFE80 // fe80::/10 (link-local)
            // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64): the
            // embedded v4 address is where it really goes.
            || matches!(v6.to_ipv4_mapped(), Some(v4) if is_private_ip(&IpAddr::V4(v4)))
            || (segments[..6] == [0x64, 0xff9b, 0, 0, 0, 0] && {
                let [a, b] = segments[6].to_be_bytes();
                let [c, d] = segments[7].to_be_bytes();
                is_private_ip(&IpAddr::V4(std::net::Ipv4Addr::new(a, b, c, d)))
            })
        }
    }
}

/// Resolve a URL's host and check every address it gives; the addresses are
/// returned so the fetch can be pinned to exactly them (no DNS rebinding).
async fn resolve_public(url: &url::Url) -> Result<Vec<SocketAddr>, &'static str> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP(S) URLs are allowed");
    }
    let port = url.port_or_known_default().ok_or("URL has no port")?;
    let addrs: Vec<SocketAddr> = match url.host().ok_or("URL has no host")? {
        url::Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        url::Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        url::Host::Domain(domain) => tokio::net::lookup_host((domain, port))
            .await
            .map_err(|_| "Could not resolve hostname")?
            .collect(),
    };
    // IPv4 first: a server without an IPv6 route otherwise waits out a
    // connect timeout before it gets to an address it can reach.
    let mut addrs = addrs;
    addrs.sort_by_key(|a| a.is_ipv6());
    if addrs.is_empty() {
        return Err("Hostname resolved to no addresses");
    }
    if addrs.iter().any(|a| is_private_ip(&a.ip())) {
        return Err("URL resolves to a private/internal IP address");
    }
    Ok(addrs)
}

/// GET a URL, following redirects by hand so each hop is checked and pinned
/// like the first. Cookies set along the way are sent back to the host that
/// set them, since some sites redirect through a cookie check before they
/// serve anything. Returns the response and the URL it finally came from.
async fn safe_fetch(
    url: &url::Url,
    ua: &str,
    accept: &str,
) -> Result<(reqwest::Response, url::Url), String> {
    let mut current = url.clone();
    let mut cookies: HashMap<String, Vec<String>> = HashMap::new();

    for _ in 0..=MAX_REDIRECTS {
        let addrs = resolve_public(&current).await?;
        let host = current.host_str().unwrap_or_default().to_string();

        let mut builder = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .gzip(true)
            .brotli(true)
            .deflate(true);
        if matches!(current.host(), Some(url::Host::Domain(_))) {
            // All of them in one call: `resolve` replaces rather than adds,
            // so calling it per address pinned the host to whichever came
            // last — often an IPv6 address on a server with no IPv6 route.
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
        let client = builder.build().map_err(|e| e.to_string())?;

        let mut request = client
            .get(current.as_str())
            .header("User-Agent", ua)
            .header("Accept", accept)
            .header("Accept-Language", "en-US,en;q=0.9");
        if let Some(jar) = cookies.get(&host) {
            request = request.header("Cookie", jar.join("; "));
        }
        let resp = request.send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_redirection() {
            return Ok((resp, current));
        }
        for set in resp.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Some(pair) = set.to_str().ok().and_then(|s| s.split(';').next()) {
                let jar = cookies.entry(host.clone()).or_default();
                let name = pair.split('=').next().unwrap_or_default();
                jar.retain(|c| c.split('=').next() != Some(name));
                jar.push(pair.trim().to_string());
            }
        }
        let Some(location) = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
        else {
            return Ok((resp, current));
        };
        // Relative in every form — "/a", "a", "?q", "//host/a" — against
        // where we are now.
        current = current.join(location).map_err(|e| e.to_string())?;
        current.set_fragment(None);
    }
    Err("Too many redirects".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> url::Url {
        url::Url::parse(s).unwrap()
    }

    #[test]
    fn normalize_strips_prose_punctuation() {
        let n = |s: &str| normalize_link(s).map(|u| u.to_string());
        assert_eq!(n("https://a.com/b)."), Some("https://a.com/b".into()));
        assert_eq!(n("<https://a.com/b>"), Some("https://a.com/b".into()));
        assert_eq!(n("https://a.com/b#frag"), Some("https://a.com/b".into()));
        assert_eq!(
            n("https://en.wikipedia.org/wiki/Rust_(programming_language)"),
            Some("https://en.wikipedia.org/wiki/Rust_(programming_language)".into())
        );
        assert_eq!(
            n("(https://en.wikipedia.org/wiki/Rust_(programming_language))!"),
            Some("https://en.wikipedia.org/wiki/Rust_(programming_language)".into())
        );
        assert_eq!(n("ftp://a.com/"), None);
        assert_eq!(n("javascript:alert(1)"), None);
    }

    #[test]
    fn twitter_is_matched_by_host_not_substring() {
        assert!(is_twitter(&url("https://x.com/a/status/1")));
        assert!(is_twitter(&url("https://mobile.twitter.com/a/status/1")));
        assert!(!is_twitter(&url("https://www.netflix.com/title/1")));
        assert!(!is_twitter(&url("https://dropbox.com/s/abc")));
        assert!(known_oembed_endpoint(&url("https://netflix.com/x")).is_none());
    }

    #[test]
    fn parses_og_tags_with_awkward_markup() {
        let html = r#"<html><head>
            <!-- <meta property="og:title" content="commented out"> -->
            <script>var s = '<meta property="og:title" content="in script">';</script>
            <meta
              content="A &gt; B &amp; C"
              property="og:title">
            <meta name=description content='Say "hi" > there'>
            <meta property="og:image" content="/img/card.png">
            <link rel="alternate" type="application/json+oembed" href="/oembed?x=1">
            <title>Fallback</title>
        </head><body></body></html>"#;
        let page = parse_page(html, &url("https://site.com/post/1"));
        assert_eq!(page.preview.title.as_deref(), Some("A > B & C"));
        assert_eq!(
            page.preview.description.as_deref(),
            Some("Say \"hi\" > there")
        );
        assert_eq!(
            page.preview.image.as_deref(),
            Some("https://site.com/img/card.png")
        );
        assert_eq!(page.oembed.as_deref(), Some("https://site.com/oembed?x=1"));
        assert!(!page.blocked);
    }

    #[test]
    fn falls_back_to_title_tag_and_spots_challenges() {
        let page = parse_page(
            "<head><title>  My\n  Page </title></head>",
            &url("https://a.com/"),
        );
        assert_eq!(page.preview.title.as_deref(), Some("My Page"));
        assert!(!page.blocked);

        let page = parse_page(
            "<head><title>Just a moment...</title></head>",
            &url("https://a.com/"),
        );
        assert!(page.blocked);
    }

    #[test]
    fn decodes_declared_charsets() {
        // "café" in windows-1252
        let bytes = b"<head><meta charset=\"windows-1252\"><title>caf\xe9</title></head>";
        let html = decode_html(bytes, "text/html");
        assert!(html.contains("café"));
        // Shift_JIS from the header: "日本"
        let html = decode_html(b"\x93\xfa\x96\x7b", "text/html; charset=shift_jis");
        assert_eq!(html, "日本");
    }

    #[test]
    fn clip_respects_char_boundaries() {
        let long = "é".repeat(400);
        let clipped = clip(&long, 300).unwrap();
        assert_eq!(clipped.chars().count(), 300);
        assert!(clipped.ends_with('…'));
        assert_eq!(clip("   ", 10), None);
        assert_eq!(
            clip("The &quot;Perpetual&quot;", 50).as_deref(),
            Some("The \"Perpetual\"")
        );
    }

    #[test]
    fn entities_decode_once() {
        assert_eq!(
            decode_html_entities("&amp;lt; &#39;x&#x27; &lt;"),
            "&lt; 'x' <"
        );
    }

    #[test]
    fn private_addresses_are_refused() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "169.254.169.254",
            "0.1.2.3",
            "::1",
            "fd00::1",
            "::ffff:192.168.1.1",
            "64:ff9b::a00:1",
        ] {
            assert!(is_private_ip(&ip.parse().unwrap()), "{ip}");
        }
        assert!(!is_private_ip(&"93.184.216.34".parse().unwrap()));
    }
}
