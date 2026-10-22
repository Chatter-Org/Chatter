/**
 * A voice call: the signalling, retries, slots and moderation of Chatter's
 * voice, without React and without a particular media stack.
 *
 * Ported from what was client/src/hooks/useWebRTCVoice.ts (see its history
 * for the longer comments that came with the code). The web client, the
 * desktop app (which loads it) and the mobile app all run on this; the web
 * hook is now only a React wrapper around it.
 *
 * What differs per platform comes in through `VoiceEngineDeps`: the media
 * backend (a browser's WebRTC, the desktop app's engine, react-native-webrtc),
 * where a call is remembered for a rejoin, and how a problem is announced.
 * Sounds go through `host`.
 */

import { host } from "../platform";
import type { Action, AppState, Dispatch } from "../store/types";
import type { SoundPack } from "../soundRules";
import {
  addRemoteCandidate,
  applyVoiceSenderBitrate,
  candidatesAfterOffer,
  clampVoiceBitrate,
  fetchIceServers,
  getWebRTCConfig,
  holdCandidatesUntilAnswer,
  isAwaitingAnswer,
  mungeVoiceAudioSdp,
  releaseHeldCandidates,
  VOICE_BITRATE_DEFAULT_BPS,
  VOICE_CONNECT_TIMEOUT_MS,
  VOICE_DISCONNECTED_GRACE_MS,
  VOICE_PUBLISH_INITIAL_RETRY_MS,
  VOICE_PUBLISH_MAX_BACKOFF_MS,
  VOICE_SLOT_COUNT,
  VOICE_SUBSCRIBE_MAX_BACKOFF_MS,
  VOICE_SUBSCRIBE_MAX_RETRIES,
  VOICE_SUBSCRIBE_RETRY_MS,
} from "../webrtc";
import type { LocalMic, MicOptions, VoiceIceCandidate, VoiceMediaBackend, VoicePeer } from "./media";
import type { VoiceRestoreState } from "./rejoin";
import { getVoiceSettings, micGain, updateVoiceSettings, type VoiceSettings } from "./settings";
import { toWorld } from "./spatial";

const VOICE_PUBLISH_MAX_RETRIES = 5;
// A first retry is usually invisible; by the third someone has noticed.
const RECONNECTING_NOTICE_AFTER = 3;

export function micOptionsFrom(settings: VoiceSettings): MicOptions {
  return {
    deviceId: settings.inputDeviceId,
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppressionMode,
    autoGainControl: settings.autoGainControl,
    gain: micGain(settings),
  };
}

function sameMicOptions(a: MicOptions, b: MicOptions): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.echoCancellation === b.echoCancellation &&
    a.noiseSuppression === b.noiseSuppression &&
    a.autoGainControl === b.autoGainControl &&
    a.gain === b.gain
  );
}

export interface VoiceEngineDeps {
  dispatch: Dispatch<Action>;
  getState(): AppState;
  /** The app's socket, for signalling. */
  socket(): WebSocket | null;
  loadVoiceMembers(): Promise<void>;
  /** The media stack for the next call, chosen at join. */
  selectBackend(): VoiceMediaBackend;
  /** Tried when the chosen stack cannot open the microphone. */
  fallbackBackend?: VoiceMediaBackend;
  /** Stop any screen share or camera that belongs to the call. */
  cleanupScreen?(): Promise<void>;
  /** Where a call is written down so it can be put back after a restart. */
  session?: {
    save(session: { roomId: string; channelId: string | null; muted: boolean; deafened: boolean; timestamp: number }): void;
    clear(): void;
  };
  /** How the engine tells the person about trouble. */
  notices: {
    reconnecting(): void;
    recovered(): void;
    failed(message: string): void;
    info(message: string): void;
    error(message: string): void;
  };
}

type Fail = (pc: VoicePeer, reason: string, capped: boolean) => void;

