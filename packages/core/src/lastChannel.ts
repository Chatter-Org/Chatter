/**
 * The channel a reader last had open in each room, kept across a refresh.
 *
 * `lastChannelByRoom` in the store already lands a room switch where the
 * reader left off, but it lived only in memory, so the first visit to every
 * room after a reload went to the room's first channel instead. This is that
 * map, saved per browser and per account: per browser like the channel
 * column's width, and per account so two people sharing a machine do not land
 * in each other's channels.
 */

const STORAGE_PREFIX = "chatter_last_channel:";

function keyFor(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function loadLastChannels(userId: string | null): Record<string, string> {
  if (!userId) return {};
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [roomId, channelId] of Object.entries(parsed)) {
      if (typeof channelId === "string" && channelId) out[roomId] = channelId;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge rather than replace: this session may not have visited every room
 *  the stored map knows about, and those answers are still right. */
export function saveLastChannels(userId: string | null, map: Record<string, string>): void {
  if (!userId || Object.keys(map).length === 0) return;
  try {
    const merged = { ...loadLastChannels(userId), ...map };
    localStorage.setItem(keyFor(userId), JSON.stringify(merged));
  } catch {
    // Storage blocked or full: the in-memory map still covers this session.
  }
}

/**
 * Which channel opening a room should land on: the remembered one when it
 * still exists and can be opened without side effects, else the room's first
 * text channel. A voice channel is never restored — opening one joins the
 * call, which nobody asked for by switching rooms.
 */
export function pickLandingChannel<C extends { channel_id: string; channel_type?: string }>(
  channels: C[],
  remembered: string | undefined,
): C | undefined {
  const match = remembered
    ? channels.find((c) => c.channel_id === remembered && c.channel_type !== "voice")
    : undefined;
  return match ?? channels.find((c) => c.channel_type === "text");
}
