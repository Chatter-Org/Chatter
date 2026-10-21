/**
 * How good a call's connection is, in the four bars the call bar draws.
 * Shared by the web (VoiceControls) and the mobile app.
 */

/** 0 = no reading yet (or down), 1 = poor … 4 = excellent. */
export type ConnectionQuality = 0 | 1 | 2 | 3 | 4;

export interface CallStats {
  connectionState: RTCPeerConnectionState | string;
  /** Seconds, from the nominated candidate pair. */
  rtt?: number | null;
  /** Seconds. */
  audioJitter?: number | null;
  audioPacketsLost?: number | null;
}

export function scoreCallQuality(pub: CallStats | undefined): ConnectionQuality {
  if (!pub || pub.connectionState === "new" || pub.connectionState === "connecting") return 0;
  if (pub.connectionState === "failed" || pub.connectionState === "disconnected" || pub.connectionState === "closed") return 0;

  const rttMs = (pub.rtt ?? 0) * 1000;
  const jitterMs = (pub.audioJitter ?? 0) * 1000;
  const loss = pub.audioPacketsLost ?? 0;

  // Score: 4 = excellent, 3 = good, 2 = fair, 1 = poor
  if (rttMs < 80 && jitterMs < 20 && loss < 5) return 4;
  if (rttMs < 150 && jitterMs < 40 && loss < 20) return 3;
  if (rttMs < 300 && jitterMs < 80 && loss < 50) return 2;
  return 1;
}

/** Read what scoreCallQuality needs out of a W3C stats report. */
export function readCallStats(
  connectionState: string,
  stats: { forEach(callback: (report: any) => void): void },
): CallStats {
  let rtt: number | null = null;
  let audioJitter: number | null = null;
  let audioPacketsLost: number | null = null;
  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.nominated && report.currentRoundTripTime != null) rtt = report.currentRoundTripTime;
    if ((report.type === "inbound-rtp" || report.type === "outbound-rtp") && report.kind === "audio") {
      if (report.packetsLost != null) audioPacketsLost = (audioPacketsLost ?? 0) + report.packetsLost;
      if (report.jitter != null) audioJitter = report.jitter;
    }
  });
  return { connectionState, rtt, audioJitter, audioPacketsLost };
}
