/**
 * Watching other people's screen shares and webcams — the subscribing half of
 * the web's useWebRTCScreen and useWebRTCWebcam, without React or a browser,
 * so the phone watches the same way.
 *
 * Each sharer is a peer connection of its own: an offer asking for their
 * video (and, for a screen, its sound), sent as `<kind>_webrtc_subscribe_offer`,
 * answered by the server, with candidates both ways. A connection that fails,
 * or stalls before connecting, is closed and tried again shortly.
 *
 * Watching is opt-in: the host says who is wanted (`setWanted`), which is
 * nobody until the person opens the viewer, and every subscription follows
 * that list — a share nobody asked to watch costs no connection, no
 * bandwidth, and no place in the sharer's viewer count.
 */
import {
  SCREEN_SUBSCRIBE_RETRY_MS,
  VOICE_SUB_STUCK_CONNECTING_MS,
  VOICE_SUB_STUCK_NEW_MS,
  addRemoteCandidate,
  getWebRTCConfig,
  holdCandidatesUntilAnswer,
  releaseHeldCandidates,
} from "../webrtc";

export type ViewedKind = "screen" | "webcam";

/** The parts of a received stream the viewer touches. */
export interface ViewerStream {
  addTrack(track: unknown): void;
  getTrackById(id: string): unknown;
}

export interface ViewerTrackEvent {
  track: { id: string } | null;
  streams: readonly ViewerStream[];
}

/** The parts of a peer connection the viewer uses: a browser's or react-native-webrtc's. */
export interface ViewerPeer {
  connectionState: string;
  onicecandidate: ((ev: { candidate: { toJSON(): unknown } | null }) => void) | null;
  ontrack: ((ev: ViewerTrackEvent) => void) | null;
  onconnectionstatechange: (() => void) | null;
  addTransceiver(kind: "audio" | "video", init: { direction: "recvonly" }): unknown;
  createOffer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
}

export interface StreamViewerDeps {
  kind: ViewedKind;
  createPeer(config: RTCConfiguration): ViewerPeer;
  /** A stream from a lone track, for a track that arrives without one. */
  newStream(track: unknown): ViewerStream;
  /** Send a frame on the socket; false when it is not open. */
  send(frame: Record<string, unknown>): boolean;
  /** The room the call is in. */
  roomId(): string | null;
  userId(): string | null;
  /** A stream arrived, grew, or went away. */
  onChange(): void;
}

export class StreamViewer {
  private peers = new Map<string, ViewerPeer>();
  private pending = new Set<string>();
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private stuck = new Map<string, ReturnType<typeof setTimeout>[]>();
  private streams = new Map<string, ViewerStream>();
  private wanted: string[] = [];
  private deps: StreamViewerDeps;

  constructor(deps: StreamViewerDeps) {
    this.deps = deps;
  }

  /** The stream being watched from this person, once it has arrived. */
  stream(userId: string): ViewerStream | undefined {
    return this.streams.get(userId);
  }

  /**
   * Who to watch: everyone sharing, while the viewer is open; nobody, once it
   * closes (that is the person opting back out). Subscribes to the new and
   * lets go of the rest.
   */
  setWanted(ids: readonly string[]): void {
    const me = this.deps.userId();
    this.wanted = ids.filter((id) => id !== me);
    for (const id of this.wanted) {
      if (!this.peers.has(id) && !this.pending.has(id) && !this.retries.has(id)) this.subscribe(id);
    }
    let dropped = false;
    for (const id of [...this.peers.keys()]) {
      if (!this.wanted.includes(id)) dropped = this.drop(id) || dropped;
    }
    for (const [id, timer] of [...this.retries]) {
      if (!this.wanted.includes(id)) {
        clearTimeout(timer);
        this.retries.delete(id);
        this.pending.delete(id);
      }
    }
    if (dropped) this.deps.onChange();
  }

