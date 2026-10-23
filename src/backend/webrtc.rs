use super::state::AppState;
use rtcp::{
    packet::Packet as RtcpPacket,
    payload_feedbacks::{
        full_intra_request::{FirEntry, FullIntraRequest},
        picture_loss_indication::PictureLossIndication,
    },
};
use serde_json::{json, Value};
use std::sync::Arc;
use webrtc::{
    api::{
        interceptor_registry::register_default_interceptors, media_engine::MediaEngine,
        setting_engine::SettingEngine, APIBuilder, API,
    },
    ice::{
        network_type::NetworkType,
        udp_mux::{UDPMuxDefault, UDPMuxParams},
        udp_network::UDPNetwork,
    },
    ice_transport::{
        ice_candidate::RTCIceCandidateInit, ice_candidate_type::RTCIceCandidateType,
        ice_credential_type::RTCIceCredentialType, ice_server::RTCIceServer,
    },
    interceptor::registry::Registry,
    peer_connection::{configuration::RTCConfiguration, RTCPeerConnection},
    rtp_transceiver::rtp_codec::{RTCRtpHeaderExtensionCapability, RTPCodecType},
};

/// RFC 6464 audio level. Every browser sends it on audio by default.
pub(crate) const AUDIO_LEVEL_EXTENSION_URI: &str = "urn:ietf:params:rtp-hdrext:ssrc-audio-level";

/// Port every peer connection is multiplexed onto unless `WEBRTC_UDP_PORT`
/// says otherwise. Matches the HTTP listener's port number — UDP and TCP are
/// separate spaces, so nothing collides — which means the single mapping
/// deployments already publish covers media too.
const DEFAULT_WEBRTC_UDP_PORT: u16 = 8000;

pub(crate) fn parse_ice_candidate(value: &Value) -> Option<RTCIceCandidateInit> {
    let candidate = value.get("candidate")?.as_str()?.to_string();
    let sdp_mid = value
        .get("sdpMid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let sdp_mline_index = value
        .get("sdpMLineIndex")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok());
    let username_fragment = value
        .get("usernameFragment")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Some(RTCIceCandidateInit {
        candidate,
        sdp_mid,
        sdp_mline_index,
        username_fragment,
    })
}

/// Holds the server's ICE candidates back until the answer they belong to has
/// been sent.
///
/// Gathering starts inside `set_local_description`, and `on_ice_candidate`
/// sends from its own task, so candidates used to reach the client ahead of the
/// answer. A client cannot add a candidate before it has a remote description,
/// so it dropped them — and one that ended up with none of the server's
/// candidates never sent a connectivity check. Behind a NAT that is a
/// connection that never comes up and never reports failing either: someone in
/// the call who simply hears nothing, or is heard by nobody, until they rejoin.
#[derive(Default)]
pub(crate) struct CandidateGate {
    state: std::sync::Mutex<CandidateGateState>,
}

#[derive(Default)]
struct CandidateGateState {
    open: bool,
    held: Vec<Value>,
}

impl CandidateGate {
    /// Hand back a candidate message if it may go out now; otherwise keep it
    /// until `open`.
    pub(crate) fn pass(&self, message: Value) -> Option<Value> {
        let Ok(mut state) = self.state.lock() else {
            return Some(message);
        };
        if state.open {
            Some(message)
        } else {
            state.held.push(message);
            None
        }
    }

    /// Call once the answer has been queued to the client. Everything held
    /// comes back, to be sent in order; later candidates pass straight through.
    pub(crate) fn open(&self) -> Vec<Value> {
        let Ok(mut state) = self.state.lock() else {
            return Vec::new();
        };
        state.open = true;
        std::mem::take(&mut state.held)
    }
}

pub(crate) fn ice_candidate_to_json(candidate: &RTCIceCandidateInit) -> Value {
    json!({
        "candidate": candidate.candidate,
        "sdpMid": candidate.sdp_mid,
        "sdpMLineIndex": candidate.sdp_mline_index,
        "usernameFragment": candidate.username_fragment
    })
}

