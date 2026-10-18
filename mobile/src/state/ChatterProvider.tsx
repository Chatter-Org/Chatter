import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { AppState as RNAppState } from "react-native";
import Constants from "expo-constants";
import {
  apiLogin,
  clearTokens,
  getAccessToken,
  getIsAdmin,
  getTotpVerified,
  refreshSession,
  setAccessToken,
  setIsAdmin,
  setTotpVerified,
} from "@chatter/core/api";
import { saveLastChannels } from "@chatter/core/lastChannel";
import { clearMessagePreviews } from "@chatter/core/messageLinks";
import { accessTokenExpired, readAccessToken } from "@chatter/core/session";
import { createStoreActions, type StoreActions } from "@chatter/core/store/actions";
import { reducer } from "@chatter/core/store/reducer";
import { initialState, type AppState } from "@chatter/core/store/types";
import { createWsMessageHandler } from "@chatter/core/store/wsHandler";
import { decideResumeAction } from "@chatter/core/wsResume";
import { VoiceEngine } from "@chatter/core/voice/engine";
import { decideVoiceRejoin } from "@chatter/core/voice/rejoin";
import { subscribeVoiceSettings } from "@chatter/core/voice/settings";
import { showToast } from "@/platform/toast";
import { createNativeVoiceBackend } from "@/voice/nativeBackend";
import { clearSpeaking, noteSpeakingFrame } from "@/voice/speaking";
import { useCallService } from "@/voice/useCallService";
import { signOutThisDevice } from "@/platform/signOut";
import { socketUrl } from "@/platform/server";
import { hasStoredSession } from "@/platform/tokenStore";

/**
 * The mobile app's store: the web client's state, reducer, socket handling and
 * actions (all from @chatter/core), plus the lifecycle a phone has instead of a
 * browser tab.
 *
 *   - The session is restored from the Keystore's refresh token, not a cookie.
 *   - "The tab came back" is the app returning to the foreground.
 *   - The socket closes a little while after the app is put away, so the
 *     server stops counting this device as present (and, once push lands,
 *     knows to push to it instead).
 */

/** How long to wait before opening the socket again after it closed. */
const SOCKET_RETRY_MS = 3000;
/** Grace before a backgrounded app lets its socket go: long enough for a quick
 *  switch to another app, short enough that presence is honest. */
const BACKGROUND_CLOSE_MS = 30_000;
/** How often the server is told someone is still using the app. */
const ACTIVITY_PING_MS = 60_000;
/** Session restore retries when the server cannot be reached. */
const RESTORE_BASE_MS = 1000;
const RESTORE_MAX_MS = 30_000;

export interface ChatterActions extends StoreActions {
  signIn(username: string, password: string, totpCode?: string): Promise<{ requiresTotp?: boolean }>;
  signOut(): Promise<void>;
  /** Voice, through the shared engine (@chatter/core/voice/engine). */
  voice: {
    join(channelId: string): Promise<void>;
    leave(): Promise<void>;
    toggleMute(): void;
    toggleDeafen(): void;
    toggleInputMode(): void;
    setTransmitting(on: boolean): void;
    setUserVolume(userId: string, volume: number): void;
    /** Whether this device's microphone is picking up speech, for the ring. */
    isSpeaking(): boolean;
  };
}

const StateContext = createContext<AppState | null>(null);
const ActionsContext = createContext<ChatterActions | null>(null);

export function useChatter(): AppState {
  const state = useContext(StateContext);
  if (!state) throw new Error("useChatter must be used inside <ChatterProvider>");
  return state;
}

export function useChatterActions(): ChatterActions {
  const actions = useContext(ActionsContext);
  if (!actions) throw new Error("useChatterActions must be used inside <ChatterProvider>");
  return actions;
}

