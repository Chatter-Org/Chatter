import { useEffect, useState } from "react";
import type { VoicePeer } from "@chatter/core/voice/media";
import { readCallStats, scoreCallQuality, type ConnectionQuality } from "@chatter/core/voice/quality";

const POLL_MS = 2000;

/** The call's connection quality, read from the publisher while `active`. */
export function useCallQuality(active: boolean, peer: () => VoicePeer | null): ConnectionQuality {
  const [quality, setQuality] = useState<ConnectionQuality>(0);
  useEffect(() => {
    if (!active) {
      setQuality(0);
      return;
    }
    let stopped = false;
    const read = async () => {
      const pc = peer();
      if (!pc) return setQuality(0);
      try {
        const stats = await pc.getStats();
        if (!stopped) setQuality(scoreCallQuality(readCallStats(pc.connectionState, stats)));
      } catch {
        if (!stopped) setQuality(0);
      }
    };
    void read();
    const id = setInterval(read, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active, peer]);
  return quality;
}
