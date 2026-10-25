//! What holds a member back from taking part in a room: a timeout, rules
//! they have not yet accepted, or automod refusing a message.
//!
//! Both are applied inside `effective_permissions` and `channel_permissions`
//! (see helpers.rs) by switching off the participating permissions, so every
//! check already written against those — forum posts, polls, reactions, voice
//! — enforces them without knowing they exist. `participation_refusal` is the
//! same answer with a reason attached, for the handlers where the person needs
//! to be told *why*, not just "no permission".

use super::{
    helpers::now_millis,
    state::{
        AppState, AutomodSettings, MemberTimeoutRecord, RolePermissions, RoomMemberRecord,
        RoomRecord,
    },
};
use axum::{http::StatusCode, response::Json};
use mongodb::bson::doc;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

/// The longest a timeout can run: four weeks, as Discord allows. Past that a
/// ban says what is meant.
pub(crate) const MAX_TIMEOUT_SECS: i64 = 28 * 24 * 60 * 60;

/// What is currently holding a member back. Both clear on their own: a timeout
/// by its end passing, the rules gate by accepting.
#[derive(Clone, Copy, Default)]
pub(crate) struct Restriction {
    /// Epoch ms the timeout ends, or 0 when there is none in force.
    pub(crate) timeout_until: i64,
    pub(crate) rules_pending: bool,
}

impl Restriction {
    pub(crate) fn is_restricted(&self) -> bool {
        self.timeout_until > 0 || self.rules_pending
    }

    pub(crate) fn to_json(self) -> Value {
        json!({
            "timeout_until": self.timeout_until,
            "rules_pending": self.rules_pending,
        })
    }
}

/// Whether the room's rules have to be accepted before taking part. A gate
/// with no rules behind it would hold people at an empty page, so it is off
/// until there is something to read.
pub(crate) fn rules_gate_active(room: &RoomRecord) -> bool {
    !room.is_dm && room.moderation.rules_required && !room.moderation.rules.trim().is_empty()
}

/// What holds `user_id` back in `room`. An owner is never held, and the rules
/// gate does not apply to moderators — they enforce the rules, and a room that
/// turns the gate on must not lock out the people who run it.
pub(crate) async fn member_restriction(
    state: &AppState,
    room: &RoomRecord,
    user_id: &str,
    role: &str,
) -> Restriction {
    if room.is_dm || role == "owner" {
        return Restriction::default();
    }
    let timeout_until = state
        .db
        .collection::<MemberTimeoutRecord>("member_timeouts")
        .find_one(doc! { "_id": MemberTimeoutRecord::key(&room.room_id, user_id) })
        .await
        .ok()
        .flatten()
        .map(|t| t.until)
        .filter(|until| *until > now_millis())
        .unwrap_or(0);
    // Only asked when the gate is on: most rooms never turn it on, and this
    // runs on every permission check.
    let rules_pending = role != "moderator"
        && rules_gate_active(room)
        && state
            .db
            .collection::<RoomMemberRecord>("room_members")
            .find_one(doc! { "room_id": &room.room_id, "user_id": user_id })
            .await
            .ok()
            .flatten()
            .is_some_and(|m| m.rules_accepted_at == 0);
    Restriction {
        timeout_until,
        rules_pending,
    }
}

/// Switch off everything that is taking part rather than watching. Reading,
/// and anything a moderator's own permissions grant, are left alone.
pub(crate) fn apply_restriction(perms: &mut RolePermissions, restriction: &Restriction) {
    if restriction.is_restricted() {
        perms.send_messages = false;
        perms.attach_files = false;
        perms.add_reactions = false;
        perms.connect = false;
        perms.speak = false;
    }
}

