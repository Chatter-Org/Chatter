import { useCallback, useRef, useEffect } from "react";
import { useAppContext, webcamStreamsMap } from "@/lib/store";
import {
  getWebRTCConfig,
  SCREEN_SUBSCRIBE_RETRY_MS,
  VOICE_SUB_STUCK_NEW_MS,
  VOICE_SUB_STUCK_CONNECTING_MS,
  VOICE_CONNECT_TIMEOUT_MS,
  canSignal,
  candidatesAfterOffer,
  getWebcamPublishProfile,
  webcamEncodings,
} from "@/lib/webrtc";
import type { WebcamPublishProfile, WebcamQuality } from "@/lib/webrtc";
import { toast } from "sonner";
import type { BlurredCamera } from "@/lib/backgroundBlur";
import { decodeCameraBackground, readAvatar, type CameraEffect } from "@/lib/cameraBackgrounds";

function buildWebcamVideoConstraints(
  profile: WebcamPublishProfile,
  deviceId?: string,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: profile.targetFps },
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

async function tuneWebcamVideoSender(
  sender: RTCRtpSender,
  profile: WebcamPublishProfile,
) {
  try {
    const params = sender.getParameters();
    // Simulcast has an encoding per rid, each with its own ceiling; a camera
    // sent as one has a single encoding with none. The count cannot change
    // here, only what each one carries.
    const byRid = new Map(webcamEncodings(profile).map((e) => [e.rid as string, e]));
    const current = params.encodings?.length ? params.encodings : [{}];
    params.encodings = current.map((encoding) => {
      const wanted = encoding.rid ? byRid.get(encoding.rid) : undefined;
      return {
        ...encoding,
        maxBitrate: wanted?.maxBitrate ?? profile.maxBitrateBps,
        maxFramerate: wanted?.maxFramerate ?? profile.targetFps,
      };
    });
    // A camera picked for 60fps is being picked for smooth motion, so shed
    // resolution before frames when the network tightens.
    params.degradationPreference = "maintain-framerate";
    await sender.setParameters(params);
  } catch {
    // Browsers differ in which sender parameters are writable.
  }
}

/**
 * Adds the camera to `pc` as a simulcast pair — full size and a quarter — so
 * the server can give each viewer the one their tile needs. VP8 is preferred:
 * it is the codec whose own frame numbering the server keeps continuous when
 * it moves a viewer between the two. A browser that refuses simulcast gets
 * the camera as one encoding, which every viewer is then given.
 */
function addCameraSender(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
  profile: WebcamPublishProfile,
): RTCRtpSender {
  let transceiver: RTCRtpTransceiver;
  try {
    transceiver = pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [stream],
      sendEncodings: webcamEncodings(profile),
    });
  } catch {
    return pc.addTrack(track, stream);
  }
  try {
    const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs ?? [];
    const isVp8 = (c: { mimeType: string }) => c.mimeType.toLowerCase() === "video/vp8";
    if (codecs.some(isVp8)) {
      transceiver.setCodecPreferences([
        ...codecs.filter(isVp8),
        ...codecs.filter((c) => !isVp8(c)),
      ]);
    }
  } catch {
    // Codec preferences are a preference; the browser's own order still works.
  }
  return transceiver.sender;
}