  /** A socket frame; the ones for this kind of stream are acted on. */
  async handleFrame(msg: { type?: string; [key: string]: unknown }): Promise<void> {
    const prefix = `${this.deps.kind}_webrtc_`;
    if (typeof msg.type !== "string" || !msg.type.startsWith(prefix)) return;
    const type = msg.type.slice(prefix.length);
    const sharer = (msg.sharer_user_id ?? msg.user_id) as string | undefined;
    if (!sharer) return;

    if (type === "subscribe_answer") {
      const pc = this.peers.get(sharer);
      if (pc && typeof msg.sdp === "string") {
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          this.pending.delete(sharer);
          await releaseHeldCandidates(pc);
        } catch {
          // A stale answer for a connection since replaced.
        }
      }
    } else if (type === "subscribe_candidate") {
      const pc = this.peers.get(sharer);
      // Held until the answer is in: the server's candidates can overtake it.
      if (pc && msg.candidate) await addRemoteCandidate(pc, msg.candidate as RTCIceCandidateInit);
    } else if (type === "publisher_ready") {
      // The sharer's track is ready on the server (they started, or started
      // again): a fresh subscription, for someone who asked to watch.
      if (!this.wanted.includes(sharer)) return;
      this.drop(sharer);
      this.cancelRetry(sharer);
      this.subscribe(sharer);
      this.deps.onChange();
    } else if (type === "error" && msg.scope === "subscribe") {
      if (this.drop(sharer)) this.deps.onChange();
      this.scheduleRetry(sharer);
    }
  }

  /** Let go of everything: leaving the call. */
  close(): void {
    for (const id of [...this.peers.keys()]) this.drop(id);
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.pending.clear();
    this.wanted = [];
    this.deps.onChange();
  }

  private subscribe(sharer: string) {
    const { kind } = this.deps;
    const room = this.deps.roomId();
    if (!room || sharer === this.deps.userId()) return;
    if (this.peers.has(sharer) || this.pending.has(sharer)) return;

    const pc = this.deps.createPeer(getWebRTCConfig());
    this.peers.set(sharer, pc);
    this.pending.add(sharer);
    const current = () => this.peers.get(sharer) === pc;

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      this.deps.send({
        type: `${kind}_webrtc_subscribe_candidate`,
        room_id: this.deps.roomId(),
        sharer_user_id: sharer,
        candidate: ev.candidate.toJSON(),
      });
    };

    pc.ontrack = (ev) => {
      if (!current()) return;
      // One stream per sharer, however many tracks it arrives as.
      const stream = this.streams.get(sharer);
      if (stream) {
        if (ev.track && !stream.getTrackById(ev.track.id)) stream.addTrack(ev.track);
      } else {
        this.streams.set(sharer, ev.streams[0] ?? this.deps.newStream(ev.track));
      }
      this.deps.onChange();
    };

    pc.onconnectionstatechange = () => {
      if (!current()) return;
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        this.drop(sharer);
        this.deps.onChange();
        this.scheduleRetry(sharer);
      }
    };

    // Lost signalling leaves a connection "new"; stuck ICE, "connecting".
    const stalled = (state: string) => () => {
      if (!current() || pc.connectionState !== state) return;
      this.drop(sharer);
      this.scheduleRetry(sharer);
    };
    this.stuck.set(sharer, [
      setTimeout(stalled("new"), VOICE_SUB_STUCK_NEW_MS),
      setTimeout(stalled("connecting"), VOICE_SUB_STUCK_CONNECTING_MS),
    ]);

    pc.addTransceiver("video", { direction: "recvonly" });
    // A screen can carry the sound of what is shared; a webcam does not.
    if (kind === "screen") pc.addTransceiver("audio", { direction: "recvonly" });
    pc.createOffer()
      .then(async (offer) => {
        if (!current()) return;
        await pc.setLocalDescription(offer);
        holdCandidatesUntilAnswer(pc);
        const sent = this.deps.send({
          type: `${kind}_webrtc_subscribe_offer`,
          room_id: this.deps.roomId(),
          sharer_user_id: sharer,
          sdp: offer.sdp,
        });
        if (!sent) {
          this.drop(sharer);
          this.scheduleRetry(sharer);
        }
      })
      .catch(() => {
        if (!current()) return;
        this.drop(sharer);
        this.scheduleRetry(sharer);
      });
  }

  /** Close the connection to one sharer and forget their stream. True if there was one. */
  private drop(sharer: string): boolean {
    const pc = this.peers.get(sharer);
    for (const timer of this.stuck.get(sharer) ?? []) clearTimeout(timer);
    this.stuck.delete(sharer);
    this.pending.delete(sharer);
    const had = this.streams.delete(sharer);
    if (!pc) return had;
    this.peers.delete(sharer);
    try {
      pc.close();
    } catch {
      // Already closed.
    }
    return true;
  }

  private cancelRetry(sharer: string) {
    const timer = this.retries.get(sharer);
    if (timer) clearTimeout(timer);
    this.retries.delete(sharer);
  }

  private scheduleRetry(sharer: string) {
    if (this.retries.has(sharer) || this.peers.has(sharer)) return;
    this.retries.set(
      sharer,
      setTimeout(() => {
        this.retries.delete(sharer);
        if (this.wanted.includes(sharer) && !this.peers.has(sharer) && !this.pending.has(sharer)) this.subscribe(sharer);
      }, SCREEN_SUBSCRIBE_RETRY_MS),
    );
  }
}