pub(crate) async fn build_webrtc_api() -> Arc<API> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_default_codecs()
        .expect("register_default_codecs failed");

    // Browsers already stamp every audio packet with how loud it is. Keeping
    // the extension through negotiation lets the SFU rank speakers by reading
    // a byte of RTP header, instead of decoding Opus it would otherwise only
    // ever forward.
    media_engine
        .register_header_extension(
            RTCRtpHeaderExtensionCapability {
                uri: AUDIO_LEVEL_EXTENSION_URI.to_string(),
            },
            RTPCodecType::Audio,
            None,
        )
        .expect("register audio level header extension failed");

    // A simulcast camera sends each of its encodings as its own stream, told
    // apart only by these: which m-line (`mid`) and which encoding (`rid`).
    // Without them negotiated, webrtc-rs cannot tell the layers apart and
    // refuses every stream after the first.
    for uri in [
        webrtc::sdp::extmap::SDES_MID_URI,
        webrtc::sdp::extmap::SDES_RTP_STREAM_ID_URI,
        webrtc::sdp::extmap::SDES_REPAIR_RTP_STREAM_ID_URI,
    ] {
        media_engine
            .register_header_extension(
                RTCRtpHeaderExtensionCapability {
                    uri: uri.to_string(),
                },
                RTPCodecType::Video,
                None,
            )
            .expect("register simulcast header extension failed");
    }

    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut media_engine)
        .expect("register_default_interceptors failed");

    let mut setting_engine = SettingEngine::default();

    // Carry every peer connection over one UDP socket. The default is an
    // ephemeral port per connection, which a large call exhausts long before
    // bandwidth becomes the limit — and it leaves nothing specific to open on
    // a firewall. Binding failure is not fatal: falling back to ephemeral
    // ports keeps small calls working on a host where the port is taken.
    let udp_port: u16 = std::env::var("WEBRTC_UDP_PORT")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(DEFAULT_WEBRTC_UDP_PORT);
    match tokio::net::UdpSocket::bind(("0.0.0.0", udp_port)).await {
        Ok(socket) => {
            #[cfg(windows)]
            disable_udp_connreset(&socket);
            println!("WebRTC: multiplexing peer connections over UDP port {udp_port}");
            setting_engine.set_udp_network(UDPNetwork::Muxed(UDPMuxDefault::new(
                UDPMuxParams::new(socket),
            )));
            // The socket is IPv4, so only IPv4 candidates can be reached on
            // it. Worse than useless, an IPv6 one cost packets: every local
            // candidate on the mux reads from the same shared connection, and
            // whichever reads a packet decides whether its sender is known —
            // looking it up among the remote candidates of *its own* network
            // type. An IPv6 candidate reading a browser's IPv4 packet finds
            // nothing and discards it. On a host with IPv6 (a link-local fe80
            // address is enough) that lost a large share of every inbound
            // stream, and the browsers sending them took the loss for
            // congestion and cut their bitrate to the floor.
            setting_engine.set_network_types(vec![NetworkType::Udp4]);
        }
        Err(e) => {
            eprintln!(
                "WebRTC: could not bind UDP port {udp_port} ({e}); \
                 falling back to an ephemeral port per connection"
            );
        }
    }

    // If WEBRTC_IP is set (e.g. the server's public IP), advertise it as a
    // server-reflexive candidate so remote peers can connect through NAT while
    // LAN peers can still connect via the local host candidate.
    if let Ok(ip) = std::env::var("WEBRTC_IP") {
        let ips: Vec<String> = ip
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !ips.is_empty() {
            println!(
                "WebRTC: advertising NAT 1:1 IPs as srflx candidates: {:?}",
                ips
            );
            setting_engine.set_nat_1to1_ips(ips, RTCIceCandidateType::Srflx);
        }
    }

    Arc::new(
        APIBuilder::new()
            .with_media_engine(media_engine)
            .with_interceptor_registry(registry)
            .with_setting_engine(setting_engine)
            .build(),
    )
}

