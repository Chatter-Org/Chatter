/**
 * What the two clip engines have in common, and what the encoder engine's
 * worker and its page-side controller say to each other.
 *
 * A clip engine keeps the last stretch of one screen share and hands it over on
 * request. `useClipBuffer` picks which engine runs and turns what they report
 * into React state; neither engine knows about React.
 */

/** A finished clip. */
export interface TakenClipData {
  blob: Blob;
  /** The footage's real length, which is not the setting's: see `ring.ts`. */
  seconds: number;
}

export interface ClipEngine {
  /** The clip as it stands, or null while there is nothing to take. */
  take: () => Promise<TakenClipData | null>;
  stop: () => void;
}

export interface ClipEngineEvents {
  /** A recorder is genuinely running — not merely requested. */
  onArmed: (armed: boolean) => void;
  /** Roughly how much footage is on hand. */
  onBuffered: (secs: number) => void;
  /** Why recording is not working; null once it is. */
  onError: (message: string | null) => void;
  /** What the engine settled on, for the tooltip: "1080p60 · hardware". */
  onDetail?: (detail: string) => void;
}

// ─── Encoder engine: page ⇄ worker ──────────────────────────────────────────

export type ClipWorkerRequest =
  | {
      type: "start";
      /** The share's picture, as a stream of frames the worker owns. */
      video: ReadableStream<VideoFrame>;
      /** The share's frame rate where the page knows it: it decides whether a
       *  machine that can afford 60 gets it. */
      sourceFps: number | null;
      windowSecs: number;
    }
  | {
      /** The share's sound. Separate because it can turn up later than the
       *  picture: a received track stays muted until media flows. */
      type: "audio";
      audio: ReadableStream<AudioData>;
    }
  | { type: "take"; id: number };

export type ClipWorkerReply =
  | { type: "ready"; detail: string }
  | { type: "buffered"; secs: number }
  | { type: "clip"; id: number; blob: Blob | null; seconds: number }
  /** Recording cannot go on in this engine; the page falls back. */
  | { type: "failed"; message: string }
  /** Recording is in trouble but may recover. */
  | { type: "warning"; message: string | null };
