/**
 * The store's actions: what happens when someone opens a room, sends a
 * message, reacts. Each one calls the API and dispatches what came back.
 *
 * Shared by the web client's AppProvider and the mobile app's provider, so a
 * fix to how a room loads is made once. They need only a way to dispatch, a
 * way to read the latest state, and a way to write to the socket — React,
 * refs and the DOM stay in each app's provider.
 *
 * Moved here from client/src/lib/store/provider.tsx; the comments explaining
 * each one's choices came with them.
 */

import {
  apiAddReaction,
  apiDeleteMessage,
  apiEditMessage,
  apiGetAllMemberRoles,
  apiGetChannels,
  apiGetContinuity,
  apiGetJoinedRooms,
  apiGetMessages,
  apiGetMessagesAfter,
  apiGetMyPermissions,
  apiGetNotificationSettings,
  apiGetPins,
  apiGetPresence,
  apiGetRoles,
  apiGetRoomMembers,
  apiGetRoomThreads,
  apiGetUnreads,
  apiGetVoiceMembers,
  apiHardDeleteNotification,
  apiListEvents,
  apiMarkRead,
  apiSendMessage,
  apiSetDraft,
  apiSetNotificationLevel,
  apiSetResumePoint,
  apiSync,
  apiGetThreadMessages,
  apiSendThreadMessage,
  apiSetThreadName,
  apiDeleteThread,
  apiPinMessage,
  apiUnpinMessage,
  apiSearchMessages,
  apiCreateDM,
  apiAddToDM,
  apiGetFriends,
  apiSendFriendRequest,
  apiAcceptFriendRequest,
  apiRejectFriendRequest,
  apiRemoveFriend,
  apiBlockUser,
  apiUnblockUser,
  apiGetFriendsPresence,
  PAGE_SIZE,
  type MatrixMessage,
  type RoomInfo,
} from "../api";
import { loadLastChannels, pickLandingChannel } from "../lastChannel";
import { channelNotificationTag, settingsKey, type NotificationLevel, type NotificationSettings } from "../notifications";
import { host } from "../platform";
import type { ProfileTheme } from "../profileTheme";
import { displayUserId, userIdFromInput } from "../utils";
import {
  resumePointsMap,
  THREAD_ACTIVE_WINDOW_MS,
  THREAD_PREVIEW_LIMIT,
  type Action,
  type AppState,
  type Dispatch,
  type MessageTarget,
  type ThreadPreview,
  type VoiceChannelMember,
} from "./types";

export interface StoreContext {
  dispatch: Dispatch<Action>;
  /** The latest state, read at call time. */
  getState(): AppState;
  /** Write a frame to the socket. False when there is no open socket. */
  send(frame: Record<string, unknown>): boolean;
}

/** Throttle on typing notices: one a second is plenty for "is typing…". */
const TYPING_THROTTLE_MS = 1000;

type SyncRoom = { state: { events: { type?: string; sender?: string; state_key?: string; content?: any }[] } };

/**
 * A room's sidebar facts, read out of its `/sync` state events.
 *
 * Pure, so both clients describe a room the same way and a new state event is
 * added in one place.
 */
export function roomInfoFromSync(roomId: string, roomData: SyncRoom | undefined): RoomInfo {
  if (!roomData) {
    return { room_id: roomId, name: "Unnamed Room", topic: "" };
  }
  const events = roomData.state.events;
  const find = (type: string) => events.find((e) => e.type === type);
  const nameEvent = find("m.room.name");
  const topicEvent = find("m.room.topic");
  const directEvent = find("m.room.direct");
  const tagsEvent = find("m.room.tags");
  const iconEvent = find("m.room.icon");
  const customEmojisEvent = find("m.room.custom_emojis");
  const emojiAliasesEvent = find("m.room.emoji_aliases");
  const nameColorsEvent = find("m.room.name_colors");
  const unlistedEvent = find("m.room.unlisted");
  const hasPasswordEvent = find("m.room.has_password");
  const roomTypeEvent = find("m.room.type");
  const readOnlyEvent = find("m.room.read_only");
  const bannerEvent = find("m.room.banner");
  const streakEvent = find("m.room.dm_streak");
  const soundsEvent = find("m.room.sounds");
  const themeEvent = find("m.room.theme");
  return {
    room_id: roomId,
    name: nameEvent?.content?.name || "Unnamed Room",
    topic: topicEvent?.content?.topic || "",
    is_direct: directEvent?.content?.is_direct || false,
    tags: tagsEvent?.content?.tags || [],
    icon_url: iconEvent?.content?.icon_url || "",
    creator: nameEvent?.sender || "",
    custom_emojis: customEmojisEvent?.content?.custom_emojis || [],
    emoji_aliases: emojiAliasesEvent?.content?.emoji_aliases || {},
    owner_name_color: nameColorsEvent?.content?.owner_name_color || "",
    mod_name_color: nameColorsEvent?.content?.mod_name_color || "",
    unlisted: unlistedEvent?.content?.unlisted || false,
    has_password: hasPasswordEvent?.content?.has_password || false,
    room_type: roomTypeEvent?.content?.room_type || "text",
    read_only: readOnlyEvent?.content?.read_only || false,
    banner_url: bannerEvent?.content?.banner_url || "",
    dm_streak_count: streakEvent?.content?.streak_count || 0,
    dm_streak_last_ts: streakEvent?.content?.last_message_ts || 0,
    // Prefer the explicit list, fall back to the room's membership. The
    // member events have always been in this payload, so a DM resolves
    // its peer whatever the server is running — the explicit field only
    // saves the client from filtering.
    dm_user_ids: directEvent?.content?.dm_user_ids?.length
      ? directEvent.content.dm_user_ids
      : events.filter((e) => e.type === "m.room.member" && !!e.state_key).map((e) => e.state_key as string),
    dm_avatars: directEvent?.content?.dm_avatars || {},
    dm_voice_count: directEvent?.content?.dm_voice_count || 0,
    sounds: soundsEvent?.content?.sounds || {},
    // Rooms that predate the field, and any room whose state event is
    // missing, keep entrance sounds on — the field's default.
    entrance_sounds_enabled: soundsEvent?.content?.entrance_sounds_enabled !== false,
    suggested_theme: themeEvent?.content?.suggested_theme || "",
  };
}

