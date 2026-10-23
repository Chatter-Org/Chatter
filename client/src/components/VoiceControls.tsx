import { useRef, useEffect, useState } from "react";
import { useAppContext } from "@/lib/store";
import { useWebRTCVoice } from "@/hooks/useWebRTCVoice";
import { useWebRTCScreen } from "@/hooks/useWebRTCScreen";
import { useWebRTCWebcam } from "@/hooks/useWebRTCWebcam";
import { useConnectionStats } from "@/hooks/useConnectionStats";
import { useSpeakingDetection } from "@/hooks/useSpeakingDetection";
import type { VoiceRestoreState } from "@/lib/voiceRejoin";
import { CameraSelectModal } from "./CameraSelectModal";
import { scoreCallQuality } from "@chatter/core/voice/quality";

export type ConnectionQuality = 0 | 1 | 2 | 3 | 4;
export interface ConnQualityData { quality: ConnectionQuality; pingMs: number | null; }

interface VoiceControlsProps {
  joinVoiceRef?: React.MutableRefObject<
    ((channelId?: string, restore?: VoiceRestoreState) => void) | null
  >;
  leaveVoiceRef?: React.MutableRefObject<(() => void) | null>;
  releaseVoiceRef?: React.MutableRefObject<(() => void) | null>;
  toggleMuteRef?: React.MutableRefObject<(() => void) | null>;
  toggleDeafenRef?: React.MutableRefObject<(() => void) | null>;
  startScreenShareRef?: React.MutableRefObject<(() => void) | null>;
  stopScreenShareRef?: React.MutableRefObject<(() => void) | null>;
  startWebcamRef?: React.MutableRefObject<(() => void) | null>;
  stopWebcamRef?: React.MutableRefObject<(() => void) | null>;
  connQualityRef?: React.MutableRefObject<ConnQualityData>;
  setUserVolumeRef?: React.MutableRefObject<((userId: string, vol: number) => void) | null>;
  speakingUsersRef?: React.MutableRefObject<Set<string>>;
}

function computeQuality(connStats: Record<string, import("@/lib/webrtc").PeerStats>): ConnectionQuality {
  // The scoring is shared with the mobile app (@chatter/core/voice/quality).
  const pub = connStats["voice-pub"];
  return scoreCallQuality(pub && { connectionState: pub.connectionState, rtt: pub.rtt, audioJitter: pub.audioJitter, audioPacketsLost: pub.audioPacketsLost });
}

export function VoiceControls({ joinVoiceRef, leaveVoiceRef, releaseVoiceRef, toggleMuteRef, toggleDeafenRef, startScreenShareRef, stopScreenShareRef, startWebcamRef, stopWebcamRef, connQualityRef, setUserVolumeRef, speakingUsersRef }: VoiceControlsProps) {
  const { state } = useAppContext();
  const [cameraModalOpen, setCameraModalOpen] = useState(false);

  // Cross-hook cleanup coordination
  const cleanupScreenRef = useRef(async () => {});

  const voice = useWebRTCVoice({ cleanupScreenRef });
  const screen = useWebRTCScreen();
  const webcam = useWebRTCWebcam();

  // Expose voice actions to parent via refs
  useEffect(() => {
    if (joinVoiceRef) joinVoiceRef.current = voice.joinVoice;
    return () => { if (joinVoiceRef) joinVoiceRef.current = null; };
  }, [joinVoiceRef, voice.joinVoice]);

  useEffect(() => {
    if (leaveVoiceRef) leaveVoiceRef.current = voice.leaveVoice;
    return () => { if (leaveVoiceRef) leaveVoiceRef.current = null; };
  }, [leaveVoiceRef, voice.leaveVoice]);

  useEffect(() => {
    if (releaseVoiceRef) releaseVoiceRef.current = voice.releaseVoice;
    return () => { if (releaseVoiceRef) releaseVoiceRef.current = null; };
  }, [releaseVoiceRef, voice.releaseVoice]);

  useEffect(() => {
    if (toggleMuteRef) toggleMuteRef.current = voice.toggleMute;
    return () => { if (toggleMuteRef) toggleMuteRef.current = null; };
  }, [toggleMuteRef, voice.toggleMute]);

  useEffect(() => {
    if (toggleDeafenRef) toggleDeafenRef.current = voice.toggleDeafen;
    return () => { if (toggleDeafenRef) toggleDeafenRef.current = null; };
  }, [toggleDeafenRef, voice.toggleDeafen]);

  useEffect(() => {
    if (startScreenShareRef) startScreenShareRef.current = screen.startScreenShare;
    return () => { if (startScreenShareRef) startScreenShareRef.current = null; };
  }, [startScreenShareRef, screen.startScreenShare]);

  useEffect(() => {
    if (stopScreenShareRef) stopScreenShareRef.current = screen.stopScreenShare;
    return () => { if (stopScreenShareRef) stopScreenShareRef.current = null; };
  }, [stopScreenShareRef, screen.stopScreenShare]);

  useEffect(() => {
    if (startWebcamRef) startWebcamRef.current = () => setCameraModalOpen(true);
    return () => { if (startWebcamRef) startWebcamRef.current = null; };
  }, [startWebcamRef]);

  useEffect(() => {
    if (stopWebcamRef) stopWebcamRef.current = webcam.stopWebcam;
    return () => { if (stopWebcamRef) stopWebcamRef.current = null; };
  }, [stopWebcamRef, webcam.stopWebcam]);

  useEffect(() => {
    if (setUserVolumeRef) setUserVolumeRef.current = voice.setUserVolume;
    return () => { if (setUserVolumeRef) setUserVolumeRef.current = null; };
  }, [setUserVolumeRef, voice.setUserVolume]);

  // Wire up the cleanup ref after both hooks are initialized
  cleanupScreenRef.current = async () => {
    await screen.fullCleanup();
    await webcam.fullCleanup();
  };

  // Connection stats polling
  const connStats = useConnectionStats(state.inVoiceChannel, {
    voicePublisherPcRef: voice.voicePublisherPcRef,
    voiceSubscriberPcRef: voice.voiceSubscriberPcRef,
    screenPubPcRef: screen.screenPubPcRef,
    screenSubPcsRef: screen.screenSubPcsRef,
  });

  // Feed stats to screen hook for frozen detection
  useEffect(() => {
    screen.updateConnStats(connStats);
  }, [connStats, screen.updateConnStats]);

  // Expose connection quality to parent — update on every render so the ref
  // is always fresh (the ChannelList polls this ref via setInterval).
  if (connQualityRef) {
    const pub = connStats["voice-pub"];
    const pingMs = pub?.rtt != null ? Math.round(pub.rtt * 1000) : null;
    connQualityRef.current = {
      quality: state.inVoiceChannel ? computeQuality(connStats) : 0,
      pingMs: state.inVoiceChannel ? pingMs : null,
    };
  }

  // Speaking detection
  const speakingUsers = useSpeakingDetection(
    state.inVoiceChannel,
    state.userId,
    voice.micRef,
  );
  // Expose to parent (e.g. ChannelList speaking indicator)
  if (speakingUsersRef) speakingUsersRef.current = speakingUsers;

  // Nothing of the call is drawn here: its controls are the channel list's
  // panel and the layout's voice bar. This component stays mounted, hidden,
  // because it owns the call's peer connections — it only draws the camera
  // picker the controls open.
  return (
    <CameraSelectModal
      open={cameraModalOpen}
      onClose={() => setCameraModalOpen(false)}
      onStart={(deviceId, fps, blur) => webcam.startWebcam(deviceId, fps, blur)}
    />
  );
}