/// The refusal for a restricted member, naming the reason so the client can
/// say it: `code` is `timed_out` or `rules_pending`.
pub(crate) fn restriction_refusal(restriction: &Restriction) -> Option<(StatusCode, Json<Value>)> {
    if restriction.timeout_until > 0 {
        return Some((
            StatusCode::FORBIDDEN,
            Json(json!({
                "errcode": "M_FORBIDDEN",
                "error": "You are timed out in this room",
                "code": "timed_out",
                "timeout_until": restriction.timeout_until,
            })),
        ));
    }
    if restriction.rules_pending {
        return Some((
            StatusCode::FORBIDDEN,
            Json(json!({
                "errcode": "M_FORBIDDEN",
                "error": "Accept this room's rules before taking part",
                "code": "rules_pending",
            })),
        ));
    }
    None
}

/// `restriction_refusal` for a member of `room_id`, looked up from scratch.
/// For handlers that act before the permission checks and want the reason.
pub(crate) async fn participation_refusal(
    state: &AppState,
    room_id: &str,
    user_id: &str,
) -> Option<(StatusCode, Json<Value>)> {
    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()?;
    let role = super::helpers::get_user_role(state, room_id, user_id).await;
    restriction_refusal(&member_restriction(state, &room, user_id, &role).await)
}

/// What members are told about the room's moderation. The automod word list
/// is left out: it is a list of things not to say, and publishing it hands
/// over the list of what to misspell.
pub(crate) fn public_view(room: &RoomRecord) -> Value {
    json!({
        "rules": room.moderation.rules,
        "rules_required": rules_gate_active(room),
        "reports_enabled": room.moderation.reports_enabled,
    })
}

// ─── Automod ─────────────────────────────────────────────────────────────────

/// Which automod filter refused a message. The name is what the audit log
/// records and the client shows — never the message, never the word.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AutomodRule {
    BlockedWord,
    Link,
    Invite,
    Mentions,
    Repeat,
}

impl AutomodRule {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BlockedWord => "blocked_word",
            Self::Link => "link",
            Self::Invite => "invite",
            Self::Mentions => "mentions",
            Self::Repeat => "repeat",
        }
    }

    fn describe(self) -> &'static str {
        match self {
            Self::BlockedWord => "it contains a blocked word",
            Self::Link => "links are not allowed here",
            Self::Invite => "invite links are not allowed here",
            Self::Mentions => "it mentions too many people",
            Self::Repeat => "you just sent the same message",
        }
    }
}

/// Web addresses: a scheme or `www.`, or a bare domain on a common TLD — the
/// way spam actually writes them.
static LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(?:https?://|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|co|me|ly|xyz|ru|tk|app|dev|link|info|biz|site|online|shop|top|club)\b(?:/\S*)?",
    )
    .unwrap()
});

/// Invites: any Chatter instance's `/invite/CODE`, and Discord's.
static INVITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)/invite/[a-z0-9]{4,}|\bdiscord(?:app)?\.com/invite/|\bdiscord\.gg/").unwrap()
});

/// An `@name` token, as the client reads a mention: not the middle of an
/// email address.
static MENTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.\-]+)").unwrap());

/// Lowercase, with every run of anything that is not a letter or digit made a
/// single space, and a space at each end — so a word is always ` word `.
fn normalize_words(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push(' ');
    let mut last_space = true;
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
            last_space = false;
        } else if !last_space {
            out.push(' ');
            last_space = true;
        }
    }
    if !last_space {
        out.push(' ');
    }
    out
}

fn contains_blocked_word(normalized: &str, words: &[String]) -> bool {
    words.iter().any(|entry| {
        let (stem, prefix) = match entry.strip_suffix('*') {
            Some(stem) => (stem, true),
            None => (entry.as_str(), false),
        };
        let stem = normalize_words(stem);
        let stem = stem.trim();
        if stem.is_empty() {
            return false;
        }
        if prefix {
            normalized.contains(&format!(" {stem}"))
        } else {
            normalized.contains(&format!(" {stem} "))
        }
    })
}