/** A page of history's messages, and its reactions seeded into the store. */
function landMessages(dispatch: Dispatch<Action>, chunk: MatrixMessage[]): MatrixMessage[] {
  const messages = chunk.filter((m) => m.type === "m.room.message");
  for (const msg of messages) {
    if (msg.reactions && Object.keys(msg.reactions).length > 0) {
      dispatch({ type: "SET_REACTIONS", payload: { eventId: msg.event_id, reactions: msg.reactions } });
    }
  }
  return messages;
}

export function createStoreActions(ctx: StoreContext) {
  const { dispatch, getState, send } = ctx;
  let typingThrottle: ReturnType<typeof setTimeout> | null = null;

  const loadRooms = async () => {
    const data = await apiGetJoinedRooms();
    const syncData = await apiSync();
    const roomInfoMap: Record<string, RoomInfo> = {};
    for (const roomId of data.joined_rooms) {
      roomInfoMap[roomId] = roomInfoFromSync(roomId, syncData.rooms?.join?.[roomId]);
    }
    dispatch({ type: "SET_ROOMS", payload: { roomIds: data.joined_rooms, roomInfoMap } });
  };

  // Unread counts are derived server-side from stored read markers, so they
  // survive a refresh; the reducer's own tallies only cover the live session.
  const loadUnreads = async () => {
    try {
      const data = await apiGetUnreads();
      dispatch({ type: "SET_UNREADS", payload: data.unreads || [] });
      dispatch({ type: "SET_THREAD_MENTIONS", payload: data.thread_mentions || [] });
      // What was read on another device while this one was not listening.
      void host.closeNotificationsReadElsewhere(
        new Set(
          (data.unreads || [])
            .filter((u) => u.count > 0)
            .map((u) => channelNotificationTag(u.room_id, u.channel_id || "")),
        ),
      );
    } catch {
      // Leave whatever the session has accumulated.
    }
  };

  const markChannelRead = (roomId: string, channelId?: string) => {
    void apiMarkRead(roomId, channelId).catch(() => {});
  };

  /** Clear a channel's badge here, without waiting for the server: a
   *  channel's own, or for a room without channels (a DM) its loose bucket. */
  const clearUnread = (roomId: string, channelId?: string | null) => {
    if (channelId) dispatch({ type: "CLEAR_CHANNEL_UNREAD", payload: channelId });
    else dispatch({ type: "CLEAR_ROOM_UNREAD", payload: roomId });
  };

  const loadNotificationSettings = async () => {
    try {
      const data = await apiGetNotificationSettings();
      const map: NotificationSettings = {};
      for (const entry of data.settings || []) {
        map[settingsKey(entry.room_id, entry.channel_id)] = entry.level;
      }
      dispatch({ type: "SET_NOTIFICATION_SETTINGS", payload: map });
    } catch {
      // Fall back to the default level for everything.
    }
  };

  const setNotificationLevel = async (roomId: string, level: NotificationLevel | "default", channelId?: string) => {
    // Optimistic: the control should respond immediately, and a failed write
    // only costs the user a re-click.
    dispatch({ type: "SET_NOTIFICATION_LEVEL", payload: { roomId, channelId: channelId ?? "", level } });
    await apiSetNotificationLevel(roomId, level, channelId);
  };

  /**
   * The recently active threads a room's channel list previews.
   *
   * One request for the room rather than one per channel: the server already
   * sorts by activity, so grouping the answer is cheaper than asking N times.
   */
  const loadActiveThreads = async (roomId: string) => {
    try {
      const data = await apiGetRoomThreads(
        roomId,
        undefined,
        undefined,
        false,
        0,
        // Enough to fill several channels' previews from one call.
        50,
        THREAD_ACTIVE_WINDOW_MS,
      );
      const grouped: Record<string, ThreadPreview[]> = {};
      for (const root of data.items || []) {
        const channelId = root.channel_id ?? "";
        const list = (grouped[channelId] ??= []);
        if (list.length >= THREAD_PREVIEW_LIMIT) continue;
        list.push({
          threadId: root.event_id,
          channelId,
          name: root.thread_name || root.content?.body || "Thread",
          replyCount: root.thread_reply_count ?? 0,
          lastActivityTs: root.thread_last_activity_ts ?? root.origin_server_ts,
        });
      }
      dispatch({ type: "SET_CHANNEL_THREADS", payload: grouped });
    } catch {
      // The channel list simply shows no threads.
    }
  };

  const loadContinuity = async () => {
    try {
      const data = await apiGetContinuity();
      const drafts: Record<string, string> = {};
      for (const entry of data.drafts || []) {
        drafts[`${entry.room_id}|${entry.channel_id}`] = entry.text;
      }
      resumePointsMap.clear();
      for (const entry of data.resume || []) {
        resumePointsMap.set(entry.url, { positionSecs: entry.position_secs, durationSecs: entry.duration_secs });
      }
      dispatch({ type: "SET_CONTINUITY", payload: { drafts } });
    } catch {
      // Nothing carried over; the composer just starts empty.
    }
  };

  const saveDraft = async (roomId: string, channelId: string, text: string) => {
    // Optimistic, and deliberately not awaited by the composer: typing must
    // never wait on a round trip.
    dispatch({ type: "SET_DRAFT", payload: { roomId, channelId, text } });
    try {
      await apiSetDraft(roomId, channelId, text);
    } catch {
      // The local draft still stands; it just will not reach another device.
    }
  };

  const saveResumePoint = async (url: string, positionSecs: number, durationSecs: number) => {
    resumePointsMap.set(url, { positionSecs, durationSecs });
    try {
      await apiSetResumePoint(url, positionSecs, durationSecs);
    } catch {
      // Playback is unaffected by a failed bookmark.
    }
  };

  const loadEvents = async (roomId?: string) => {
    const target = roomId ?? getState().currentRoomId;
    if (!target) return;
    try {
      const { events } = await apiListEvents(target);
      // A slow answer for a room the user has already left must not land.
      if (getState().currentRoomId !== target) return;
      dispatch({ type: "SET_ROOM_EVENTS", payload: events });
    } catch {
      if (getState().currentRoomId === target) {
        dispatch({ type: "SET_ROOM_EVENTS", payload: [] });
      }
    }
  };

  /**
   * Ask the socket for every room's voice state.
   *
   * The socket answers from memory and covers every room at once, so it is both
   * cheaper than the REST call and wider — which matters because a call in a
   * room that is not on screen still has a sidebar row and a DM bar to keep
   * right. Answers false when there is no open socket to ask on.
   */
  const requestVoiceSync = () => send({ type: "voice_state_request" });

  const loadVoiceMembers = async (forRoomId?: string) => {
    if (requestVoiceSync()) return;
    // No socket: fall back to the one room the REST endpoint can describe.
    // A caller mid-room-switch names it, since the store may not have caught up.
    const roomId = forRoomId ?? getState().currentRoomId;
    if (!roomId) return;
    try {
      const voiceData = await apiGetVoiceMembers(roomId);
      const channels: Record<string, { roomId: string; occupiedSince: number | null; members: VoiceChannelMember[] }> = {};
      for (const [channelId, members] of Object.entries(voiceData.voice_channels || {})) {
        channels[channelId] = {
          roomId,
          occupiedSince: voiceData.occupied_since?.[channelId] ?? null,
          members: (members as any[]).map((m: any) => ({
            userId: m.user_id || m.userId,
            muted: !!m.muted,
            deafened: m.deafened ?? false,
            screen_sharing: !!m.screen_sharing,
            webcam_sharing: !!m.webcam_sharing,
            force_muted: m.force_muted ?? false,
            clipping: m.clipping ?? false,
            x: typeof m.x === "number" ? m.x : undefined,
            y: typeof m.y === "number" ? m.y : undefined,
          })),
        };
      }
      // Scoped to this room: the endpoint was told nothing about the others, so
      // it must not be read as saying their calls have ended.
      dispatch({ type: "SYNC_VOICE_STATE", payload: { roomId, channels } });
    } catch {}
  };

  const loadPresence = async (forRoomId?: string) => {
    const roomId = forRoomId ?? getState().currentRoomId;
    if (!roomId) return;
    try {
      const data = await apiGetPresence(roomId);
      const mapped: Parameters<typeof setPresence>[0] = {};
      for (const [uid, p] of Object.entries(data.presence)) {
        const pAny = p as any;
        mapped[uid] = {
          status: pAny.status,
          customStatus: pAny.custom_status || undefined,
          avatarUrl: pAny.avatar_url || undefined,
          about: pAny.about || undefined,
          bannerUrl: pAny.banner_url || undefined,
          displayName: pAny.display_name || undefined,
          nameFontUrl: pAny.name_font_url || undefined,
          profileTheme: pAny.profile_theme || undefined,
          isMobile: pAny.is_mobile || false,
          steamGame: pAny.steam_game || undefined,
          steamAppId: pAny.steam_appid || undefined,
          gameSessionStart: pAny.game_session_start || undefined,
        };
      }
      setPresence(mapped);
    } catch {}
  };
  const setPresence = (payload: Extract<Action, { type: "SET_PRESENCE" }>["payload"]) =>
    dispatch({ type: "SET_PRESENCE", payload });

  /** Open a room.
   *
   *  Six requests used to run here strictly one after another — channels, then
   *  roles, then messages, then permissions, then pins, then a full `/sync` for
   *  the member list — so the timeline waited on two calls it does not read,
   *  and the member list waited on all five. Only one dependency is real: the
   *  channel to land on comes out of the channel list, and messages, pins and
   *  permissions are all scoped to it. Everything else now runs alongside.
   */
  const selectRoom = async (roomId: string) => {
    dispatch({ type: "SELECT_ROOM", payload: roomId });
    void loadActiveThreads(roomId);

    // Whether this switch is still the one on screen. Requests that are no
    // longer awaited in order can land after the next switch has started, and
    // the roster or pins of the room someone just left must not paint over
    // the room they are now in.
    const stillCurrent = () => getState().currentRoomId === roomId;

    // Started first and never waited on: it depends on nothing else here.
    void apiGetRoomMembers(roomId)
      .then((data) => {
        if (!stillCurrent()) return;
        dispatch({
          type: "SET_ROOM_MEMBERS",
          payload: data.members.map((m) => ({
            userId: m.user_id,
            displayName: m.display_name || displayUserId(m.user_id),
            role: m.role || "member",
            joinedAt: m.joined_at || undefined,
          })),
        });
      })
      .catch(() => {});

    // Load channels for non-DM rooms and auto-select default text channel
    const roomInfo = getState().roomInfoMap[roomId];
    const isDm = roomInfo?.is_direct;
    let selectedChannelId: string | undefined;
    if (!isDm) {
      // Custom roles and their assignments decide which controls render, not
      // what the timeline contains, so they run alongside it.
      void Promise.all([apiGetRoles(roomId), apiGetAllMemberRoles(roomId)])
        .then(([rolesData, memberRolesData]) => {
          if (!stillCurrent()) return;
          dispatch({ type: "SET_CUSTOM_ROLES", payload: rolesData.roles || [] });
          dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: memberRolesData.member_roles || {} });
        })
        .catch(() => {
          if (!stillCurrent()) return;
          dispatch({ type: "SET_CUSTOM_ROLES", payload: [] });
          dispatch({ type: "SET_MEMBER_CUSTOM_ROLES", payload: {} });
        });

      try {
        const channelsData = await apiGetChannels(roomId);
        dispatch({ type: "SET_CHANNELS", payload: channelsData.channels || [] });
        dispatch({ type: "SET_CHANNEL_CATEGORIES", payload: channelsData.categories || [] });
        // Land where the reader last was in this room — this session, or
        // before a reload (lastChannel.ts) — not on whichever channel the room
        // happens to list first. A remembered channel that is gone falls back
        // to the first text channel.
        const remembered = getState().lastChannelByRoom[roomId] ?? loadLastChannels(getState().userId)[roomId];
        const landing = pickLandingChannel(channelsData.channels || [], remembered);
        if (landing) {
          selectedChannelId = landing.channel_id;
          dispatch({ type: "SELECT_CHANNEL", payload: selectedChannelId });
        }
      } catch {
        dispatch({ type: "SET_CHANNELS", payload: [] });
      }

      // Fetched on the room switch rather than when the panel opens: the
      // header badge has to know about an event starting soon before anyone
      // thinks to look for one.
      void loadEvents(roomId);
    }

    // All three are scoped to the channel just landed on, so they go out
    // together. Only the messages are awaited, because they are what the
    // room is.
    //
    // The server computes effective permissions; the client only mirrors them
    // to decide which controls to show.
    void apiGetMyPermissions(roomId, selectedChannelId)
      .then((permsData) => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
      });
    void apiGetPins(roomId, selectedChannelId)
      .then((page) => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_PINNED_MESSAGES", payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset } });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_PINNED_MESSAGES", payload: { pins: [], hasMore: false, nextOffset: 0 } });
      });

    const msgData = await apiGetMessages(roomId, 50, undefined, undefined, selectedChannelId);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({ type: "SET_MESSAGES", payload: { messages, hasMore: msgData.has_more } });
    landMessages(dispatch, messages);
    // Load presence. The same call the poll makes, rather than a second copy
    // of the mapping that could drift from it — this one dropped `is_mobile`,
    // so opening a room took the phone badge off everyone in it until the
    // poll next ran.
    void loadPresence(roomId);
    // Who is in this room's voice channels. Opening a room used to load the
    // flat member list and nothing per channel, so the channel list showed
    // empty voice channels however many people were sitting in them — and it
    // skipped the load entirely while a call was running in another room,
    // which is the case where the client is furthest behind. The snapshot
    // covers every room at once, so neither is a reason to ask for less.
    void loadVoiceMembers(roomId);
  };

  const loadOlderMessages = async () => {
    const cur = getState();
    if (!cur.currentRoomId || cur.loadingOlderMessages || !cur.hasMoreMessages) return;
    // The cursor is the oldest message on screen, so nothing separate has to
    // be tracked — and it stays correct even if messages arrive meanwhile.
    const oldest = cur.messages[0];
    if (!oldest) return;
    dispatch({ type: "SET_LOADING_OLDER", payload: true });
    try {
      const msgData = await apiGetMessages(
        cur.currentRoomId,
        50,
        { ts: oldest.origin_server_ts, eventId: oldest.event_id },
        undefined,
        cur.currentChannelId || undefined,
      );
      const olderMessages = msgData.chunk.filter((m) => m.type === "m.room.message");
      dispatch({ type: "PREPEND_MESSAGES", payload: { messages: olderMessages, hasMore: msgData.has_more } });
      landMessages(dispatch, olderMessages);
    } catch {
      dispatch({ type: "SET_LOADING_OLDER", payload: false });
    }
  };

  /** Open a room on one of its messages.
   *
   *  The target is recorded before the room is selected and acted on by the
   *  timeline, because the two halves cannot happen in one place: landing on a
   *  message needs the room's channels and timeline, which exist only once
   *  selecting the room has finished, and the caller is a row on another page
   *  that this very switch is about to unmount. */
  /** The timeline has landed on a jump's message (or given up on it). */
  const clearPendingJump = () => dispatch({ type: "SET_PENDING_JUMP", payload: null });

  const openMessage = async (target: MessageTarget) => {
    dispatch({ type: "SET_PENDING_JUMP", payload: target });
    // Already here: nothing to load, and the timeline acts on the target as
    // soon as it sees it.
    if (getState().currentRoomId === target.roomId) return;
    await selectRoom(target.roomId);
  };

  const loadMessagesAround = async (roomId: string, ts: number) => {
    const msgData = await apiGetMessages(roomId, 50, undefined, ts, getState().currentChannelId || undefined);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({ type: "SET_MESSAGES", payload: { messages, hasMore: msgData.has_more } });
    landMessages(dispatch, messages);
  };

  const selectChannel = async (channelId: string) => {
    dispatch({ type: "SELECT_CHANNEL", payload: channelId });
    const roomId = getState().currentRoomId;
    if (!roomId) return;

    // Whether this switch is still the one on screen, as in `selectRoom`: these
    // no longer finish in order, and a slow answer for the channel someone just
    // left must not paint over the one they are now in.
    const stillCurrent = () => getState().currentRoomId === roomId && getState().currentChannelId === channelId;

    // Overwrites make permissions channel-scoped, so they follow the channel.
    void apiGetMyPermissions(roomId, channelId)
      .then((permsData) => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: permsData.permissions });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_MY_PERMISSIONS", payload: null });
      });
    void apiGetPins(roomId, channelId)
      .then((page) => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_PINNED_MESSAGES", payload: { pins: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset } });
      })
      .catch(() => {
        if (!stillCurrent()) return;
        dispatch({ type: "SET_PINNED_MESSAGES", payload: { pins: [], hasMore: false, nextOffset: 0 } });
      });

    const msgData = await apiGetMessages(roomId, 50, undefined, undefined, channelId);
    const messages = msgData.chunk.filter((m) => m.type === "m.room.message");
    dispatch({ type: "SET_MESSAGES", payload: { messages, hasMore: msgData.has_more } });
    landMessages(dispatch, messages);
  };

  const sendMessage = async (body: string, inReplyTo?: string, spoiler?: boolean) => {
    const cur = getState();
    if (!cur.currentRoomId) return;
    await apiSendMessage(cur.currentRoomId, body, inReplyTo, spoiler, cur.currentChannelId || undefined);
  };

  const deleteMessage = async (eventId: string, deleteFiles?: boolean) => {
    const roomId = getState().currentRoomId;
    if (!roomId) return;
    // Throws unless the server actually deleted it, so what follows only
    // runs on a success.
    await apiDeleteMessage(roomId, eventId, deleteFiles);
    // The broadcast tells the rest of the room, and it used to be the only
    // thing that told this client too — so the message stayed on the screen
    // of the person who had just deleted it until the socket came back with
    // the news. Applied here as well, against the success they already
    // waited for. The reducer removes by filtering, so the broadcast
    // arriving after this changes nothing.
    dispatch({ type: "REDACT_MESSAGE", payload: eventId });
  };

  const hardDeleteNotification = async (roomId: string, eventId: string) => {
    await apiHardDeleteNotification(roomId, eventId);
    dispatch({ type: "REMOVE_MESSAGE", payload: eventId });
  };

  const editMessage = async (eventId: string, newBody: string) => {
    const roomId = getState().currentRoomId;
    if (!roomId) return;
    await apiEditMessage(roomId, eventId, newBody);
  };

  const addReaction = async (eventId: string, emoji: string) => {
    const cur = getState();
    if (!cur.currentRoomId || !cur.userId) return;
    // Optimistic update: toggle locally before the server round-trip
    const current = cur.messageReactions[eventId] ?? {};
    const users = current[emoji] ?? [];
    const userId = cur.userId;
    let optimistic: Record<string, string[]>;
    if (users.includes(userId)) {
      const next = users.filter((u) => u !== userId);
      if (next.length === 0) {
        const { [emoji]: _removed, ...rest } = current;
        optimistic = rest;
      } else {
        optimistic = { ...current, [emoji]: next };
      }
    } else {
      optimistic = { ...current, [emoji]: [...users, userId] };
    }
    dispatch({ type: "SET_REACTIONS", payload: { eventId, reactions: optimistic } });
    // Fire-and-forget; server WS broadcast will confirm with authoritative state
    apiAddReaction(cur.currentRoomId, eventId, emoji).catch(() => {
      // On failure, revert to previous state
      dispatch({ type: "SET_REACTIONS", payload: { eventId, reactions: current } });
    });
  };

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
  const recoverMissedMessages = async () => {
    // Server-computed, so these are right even where the timeline is not.
    void loadUnreads();
    // Who is in a call, who is muted, who is sharing — all of it is assembled
    // from events, and every event sent while the socket was down reached
    // nobody. Nothing else refetches it, so a single missed join left the call
    // looking wrong until the room was reselected. Ask the server outright.
    //
    // (The server pushes the same snapshot when the socket opens; this covers
    // the case where the connection survived and only the events were lost.)
    void loadVoiceMembers();
    // Online, idle and offline are broadcast the same way, and were missed the
    // same way.
    void loadPresence();

    const { currentRoomId, currentChannelId, messages } = getState();
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
        const data = await apiGetMessagesAfter(currentRoomId, cursor.ts, currentChannelId ?? undefined, undefined, cursor.eventId);
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
  };

  const sendTyping = () => {
    const cur = getState();
    if (!cur.currentRoomId) return;
    if (typingThrottle) return;
    send({
      type: "typing",
      room_id: cur.currentRoomId,
      ...(cur.currentChannelId ? { channel_id: cur.currentChannelId } : {}),
    });
    typingThrottle = setTimeout(() => {
      typingThrottle = null;
    }, TYPING_THROTTLE_MS);
  };


  // ─── Threads ─────────────────────────────────────────────────────────────

  const openThread = async (eventId: string) => {
    if (!getState().currentRoomId) return;
    const roomId = getState().currentRoomId!;
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
  };

  /** Prepend the page of replies before the oldest one held, as scrolling a
   *  channel does. */
  const loadOlderThreadMessages = async () => {
    const cur = getState();
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
  };

  /** Page back through the open thread until `eventId` is loaded, so a pin or
   *  a quoted reply older than what is on screen can still be reached.
   *  Answers whether it was found. Keeps its own cursor rather than rereading
   *  the state, which only catches up after a render. */
  const revealThreadMessage = async (eventId: string) => {
    const cur = getState();
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
  };

  const closeThread = () => {
    dispatch({ type: "CLOSE_THREAD" });
  };

  /** Post into the open thread, answering `replyTo` (or the reply the store
   *  holds, which is how the web's thread composer keeps it). */
  const sendThreadMessage = async (body: string, replyTo?: string) => {
    const cur = getState();
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSendThreadMessage(
      cur.currentRoomId,
      cur.activeThreadEventId,
      body,
      replyTo ?? cur.threadReplyingTo?.event_id,
    );
    dispatch({ type: "SET_THREAD_REPLYING_TO", payload: null });
  };

  const setThreadName = async (name: string) => {
    const cur = getState();
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiSetThreadName(cur.currentRoomId, cur.activeThreadEventId, name);
    dispatch({
      type: "SET_THREAD_NAME",
      payload: { eventId: cur.activeThreadEventId, name },
    });
  };

  const deleteThread = async () => {
    const cur = getState();
    if (!cur.currentRoomId || !cur.activeThreadEventId) return;
    await apiDeleteThread(cur.currentRoomId, cur.activeThreadEventId);
    dispatch({ type: "DELETE_THREAD", payload: cur.activeThreadEventId });
  };

  // ─── Pins ────────────────────────────────────────────────────────────────

  const loadPins = async () => {
    const cur = getState();
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
  };

  const loadMorePins = async () => {
    const cur = getState();
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
  };

  const pinMessage = async (eventId: string) => {
    const cur = getState();
    if (!cur.currentRoomId) return;
    // The server broadcasts m.room.pinned, which is what updates the list.
    await apiPinMessage(cur.currentRoomId, eventId);
  };

  const unpinMessage = async (eventId: string) => {
    const cur = getState();
    if (!cur.currentRoomId) return;
    await apiUnpinMessage(cur.currentRoomId, eventId);
  };

  // ─── Search ──────────────────────────────────────────────────────────────

  /** Where a search looks: this channel, the room's channel-less messages
   *  (a DM), or the whole room. */
  const searchScope = (cur: AppState) => {
    let channelId: string | undefined;
    let noChannelOnly: boolean | undefined;
    if (cur.search.thisChannel) {
      if (cur.currentChannelId) channelId = cur.currentChannelId;
      else noChannelOnly = true;
    }
    return { channelId, noChannelOnly };
  };

  /**
   * Run the search the store describes (`state.search`), first page. The apps
   * call it a beat after the query or its filters change — the debounce is
   * theirs, the request is this.
   */
  const runSearch = async () => {
    const cur = getState();
    const { open, query, filter, fileTypeFilter } = cur.search;
    const roomId = cur.currentRoomId;
    if (!open || !roomId) return;
    const { channelId, noChannelOnly } = searchScope(cur);
    if (filter !== "thread" && filter !== "file" && !query.trim()) {
      dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
      return;
    }
    dispatch({ type: "SET_SEARCH", payload: { loading: true } });
    try {
      const page =
        filter === "thread"
          ? await apiGetRoomThreads(roomId, query.trim() || undefined, channelId, noChannelOnly)
          : await apiSearchMessages(roomId, query.trim(), filter, fileTypeFilter, channelId, noChannelOnly);
      dispatch({
        type: "SET_SEARCH",
        payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_SEARCH", payload: { results: [], hasMore: false, nextOffset: 0 } });
    } finally {
      dispatch({ type: "SET_SEARCH", payload: { loading: false } });
    }
  };

  /** Change the search: its query, filters or whether it is open. */
  const updateSearch = (change: Partial<AppState["search"]>) => dispatch({ type: "SET_SEARCH", payload: change });
  const closeSearch = () => dispatch({ type: "CLOSE_SEARCH" });

  const loadMoreSearchResults = async () => {
    const cur = getState();
    const { open, query, filter, fileTypeFilter, hasMore, loadingMore, nextOffset } = cur.search;
    if (!open || !cur.currentRoomId || !hasMore || loadingMore) return;
    const { channelId, noChannelOnly } = searchScope(cur);
    dispatch({ type: "SET_SEARCH", payload: { loadingMore: true } });
    try {
      const page =
        filter === "thread"
          ? await apiGetRoomThreads(cur.currentRoomId, query.trim() || undefined, channelId, noChannelOnly, nextOffset)
          : await apiSearchMessages(cur.currentRoomId, query.trim(), filter, fileTypeFilter, channelId, noChannelOnly, nextOffset);
      dispatch({
        type: "APPEND_SEARCH_RESULTS",
        payload: { results: page.items, hasMore: page.hasMore, nextOffset: page.nextOffset },
      });
    } catch {
      dispatch({ type: "SET_SEARCH", payload: { loadingMore: false } });
    }
  };


  // ─── People: DMs, friends, your own profile ──────────────────────────────

  /** Open (or create) a DM with one person, or a group DM with several. */
  const openDM = async (targetUserIds: string | string[]) => {
    const data = await apiCreateDM(targetUserIds);
    await loadRooms();
    await selectRoom(data.room_id);
  };


  /** Friends' avatars, names and status. Presence otherwise arrives per room,
   *  and a friend you share no room with would be a bare initial. Merged, so
   *  what the socket has already delivered for anyone else stays. */
  const loadFriendPresence = async () => {
    try {
      const { presence } = await apiGetFriendsPresence();
      const mapped: AppState["userPresence"] = {};
      for (const [userId, raw] of Object.entries(presence)) {
        const p = raw as Record<string, unknown>;
        mapped[userId] = {
          status: String(p.status ?? "offline"),
          customStatus: (p.custom_status as string) || undefined,
          avatarUrl: (p.avatar_url as string) || undefined,
          about: (p.about as string) || undefined,
          bannerUrl: (p.banner_url as string) || undefined,
          displayName: (p.display_name as string) || undefined,
          nameFontUrl: (p.name_font_url as string) || undefined,
          profileTheme: p.profile_theme || undefined,
          isMobile: Boolean(p.is_mobile),
          steamGame: (p.steam_game as string) || undefined,
          steamAppId: (p.steam_appid as string) || undefined,
          gameSessionStart: (p.game_session_start as number) || undefined,
        };
      }
      dispatch({ type: "SET_PRESENCE", payload: { ...getState().userPresence, ...mapped } });
    } catch {
      // The list still renders, with initials.
    }
  };

  const addToGroupDM = async (roomId: string, userId: string) => {
    await apiAddToDM(roomId, userId);
  };

  const loadFriends = async () => {
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
    } catch {
      // Keep whatever is shown.
    }
  };

  /** Takes an id, or a name as someone typed it. */
  const sendFriendRequest = async (who: string) => {
    const userId = userIdFromInput(who, getState().userId);
    const result = await apiSendFriendRequest(userId);
    if (result.auto_accepted) {
      dispatch({ type: "ADD_FRIEND", payload: userId });
    } else {
      dispatch({ type: "ADD_OUTGOING_REQUEST", payload: { userId, requestId: "" } });
    }
  };

  const acceptFriendRequest = async (userId: string) => {
    await apiAcceptFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "ADD_FRIEND", payload: userId });
  };

  const rejectFriendRequest = async (userId: string) => {
    await apiRejectFriendRequest(userId);
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
  };

  const removeFriend = async (userId: string) => {
    await apiRemoveFriend(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
  };

  const blockUser = async (userId: string) => {
    await apiBlockUser(userId);
    dispatch({ type: "REMOVE_FRIEND", payload: userId });
    dispatch({ type: "REMOVE_INCOMING_REQUEST", payload: userId });
    dispatch({ type: "REMOVE_OUTGOING_REQUEST", payload: userId });
    dispatch({ type: "ADD_BLOCKED_USER", payload: userId });
  };

  const unblockUser = async (userId: string) => {
    await apiUnblockUser(userId);
    dispatch({ type: "REMOVE_BLOCKED_USER", payload: userId });
  };

  const setCustomStatus = (status: string) => {
    send({ type: "set_custom_status", custom_status: status });
  };

  const setManualStatus = (status: string) => {
    send({ type: "set_status", status });
  };

  const updateProfile = (profile: {
    avatarUrl?: string;
    bannerUrl?: string;
    about?: string;
    customStatus?: string;
    displayName?: string;
    nameFontUrl?: string;
    profileTheme?: ProfileTheme;
    entranceSoundUrl?: string;
  }) => {
    const payload: Record<string, unknown> = { type: "set_profile" };
    if (profile.avatarUrl !== undefined) payload.avatar_url = profile.avatarUrl;
    if (profile.bannerUrl !== undefined) payload.banner_url = profile.bannerUrl;
    if (profile.about !== undefined) payload.about = profile.about;
    if (profile.customStatus !== undefined) payload.custom_status = profile.customStatus;
    if (profile.displayName !== undefined) payload.display_name = profile.displayName;
    if (profile.nameFontUrl !== undefined) payload.name_font_url = profile.nameFontUrl;
    if (profile.profileTheme !== undefined) payload.profile_theme = profile.profileTheme;
    if (profile.entranceSoundUrl !== undefined) payload.entrance_sound_url = profile.entranceSoundUrl;
    send(payload);
  };

  return {
    loadRooms,
    loadUnreads,
    markChannelRead,
    clearUnread,
    loadNotificationSettings,
    setNotificationLevel,
    loadActiveThreads,
    loadContinuity,
    saveDraft,
    saveResumePoint,
    loadEvents,
    requestVoiceSync,
    loadVoiceMembers,
    loadPresence,
    selectRoom,
    loadOlderMessages,
    openMessage,
    clearPendingJump,
    openThread,
    loadOlderThreadMessages,
    revealThreadMessage,
    closeThread,
    sendThreadMessage,
    setThreadName,
    deleteThread,
    loadPins,
    loadMorePins,
    pinMessage,
    unpinMessage,
    runSearch,
    loadMoreSearchResults,
    updateSearch,
    closeSearch,
    openDM,
    addToGroupDM,
    loadFriends,
    loadFriendPresence,
    sendFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    removeFriend,
    blockUser,
    unblockUser,
    setCustomStatus,
    setManualStatus,
    updateProfile,
    loadMessagesAround,
    selectChannel,
    sendMessage,
    deleteMessage,
    hardDeleteNotification,
    editMessage,
    addReaction,
    recoverMissedMessages,
    sendTyping,
  };
}

export type StoreActions = ReturnType<typeof createStoreActions>;
