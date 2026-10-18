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
  apiCreateRoom,
  apiJoinRoom,
  apiLeaveRoom,
  apiGetAllRooms,
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
  apiGetServerInfo,
  apiCreateChannel,
  apiUpdateChannel,
  apiDeleteChannel,
  apiGetRoles,
  apiCreateRole,
  apiUpdateRole,
  apiDeleteRole,
  apiGetAllMemberRoles,
  apiAssignMemberRoles,
} from "../api";
import { clearMediaBlobs } from "@/lib/mediaBlobs";
import { clearMessagePreviews } from "@/lib/messageLinks";
import { fetchIceServers } from "../webrtc";
import { AppActionsContext, AppStateContext, type AppActions } from "./context";
import {
  initialState,
} from "./types";
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
  // panel and the provider share one source of truth). The request itself is
  // core's runSearch, shared with the mobile app; the debounce is ours.
  useEffect(() => {
    if (!state.search.open || !state.currentRoomId) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => void shared.runSearch(), 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [state.search.open, state.search.query, state.search.filter, state.search.fileTypeFilter, state.search.thisChannel, state.currentRoomId, state.currentChannelId, shared]);

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

  // Made once for the provider's lifetime; it reads state through stateRef.
  const [handleWsMessage] = useState(() =>
    createWsMessageHandler(dispatch, stateRef, typingTimeoutsRef, loadRoomsRef, loadPresenceRef),
  );

  /** False until the socket has connected once, so the first open is not
   *  mistaken for a reconnection. */
  const hasConnectedRef = useRef(false);
  // When the page was last backgrounded, so a resume can tell a glance away
  // from a phone that was put down.
  const hiddenAtRef = useRef<number | null>(null);

  // Replay whatever arrived while the socket was down (see core actions).
  const recoverMissedMessages = shared.recoverMissedMessages;

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

  const createEvent = shared.createEvent;

  const updateEvent = shared.updateEvent;

  const deleteEvent = shared.deleteEvent;

  const setRsvp = shared.setRsvp;

  const createPoll = shared.createPoll;

  const votePoll = shared.votePoll;

  const closePoll = shared.closePoll;

  const loadPoll = shared.loadPoll;

  const loadPins = shared.loadPins;

  const loadMorePins = shared.loadMorePins;

  const loadMoreSearchResults = shared.loadMoreSearchResults;

  const pinMessage = shared.pinMessage;

  const unpinMessage = shared.unpinMessage;

  const openThread = shared.openThread;

  /** Prepend the page of replies before the oldest one held, as scrolling a
   *  channel does. */
  const loadOlderThreadMessages = shared.loadOlderThreadMessages;

  /** Page back through the open thread until `eventId` is loaded, so a pin or
   *  a quoted reply older than what is on screen can still be reached.
   *  Answers whether it was found. Keeps its own cursor rather than rereading
   *  `stateRef`, which only catches up after a render. */
  const revealThreadMessage = shared.revealThreadMessage;

  const closeThread = shared.closeThread;

  const sendThreadMessage = shared.sendThreadMessage;

  const setThreadName = shared.setThreadName;

  const deleteThread = shared.deleteThread;

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

  const openDM = shared.openDM;

  const addToGroupDM = shared.addToGroupDM;

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

  const setCustomStatus = shared.setCustomStatus;

  const setManualStatus = shared.setManualStatus;

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

  const loadFriends = shared.loadFriends;
  const loadFriendPresence = shared.loadFriendPresence;
  const embedInteraction = shared.embedInteraction;

  const sendFriendRequest = shared.sendFriendRequest;

  const acceptFriendRequest = shared.acceptFriendRequest;

  const rejectFriendRequest = shared.rejectFriendRequest;

  const removeFriend = shared.removeFriend;

  const blockUser = shared.blockUser;

  const unblockUser = shared.unblockUser;

  const updateProfile = shared.updateProfile;

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
      loadFriendPresence,
      embedInteraction,
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
    [login, register, logout, deleteAccount, loadRooms, selectRoom, loadOlderMessages, loadMessagesAround, sendMessage, openThread, openMessage, loadOlderThreadMessages, revealThreadMessage, closeThread, sendThreadMessage, setThreadName, deleteThread, deleteMessage, hardDeleteNotification, editMessage, addReaction, loadPins, loadEvents, createEvent, updateEvent, deleteEvent, createPoll, votePoll, closePoll, loadPoll, setRsvp, loadMorePins, loadMoreSearchResults, pinMessage, unpinMessage, createRoom, joinRoom, leaveRoom, loadVoiceMembers, sendTyping, getAllRooms, openDM, addToGroupDM, updateTopic, updateRoomSettings, setCustomStatus, setManualStatus, updateProfile, kickMember, banMember, unbanMember, setMemberRole, setNameColors, selectChannel, createChannel, updateChannel, deleteChannel, loadRoles, createRole, updateRole, deleteRole, assignMemberRoles, loadRoomGroups, createRoomGroup, deleteRoomGroup, renameRoomGroup, setGroupRooms, toggleGroupCollapsed, setSidebarOrder, loadFriends, loadFriendPresence, embedInteraction, loadUnreads, markChannelRead, loadNotificationSettings, loadContinuity, loadActiveThreads, saveDraft, saveResumePoint, setNotificationLevel, moderateVoice, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, blockUser, unblockUser],
  );

  return (
    <AppActionsContext.Provider value={actions}>
      <AppStateContext.Provider value={state}>{children}</AppStateContext.Provider>
    </AppActionsContext.Provider>
  );
}
