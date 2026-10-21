import { useEffect, useState } from "react";
import type { VoicePeer } from "@chatter/core/voice/media";
import { readCallStats, scoreCallQuality, type ConnectionQuality } from "@chatter/core/voice/quality";

const POLL_MS = 2000;

/** The call's connection quality, read from the publisher while `active`. */
export function useCallQuality(active: boolean, peer: () => VoicePeer | null): ConnectionQuality {
  const [quality, setQuality] = useState<ConnectionQuality>(0);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const read = () => {
      const pc = peer();
      const scored = pc
        ? pc.getStats().then((stats) => scoreCallQuality(readCallStats(pc.connectionState, stats)))
        : Promise.resolve<ConnectionQuality>(0);
      void scored
        .catch((): ConnectionQuality => 0)
        .then((q) => {
          if (!stopped) setQuality(q);
        });
    };
    read();
    const id = setInterval(read, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
      // The next call starts from nothing, not this one's last reading.
      setQuality(0);
    };
  }, [active, peer]);
  return quality;
}
