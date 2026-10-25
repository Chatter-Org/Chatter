import type { AppState, Action, VoiceChannelMember } from "./types";
import type { MatrixMessage, PollState } from "../api";
import { initialState, THREAD_PREVIEW_LIMIT } from "./types";
import { bucketsFromServer, deriveRoomUnreads } from "../unreads";

/**
 * Fold the poll state a page of messages arrived with into the poll map.
 *
 * Every path that puts messages into state runs through this rather than each
 * caller remembering to, because a poll card that finds no entry draws no bars
 * and has to fetch what it was already handed.
 */
function seedPolls(state: AppState, messages: MatrixMessage[]): Record<string, PollState> {
  let polls = state.polls;
  for (const message of messages) {
    if (!message.poll) continue;
    if (polls === state.polls) polls = { ...polls };
    polls[message.poll.poll_id] = message.poll;
  }
  return polls;
}

/**
 * The room whose call this client is showing.
 *
 * The one it is actually in, when it is in one — a call keeps its panel while
 * you read another room — and otherwise the room on screen.
 */
function focusVoiceRoomId(state: AppState): string | null {
  if (state.inVoiceChannel && state.voiceRoomId) return state.voiceRoomId;
  return state.currentRoomId;
}

/**
 * Re-derive the flat, room-wide voice view from the per-channel map.
 *
 * The two used to be maintained side by side from different events, which is
 * why the member list and the channel list could disagree about who was muted.
 * The per-channel map is the one the server describes, so everything else is
 * computed from it.
 */
function deriveRoomVoice(state: AppState): AppState {
  const roomId = focusVoiceRoomId(state);
  const members: string[] = [];
  const states: Record<
    string,
    { muted: boolean; deafened: boolean; screen_sharing: boolean }
  > = {};
  const sharers: string[] = [];
  // Cameras too: someone who joins after a camera came on hears of it only
  // from the member list, not from the "started" broadcast they missed.
  const streamers: string[] = [];
  if (roomId) {
    for (const [channelId, channelMembers] of Object.entries(state.voiceChannelMembers)) {
      if (state.voiceChannelRooms[channelId] !== roomId) continue;
      for (const member of channelMembers) {
        if (!members.includes(member.userId)) members.push(member.userId);
        states[member.userId] = {
          muted: member.muted,
          // Carried, not dropped: this flat view is what the phone's call sheet
          // reads, and without it a deafened peer could only ever be drawn
          // with an open mic there.
          deafened: member.deafened,
          screen_sharing: member.screen_sharing,
        };
        if (member.screen_sharing && !sharers.includes(member.userId)) {
          sharers.push(member.userId);
        }
        if (member.webcam_sharing && !streamers.includes(member.userId)) {
          streamers.push(member.userId);
        }
      }
    }
  }
  // One's own camera counts from the moment it is on, before the server's
  // member list catches up with it.
  if (state.isWebcamActive && state.userId && !streamers.includes(state.userId)) streamers.push(state.userId);
  return {
    ...state,
    voiceMembers: members,
    voiceMemberStates: states,
    activeScreenSharers: sharers,
    activeWebcamStreamers: streamers,
  };
}

/** Voice head-counts per room, folded back into the room list so a DM row and
 *  a room card show the call without waiting for the next poll. */
function withRoomVoiceCounts(state: AppState): AppState {
  const counts: Record<string, number> = {};
  for (const [channelId, members] of Object.entries(state.voiceChannelMembers)) {
    const roomId = state.voiceChannelRooms[channelId];
    if (!roomId) continue;
    const seen = counts[roomId] ?? 0;
    counts[roomId] = seen + members.length;
  }
  let changed = false;
  const roomInfoMap = { ...state.roomInfoMap };
  for (const [roomId, info] of Object.entries(roomInfoMap)) {
    const count = counts[roomId] ?? 0;
    if ((info.dm_voice_count ?? 0) === count) continue;
    roomInfoMap[roomId] = { ...info, dm_voice_count: count };
    changed = true;
  }
  return changed ? { ...state, roomInfoMap } : state;
}

/** Channel kinds whose view is not the chat timeline. */
const NON_TIMELINE_CHANNELS = new Set(["forum", "whiteboard", "theater", "showcase", "spatial", "voice"]);

function isChatRoomType(roomType: string | undefined): boolean {
  return roomType !== "forum" && roomType !== "whiteboard" && roomType !== "watchparty";
}

/** Recompute the room badges from the buckets they summarise. Every case that
 *  touches a bucket ends here, so the two can never disagree. */
