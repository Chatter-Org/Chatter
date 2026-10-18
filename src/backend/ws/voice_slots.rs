//! Speaker slots: who a listener actually hears, and how their audio gets there.
//!
//! Forwarding every publisher to every listener costs O(N²) streams, which caps
//! a call in the low tens however fast the machine is. Instead each listener
//! holds a fixed number of slots, and a periodic sweep decides which speakers
//! occupy them. Bandwidth is then bounded by the slot count rather than the
//! headcount, so the same server carries a call of ten and a call of hundreds.

use super::voice_webrtc::send_slot_map;
use crate::backend::{
    constants::{
        OPUS_FRAME_SAMPLES, VOICE_ACTIVITY_DBOV_THRESHOLD, VOICE_MAX_ACTIVE_SPEAKERS,
        VOICE_MAX_TS_DELTA, VOICE_SPEAKER_HOLD_MS, VOICE_SPEAKER_REFRESH_MS,
    },
    helpers::{broadcast_to_voice_channel, now_millis},
    metrics::{MediaKind, METRICS},
    state::{AppState, SlotRestamp, VoiceSlot, VoiceSlotAssignment},
};
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::{sync::broadcast, task::JoinHandle};
use webrtc::track::track_local::TrackLocalWriter;

/// What the sweep knows about one publisher: how loud their last packet was,
/// and when they last said anything.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SpeakerActivity {
    pub(crate) user_id: String,
    pub(crate) level: u8,
    pub(crate) last_voice_ms: u64,
}

impl SpeakerActivity {
    fn is_voicing(&self) -> bool {
        self.level <= VOICE_ACTIVITY_DBOV_THRESHOLD
    }
}

/// Order speakers by who most deserves a slot.
///
/// Anyone talking right now comes first, loudest first. Behind them come people
/// who spoke within the hold window: without that tier, two people trading
/// short remarks would evict each other from a slot several times a second, and
/// every eviction costs the listener a decoder reset.
pub(crate) fn rank_speakers(activity: &[SpeakerActivity], now_ms: u64) -> Vec<String> {
    let mut ranked: Vec<&SpeakerActivity> = activity.iter().collect();
    ranked.sort_by(|a, b| rank_key(a, now_ms).cmp(&rank_key(b, now_ms)));
    ranked.into_iter().map(|a| a.user_id.clone()).collect()
}

fn rank_key(a: &SpeakerActivity, now_ms: u64) -> (u8, u64, &str) {
    if a.is_voicing() {
        // Level is -dBov, so a smaller number is louder and sorts first.
        (0, u64::from(a.level), a.user_id.as_str())
    } else if now_ms.saturating_sub(a.last_voice_ms) <= VOICE_SPEAKER_HOLD_MS {
        (1, u64::MAX - a.last_voice_ms, a.user_id.as_str())
    } else {
        (2, 0, a.user_id.as_str())
    }
}

/// Which speakers are audible to a listener, given the channel-wide ranking.
pub(crate) fn wanted_for_listener(ranked: &[String], listener_user_id: &str) -> Vec<String> {
    ranked
        .iter()
        .filter(|u| u.as_str() != listener_user_id)
        .take(VOICE_MAX_ACTIVE_SPEAKERS)
        .cloned()
        .collect()
}

/// Place the wanted speakers into slots, leaving anyone already placed where
/// they are.
///
/// Stability is the whole point: moving a speaker who is still wanted from one
/// slot to another would break their audio for no reason, so only slots that
/// genuinely change hands are touched.
pub(crate) fn assign_slots(current: &[Option<String>], wanted: &[String]) -> Vec<Option<String>> {
    let mut next: Vec<Option<String>> = vec![None; current.len()];
    let mut placed: HashSet<String> = HashSet::new();

    for (i, occupant) in current.iter().enumerate() {
        if let Some(user_id) = occupant {
            if wanted.contains(user_id) && !placed.contains(user_id) {
                next[i] = Some(user_id.clone());
                placed.insert(user_id.clone());
            }
        }
    }

    let mut free = next
        .iter()
        .enumerate()
        .filter(|(_, slot)| slot.is_none())
        .map(|(i, _)| i)
        .collect::<Vec<_>>()
        .into_iter();

    for user_id in wanted {
        if placed.contains(user_id) {
            continue;
        }
        match free.next() {
            Some(i) => {
                next[i] = Some(user_id.clone());
                placed.insert(user_id.clone());
            }
            None => break,
        }
    }

    next
}