export function useWebRTCWebcam() {
  const { state, dispatch, wsRef } = useAppContext();

  const webcamStreamRef = useRef<MediaStream | null>(null);
  // The blur, background image or avatar between the camera and the call, when one is on.
  const blurRef = useRef<BlurredCamera | null>(null);
  const webcamPubPcRef = useRef<RTCPeerConnection | null>(null);
  const webcamSubPcsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const webcamRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingWebcamSubsRef = useRef<Set<string>>(new Set());
  const webcamStartingRef = useRef(false);
  // What the viewer wants of each camera, from the size it is drawn at (the
  // viewer says, with a "webcam-quality" event). Sent with the subscription
  // and whenever it changes.
  const qualityWishRef = useRef<Map<string, WebcamQuality>>(new Map());
  // Profile of the stream currently being published, so the publish answer
  // handler can re-apply sender parameters browsers reset on renegotiation.
  const webcamProfileRef = useRef<WebcamPublishProfile>(getWebcamPublishProfile(30));

  const currentRoomRef = useRef(state.currentRoomId);
  const voiceRoomIdRef = useRef(state.voiceRoomId);
  const inVoiceChannelRef = useRef(state.inVoiceChannel);
  const activeWebcamStreamersRef = useRef(state.activeWebcamStreamers);
  // The viewer being open is what consents to a subscription — see the same
  // ref in useWebRTCScreen.
  const screenViewerOpenRef = useRef(state.screenViewerOpen);
  useEffect(() => { currentRoomRef.current = state.currentRoomId; }, [state.currentRoomId]);
  useEffect(() => { voiceRoomIdRef.current = state.voiceRoomId; }, [state.voiceRoomId]);
  useEffect(() => { inVoiceChannelRef.current = state.inVoiceChannel; }, [state.inVoiceChannel]);
  useEffect(() => { activeWebcamStreamersRef.current = state.activeWebcamStreamers; }, [state.activeWebcamStreamers]);
  useEffect(() => { screenViewerOpenRef.current = state.screenViewerOpen; }, [state.screenViewerOpen]);
  // The camera belongs to the call, so its frames name the call's room — not
  // whichever room is on screen, which announced it to the wrong room when it
  // was turned on from the voice bar while reading elsewhere.
  const callRoomId = () => voiceRoomIdRef.current || currentRoomRef.current;

  const ensureWebcamSub = (sharerId: string) => {
    if (!canSignal(wsRef) || sharerId === state.userId) return;
    if (webcamSubPcsRef.current.has(sharerId) || pendingWebcamSubsRef.current.has(sharerId)) return;

    const pc = new RTCPeerConnection(getWebRTCConfig());
    webcamSubPcsRef.current.set(sharerId, pc);
    pendingWebcamSubsRef.current.add(sharerId);

    pc.onicecandidate = (ev) => {
      if (!ev.candidate || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "webcam_webrtc_subscribe_candidate",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        candidate: ev.candidate.toJSON(),
      }));
    };

    pc.ontrack = (ev) => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      let stream = webcamStreamsMap.get(sharerId);
      if (stream) {
        if (ev.track && !stream.getTrackById(ev.track.id)) {
          stream.addTrack(ev.track);
        }
      } else {
        stream = ev.streams[0] || new MediaStream([ev.track]);
        webcamStreamsMap.set(sharerId, stream);
      }
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    };

    pc.onconnectionstatechange = () => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        try { pc.close(); } catch { /* noop */ }
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        webcamStreamsMap.delete(sharerId);
        window.dispatchEvent(new CustomEvent("webcam-stream-update"));
        scheduleWebcamRetry(sharerId);
      }
    };

    setTimeout(() => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "new") {
        try { pc.close(); } catch {}
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        scheduleWebcamRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_NEW_MS);

    setTimeout(() => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      if (pc.connectionState === "connecting") {
        try { pc.close(); } catch {}
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        scheduleWebcamRetry(sharerId);
      }
    }, VOICE_SUB_STUCK_CONNECTING_MS);

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.createOffer().then(async (offer) => {
      if (pc !== webcamSubPcsRef.current.get(sharerId)) return;
      await pc.setLocalDescription(offer);
      if (!canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "webcam_webrtc_subscribe_offer",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        sdp: offer.sdp,
        quality: qualityWishRef.current.get(sharerId) ?? "high",
      }));
    }).catch(() => {
      try { pc.close(); } catch {}
      webcamSubPcsRef.current.delete(sharerId);
      pendingWebcamSubsRef.current.delete(sharerId);
      scheduleWebcamRetry(sharerId);
    });
  };

  const scheduleWebcamRetry = (sharerId: string) => {
    if (webcamRetryTimersRef.current.has(sharerId)) return;
    if (webcamSubPcsRef.current.has(sharerId)) return;

    const timer = setTimeout(() => {
      webcamRetryTimersRef.current.delete(sharerId);
      if (
        inVoiceChannelRef.current &&
        screenViewerOpenRef.current &&
        activeWebcamStreamersRef.current.includes(sharerId) &&
        sharerId !== state.userId &&
        !webcamSubPcsRef.current.has(sharerId) &&
        !pendingWebcamSubsRef.current.has(sharerId)
      ) {
        ensureWebcamSub(sharerId);
      }
    }, SCREEN_SUBSCRIBE_RETRY_MS);

    webcamRetryTimersRef.current.set(sharerId, timer);
  };

  const stopWebcam = useCallback(async () => {
    dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: false } });
    if (state.userId) {
      dispatch({ type: "WEBCAM_SHARE_STOPPED", payload: state.userId });
      webcamStreamsMap.delete(state.userId);
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    }
    if (webcamPubPcRef.current) { webcamPubPcRef.current.close(); webcamPubPcRef.current = null; }
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      webcamStreamRef.current = null;
    }
    blurRef.current?.stop();
    blurRef.current = null;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      const msg: any = { type: "webcam_share_stop", room_id: callRoomId() };
      if (state.voiceChannelId) msg.channel_id = state.voiceChannelId;
      wsRef.current.send(JSON.stringify(msg));
    }
  }, [state.currentRoomId, state.userId, state.voiceChannelId, dispatch, wsRef]);
  // For callbacks that outlive the render they were made in, like the
  // publisher's connection watch.
  const stopWebcamRef = useRef(stopWebcam);
  stopWebcamRef.current = stopWebcam;

  // WS message handler
  useEffect(() => {
    const handler = async (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg.type === "webcam_webrtc_publish_answer" && webcamPubPcRef.current) {
        try {
          await webcamPubPcRef.current.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          // Some browsers reset encodings when the answer is applied.
          const videoSender = webcamPubPcRef.current.getSenders().find(
            (s) => s.track?.kind === "video",
          );
          if (videoSender) {
            await tuneWebcamVideoSender(videoSender, webcamProfileRef.current);
          }
        } catch { /* noop */ }
      } else if (msg.type === "webcam_webrtc_publish_candidate" && webcamPubPcRef.current) {
        try { await webcamPubPcRef.current.addIceCandidate(msg.candidate); } catch { /* noop */ }
      } else if (msg.type === "webcam_webrtc_subscribe_answer") {
        const pc = webcamSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.sdp) {
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            pendingWebcamSubsRef.current.delete(msg.sharer_user_id);
          } catch { /* noop */ }
        }
      } else if (msg.type === "webcam_webrtc_subscribe_candidate") {
        const pc = webcamSubPcsRef.current.get(msg.sharer_user_id);
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch { /* noop */ }
        }
      } else if (msg.type === "webcam_webrtc_publisher_ready") {
        if (state.inVoiceChannel && screenViewerOpenRef.current && msg.user_id !== state.userId) {
          const sharerId = msg.user_id;
          const oldPc = webcamSubPcsRef.current.get(sharerId);
          if (oldPc) {
            try { oldPc.close(); } catch { /* noop */ }
            webcamSubPcsRef.current.delete(sharerId);
          }
          pendingWebcamSubsRef.current.delete(sharerId);
          webcamStreamsMap.delete(sharerId);
          const timer = webcamRetryTimersRef.current.get(sharerId);
          if (timer) {
            clearTimeout(timer);
            webcamRetryTimersRef.current.delete(sharerId);
          }
          ensureWebcamSub(sharerId);
        }
      } else if (msg.type === "webcam_webrtc_error") {
        console.warn("[webcam] WebRTC error:", msg.detail || msg);
        if (msg.scope === "subscribe" && msg.sharer_user_id) {
          const failedPc = webcamSubPcsRef.current.get(msg.sharer_user_id);
          if (failedPc) {
            try { failedPc.close(); } catch { /* noop */ }
            webcamSubPcsRef.current.delete(msg.sharer_user_id);
          }
          pendingWebcamSubsRef.current.delete(msg.sharer_user_id);
          webcamStreamsMap.delete(msg.sharer_user_id);
          scheduleWebcamRetry(msg.sharer_user_id);
        } else if (msg.scope === "publish") {
          void stopWebcam();
        }
      }
    };

    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [state.inVoiceChannel, state.userId, state.currentRoomId, stopWebcam]);

  // The viewer asking for a camera at the size it now draws it. A camera not
  // yet subscribed picks it up from the wish when it is.
  useEffect(() => {
    const handler = (e: Event) => {
      const { sharerId, quality } = (e as CustomEvent<{ sharerId: string; quality: WebcamQuality }>).detail;
      if (qualityWishRef.current.get(sharerId) === quality) return;
      qualityWishRef.current.set(sharerId, quality);
      if (!webcamSubPcsRef.current.has(sharerId) || !canSignal(wsRef)) return;
      wsRef.current!.send(JSON.stringify({
        type: "webcam_webrtc_set_quality",
        room_id: voiceRoomIdRef.current || currentRoomRef.current,
        sharer_user_id: sharerId,
        quality,
      }));
    };
    window.addEventListener("webcam-quality", handler);
    return () => window.removeEventListener("webcam-quality", handler);
  }, [wsRef]);

  // Subscribe to webcam streams from other users — only once the viewer is
  // open, so a camera nobody asked to watch is never pulled down.
  useEffect(() => {
    const wanted =
      state.inVoiceChannel && state.screenViewerOpen ? state.activeWebcamStreamers : [];

    for (const sharerId of wanted) {
      if (
        sharerId !== state.userId &&
        !webcamSubPcsRef.current.has(sharerId) &&
        !pendingWebcamSubsRef.current.has(sharerId) &&
        !webcamRetryTimersRef.current.has(sharerId)
      ) {
        ensureWebcamSub(sharerId);
      }
    }
    let dropped = false;
    webcamSubPcsRef.current.forEach((pc, sharerId) => {
      if (!wanted.includes(sharerId)) {
        pc.close();
        webcamSubPcsRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
        webcamStreamsMap.delete(sharerId);
        dropped = true;
      }
    });
    webcamRetryTimersRef.current.forEach((timer, sharerId) => {
      if (!wanted.includes(sharerId)) {
        clearTimeout(timer);
        webcamRetryTimersRef.current.delete(sharerId);
        pendingWebcamSubsRef.current.delete(sharerId);
      }
    });
    if (dropped) window.dispatchEvent(new CustomEvent("webcam-stream-update"));
  }, [state.activeWebcamStreamers, state.inVoiceChannel, state.screenViewerOpen, state.userId]);

  // Notify viewer when streams change
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("webcam-stream-update"));
  }, [state.activeWebcamStreamers]);

  // Auto-close viewer when no more webcam or screen streams
  useEffect(() => {
    if (state.activeWebcamStreamers.length === 0) {
      webcamStreamsMap.forEach((_stream, id) => {
        if (!state.activeWebcamStreamers.includes(id)) {
          webcamStreamsMap.delete(id);
        }
      });
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
    }
  }, [state.activeWebcamStreamers]);

  const startWebcam = useCallback(async (deviceId?: string, fps: 30 | 60 = 30, effect: CameraEffect = { kind: "none" }) => {
    if (!state.inVoiceChannel || !canSignal(wsRef)) return;
    if (webcamStartingRef.current) return;
    webcamStartingRef.current = true;
    const profile = getWebcamPublishProfile(fps);
    webcamProfileRef.current = profile;
    try {
      const videoConstraints = buildWebcamVideoConstraints(profile, deviceId);

      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
      webcamStreamRef.current = stream;
      // `stream` stays the camera itself — it is what is stopped, and what
      // says when the camera is unplugged. `sent` is what the call sees.
      let sent = stream;
      if (effect.kind === "avatar") {
        // Unlike the background effects, an avatar that fails stops the
        // camera here (the catch below): the face is not for sharing.
        const [{ startAvatarCamera }, model, image] = await Promise.all([
          import("@/lib/avatarCamera"),
          readAvatar(effect.id),
          effect.backgroundSrc ? decodeCameraBackground(effect.backgroundSrc) : undefined,
        ]);
        blurRef.current = await startAvatarCamera(stream.getVideoTracks()[0], profile.targetFps, model, image);
        sent = new MediaStream([blurRef.current.track]);
      } else if (effect.kind !== "none") {
        try {
          const [{ blurBackground }, image] = await Promise.all([
            import("@/lib/backgroundBlur"),
            effect.kind === "image" ? decodeCameraBackground(effect.src) : undefined,
          ]);
          blurRef.current = await blurBackground(stream.getVideoTracks()[0], profile.targetFps, image);
          sent = new MediaStream([blurRef.current.track]);
        } catch (err) {
          console.warn("[webcam] background effect unavailable:", err);
          toast.error("Background effects aren't available here, so your camera is on without one.");
        }
      }
      webcamStreamsMap.set(state.userId!, sent);
      window.dispatchEvent(new CustomEvent("webcam-stream-update"));
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: true } });
      dispatch({ type: "WEBCAM_SHARE_STARTED", payload: state.userId! });
      // Open the viewer to show the webcam
      dispatch({ type: "SET_SCREEN_VIEWER", payload: { open: true } });

      if (canSignal(wsRef)) {
        const startMsg: any = { type: "webcam_share_start", room_id: callRoomId() };
        if (state.voiceChannelId) startMsg.channel_id = state.voiceChannelId;
        wsRef.current!.send(JSON.stringify(startMsg));
      }

      const cameraTrack = stream.getVideoTracks()[0];
      cameraTrack.onended = () => {
        if (webcamStreamRef.current === stream) stopWebcam();
      };
      const videoTrack = sent.getVideoTracks()[0];
      if ("contentHint" in videoTrack) {
        videoTrack.contentHint = profile.contentHint;
      }

      const pc = new RTCPeerConnection(getWebRTCConfig());
      webcamPubPcRef.current = pc;
      const videoSender = addCameraSender(pc, videoTrack, sent, profile);
      await tuneWebcamVideoSender(videoSender, profile);

      // None before the offer; see `candidatesAfterOffer`.
      const trickle = candidatesAfterOffer<RTCIceCandidate>((c) => {
        if (!canSignal(wsRef)) return;
        wsRef.current!.send(JSON.stringify({
          type: "webcam_webrtc_publish_candidate",
          room_id: callRoomId(),
          channel_id: state.voiceChannelId || undefined,
          candidate: c.toJSON(),
        }));
      });
      pc.onicecandidate = (ev) => {
        if (ev.candidate) trickle.add(ev.candidate);
      };
      // The sharer's own preview looks fine whether or not anyone receives
      // it, so a camera that fails, or never connects, is turned off and
      // they are told.
      const giveUp = (message: string) => {
        if (webcamPubPcRef.current !== pc) return;
        console.warn(`[webcam] ${message} (connection ${pc.connectionState})`);
        toast.error(message);
        void stopWebcamRef.current();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") giveUp("Your camera lost its connection. Try turning it on again.");
      };
      setTimeout(() => {
        if (pc.connectionState === "new" || pc.connectionState === "connecting") {
          giveUp("Your camera couldn't connect. Try turning it on again.");
        }
      }, VOICE_CONNECT_TIMEOUT_MS);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await tuneWebcamVideoSender(videoSender, profile);

      if (canSignal(wsRef)) {
        wsRef.current!.send(JSON.stringify({
          type: "webcam_webrtc_publish_offer",
          room_id: callRoomId(),
          channel_id: state.voiceChannelId || undefined,
          sdp: offer.sdp,
        }));
        trickle.offerSent();
      }
    } catch (err: unknown) {
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: false } });
      if (webcamStreamRef.current) {
        webcamStreamRef.current.getTracks().forEach((t) => { t.onended = null; t.stop(); });
        webcamStreamRef.current = null;
      }
      blurRef.current?.stop();
      blurRef.current = null;
      if (webcamPubPcRef.current) { webcamPubPcRef.current.close(); webcamPubPcRef.current = null; }
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        const message = err instanceof Error ? err.message : "Unknown error";
        toast.error("Could not start webcam: " + message);
      }
    } finally {
      webcamStartingRef.current = false;
    }
  }, [state.inVoiceChannel, state.currentRoomId, state.userId, state.voiceChannelId, dispatch, stopWebcam, wsRef]);

  const fullCleanup = useCallback(async () => {
    if (state.isWebcamActive) await stopWebcam();
    webcamSubPcsRef.current.forEach((pc) => pc.close());
    webcamSubPcsRef.current.clear();
    webcamRetryTimersRef.current.forEach((t) => clearTimeout(t));
    webcamRetryTimersRef.current.clear();
    pendingWebcamSubsRef.current.clear();
    webcamStreamsMap.clear();
    window.dispatchEvent(new CustomEvent("webcam-stream-update"));
  }, [state.isWebcamActive, stopWebcam]);

  return {
    webcamPubPcRef,
    webcamSubPcsRef,
    startWebcam,
    stopWebcam,
    fullCleanup,
  };
}
