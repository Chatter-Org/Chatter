use crate::backend::{
    constants::WEBCAM_RTP_BUFFER_SIZE,
    helpers::{broadcast_to_room, send_to_user},
    metrics::{MediaKind, METRICS},
    state::{AppState, WebcamLayer, WebcamPublisherState, WebcamSubscriberState},
    webrtc::{
        create_peer_connection, ice_candidate_to_json, parse_ice_candidate, relay_packet,
        rewrite_rtcp_feedback_for_publisher, CandidateGate,
    },
    ws::webcam_simulcast::{pick_layer, starts_keyframe, VideoRestamp, Vp8Munger, WebcamQuality},
};
use rtcp::{
    packet::Packet as RtcpPacket, payload_feedbacks::picture_loss_indication::PictureLossIndication,
};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinHandle,
};
use webrtc::{
    peer_connection::{
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription, RTCPeerConnection,
    },
    rtp_transceiver::rtp_codec::RTCRtpCodecCapability,
    track::{
        track_local::{track_local_static_rtp::TrackLocalStaticRTP, TrackLocal, TrackLocalWriter},
        track_remote::TrackRemote,
    },
    util::MarshalSize,
};

pub(crate) fn subscriber_key(viewer_user_id: &str, sharer_user_id: &str) -> String {
    format!("{}|{}", viewer_user_id, sharer_user_id)
}

pub(crate) async fn user_in_voice_room(state: &AppState, _room_id: &str, user_id: &str) -> bool {
    let vc = state.voice_channels.read().await;
    vc.values().any(|members| members.contains_key(user_id))
}

pub(crate) async fn user_is_webcam_active(state: &AppState, _room_id: &str, user_id: &str) -> bool {
    let publishers = state.webcam_publishers.read().await;
    publishers.contains_key(user_id)
}

/// Set a member's webcam flag wherever they are in voice, returning the channel
/// it changed in. Mirrors `set_user_screen_sharing`, and for the same reason:
/// the channel a user is in is found by looking for them, not by assuming the
/// channel id matches the room's.
pub(crate) async fn set_user_webcam_sharing(
    state: &AppState,
    user_id: &str,
    sharing: bool,
) -> Option<String> {
    let mut vc = state.voice_channels.write().await;
    for (channel_id, members) in vc.iter_mut() {
        if let Some(member) = members.get_mut(user_id) {
            member.webcam_sharing = sharing;
            return Some(channel_id.clone());
        }
    }
    None
}

pub(crate) async fn teardown_webcam_subscriber_pair(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
) {
    teardown_webcam_subscriber_pair_on(state, viewer_user_id, sharer_user_id, None).await;
}

/// Tear down one viewer's subscription — with `only`, just when it is still
/// that connection. Checked under the same lock as the removal: a connection
/// reporting itself closed after a resubscribe has replaced it must not take
/// the replacement down with it.
async fn teardown_webcam_subscriber_pair_on(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
    only: Option<&Arc<RTCPeerConnection>>,
) {
    let key = subscriber_key(viewer_user_id, sharer_user_id);
    let subscriber = {
        let mut subs = state.webcam_subscribers.write().await;
        match subs.get(&key) {
            Some(s) if only.is_none_or(|pc| Arc::ptr_eq(&s.peer_connection, pc)) => {
                subs.remove(&key)
            }
            _ => None,
        }
    };

    if let Some(subscriber) = subscriber {
        subscriber.forward_task.abort();
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[webcam] teardown_webcam_subscriber_pair close error: {e}");
        }
    }
}

pub(crate) async fn teardown_webcam_subscriptions_for_viewer(
    state: &AppState,
    viewer_user_id: &str,
) {
    let subscribers = {
        let mut subs = state.webcam_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.viewer_user_id == viewer_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[webcam] teardown_webcam_subscriptions_for_viewer close error: {e}");
        }
    }
}

pub(crate) async fn teardown_webcam_subscriptions_for_sharer(
    state: &AppState,
    sharer_user_id: &str,
) {
    let subscribers = {
        let mut subs = state.webcam_subscribers.write().await;
        let keys: Vec<String> = subs
            .iter()
            .filter(|(_, entry)| entry.sharer_user_id == sharer_user_id)
            .map(|(key, _)| key.clone())
            .collect();

        let mut removed = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(entry) = subs.remove(&key) {
                removed.push(entry);
            }
        }
        removed
    };

    for subscriber in subscribers {
        subscriber.forward_task.abort();
        if let Err(e) = subscriber.peer_connection.close().await {
            eprintln!("[webcam] teardown_webcam_subscriptions_for_sharer close error: {e}");
        }
    }
}