function withRoomUnreads(state: AppState): AppState {
  return { ...state, ...deriveRoomUnreads(state) };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "LOGIN":
      return {
        ...state,
        accessToken: action.payload.accessToken,
        userId: action.payload.userId,
      };
    case "SET_SESSION_RESTORE":
      return { ...state, sessionRestore: action.payload };
    case "LOGOUT":
      // Deliberately not "pending": this is a settled answer, and leaving it
      // pending would put the reconnecting screen in front of someone who has
      // just been told their session is over.
      return { ...initialState, sessionRestore: "absent" as const };
    case "SET_ROOMS":
      return {
        ...state,
        joinedRoomIds: action.payload.roomIds,
        roomInfoMap: action.payload.roomInfoMap,
      };
    case "SELECT_ROOM": {
      // When in a voice channel, preserve voice/screen share state across room switches
      const preserveVoice = state.inVoiceChannel;
      // `voiceChannelMembers` is deliberately not cleared: it describes every
      // room, not the one being left, and the flat view below is derived from
      // it. Clearing it used to blank the new room's voice channels until
      // something happened to refetch them — which, on a room switch, nothing
      // did.
      return withRoomUnreads(deriveRoomVoice({
        ...state,
        currentRoomId: action.payload,
        currentChannelId: null,
        channels: [],
        channelCategories: [],
        messages: [],
        hasMoreMessages: false,
        loadingOlderMessages: false,
        roomMembers: [],
        screenViewerOpen: preserveVoice ? state.screenViewerOpen : false,
        selectedScreenSharer: preserveVoice ? state.selectedScreenSharer : null,
        selectedWebcamStreamer: preserveVoice ? state.selectedWebcamStreamer : null,
        screenViewers: preserveVoice ? state.screenViewers : {},
        typingUsers: [],
        adminDashboardOpen: false,
        // Only the room's *loose* pings are dismissed by opening it — a DM,
        // a forum, a thread reply: what has no channel row to keep showing
        // it. A ping in a channel stays on that channel until it is read,
        // and so stays on the room if the reader leaves without reading it.
        roomLooseMentions: action.payload
          ? { ...state.roomLooseMentions, [action.payload]: 0 }
          : state.roomLooseMentions,
        // A room with no timeline (a forum, a whiteboard, a watch party)
        // never mounts the chat view that clears the rest on arrival.
        roomLooseUnreads:
          action.payload && !isChatRoomType(state.roomInfoMap[action.payload]?.room_type)
            ? { ...state.roomLooseUnreads, [action.payload]: 0 }
            : state.roomLooseUnreads,
        myPermissions: null,
        myRestriction: null,
        companionPanel: null,
        roomEvents: [],
        pinnedMessages: [],
        pinsHasMore: false,
        pinsNextOffset: 0,
        // A pending jump is kept only while it points at the room being
        // opened. Any other target belongs to a room this switch walked away
        // from, and would fire the next time that room came up.
        pendingJump:
          state.pendingJump && state.pendingJump.roomId === action.payload
            ? state.pendingJump
            : null,
        loadingMorePins: false,
        activeThreadEventId: null,
        threadRootMessage: null,
        threadMessages: [],
        threadReplyingTo: null,
        threadPins: [],
      }));
    }
    case "SET_MESSAGES":
      return {
        ...state,
        messages: action.payload.messages,
        hasMoreMessages: action.payload.hasMore,
        polls: seedPolls(state, action.payload.messages),
      };
    case "PREPEND_MESSAGES":
      return {
        ...state,
        messages: [...action.payload.messages, ...state.messages],
        hasMoreMessages: action.payload.hasMore,
        loadingOlderMessages: false,
        polls: seedPolls(state, action.payload.messages),
      };
    case "SET_LOADING_OLDER":
      return { ...state, loadingOlderMessages: action.payload };
    case "ADD_MESSAGE":
      if (state.messages.some((m) => m.event_id === action.payload.event_id)) return state;
      return {
        ...state,
        messages: [...state.messages, action.payload],
        polls: seedPolls(state, [action.payload]),
      };
    case "SET_POLLS":
      return { ...state, polls: { ...state.polls, ...action.payload } };
    case "UPDATE_POLL":
      return {
        ...state,
        polls: { ...state.polls, [action.payload.poll_id]: action.payload },
      };
    // A message is on screen in up to three places at once — the timeline, the
    // pin list, and an open thread — and only the first two were being cleared,
    // so deleting a reply from inside a thread left it sitting there. Deleting
    // a thread's *root* takes the thread with it: what is left is a panel of
    // replies to something that is gone.
    case "REDACT_MESSAGE":
    case "REMOVE_MESSAGE": {
      const goneId = action.payload;
      const wasThreadRoot = state.activeThreadEventId === goneId;
      return {
        ...state,
        messages: state.messages.filter((m) => m.event_id !== goneId),
        pinnedMessages: state.pinnedMessages.filter((m) => m.event_id !== goneId),
        activeThreadEventId: wasThreadRoot ? null : state.activeThreadEventId,
        threadRootMessage:
          state.threadRootMessage?.event_id === goneId ? null : state.threadRootMessage,
        threadMessages: wasThreadRoot
          ? []
          : state.threadMessages.filter((m) => m.event_id !== goneId),
        threadPins: wasThreadRoot ? [] : state.threadPins.filter((m) => m.event_id !== goneId),
        threadReplyingTo:
          wasThreadRoot || state.threadReplyingTo?.event_id === goneId ? null : state.threadReplyingTo,
      };
    }
    case "SET_ROOM_EVENTS":
      return { ...state, roomEvents: action.payload };
    case "UPSERT_ROOM_EVENT": {
      const incoming = action.payload;
      if (incoming.room_id !== state.currentRoomId) return state;
      const known = state.roomEvents.find((e) => e.event_id === incoming.event_id);
      // A broadcast reaches the whole room, so it cannot carry anyone's own
      // answer (the server always sends it empty). Keep the one this client
      // already knows rather than letting a neighbour's RSVP blank out yours.
      // An answer that is there came from this client's own request — the
      // event it just created — and wins, even when the broadcast got here
      // first and was stored with none.
      const merged = known ? { ...incoming, my_rsvp: incoming.my_rsvp || known.my_rsvp } : incoming;
      const rest = state.roomEvents.filter((e) => e.event_id !== incoming.event_id);
      return {
        ...state,
        roomEvents: [...rest, merged].sort((a, b) => a.starts_at - b.starts_at),
      };
    }
    case "REMOVE_ROOM_EVENT":
      return {
        ...state,
        roomEvents: state.roomEvents.filter((e) => e.event_id !== action.payload),
      };
    case "SET_MY_RSVP": {
      const { eventId, status } = action.payload;
      return {
        ...state,
        roomEvents: state.roomEvents.map((e) => {
          if (e.event_id !== eventId) return e;
          // The counts move optimistically so the face pile and the tally
          // agree with the button the moment it is pressed; the broadcast
          // that follows replaces them with the server's figures.
          const was = e.my_rsvp;
          const delta = (s: string) => (status === s ? 1 : 0) - (was === s ? 1 : 0);
          return {
            ...e,
            my_rsvp: status,
            going_count: Math.max(0, e.going_count + delta("going")),
            maybe_count: Math.max(0, e.maybe_count + delta("maybe")),
          };
        }),
      };
    }
    case "SET_PINNED_MESSAGES":
      return {
        ...state,
        pinnedMessages: action.payload.pins,
        pinsHasMore: action.payload.hasMore,
        pinsNextOffset: action.payload.nextOffset,
        loadingMorePins: false,
      };
    case "APPEND_PINNED_MESSAGES": {
      const seen = new Set(state.pinnedMessages.map((m) => m.event_id));
      const fresh = action.payload.pins.filter((m) => !seen.has(m.event_id));
      return {
        ...state,
        pinnedMessages: [...state.pinnedMessages, ...fresh],
        pinsHasMore: action.payload.hasMore,
        pinsNextOffset: action.payload.nextOffset,
        loadingMorePins: false,
      };
    }
    case "SET_LOADING_MORE_PINS":
      return { ...state, loadingMorePins: action.payload };
    case "ADD_PINNED_MESSAGE":
      if (state.pinnedMessages.some((m) => m.event_id === action.payload.event_id)) return state;
      return {
        ...state,
        pinnedMessages: [action.payload, ...state.pinnedMessages],
        // The new pin sorts above the loaded page, pushing everything down one.
        pinsNextOffset: state.pinsNextOffset + 1,
      };
    case "REMOVE_PINNED_MESSAGE": {
      // An unpin names the message, not the list it was in.
      const threadPins = state.threadPins.some((m) => m.event_id === action.payload)
        ? state.threadPins.filter((m) => m.event_id !== action.payload)
        : state.threadPins;
      if (!state.pinnedMessages.some((m) => m.event_id === action.payload)) {
        return threadPins === state.threadPins ? state : { ...state, threadPins };
      }
      return {
        ...state,
        threadPins,
        pinnedMessages: state.pinnedMessages.filter((m) => m.event_id !== action.payload),
        pinsNextOffset: Math.max(0, state.pinsNextOffset - 1),
      };
    }
    case "EDIT_MESSAGE":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody, ...(action.payload.newEmbeds !== undefined ? { embeds: action.payload.newEmbeds } : {}) } }
            : m
        ),
        pinnedMessages: state.pinnedMessages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody, ...(action.payload.newEmbeds !== undefined ? { embeds: action.payload.newEmbeds } : {}) } }
            : m
        ),
        // A thread reply is edited like any message, and is on screen in the
        // thread and possibly its pin list.
        threadMessages: state.threadMessages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody, ...(action.payload.newEmbeds !== undefined ? { embeds: action.payload.newEmbeds } : {}) } }
            : m
        ),
        threadPins: state.threadPins.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, edited: true, content: { ...m.content, body: action.payload.newBody, ...(action.payload.newEmbeds !== undefined ? { embeds: action.payload.newEmbeds } : {}) } }
            : m
        ),
      };
    case "SET_REACTIONS":
      return {
        ...state,
        messageReactions: {
          ...state.messageReactions,
          [action.payload.eventId]: action.payload.reactions,
        },
      };
    case "SET_ROOM_MEMBERS":
      return { ...state, roomMembers: action.payload };
    case "SET_PRESENCE":
      // Merged, not replaced. Every caller fetches presence for one room, so
      // replacing threw away everyone outside it: opening a DM left the rest of
      // the list with no presence at all, and their avatars and display names
      // fell back to initials until something happened to refetch them. A
      // presence entry going stale is corrected by the next `presence_update`;
      // a discarded one is not corrected by anything.
      return {
        ...state,
        userPresence: { ...state.userPresence, ...action.payload },
      };
    case "SET_VOICE_STATE":
      // Joining or leaving a call moves which room the member list describes,
      // so the flat view is re-derived rather than left until the next event
      // happens to correct it.
      return deriveRoomVoice({ ...state, ...action.payload });
    case "SET_VOICE_MEMBERS":
      return {
        ...state,
        voiceMembers: action.payload.members,
        voiceMemberStates: action.payload.states,
      };
    case "VOICE_USER_JOINED": {
      const newMembers = state.voiceMembers.includes(action.payload)
        ? state.voiceMembers
        : [...state.voiceMembers, action.payload];
      return {
        ...state,
        voiceMembers: newMembers,
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: state.voiceMemberStates[action.payload] || {
            muted: false,
            deafened: false,
            screen_sharing: false,
          },
        },
      };
    }
    case "VOICE_USER_LEFT": {
      const { [action.payload]: _, ...remainingStates } = state.voiceMemberStates;
      return {
        ...state,
        voiceMembers: state.voiceMembers.filter((id) => id !== action.payload),
        voiceMemberStates: remainingStates,
        activeScreenSharers: state.activeScreenSharers.filter(
          (id) => id !== action.payload
        ),
      };
    }
    case "VOICE_USER_MUTED":
      return {
        ...state,
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload.userId]: {
            ...(state.voiceMemberStates[action.payload.userId] || {
              muted: false,
              deafened: false,
              screen_sharing: false,
            }),
            muted: action.payload.muted,
          },
        },
      };
    case "SCREEN_SHARE_STARTED":
      return {
        ...state,
        activeScreenSharers: state.activeScreenSharers.includes(action.payload)
          ? state.activeScreenSharers
          : [...state.activeScreenSharers, action.payload],
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: {
            ...(state.voiceMemberStates[action.payload] || {
              muted: false,
              deafened: false,
              screen_sharing: false,
            }),
            screen_sharing: true,
          },
        },
      };
    case "SCREEN_SHARE_STOPPED": {
      const { [action.payload]: _removedViewers, ...remainingViewers } = state.screenViewers;
      return {
        ...state,
        activeScreenSharers: state.activeScreenSharers.filter(
          (id) => id !== action.payload
        ),
        voiceMemberStates: {
          ...state.voiceMemberStates,
          [action.payload]: {
            ...(state.voiceMemberStates[action.payload] || {
              muted: false,
              deafened: false,
              screen_sharing: false,
            }),
            screen_sharing: false,
          },
        },
        screenViewers: remainingViewers,
      };
    }
    case "SET_ACTIVE_SCREEN_SHARERS":
      return { ...state, activeScreenSharers: action.payload };
    case "SET_SCREEN_VIEWER": {
      const selectingSharer = action.payload.sharer !== undefined;
      const selectingWebcam = action.payload.webcamStreamer !== undefined;
      return {
        ...state,
        screenViewerOpen: action.payload.open ?? state.screenViewerOpen,
        selectedScreenSharer: selectingSharer
          ? (action.payload.sharer ?? null)
          : selectingWebcam
            ? null
            : state.selectedScreenSharer,
        selectedWebcamStreamer: selectingWebcam
          ? (action.payload.webcamStreamer ?? null)
          : selectingSharer
            ? null
            : state.selectedWebcamStreamer,
      };
    }
    case "SET_SCREEN_VIEWERS":
      return {
        ...state,
        screenViewers: {
          ...state.screenViewers,
          [action.payload.sharerId]: action.payload.viewers,
        },
      };
    // Who is watching is the server's to know, and it only holds it in memory.
    // A reconnect may be to a server that has forgotten, so the last list we
    // were sent is not evidence of anything until it tells us again.
    case "CLEAR_SCREEN_VIEWERS":
      return { ...state, screenViewers: {} };
    case "WEBCAM_SHARE_STARTED":
      return {
        ...state,
        activeWebcamStreamers: state.activeWebcamStreamers.includes(action.payload)
          ? state.activeWebcamStreamers
          : [...state.activeWebcamStreamers, action.payload],
      };
    case "WEBCAM_SHARE_STOPPED":
      return {
        ...state,
        activeWebcamStreamers: state.activeWebcamStreamers.filter((id) => id !== action.payload),
      };
    case "SET_ACTIVE_WEBCAM_STREAMERS":
      return { ...state, activeWebcamStreamers: action.payload };
    case "SET_VIEW":
      return { ...state, currentView: action.payload };
    case "SET_COMPANION_PANEL":
      return { ...state, companionPanel: action.payload };
    case "SET_SEARCH":
      return { ...state, search: { ...state.search, ...action.payload } };
    case "CLOSE_SEARCH":
      return { ...state, search: { ...initialState.search } };
    case "APPEND_SEARCH_RESULTS": {
      // Dedupe: a message pinned or posted between pages can shift the window.
      const seen = new Set(state.search.results.map((m) => m.event_id));
      const fresh = action.payload.results.filter((m) => !seen.has(m.event_id));
      return {
        ...state,
        search: {
          ...state.search,
          results: [...state.search.results, ...fresh],
          hasMore: action.payload.hasMore,
          nextOffset: action.payload.nextOffset,
          loadingMore: false,
        },
      };
    }
    case "SET_MENTION":
      return withRoomUnreads({
        ...state,
        roomLooseMentions: {
          ...state.roomLooseMentions,
          [action.payload.roomId]: action.payload.hasMention
            ? (state.roomLooseMentions[action.payload.roomId] || 0) + 1
            : 0,
        },
      });
    case "SET_REPLYING_TO":
      return { ...state, replyingTo: action.payload };
    // A thread has its own composer, so it has its own reply target. Sharing
    // `replyingTo` put the quote on the channel's composer instead, and sent a
    // thread message's quote into the channel.
    case "SET_THREAD_REPLYING_TO":
      return { ...state, threadReplyingTo: action.payload };
    case "OPEN_THREAD":
      return {
        ...state,
        activeThreadEventId: action.payload.eventId,
        threadRootMessage: action.payload.root,
        threadMessages: action.payload.messages,
        threadHasMore: action.payload.hasMore,
        threadLoadingOlder: false,
        threadPosters: action.payload.posters,
        threadReplyingTo: null,
        // Filled by the pin fetch that follows; a previous thread's pins must
        // not show under this one while it is in flight.
        threadPins: [],
        // Opening a thread is reading it, so its badge goes with it. The
        // provider moves the server's marker for the same reason, which is what
        // keeps the badge gone after a reload rather than only in this session.
        threadMentions: { ...state.threadMentions, [action.payload.eventId]: 0 },
      };
    // Both guarded by thread: a page asked for under one thread can land after
    // another has been opened, and must not be spliced into it.
    case "PREPEND_THREAD_MESSAGES": {
      if (state.activeThreadEventId !== action.payload.threadId) return state;
      const held = new Set(state.threadMessages.map((m) => m.event_id));
      const older = action.payload.messages.filter((m) => !held.has(m.event_id));
      return {
        ...state,
        threadMessages: [...older, ...state.threadMessages],
        threadHasMore: action.payload.hasMore,
        threadLoadingOlder: false,
      };
    }
    case "SET_THREAD_LOADING_OLDER":
      if (state.activeThreadEventId !== action.payload.threadId) return state;
      return { ...state, threadLoadingOlder: action.payload.loading };
    case "SET_THREAD_PINS":
      if (state.activeThreadEventId !== action.payload.threadId) return state;
      return { ...state, threadPins: action.payload.pins };
    case "ADD_THREAD_PIN":
      if (state.activeThreadEventId !== action.payload.thread_id) return state;
      if (state.threadPins.some((m) => m.event_id === action.payload.event_id)) return state;
      return { ...state, threadPins: [action.payload, ...state.threadPins] };
    case "CLOSE_THREAD":
      return {
        ...state,
        activeThreadEventId: null,
        threadRootMessage: null,
        threadMessages: [],
        threadHasMore: false,
        threadLoadingOlder: false,
        threadPosters: [],
        threadReplyingTo: null,
        threadPins: [],
      };
    case "ADD_THREAD_MESSAGE":
      if (state.activeThreadEventId !== action.payload.thread_id) return state;
      if (state.threadMessages.some((m) => m.event_id === action.payload.event_id)) return state;
      return {
        ...state,
        threadMessages: [...state.threadMessages, action.payload],
        threadPosters:
          action.payload.content?.msgtype === "m.system" || state.threadPosters.includes(action.payload.sender)
            ? state.threadPosters
            : [...state.threadPosters, action.payload.sender],
      };
    case "UPDATE_THREAD_REPLY_COUNT": {
      // The count is shown in two places — the badge on the root message and
      // the channel list's preview row — and only the first was kept up. The
      // preview's own action carries a timestamp and re-sorts by it, which is
      // right for a reply and wrong for a deletion: losing a reply is not
      // activity and must not lift the thread up the list.
      const { eventId, count } = action.payload;
      const previews = Object.fromEntries(
        Object.entries(state.channelThreads).map(([channelId, threads]) => [
          channelId,
          threads.map((thread) =>
            thread.threadId === eventId ? { ...thread, replyCount: count } : thread,
          ),
        ]),
      );
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === eventId ? { ...m, thread_reply_count: count } : m
        ),
        // The open thread's header counts off its root too, since the replies
        // it holds are only the pages scrolled through.
        threadRootMessage:
          state.threadRootMessage?.event_id === eventId
            ? { ...state.threadRootMessage, thread_reply_count: count }
            : state.threadRootMessage,
        channelThreads: previews,
      };
    }
    case "ADD_THREAD_PARTICIPANTS": {
      const mergeParticipants = (existing: string[] | undefined, added: string[]) => {
        const set = new Set(existing ?? []);
        added.forEach((p) => set.add(p));
        return Array.from(set);
      };
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, thread_participants: mergeParticipants(m.thread_participants, action.payload.participants) }
            : m
        ),
        threadRootMessage:
          state.threadRootMessage?.event_id === action.payload.eventId
            ? { ...state.threadRootMessage, thread_participants: mergeParticipants(state.threadRootMessage.thread_participants, action.payload.participants) }
            : state.threadRootMessage,
      };
    }
    case "DELETE_THREAD":
      return {
        ...state,
        messages: state.messages.filter((m) => m.event_id !== action.payload),
        activeThreadEventId: state.activeThreadEventId === action.payload ? null : state.activeThreadEventId,
        threadRootMessage: state.threadRootMessage?.event_id === action.payload ? null : state.threadRootMessage,
        threadMessages: state.activeThreadEventId === action.payload ? [] : state.threadMessages,
        threadPins: state.activeThreadEventId === action.payload ? [] : state.threadPins,
        threadReplyingTo: state.activeThreadEventId === action.payload ? null : state.threadReplyingTo,
        threadMentions: { ...state.threadMentions, [action.payload]: 0 },
      };
    case "SET_THREAD_NAME":
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.event_id === action.payload.eventId
            ? { ...m, thread_name: action.payload.name }
            : m
        ),
        threadRootMessage:
          state.threadRootMessage?.event_id === action.payload.eventId
            ? { ...state.threadRootMessage, thread_name: action.payload.name }
            : state.threadRootMessage,
      };
    case "SET_DM_VOICE_COUNT": {
      // Only for rooms already known; a call in a room this client has never
      // heard of is not something to invent an entry for.
      const info = state.roomInfoMap[action.payload.roomId];
      if (!info || info.dm_voice_count === action.payload.count) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: { ...info, dm_voice_count: action.payload.count },
        },
      };
    }
    case "UPDATE_ROOM_TOPIC":
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...state.roomInfoMap[action.payload.roomId],
            topic: action.payload.topic,
          },
        },
      };
    case "UPDATE_ROOM_SETTINGS": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            ...(action.payload.name !== undefined && { name: action.payload.name }),
            ...(action.payload.icon_url !== undefined && { icon_url: action.payload.icon_url }),
            ...(action.payload.tags !== undefined && { tags: action.payload.tags }),
            ...(action.payload.custom_emojis !== undefined && { custom_emojis: action.payload.custom_emojis }),
            ...(action.payload.emoji_aliases !== undefined && { emoji_aliases: action.payload.emoji_aliases }),
            ...(action.payload.unlisted !== undefined && { unlisted: action.payload.unlisted }),
            ...(action.payload.has_password !== undefined && { has_password: action.payload.has_password }),
            ...(action.payload.read_only !== undefined && { read_only: action.payload.read_only }),
            ...(action.payload.banner_url !== undefined && { banner_url: action.payload.banner_url }),
          },
        },
      };
    }
    case "UPDATE_MEMBER_EVENT":
      return state; // Trigger re-render for member loading
    case "SET_TYPING_USER":
      return {
        ...state,
        typingUsers: state.typingUsers.includes(action.payload)
          ? state.typingUsers
          : [...state.typingUsers, action.payload],
      };
    case "CLEAR_TYPING_USER":
      return {
        ...state,
        typingUsers: state.typingUsers.filter((id) => id !== action.payload),
      };
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.payload };
    case "UPDATE_MEMBER_ROLE":
      return {
        ...state,
        roomMembers: state.roomMembers.map((m) =>
          m.userId === action.payload.userId
            ? { ...m, role: action.payload.role }
            : m
        ),
      };
    case "UPDATE_NAME_COLORS": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            owner_name_color: action.payload.owner_name_color,
            mod_name_color: action.payload.mod_name_color,
          },
        },
      };
    }
    case "SET_IS_ADMIN":
      return { ...state, isAdmin: action.payload };
    case "SET_ADMIN_DASHBOARD_OPEN":
      return { ...state, adminDashboardOpen: action.payload };
    case "SET_SERVER_SETTINGS":
      return { ...state, requireAuthForUploads: action.payload.requireAuthForUploads, uploadLimitBytes: action.payload.uploadLimitBytes, storageLimitBytes: action.payload.storageLimitBytes };
    case "SET_TOTP_VERIFIED":
      return { ...state, totpVerified: action.payload };
    case "SET_PENDING_JUMP":
      return { ...state, pendingJump: action.payload };
    case "SET_ROOM_GROUPS":
      return { ...state, roomGroups: action.payload };
    case "SET_SIDEBAR_ORDER":
      return { ...state, sidebarOrder: action.payload };
    case "UPDATE_ROOM_GROUP":
      return {
        ...state,
        roomGroups: state.roomGroups.map((g) =>
          g.group_id === action.payload.group_id ? action.payload : g
        ),
      };
    case "REMOVE_ROOM_GROUP":
      return {
        ...state,
        roomGroups: state.roomGroups.filter((g) => g.group_id !== action.payload),
      };
    case "TOGGLE_GROUP_COLLAPSED":
      return {
        ...state,
        roomGroups: state.roomGroups.map((g) =>
          g.group_id === action.payload.groupId
            ? { ...g, collapsed: action.payload.collapsed }
            : g
        ),
      };
    case "SET_FRIENDS_DATA":
      return {
        ...state,
        friends: action.payload.friends,
        incomingFriendRequests: action.payload.incomingRequests,
        outgoingFriendRequests: action.payload.outgoingRequests,
        blockedUsers: action.payload.blocked,
      };
    case "ADD_FRIEND":
      return {
        ...state,
        friends: state.friends.includes(action.payload)
          ? state.friends
          : [...state.friends, action.payload],
      };
    case "REMOVE_FRIEND":
      return {
        ...state,
        friends: state.friends.filter((id) => id !== action.payload),
      };
    case "ADD_INCOMING_REQUEST":
      return {
        ...state,
        incomingFriendRequests: state.incomingFriendRequests.some((r) => r.userId === action.payload.userId)
          ? state.incomingFriendRequests
          : [...state.incomingFriendRequests, action.payload],
      };
    case "REMOVE_INCOMING_REQUEST":
      return {
        ...state,
        incomingFriendRequests: state.incomingFriendRequests.filter((r) => r.userId !== action.payload),
      };
    case "ADD_OUTGOING_REQUEST":
      return {
        ...state,
        outgoingFriendRequests: state.outgoingFriendRequests.some((r) => r.userId === action.payload.userId)
          ? state.outgoingFriendRequests
          : [...state.outgoingFriendRequests, action.payload],
      };
    case "REMOVE_OUTGOING_REQUEST":
      return {
        ...state,
        outgoingFriendRequests: state.outgoingFriendRequests.filter((r) => r.userId !== action.payload),
      };
    case "ADD_BLOCKED_USER":
      return {
        ...state,
        blockedUsers: state.blockedUsers.includes(action.payload)
          ? state.blockedUsers
          : [...state.blockedUsers, action.payload],
      };
    case "REMOVE_BLOCKED_USER":
      return {
        ...state,
        blockedUsers: state.blockedUsers.filter((id) => id !== action.payload),
      };
    case "SET_CUSTOM_ROLES":
      return { ...state, customRoles: action.payload };
    case "ADD_CUSTOM_ROLE":
      if (state.customRoles.some((r) => r.role_id === action.payload.role_id)) return state;
      return { ...state, customRoles: [...state.customRoles, action.payload] };
    case "UPDATE_CUSTOM_ROLE":
      return {
        ...state,
        customRoles: state.customRoles.map((r) =>
          r.role_id === action.payload.role_id ? { ...r, ...action.payload } : r
        ),
      };
    case "REMOVE_CUSTOM_ROLE":
      return {
        ...state,
        customRoles: state.customRoles.filter((r) => r.role_id !== action.payload),
      };
    case "SET_MY_PERMISSIONS":
      return { ...state, myPermissions: action.payload };
    case "SET_MY_RESTRICTION":
      return { ...state, myRestriction: action.payload };
    case "SET_REPORT_COUNT":
      return {
        ...state,
        reportCounts: { ...state.reportCounts, [action.payload.roomId]: action.payload.count },
      };
    case "SET_ROOM_MODERATION": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: { ...existing, moderation: action.payload.moderation },
        },
      };
    }
    case "SET_MEMBER_TIMEOUT":
      return {
        ...state,
        roomMembers: state.roomMembers.map((m) =>
          m.userId === action.payload.userId
            ? { ...m, timeoutUntil: action.payload.timeoutUntil > Date.now() ? action.payload.timeoutUntil : undefined }
            : m,
        ),
      };
    case "SET_MEMBER_CUSTOM_ROLES":
      return { ...state, memberCustomRoles: action.payload };
    case "UPDATE_MEMBER_CUSTOM_ROLES":
      return {
        ...state,
        memberCustomRoles: { ...state.memberCustomRoles, [action.payload.userId]: action.payload.roleIds },
      };
    case "SET_CHANNELS":
      return { ...state, channels: action.payload };
    case "SET_CHANNEL_CATEGORIES":
      return { ...state, channelCategories: action.payload };
    case "ADD_CHANNEL_CATEGORY":
      if (state.channelCategories.some((c) => c.category_id === action.payload.category_id)) return state;
      return { ...state, channelCategories: [...state.channelCategories, action.payload] };
    case "UPDATE_CHANNEL_CATEGORY":
      return {
        ...state,
        channelCategories: state.channelCategories.map((c) =>
          c.category_id === action.payload.category_id ? { ...c, ...action.payload } : c
        ),
      };
    case "REMOVE_CHANNEL_CATEGORY":
      return {
        ...state,
        channelCategories: state.channelCategories.filter((c) => c.category_id !== action.payload),
        channels: state.channels.map((ch) =>
          ch.category_id === action.payload ? { ...ch, category_id: "" } : ch
        ),
      };
    case "SELECT_CHANNEL": {
      const channelId = action.payload;
      const remembered =
        channelId && state.currentRoomId
          ? { ...state.lastChannelByRoom, [state.currentRoomId]: channelId }
          : state.lastChannelByRoom;
      // A text channel is cleared by the chat view once it has measured the
      // unread for its "New" divider. Every other kind opens a view that
      // never does, so its highlight would outlive the visit.
      const channelType = state.channels.find((c) => c.channel_id === channelId)?.channel_type ?? "";
      const unreads = !channelId || !NON_TIMELINE_CHANNELS.has(channelType)
        ? {}
        : {
            channelUnreadCounts: { ...state.channelUnreadCounts, [channelId]: 0 },
            channelMentions: { ...state.channelMentions, [channelId]: 0 },
            channelLatestUnreadTs: { ...state.channelLatestUnreadTs, [channelId]: 0 },
          };
      return withRoomUnreads({
        ...state,
        ...unreads,
        lastChannelByRoom: remembered,
        currentChannelId: action.payload,
        messages: [],
        hasMoreMessages: false,
        loadingOlderMessages: false,
        myPermissions: null,
        pinnedMessages: [],
        pinsHasMore: false,
        pinsNextOffset: 0,
        loadingMorePins: false,
        // A thread belongs to the channel it was opened from, so picking a
        // different channel leaves it behind — as switching room already did.
        // The panel renders on activeThreadEventId, so leaving it set meant
        // clicking a channel appeared to do nothing at all.
        //
        // Opening a thread from the sidebar selects its channel first and only
        // opens once the fetch returns, so this clear lands before that and
        // does not undo it.
        activeThreadEventId: null,
        threadRootMessage: null,
        threadMessages: [],
        threadReplyingTo: null,
        threadPins: [],
      });
    }
    case "ADD_CHANNEL":
      if (state.channels.some((c) => c.channel_id === action.payload.channel_id)) return state;
      return { ...state, channels: [...state.channels, action.payload] };
    case "UPDATE_CHANNEL":
      return {
        ...state,
        channels: state.channels.map((c) =>
          c.channel_id === action.payload.channel_id
            ? { ...c, ...action.payload }
            : c
        ),
      };
    case "REMOVE_CHANNEL":
      return {
        ...state,
        channels: state.channels.filter((c) => c.channel_id !== action.payload),
        currentChannelId:
          state.currentChannelId === action.payload ? null : state.currentChannelId,
      };
    case "SET_VOICE_CHANNEL": {
      const { channelId, roomId, members } = action.payload;
      // An emptied channel is removed rather than kept as an empty list, so
      // "is anyone in there" is one question with one answer.
      const voiceChannelMembers = { ...state.voiceChannelMembers };
      const voiceChannelRooms = { ...state.voiceChannelRooms };
      const voiceChannelOccupiedSince = { ...state.voiceChannelOccupiedSince };
      if (members.length === 0) {
        delete voiceChannelMembers[channelId];
        delete voiceChannelRooms[channelId];
        delete voiceChannelOccupiedSince[channelId];
      } else {
        voiceChannelMembers[channelId] = members;
        if (roomId) voiceChannelRooms[channelId] = roomId;
      }
      return withRoomVoiceCounts(
        deriveRoomVoice({
          ...state,
          voiceChannelMembers,
          voiceChannelRooms,
          voiceChannelOccupiedSince,
        }),
      );
    }
    case "SET_VOICE_POSITION": {
      // One person moved. A position event is a delta by design — the full
      // record still rides on every join, leave and mute — so a channel this
      // client has never seen is left alone rather than invented from it.
      const { channelId, userId, x, y } = action.payload;
      const members = state.voiceChannelMembers[channelId];
      if (!members?.some((m) => m.userId === userId)) return state;
      return {
        ...state,
        voiceChannelMembers: {
          ...state.voiceChannelMembers,
          [channelId]: members.map((m) => (m.userId === userId ? { ...m, x, y } : m)),
        },
      };
    }
    case "SYNC_VOICE_STATE": {
      const { roomId: scope, channels } = action.payload;
      // A snapshot is authoritative for everything it covers, so channels it
      // does not name within that scope are empty — not merely unchanged.
      const voiceChannelMembers: Record<string, VoiceChannelMember[]> = {};
      const voiceChannelRooms: Record<string, string> = {};
      const voiceChannelOccupiedSince: Record<string, number> = {};
      if (scope) {
        for (const [channelId, members] of Object.entries(state.voiceChannelMembers)) {
          const room = state.voiceChannelRooms[channelId];
          if (room === scope) continue;
          voiceChannelMembers[channelId] = members;
          if (room) voiceChannelRooms[channelId] = room;
          const since = state.voiceChannelOccupiedSince[channelId];
          if (since !== undefined) voiceChannelOccupiedSince[channelId] = since;
        }
      }
      for (const [channelId, channel] of Object.entries(channels)) {
        if (channel.members.length === 0) continue;
        voiceChannelMembers[channelId] = channel.members;
        voiceChannelRooms[channelId] = channel.roomId;
        if (channel.occupiedSince != null) {
          voiceChannelOccupiedSince[channelId] = channel.occupiedSince;
        }
      }
      return withRoomVoiceCounts(
        deriveRoomVoice({
          ...state,
          voiceChannelMembers,
          voiceChannelRooms,
          voiceChannelOccupiedSince,
        }),
      );
    }
    case "SET_WATCH_VIEWERS":
      return {
        ...state,
        watchViewers: { ...state.watchViewers, [action.payload.roomId]: action.payload.users },
      };
    case "UPDATE_VOICE_CHANNEL_OCCUPIED_SINCE": {
      if (action.payload.since == null) {
        const next = { ...state.voiceChannelOccupiedSince };
        delete next[action.payload.channelId];
        return { ...state, voiceChannelOccupiedSince: next };
      }
      return {
        ...state,
        voiceChannelOccupiedSince: {
          ...state.voiceChannelOccupiedSince,
          [action.payload.channelId]: action.payload.since,
        },
      };
    }
    case "SET_CHANNEL_MENTION":
      return withRoomUnreads({
        ...state,
        channelRoomIds: { ...state.channelRoomIds, [action.payload.channelId]: action.payload.roomId },
        channelMentions: {
          ...state.channelMentions,
          [action.payload.channelId]: action.payload.hasMention
            ? (state.channelMentions[action.payload.channelId] || 0) + 1
            : 0,
        },
      });
    case "SET_THREAD_MENTION":
      return {
        ...state,
        threadMentions: {
          ...state.threadMentions,
          [action.payload.threadId]: action.payload.hasMention
            ? (state.threadMentions[action.payload.threadId] || 0) + 1
            : 0,
        },
      };
    case "INCREMENT_CHANNEL_UNREAD": {
      const channelId = action.payload.channelId;
      const ts = action.payload.ts;
      const latest = state.channelLatestUnreadTs;
      return withRoomUnreads({
        ...state,
        channelRoomIds: { ...state.channelRoomIds, [channelId]: action.payload.roomId },
        channelUnreadCounts: {
          ...state.channelUnreadCounts,
          [channelId]: (state.channelUnreadCounts[channelId] || 0) + 1,
        },
        channelLatestUnreadTs:
          ts === undefined
            ? latest
            : { ...latest, [channelId]: Math.max(latest[channelId] || 0, ts) },
      });
    }
    case "SET_NOTIFICATION_SETTINGS":
      return { ...state, notificationSettings: action.payload };
    case "SET_CHANNEL_THREADS":
      return { ...state, channelThreads: action.payload };
    case "THREAD_ACTIVITY": {
      // Applied live rather than refetched: the broadcast already carries
      // everything a preview row needs.
      const preview = action.payload;
      const existing = state.channelThreads[preview.channelId] ?? [];
      const merged = [preview, ...existing.filter((t) => t.threadId !== preview.threadId)]
        .sort((a, b) => b.lastActivityTs - a.lastActivityTs)
        .slice(0, THREAD_PREVIEW_LIMIT);
      return {
        ...state,
        channelThreads: { ...state.channelThreads, [preview.channelId]: merged },
      };
    }
    case "SET_CONTINUITY":
      return { ...state, drafts: action.payload.drafts };
    case "SET_DRAFT": {
      const key = `${action.payload.roomId}|${action.payload.channelId}`;
      const next = { ...state.drafts };
      // An empty draft is the absence of one, matching what the server stores.
      if (action.payload.text.trim() === "") delete next[key];
      else next[key] = action.payload.text;
      return { ...state, drafts: next };
    }
    case "SET_NOTIFICATION_LEVEL": {
      const key = `${action.payload.roomId}|${action.payload.channelId}`;
      const next = { ...state.notificationSettings };
      // "default" is the absence of an override, not a stored value.
      if (action.payload.level === "default") delete next[key];
      else next[key] = action.payload.level;
      return { ...state, notificationSettings: next };
    }
    // Server-computed unreads replace the in-memory tallies wholesale — they are
    // authoritative, and a partial merge would double-count anything the client
    // had already counted this session.
    case "SET_UNREADS":
      return withRoomUnreads({
        ...state,
        ...bucketsFromServer(action.payload, {
          roomId: state.currentRoomId,
          channelId: state.currentChannelId,
        }),
      });
    // Server-computed unread mentions replace the session's tallies wholesale,
    // same as the counts above: they are authoritative and a merge would
    // double-count whatever this client already saw.
    case "SET_THREAD_MENTIONS": {
      const threadMentions: Record<string, number> = {};
      for (const entry of action.payload) {
        if (entry.mentions > 0) threadMentions[entry.thread_id] = entry.mentions;
      }
      return { ...state, threadMentions };
    }
    // Another device (or this one) read a bucket. The counts are what is
    // *left* after the point read, so a message that landed since stays
    // unread, and they replace only that one bucket — the rest of the
    // user's unreads are untouched. Like SET_UNREADS, the bucket on screen
    // is left alone: it is being read here, whatever the marker says.
    case "APPLY_READ_MARKER": {
      const u = action.payload;
      if ("threadId" in u) {
        if (state.activeThreadEventId === u.threadId) return state;
        return {
          ...state,
          threadMentions: { ...state.threadMentions, [u.threadId]: u.mentions },
        };
      }
      const viewing =
        u.roomId === state.currentRoomId && (u.channelId || null) === state.currentChannelId;
      if (viewing) return state;
      if (!u.channelId) {
        return withRoomUnreads({
          ...state,
          roomLooseUnreads: { ...state.roomLooseUnreads, [u.roomId]: u.count },
          roomLooseMentions: { ...state.roomLooseMentions, [u.roomId]: u.mentions },
        });
      }
      return withRoomUnreads({
        ...state,
        channelRoomIds: { ...state.channelRoomIds, [u.channelId]: u.roomId },
        channelUnreadCounts: { ...state.channelUnreadCounts, [u.channelId]: u.count },
        channelMentions: { ...state.channelMentions, [u.channelId]: u.mentions },
        channelLatestUnreadTs: { ...state.channelLatestUnreadTs, [u.channelId]: u.latestTs },
      });
    }
    case "CLEAR_CHANNEL_UNREAD":
      return withRoomUnreads({
        ...state,
        channelUnreadCounts: { ...state.channelUnreadCounts, [action.payload]: 0 },
        channelMentions: { ...state.channelMentions, [action.payload]: 0 },
        channelLatestUnreadTs: { ...state.channelLatestUnreadTs, [action.payload]: 0 },
      });
    // The room's loose bucket only — what has no channel. Its channels are
    // cleared one by one as they are read.
    case "INCREMENT_ROOM_UNREAD":
      return withRoomUnreads({
        ...state,
        roomLooseUnreads: {
          ...state.roomLooseUnreads,
          [action.payload]: (state.roomLooseUnreads[action.payload] || 0) + 1,
        },
      });
    case "CLEAR_ROOM_UNREAD":
      return withRoomUnreads({
        ...state,
        roomLooseUnreads: { ...state.roomLooseUnreads, [action.payload]: 0 },
        roomLooseMentions: { ...state.roomLooseMentions, [action.payload]: 0 },
      });
    case "UPDATE_DM_STREAK": {
      const existing = state.roomInfoMap[action.payload.roomId];
      if (!existing) return state;
      return {
        ...state,
        roomInfoMap: {
          ...state.roomInfoMap,
          [action.payload.roomId]: {
            ...existing,
            dm_streak_count: action.payload.streakCount,
            dm_streak_last_ts: action.payload.lastMessageTs,
          },
        },
      };
    }
    default:
      return state;
  }
}