/// Windows reports an ICMP "port unreachable" from an earlier send as
/// WSAECONNRESET on the socket's next receive. webrtc-ice's mux treats any
/// receive error but a timeout as fatal and stops reading, so one connectivity
/// check sent to a candidate nobody listens on (a peer that left, an address
/// that only exists on the other machine) silently ends all WebRTC on the
/// server. Linux doesn't report these on unconnected sockets; turn it off here.
#[cfg(windows)]
fn disable_udp_connreset(socket: &tokio::net::UdpSocket) {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::{WSAIoctl, SIO_UDP_CONNRESET, SOCKET};

    let report: u32 = 0; // FALSE
    let mut returned: u32 = 0;
    // SAFETY: a valid socket handle for the call's duration, an in-buffer of
    // the size given, no out-buffer, and a synchronous (non-overlapped) call.
    let rc = unsafe {
        WSAIoctl(
            socket.as_raw_socket() as SOCKET,
            SIO_UDP_CONNRESET,
            (&report as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
            None,
        )
    };
    if rc != 0 {
        eprintln!(
            "WebRTC: could not disable UDP connection-reset reports ({}); \
             an unreachable peer may stop all calls on this host",
            std::io::Error::last_os_error()
        );
    }
}

fn default_webrtc_config() -> RTCConfiguration {
    let mut ice_servers = vec![RTCIceServer {
        urls: vec!["stun:stun.l.google.com:19302".to_string()],
        ..Default::default()
    }];

    // Add TURN server if configured via environment variables.
    // Example: TURN_URL=turn:your-server.com:3478
    //          TURN_USERNAME=user
    //          TURN_PASSWORD=pass
    if let Ok(turn_url) = std::env::var("TURN_URL") {
        if !turn_url.is_empty() {
            let username = std::env::var("TURN_USERNAME").unwrap_or_default();
            let credential = std::env::var("TURN_PASSWORD").unwrap_or_default();
            ice_servers.push(RTCIceServer {
                urls: turn_url.split(',').map(|s| s.trim().to_string()).collect(),
                username,
                credential,
                credential_type: RTCIceCredentialType::Password,
            });
        }
    }

    RTCConfiguration {
        ice_servers,
        ..Default::default()
    }
}

/// The TURN addresses to hand a browser, from the ones configured.
///
/// Two things go wrong between a TURN URL that works for the server and one
/// that works for a client, and both left people unable to connect at all:
///
/// - The configured address is often only meaningful inside the deployment —
///   the compose file ships `turn:host.docker.internal:3478`, which no browser
///   can resolve. Without `TURN_PUBLIC_URL` that was handed out as-is, so the
///   relay that exists precisely for people behind strict NATs was unreachable
///   by every one of them. An internal-only host is replaced by the host the
///   client reached this server on, which is where the bundled coturn runs.
/// - A bare `turn:` URL is UDP. The networks that need a relay most — offices,
///   schools, hotel wifi — are the ones that block UDP outright, and the SFU
///   offers no TCP candidates of its own. Each UDP URL is therefore paired with
///   its `?transport=tcp` twin; coturn listens on both by default. The browser
///   tries UDP first, so this costs nothing where UDP works.
pub(crate) fn client_turn_urls(configured: &str, public_host: Option<&str>) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    let mut push = |url: String| {
        if !urls.contains(&url) {
            urls.push(url);
        }
    };
    for raw in configured.split(',') {
        let url = raw.trim();
        let Some((scheme, rest)) = url.split_once(':') else {
            continue;
        };
        if !matches!(scheme, "turn" | "turns") || rest.is_empty() {
            continue;
        }
        let (address, query) = match rest.split_once('?') {
            Some((address, query)) => (address, Some(query)),
            None => (rest, None),
        };
        let (host, port) = split_host_port(address);
        let host = match public_host {
            Some(public) if is_internal_host(host) => public,
            _ => host,
        };
        if is_internal_host(host) {
            // Nothing better to offer; a client cannot use this one.
            continue;
        }
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        let address = match port {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        match query {
            Some(query) => push(format!("{scheme}:{address}?{query}")),
            None => {
                push(format!("{scheme}:{address}"));
                if scheme == "turn" {
                    push(format!("{scheme}:{address}?transport=tcp"));
                }
            }
        }
    }
    urls
}

fn split_host_port(address: &str) -> (&str, Option<&str>) {
    if let Some(rest) = address.strip_prefix('[') {
        // [v6]:port
        if let Some((host, tail)) = rest.split_once(']') {
            return (host, tail.strip_prefix(':'));
        }
    }
    match address.rsplit_once(':') {
        // More than one colon and no brackets is a bare IPv6 address.
        Some((host, port)) if !host.contains(':') => (host, Some(port)),
        _ => (address, None),
    }
}

/// A hostname only the deployment itself can resolve or reach.
fn is_internal_host(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host == "host.docker.internal" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback() || ip.is_unspecified();
    }
    // A bare name with no dot is a compose service or container name.
    !host.contains('.')
}

