import { mediaDevices, MediaStream, MediaStreamTrack, RTCPeerConnection, type RTCRtpSender } from "react-native-webrtc";
import type {
  AudioDevice,
  LocalMic,
  MicOptions,
  MicTest,
  VoiceMediaBackend,
  VoicePeer,
  VoiceTrackEvent,
  WorldPosition,
} from "@chatter/core/voice/media";
import { distanceGain } from "@chatter/core/voice/spatial";

/**
 * Voice on react-native-webrtc: the phone's own WebRTC, with Android's echo
 * cancellation and noise suppression.
 *
 * There is no Web Audio here. Remote tracks play straight out of WebRTC's
 * audio device, so a slot's gain is the track's own volume, a spatial channel
 * is heard as distance (louder near, quieter far) without left and right, and
 * the speaking light reads the level WebRTC reports for the outgoing audio.
 * Which speaker or headset the sound comes out of is the audio route's job
 * (see ./audioRoute).
 */

// react-native-webrtc's Android capture takes no audio constraints: the
// phone's own echo canceller, noise suppressor and gain control are always
// on, which is what a call wants. So the processing settings have nothing to
// change here, and the one mode offered is the platform's.
const MIC = { audio: true, video: false } as const;

// Matches the web's threshold in feel: WebRTC's audioLevel is 0..1 linear.
const SPEAKING_LEVEL = 0.04;
const LEVEL_POLL_MS = 150;

class NativeMic implements LocalMic {
  private stream: MediaStream;
  private options: MicOptions;
  private enabled = true;
  private sender: RTCRtpSender | null = null;
  private peer: RTCPeerConnection | null = null;
  private level = 0;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(stream: MediaStream, options: MicOptions) {
    this.stream = stream;
    this.options = options;
  }

  private get track(): MediaStreamTrack {
    return this.stream.getAudioTracks()[0];
  }

  attachTo(peer: VoicePeer): void {
    const pc = peer as unknown as RTCPeerConnection;
    this.track.enabled = this.enabled;
    this.sender = pc.addTrack(this.track, this.stream);
    this.peer = pc;
    this.watchLevel();
  }

  /** The outgoing audio's level, as the publisher measures it. */
  private watchLevel() {
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(async () => {
      const pc = this.peer;
      if (!pc || pc.connectionState === "closed" || !this.enabled) {
        this.level = 0;
        return;
      }
      try {
        const stats = (await pc.getStats()) as Map<string, { type: string; kind?: string; audioLevel?: number }>;
        let level = 0;
        stats.forEach((report) => {
          if (report.type === "media-source" && report.kind === "audio" && typeof report.audioLevel === "number") {
            level = report.audioLevel;
          }
        });
        this.level = level;
      } catch {
        this.level = 0;
      }
    }, LEVEL_POLL_MS);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.stream.getAudioTracks().forEach((t) => {
      t.enabled = on;
    });
    if (!on) this.level = 0;
  }

  isSpeaking(): boolean {
    return this.enabled && this.level > SPEAKING_LEVEL;
  }

  async update(options: MicOptions): Promise<void> {
    // Device and processing are the phone's (see MIC); gain is not adjustable.
    this.options = options;
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.peer = null;
    this.sender = null;
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream.release();
  }
}

export function createNativeVoiceBackend(): VoiceMediaBackend {
  const slots = new Map<number, MediaStreamTrack>();
  const gains = new Map<number, number>();
  const positions = new Map<number, WorldPosition>();
  let listener: WorldPosition = { x: 0, y: 0, z: 0 };
  let outputVolume = 1;

  const apply = (slot: number) => {
    const track = slots.get(slot);
    if (!track) return;
    const at = positions.get(slot);
    const distance = at ? Math.hypot(at.x - listener.x, at.z - listener.z) : 0;
    const volume = (gains.get(slot) ?? 0) * outputVolume * (at ? distanceGain(distance) : 1);
    try {
      track._setVolume(volume);
    } catch {
      // The track went with its connection.
    }
  };

  return {
    kind: "native",
    noiseSuppressionModes: ["browser"],

    createPeer(config) {
      return new RTCPeerConnection(config as ConstructorParameters<typeof RTCPeerConnection>[0]) as unknown as VoicePeer;
    },

    async acquireMic(options) {
      const stream = await mediaDevices.getUserMedia(MIC);
      return new NativeMic(stream, options);
    },

    attachSlot(slot, event: VoiceTrackEvent) {
      slots.set(slot, event.track as MediaStreamTrack);
      apply(slot);
    },
    setSlotGain(slot, gain) {
      gains.set(slot, gain);
      apply(slot);
    },
    setSlotPosition(slot, at) {
      // The middle of the room is where a non-spatial channel puts everyone.
      if (at.x === 0 && at.z === 0 && listener.x === 0 && listener.z === 0) positions.delete(slot);
      else positions.set(slot, at);
      apply(slot);
    },
    setListenerPosition(at) {
      listener = at;
      slots.forEach((_, slot) => apply(slot));
    },
    setOutput({ volume }) {
      outputVolume = volume;
      slots.forEach((_, slot) => apply(slot));
    },
    closeGraph() {
      slots.clear();
      gains.clear();
      positions.clear();
    },

    async listDevices() {
      // The phone picks the microphone itself; outputs are the audio route's.
      const devices = (await mediaDevices.enumerateDevices()) as { kind: string; deviceId: string; label: string }[];
      const inputs: AudioDevice[] = devices
        .filter((d) => d.kind === "audioinput")
        .map((d) => ({ id: d.deviceId, label: d.label || "Microphone" }));
      return { inputs, outputs: [] };
    },
    onDevicesChanged() {
      return () => {};
    },

    async startMicTest(options, onLevel): Promise<MicTest> {
      // A loopback peer pair, so WebRTC measures the level as it would in a call.
      const stream = await mediaDevices.getUserMedia(MIC);
      const pc = new RTCPeerConnection({ iceServers: [] });
      pc.addTrack(stream.getAudioTracks()[0], stream);
      const timer = setInterval(async () => {
        try {
          const stats = (await pc.getStats()) as Map<string, { type: string; kind?: string; audioLevel?: number }>;
          stats.forEach((r) => {
            if (r.type === "media-source" && r.kind === "audio" && typeof r.audioLevel === "number") onLevel(r.audioLevel);
          });
        } catch {}
      }, LEVEL_POLL_MS);
      return {
        async setMonitoring() {},
        setGain() {},
        stop() {
          clearInterval(timer);
          pc.close();
          stream.getTracks().forEach((t) => t.stop());
          stream.release();
        },
      };
    },
  };
}