pub(crate) async fn teardown_webcam_publisher(
    state: &AppState,
    sharer_user_id: &str,
) -> Option<String> {
    teardown_webcam_publisher_on(state, sharer_user_id, None).await
}

/// As `teardown_webcam_subscriber_pair_on`, for the sharer's own connection.
async fn teardown_webcam_publisher_on(
    state: &AppState,
    sharer_user_id: &str,
    only: Option<&Arc<RTCPeerConnection>>,
) -> Option<String> {
    let publisher = {
        let mut publishers = state.webcam_publishers.write().await;
        match publishers.get(sharer_user_id) {
            Some(p) if only.is_none_or(|pc| Arc::ptr_eq(&p.peer_connection, pc)) => {
                publishers.remove(sharer_user_id)
            }
            _ => None,
        }
    };

    let publisher = match publisher {
        Some(p) => p,
        None => return None,
    };

    teardown_webcam_subscriptions_for_sharer(state, sharer_user_id).await;
    if let Err(e) = publisher.peer_connection.close().await {
        eprintln!("[webcam] teardown_webcam_publisher close error for {sharer_user_id}: {e}");
    }
    Some(publisher.room_id)
}

pub(crate) async fn handle_webcam_webrtc_publish_offer(
    state: Arc<AppState>,
    user_id: &str,
    room_id: &str,
    channel_id: &str,
    sdp: &str,
) {
    if room_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing room_id or sdp"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if !user_in_voice_room(&state, room_id, user_id).await {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "You must be in the room voice channel before publishing webcam"
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    let _ = teardown_webcam_publisher(&state, user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    {
        let mut publishers = state.webcam_publishers.write().await;
        publishers.insert(
            user_id.to_string(),
            WebcamPublisherState {
                room_id: room_id.to_string(),
                channel_id: channel_id.to_string(),
                peer_connection: peer_connection.clone(),
                video_codec: None,
                layers: Arc::new(watch::channel(Vec::new()).0),
            },
        );
    }

    // Held back until the answer is out; see `CandidateGate`.
    let candidate_gate = Arc::new(CandidateGate::default());
    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let user_id = user_id.to_string();
        let gate = candidate_gate.clone();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let gate = gate.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "webcam_webrtc_publish_candidate",
                    "room_id": room_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                if let Some(response) = gate.pass(response) {
                    send_to_user(&state, &user_id, &response).await;
                }
            })
        }));
    }

    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let user_id = user_id.to_string();
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let room_id = room_id.clone();
            let user_id = user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Only this connection: an old one reporting itself
                    // closed must not end a share that has replaced it.
                    if teardown_webcam_publisher_on(&state, &user_id, Some(&this_pc))
                        .await
                        .is_some()
                    {
                        let event = json!({
                            "type": "webcam_share_stopped",
                            "room_id": room_id,
                            "user_id": user_id
                        });
                        broadcast_to_room(&state, &room_id, &event).await;
                    }
                }
            })
        }));
    }

    {
        let state_clone = state.clone();
        let user_id = user_id.to_string();
        // Once per encoding: a simulcast camera's arrive one at a time, each
        // as its own track named by its rid; one sent without simulcast
        // arrives once, with no rid.
        peer_connection.on_track(Box::new(move |track: Arc<TrackRemote>, _, _| {
            let state = state_clone.clone();
            let user_id = user_id.clone();
            Box::pin(async move {
                let codec = track.codec();
                let codec_capability = RTCRtpCodecCapability {
                    mime_type: codec.capability.mime_type.clone(),
                    clock_rate: codec.capability.clock_rate,
                    channels: codec.capability.channels,
                    sdp_fmtp_line: codec.capability.sdp_fmtp_line.clone(),
                    rtcp_feedback: codec.capability.rtcp_feedback.clone(),
                };

                let (rtp_sender, _) =
                    broadcast::channel::<rtp::packet::Packet>(WEBCAM_RTP_BUFFER_SIZE);
                let layer = WebcamLayer {
                    rid: track.rid().to_string(),
                    ssrc: track.ssrc(),
                    rtp_sender: rtp_sender.clone(),
                };

                let (room_id, first) = {
                    let mut publishers = state.webcam_publishers.write().await;
                    let Some(publisher) = publishers.get_mut(&user_id) else {
                        return;
                    };
                    publisher.video_codec.get_or_insert(codec_capability);
                    let mut first = false;
                    publisher.layers.send_modify(|layers| {
                        layers.retain(|l| l.rid != layer.rid);
                        first = layers.is_empty();
                        layers.push(layer);
                    });
                    (publisher.room_id.clone(), first)
                };
                // Viewers can start on the first encoding; the rest reach
                // their forwarders through the layers watch.
                if first {
                    let event = json!({
                        "type": "webcam_webrtc_publisher_ready",
                        "room_id": room_id,
                        "user_id": user_id
                    });
                    broadcast_to_room(&state, &room_id, &event).await;
                }

                tokio::spawn(async move {
                    while let Ok((rtp_packet, _)) = track.read_rtp().await {
                        METRICS.record_in(MediaKind::Webcam, rtp_packet.marshal_size());
                        let _ = rtp_sender.send(rtp_packet);
                    }
                });
            })
        }));
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            let _ = teardown_webcam_publisher(&state, user_id).await;
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        let _ = teardown_webcam_publisher(&state, user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            let _ = teardown_webcam_publisher(&state, user_id).await;
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "publish",
                "room_id": room_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        let _ = teardown_webcam_publisher(&state, user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "webcam_webrtc_publish_answer",
            "room_id": room_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, user_id, &response).await;
        for candidate in candidate_gate.open() {
            send_to_user(&state, user_id, &candidate).await;
        }
    } else {
        let _ = teardown_webcam_publisher(&state, user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "room_id": room_id,
            "detail": "Missing local description for publisher"
        });
        send_to_user(&state, user_id, &error).await;
    }
}