/// Renumber a forwarded packet so the slot's output stays continuous.
///
/// A slot keeps one SSRC for the life of the connection while the speaker
/// feeding it changes. Receivers track a stream by SSRC, so passing the input's
/// own numbering through would make the sequence jump backwards the moment a
/// slot changed hands, and the jitter buffer would stall waiting for packets
/// that will never come.
///
/// Returns the outgoing sequence number and timestamp, plus whether this packet
/// begins a new run — the caller sets the marker bit on those so the decoder
/// resets rather than trying to conceal a gap that is not really loss.
/// `None` means drop the packet: it is a duplicate or arrived out of order.
///
/// Wherever the input's own timestamps cannot be trusted — a new run, or a
/// jump too large to believe — the output advances by the wall-clock time since
/// the slot last sent. Advancing by a single frame there, as this used to, told
/// the receiver that audio separated by seconds was contiguous. Its jitter
/// buffer saw a packet arrive seconds "late", grew its delay to match, and
/// time-stretched its way back down: the choppy, warbling start every speaker
/// change produced.
pub(crate) fn restamp(
    state: &mut SlotRestamp,
    in_seq: u16,
    in_ts: u32,
    now: Instant,
) -> Option<(u16, u32, bool)> {
    let elapsed = elapsed_samples(state.last_out, now);
    let discontinuity = match state.prev_in {
        None => true,
        Some((prev_seq, prev_ts)) => {
            let seq_delta = in_seq.wrapping_sub(prev_seq);
            // Zero is a duplicate; anything past half the sequence space is a
            // packet that arrived late. Neither belongs in the output.
            if seq_delta == 0 || seq_delta > u16::MAX / 2 {
                return None;
            }
            let ts_delta = in_ts.wrapping_sub(prev_ts);
            state.out_seq = state.out_seq.wrapping_add(seq_delta);
            // A silent stretch under DTX legitimately jumps the timestamp, so
            // gaps are carried through; a wildly out-of-range one is not
            // trusted, and the clock moves by the time that actually passed.
            state.out_ts =
                state
                    .out_ts
                    .wrapping_add(if ts_delta == 0 || ts_delta > VOICE_MAX_TS_DELTA {
                        elapsed
                    } else {
                        ts_delta
                    });
            false
        }
    };

    if discontinuity {
        state.out_seq = state.out_seq.wrapping_add(1);
        state.out_ts = state.out_ts.wrapping_add(elapsed);
    }

    state.prev_in = Some((in_seq, in_ts));
    state.last_out = Some(now);
    Some((state.out_seq, state.out_ts, discontinuity))
}

/// RTP clock ticks since the slot last sent, never less than one frame.
///
/// Capped well inside half the 32-bit timestamp space, past which a receiver
/// would read the jump as going backwards. A slot idle that long is a fresh
/// stream to the decoder either way.
fn elapsed_samples(last_out: Option<Instant>, now: Instant) -> u32 {
    const MAX_ELAPSED_SAMPLES: u64 = 48 * 60 * 60 * 1000; // an hour
    let Some(last_out) = last_out else {
        return OPUS_FRAME_SAMPLES;
    };
    let ms = now.saturating_duration_since(last_out).as_millis() as u64;
    let samples = (ms * 48).min(MAX_ELAPSED_SAMPLES) as u32;
    samples.max(OPUS_FRAME_SAMPLES)
}

