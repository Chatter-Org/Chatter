import { useEffect, useRef, useState } from "react";
import * as Notifications from "expo-notifications";
import type { AppState } from "@chatter/core/store/types";
import { callService, type AudioRoute } from "../../modules/chatter-call";

/**
 * Hold the call up natively while there is one: the foreground service and
 * its notification start with the call, follow its channel and mute, and stop
 * when it ends. The notification's Mute and Leave come back here.
 */
export function useCallService(state: AppState, voice: { leave(): Promise<void>; toggleMute(): void }) {
  const running = useRef(false);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const title = state.voiceChannelName ? `In a call · ${state.voiceChannelName}` : "In a call";
  const text = (state.voiceRoomId && state.roomInfoMap[state.voiceRoomId]?.name) || "";
  const muted = state.isMuted || state.isDeafened;

  useEffect(() => {
    if (!state.inVoiceChannel) {
      if (running.current) callService.stop();
      running.current = false;
      return;
    }
    if (!running.current) {
      running.current = true;
      // The call's notification is how it is reached from outside the app;
      // Android 13 asks before showing any. The call runs either way. (Before
      // the first prompt Android reports "denied" with canAskAgain, not
      // "undetermined".)
      void Notifications.getPermissionsAsync()
        .then((p) => (p.status !== "granted" && p.canAskAgain ? Notifications.requestPermissionsAsync() : p))
        .catch(() => {})
        .finally(() => {
          if (running.current) callService.start(title, text, muted);
        });
      return;
    }
    callService.update(title, text, muted);
  }, [state.inVoiceChannel, title, text, muted]);

  useEffect(
    () =>
      callService.onAction((action) => {
        if (action === "leave") void voiceRef.current.leave();
        else voiceRef.current.toggleMute();
      }),
    [],
  );

  // Signed out or torn down with a call up: the service goes with it.
  useEffect(
    () => () => {
      if (running.current) callService.stop();
    },
    [],
  );
}

/** The phone's audio routes for the call, kept current as headsets come and go. */
export function useAudioRoutes(active: boolean): AudioRoute[] {
  const [routes, setRoutes] = useState<AudioRoute[]>([]);
  useEffect(() => {
    if (!active) {
      setRoutes([]);
      return;
    }
    setRoutes(callService.routes());
    return callService.onRoutesChanged(setRoutes);
  }, [active]);
  return routes;
}
