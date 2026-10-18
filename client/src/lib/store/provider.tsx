import {
  useReducer,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { decideResumeAction } from "@/lib/wsResume";
import { useVersionCheck } from "@/hooks/useVersionCheck";
import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";
import {
  setAccessToken,
  clearTokens,
  getAccessToken,
  refreshSession,
  hadSession,
  setIsAdmin,
  getIsAdmin,
  setTotpVerified,
  getTotpVerified,
  apiLogin,
  apiRegister,
  apiLogout,
  apiDeleteAccount,
  apiMarkRead,
  apiGetMessagesAfter,
  apiCreateRoom,
  apiJoinRoom,
  apiLeaveRoom,
  apiSearchMessages,
  apiGetRoomThreads,
  apiGetPins,
  apiCreateEvent,
  apiUpdateEvent,
  apiDeleteEvent,
  apiSetRsvp,
  apiCreatePoll,
  apiVotePoll,
  apiGetPoll,
  apiClosePoll,
  type EventDraft,
  type PollDraft,
  type RsvpStatus,
  apiPinMessage,
  apiUnpinMessage,
  apiGetAllRooms,
  apiCreateDM,
  apiAddToDM,
  apiUpdateTopic,
  apiUpdateRoomSettings,
  apiKickMember,
  apiBanMember,
  apiUnbanMember,
  apiSetMemberRole,
  apiSetNameColors,
  apiGetRoomGroups,
  apiSetSidebarOrder,
  apiCreateRoomGroup,
  apiDeleteRoomGroup,
  apiUpdateRoomGroup,
  apiSetGroupRooms,
  apiSetGroupCollapsed,
  apiGetFriends,
  apiSendFriendRequest,
  apiAcceptFriendRequest,
  apiRejectFriendRequest,
  apiRemoveFriend,
  apiBlockUser,
  apiUnblockUser,
  apiGetServerInfo,
  apiGetThreadMessages,
  apiSendThreadMessage,
  apiSetThreadName,
  apiDeleteThread,
  apiCreateChannel,
  apiUpdateChannel,
  apiDeleteChannel,
  apiGetRoles,
  apiCreateRole,
  apiUpdateRole,
  apiDeleteRole,
  apiGetAllMemberRoles,
  apiAssignMemberRoles,
  PAGE_SIZE,
} from "../api";
import { clearMediaBlobs } from "@/lib/mediaBlobs";
import { clearMessagePreviews } from "@/lib/messageLinks";
import { fetchIceServers } from "../webrtc";
import { AppActionsContext, AppStateContext, type AppActions } from "./context";
import {
  initialState,
} from "./types";
import type { ProfileTheme } from "../profileTheme";
import { reducer } from "./reducer";
import { createWsMessageHandler } from "./wsHandler";
import { createStoreActions } from "@chatter/core/store/actions";
import { saveLastChannels } from "../lastChannel";

/** How long to wait before opening the socket again after it closed. */
const WS_RECONNECT_MS = 3000;

/** How often, at most, to report that someone is still at their machine.
 *
 * A ceiling on chatter rather than a schedule: the ping is skipped entirely
 * when there has been no input since the last one. The server's idle threshold
 * is measured in minutes, so reporting oftener than this would buy nothing. */
const ACTIVITY_PING_MS = 60_000;

/** How often presence is reconciled against the server when nothing prompted it.
 *
 *  Long, because it is a safety net rather than the mechanism: presence rides
 *  the socket, and the paths that can actually miss something — a closed
 *  socket, a room switch, a backgrounded tab — each re-fetch on their own.
 */
const PRESENCE_RECONCILE_MS = 5 * 60_000;

/** Retry schedule for restoring a session at page load when nothing answers.
 *
 * Backed off rather than hammered, and bounded: a server that has not come
 * back within a couple of minutes is not one to keep silently polling, and the
 * login screen already sitting there stays the way back in. */
const SESSION_RESTORE_BASE_MS = 1000;
const SESSION_RESTORE_MAX_MS = 30_000;
const SESSION_RESTORE_MAX_ATTEMPTS = 8;

export function AppProvider({ children }: { children: ReactNode }) {
  useVersionCheck();
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const typingTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep a ref to latest state for WS handler closures
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The actions shared with the mobile app (@chatter/core/store/actions).
  // Created once, so each keeps one identity for the provider's lifetime.
  const [shared] = useState(() =>
    createStoreActions({
      dispatch,
      getState: () => stateRef.current,
      send: (frame) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(JSON.stringify(frame));
        return true;
      },
    }),
  );

  // Fetch public server settings on mount
  useEffect(() => {
    apiGetServerInfo().then((info) => {
      dispatch({ type: "SET_SERVER_SETTINGS", payload: { requireAuthForUploads: info.require_auth_for_uploads, uploadLimitBytes: info.upload_limit_bytes ?? 0, storageLimitBytes: info.storage_limit_bytes ?? 0 } });
    }).catch(() => {});
  }, []);

  // Reset search when switching rooms
  useEffect(() => {
    dispatch({ type: "CLOSE_SEARCH" });
  }, [state.currentRoomId]);

  // Debounced message-search execution (state lives in the store so the search
  // panel and the provider share one source of truth).
  useEffect(() => {
    const { open, query, filter, fileTypeFilter, thisChannel } = state.search;
    if (!open || !state.currentRoomId) return;

    let searchChannelId: string | undefined;
    let searchNoChannelOnly: boolean | undefined;
    if (thisChannel) {
      if (state.currentChannelId) {
        searchChannelId = state.currentChannelId;
      } else {
        searchNoChannelOnly = true;
      }
    }

    if (filter === "thread") {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      searchTimerRef.current = setTimeout(async () => {
        dispatch({ type: "SET_SEARCH", payload: { loading: true } });
        try {
          const page = await apiGetRoomThreads(
            state.currentRoomId!,
            query.trim() || undefined,
            searchChannelId,
            searchNoChannelOnly
          );
          dispatch({
            type: "SET_SEARCH",
            payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
          });
        } catch {
          dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
        } finally {
          dispatch({ type: "SET_SEARCH", payload: { loading: false } });
        }
      }, 300);
      return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }

    if (filter !== "file" && !query.trim()) {
      dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
      return;
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      dispatch({ type: "SET_SEARCH", payload: { loading: true } });
      try {
        const page = await apiSearchMessages(
          state.currentRoomId!,
          query.trim(),
          filter,
          fileTypeFilter,
          searchChannelId,
          searchNoChannelOnly
        );
        dispatch({
          type: "SET_SEARCH",
          payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
        });
      } catch {
        dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
      } finally {
        dispatch({ type: "SET_SEARCH", payload: { loading: false } });
      }
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [state.search.open, state.search.query, state.search.filter, state.search.fileTypeFilter, state.search.thisChannel, state.currentRoomId, state.currentChannelId]);

  // Rehydrate session on mount via the HttpOnly refresh-token cookie.
  // No tokens are read from localStorage — the cookie is sent automatically
  // by the browser and is not accessible to JavaScript.
  useEffect(() => {
    const loginWithToken = (accessToken: string) => {
      try {
        const payload = JSON.parse(atob(accessToken.split(".")[1]));
        dispatch({
          type: "LOGIN",
          payload: { accessToken, userId: payload.sub },
        });
        dispatch({ type: "SET_IS_ADMIN", payload: getIsAdmin() });
        dispatch({ type: "SET_TOTP_VERIFIED", payload: getTotpVerified() });
        // Verify admin status with the server
        fetch("/api/admin/stats", {
          headers: { Authorization: `Bearer ${accessToken}` },
        }).then((res) => {
          const isAdmin = res.ok;
          setIsAdmin(isAdmin);
          dispatch({ type: "SET_IS_ADMIN", payload: isAdmin });
        }).catch(() => {});
        // Fetch ICE servers now that the token is available
        fetchIceServers();
      } catch {
        clearTokens();
      }
    };

    // Always try a cookie-based refresh on page load.
    // If the user has a valid session, the server will issue a fresh access token.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const restoreSession = () => {
      void refreshSession().then((outcome) => {
        if (cancelled) return;
        if (outcome === "refreshed") {
          const newToken = getAccessToken();
          if (newToken) loginWithToken(newToken);
          dispatch({ type: "SET_SESSION_RESTORE", payload: "restored" });
          return;
        }
        // The server judged the cookie and there is no session behind it, so
        // the login screen is the right answer.
        if (outcome === "rejected") {
          dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
          return;
        }
        // Nothing answered. Loading while the server is down or restarting is
        // not evidence of being logged out, and showing a login screen to
        // someone who still has a session is why refreshing the page "logs
        // them in" — it was only ever asking again at a better moment.
        attempt += 1;
        // Someone who has signed in on this browser is waiting behind the
        // reconnecting screen, so keep asking however long it takes; the delay
        // settles at SESSION_RESTORE_MAX_MS. A browser that has never held a
        // session has a login form to get on with, so that one gives up.
        if (!hadSession() && attempt > SESSION_RESTORE_MAX_ATTEMPTS) {
          dispatch({ type: "SET_SESSION_RESTORE", payload: "absent" });
          return;
        }
        dispatch({ type: "SET_SESSION_RESTORE", payload: "unreachable" });
        timer = setTimeout(
          restoreSession,
          Math.min(SESSION_RESTORE_BASE_MS * 2 ** (attempt - 1), SESSION_RESTORE_MAX_MS),
        );
      });
    };
    restoreSession();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Keep a ref to loadRooms so WS handler can call it without stale closure
  const loadRoomsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Defined further down, but needed by the reconnect handler above it.
  const loadUnreadsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const loadVoiceMembersRef = useRef<(roomId?: string) => Promise<void>>(() => Promise.resolve());
  const loadPresenceRef = useRef<(roomId?: string) => Promise<void>>(() => Promise.resolve());
  const loadActiveThreadsRef = useRef<(roomId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );

  const handleWsMessage = useCallback(
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef, loadPresenceRef),
    []
  );

  /** False until the socket has connected once, so the first open is not
   *  mistaken for a reconnection. */
  const hasConnectedRef = useRef(false);
  // When the page was last backgrounded, so a resume can tell a glance away
  // from a phone that was put down.
  const hiddenAtRef = useRef<number | null>(null);

  /**
   * Replay whatever arrived while the socket was down.
   *
   * Live events are the only way a message reaches an open channel, so a
   * dropped connection silently leaves a hole in the timeline — the client
   * keeps rendering, the banner clears, and nothing says that anything is
   * missing. This closes the hole from the newest message actually held,
   * looping when the gap was wider than one page.
   *
   * Messages are replayed through ADD_MESSAGE, which ignores an event_id it
   * already has, so an overlap with what arrived live is harmless.
   */
  const recoverMissedMessages = useCallback(async () => {
    // Server-computed, so these are right even where the timeline is not.
    void loadUnreadsRef.current();
    // Who is in a call, who is muted, who is sharing — all of it is assembled
    // from events, and every event sent while the socket was down reached
    // nobody. Nothing else refetches it, so a single missed join left the call
    // looking wrong until the room was reselected. Ask the server outright.
    //
    // (The server pushes the same snapshot when the socket opens; this covers
    // the case where the connection survived and only the events were lost.)
    void loadVoiceMembersRef.current();
    // Online, idle and offline are broadcast the same way, and were missed the
    // same way. The poll would correct it within ten seconds, but only for the
    // room on screen and only once it next fires.
    void loadPresenceRef.current();

    const { currentRoomId, currentChannelId, messages } = stateRef.current;
    if (!currentRoomId) return;

    // With nothing loaded there is no gap to close — opening the channel will
    // fetch it. Only a timeline that already has a tail can have lost one.
    //
    // The cursor carries the event id as well as the timestamp: two messages
    // can share a millisecond, and asking only for "newer than this time"
    // would step straight over the second one.
    let cursor: { ts: number; eventId: string } | null = null;
    for (const message of messages) {
      if (
        !cursor ||
        message.origin_server_ts > cursor.ts ||
        (message.origin_server_ts === cursor.ts && message.event_id > cursor.eventId)
      ) {
        cursor = { ts: message.origin_server_ts, eventId: message.event_id };
      }
    }
    if (!cursor) return;

    try {
      // Bounded: a socket down for days should not walk the whole history.
      for (let page = 0; page < 20; page++) {
        const data = await apiGetMessagesAfter(
          currentRoomId,
          cursor.ts,
          currentChannelId ?? undefined,
          undefined,
          cursor.eventId,
        );
        const chunk = data.chunk || [];
        if (chunk.length === 0) return;
        for (const message of chunk) {
          dispatch({ type: "ADD_MESSAGE", payload: message });
        }
        // Continue from the last message of this page, in the server's order.
        const last = chunk[chunk.length - 1];
        cursor = { ts: last.origin_server_ts, eventId: last.event_id };
        if (!data.has_more) return;
      }
    } catch {
      // The socket is back and live messages are flowing again; the hole stays
      // until the channel is reopened, which is no worse than before.
    }
  }, []);

  // WebSocket connection — refreshes expired token before connecting
  const connectWebSocket = useCallback(async () => {
    let token = getAccessToken();
    if (!token) return;

    // Refresh the token if it has expired (access tokens live only 15 min)
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      if (payload.exp * 1000 <= Date.now()) {
        const outcome = await refreshSession();
        if (outcome === "rejected") {
          dispatch({ type: "LOGOUT" });
          return;
        }
        if (outcome === "unreachable") {
          // The server is down, restarting, or behind a proxy answering for
          // it. That is exactly when this runs — the socket dropped for the
          // same reason — so it must not be read as the session ending. Keep
          // trying on the same cadence as the socket's own retry; returning
          // without one would strand the client until it was reloaded.
          setTimeout(connectWebSocket, WS_RECONNECT_MS);
          return;
        }
        token = getAccessToken();
        if (!token) return;
      }
    } catch {
      // Malformed token — attempt connection anyway and let the server reject it
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      // Use getAccessToken() in case another refresh happened between now and above
      const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
      ws.send(JSON.stringify({
        access_token: getAccessToken() ?? token,
        is_mobile: isMobileDevice,
        // The desktop app says so: it keeps its socket open from the tray, so
        // the server only lets it stand in for a phone push while it's in use.
        ...(desktop && { client: { kind: "desktop", version: desktop.appVersion } }),
      }));
      // The server forgets activity with the connection; tell it again.
      if (hasDesktopFeature("game-activity")) {
        void desktop!.gameActivity!.current().then((game) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "game_activity", game }));
        }).catch(() => {});
      }
      dispatch({ type: "SET_WS_CONNECTED", payload: true });

      // Live events only exist while the socket does. Anything sent while it
      // was down reached nobody, so the first connection is a load and every
      // one after it is a repair.
      if (hasConnectedRef.current) {
        void recoverMissedMessages();
        // Viewer lists describe live subscriptions the server keeps only in
        // memory. Reconnecting may mean reconnecting to a restarted server
        // that has none, so drop ours and wait to be told again rather than
        // going on showing people who were watching a share that is over.
        dispatch({ type: "CLEAR_SCREEN_VIEWERS" });
      }
      hasConnectedRef.current = true;
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    };

    ws.onerror = () => {};
    ws.onclose = () => {
      wsRef.current = null;
      dispatch({ type: "SET_WS_CONNECTED", payload: false });
      setTimeout(connectWebSocket, WS_RECONNECT_MS);
    };
  }, []); // getAccessToken / apiRefreshToken are module-level, no deps needed

  // The desktop app reports the game being played as "Playing …".
  useEffect(() => {
    if (!hasDesktopFeature("game-activity")) return;
    return desktop!.gameActivity!.subscribe((game) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "game_activity", game }));
    });
  }, []);

  // Keep where the reader was in each room past a reload.
  useEffect(() => {
    saveLastChannels(state.userId, state.lastChannelByRoom);
  }, [state.userId, state.lastChannelByRoom]);

  // Update document title with total unread notification count
  useEffect(() => {
    const total = Object.values(state.roomMentions).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) Chatter` : "Chatter";
  }, [state.roomMentions]);

  // A backgrounded phone freezes the page: timers stop, and the socket the
  // server timed out is not necessarily reported closed on this side either.
  // Reconnection is driven entirely by onclose, so without this the page comes
  // back showing whoever was in a call when it was put down.
  useEffect(() => {
    if (!state.accessToken) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;

      const action = decideResumeAction({
        socketOpen: wsRef.current?.readyState === WebSocket.OPEN,
        hiddenForMs: hiddenAt === null ? 0 : Date.now() - hiddenAt,
      });
      if (action === "nothing") return;
      if (action === "resync") {
        void loadVoiceMembersRef.current();
        void loadPresenceRef.current();
        return;
      }
      // Drop whatever is left of the old socket without letting its onclose
      // schedule a second connection on top of this one.
      if (wsRef.current) {
        wsRef.current.onclose = null;
        try { wsRef.current.close(); } catch { /* already gone */ }
        wsRef.current = null;
      }
      void connectWebSocket();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [state.accessToken, connectWebSocket]);

  // Connect WS when logged in
  useEffect(() => {
    if (state.accessToken && !wsRef.current && getAccessToken()) {
      connectWebSocket();
    }
    return () => {
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [state.accessToken]); // connectWebSocket is stable ([] deps), no need to include

  // Say goodbye when the page is really going away.
  //
  // Closing a tab or app without a close frame leaves the server waiting out
  // its 45s read timeout before anyone sees the session end — most of why a
  // phone kept showing as online after it was closed. `persisted` separates a
  // discard from a back/forward-cache suspend: an app merely switched away
  // keeps its session, and reconnects on its own if the socket dies meanwhile.
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      if (e.persisted) return;
      const ws = wsRef.current;
      if (!ws) return;
      ws.onclose = null; // nothing to reconnect to; the page is leaving
      ws.close(1000, "page closed");
      wsRef.current = null;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Tell the server its person is still there.
  //
  // This replaced an unconditional keepalive on the same cadence, which is what
  // made the idle status unreachable: the server refreshed `last_active` for
  // anything that arrived, so a tab left open overnight reported someone at
  // their desk. The socket's own ping/pong already proves the connection is
  // alive, so nothing is lost by only speaking up when there is something to
  // say.
  //
  // "Something to say" is real input since the last ping, and a visible tab. A
  // page left open in the background stops reporting and decays to idle on the
  // server's own clock, which is the behaviour anyone would expect of it.
  useEffect(() => {
    if (!state.accessToken) return;

    let interacted = true; // opening the app is itself an interaction
    const noteInteraction = () => {
      interacted = true;
    };
    const events: (keyof DocumentEventMap)[] = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const event of events) {
      document.addEventListener(event, noteInteraction, { passive: true });
    }
    window.addEventListener("focus", noteInteraction);

    const interval = setInterval(() => {
      if (!interacted || document.visibilityState === "hidden") return;
      interacted = false;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "activity" }));
      }
    }, ACTIVITY_PING_MS);

    return () => {
      clearInterval(interval);
      for (const event of events) {
        document.removeEventListener(event, noteInteraction);
      }
      window.removeEventListener("focus", noteInteraction);
    };
  }, [state.accessToken]);

  // Presence reconciliation.
  //
  // Not a poll. The server broadcasts every presence transition as it happens
  // — connecting, disconnecting, a manual or custom status, a profile edit,
  // going active — and announces the one that has no event of its own, going
  // idle, from a sweep a few seconds wide. So presence arrives over the socket,
  // and a fetch is only ever needed where the socket could not have told us:
  // when it was closed, and when the room on screen changed. The first is
  // handled on reconnect, the second by `selectRoom`.
  //
  // What is left is the tab coming back to the foreground, which is both a
  // catch-up and the reason this stopped being an interval: the old ten-second
  // poll had no visibility check at all, so a backgrounded phone asked for a
  // room's entire roster six times a minute for as long as the app stayed
  // open. The long timer below is a belt-and-braces net for a broadcast lost
  // to something we have not thought of, not the mechanism.
  useEffect(() => {
    if (!state.currentRoomId || !state.accessToken) return;

    const refreshIfVisible = () => {
      if (document.visibilityState === "hidden") return;
      void loadPresenceRef.current();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadPresenceRef.current();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const interval = setInterval(refreshIfVisible, PRESENCE_RECONCILE_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(interval);
    };
  }, [state.currentRoomId, state.accessToken]);

  // ─── Actions ───────────────────────────────────────────────────────────────

  const login = useCallback(async (username: string, password: string, totpCode?: string) => {
    const data = await apiLogin(username, password, totpCode);
    if (data.requires_totp) {
      return { requires_totp: true };
    }
    setAccessToken(data.access_token);
    setIsAdmin(!!data.is_admin);
    dispatch({
      type: "LOGIN",
      payload: { accessToken: data.access_token, userId: data.user_id },
    });
    dispatch({ type: "SET_IS_ADMIN", payload: !!data.is_admin });
    setTotpVerified(!!data.totp_verified);
    dispatch({ type: "SET_TOTP_VERIFIED", payload: !!data.totp_verified });
    return {};
  }, []);

  const register = useCallback(async (username: string, password: string, passwordConfirm: string, inviteCode?: string) => {
    const data = await apiRegister(username, password, passwordConfirm, inviteCode);
    // Don't store tokens - they aren't issued until TOTP verification
    return {
      user_id: data.user_id,
      totp_secret: data.totp_secret,
      totp_uri: data.totp_uri,
      totp_qr_base64: data.totp_qr_base64,
    };
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {}
    clearTokens();
    // Media fetched with the session's credentials outlives the session
    // otherwise — the blob URLs are held by the cache, not by the tab — and
    // the next person to sign in here shares this document.
    clearMediaBlobs();
    // Likewise a resolved message link: what one account was allowed to read
    // is not what the next one is, and these were resolved against the
    // account that is leaving.
    clearMessagePreviews();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    dispatch({ type: "LOGOUT" });
  }, []);

  const deleteAccount = useCallback(async (totpCode: string) => {
    await apiDeleteAccount(totpCode);
    clearTokens();
    clearMediaBlobs();
    clearMessagePreviews();
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    dispatch({ type: "LOGOUT" });
  }, []);

  const loadRooms = shared.loadRooms;
  loadRoomsRef.current = loadRooms;

  // Unread counts are derived server-side from stored read markers, so they
  // survive a refresh; the reducer's own tallies only cover the live session.
  const loadUnreads = shared.loadUnreads;
  loadUnreadsRef.current = loadUnreads;

  const markChannelRead = shared.markChannelRead;

  const moderateVoice = useCallback(
    (
      roomId: string,
      targetUserId: string,
      action: "mute" | "unmute" | "move" | "disconnect",
      targetChannelId?: string,
    ) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(
        JSON.stringify({
          type: "voice_moderate",
          room_id: roomId,
          target_user_id: targetUserId,
          action,
          ...(targetChannelId ? { target_channel_id: targetChannelId } : {}),
        }),
      );
    },
    [],
  );

  const loadNotificationSettings = shared.loadNotificationSettings;

  const setNotificationLevel = shared.setNotificationLevel;

  /**
   * The recently active threads a room's channel list previews.
   *
   * One request for the room rather than one per channel: the server already
   * sorts by activity, so grouping the answer is cheaper than asking N times.
   */
  const loadActiveThreads = shared.loadActiveThreads;
  loadActiveThreadsRef.current = loadActiveThreads;

  const loadContinuity = shared.loadContinuity;

  const saveDraft = shared.saveDraft;

  const saveResumePoint = shared.saveResumePoint;

  /** Open a room.
   *
   *  Six requests used to run here strictly one after another — channels, then
   *  roles, then messages, then permissions, then pins, then a full `/sync` for
   *  the member list — so the timeline waited on two calls it does not read,
   *  and the member list waited on all five. Only one dependency is real: the
   *  channel to land on comes out of the channel list, and messages, pins and
   *  permissions are all scoped to it. Everything else now runs alongside.
   */
  const selectRoom = shared.selectRoom;

  const loadOlderMessages = shared.loadOlderMessages;

  /** Open a room on one of its messages.
   *
   *  The target is recorded before the room is selected and acted on in
   *  `ChatArea`, because the two halves cannot happen in one place: landing
   *  on a message needs the room's channels and timeline, which exist only
   *  once selecting the room has finished, and the caller is a row on another
   *  page that this very switch is about to unmount. */
  const openMessage = shared.openMessage;

  const loadMessagesAround = shared.loadMessagesAround;

  const sendMessage = shared.sendMessage;

  const deleteMessage = shared.deleteMessage;

  const hardDeleteNotification = shared.hardDeleteNotification;

  const editMessage = shared.editMessage;

  // ─── Pinned messages ──────────────────────────────────────────────────
  const loadEvents = shared.loadEvents;
  const loadEventsRef = useRef(loadEvents);
  useEffect(() => { loadEventsRef.current = loadEvents; }, [loadEvents]);

  const createEvent = useCallback(async (draft: EventDraft) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { event } = await apiCreateEvent(roomId, draft);
    // The broadcast will arrive too, but it cannot carry this client's own
    // RSVP — and creating an event answers "going" for you.
    dispatch({ type: "UPSERT_ROOM_EVENT", payload: event });
  }, []);

  const updateEvent = useCallback(
    async (eventId: string, patch: Partial<EventDraft> & { cancelled?: boolean }) => {
      const roomId = stateRef.current.currentRoomId;
      if (!roomId) return;
      await apiUpdateEvent(roomId, eventId, patch);
    },
    [],
  );

  const deleteEvent = useCallback(async (eventId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    await apiDeleteEvent(roomId, eventId);
    // Deleting is the one case the broadcast covers fully, but dropping it
    // here too means the card goes as the button is released.
    dispatch({ type: "REMOVE_ROOM_EVENT", payload: eventId });
  }, []);

  const setRsvp = useCallback(async (eventId: string, status: RsvpStatus | "") => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const previous = stateRef.current.roomEvents.find((e) => e.event_id === eventId)?.my_rsvp ?? "";
    dispatch({ type: "SET_MY_RSVP", payload: { eventId, status } });
    try {
      await apiSetRsvp(roomId, eventId, status);
    } catch (err) {
      dispatch({ type: "SET_MY_RSVP", payload: { eventId, status: previous } });
      throw err;
    }
  }, []);

  const createPoll = useCallback(async (draft: PollDraft) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    // The channel is read here rather than in the dialog: it is the one the
    // person is looking at, and a poll that quietly landed in the room's
    // default channel would be a poll asked of the wrong people.
    draft = { ...draft, channel_id: stateRef.current.currentChannelId ?? undefined };
    // The poll's own message arrives on the socket and carries its state, so
    // nothing is inserted here — this is the one path where the broadcast is
    // complete, because a poll nobody has voted in has no per-viewer half.
    await apiCreatePoll(roomId, draft);
  }, []);

  const votePoll = useCallback(async (pollId: string, options: number[]) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const previous = stateRef.current.polls[pollId];
    const me = stateRef.current.userId;
    // Move the bars as the button is released rather than a round trip later.
    // The broadcast that follows replaces this with the server's tally, and a
    // refusal puts back exactly what was there.
    if (previous && me) {
      dispatch({
        type: "UPDATE_POLL",
        payload: {
          ...previous,
          voters: previous.voters.map((voters, index) => {
            const without = voters.filter((id) => id !== me);
            return options.includes(index) ? [...without, me] : without;
          }),
        },
      });
    }
    try {
      const { poll } = await apiVotePoll(roomId, pollId, options);
      dispatch({ type: "UPDATE_POLL", payload: poll });
    } catch (err) {
      if (previous) dispatch({ type: "UPDATE_POLL", payload: previous });
      throw err;
    }
  }, []);

  const closePoll = useCallback(async (pollId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { poll } = await apiClosePoll(roomId, pollId);
    dispatch({ type: "UPDATE_POLL", payload: poll });
  }, []);

  const loadPoll = useCallback(async (pollId: string) => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    const { poll } = await apiGetPoll(roomId, pollId);
    dispatch({ type: "UPDATE_POLL", payload: poll });
  }, []);

  const loadPins = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    try {
      const page = await apiGetPins(cur.currentRoomId, cur.currentChannelId || undefined);
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({
        type: "SET_PINNED_MESSAGES",
        payload: { pins: [], hasMore: false, nextOffset: 0 },
      });
    }
  }, []);

  const loadMorePins = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.pinsHasMore || cur.loadingMorePins) return;
    dispatch({ type: "SET_LOADING_MORE_PINS", payload: true });
    try {
      const page = await apiGetPins(
        cur.currentRoomId,
        cur.currentChannelId || undefined,
        cur.pinsNextOffset,
      );
      dispatch({
        type: "APPEND_PINNED_MESSAGES",
        payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_LOADING_MORE_PINS", payload: false });
    }
  }, []);

  const loadMoreSearchResults = useCallback(async () => {
    const cur = stateRef.current;
    const { open, query, filter, fileTypeFilter, thisChannel, hasMore, loadingMore, nextOffset } =
      cur.search;
    if (!open || !cur.currentRoomId || !hasMore || loadingMore) return;

    let searchChannelId: string | undefined;
    let searchNoChannelOnly: boolean | undefined;
    if (thisChannel) {
      if (cur.currentChannelId) {
        searchChannelId = cur.currentChannelId;
      } else {
        searchNoChannelOnly = true;
      }
    }

    dispatch({ type: "SET_SEARCH", payload: { loadingMore: true } });
    try {
      const page =
        filter === "thread"
          ? await apiGetRoomThreads(
              cur.currentRoomId,
              query.trim() || undefined,
              searchChannelId,
              searchNoChannelOnly,
              nextOffset,
            )
          : await apiSearchMessages(
              cur.currentRoomId,
              query.trim(),
              filter,
              fileTypeFilter,
              searchChannelId,
              searchNoChannelOnly,
              nextOffset,
            );
      dispatch({
        type: "APPEND_SEARCH_RESULTS",
        payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_SEARCH", payload: { loadingMore: false } });
    }
  }, []);

  const pinMessage = useCallback(async (eventId: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    // The server broadcasts m.room.pinned, which is what updates the list.
    await apiPinMessage(cur.currentRoomId, eventId);
  }, []);

  const unpinMessage = useCallback(async (eventId: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId) return;
    await apiUnpinMessage(cur.currentRoomId, eventId);
  }, []);

  const openThread = useCallback(async (eventId: string) => {
    if (!stateRef.current.currentRoomId) return;
    const roomId = stateRef.current.currentRoomId;
    const data = await apiGetThreadMessages(roomId, eventId);
    dispatch({
      type: "OPEN_THREAD",
      payload: {
        eventId,
        root: data.root,
        messages: data.messages,
        hasMore: data.has_more,
        posters: data.posters ?? [],
      },
    });
    // Opening a thread is reading it, so its unread mention badge is dismissed
    // on the server too — the reducer drops it for this session, the marker is
    // what keeps it dropped after a reload. A thread has its own marker because
    // its replies are not in the channel's timeline, so reading that channel
    // never showed anyone a reply and must not dismiss one.
    void apiMarkRead(roomId, undefined, eventId).catch(() => {});
    // Pins are a nicety on top of the thread, so a refusal leaves it open
    // with none rather than failing the open. SET_THREAD_PINS drops an answer
    // for a thread that has since been swapped for another.
    try {
      const page = await apiGetPins(roomId, undefined, 0, PAGE_SIZE, eventId);
      dispatch({ type: "SET_THREAD_PINS", payload: { threadId: eventId, pins: page.items } });
    } catch {
      // Nothing to show.
    }
  }, []);

  /** Prepend the page of replies before the oldest one held, as scrolling a
   *  channel does. */
  const loadOlderThreadMessages = useCallback(async () => {
    const cur = stateRef.current;
    const roomId = cur.currentRoomId;
    const threadId = cur.activeThreadEventId;
    if (!roomId || !threadId || cur.threadLoadingOlder || !cur.threadHasMore) return;
    const oldest = cur.threadMessages[0];
    if (!oldest) return;
    dispatch({ type: "SET_THREAD_LOADING_OLDER", payload: { threadId, loading: true } });
    try {
      const data = await apiGetThreadMessages(roomId, threadId, {
        ts: oldest.origin_server_ts,
        eventId: oldest.event_id,
      });
      dispatch({
        type: "PREPEND_THREAD_MESSAGES",
        payload: { threadId, messages: data.messages, hasMore: data.has_more },
      });
    } catch {
      dispatch({ type: "SET_THREAD_LOADING_OLDER", payload: { threadId, loading: false } });
    }
  }, []);

  /** Page back through the open thread until `eventId` is loaded, so a pin or
   *  a quoted reply older than what is on screen can still be reached.
   *  Answers whether it was found. Keeps its own cursor rather than rereading
   *  `stateRef`, which only catches up after a render. */
  const revealThreadMessage = useCallback(async (eventId: string) => {
    const cur = stateRef.current;
    const roomId = cur.currentRoomId;
    const threadId = cur.activeThreadEventId;
    if (!roomId || !threadId) return false;
    if (cur.threadMessages.some((m) => m.event_id === eventId)) return true;
    let oldest = cur.threadMessages[0];
    let hasMore = cur.threadHasMore;
    while (hasMore && oldest) {
      dispatch({ type: "SET_THREAD_LOADING_OLDER", payload: { threadId, loading: true } });
      let data;
      try {
        data = await apiGetThreadMessages(
          roomId,
          threadId,
          { ts: oldest.origin_server_ts, eventId: oldest.event_id },
          100,
        );
      } catch {
        dispatch({ type: "SET_THREAD_LOADING_OLDER", payload: { threadId, loading: false } });
        return false;
      }
      dispatch({
        type: "PREPEND_THREAD_MESSAGES",
        payload: { threadId, messages: data.messages, hasMore: data.has_more },
      });
      if (data.messages.some((m) => m.event_id === eventId)) return true;
      hasMore = data.has_more;
      oldest = data.messages[0];
    }
    return false;
  }, []);

  const closeThread = useCallback(() => {
    dispatch({ type: "CLOSE_THREAD" });
  }, []);

  const sendThreadMessage = useCallback(async (body: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSendThreadMessage(
      cur.currentRoomId,
      cur.activeThreadEventId,
      body,
      cur.threadReplyingTo?.event_id,
    );
    dispatch({ type: "SET_THREAD_REPLYING_TO", payload: null });
  }, []);

  const setThreadName = useCallback(async (name: string) => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSetThreadName(cur.currentRoomId, cur.activeThreadEventId, name);
    dispatch({
      type: "SET_THREAD_NAME",
      payload: { eventId: cur.activeThreadEventId, name },
    });
  }, []);

  const deleteThread = useCallback(async () => {
    const cur = stateRef.current;
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiDeleteThread(cur.currentRoomId, cur.activeThreadEventId);
    dispatch({ type: "DELETE_THREAD", payload: cur.activeThreadEventId });
  }, []);

  const addReaction = shared.addReaction;

  const createRoom = useCallback(
    async (name: string, topic: string, tags?: string[], iconUrl?: string, unlisted?: boolean, password?: string, roomType?: string) => {
      const data = await apiCreateRoom(name, topic, tags, iconUrl, unlisted, password, roomType);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const joinRoom = useCallback(
    async (roomId: string, password?: string) => {
      await apiJoinRoom(roomId, password);
      await loadRooms();
      await selectRoom(roomId);
    },
    [loadRooms, selectRoom]
  );

  const leaveRoom = useCallback(
    async (roomId: string) => {
      await apiLeaveRoom(roomId);
      if (stateRef.current.currentRoomId === roomId) {
        dispatch({ type: "SELECT_ROOM", payload: null });
      }
      await loadRooms();
    },
    [loadRooms]
  );

  /**
   * Ask the server to describe every call it knows this user can see.
   *
   * The socket answers from memory and covers every room at once, so it is both
   * cheaper than the REST call and wider — which matters because a call in a
   * room that is not on screen still has a sidebar row and a DM bar to keep
   * right. Answers false when there is no open socket to ask on.
   */

  const loadVoiceMembers = shared.loadVoiceMembers;
  loadVoiceMembersRef.current = loadVoiceMembers;

  /** Presence for everyone in the room on screen.
   *
   *  Polled, and asked for again whenever the socket has been away: a status
   *  that changed while it was down was broadcast to nobody. */
  const loadPresence = shared.loadPresence;
  loadPresenceRef.current = loadPresence;

  /** Open a channel.
   *
   *  The same shape as `selectRoom`: messages, permissions and pins are three
   *  independent questions about the channel being opened, so they go out
   *  together and only the messages are awaited. Run one after another — which
   *  is what this did — the timeline waited on two answers it never reads.
   */
  const selectChannel = shared.selectChannel;

  const createChannel = useCallback(async (roomId: string, name: string, channelType: string, topic?: string, categoryId?: string) => {
    await apiCreateChannel(roomId, { name, channel_type: channelType, topic, category_id: categoryId });
  }, []);

  const updateChannel = useCallback(async (roomId: string, channelId: string, data: { name?: string; topic?: string; read_only?: boolean }) => {
    await apiUpdateChannel(roomId, channelId, data);
  }, []);

  const deleteChannel = useCallback(async (roomId: string, channelId: string) => {
    await apiDeleteChannel(roomId, channelId);
  }, []);

  // ─── Custom Roles ─────────────────────────────────────────────────────
  const loadRoles = useCallback(async () => {
    const roomId = stateRef.current.currentRoomId;
    if (!roomId) return;
    try {
      const [rolesData, memberRolesData] = await Promise.all([
        apiGetRoles(roomId),
        apiGetAllMemberRoles(roomId),
      ]);
      dispatch({ type: "SET_CUSTOM_ROLES", payload: rolesData.roles || [] });
      dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: memberRolesData.member_roles || {} });
    } catch {}
  }, [dispatch]);

  const createRole = useCallback(async (roomId: string, name: string, color?: string, permissions?: Partial<import("../api").RolePermissions>) => {
    await apiCreateRole(roomId, { name, color, permissions });
  }, []);

  const updateRole = useCallback(async (roomId: string, roleId: string, data: { name?: string; color?: string; position?: number; permissions?: Partial<import("../api").RolePermissions> }) => {
    await apiUpdateRole(roomId, roleId, data);
    dispatch({ type: "UPDATE_CUSTOM_ROLE", payload: { role_id: roleId, ...data } as any });
  }, [dispatch]);

  const deleteRole = useCallback(async (roomId: string, roleId: string) => {
    await apiDeleteRole(roomId, roleId);
  }, []);

  const assignMemberRoles = useCallback(async (roomId: string, userId: string, roleIds: string[]) => {
    await apiAssignMemberRoles(roomId, userId, roleIds);
  }, []);

  const sendTyping = shared.sendTyping;

  const getAllRooms = useCallback(async () => {
    const data = await apiGetAllRooms();
    return data.rooms;
  }, []);

  const openDM = useCallback(
    async (targetUserIds: string | string[]) => {
      const data = await apiCreateDM(targetUserIds);
      await loadRooms();
      await selectRoom(data.room_id);
    },
    [loadRooms, selectRoom]
  );

  const addToGroupDM = useCallback(
    async (roomId: string, userId: string) => {
      await apiAddToDM(roomId, userId);
    },
    []
  );

  const updateTopic = useCallback(
    async (roomId: string, topic: string) => {
      await apiUpdateTopic(roomId, topic);
    },
    []
  );

  const updateRoomSettings = useCallback(
    async (roomId: string, settings: { name?: string; icon_url?: string; tags?: string[]; custom_emojis?: string[]; emoji_aliases?: Record<string, string>; unlisted?: boolean; password?: string; remove_password?: boolean; read_only?: boolean; sounds?: Record<string, string>; entrance_sounds_enabled?: boolean }) => {
      await apiUpdateRoomSettings(roomId, settings);
    },
    []
  );

  const setCustomStatus = useCallback((status: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_custom_status", custom_status: status }));
    }
  }, []);

  const setManualStatus = useCallback((status: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "set_status", status }));
    }
  }, []);

  const kickMember = useCallback(async (roomId: string, userId: string) => {
    await apiKickMember(roomId, userId);
  }, []);

  const banMember = useCallback(async (roomId: string, userId: string) => {
    await apiBanMember(roomId, userId);
  }, []);

  const unbanMember = useCallback(async (roomId: string, userId: string) => {
    await apiUnbanMember(roomId, userId);
  }, []);

  const setMemberRole = useCallback(async (roomId: string, userId: string, role: string) => {
    await apiSetMemberRole(roomId, userId, role);
  }, []);

  const setNameColors = useCallback(async (roomId: string, ownerColor?: string, modColor?: string) => {
    await apiSetNameColors(roomId, ownerColor, modColor);
  }, []);

  const loadRoomGroups = useCallback(async () => {
    try {
      const { groups, order } = await apiGetRoomGroups();
      dispatch({ type: "SET_ROOM_GROUPS", payload: groups });
      dispatch({ type: "SET_SIDEBAR_ORDER", payload: order });
    } catch {}
  }, []);

  const createRoomGroup = useCallback(async (name: string) => {
    await apiCreateRoomGroup(name);
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const deleteRoomGroup = useCallback(async (groupId: string) => {
    await apiDeleteRoomGroup(groupId);
    dispatch({ type: "REMOVE_ROOM_GROUP", payload: groupId });
  }, []);

  const renameRoomGroup = useCallback(async (groupId: string, name: string) => {
    await apiUpdateRoomGroup(groupId, { name });
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const setGroupRooms = useCallback(async (groupId: string, roomIds: string[]) => {
    await apiSetGroupRooms(groupId, roomIds);
    await loadRoomGroups();
  }, [loadRoomGroups]);

  const toggleGroupCollapsed = useCallback(async (groupId: string, collapsed: boolean) => {
    dispatch({ type: "TOGGLE_GROUP_COLLAPSED", payload: { groupId, collapsed } });
    await apiSetGroupCollapsed(groupId, collapsed);
  }, []);

  /** Applied before it is saved: a dragged icon that waits for a round trip
   *  to move springs back to where it was and lands a moment later, which
   *  reads as the drag having failed. The server is the record, so a refusal
   *  reloads rather than leaving the two disagreeing. */
  const setSidebarOrder = useCallback(async (order: string[]) => {
    dispatch({ type: "SET_SIDEBAR_ORDER", payload: order });
    try {
      await apiSetSidebarOrder(order);
    } catch {
      await loadRoomGroups();
    }
  }, [loadRoomGroups]);

  const loadFriends = useCallback(async () => {
    try {
      const data = await apiGetFriends();
      dispatch({
        type: "SET_FRIENDS_DATA",
        payload: {
          friends: data.friends,
          incomingRequests: data.incoming_requests,
          outgoingRequests: data.outgoing_requests,
          blocked: data.blocked,
        },
      });
    } catch {}
  }, []);

  const sendFriendRequest = useCallback(async (userId: string) => {
    const result = await apiSendFriendRequest(userId);
    if (result.auto_accepted) {
      dispatch({ type: "ADD_FRIEND", payload: userId });
    } else {
      dispatch({ type: "ADD_OUTGOING_REQUEST", payload: { userId, requestId: "" } });
    }
  }, []);

  const acceptFriendRequest = useCallback(async (userId: string) => {
    await apiAcceptFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "ADD_FRIEND", payload: userId });
  }, []);

  const rejectFriendRequest = useCallback(async (userId: string) => {
    await apiRejectFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
  }, []);

  const removeFriend = useCallback(async (userId: string) => {
    await apiRemoveFriend(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
  }, []);

  const blockUser = useCallback(async (userId: string) => {
    await apiBlockUser(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "REMOVE_OUTGOING_REQUEST", payload: userId });
    dispatch({ type: "ADD_BLOCKED_USER", payload: userId });
  }, []);

  const unblockUser = useCallback(async (userId: string) => {
    await apiUnblockUser(userId);
    dispatch({ type: "REMOVE_BLOCKED_USER", payload: userId });
  }, []);

  const updateProfile = useCallback((profile: { avatarUrl?: string; bannerUrl?: string; about?: string; customStatus?: string; displayName?: string; nameFontUrl?: string; profileTheme?: ProfileTheme; entranceSoundUrl?: string }) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload: any = { type: "set_profile" };
      if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
      if (profile.bannerUrl !== undefined) payload.banner_url = profile.bannerUrl;
      if (profile.about !== undefined) payload.about = profile.about;
      if (profile.customStatus !== undefined) payload.custom_status = profile.customStatus;
      if (profile.displayName !== undefined) payload.display_name = profile.displayName;
      if (profile.nameFontUrl !== undefined) payload.name_font_url = profile.nameFontUrl;
      if (profile.profileTheme !== undefined) payload.profile_theme = profile.profileTheme;
      if (profile.entranceSoundUrl !== undefined) payload.entrance_sound_url = profile.entranceSoundUrl;
      ws.send(JSON.stringify(payload));
    }
  }, []);

  // Stable across state changes so action-only consumers never re-render.
  const actions = useMemo<AppActions>(
    () => ({
      dispatch,
      wsRef,
      login,
      register,
      logout,
      deleteAccount,
      loadRooms,
      selectRoom,
      loadOlderMessages,
      loadMessagesAround,
      sendMessage,
      openThread,
      openMessage,
      loadOlderThreadMessages,
      revealThreadMessage,
      closeThread,
      sendThreadMessage,
      setThreadName,
      deleteThread,
      deleteMessage,
      hardDeleteNotification,
      editMessage,
      addReaction,
      loadPins,
      loadEvents,
      createEvent,
      updateEvent,
      deleteEvent,
      createPoll,
      votePoll,
      closePoll,
      loadPoll,
      setRsvp,
      loadMorePins,
      loadMoreSearchResults,
      pinMessage,
      unpinMessage,
      createRoom,
      joinRoom,
      leaveRoom,
      loadVoiceMembers,
      sendTyping,
      getAllRooms,
      openDM,
      addToGroupDM,
      updateTopic,
      updateRoomSettings,
      setCustomStatus,
      setManualStatus,
      updateProfile,
      kickMember,
      banMember,
      unbanMember,
      setMemberRole,
      setNameColors,
      selectChannel,
      createChannel,
      updateChannel,
      deleteChannel,
      loadRoles,
      createRole,
      updateRole,
      deleteRole,
      assignMemberRoles,
      loadRoomGroups,
      createRoomGroup,
      deleteRoomGroup,
      renameRoomGroup,
      setGroupRooms,
      toggleGroupCollapsed,
      setSidebarOrder,
      loadFriends,
      loadUnreads,
      markChannelRead,
      loadNotificationSettings,
      loadContinuity,
      loadActiveThreads,
      saveDraft,
      saveResumePoint,
      setNotificationLevel,
      moderateVoice,
      sendFriendRequest,
      acceptFriendRequest,
      rejectFriendRequest,
      removeFriend,
      blockUser,
      unblockUser,
    }),
    [login, register, logout, deleteAccount, loadRooms, selectRoom, loadOlderMessages, loadMessagesAround, sendMessage, openThread, openMessage, loadOlderThreadMessages, revealThreadMessage, closeThread, sendThreadMessage, setThreadName, deleteThread, deleteMessage, hardDeleteNotification, editMessage, addReaction, loadPins, loadEvents, createEvent, updateEvent, deleteEvent, createPoll, votePoll, closePoll, loadPoll, setRsvp, loadMorePins, loadMoreSearchResults, pinMessage, unpinMessage, createRoom, joinRoom, leaveRoom, loadVoiceMembers, sendTyping, getAllRooms, openDM, addToGroupDM, updateTopic, updateRoomSettings, setCustomStatus, setManualStatus, updateProfile, kickMember, banMember, unbanMember, setMemberRole, setNameColors, selectChannel, createChannel, updateChannel, deleteChannel, loadRoles, createRole, updateRole, deleteRole, assignMemberRoles, loadRoomGroups, createRoomGroup, deleteRoomGroup, renameRoomGroup, setGroupRooms, toggleGroupCollapsed, setSidebarOrder, loadFriends, loadUnreads, markChannelRead, loadNotificationSettings, loadContinuity, loadActiveThreads, saveDraft, saveResumePoint, setNotificationLevel, moderateVoice, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser],
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStateContext.Provider value={state}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