export function ChatterProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const socketRef = useRef<WebSocket | null>(null);
  const hasConnectedRef = useRef(false);

  const [shared] = useState(() =>
    createStoreActions({
      dispatch,
      getState: () => stateRef.current,
      send: (frame) => {
        const ws = socketRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      },
    }),
  );

  // The socket handler is the web client's own; it reaches back for these.
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loadRoomsRef = useRef(shared.loadRooms);
  const loadPresenceRef = useRef(shared.loadPresence);
  const [handleFrame] = useState(() =>
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef, loadPresenceRef),
  );

  // ─── Voice ─────────────────────────────────────────────────────────────────

  const [voice] = useState(() => {
    let reconnecting = false;
    return new VoiceEngine({
      dispatch,
      getState: () => stateRef.current,
      socket: () => socketRef.current,
      loadVoiceMembers: () => shared.loadVoiceMembers(),
      selectBackend: createNativeVoiceBackend,
      notices: {
        reconnecting() {
          reconnecting = true;
          showToast({ message: "Reconnecting to voice…" });
        },
        recovered() {
          if (!reconnecting) return;
          reconnecting = false;
          showToast({ message: "Voice reconnected" });
        },
        failed: (message) => showToast({ message, tone: "error" }),
        info: (message) => showToast({ message }),
        error: (message) => showToast({ message, tone: "error" }),
      },
    });
  });
  // The engine keeps its own copy of what it needs; let it catch up.
  useEffect(() => voice.sync(), [voice, state]);
  useEffect(() => {
    if (!state.inVoiceChannel) clearSpeaking();
  }, [state.inVoiceChannel]);
  useEffect(() => subscribeVoiceSettings(() => voice.applySettings()), [voice]);
  useCallService(state, voice);

  // ─── Session ───────────────────────────────────────────────────────────────

  const enterSession = (accessToken: string) => {
    const claims = readAccessToken(accessToken);
    if (!claims) return false;
    dispatch({ type: "LOGIN", payload: { accessToken, userId: claims.sub } });
    dispatch({ type: "SET_IS_ADMIN", payload: getIsAdmin() });
    dispatch({ type: "SET_TOTP_VERIFIED", payload: getTotpVerified() });
    return true;
  };

  // Restore the session from the Keystore on launch. A server that cannot be
  // reached says nothing about the session, so it is asked again (backing off)
  // behind a reconnecting screen rather than showing the sign-in form.
  useEffect(() => {
    if (!hasStoredSession()) {
      dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const restore = () => {
      void refreshSession().then((outcome) => {
        if (cancelled) return;
        if (outcome === "refreshed") {
          const token = getAccessToken();
          dispatch({ type: "SET_SESSION_RESTORE", payload: token && enterSession(token) ? "restored" : "absent" });
          return;
        }
        if (outcome === "rejected") {
          dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
          return;
        }
        attempt += 1;
        dispatch({ type: "SET_SESSION_RESTORE", payload: "unreachable" });
        timer = setTimeout(restore, Math.min(RESTORE_BASE_MS * 2 ** (attempt - 1), RESTORE_MAX_MS));
      });
    };
    restore();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // ─── Socket ────────────────────────────────────────────────────────────────

  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the socket last went down, for deciding whether a call survives it. */
  const droppedAt = useRef<number | null>(null);

  const closeSocket = (reason: string) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    const ws = socketRef.current;
    if (!ws) return;
    // Let go of it entirely. A socket still connecting would otherwise finish
    // opening, say hello and deliver every frame beside its replacement —
    // the server sends to each of them, so each voice answer arrived twice.
    ws.onclose = null; // a deliberate close does not schedule a reconnect
    ws.onmessage = null;
    ws.onopen = () => ws.close(1000, reason);
    try {
      ws.close(1000, reason);
    } catch {
      // Already gone.
    }
    socketRef.current = null;
    dispatch({ type: "SET_WS_CONNECTED", payload: false });
  };

  const connect = async () => {
    if (socketRef.current || !getAccessToken()) return;
    // Access tokens are short-lived; the server would refuse an expired one.
    if (accessTokenExpired(getAccessToken(), 10_000)) {
      const outcome = await refreshSession();
      if (outcome === "rejected") {
        dispatch({ type: "LOGOUT" });
        return;
      }
      if (outcome === "unreachable") {
        // The same outage that dropped the socket; keep trying on its cadence.
        retryTimer.current = setTimeout(() => void connect(), SOCKET_RETRY_MS);
        return;
      }
    }
    // In the background only a call may open one (to repair itself).
    if (socketRef.current || (RNAppState.currentState !== "active" && !stateRef.current.inVoiceChannel)) return;

    const ws = new WebSocket(socketUrl());
    socketRef.current = ws;
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          access_token: getAccessToken(),
          is_mobile: true,
          client: { kind: "mobile", version: Constants.expoConfig?.version ?? "0" },
        }),
      );
      dispatch({ type: "SET_WS_CONNECTED", payload: true });
      // The first connection is a load; every one after it is a repair.
      if (hasConnectedRef.current) {
        void shared.recoverMissedMessages();
        dispatch({ type: "CLEAR_SCREEN_VIEWERS" });
        rejoinVoice();
      }
      droppedAt.current = null;
      hasConnectedRef.current = true;
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data);
        handleFrame(frame);
        void voice.handleFrame(frame);
        noteSpeakingFrame(frame);
      } catch (e) {
        console.warn("socket: could not handle a frame", e);
      }
    };
    ws.onclose = () => {
      if (socketRef.current === ws) socketRef.current = null;
      droppedAt.current ??= Date.now();
      dispatch({ type: "SET_WS_CONNECTED", payload: false });
      retryTimer.current = setTimeout(() => void connect(), SOCKET_RETRY_MS);
    };
  };

  // The server drops a call with the socket that carried it, so a socket that
  // comes back puts the call back together, unless it was gone so long that
  // reappearing would surprise the room (see voice/rejoin.ts).
  const rejoinVoice = () => {
    const current = stateRef.current;
    const decision = decideVoiceRejoin({
      inVoiceChannel: current.inVoiceChannel,
      voiceRoomId: current.voiceRoomId,
      downForMs: droppedAt.current === null ? 0 : Date.now() - droppedAt.current,
    });
    if (decision === "nothing-to-restore") return;
    if (decision === "release") {
      void voice.release();
      showToast({ message: "You were disconnected for too long — rejoin the call to come back." });
      return;
    }
    // Let the socket's own hello be processed before rejoining on it.
    const channelId = current.voiceChannelId;
    setTimeout(() => void voice.join(channelId ?? undefined), 500);
  };

  // Signed in: load what the shell shows, and open the socket.
  useEffect(() => {
    if (!state.accessToken) return;
    void shared.loadRooms().catch(() => {});
    void shared.loadUnreads();
    void shared.loadNotificationSettings();
    void shared.loadContinuity();
    void connect();
    return () => closeSocket("signed out");
    // `shared` and the socket helpers live for the provider's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.accessToken]);

  // Foreground and background. Put away, the socket is let go after a grace
  // period; brought back, the shared rule decides between nothing, a resync
  // and a fresh connection (see wsResume.ts).
  useEffect(() => {
    if (!state.accessToken) return;
    let backgroundedAt: number | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const sub = RNAppState.addEventListener("change", (next) => {
      if (next === "background") {
        backgroundedAt = Date.now();
        // A call keeps its socket: it carries the call's signalling, and the
        // call's foreground service keeps the app running for it.
        closeTimer = setTimeout(() => {
          if (!stateRef.current.inVoiceChannel) closeSocket("app in background");
        }, BACKGROUND_CLOSE_MS);
        return;
      }
      if (next !== "active") return;
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = null;
      const hiddenFor = backgroundedAt === null ? 0 : Date.now() - backgroundedAt;
      backgroundedAt = null;
      const action = decideResumeAction({
        socketOpen: socketRef.current?.readyState === WebSocket.OPEN,
        hiddenForMs: hiddenFor,
      });
      if (action === "nothing") return;
      if (action === "resync") {
        void shared.loadVoiceMembers();
        void shared.loadPresence();
        void shared.loadUnreads();
        return;
      }
      closeSocket("resuming");
      hasConnectedRef.current = true; // what follows is a repair, not a first load
      void connect();
    });
    return () => {
      sub.remove();
      if (closeTimer) clearTimeout(closeTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.accessToken]);

  // Someone with the app open is using it; tell the server, which otherwise
  // lets presence decay to idle on its own clock.
  useEffect(() => {
    if (!state.accessToken) return;
    const interval = setInterval(() => {
      if (RNAppState.currentState !== "active") return;
      const ws = socketRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "activity" }));
    }, ACTIVITY_PING_MS);
    return () => clearInterval(interval);
  }, [state.accessToken]);

  // Keep where the reader was in each room past a restart.
  useEffect(() => {
    saveLastChannels(state.userId, state.lastChannelByRoom);
  }, [state.userId, state.lastChannelByRoom]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const actions = useMemo<ChatterActions>(
    () => ({
      ...shared,
      voice: {
        async join(channelId) {
          const channel = stateRef.current.channels.find((c) => c.channel_id === channelId);
          if (channel) dispatch({ type: "SET_VOICE_STATE", payload: { voiceChannelName: channel.name } });
          await voice.join(channelId);
        },
        leave: () => voice.leave(),
        toggleMute: () => voice.toggleMute(),
        toggleDeafen: () => voice.toggleDeafen(),
        toggleInputMode: () => voice.toggleInputMode(),
        setTransmitting: (on) => voice.setTransmitting(on),
        setUserVolume: (userId, volume) => voice.setUserVolume(userId, volume),
        isSpeaking: () => voice.connections.mic?.isSpeaking() ?? false,
      },
      async signIn(username, password, totpCode) {
        const data = await apiLogin(username, password, totpCode);
        if (data.requires_totp) return { requiresTotp: true };
        setAccessToken(data.access_token);
        setIsAdmin(!!data.is_admin);
        setTotpVerified(!!data.totp_verified);
        dispatch({ type: "LOGIN", payload: { accessToken: data.access_token, userId: data.user_id } });
        dispatch({ type: "SET_IS_ADMIN", payload: !!data.is_admin });
        dispatch({ type: "SET_TOTP_VERIFIED", payload: !!data.totp_verified });
        dispatch({ type: "SET_SESSION_RESTORE", payload: "restored" });
        return {};
      },
      async signOut() {
        if (stateRef.current.inVoiceChannel) await voice.leave();
        closeSocket("signed out");
        // This device only: the account stays signed in everywhere else.
        await signOutThisDevice();
        clearTokens();
        // What one account was allowed to read is not what the next one is.
        clearMessagePreviews();
        hasConnectedRef.current = false;
        dispatch({ type: "LOGOUT" });
        dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shared, voice],
  );

  return (
    <StateContext.Provider value={state}>
      <ActionsContext.Provider value={actions}>{children}</ActionsContext.Provider>
    </StateContext.Provider>
  );
}