/// What in `body` this room's automod refuses, checked in the order a
/// moderator would care about. `None` is a message it lets through.
///
/// The repeat check needs the sender's recent messages and is made by the
/// caller (`automod_refusal`); this is everything decidable from the text.
pub(crate) fn automod_verdict(settings: &AutomodSettings, body: &str) -> Option<AutomodRule> {
    if !settings.enabled {
        return None;
    }
    // This instance's own attachments are paths, not links anyone typed.
    let text: String = body
        .split_whitespace()
        .filter(|t| !t.contains("/external/"))
        .collect::<Vec<_>>()
        .join(" ");
    if !settings.blocked_words.is_empty()
        && contains_blocked_word(&normalize_words(&text), &settings.blocked_words)
    {
        return Some(AutomodRule::BlockedWord);
    }
    if settings.block_invites && INVITE.is_match(&text) {
        return Some(AutomodRule::Invite);
    }
    if settings.block_links && LINK.is_match(&text) {
        return Some(AutomodRule::Link);
    }
    if settings.max_mentions > 0 {
        let mut names: Vec<String> = MENTION
            .captures_iter(&text)
            .map(|c| c[1].to_lowercase())
            .collect();
        names.sort_unstable();
        names.dedup();
        if names.len() > settings.max_mentions as usize {
            return Some(AutomodRule::Mentions);
        }
    }
    None
}

/// How long "the same message again" looks back.
const REPEAT_WINDOW_MS: i64 = 60_000;

/// Run automod on a message `sender` is about to post (or edit to). Answers
/// the refusal to return, having timed them out when the room asks for that.
/// Anyone who can manage messages is exempt, as with slowmode.
///
/// `check_repeats` is off for an edit: the message being edited is itself a
/// recent message with that body.
pub(crate) async fn automod_refusal(
    state: &std::sync::Arc<AppState>,
    room_id: &str,
    sender: &str,
    body: &str,
    check_repeats: bool,
) -> Option<(StatusCode, Json<Value>)> {
    let room = state
        .db
        .collection::<RoomRecord>("rooms")
        .find_one(doc! { "_id": room_id })
        .await
        .ok()
        .flatten()?;
    let settings = &room.moderation.automod;
    if room.is_dm || !settings.enabled {
        return None;
    }
    if super::helpers::effective_permissions(state, room_id, sender)
        .await
        .manage_messages
    {
        return None;
    }
    let mut rule = automod_verdict(settings, body);
    if rule.is_none() && check_repeats && settings.block_repeats && !body.trim().is_empty() {
        let repeat = state
            .db
            .collection::<mongodb::bson::Document>("messages")
            .find_one(doc! {
                "room_id": room_id,
                "sender": sender,
                "content.body": body,
                "origin_server_ts": { "$gte": now_millis() - REPEAT_WINDOW_MS },
                "redacted": { "$ne": true },
            })
            .await
            .ok()
            .flatten();
        if repeat.is_some() {
            rule = Some(AutomodRule::Repeat);
        }
    }
    let rule = rule?;

    super::audit::record(
        state,
        room_id,
        AUTOMOD_ACTOR,
        super::audit::AuditAction::AutomodBlocked,
        sender,
        rule.as_str(),
    )
    .await;
    let mut timeout_until = 0;
    if settings.timeout_secs > 0 {
        timeout_until = super::routes::moderation::apply_timeout(
            state,
            room_id,
            AUTOMOD_ACTOR,
            sender,
            settings.timeout_secs,
            &format!("automod: {}", rule.as_str()),
        )
        .await;
    }
    let mut out = json!({
        "errcode": "M_FORBIDDEN",
        "error": format!("This room's automod blocked your message: {}", rule.describe()),
        "code": "automod",
        "rule": rule.as_str(),
    });
    if timeout_until > 0 {
        out["timeout_until"] = json!(timeout_until);
    }
    Some((StatusCode::FORBIDDEN, Json(out)))
}

/// Who the audit log and the timeout event name when automod acts.
pub(crate) const AUTOMOD_ACTOR: &str = "automod";

#[cfg(test)]
mod tests {
    use super::*;