export class VoiceEngine {
  private backend: VoiceMediaBackend;
  private mic: LocalMic | null = null;
  private publisher: VoicePeer | null = null;
  private subscriber: VoicePeer | null = null;
  private slots = new Set<number>();
  private slotUsers = new Map<number, string>();
  private spatial: { on: boolean; me: { x: number; y: number }; others: Record<string, { x: number; y: number }> } = {
    on: false,
    me: { x: 0.5, y: 0.5 },
    others: {},
  };
  /** What `spatial` was last read from, to tell when to read it again. */
  private spatialSource: { members: AppState["voiceChannelMembers"][string] | undefined; userId: string | null } = {
    members: undefined,
    userId: null,
  };
  private userVolumes: Record<string, number> = {};
  private subscribeRetries = 0;
  private publishRetries = 0;
  private forceMuted = false;
  private bitrate = VOICE_BITRATE_DEFAULT_BPS;
  /** Peers whose answer is being applied. "Awaiting an answer" stays true
   *  until it has been, so a second copy arriving meanwhile — one per open
   *  socket of the account — would otherwise be applied to a peer that
   *  already has one, fail, and take a working connection down with it. */
  private answering = new WeakSet<VoicePeer>();
  /** Push-to-talk's current state, so a repeat press does nothing. */
  private transmitting = false;
  /** What the call's mic and playout were last set to, so a settings change
   *  touches only what it changed: an output level must not reopen the mic. */
  private appliedMic: MicOptions | null = null;
  private appliedOutput: { deviceId: string; volume: number } | null = null;

  // Mirrors of the store, kept here because some are set ahead of a render.
  private inVoice = false;
  private currentRoomId: string | null = null;
  private voiceRoomId: string | null = null;
  private voiceChannelId: string | null = null;
  private muted = false;
  private deafened = false;

  private readonly deps: VoiceEngineDeps;

  constructor(deps: VoiceEngineDeps) {
    this.deps = deps;
    // Nothing is chosen until a call starts: choosing can start a media stack
    // (the desktop app's engine), which has no business running before then.
    this.backend = deps.fallbackBackend ?? deps.selectBackend();
    this.sync();
  }

  /** The microphone and connections, for diagnostics (connection stats). */
  get connections() {
    return { mic: this.mic, publisher: this.publisher, subscriber: this.subscriber };
  }

  // ─── Keeping up with the store ─────────────────────────────────────────────

  /**
   * Read what the rest of the app has changed: call each time the store does.
   * Re-caps the sender when a moderator changes the channel's bitrate, and
   * re-points the audio graph when anyone moves in a spatial channel.
   */
  sync(): void {
    const state = this.deps.getState();
    this.inVoice = state.inVoiceChannel;
    this.currentRoomId = state.currentRoomId;
    this.voiceRoomId = state.voiceRoomId;
    this.voiceChannelId = state.voiceChannelId;
    this.muted = state.isMuted;
    this.deafened = state.isDeafened;

    const channel = state.channels.find((c) => c.channel_id === state.voiceChannelId);
    if (channel) {
      const bitrate = clampVoiceBitrate(channel.voice_bitrate);
      if (bitrate !== this.bitrate) {
        this.bitrate = bitrate;
        if (this.publisher) void applyVoiceSenderBitrate(this.publisher, bitrate);
      }
    }

    // Re-applied whenever the member list is replaced, even with nobody
    // moved: a reload after a join is what reaches a listener whose audio
    // graph did not exist when the positions last came in.
    const members = state.voiceChannelId ? state.voiceChannelMembers[state.voiceChannelId] : undefined;
    const spatialOn = channel?.channel_type === "spatial";
    if (members === this.spatialSource.members && spatialOn === this.spatial.on && state.userId === this.spatialSource.userId) return;
    this.spatialSource = { members, userId: state.userId };
    const others: Record<string, { x: number; y: number }> = {};
    let me = this.spatial.me;
    for (const member of members ?? []) {
      if (member.x === undefined || member.y === undefined) continue;
      if (member.userId === state.userId) me = { x: member.x, y: member.y };
      else others[member.userId] = { x: member.x, y: member.y };
    }
    this.spatial = { on: spatialOn, me, others };
    this.applyAllSlotPositions();
  }

