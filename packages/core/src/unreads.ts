/**
 * Room-level unread state is *derived*, never kept beside the channel-level
 * state it summarises.
 *
 * It used to be two tallies maintained side by side from different events,
 * and they drifted: opening a room zeroed its mention badge while the channel
 * that held the mention was still unread, so leaving again showed a clean room
 * with a ping hidden inside it; a message in another channel of the room on
 * screen bumped the channel and never the room. Summing the buckets means the
 * room can only ever say what its channels say.
 *
 * A bucket is either a channel (`channelUnreadCounts`, keyed by channel_id,
 * with `channelRoomIds` naming the room it belongs to — a channel of a room
 * that is not open has no other record of whose it is) or a room's *loose*
 * bucket: what has no channel to sit in — a DM's messages, a forum post, a
 * reply in a thread you are part of.
 */

export interface UnreadBuckets {
  channelUnreadCounts: Record<string, number>;
  channelMentions: Record<string, number>;
  channelRoomIds: Record<string, string>;
  roomLooseUnreads: Record<string, number>;
  roomLooseMentions: Record<string, number>;
}

export interface RoomUnreads {
  roomUnreadCounts: Record<string, number>;
  roomMentions: Record<string, number>;
}

function addInto(into: Record<string, number>, key: string, n: number) {
  if (n > 0) into[key] = (into[key] || 0) + n;
}

export function deriveRoomUnreads(b: UnreadBuckets): RoomUnreads {
  const roomUnreadCounts: Record<string, number> = {};
  const roomMentions: Record<string, number> = {};
  for (const [channelId, count] of Object.entries(b.channelUnreadCounts)) {
    const roomId = b.channelRoomIds[channelId];
    if (roomId) addInto(roomUnreadCounts, roomId, count);
  }
  for (const [channelId, count] of Object.entries(b.channelMentions)) {
    const roomId = b.channelRoomIds[channelId];
    if (roomId) addInto(roomMentions, roomId, count);
  }
  for (const [roomId, count] of Object.entries(b.roomLooseUnreads)) {
    addInto(roomUnreadCounts, roomId, count);
  }
  for (const [roomId, count] of Object.entries(b.roomLooseMentions)) {
    addInto(roomMentions, roomId, count);
  }
  // A mention is a message, so a room with a ping is never "read". Without
  // this a mention that arrived with no unread beside it (a forum mention, a
  // thread reply) would draw a red badge on a room with no unread dot.
  for (const [roomId, mentions] of Object.entries(roomMentions)) {
    if ((roomUnreadCounts[roomId] || 0) < mentions) roomUnreadCounts[roomId] = mentions;
  }
  return { roomUnreadCounts, roomMentions };
}

/** One row of `GET /api/unreads`. */
export interface ServerUnread {
  room_id: string;
  channel_id: string;
  count: number;
  mentions: number;
  latest_ts?: number;
}

/** The `read_marker` broadcast: one bucket's remaining unread after a read on
 *  any of the user's devices. A thread names `threadId` and only mentions. */
export type ReadMarkerUpdate =
  | {
      roomId: string;
      channelId: string;
      count: number;
      mentions: number;
      latestTs: number;
    }
  | { roomId: string; threadId: string; mentions: number };

/**
 * The buckets the server's counts describe. They replace the session's tallies
 * wholesale — they are authoritative, and a merge would double-count anything
 * already counted live.
 *
 * The channel being read is left out: the server counts against the stored
 * marker, which trails the screen by a debounce, so a refetch landing in that
 * window would mark the very channel on screen unread — and since its row is
 * the selected one, nobody would see it until they left and found the room
 * still lit.
 */
export function bucketsFromServer(
  rows: ServerUnread[],
  viewing: { roomId: string | null; channelId: string | null },
): UnreadBuckets & { channelLatestUnreadTs: Record<string, number> } {
  const out = {
    channelUnreadCounts: {} as Record<string, number>,
    channelMentions: {} as Record<string, number>,
    channelLatestUnreadTs: {} as Record<string, number>,
    channelRoomIds: {} as Record<string, string>,
    roomLooseUnreads: {} as Record<string, number>,
    roomLooseMentions: {} as Record<string, number>,
  };
  for (const row of rows) {
    const isViewing =
      row.room_id === viewing.roomId && (row.channel_id || null) === viewing.channelId;
    if (isViewing || row.count <= 0) continue;
    if (row.channel_id) {
      out.channelRoomIds[row.channel_id] = row.room_id;
      out.channelUnreadCounts[row.channel_id] = row.count;
      if (row.mentions > 0) out.channelMentions[row.channel_id] = row.mentions;
      if (row.latest_ts) out.channelLatestUnreadTs[row.channel_id] = row.latest_ts;
    } else {
      addInto(out.roomLooseUnreads, row.room_id, row.count);
      addInto(out.roomLooseMentions, row.room_id, row.mentions);
    }
  }
  return out;
}

/** The fields `oldestUnreadEventId` reads off a timeline message. */
interface CountedMessage {
  event_id: string;
  sender: string;
  redacted?: boolean;
  content?: { msgtype?: string };
}

/**
 * The message the unread divider goes above: the oldest of the newest
 * `count` messages that were counted as unread. It walks back counting only
 * what the unread tally counts — someone else's, not a system line, not
 * deleted — because the timeline also holds the reader's own replies, and
 * stepping back `count` rows put the line too low by every one of them.
 *
 * `null` while the oldest unread is older than what is loaded: a line on the
 * top loaded message would claim the backlog starts there.
 */
export function oldestUnreadEventId(
  messages: CountedMessage[],
  count: number,
  me: string | null,
): string | null {
  if (count <= 0) return null;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.sender === me || m.redacted || m.content?.msgtype === "m.system") continue;
    seen += 1;
    if (seen === count) return m.event_id;
  }
  return null;
}
