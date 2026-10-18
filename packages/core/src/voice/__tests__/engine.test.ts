import { describe, expect, it, vi } from "vitest";
import { reducer } from "../../store/reducer";
import { initialState, type Action, type AppState } from "../../store/types";
import { VOICE_SLOT_COUNT } from "../../webrtc";
import { VoiceEngine } from "../engine";
import type { LocalMic, VoiceMediaBackend, VoicePeer } from "../media";

// A peer that records what the engine does with it.
function fakePeer() {
  const transceivers: object[] = [];
  const peer = {
    connectionState: "new" as RTCPeerConnectionState,
    onicecandidate: null,
    onconnectionstatechange: null as (() => void) | null,
    ontrack: null as VoicePeer["ontrack"],
    remote: null as RTCSessionDescriptionInit | null,
    closed: false,
    addTransceiver: () => {
      const t = {};
      transceivers.push(t);
      return t;
    },
    getTransceivers: () => transceivers,
    getSenders: () => [],
    createOffer: async () => ({ type: "offer" as const, sdp: "v=0\r\n" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async (d: RTCSessionDescriptionInit) => {
      peer.remote = d;
    },
    addIceCandidate: async () => {},
    restartIce: () => {},
    getStats: async () => ({ forEach: () => {} }),
    close: () => {
      peer.closed = true;
    },
  };
  return peer;
}

function setup(state: Partial<AppState> = {}) {
  let current: AppState = {
    ...initialState,
    userId: "me",
    currentRoomId: "room1",
    channels: [{ channel_id: "voice1", name: "Lounge", channel_type: "voice" } as AppState["channels"][number]],
    ...state,
  };
  const sent: Record<string, unknown>[] = [];
  const socket = { readyState: WebSocket.OPEN, send: (raw: string) => sent.push(JSON.parse(raw)) } as unknown as WebSocket;
  const peers: ReturnType<typeof fakePeer>[] = [];
  const gains = new Map<number, number>();
  const mic = { enabled: true, stopped: false };
  const localMic: LocalMic = {
    attachTo: () => {},
    setEnabled: (on) => void (mic.enabled = on),
    isSpeaking: () => false,
    update: async () => {},
    stop: () => void (mic.stopped = true),
  };
  const backend = {
    kind: "browser",
    noiseSuppressionModes: ["none"],
    createPeer: () => {
      const p = fakePeer();
      peers.push(p);
      return p as unknown as VoicePeer;
    },
    acquireMic: async () => localMic,
    attachSlot: () => {},
    setSlotGain: (slot: number, gain: number) => void gains.set(slot, gain),
    setSlotPosition: () => {},
    setListenerPosition: () => {},
    setOutput: () => {},
    closeGraph: () => {},
    listDevices: async () => ({ inputs: [], outputs: [] }),
    onDevicesChanged: () => () => {},
    startMicTest: async () => ({ setMonitoring: async () => {}, setGain: () => {}, stop: () => {} }),
  } satisfies VoiceMediaBackend;
  const notices = { reconnecting: vi.fn(), recovered: vi.fn(), failed: vi.fn(), info: vi.fn(), error: vi.fn() };
  const engine = new VoiceEngine({
    dispatch: (action: Action) => {
      current = reducer(current, action);
      engine?.sync();
    },
    getState: () => current,
    socket: () => socket,
    loadVoiceMembers: async () => {},
    selectBackend: () => backend,
    notices,
  });
  return { engine, sent, peers, gains, mic, notices, state: () => current };
}

describe("VoiceEngine", () => {
  it("joins with a publisher and a subscription of fixed slots", async () => {
    const t = setup();
    await t.engine.join("voice1");

    expect(t.state().inVoiceChannel).toBe(true);
    expect(t.state().voiceChannelId).toBe("voice1");
    expect(t.sent.map((f) => f.type)).toEqual(["voice_join", "voice_webrtc_publish_offer", "voice_webrtc_subscribe_offer"]);
    expect(t.sent[0]).toMatchObject({ room_id: "room1", channel_id: "voice1", muted: false, deafened: false });
    const [, subscriber] = t.peers;
    expect(subscriber.getTransceivers()).toHaveLength(VOICE_SLOT_COUNT);
  });

  it("applies answers, and silences slots nobody occupies", async () => {
    const t = setup();
    await t.engine.join("voice1");
    const [publisher, subscriber] = t.peers;

    await t.engine.handleFrame({ type: "voice_webrtc_publish_answer", sdp: "v=0\r\n" });
    await t.engine.handleFrame({ type: "voice_webrtc_subscribe_answer", sdp: "v=0\r\n" });
    expect(publisher.remote?.type).toBe("answer");
    expect(subscriber.remote?.type).toBe("answer");

    const transceiver = subscriber.getTransceivers()[2];
    subscriber.ontrack!({ transceiver, track: {}, streams: [] });
    expect(t.gains.get(2)).toBe(0);
    await t.engine.handleFrame({ type: "voice_slot_map", slots: [{ slot: 2, user_id: "bob" }] });
    expect(t.gains.get(2)).toBe(1);
    t.engine.setUserVolume("bob", 0.5);
    expect(t.gains.get(2)).toBe(0.5);
    await t.engine.handleFrame({ type: "voice_slot_map", slots: [] });
    expect(t.gains.get(2)).toBe(0);
  });

  it("applies an answer once when it arrives twice", async () => {
    const t = setup();
    await t.engine.join("voice1");
    const [publisher, subscriber] = t.peers;
    let applied = 0;
    publisher.setRemoteDescription = async () => {
      applied += 1;
      if (applied > 1) throw new Error("Called in wrong state: stable");
    };
    // Two sockets on one account each deliver the answer.
    await Promise.all([
      t.engine.handleFrame({ type: "voice_webrtc_publish_answer", sdp: "v=0\r\n" }),
      t.engine.handleFrame({ type: "voice_webrtc_publish_answer", sdp: "v=0\r\n" }),
      t.engine.handleFrame({ type: "voice_webrtc_subscribe_answer", sdp: "v=0\r\n" }),
      t.engine.handleFrame({ type: "voice_webrtc_subscribe_answer", sdp: "v=0\r\n" }),
    ]);
    expect(applied).toBe(1);
    expect(publisher.closed).toBe(false);
    expect(subscriber.closed).toBe(false);
  });

  it("mutes and deafens the mic and tells the server", async () => {
    const t = setup();
    await t.engine.join("voice1");
    t.engine.toggleMute();
    expect(t.mic.enabled).toBe(false);
    expect(t.state().isMuted).toBe(true);
    expect(t.sent.at(-1)).toMatchObject({ type: "voice_mute", muted: true });

    t.engine.toggleMute();
    t.engine.toggleDeafen();
    expect(t.mic.enabled).toBe(false);
    expect(t.state().isDeafened).toBe(true);
    t.engine.toggleDeafen();
    expect(t.mic.enabled).toBe(true);
  });

  it("stops publishing under a moderator's mute and resumes after", async () => {
    const t = setup();
    await t.engine.join("voice1");
    const [publisher] = t.peers;
    await t.engine.handleFrame({ type: "voice_force_muted", force_muted: true });
    expect(publisher.closed).toBe(true);
    expect(t.state().isMuted).toBe(true);

    await t.engine.handleFrame({ type: "voice_force_muted", force_muted: false });
    expect(t.peers).toHaveLength(3);
    expect(t.sent.at(-1)?.type).toBe("voice_webrtc_publish_offer");
  });

  it("leaves: closes everything, then tells the server", async () => {
    const t = setup();
    await t.engine.join("voice1");
    await t.engine.leave();
    expect(t.peers.every((p) => p.closed)).toBe(true);
    expect(t.mic.stopped).toBe(true);
    expect(t.state().inVoiceChannel).toBe(false);
    expect(t.sent.at(-1)).toMatchObject({ type: "voice_leave", room_id: "room1", channel_id: "voice1" });
  });

  it("drops the call quietly when the same account joins elsewhere", async () => {
    const t = setup();
    await t.engine.join("voice1");
    const before = t.sent.length;
    await t.engine.handleFrame({ type: "voice_session_taken" });
    expect(t.state().inVoiceChannel).toBe(false);
    expect(t.sent.length).toBe(before);
    expect(t.notices.info).toHaveBeenCalled();
  });
});