/// Pump one speaker's RTP into one slot until the speaker stops publishing or
/// the slot is handed to somebody else.
///
/// If it stops on its own — the speaker's stream ended under it — it gives the
/// slot back. That happens when a sweep hands out a speaker's stream in the
/// same moment their publisher is replaced (a rejoin, a retry): the slot is
/// fed from the old stream, which then closes. Left assigned, the slot would
/// look occupied to the sweep forever while carrying nothing, and since the
/// sweep keeps anyone still wanted where they are, the listener would never
/// hear that speaker again.
fn spawn_slot_forwarder(
    slot: Arc<VoiceSlot>,
    mut rtp: broadcast::Receiver<rtp::packet::Packet>,
    token: Arc<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        forward_into_slot(&slot, &mut rtp).await;
        if let Ok(mut assignment) = slot.assignment.lock() {
            let still_ours = assignment
                .as_ref()
                .is_some_and(|a| Arc::ptr_eq(&a.token, &token));
            if still_ours {
                if let Some(gone) = assignment.take() {
                    eprintln!(
                        "[voice] slot forwarder for {} stopped; freeing the slot",
                        gone.speaker_user_id
                    );
                }
                if let Ok(mut restamp_state) = slot.restamp.lock() {
                    restamp_state.prev_in = None;
                }
            }
        }
    })
}

async fn forward_into_slot(slot: &VoiceSlot, rtp: &mut broadcast::Receiver<rtp::packet::Packet>) {
    loop {
        match rtp.recv().await {
            Ok(packet) => {
                let stamped = {
                    let Ok(mut restamp_state) = slot.restamp.lock() else {
                        break;
                    };
                    restamp(
                        &mut restamp_state,
                        packet.header.sequence_number,
                        packet.header.timestamp,
                        Instant::now(),
                    )
                };
                let Some((sequence_number, timestamp, discontinuity)) = stamped else {
                    continue;
                };

                // Built rather than cloned and then emptied. Every
                // publisher packet carries the audio-level extension, so
                // `packet.clone()` heap-allocated an extension vector once
                // per packet *per listener* purely for the next few lines
                // to throw away — and this is the hottest loop the server
                // has. `payload` is `Bytes`, so carrying it over is a
                // refcount bump rather than a copy.
                //
                // Extension ids are negotiated per connection, so the
                // publisher's numbering means nothing on this leg. Speaking
                // state reaches clients over the websocket instead.
                let out = rtp::packet::Packet {
                    header: rtp::header::Header {
                        version: packet.header.version,
                        padding: packet.header.padding,
                        extension: false,
                        marker: discontinuity,
                        payload_type: packet.header.payload_type,
                        sequence_number,
                        timestamp,
                        // Both are overwritten per binding inside
                        // `write_rtp`; carried anyway so the packet is
                        // coherent on its own.
                        ssrc: packet.header.ssrc,
                        // Empty in practice — nothing upstream mixes — so
                        // this clone does not allocate either.
                        csrc: packet.header.csrc.clone(),
                        extension_profile: 0,
                        extensions: Vec::new(),
                        extensions_padding: 0,
                    },
                    payload: packet.payload.clone(),
                };

                // A failed write is not the end of the slot. The forwarder
                // used to stop on the first one, while the assignment it
                // served stayed in place — and since the sweep keeps a
                // speaker who is still wanted exactly where they are, one
                // transient send error (a network blip, a write during an
                // ICE consent hiccup) silenced that speaker for that
                // listener for the rest of the call. The task ends when
                // the slot is reassigned or the listener is torn down,
                // both of which abort it, or when the publisher goes.
                match slot.track.write_rtp(&out).await {
                    Ok(bytes) => METRICS.record_out(MediaKind::Voice, bytes),
                    Err(_) => continue,
                }
            }
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                METRICS.record_lagged(MediaKind::Voice, skipped);
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        }
    }
}

