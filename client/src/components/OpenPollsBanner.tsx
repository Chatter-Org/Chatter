import { useAppContext } from "@/lib/store";
import type { MatrixMessage, OpenPoll } from "@/lib/api";
import { remainingLabel } from "@/lib/polls";
import { BarChart3 } from "lucide-react";

/**
 * A strip under the channel header naming the running polls the reader has
 * not answered yet, one row each (a channel runs at most three), each jumping
 * to its own message.
 *
 * A poll is a message, so a busy channel buries it like any other. This lifts
 * it out only while it asks something of this reader: a row goes away when
 * they vote, when the poll ends, or when it is deleted.
 */
export function OpenPollsBanner({
  polls,
  onJump,
}: {
  polls: OpenPoll[];
  onJump: (msg: MatrixMessage) => void;
}) {
  const { state } = useAppContext();
  const me = state.userId ?? "";
  const unanswered = polls.filter(
    (p) => !(state.polls[p.poll_id] ?? p.poll)?.voters.some((v) => v.includes(me)),
  );
  if (unanswered.length === 0) return null;

  return (
    <div className="flex flex-col border-b border-border bg-primary/10 shrink-0">
      {unanswered.map((p) => (
        <button
          key={p.poll_id}
          type="button"
          onClick={() =>
            onJump({
              event_id: p.poll_id,
              channel_id: p.channel_id || undefined,
              origin_server_ts: p.created_at,
            } as MatrixMessage)
          }
          title="Go to the poll"
          className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-primary/15 transition-colors cursor-pointer"
        >
          <BarChart3 className="h-4 w-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{p.question}</span>
            <span className="text-muted-foreground"> · {remainingLabel(p.ends_at)}</span>
          </span>
          <span className="shrink-0 text-xs font-medium text-primary">Vote</span>
        </button>
      ))}
    </div>
  );
}
