import { useCallback, useEffect, useState } from "react";
import {
  STREAMER_MODE_CHANGE_EVENT,
  readStreamerMode,
  saveStreamerMode,
  type StreamerSettings,
} from "@/lib/streamerMode";

/**
 * Shared access to the streamer mode settings, arranged like the screen share
 * preferences beside it: localStorage with a window event, so the dialog and a
 * share in progress stay in step and a move of the avatar lands straight away.
 */
export function useStreamerMode() {
  const [streamer, setStreamerState] = useState<StreamerSettings>(readStreamerMode);

  useEffect(() => {
    const handler = () => setStreamerState(readStreamerMode());
    window.addEventListener(STREAMER_MODE_CHANGE_EVENT, handler);
    return () => window.removeEventListener(STREAMER_MODE_CHANGE_EVENT, handler);
  }, []);

  const setStreamer = useCallback((settings: StreamerSettings) => {
    saveStreamerMode(settings);
    window.dispatchEvent(new CustomEvent(STREAMER_MODE_CHANGE_EVENT));
  }, []);

  return { streamer, setStreamer };
}