/// Hand a slot to `speaker`, or clear it when `speaker` is `None`.
///
/// Resetting the restamp state is what makes the handover audible as a clean
/// start rather than a stalled stream.
fn set_slot(
    slot: &Arc<VoiceSlot>,
    speaker: Option<(String, broadcast::Sender<rtp::packet::Packet>)>,
) {
    let Ok(mut assignment) = slot.assignment.lock() else {
        return;
    };
    if let Some(previous) = assignment.take() {
        previous.forward_task.abort();
    }
    if let Ok(mut restamp_state) = slot.restamp.lock() {
        restamp_state.prev_in = None;
    }
    if let Some((speaker_user_id, rtp_sender)) = speaker {
        let token = Arc::new(());
        let forward_task =
            spawn_slot_forwarder(slot.clone(), rtp_sender.subscribe(), token.clone());
        *assignment = Some(VoiceSlotAssignment {
            speaker_user_id,
            forward_task,
            token,
        });
    }
}

fn current_occupants(slots: &[Arc<VoiceSlot>]) -> Vec<Option<String>> {
    slots
        .iter()
        .map(|slot| {
            slot.assignment
                .lock()
                .ok()
                .and_then(|a| a.as_ref().map(|a| a.speaker_user_id.clone()))
        })
        .collect()
}

/// Release every slot in the channel that is currently carrying `speaker`.
/// The next sweep refills them; this just stops audio from someone who has gone.
pub(crate) async fn release_slots_for_speaker(state: &AppState, speaker_user_id: &str) {
    let listeners = state.voice_listeners.read().await;
    for listener in listeners.values() {
        for slot in &listener.slots {
            let holds = slot
                .assignment
                .lock()
                .ok()
                .and_then(|a| a.as_ref().map(|a| a.speaker_user_id == speaker_user_id))
                .unwrap_or(false);
            if holds {
                set_slot(slot, None);
            }
        }
    }
}

/// One pass over every occupied voice channel: rank its speakers, tell everyone
/// who is talking, and move slots that need moving.
pub(crate) async fn refresh_voice_slots(state: &AppState) {
    let now_ms = now_millis().max(0) as u64;

    let channels: Vec<(String, Vec<String>)> = {
        let voice_channels = state.voice_channels.read().await;
        voice_channels
            .iter()
            .filter(|(_, members)| !members.is_empty())
            .map(|(channel_id, members)| (channel_id.clone(), members.keys().cloned().collect()))
            .collect()
    };
    if channels.is_empty() {
        return;
    }

    for (channel_id, members) in channels {
        // Snapshot activity and the broadcast handles together, so nothing is
        // held across the slot work below.
        let (activity, senders) = {
            let publishers = state.voice_publishers.read().await;
            let mut activity = Vec::with_capacity(members.len());
            let mut senders = HashMap::with_capacity(members.len());
            for user_id in &members {
                let Some(publisher) = publishers.get(user_id) else {
                    continue;
                };
                if publisher.channel_id != channel_id {
                    continue;
                }
                let Some(rtp_sender) = publisher.rtp_sender.clone() else {
                    continue;
                };
                activity.push(SpeakerActivity {
                    user_id: user_id.clone(),
                    level: publisher.audio_level.load(Ordering::Relaxed),
                    last_voice_ms: publisher.last_voice_ms.load(Ordering::Relaxed),
                });
                senders.insert(user_id.clone(), rtp_sender);
            }
            (activity, senders)
        };

        let ranked = rank_speakers(&activity, now_ms);

        let mut speaking: Vec<String> = activity
            .iter()
            .filter(|a| a.is_voicing())
            .map(|a| a.user_id.clone())
            .collect();
        speaking.sort();
        let changed = {
            let mut last = state.voice_speaking.write().await;
            match last.get(&channel_id) {
                Some(previous) if *previous == speaking => false,
                _ => {
                    last.insert(channel_id.clone(), speaking.clone());
                    true
                }
            }
        };
        if changed {
            broadcast_to_voice_channel(
                state,
                &channel_id,
                &json!({
                    "type": "voice_speaking",
                    "channel_id": channel_id,
                    "speaking": speaking,
                }),
            )
            .await;
        }

        // Work out each listener's map, then send updates outside the lock.
        let mut updates: Vec<(String, String, Vec<Option<String>>)> = Vec::new();
        {
            let listeners = state.voice_listeners.read().await;
            for listener_user_id in &members {
                let Some(listener) = listeners.get(listener_user_id) else {
                    continue;
                };
                if listener.channel_id != channel_id {
                    continue;
                }

                let wanted = wanted_for_listener(&ranked, listener_user_id);
                let current = current_occupants(&listener.slots);
                let next = assign_slots(&current, &wanted);

                for (i, slot) in listener.slots.iter().enumerate() {
                    if next[i] == current[i] {
                        continue;
                    }
                    let speaker = next[i]
                        .as_ref()
                        .and_then(|u| senders.get(u).map(|tx| (u.clone(), tx.clone())));
                    set_slot(slot, speaker);
                }

                // Announce against what the client was last told, not against
                // the slots: a slot vacated outside the sweep leaves the two
                // disagreeing, and only this comparison notices.
                let announce = match listener.last_sent_map.lock() {
                    Ok(mut last) => {
                        if *last == next {
                            false
                        } else {
                            last.clone_from(&next);
                            true
                        }
                    }
                    Err(_) => false,
                };
                if !announce {
                    continue;
                }

                updates.push((listener_user_id.clone(), listener.room_id.clone(), next));
            }
        }

        for (listener_user_id, room_id, slots) in updates {
            send_slot_map(state, &listener_user_id, &room_id, &channel_id, &slots).await;
        }
    }
}

