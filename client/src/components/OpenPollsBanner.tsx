import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/lib/store";
import { apiGetOpenPolls, type MatrixMessage, type OpenPoll } from "@/lib/api";
import { remainingLabel } from "@/lib/polls";
import { BarChart3 } from "lucide-react";

/**
 * A strip under the channel header naming the polls that are still running and
 * that the reader has not answered.
 *
 * A poll is a message, so a busy channel buries it like any other. This is the
 * one place a poll is lifted out of the timeline, and only for as long as it
 * asks something of this reader: it goes away when they vote, when it ends, or
 * when the poll is deleted. It takes no room otherwise.
 *
 * The list is fetched when the channel opens and then kept by what the socket
 * already delivers — a new poll arrives as a message, and votes and endings
 * arrive in `state.polls` — so nothing here polls the server.
 */
export function OpenPollsBanner({ onJump }: { onJump: (msg: MatrixMessage) => void }) {
  const { state } = useAppContext();
  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId ?? "";
  const me = state.userId ?? "";
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

  // The countdown is the only thing that moves without a message, and a
  // minute is as fine as it is drawn.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const open = useMemo(() => {
    const byId = new Map<string, OpenPoll>();
    for (const p of fetched) byId.set(p.poll_id, p);
    // A poll posted while the channel is open is in the timeline, not the fetch.
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
      .filter((p) => {
        const live = state.polls[p.poll_id] ?? p.poll;
        if (live?.closed || p.ends_at <= now) return false;
        return !live?.voters.some((v) => v.includes(me));
      })
      .sort((a, b) => b.created_at - a.created_at);
  }, [fetched, state.messages, state.polls, me, now]);

  if (open.length === 0) return null;
  const first = open[0];
  const jump = (p: OpenPoll) =>
    onJump({
      event_id: p.poll_id,
      channel_id: p.channel_id || undefined,
      origin_server_ts: p.created_at,
    } as MatrixMessage);

  return (
    <button
      type="button"
      onClick={() => jump(first)}
      title="Go to the poll"
      className="flex w-full items-center gap-2 border-b border-border bg-primary/10 px-4 py-1.5 text-left text-sm shrink-0 hover:bg-primary/15 transition-colors cursor-pointer"
    >
      <BarChart3 className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{first.question}</span>
        <span className="text-muted-foreground"> · {remainingLabel(first.ends_at, now)}</span>
      </span>
      {open.length > 1 && (
        <span className="shrink-0 text-xs text-muted-foreground">+{open.length - 1} more</span>
      )}
      <span className="shrink-0 text-xs font-medium text-primary">Vote</span>
    </button>
  );
}
