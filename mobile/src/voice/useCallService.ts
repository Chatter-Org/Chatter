import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import * as Notifications from "expo-notifications";
import type { AppState } from "@chatter/core/store/types";
import { callService, type AudioRoute, type CallAction } from "../../modules/chatter-call";

/**
 * Hold the call up natively while there is one: the foreground service and
 * its notification start with the call, follow its channel and mute, and stop
 * when it ends. The notification's Mute and Leave come back here, as do
 * Android's hold and resume around a phone call and a car's or watch's
 * hang-up (the call's Telecom connection, Telecom.kt).
 */
export function useCallService(state: AppState, voice: { leave(): Promise<void>; toggleMute(): void; toggleDeafen(): void }) {
  const running = useRef(false);
  // Whether a phone call's hold deafened the call, so resuming undoes only that.
  const heldDeaf = useRef(false);

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

  // The notification outlives renders, so its buttons reach whichever voice
  // the latest one had.
  const onAction = useEffectEvent((action: CallAction) => {
    if (action === "leave") void voice.leave();
    else if (action === "toggleMute") voice.toggleMute();
    else if (action === "hold") {
      // A phone call is answered over this one: nobody here hears it, and it
      // hears nobody here, until it is over.
      heldDeaf.current = !state.isDeafened;
      if (heldDeaf.current) voice.toggleDeafen();
    } else if (action === "resume") {
      if (heldDeaf.current && state.isDeafened) voice.toggleDeafen();
      heldDeaf.current = false;
    }
  });
  useEffect(() => callService.onAction((action) => onAction(action)), []);

  // Signed out or torn down with a call up: the service goes with it.
  useEffect(
    () => () => {
      if (running.current) callService.stop();
    },
    [],
  );
}

/**
 * The phone's audio routes, as a store for useSyncExternalStore: read when the
 * first reader subscribes, then replaced only by the module's change events,
 * so every render in between sees the same array.
 */
const NO_ROUTES: AudioRoute[] = [];
let currentRoutes = NO_ROUTES;

function subscribeToRoutes(onChange: () => void): () => void {
  const off = callService.onRoutesChanged((routes) => {
    currentRoutes = routes;
    onChange();
  });
  currentRoutes = callService.routes();
  onChange();
  return () => {
    off();
    currentRoutes = NO_ROUTES;
  };
}

const subscribeToNothing = () => () => {};

/** The phone's audio routes for the call, kept current as headsets come and go. */
export function useAudioRoutes(active: boolean): AudioRoute[] {
  return useSyncExternalStore(active ? subscribeToRoutes : subscribeToNothing, () =>
    active ? currentRoutes : NO_ROUTES,
  );
}
