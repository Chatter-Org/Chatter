import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { VoiceEngine } from "@chatter/core/voice/engine";
import { useAppContext } from "@/lib/store";
import { useVoiceSettings } from "@/hooks/useVoiceSettings";
import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";
import type { VoiceRestoreState } from "@/lib/voiceRejoin";
import { browserVoiceBackend, selectVoiceBackend, type LocalMic, type VoicePeer } from "@/lib/media";

// The call itself — signalling, retries, slots, moderation — is the shared
// VoiceEngine (@chatter/core/voice/engine), which the mobile app runs too.
// What stays here is the browser's part: the toasts, the session kept for a
// refresh, the push-to-talk key and the leave announced as the tab closes.

const RECONNECTING_TOAST = "voice-reconnecting";

/** A ref whose value is read from the engine, so the connection-stats and
 *  speaking hooks keep taking refs while the engine owns the connections. */
function liveRef<T>(read: () => T): { readonly current: T } {
  return {
    get current() {
      return read();
    },
  };
}

interface UseWebRTCVoiceOptions {
  cleanupScreenRef: React.MutableRefObject<() => Promise<void>>;
}

export function useWebRTCVoice({ cleanupScreenRef }: UseWebRTCVoiceOptions) {
  const { state, dispatch, wsRef, loadVoiceMembers } = useAppContext();
  const { settings } = useVoiceSettings();

  // The provider keeps a ref to the state too, but refreshes it in an effect
  // of its own, which runs after this component's: reading it here would be a
  // render behind.
  const stateRef = useRef(state);

  // One call engine for as long as VoiceControls is mounted.
  const [engine] = useState(
    () =>
      new VoiceEngine({
        dispatch,
        getState: () => stateRef.current,
        socket: () => wsRef.current,
        loadVoiceMembers: () => loadVoiceMembers(),
        selectBackend: selectVoiceBackend,
        // The native engine couldn't open the mic (or isn't running): the
        // browser's stack can still carry the call.
        fallbackBackend: browserVoiceBackend,
        cleanupScreen: () => cleanupScreenRef.current(),
        // Enough to put the call back after a refresh, mute and deafen
        // included: coming back on an open mic is the one mistake here the
        // person cannot see. Cleared on leaving, so a refresh on this device
        // does not take the session back off whichever device holds it.
        session: {
          save: (session) => {
            try {
              sessionStorage.setItem("voiceSession", JSON.stringify(session));
            } catch {
              // Only costs the restore; the call itself is unaffected.
            }
          },
          clear: () => {
            try {
              sessionStorage.removeItem("voiceSession");
            } catch {
              // Nothing stored to clear.
            }
          },
        },
        notices: {
          reconnecting: () => toast.warning("Voice connection lost. Reconnecting…", { id: RECONNECTING_TOAST }),
          recovered: () => toast.dismiss(RECONNECTING_TOAST),
          failed: (message) => toast.error(message, { id: RECONNECTING_TOAST }),
          info: (message) => toast.info(message),
          error: (message) => toast.error(message),
        },
      }),
  );

  // A layout effect, so the engine has caught up before any passive effect
  // below acts on the same change.
  useLayoutEffect(() => {
    stateRef.current = state;
    engine.sync();
  }, [engine, state]);

  // Settings changed in the Voice & Audio dialog apply to the call already
  // running; the engine touches only what changed.
  useEffect(() => {
    engine.applySettings();
  }, [engine, settings, state.inVoiceChannel]);

  // Every socket frame goes to the engine; it acts on the voice ones.
  useEffect(() => {
    const handler = (e: Event) => {
      void engine.handleFrame((e as CustomEvent).detail);
    };
    window.addEventListener("ws-message", handler);
    return () => window.removeEventListener("ws-message", handler);
  }, [engine]);

  // Announce the departure while the socket is still open.
  //
  // Closing a tab otherwise leaves it to the server noticing the socket die,
  // which can lag by up to the read timeout, and the whole room goes on showing
  // someone who has gone. pagehide covers tab close, navigation and mobile
  // backgrounding, where beforeunload does not.
  useEffect(() => {
    const announceLeave = () => engine.announceLeave();
    window.addEventListener("pagehide", announceLeave);
    return () => window.removeEventListener("pagehide", announceLeave);
  }, [engine]);

  const joinVoice = useCallback(
    (channelId?: string, restore?: VoiceRestoreState) => engine.join(channelId, restore),
    [engine],
  );
  const leaveVoice = useCallback(() => engine.leave(), [engine]);
  const releaseVoice = useCallback(() => engine.release(), [engine]);
  const toggleMute = useCallback(() => engine.toggleMute(), [engine]);
  const toggleDeafen = useCallback(() => engine.toggleDeafen(), [engine]);
  const toggleInputMode = useCallback(() => engine.toggleInputMode(), [engine]);
  const setUserVolume = useCallback((userId: string, vol: number) => engine.setUserVolume(userId, vol), [engine]);

  // ─── PTT ──────────────────────────────────────────────────────────────────
  // The dialog's switch, or a call joined with push-to-talk remembered.
  const { inputMode } = settings;
  useEffect(() => {
    if (state.inVoiceChannel && inputMode !== state.voiceInputMode) engine.toggleInputMode();
  }, [engine, state.inVoiceChannel, inputMode, state.voiceInputMode]);

  // PTT key handling
  useEffect(() => {
    if (!state.inVoiceChannel || state.voiceInputMode !== "ptt") return;
    const setTransmitting = (on: boolean) => engine.setTransmitting(on);

    // The desktop app watches its key system-wide, so it works while a game
    // has focus; a browser only sees keys while this page does.
    const desktopPtt = hasDesktopFeature("ptt") ? desktop?.pushToTalk : undefined;
    if (desktopPtt) {
      return desktopPtt.subscribe(setTransmitting);
    }

    const down = (e: KeyboardEvent) => {
      if (e.key === "`" && !e.repeat) setTransmitting(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "`") setTransmitting(false);
    };
    // The keyup never arrives if focus leaves mid-press; without this the mic
    // stayed open until the key was pressed again.
    const blur = () => setTransmitting(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [engine, state.inVoiceChannel, state.voiceInputMode]);

  // For connection stats and speaking detection.
  const [refs] = useState(() => ({
    micRef: liveRef<LocalMic | null>(() => engine.connections.mic),
    voicePublisherPcRef: liveRef<VoicePeer | null>(() => engine.connections.publisher),
    voiceSubscriberPcRef: liveRef<VoicePeer | null>(() => engine.connections.subscriber),
  }));

  return {
    ...refs,
    joinVoice,
    leaveVoice,
    /** Drop the local half of a call without announcing a leave — for when the
     *  session is already gone on the server's side. */
    releaseVoice,
    toggleMute,
    toggleDeafen,
    toggleInputMode,
    setUserVolume,
  };
}