/// The host a client knows this server by: `SERVER_URL` when it is set, else
/// what the request was addressed to.
pub(crate) fn public_host(headers: &axum::http::HeaderMap) -> Option<String> {
    let from_server_url = std::env::var("SERVER_URL").ok().and_then(|url| {
        let rest = url.trim().split_once("://").map(|(_, r)| r)?;
        let authority = rest.split(['/', '?', '#']).next()?;
        Some(authority.to_string())
    });
    let authority = from_server_url.or_else(|| {
        ["x-forwarded-host", "host"].iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(|v| v.trim().to_string())
        })
    })?;
    let (host, _) = split_host_port(&authority);
    let host = host.trim();
    (!host.is_empty() && !is_internal_host(host)).then(|| host.to_string())
}

pub(crate) async fn create_peer_connection(
    state: &AppState,
) -> Result<Arc<RTCPeerConnection>, webrtc::Error> {
    state
        .webrtc_api
        .new_peer_connection(default_webrtc_config())
        .await
        .map(Arc::new)
}

/// A publisher's packet, rebuilt to be sent on to a subscriber.
///
/// Header extension ids are negotiated per connection, so the publisher's
/// numbering means nothing on the subscriber's leg — and since a video
/// publisher's packets carry its `mid` (and, simulcast, its `rid`), passing
/// them through would tell the viewer's browser to route the packet to a
/// section or an encoding of the *publisher's* connection. Without them the
/// viewer routes by SSRC, which the server's SDP always declares. `payload` is
/// `Bytes`, so carrying it over is a refcount bump, not a copy.
pub(crate) fn relay_packet(
    packet: &rtp::packet::Packet,
    sequence_number: u16,
    timestamp: u32,
) -> rtp::packet::Packet {
    rtp::packet::Packet {
        header: rtp::header::Header {
            version: packet.header.version,
            padding: packet.header.padding,
            extension: false,
            marker: packet.header.marker,
            // Both overwritten per binding inside `write_rtp`; carried anyway
            // so the packet is coherent on its own.
            payload_type: packet.header.payload_type,
            ssrc: packet.header.ssrc,
            sequence_number,
            timestamp,
            csrc: packet.header.csrc.clone(),
            extension_profile: 0,
            extensions: Vec::new(),
            extensions_padding: 0,
        },
        payload: packet.payload.clone(),
    }
}