  /** Settings changed: a different mic or processing reopens the capture
   *  under the same sender, and levels only move a gain. */
  applySettings(): void {
    if (!this.inVoice) return;
    const settings = getVoiceSettings();
    const micOptions = micOptionsFrom(settings);
    if (this.mic && !(this.appliedMic && sameMicOptions(this.appliedMic, micOptions))) {
      this.appliedMic = micOptions;
      this.mic.update(micOptions).catch((err) => {
        console.warn("[voice] could not apply microphone settings", err);
        this.deps.notices.error("Could not switch microphone. Check that it's connected.");
      });
    }
    this.setOutput(settings);
  }

  private setOutput(settings: VoiceSettings) {
    const output = { deviceId: settings.outputDeviceId, volume: settings.outputVolume / 100 };
    const applied = this.appliedOutput;
    if (applied && applied.deviceId === output.deviceId && applied.volume === output.volume) return;
    this.appliedOutput = output;
    this.backend.setOutput(output);
  }

  // ─── Audio graph ───────────────────────────────────────────────────────────

  private closeAudioGraph() {
    this.backend.closeGraph();
    this.slots.clear();
    this.slotUsers.clear();
  }

  // A slot plays at the volume set for whoever currently occupies it, and is
  // silent while empty — an unassigned slot still carries whatever the
  // previous speaker left in the pipeline.
  private applySlotGain(slot: number) {
    if (!this.slots.has(slot)) return;
    const userId = this.slotUsers.get(slot);
    this.backend.setSlotGain(slot, this.deafened || !userId ? 0 : (this.userVolumes[userId] ?? 1.0));
  }

  private applySlotPosition(slot: number) {
    if (!this.slots.has(slot)) return;
    const userId = this.slotUsers.get(slot);
    const at = this.spatial.on && userId ? this.spatial.others[userId] : undefined;
    // An unoccupied slot is silenced by its gain, so it is left where it was
    // rather than swung to the middle.
    if (this.spatial.on && !at && userId) return;
    this.backend.setSlotPosition(slot, at ? toWorld(at.x, at.y) : { x: 0, y: 0, z: 0 });
  }

  private applyAllSlotPositions() {
    this.backend.setListenerPosition(this.spatial.on ? toWorld(this.spatial.me.x, this.spatial.me.y) : { x: 0, y: 0, z: 0 });
    this.slots.forEach((slot) => this.applySlotPosition(slot));
  }

  // ─── Signalling ────────────────────────────────────────────────────────────