    fn automod(change: impl FnOnce(&mut AutomodSettings)) -> AutomodSettings {
        let mut s = AutomodSettings {
            enabled: true,
            ..AutomodSettings::default()
        };
        change(&mut s);
        s
    }

    #[test]
    fn blocked_words_match_whole_words_and_prefixes() {
        let s =
            automod(|s| s.blocked_words = vec!["darn".into(), "scam*".into(), "free money".into()]);
        assert_eq!(
            automod_verdict(&s, "well DARN it"),
            Some(AutomodRule::BlockedWord)
        );
        assert_eq!(automod_verdict(&s, "darn."), Some(AutomodRule::BlockedWord));
        assert_eq!(automod_verdict(&s, "darning socks"), None);
        assert_eq!(
            automod_verdict(&s, "total scammers"),
            Some(AutomodRule::BlockedWord)
        );
        assert_eq!(
            automod_verdict(&s, "get FREE   money!"),
            Some(AutomodRule::BlockedWord)
        );
        assert_eq!(automod_verdict(&s, "money for free"), None);
    }

    #[test]
    fn nothing_is_checked_while_disabled() {
        let mut s = automod(|s| s.blocked_words = vec!["darn".into()]);
        s.enabled = false;
        assert_eq!(automod_verdict(&s, "darn"), None);
    }

    #[test]
    fn links_and_invites() {
        let s = automod(|s| s.block_links = true);
        assert_eq!(
            automod_verdict(&s, "see https://example.org/x"),
            Some(AutomodRule::Link)
        );
        assert_eq!(
            automod_verdict(&s, "go to cheap-pills.xyz now"),
            Some(AutomodRule::Link)
        );
        assert_eq!(automod_verdict(&s, "ok. see you"), None);
        // An attachment on this instance is not a link someone typed.
        assert_eq!(automod_verdict(&s, "/external/abc/photo.png"), None);

        let s = automod(|s| s.block_invites = true);
        assert_eq!(
            automod_verdict(&s, "join discord.gg/abcd"),
            Some(AutomodRule::Invite)
        );
        assert_eq!(
            automod_verdict(&s, "https://chat.example.com/invite/Xy7kP2qa"),
            Some(AutomodRule::Invite)
        );
        assert_eq!(automod_verdict(&s, "https://example.com"), None);
    }

    #[test]
    fn mentions_count_distinct_names_not_emails() {
        let s = automod(|s| s.max_mentions = 2);
        assert_eq!(automod_verdict(&s, "@a @b"), None);
        assert_eq!(automod_verdict(&s, "@a @a @a @b"), None);
        assert_eq!(automod_verdict(&s, "@a @b @c"), Some(AutomodRule::Mentions));
        assert_eq!(automod_verdict(&s, "mail x@a.com y@b.com z@c.com"), None);
    }

    #[test]
    fn restriction_switches_off_participation_only() {
        let mut perms = RolePermissions {
            manage_messages: true,
            ..RolePermissions::default()
        };
        apply_restriction(
            &mut perms,
            &Restriction {
                timeout_until: 1,
                rules_pending: false,
            },
        );
        assert!(!perms.send_messages);
        assert!(!perms.add_reactions);
        assert!(!perms.connect);
        assert!(!perms.speak);
        assert!(perms.view_channel);
        assert!(perms.manage_messages);
    }

    #[test]
    fn no_restriction_changes_nothing() {
        let mut perms = RolePermissions::default();
        apply_restriction(&mut perms, &Restriction::default());
        assert!(perms.send_messages);
        assert!(perms.connect);
    }

    #[test]
    fn refusal_names_the_reason() {
        let timed = restriction_refusal(&Restriction {
            timeout_until: 5,
            rules_pending: true,
        })
        .unwrap();
        assert_eq!(timed.1 .0["code"], "timed_out");
        let rules = restriction_refusal(&Restriction {
            timeout_until: 0,
            rules_pending: true,
        })
        .unwrap();
        assert_eq!(rules.1 .0["code"], "rules_pending");
        assert!(restriction_refusal(&Restriction::default()).is_none());
    }
}
