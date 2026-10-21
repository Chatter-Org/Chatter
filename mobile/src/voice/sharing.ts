import { mediaDevices, type MediaStream, type MediaStreamTrack } from "react-native-webrtc";
import type { Action, AppState } from "@chatter/core/store/types";
import type { ViewedKind } from "@chatter/core/voice/viewer";
import type { StreamPublisher } from "@chatter/core/voice/publisher";
import { getScreenSharePublishProfile, getWebcamPublishProfile } from "@chatter/core/webrtc";
import { showToast } from "@/platform/toast";
import { createPublisher, localStream, setLocalStream } from "./viewing";

/**
 * Sending this phone's camera or screen to the call — the publishing side of
 * the web's useWebRTCWebcam and useWebRTCScreen. Each kind is a stream
 * captured here, announced to the room (`<kind>_share_start`, and the store
 * told at once, so the person sees it as on), and sent through the shared
 * StreamPublisher. Stopping undoes all of it, as does a publish that fails:
 * the person's own preview would look fine, so they are told.
 */
export class LocalShares {
  private publishers: Record<ViewedKind, StreamPublisher>;
  private deps: {
    dispatch(action: Action): void;
    getState(): AppState;
    send(frame: Record<string, unknown>): boolean;
  };

  constructor(deps: LocalShares["deps"]) {
    this.deps = deps;
    const make = (kind: ViewedKind) =>
      createPublisher(kind, {
        send: deps.send,
        roomId: () => this.room(),
        channelId: () => deps.getState().voiceChannelId,
        onGiveUp: (message) => {
          this.stop(kind);
          showToast({ message, tone: "error" });
        },
      });
    this.publishers = { screen: make("screen"), webcam: make("webcam") };
  }

  private room() {
    const s = this.deps.getState();
    return s.voiceRoomId || s.currentRoomId;
  }

  /** A socket frame, for the publishers. */
  handleFrame(frame: { type?: string; [key: string]: unknown }): void {
    void this.publishers.screen.handleFrame(frame);
    void this.publishers.webcam.handleFrame(frame);
  }

  isOn(kind: ViewedKind): boolean {
    return !!localStream(kind);
  }

  /** Turn the camera on, or start sharing the screen (Android asks first). */
  async start(kind: ViewedKind): Promise<boolean> {
    const s = this.deps.getState();
    if (!s.inVoiceChannel || this.isOn(kind)) return false;

    let stream: MediaStream;
    try {
      stream =
        kind === "webcam"
          ? await mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user", width: 1280, height: 720, frameRate: 30 } })
          : await mediaDevices.getDisplayMedia({});
    } catch {
      // Refused (the camera permission, or the screen-capture prompt): a choice, not a fault.
      if (kind === "webcam") showToast({ message: "Couldn't open the camera", description: "Chatter needs the camera permission to show it.", tone: "error" });
      return false;
    }
    const track = stream.getVideoTracks()[0] as MediaStreamTrack | undefined;
    if (!track) return false;
    // Ending the capture from Android's own controls ends the share.
    (track as MediaStreamTrack & { onended?: (() => void) | null }).onended = () => this.stop(kind);

    setLocalStream(kind, s.userId, stream);
    const { dispatch } = this.deps;
    if (kind === "webcam") {
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: true } });
      if (s.userId) dispatch({ type: "WEBCAM_SHARE_STARTED", payload: s.userId });
    } else {
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: true } });
      if (s.userId) dispatch({ type: "SCREEN_SHARE_STARTED", payload: s.userId });
    }
    this.deps.send({ type: `${kind}_share_start`, room_id: this.room(), channel_id: s.voiceChannelId || undefined });

    const tuning =
      kind === "webcam"
        ? (() => {
            const p = getWebcamPublishProfile(30);
            return { maxBitrateBps: p.maxBitrateBps, maxFramerate: p.targetFps, degradationPreference: "maintain-framerate" as const };
          })()
        : (() => {
            // A phone's screen is text and stills as often as motion: detail first.
            const p = getScreenSharePublishProfile(30, undefined, "detail");
            return { maxBitrateBps: p.maxBitrateBps, maxFramerate: p.targetFps, degradationPreference: "maintain-resolution" as const };
          })();
    try {
      await this.publishers[kind].start(track, stream, tuning);
    } catch {
      this.stop(kind);
      showToast({ message: kind === "webcam" ? "Couldn't start the camera" : "Couldn't share the screen", tone: "error" });
      return false;
    }
    return true;
  }

  /** Stop sending; nothing happens if it was not on. */
  stop(kind: ViewedKind): void {
    const s = this.deps.getState();
    const stream = localStream(kind);
    this.publishers[kind].stop();
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    setLocalStream(kind, s.userId, null);
    const { dispatch } = this.deps;
    if (kind === "webcam") {
      dispatch({ type: "SET_VOICE_STATE", payload: { isWebcamActive: false } });
      if (s.userId) dispatch({ type: "WEBCAM_SHARE_STOPPED", payload: s.userId });
    } else {
      dispatch({ type: "SET_VOICE_STATE", payload: { isScreenSharing: false } });
      if (s.userId) dispatch({ type: "SCREEN_SHARE_STOPPED", payload: s.userId });
    }
    this.deps.send({ type: `${kind}_share_stop`, room_id: this.room(), channel_id: s.voiceChannelId || undefined });
  }

  stopAll(): void {
    this.stop("webcam");
    this.stop("screen");
  }

  /** Front camera to back, or back again. */
  flipCamera(): void {
    // react-native-webrtc's own way to swap a camera track between lenses.
    const track = localStream("webcam")?.getVideoTracks()[0] as (MediaStreamTrack & { _switchCamera?(): void }) | undefined;
    track?._switchCamera?.();
  }
}
