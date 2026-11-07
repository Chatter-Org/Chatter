import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetOpenPolls, type OpenPoll } from "@/lib/api";

/**
 * The polls still running in the open channel, newest first.
 *
 * Fetched when the channel opens, then kept by what the socket already
 * delivers: a new poll arrives as a message, votes and endings in
 * `state.polls`. Shared by the banner and by the composer, which stops
 * offering a poll when the channel is full.
 */
export function useOpenPolls(): OpenPoll[] {
  const { state } = useAppContext();
  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId ?? "";
  const [fetched, setFetched] = useState<OpenPoll[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setFetched([]);
    if (!roomId) return;
    let live = true;
    apiGetOpenPolls(roomId, channelId || undefined)
      .then(({ polls }) => live && setFetched(polls))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [roomId, channelId]);

  // The clock running out is the one change that arrives without a message.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  return useMemo(() => {
    const byId = new Map<string, OpenPoll>();
    for (const p of fetched) byId.set(p.poll_id, p);
    for (const m of state.messages) {
      const c = m.content;
      if (c?.msgtype !== "m.poll" || !c.poll_id || byId.has(c.poll_id)) continue;
      byId.set(c.poll_id, {
        poll_id: c.poll_id,
        question: c.question ?? "",
        channel_id: m.channel_id ?? "",
        creator: m.sender,
        created_at: m.origin_server_ts,
        ends_at: c.ends_at ?? 0,
        poll: null,
      });
    }
    return [...byId.values()]
      .filter((p) => !(state.polls[p.poll_id] ?? p.poll)?.closed && p.ends_at > now)
      .sort((a, b) => b.created_at - a.created_at);
  }, [fetched, state.messages, state.polls, now]);
}
