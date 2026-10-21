/**
 * Sending a camera (or a screen) to the call — the publishing half of the
 * web's useWebRTCWebcam and useWebRTCScreen, without React or a browser, so
 * the phone sends the same way.
 *
 * One peer connection carries the picture to the server: an offer as
 * `<kind>_webrtc_publish_offer`, the answer back, and candidates both ways
 * (ours held until the offer is out, the server's until its answer is in).
 * The sender is tuned to the kind's profile — a bitrate ceiling and frame
 * rate — and tuned again once the answer lands, which can reset it. A
 * connection that fails, or never connects, gives up and says why: the
 * sharer's own preview looks fine whether anyone receives it or not, so they
 * would otherwise never know.
 */
import {
  VOICE_CONNECT_TIMEOUT_MS,
  addRemoteCandidate,
  candidatesAfterOffer,
  getWebRTCConfig,
  holdCandidatesUntilAnswer,
  releaseHeldCandidates,
} from "../webrtc";
import type { ViewedKind } from "./viewer";

export interface PublishTuning {
  maxBitrateBps: number;
  maxFramerate: number;
  degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
}

/** The parts of an RTP sender the publisher tunes. */
export interface PublisherSender {
  getParameters(): { encodings?: Record<string, unknown>[]; degradationPreference?: string; [key: string]: unknown };
  setParameters(params: unknown): Promise<void>;
}

/** The parts of a peer connection the publisher uses. */
export interface PublisherPeer {
  connectionState: string;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTrack(track: unknown, stream: unknown): PublisherSender;
  createOffer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  /** The connection's statistics, where the implementation has them. */
  getStats?(): Promise<{ forEach(cb: (report: Record<string, unknown>) => void): void }>;
  close(): void;
}

/** How long after connecting the first frames must have gone out. */
export const FIRST_FRAMES_MS = 6_000;

export interface StreamPublisherDeps {
  kind: ViewedKind;
  createPeer(config: RTCConfiguration): PublisherPeer;
  send(frame: Record<string, unknown>): boolean;
  roomId(): string | null;
  channelId(): string | null;
  /** The publish failed for good: stop sharing, and tell the person. */
  onGiveUp(message: string): void;
}

export class StreamPublisher {
  private deps: StreamPublisherDeps;
  private pc: PublisherPeer | null = null;
  private sender: PublisherSender | null = null;
  private tuning: PublishTuning | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: StreamPublisherDeps) {
    this.deps = deps;
  }

  get active(): boolean {
    return this.pc !== null;
  }

  /** Send this track (of this stream) to the call. */
  async start(track: unknown, stream: unknown, tuning: PublishTuning): Promise<void> {
    this.stop();
    const { kind } = this.deps;
    const pc = this.deps.createPeer(getWebRTCConfig());
    this.pc = pc;
    this.tuning = tuning;
    const where = () => ({ room_id: this.deps.roomId(), channel_id: this.deps.channelId() || undefined });

    const trickle = candidatesAfterOffer<{ toJSON(): unknown }>((c) => {
      this.deps.send({ type: `${kind}_webrtc_publish_candidate`, ...where(), candidate: c.toJSON() });
    });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) trickle.add(ev.candidate);
    };
    const what = kind === "screen" ? "screen share" : "camera";
    const giveUp = (message: string) => {
      if (this.pc !== pc) return;
      this.stop();
      this.deps.onGiveUp(message);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") giveUp(`Your ${what} lost its connection. Try turning it on again.`);
      // Connected is not the same as sending: a capture the phone refused
      // after the prompt connects and then sends nothing, while the person
      // believes they are sharing. Check that pictures are going out.
      if (pc.connectionState === "connected" && pc.getStats) {
        setTimeout(() => {
          if (this.pc !== pc) return;
          void sentFrames(pc).then((frames) => {
            if (frames === 0) giveUp(`Your ${what} isn't sending anything. Try turning it on again.`);
          });
        }, FIRST_FRAMES_MS);
      }
    };
    this.timer = setTimeout(() => {
      if (pc.connectionState === "new" || pc.connectionState === "connecting") {
        giveUp(`Your ${what} couldn't connect. Try turning it on again.`);
      }
    }, VOICE_CONNECT_TIMEOUT_MS);

    this.sender = pc.addTrack(track, stream);
    await this.tune();
    const offer = await pc.createOffer();
    if (this.pc !== pc) return;
    await pc.setLocalDescription(offer);
    await this.tune();
    holdCandidatesUntilAnswer(pc);
    if (this.deps.send({ type: `${kind}_webrtc_publish_offer`, ...where(), sdp: offer.sdp })) trickle.offerSent();
    else giveUp(`Your ${what} couldn't connect. Try turning it on again.`);
  }

  /** Stop sending. The host tells the server (`<kind>_share_stop`) and stops the track. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pc = this.pc;
    this.pc = null;
    this.sender = null;
    try {
      pc?.close();
    } catch {
      // Already closed.
    }
  }

  /** A socket frame; the ones about this publish are acted on. */
  async handleFrame(msg: { type?: string; [key: string]: unknown }): Promise<void> {
    const pc = this.pc;
    if (!pc || typeof msg.type !== "string") return;
    const prefix = `${this.deps.kind}_webrtc_`;
    if (!msg.type.startsWith(prefix)) return;
    const type = msg.type.slice(prefix.length);
    if (type === "publish_answer" && typeof msg.sdp === "string") {
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        await releaseHeldCandidates(pc);
        // Applying the answer can reset what the sender was told.
        await this.tune();
      } catch {
        // An answer for a publish since stopped.
      }
    } else if (type === "publish_candidate" && msg.candidate) {
      await addRemoteCandidate(pc, msg.candidate as RTCIceCandidateInit);
    } else if (type === "error" && msg.scope === "publish") {
      this.stop();
      this.deps.onGiveUp(`Your ${this.deps.kind === "screen" ? "screen share" : "camera"} was stopped: the server could not take it.`);
    }
  }

  private async tune() {
    const sender = this.sender;
    const tuning = this.tuning;
    if (!sender || !tuning) return;
    try {
      const params = sender.getParameters();
      const base = params.encodings?.[0] ?? {};
      params.encodings = [{ ...base, maxBitrate: tuning.maxBitrateBps, maxFramerate: tuning.maxFramerate }];
      if (tuning.degradationPreference) params.degradationPreference = tuning.degradationPreference;
      await sender.setParameters(params);
    } catch {
      // Not every implementation lets these be written.
    }
  }
}

/** Video frames sent so far on this connection; null when it cannot say. */
async function sentFrames(pc: PublisherPeer): Promise<number | null> {
  try {
    const stats = await pc.getStats!();
    let frames: number | null = null;
    stats.forEach((report) => {
      if (report.type === "outbound-rtp" && (report.kind === "video" || report.mediaType === "video")) {
        const sent = Number(report.framesSent ?? report.framesEncoded ?? 0);
        frames = (frames ?? 0) + (Number.isFinite(sent) ? sent : 0);
      }
    });
    return frames;
  } catch {
    return null;
  }
}