pub(crate) async fn handle_webcam_webrtc_publish_candidate(
    state: &AppState,
    user_id: &str,
    candidate_value: &Value,
) {
    let peer_connection = {
        let publishers = state.webcam_publishers.read().await;
        publishers
            .get(user_id)
            .map(|publisher| publisher.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };
    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "publish",
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, user_id, &error).await;
    }
}

pub(crate) async fn handle_webcam_webrtc_subscribe_offer(
    state: Arc<AppState>,
    viewer_user_id: &str,
    room_id: &str,
    sharer_user_id: &str,
    sdp: &str,
    quality: WebcamQuality,
) {
    if room_id.is_empty() || sharer_user_id.is_empty() || sdp.is_empty() {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Missing room_id, sharer_user_id, or sdp"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if viewer_user_id == sharer_user_id {
        return;
    }

    if !user_in_voice_room(&state, room_id, viewer_user_id).await {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "You must be in the room voice channel before subscribing"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if !user_is_webcam_active(&state, room_id, sharer_user_id).await {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "The requested user is not currently webcam streaming"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let publisher_state = {
        let publishers = state.webcam_publishers.read().await;
        publishers.get(sharer_user_id).cloned()
    };

    let Some(publisher_state) = publisher_state else {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Webcam publisher is not connected yet"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    if publisher_state.room_id != room_id {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Sharer is publishing in a different room"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let publisher_peer_connection = publisher_state.peer_connection.clone();

    if publisher_state.layers.borrow().is_empty() {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Webcam SSRC not ready yet; retry shortly"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let Some(codec_capability) = publisher_state.video_codec.clone() else {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Webcam track not ready yet; retry shortly"
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    };

    teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;

    let peer_connection = match create_peer_connection(&state).await {
        Ok(pc) => pc,
        Err(err) => {
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed creating peer connection: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    // Held back until the answer is out; see `CandidateGate`.
    let candidate_gate = Arc::new(CandidateGate::default());
    {
        let state_clone = state.clone();
        let room_id = room_id.to_string();
        let viewer_user_id = viewer_user_id.to_string();
        let sharer_user_id = sharer_user_id.to_string();
        let gate = candidate_gate.clone();
        peer_connection.on_ice_candidate(Box::new(move |candidate| {
            let state = state_clone.clone();
            let gate = gate.clone();
            let room_id = room_id.clone();
            let viewer_user_id = viewer_user_id.clone();
            let sharer_user_id = sharer_user_id.clone();
            Box::pin(async move {
                let Some(candidate) = candidate else {
                    return;
                };
                let Ok(candidate_init) = candidate.to_json() else {
                    return;
                };
                let response = json!({
                    "type": "webcam_webrtc_subscribe_candidate",
                    "room_id": room_id,
                    "sharer_user_id": sharer_user_id,
                    "candidate": ice_candidate_to_json(&candidate_init)
                });
                if let Some(response) = gate.pass(response) {
                    send_to_user(&state, &viewer_user_id, &response).await;
                }
            })
        }));
    }

    {
        let state_clone = state.clone();
        let viewer_user_id = viewer_user_id.to_string();
        let sharer_user_id = sharer_user_id.to_string();
        let this_pc = peer_connection.clone();
        peer_connection.on_peer_connection_state_change(Box::new(move |pc_state| {
            let state = state_clone.clone();
            let viewer_user_id = viewer_user_id.clone();
            let sharer_user_id = sharer_user_id.clone();
            let this_pc = this_pc.clone();
            Box::pin(async move {
                if matches!(
                    pc_state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    // Only this connection, never a subscription that has
                    // since replaced it.
                    teardown_webcam_subscriber_pair_on(
                        &state,
                        &viewer_user_id,
                        &sharer_user_id,
                        Some(&this_pc),
                    )
                    .await;
                }
            })
        }));
    }

    let mime_type = codec_capability.mime_type.clone();
    let clock_rate = codec_capability.clock_rate;
    let local_track = Arc::new(TrackLocalStaticRTP::new(
        codec_capability,
        format!("webcam-{}-{}", sharer_user_id, viewer_user_id),
        "chatter-sfu".to_string(),
    ));

    let track_for_sender: Arc<dyn TrackLocal + Send + Sync> = local_track.clone();
    let rtp_sender = match peer_connection.add_track(track_for_sender).await {
        Ok(sender) => sender,
        Err(err) => {
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed adding relay track: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            if let Err(e) = peer_connection.close().await {
                eprintln!("[webcam] subscribe add_track cleanup close error: {e}");
            }
            return;
        }
    };

    // Which encoding's SSRC the viewer is on, for its keyframe requests to
    // reach the right one. Set by the forwarder as it moves them.
    let current_ssrc = Arc::new(AtomicU32::new(0));
    let publisher_peer_connection_for_feedback = publisher_peer_connection.clone();
    let feedback_ssrc = current_ssrc.clone();
    tokio::spawn(async move {
        while let Ok((rtcp_packets, _)) = rtp_sender.read_rtcp().await {
            let publisher_media_ssrc = feedback_ssrc.load(Ordering::Relaxed);
            let rewritten_packets = rtcp_packets
                .iter()
                .filter_map(|packet| {
                    rewrite_rtcp_feedback_for_publisher(packet.as_ref(), publisher_media_ssrc)
                })
                .collect::<Vec<_>>();

            if rewritten_packets.is_empty() {
                continue;
            }

            let _ = publisher_peer_connection_for_feedback
                .write_rtcp(&rewritten_packets)
                .await;
        }
    });

    let (quality_tx, quality_rx) = watch::channel(quality);
    let forward_task: JoinHandle<()> = tokio::spawn(forward_webcam(
        WebcamForwarder::new(
            local_track,
            publisher_peer_connection,
            mime_type,
            clock_rate,
            current_ssrc,
        ),
        publisher_state.layers.subscribe(),
        quality_rx,
    ));

    {
        let key = subscriber_key(viewer_user_id, sharer_user_id);
        let mut subs = state.webcam_subscribers.write().await;
        subs.insert(
            key,
            WebcamSubscriberState {
                viewer_user_id: viewer_user_id.to_string(),
                sharer_user_id: sharer_user_id.to_string(),
                peer_connection: peer_connection.clone(),
                forward_task,
                quality: quality_tx,
            },
        );
    }

    let offer = match RTCSessionDescription::offer(sdp.to_string()) {
        Ok(offer) => offer,
        Err(err) => {
            teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Invalid offer SDP: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_remote_description(offer).await {
        teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed setting remote description: {}", err)
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    let answer = match peer_connection.create_answer(None).await {
        Ok(answer) => answer,
        Err(err) => {
            teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
            let error = json!({
                "type": "webcam_webrtc_error",
                "scope": "subscribe",
                "room_id": room_id,
                "sharer_user_id": sharer_user_id,
                "detail": format!("Failed creating answer: {}", err)
            });
            send_to_user(&state, viewer_user_id, &error).await;
            return;
        }
    };

    if let Err(err) = peer_connection.set_local_description(answer).await {
        teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed setting local description: {}", err)
        });
        send_to_user(&state, viewer_user_id, &error).await;
        return;
    }

    if let Some(local_desc) = peer_connection.local_description().await {
        let response = json!({
            "type": "webcam_webrtc_subscribe_answer",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "sdp": local_desc.sdp
        });
        send_to_user(&state, viewer_user_id, &response).await;
        for candidate in candidate_gate.open() {
            send_to_user(&state, viewer_user_id, &candidate).await;
        }
    } else {
        teardown_webcam_subscriber_pair(&state, viewer_user_id, sharer_user_id).await;
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "room_id": room_id,
            "sharer_user_id": sharer_user_id,
            "detail": "Missing local description for subscriber"
        });
        send_to_user(&state, viewer_user_id, &error).await;
    }
}

pub(crate) async fn handle_webcam_webrtc_subscribe_candidate(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
    candidate_value: &Value,
) {
    let key = subscriber_key(viewer_user_id, sharer_user_id);
    let peer_connection = {
        let subs = state.webcam_subscribers.read().await;
        subs.get(&key).map(|sub| sub.peer_connection.clone())
    };

    let Some(peer_connection) = peer_connection else {
        return;
    };
    let Some(candidate) = parse_ice_candidate(candidate_value) else {
        return;
    };

    if let Err(err) = peer_connection.add_ice_candidate(candidate).await {
        let error = json!({
            "type": "webcam_webrtc_error",
            "scope": "subscribe",
            "sharer_user_id": sharer_user_id,
            "detail": format!("Failed adding ICE candidate: {}", err)
        });
        send_to_user(state, viewer_user_id, &error).await;
    }
}

/// A viewer asking for a camera at another quality: the full picture for one
/// they have made big, a small one for a thumbnail or a grid tile. Takes effect
/// at the next keyframe of the encoding they are moved to.
pub(crate) async fn handle_webcam_webrtc_set_quality(
    state: &AppState,
    viewer_user_id: &str,
    sharer_user_id: &str,
    quality: WebcamQuality,
) {
    let key = subscriber_key(viewer_user_id, sharer_user_id);
    let subs = state.webcam_subscribers.read().await;
    if let Some(sub) = subs.get(&key) {
        sub.quality.send_if_modified(|current| {
            let changed = *current != quality;
            *current = quality;
            changed
        });
    }
}

/// Many packets dropped at once for a slow viewer: ask for a keyframe, since
/// the next frames will not decode without one.
const LAGGED_PACKET_THRESHOLD_FOR_PLI: u64 = 32;
const PLI_COOLDOWN: Duration = Duration::from_secs(2);
const PERIODIC_PLI_INTERVAL: Duration = Duration::from_secs(10);
/// How long the encoding a viewer is on may go quiet before they are moved to
/// another. A sender drops its top encoding when its upload cannot carry it,
/// and a viewer left on it would see a frozen picture.
const LAYER_STALL: Duration = Duration::from_millis(1500);
/// How long to wait for a keyframe on the encoding a viewer is being moved to
/// before giving the move up, and how often to ask for one meanwhile.
const SWITCH_TIMEOUT: Duration = Duration::from_secs(3);
const SWITCH_PLI_INTERVAL: Duration = Duration::from_secs(1);
/// How often a viewer kept off the encoding they asked for tries it again.
const RETRY_WANTED_LAYER: Duration = Duration::from_secs(5);
const FORWARDER_TICK: Duration = Duration::from_millis(500);

/// An encoding a viewer is receiving, or waiting to be moved to.
struct ActiveLayer {
    rid: String,
    ssrc: u32,
    rx: broadcast::Receiver<rtp::packet::Packet>,
    joined: Instant,
    last_packet: Instant,
    last_pli: Instant,
}

impl ActiveLayer {
    fn join(layer: &WebcamLayer) -> Self {
        let now = Instant::now();
        Self {
            rid: layer.rid.clone(),
            ssrc: layer.ssrc,
            rx: layer.rtp_sender.subscribe(),
            joined: now,
            last_packet: now,
            last_pli: now,
        }
    }
}

async fn recv_from(
    layer: &mut Option<ActiveLayer>,
) -> Result<rtp::packet::Packet, broadcast::error::RecvError> {
    match layer {
        Some(layer) => layer.rx.recv().await,
        None => std::future::pending().await,
    }
}

/// The encoding of `layers` to give a viewer asking for `quality`, leaving
/// out `except` (one that has gone quiet) when there is anything else.
fn choose_layer(
    layers: &[WebcamLayer],
    quality: WebcamQuality,
    except: Option<&str>,
) -> Option<WebcamLayer> {
    let candidates = || {
        layers
            .iter()
            .filter(move |l| except.is_none_or(|rid| l.rid != rid))
            .map(|l| l.rid.as_str())
    };
    let rid = pick_layer(candidates(), quality)?;
    layers.iter().find(|l| l.rid == rid).cloned()
}

/// One viewer's copy of one camera: which encoding they are on, which they are
/// being moved to, and the restamping that makes the two one stream.
struct WebcamForwarder {
    local_track: Arc<TrackLocalStaticRTP>,
    publisher_pc: Arc<RTCPeerConnection>,
    mime_type: String,
    restamp: VideoRestamp,
    /// Only for a VP8 camera, whose payload carries frame numbers of its own.
    vp8: Option<Vp8Munger>,
    current: Option<ActiveLayer>,
    /// Joined, and waiting for a keyframe before the viewer is moved to it.
    pending: Option<ActiveLayer>,
    current_ssrc: Arc<AtomicU32>,
    last_pli: Instant,
    last_retry: Instant,
}

impl WebcamForwarder {
    fn new(
        local_track: Arc<TrackLocalStaticRTP>,
        publisher_pc: Arc<RTCPeerConnection>,
        mime_type: String,
        clock_rate: u32,
        current_ssrc: Arc<AtomicU32>,
    ) -> Self {
        let now = Instant::now();
        let vp8 = mime_type
            .eq_ignore_ascii_case("video/vp8")
            .then(Vp8Munger::new);
        Self {
            local_track,
            publisher_pc,
            mime_type,
            restamp: VideoRestamp::new(clock_rate),
            vp8,
            current: None,
            pending: None,
            current_ssrc,
            last_pli: now - PLI_COOLDOWN,
            last_retry: now,
        }
    }

    /// The next packet sent is from a different encoding.
    fn switch_source(&mut self) {
        self.restamp.switch_source();
        if let Some(vp8) = self.vp8.as_mut() {
            vp8.switch_source();
        }
    }

    async fn request_keyframe(&self, ssrc: u32) {
        let _ = self
            .publisher_pc
            .write_rtcp(&[Box::new(PictureLossIndication {
                sender_ssrc: 0,
                media_ssrc: ssrc,
            }) as Box<dyn RtcpPacket + Send + Sync>])
            .await;
    }

    /// Head for `target`: straight onto it when the viewer has nothing yet,
    /// otherwise join it and wait for its next keyframe.
    async fn head_for(&mut self, target: Option<WebcamLayer>) {
        let Some(target) = target else {
            return;
        };
        match &self.current {
            None => {
                self.current_ssrc.store(target.ssrc, Ordering::Relaxed);
                self.current = Some(ActiveLayer::join(&target));
                self.switch_source();
                self.last_pli = Instant::now();
                self.request_keyframe(target.ssrc).await;
            }
            Some(current) if current.ssrc == target.ssrc => self.pending = None,
            Some(_) => {
                if self.pending.as_ref().map(|p| p.ssrc) != Some(target.ssrc) {
                    self.pending = Some(ActiveLayer::join(&target));
                    self.request_keyframe(target.ssrc).await;
                }
            }
        }
    }

    async fn send(&mut self, packet: &rtp::packet::Packet) {
        let (sequence_number, timestamp) = self.restamp.stamp(
            packet.header.sequence_number,
            packet.header.timestamp,
            Instant::now(),
        );
        // A failed write is not the end of this viewer's stream: stopping
        // here froze their picture for the rest of the share, and with no
        // packets arriving the client's frozen-video check never fired. The
        // task ends when the subscription is torn down, which aborts it, or
        // when the sharer stops.
        let mut out = relay_packet(packet, sequence_number, timestamp);
        if let Some(renumbered) = self.vp8.as_mut().and_then(|m| m.rewrite(&packet.payload)) {
            out.payload = renumbered.into();
        }
        if let Ok(bytes) = self.local_track.write_rtp(&out).await {
            METRICS.record_out(MediaKind::Webcam, bytes);
        }
    }

    /// A packet of the encoding being moved to: the move happens on the first
    /// packet of a keyframe, and everything before it is dropped.
    async fn on_pending_packet(&mut self, packet: rtp::packet::Packet) {
        let Some(pending) = self.pending.as_mut() else {
            return;
        };
        pending.last_packet = Instant::now();
        if starts_keyframe(&self.mime_type, &packet.payload) == Some(false) {
            return;
        }
        let Some(next) = self.pending.take() else {
            return;
        };
        self.current_ssrc.store(next.ssrc, Ordering::Relaxed);
        self.current = Some(next);
        self.switch_source();
        self.send(&packet).await;
    }

    async fn on_tick(&mut self, layers: &[WebcamLayer], quality: WebcamQuality) {
        let now = Instant::now();
        if let Some(pending) = self.pending.as_mut() {
            if now.duration_since(pending.joined) >= SWITCH_TIMEOUT {
                self.pending = None;
            } else if now.duration_since(pending.last_pli) >= SWITCH_PLI_INTERVAL {
                pending.last_pli = now;
                let ssrc = pending.ssrc;
                self.request_keyframe(ssrc).await;
            }
        }
        let Some(current) = self.current.as_ref() else {
            return;
        };
        let (current_rid, current_ssrc) = (current.rid.clone(), current.ssrc);
        let stalled = now.duration_since(current.last_packet) >= LAYER_STALL;

        if self.last_pli.elapsed() >= PERIODIC_PLI_INTERVAL {
            self.last_pli = now;
            self.request_keyframe(current_ssrc).await;
        }
        if self.pending.is_some() {
            return;
        }
        if stalled {
            let fallback = choose_layer(layers, quality, Some(&current_rid));
            if fallback.as_ref().is_some_and(|l| l.rid != current_rid) {
                self.head_for(fallback).await;
            }
        } else if now.duration_since(self.last_retry) >= RETRY_WANTED_LAYER {
            // Moved off what they asked for by a stall: see if it is back.
            let wanted = choose_layer(layers, quality, None);
            if wanted.as_ref().is_some_and(|l| l.rid != current_rid) {
                self.last_retry = now;
                self.head_for(wanted).await;
            }
        }
    }
}

/// Forward one camera to one viewer until the subscription or the camera ends
/// (teardown aborts the task).
async fn forward_webcam(
    mut fwd: WebcamForwarder,
    mut layers_rx: watch::Receiver<Vec<WebcamLayer>>,
    mut quality_rx: watch::Receiver<WebcamQuality>,
) {
    let mut tick = tokio::time::interval(FORWARDER_TICK);
    let target = choose_layer(
        &layers_rx.borrow_and_update(),
        *quality_rx.borrow_and_update(),
        None,
    );
    fwd.head_for(target).await;

    loop {
        tokio::select! {
            changed = quality_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let target = choose_layer(&layers_rx.borrow(), *quality_rx.borrow(), None);
                fwd.head_for(target).await;
            }
            changed = layers_rx.changed() => {
                if changed.is_err() {
                    break;
                }
                let target = choose_layer(&layers_rx.borrow(), *quality_rx.borrow(), None);
                fwd.head_for(target).await;
            }
            _ = tick.tick() => {
                let layers = layers_rx.borrow().clone();
                let quality = *quality_rx.borrow();
                fwd.on_tick(&layers, quality).await;
            }
            received = recv_from(&mut fwd.current) => match received {
                Ok(packet) => {
                    if let Some(current) = fwd.current.as_mut() {
                        current.last_packet = Instant::now();
                    }
                    fwd.send(&packet).await;
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    METRICS.record_lagged(MediaKind::Webcam, skipped);
                    if skipped >= LAGGED_PACKET_THRESHOLD_FOR_PLI
                        && fwd.last_pli.elapsed() >= PLI_COOLDOWN
                    {
                        fwd.last_pli = Instant::now();
                        if let Some(ssrc) = fwd.current.as_ref().map(|c| c.ssrc) {
                            fwd.request_keyframe(ssrc).await;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            received = recv_from(&mut fwd.pending) => match received {
                Ok(packet) => fwd.on_pending_packet(packet).await,
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => fwd.pending = None,
            },
        }
    }
}