/// Forward only keyframe requests (PLI/FIR) from subscribers to the publisher.
/// NACKs are intentionally NOT forwarded: the server's default interceptors
/// cache recent RTP packets and handle retransmissions on each leg independently.
/// Forwarding subscriber NACKs to the publisher causes NACK amplification —
/// the publisher's browser interprets them as loss on its own upload path and
/// aggressively reduces bitrate/framerate.
pub(crate) fn rewrite_rtcp_feedback_for_publisher(
    packet: &(dyn RtcpPacket + Send + Sync),
    publisher_media_ssrc: u32,
) -> Option<Box<dyn RtcpPacket + Send + Sync>> {
    if packet
        .as_any()
        .downcast_ref::<PictureLossIndication>()
        .is_some()
    {
        return Some(Box::new(PictureLossIndication {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
        }));
    }

    if let Some(fir) = packet.as_any().downcast_ref::<FullIntraRequest>() {
        let rewritten_fir = fir
            .fir
            .iter()
            .map(|entry| FirEntry {
                ssrc: publisher_media_ssrc,
                sequence_number: entry.sequence_number,
            })
            .collect::<Vec<_>>();

        return Some(Box::new(FullIntraRequest {
            sender_ssrc: 0,
            media_ssrc: publisher_media_ssrc,
            fir: rewritten_fir,
        }));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        client_turn_urls, ice_candidate_to_json, parse_ice_candidate,
        rewrite_rtcp_feedback_for_publisher, CandidateGate,
    };
    use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
    use serde_json::json;

    #[test]
    fn candidate_gate_holds_until_the_answer_then_passes_through() {
        let gate = CandidateGate::default();
        assert!(gate.pass(json!(1)).is_none());
        assert!(gate.pass(json!(2)).is_none());
        assert_eq!(gate.open(), vec![json!(1), json!(2)], "held in order");
        assert_eq!(gate.pass(json!(3)), Some(json!(3)));
        assert!(gate.open().is_empty(), "nothing is released twice");
    }

    #[test]
    fn ice_candidate_round_trip_preserves_fields() {
        let source = json!({
            "candidate": "candidate:1 1 udp 2113937151 192.168.1.2 9999 typ host",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
            "usernameFragment": "ufrag"
        });

        let parsed = parse_ice_candidate(&source).expect("candidate should parse");
        let json_value = ice_candidate_to_json(&parsed);

        assert_eq!(json_value["candidate"], source["candidate"]);
        assert_eq!(json_value["sdpMid"], source["sdpMid"]);
        assert_eq!(json_value["sdpMLineIndex"], source["sdpMLineIndex"]);
        assert_eq!(json_value["usernameFragment"], source["usernameFragment"]);
    }

    #[test]
    fn rewrite_rtcp_feedback_updates_media_ssrc() {
        let pli = PictureLossIndication {
            sender_ssrc: 42,
            media_ssrc: 7,
        };

        let rewritten = rewrite_rtcp_feedback_for_publisher(&pli, 100).expect("should rewrite");
        let rewritten_pli = rewritten
            .as_any()
            .downcast_ref::<PictureLossIndication>()
            .expect("should stay PLI");

        assert_eq!(rewritten_pli.sender_ssrc, 0);
        assert_eq!(rewritten_pli.media_ssrc, 100);
    }

    #[test]
    fn turn_urls_gain_a_tcp_twin() {
        assert_eq!(
            client_turn_urls("turn:turn.example.com:3478", None),
            vec![
                "turn:turn.example.com:3478",
                "turn:turn.example.com:3478?transport=tcp"
            ]
        );
    }

    #[test]
    fn explicit_transports_and_turns_are_left_alone() {
        assert_eq!(
            client_turn_urls(
                "turn:t.example.com:3478?transport=udp, turns:t.example.com:5349",
                None
            ),
            vec![
                "turn:t.example.com:3478?transport=udp",
                "turns:t.example.com:5349"
            ]
        );
    }

    #[test]
    fn an_internal_turn_host_becomes_the_public_one() {
        assert_eq!(
            client_turn_urls("turn:host.docker.internal:3478", Some("chat.example.com")),
            vec![
                "turn:chat.example.com:3478",
                "turn:chat.example.com:3478?transport=tcp"
            ]
        );
        assert_eq!(
            client_turn_urls("turn:coturn:3478", Some("chat.example.com"))[0],
            "turn:chat.example.com:3478"
        );
    }

    #[test]
    fn an_internal_turn_host_with_nothing_to_replace_it_is_dropped() {
        assert!(client_turn_urls("turn:host.docker.internal:3478", None).is_empty());
    }

    #[test]
    fn public_ip_hosts_are_kept() {
        assert_eq!(
            client_turn_urls("turn:203.0.113.5:3478", Some("chat.example.com"))[0],
            "turn:203.0.113.5:3478"
        );
    }
}