  private socketOpen(): boolean {
    const ws = this.deps.socket();
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  private send(frame: Record<string, unknown>) {
    if (!this.socketOpen()) return;
    this.deps.socket()!.send(JSON.stringify(frame));
  }

  private callRoom(): string | null {
    return this.voiceRoomId || this.currentRoomId;
  }

  private persist(over: { roomId?: string | null; channelId?: string | null; muted?: boolean; deafened?: boolean } = {}) {
    const roomId = over.roomId ?? this.callRoom();
    if (!roomId || !this.deps.session) return;
    try {
      this.deps.session.save({
        roomId,
        channelId: over.channelId !== undefined ? over.channelId : this.voiceChannelId,
        muted: over.muted ?? this.muted,
        deafened: over.deafened ?? this.deafened,
        timestamp: Date.now(),
      });
    } catch {
      // Only costs the restore; the call itself is unaffected.
    }
  }

  /** Send this peer's own candidates, none before its offer. */
  private trickleAfterOffer(pc: VoicePeer, type: "voice_webrtc_publish_candidate" | "voice_webrtc_subscribe_candidate") {
    const trickle = candidatesAfterOffer<VoiceIceCandidate>((c) => {
      this.send({
        type,
        room_id: this.callRoom(),
        candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment },
      });
    });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) trickle.add(ev.candidate);
    };
    return trickle.offerSent;
  }

  // ─── Connection recovery ───────────────────────────────────────────────────

  private noteRetrying(attempt: number, cap: number, capped: boolean) {
    if (capped && attempt > cap) {
      this.deps.notices.failed("Couldn't connect to voice. Try leaving and rejoining the channel.");
    } else if (attempt === RECONNECTING_NOTICE_AFTER) {
      this.deps.notices.reconnecting();
    }
  }

  private watchConnection(pc: VoicePeer, current: () => VoicePeer | null, fail: Fail) {
    setTimeout(() => {
      if (pc !== current() || pc.connectionState === "connected") return;
      fail(pc, isAwaitingAnswer(pc) ? "got no answer" : `stuck ${pc.connectionState}`, isAwaitingAnswer(pc));
    }, VOICE_CONNECT_TIMEOUT_MS);
  }

  private graceDisconnect(pc: VoicePeer, current: () => VoicePeer | null, fail: Fail) {
    setTimeout(() => {
      if (pc !== current()) return;
      if (pc.connectionState === "disconnected" || pc.connectionState === "failed") fail(pc, "stayed disconnected", false);
    }, VOICE_DISCONNECTED_GRACE_MS);
  }

  // ─── Publisher ─────────────────────────────────────────────────────────────

  private failPublisher: Fail = (pc, reason, capped) => {
    if (pc !== this.publisher) return;
    try {
      pc.close();
    } catch {}
    this.publisher = null;
    // A moderator's mute closes the publisher on purpose, and lifting it
    // rebuilds it; retrying in between would only be refused.
    if (!this.inVoice || this.forceMuted) {
      this.publishRetries = 0;
      return;
    }
    const attempt = this.publishRetries + 1;
    console.warn(`[voice] Publisher ${reason} (attempt ${attempt})`);
    this.noteRetrying(attempt, VOICE_PUBLISH_MAX_RETRIES, capped);
    if (capped && attempt > VOICE_PUBLISH_MAX_RETRIES) {
      this.publishRetries = 0;
      return;
    }
    this.publishRetries = attempt;
    const delay = Math.min(VOICE_PUBLISH_INITIAL_RETRY_MS * 2 ** (attempt - 1), VOICE_PUBLISH_MAX_BACKOFF_MS);
    setTimeout(async () => {
      if (!this.inVoice || this.publisher) return;
      await fetchIceServers();
      await this.createPublisher();
    }, delay);
  };

  private async createPublisher() {
    if (!this.mic || !this.socketOpen()) return;
    const pc = this.backend.createPeer(getWebRTCConfig());
    this.publisher = pc;
    holdCandidatesUntilAnswer(pc);
    this.mic.attachTo(pc);
    const current = () => this.publisher;
    const offerSent = this.trickleAfterOffer(pc, "voice_webrtc_publish_candidate");

    pc.onconnectionstatechange = () => {
      if (pc !== this.publisher) return;
      this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { voicePublisherState: pc.connectionState } });
      if (pc.connectionState === "connected") {
        this.publishRetries = 0;
        this.deps.notices.recovered();
        // Audio is flowing now, so the arrival this call was announcing has
        // actually happened.
        host.playDeferredArrivalSound();
      } else if (pc.connectionState === "disconnected") {
        this.graceDisconnect(pc, current, this.failPublisher);
      } else if (pc.connectionState === "failed") {
        this.failPublisher(pc, "connection failed", false);
      }
    };
    this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { voicePublisherState: pc.connectionState } });

    try {
      const offer = await pc.createOffer();
      if (pc !== this.publisher) return;
      await pc.setLocalDescription(offer);
      await applyVoiceSenderBitrate(pc, this.bitrate);
      if (!this.socketOpen()) return;
      this.send({
        type: "voice_webrtc_publish_offer",
        room_id: this.callRoom(),
        channel_id: this.voiceChannelId || undefined,
        sdp: offer.sdp,
      });
      offerSent();
      this.watchConnection(pc, current, this.failPublisher);
    } catch (err) {
      console.warn("[voice] could not create publisher offer", err);
      this.failPublisher(pc, "could not make an offer", true);
    }
  }

  // ─── Subscriber ────────────────────────────────────────────────────────────

  private failSubscriber: Fail = (pc, reason, capped) => {
    if (pc !== this.subscriber) return;
    try {
      pc.close();
    } catch {}
    this.subscriber = null;
    this.closeAudioGraph();
    if (!this.inVoice) {
      this.subscribeRetries = 0;
      return;
    }
    const attempt = this.subscribeRetries + 1;
    console.warn(`[voice] Subscription ${reason} (attempt ${attempt})`);
    this.noteRetrying(attempt, VOICE_SUBSCRIBE_MAX_RETRIES, capped);
    if (capped && attempt > VOICE_SUBSCRIBE_MAX_RETRIES) {
      this.subscribeRetries = 0;
      return;
    }
    this.subscribeRetries = attempt;
    const delay = Math.min(VOICE_SUBSCRIBE_RETRY_MS * 2 ** (attempt - 1), VOICE_SUBSCRIBE_MAX_BACKOFF_MS);
    setTimeout(async () => {
      if (!this.inVoice || this.subscriber) return;
      await fetchIceServers();
      await this.createSubscription();
    }, delay);
  };

  // One connection carries the entire call: a fixed number of receive-only
  // slots, filled by the server with whoever is speaking.
  private async createSubscription() {
    if (!this.socketOpen() || this.subscriber) return;
    const pc = this.backend.createPeer(getWebRTCConfig());
    this.subscriber = pc;
    holdCandidatesUntilAnswer(pc);
    const current = () => this.subscriber;
    const offerSent = this.trickleAfterOffer(pc, "voice_webrtc_subscribe_candidate");

    pc.ontrack = (ev) => {
      if (pc !== this.subscriber) return;
      // Slot index is the transceiver's position, which the server matches by
      // adding its slot tracks in the same order our offer listed them.
      const slot = pc.getTransceivers().indexOf(ev.transceiver);
      if (slot < 0) return;
      this.backend.attachSlot(slot, ev);
      this.slots.add(slot);
      this.applySlotGain(slot);
      this.applySlotPosition(slot);
    };

    pc.onconnectionstatechange = () => {
      if (pc !== this.subscriber) return;
      if (pc.connectionState === "connected") {
        this.subscribeRetries = 0;
        this.deps.notices.recovered();
      } else if (pc.connectionState === "disconnected") {
        this.graceDisconnect(pc, current, this.failSubscriber);
      } else if (pc.connectionState === "failed") {
        this.failSubscriber(pc, "connection failed", false);
      }
    };

    for (let i = 0; i < VOICE_SLOT_COUNT; i++) pc.addTransceiver("audio", { direction: "recvonly" });

    try {
      const offer = await pc.createOffer();
      if (pc !== this.subscriber) return;
      await pc.setLocalDescription(offer);
      if (!this.socketOpen()) return;
      this.send({ type: "voice_webrtc_subscribe_offer", room_id: this.callRoom(), sdp: offer.sdp });
      offerSent();
      this.watchConnection(pc, current, this.failSubscriber);
    } catch (err) {
      console.warn("[voice] could not create subscription offer", err);
      this.failSubscriber(pc, "could not make an offer", true);
    }
  }

  private applySlotMap(slots: { slot: number; user_id: string | null }[]) {
    const seen = new Set<number>();
    for (const { slot, user_id } of slots) {
      seen.add(slot);
      if (user_id) this.slotUsers.set(slot, user_id);
      else this.slotUsers.delete(slot);
      this.applySlotGain(slot);
      this.applySlotPosition(slot);
    }
    for (const slot of [...this.slotUsers.keys()]) {
      if (!seen.has(slot)) {
        this.slotUsers.delete(slot);
        this.applySlotGain(slot);
      }
    }
  }

  /** Every socket frame goes past here; the voice ones are acted on. */
  async handleFrame(msg: { type?: string; [key: string]: any }): Promise<void> {
    switch (msg.type) {
      case "voice_webrtc_publish_answer": {
        const pc = this.publisher;
        if (!pc || !isAwaitingAnswer(pc) || this.answering.has(pc)) return;
        this.answering.add(pc);
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: mungeVoiceAudioSdp(msg.sdp, this.bitrate) });
          await releaseHeldCandidates(pc);
          await applyVoiceSenderBitrate(pc, this.bitrate);
        } catch (err) {
          console.warn("[voice] could not apply publisher answer", err);
          this.failPublisher(pc, "answer was rejected", true);
        }
        return;
      }
      case "voice_webrtc_publish_candidate":
        if (this.publisher && msg.candidate) await addRemoteCandidate(this.publisher, msg.candidate);
        return;
      case "voice_webrtc_subscribe_answer": {
        const pc = this.subscriber;
        if (pc && msg.sdp && isAwaitingAnswer(pc) && !this.answering.has(pc)) {
          this.answering.add(pc);
          try {
            await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
            await releaseHeldCandidates(pc);
          } catch (err) {
            console.warn("[voice] could not apply subscription answer", err);
            this.failSubscriber(pc, "answer was rejected", true);
          }
        }
        return;
      }
      case "voice_webrtc_subscribe_candidate":
        if (this.subscriber && msg.candidate) await addRemoteCandidate(this.subscriber, msg.candidate);
        return;
      case "voice_slot_map":
        if (Array.isArray(msg.slots)) this.applySlotMap(msg.slots);
        return;
      case "voice_force_muted":
        this.forceMuted = !!msg.force_muted;
        if (msg.force_muted) {
          this.mic?.setEnabled(false);
          if (this.publisher) {
            try {
              this.publisher.close();
            } catch {}
            this.publisher = null;
          }
          this.muted = true;
          this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
        } else if (this.inVoice && !this.publisher) {
          await this.createPublisher();
        }
        return;
      case "voice_force_moved":
        if (msg.channel_id) await this.join(msg.channel_id);
        return;
      case "voice_session_taken":
        // The same account joined this call from somewhere else; drop the
        // local half quietly rather than announcing a leave.
        if (this.inVoice) {
          await this.release();
          this.deps.notices.info("You joined this call from another device");
        }
        return;
      case "voice_force_disconnected":
        if (this.inVoice) {
          await this.leave();
          this.deps.notices.info("A moderator disconnected you from voice");
        }
        return;
      case "voice_webrtc_error":
        console.warn("[voice] WebRTC error:", msg.detail || msg);
        if (msg.scope === "subscribe" && this.subscriber) {
          this.failSubscriber(this.subscriber, "was refused", true);
        } else if (msg.scope === "publish" && this.publisher && isAwaitingAnswer(this.publisher)) {
          if (msg.code === "force_muted" || msg.code === "cannot_speak") {
            // Not a fault, and no retry will change it: listen only.
            this.forceMuted = msg.code === "force_muted";
            const pc = this.publisher;
            this.publisher = null;
            try {
              pc.close();
            } catch {}
            this.mic?.setEnabled(false);
            this.muted = true;
            this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: true } });
          } else {
            this.failPublisher(this.publisher, "was refused", true);
          }
        }
        return;
    }
  }

  // ─── Join / leave ──────────────────────────────────────────────────────────

  async join(channelId?: string, restore?: VoiceRestoreState): Promise<void> {
    const state = this.deps.getState();
    if (!state.currentRoomId) return;

    // Already in a call: tear the local half down first, without a leave —
    // the server's join removes us from the previous channel atomically.
    if (this.inVoice) {
      await this.deps.cleanupScreen?.();
      this.closeConnections();
      this.mic?.stop();
      this.mic = null;
    }

    // Mute and deafen belong to the person, not the channel.
    const rejoining = this.inVoice;
    const pushToTalk = getVoiceSettings().inputMode === "ptt";
    const nextMuted = pushToTalk || (restore?.muted ?? (rejoining ? this.muted : false));
    const nextDeafened = restore?.deafened ?? (rejoining ? this.deafened : false);

    try {
      const settings = getVoiceSettings();
      const micOptions = micOptionsFrom(settings);
      this.backend = this.deps.selectBackend();
      let mic: LocalMic;
      try {
        mic = await this.backend.acquireMic(micOptions);
      } catch (err) {
        const fallback = this.deps.fallbackBackend;
        if (!fallback || fallback === this.backend) throw err;
        console.warn("[voice] chosen media stack unavailable, falling back", err);
        this.backend = fallback;
        mic = await this.backend.acquireMic(micOptions);
      }
      this.mic = mic;
      this.appliedMic = micOptions;
      // A new backend has heard nothing yet.
      this.appliedOutput = null;
      this.setOutput(settings);
      if (nextMuted || nextDeafened) mic.setEnabled(false);
      this.transmitting = false;

      const resolvedChannelId = channelId || state.voiceChannelId || undefined;
      const joinedChannel = state.channels.find((c) => c.channel_id === resolvedChannelId);
      this.bitrate = clampVoiceBitrate(joinedChannel?.voice_bitrate);
      this.inVoice = true;
      this.muted = nextMuted;
      this.deafened = nextDeafened;
      this.voiceRoomId = state.currentRoomId;
      this.voiceChannelId = resolvedChannelId ?? null;
      this.deps.dispatch({
        type: "SET_VOICE_STATE",
        payload: {
          inVoiceChannel: true,
          isMuted: nextMuted,
          isDeafened: nextDeafened,
          voiceInputMode: pushToTalk ? "ptt" : "open",
          voiceRoomId: state.currentRoomId,
          voiceChannelId: resolvedChannelId ?? null,
          voicePublisherState: "new",
        },
      });

      this.persist({ roomId: state.currentRoomId, channelId: resolvedChannelId ?? null, muted: nextMuted, deafened: nextDeafened });

      // Mute and deafen ride along with the join, so nobody sees the arrival
      // unmuted first and corrected a moment later.
      this.send({
        type: "voice_join",
        room_id: state.currentRoomId,
        muted: nextMuted,
        deafened: nextDeafened,
        ...(resolvedChannelId ? { channel_id: resolvedChannelId } : {}),
      });
      await this.createPublisher();
      await this.createSubscription();
      await this.deps.loadVoiceMembers();
    } catch {
      this.deps.notices.error("Could not access microphone. Please check permissions.");
    }
  }

  private closeConnections() {
    if (this.publisher) {
      try {
        this.publisher.close();
      } catch {}
      this.publisher = null;
    }
    if (this.subscriber) {
      try {
        this.subscriber.close();
      } catch {}
      this.subscriber = null;
    }
    this.closeAudioGraph();
    this.publishRetries = 0;
    this.subscribeRetries = 0;
  }

  /** Announce leaving while the socket is still open — for an app being
   *  closed, where the server would otherwise wait out its read timeout. */
  announceLeave(): void {
    if (!this.inVoice) return;
    const roomId = this.callRoom();
    if (!roomId) return;
    try {
      this.send({ type: "voice_leave", room_id: roomId, channel_id: this.voiceChannelId || undefined });
    } catch {
      // The socket was already going down; the server falls back to noticing.
    }
  }

  /** Shut the local half down, telling nobody — for when the session is
   *  already gone on the server's side. */
  async release(): Promise<void> {
    await this.deps.cleanupScreen?.();
    this.closeConnections();
    this.forceMuted = false;
    this.deps.notices.recovered();
    // A sting still waiting on a connection must never surface on a later call.
    host.dropDeferredArrivalSound();
    this.mic?.stop();
    this.mic = null;
    this.inVoice = false;
    this.muted = false;
    this.deafened = false;
    this.voiceRoomId = null;
    this.voiceChannelId = null;
    this.deps.dispatch({
      type: "SET_VOICE_STATE",
      payload: {
        inVoiceChannel: false,
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false,
        voiceRoomId: null,
        voiceChannelId: null,
        voiceChannelName: null,
        voicePublisherState: "closed",
      },
    });
    this.deps.session?.clear();
  }

  async leave(): Promise<void> {
    // Read before the teardown, which clears the call's room.
    const roomId = this.callRoom();
    const channelId = this.voiceChannelId;
    await this.release();
    this.send({ type: "voice_leave", room_id: roomId, ...(channelId ? { channel_id: channelId } : {}) });
    await this.deps.loadVoiceMembers();
  }

  // ─── Mute, deafen, push-to-talk, volume ────────────────────────────────────

  private roomSounds(): SoundPack | undefined {
    const state = this.deps.getState();
    return state.roomInfoMap[state.voiceRoomId ?? state.currentRoomId ?? ""]?.sounds as SoundPack | undefined;
  }

  private sendMute(muted: boolean) {
    this.send({ type: "voice_mute", room_id: this.callRoom(), channel_id: this.voiceChannelId || undefined, muted });
  }

  toggleMute(): void {
    if (!this.mic) return;
    const next = !this.muted;
    this.mic.setEnabled(!next);
    this.muted = next;
    this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: next } });
    this.persist({ muted: next });
    host.playSound(next ? "mute" : "unmute", this.roomSounds());
    this.sendMute(next);
  }

  toggleInputMode(): void {
    const state = this.deps.getState();
    const next = state.voiceInputMode === "open" ? "ptt" : "open";
    if (getVoiceSettings().inputMode !== next) updateVoiceSettings({ inputMode: next });
    if (next === "ptt" && this.mic) {
      this.mic.setEnabled(false);
      this.muted = true;
      this.transmitting = false;
      this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "ptt", isMuted: true } });
      this.sendMute(true);
    } else {
      this.mic?.setEnabled(true);
      this.muted = false;
      this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { voiceInputMode: "open", isMuted: false } });
      this.sendMute(false);
    }
  }

  /** Push-to-talk: the key or button is down (true) or up (false). */
  setTransmitting(on: boolean): void {
    if (!this.inVoice || on === this.transmitting) return;
    this.transmitting = on;
    this.mic?.setEnabled(on);
    this.muted = !on;
    this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { isMuted: !on } });
    host.playSound(on ? "unmute" : "mute", this.roomSounds());
    this.sendMute(!on);
  }

  setUserVolume(userId: string, volume: number): void {
    this.userVolumes[userId] = volume;
    for (const [slot, occupant] of this.slotUsers) {
      if (occupant === userId) this.applySlotGain(slot);
    }
  }

  toggleDeafen(): void {
    const next = !this.deafened;
    // Deafening silences the mic too; undeafening reopens it only if the
    // person is not separately muted.
    this.mic?.setEnabled(next ? false : !this.muted);
    this.deafened = next;
    this.slots.forEach((slot) => this.applySlotGain(slot));
    this.persist({ deafened: next });
    this.deps.dispatch({ type: "SET_VOICE_STATE", payload: { isDeafened: next } });
    this.send({ type: "voice_deafen", room_id: this.callRoom(), channel_id: this.voiceChannelId || undefined, deafened: next });
  }
}