/// Drive the sweep for the life of the process. Idle channels cost one map
/// lookup per tick.
pub(crate) async fn run_voice_slot_scheduler(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(Duration::from_millis(VOICE_SPEAKER_REFRESH_MS));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        refresh_voice_slots(&state).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        use std::sync::OnceLock;
        static T0: OnceLock<Instant> = OnceLock::new();
        *T0.get_or_init(Instant::now)
    }

    fn at(ms: u64) -> Instant {
        t0() + Duration::from_millis(ms)
    }

    fn activity(user_id: &str, level: u8, last_voice_ms: u64) -> SpeakerActivity {
        SpeakerActivity {
            user_id: user_id.to_string(),
            level,
            last_voice_ms,
        }
    }

    #[test]
    fn ranks_current_speakers_loudest_first() {
        let now = 10_000;
        let ranked = rank_speakers(
            &[
                activity("quiet", 20, now),
                activity("loudest", 5, now),
                activity("middle", 12, now),
            ],
            now,
        );
        assert_eq!(ranked, vec!["loudest", "middle", "quiet"]);
    }

    #[test]
    fn ranks_talkers_above_the_recently_silent_above_the_idle() {
        let now = 10_000;
        let ranked = rank_speakers(
            &[
                activity("idle", 127, 0),
                activity("just_stopped", 127, now - 500),
                activity("talking", 30, now),
            ],
            now,
        );
        assert_eq!(ranked, vec!["talking", "just_stopped", "idle"]);
    }

    #[test]
    fn hold_window_expires() {
        let now = 10_000;
        let held = activity("held", 127, now - VOICE_SPEAKER_HOLD_MS);
        let expired = activity("expired", 127, now - VOICE_SPEAKER_HOLD_MS - 1);
        assert_eq!(
            rank_speakers(&[expired, held], now),
            vec!["held", "expired"]
        );
    }

    #[test]
    fn listener_never_hears_themselves() {
        let ranked = vec!["a".to_string(), "me".to_string(), "b".to_string()];
        assert_eq!(wanted_for_listener(&ranked, "me"), vec!["a", "b"]);
    }

    #[test]
    fn listener_hears_at_most_the_slot_count() {
        let ranked: Vec<String> = (0..40).map(|i| format!("u{i}")).collect();
        assert_eq!(
            wanted_for_listener(&ranked, "nobody").len(),
            VOICE_MAX_ACTIVE_SPEAKERS
        );
    }

    #[test]
    fn keeps_a_speaker_in_the_slot_they_already_hold() {
        let current = vec![Some("a".into()), None, Some("b".into())];
        let wanted = vec!["b".to_string(), "a".to_string(), "c".to_string()];
        // b stays in slot 2 and a in slot 0 despite b ranking first; only the
        // genuinely empty slot takes the newcomer.
        assert_eq!(
            assign_slots(&current, &wanted),
            vec![Some("a".into()), Some("c".into()), Some("b".into())]
        );
    }

    #[test]
    fn evicts_only_speakers_who_dropped_out() {
        let current = vec![Some("a".into()), Some("gone".into())];
        let wanted = vec!["a".to_string(), "new".to_string()];
        assert_eq!(
            assign_slots(&current, &wanted),
            vec![Some("a".into()), Some("new".into())]
        );
    }

    #[test]
    fn clears_slots_when_nobody_is_wanted() {
        let current = vec![Some("a".into()), Some("b".into())];
        assert_eq!(assign_slots(&current, &[]), vec![None, None]);
    }

    #[test]
    fn never_places_a_speaker_in_two_slots() {
        let current = vec![Some("a".into()), Some("a".into()), None];
        let next = assign_slots(&current, &["a".to_string()]);
        assert_eq!(next.iter().flatten().filter(|u| *u == "a").count(), 1);
    }

    fn test_slot() -> Arc<VoiceSlot> {
        use webrtc::{
            api::media_engine::MIME_TYPE_OPUS, rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
            track::track_local::track_local_static_rtp::TrackLocalStaticRTP,
        };
        Arc::new(VoiceSlot {
            track: Arc::new(TrackLocalStaticRTP::new(
                RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_string(),
                    clock_rate: 48_000,
                    channels: 2,
                    ..Default::default()
                },
                "voice-slot-0".to_string(),
                "test".to_string(),
            )),
            assignment: std::sync::Mutex::new(None),
            restamp: std::sync::Mutex::new(Default::default()),
        })
    }

    async fn wait_until_empty(slot: &VoiceSlot) -> bool {
        for _ in 0..100 {
            if slot.assignment.lock().unwrap().is_none() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        false
    }

    /// A slot whose speaker's stream has ended must be given back, or the
    /// sweep goes on believing the listener hears them.
    #[tokio::test]
    async fn a_slot_is_freed_when_its_speakers_stream_ends() {
        let slot = test_slot();
        let (tx, _) = broadcast::channel::<rtp::packet::Packet>(8);
        set_slot(&slot, Some(("@a:localhost".to_string(), tx.clone())));
        assert!(slot.assignment.lock().unwrap().is_some());

        drop(tx);
        assert!(wait_until_empty(&slot).await, "slot should have been freed");
    }

    /// A forwarder that was replaced must not free the slot from under the
    /// speaker who took it over.
    #[tokio::test]
    async fn a_replaced_forwarder_leaves_the_new_assignment_alone() {
        let slot = test_slot();
        let (old_tx, _) = broadcast::channel::<rtp::packet::Packet>(8);
        let (new_tx, _) = broadcast::channel::<rtp::packet::Packet>(8);
        set_slot(&slot, Some(("@a:localhost".to_string(), old_tx.clone())));
        set_slot(&slot, Some(("@b:localhost".to_string(), new_tx.clone())));
        drop(old_tx);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            current_occupants(std::slice::from_ref(&slot)),
            vec![Some("@b:localhost".to_string())]
        );
    }

    #[test]
    fn restamp_starts_a_new_run_with_the_marker_set() {
        let mut state = SlotRestamp::default();
        let (seq, ts, discontinuity) = restamp(&mut state, 40_000, 900_000, t0()).unwrap();
        assert_eq!((seq, ts), (1, OPUS_FRAME_SAMPLES));
        assert!(discontinuity);
    }

    #[test]
    fn restamp_is_continuous_across_a_speaker_change() {
        let mut state = SlotRestamp::default();
        // First speaker, three packets.
        for i in 0..3 {
            restamp(
                &mut state,
                100 + i,
                48_000 + u32::from(i) * OPUS_FRAME_SAMPLES,
                at(u64::from(i) * 40),
            )
            .unwrap();
        }
        let (before, before_ts, _) = (state.out_seq, state.out_ts, ());
        // Slot changes hands: the new speaker's own numbering is unrelated and
        // in this case runs far behind the old one.
        state.prev_in = None;
        let (seq, ts, discontinuity) = restamp(&mut state, 7, 12, at(120)).unwrap();
        assert!(discontinuity, "a handover must reset the decoder");
        assert_eq!(
            seq,
            before.wrapping_add(1),
            "output must not jump backwards"
        );
        assert_eq!(ts, before_ts.wrapping_add(OPUS_FRAME_SAMPLES));
    }

    #[test]
    fn restamp_carries_gaps_through_so_loss_is_still_visible() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, 100, 48_000, t0()).unwrap();
        // Three packets lost in flight.
        let (seq, _, discontinuity) =
            restamp(&mut state, 104, 48_000 + 4 * OPUS_FRAME_SAMPLES, at(160)).unwrap();
        assert_eq!(seq, 5);
        assert!(!discontinuity);
    }

    #[test]
    fn restamp_drops_duplicates_and_reordered_packets() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, 100, 48_000, t0()).unwrap();
        restamp(&mut state, 101, 48_960, at(20)).unwrap();
        assert!(
            restamp(&mut state, 101, 48_960, at(40)).is_none(),
            "duplicate"
        );
        assert!(
            restamp(&mut state, 99, 47_040, at(60)).is_none(),
            "reordered"
        );
    }

    #[test]
    fn restamp_survives_sequence_wraparound() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, u16::MAX, 48_000, t0()).unwrap();
        let (seq, _, discontinuity) = restamp(&mut state, 0, 48_960, at(20)).unwrap();
        assert_eq!(seq, 2);
        assert!(!discontinuity);
    }

    #[test]
    fn restamp_distrusts_an_absurd_timestamp_jump() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, 100, 48_000, t0()).unwrap();
        let (_, ts, _) = restamp(
            &mut state,
            101,
            48_000u32.wrapping_add(VOICE_MAX_TS_DELTA + 1),
            at(40),
        )
        .unwrap();
        assert_eq!(ts, OPUS_FRAME_SAMPLES * 2);
    }

    #[test]
    fn restamp_advances_by_real_time_when_a_slot_changes_hands_after_a_silence() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, 100, 48_000, t0()).unwrap();
        let before_ts = state.out_ts;
        // Three seconds later somebody else takes the slot.
        state.prev_in = None;
        let (_, ts, discontinuity) = restamp(&mut state, 9, 77, at(3_000)).unwrap();
        assert!(discontinuity);
        assert_eq!(
            ts.wrapping_sub(before_ts),
            3 * 48_000,
            "the receiver must see the three seconds that passed, or it reads them as jitter"
        );
    }

    #[test]
    fn restamp_trusts_real_time_over_an_absurd_jump() {
        let mut state = SlotRestamp::default();
        restamp(&mut state, 100, 48_000, t0()).unwrap();
        let before_ts = state.out_ts;
        let (_, ts, _) = restamp(
            &mut state,
            101,
            48_000u32.wrapping_add(VOICE_MAX_TS_DELTA * 10),
            at(2_000),
        )
        .unwrap();
        assert_eq!(ts.wrapping_sub(before_ts), 2 * 48_000);
    }
}
