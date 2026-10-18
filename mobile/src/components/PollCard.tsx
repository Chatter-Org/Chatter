import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { BarChart3, Check, ChevronDown } from "lucide-react-native";
import type { MatrixMessage } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { canManageMessages } from "@chatter/core/permissions";
import { remainingLabel, sharePercent, voteLabel, voterLabel, winningIndexes } from "@chatter/core/polls";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { Tap } from "./Tap";

/**
 * Polls in the timeline — the web's PollCard and PollResultsCard: the
 * question, an answer per row with its bar behind it, and who voted for it a
 * tap away. The controls are Taps, since a poll sits inside a message row
 * whose own gestures would take a Pressable's touch.
 */

function OptionRow({
  label,
  count,
  percent,
  chosen,
  winner,
  voters,
  onPress,
  disabled,
}: {
  label: string;
  count: number;
  percent: number;
  chosen: boolean;
  winner: boolean;
  voters: string[];
  onPress?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const inner = (
    <>
      <View
        className={cn(
          "size-4 items-center justify-center rounded-full border",
          chosen ? "border-primary bg-primary" : "border-muted-foreground/40",
        )}
      >
        {chosen ? <Icon as={Check} size={11} tone="primary-foreground" /> : null}
      </View>
      <T className={cn("min-w-0 flex-1 text-[14.3px]", winner && "font-medium")}>{label}</T>
      <T className="text-xs text-muted-foreground">
        {percent}% · {count}
      </T>
    </>
  );
  const row = "flex-1 flex-row items-center gap-2 px-2.5 py-2";
  return (
    <View className={cn("overflow-hidden rounded-md border", chosen ? "border-primary/60" : "border-border")}>
      <View className="flex-row items-stretch">
        <View
          pointerEvents="none"
          className={cn("absolute bottom-0 left-0 top-0", winner ? "bg-primary/25" : "bg-muted-foreground/15")}
          style={{ width: `${percent}%` }}
        />
        {onPress ? (
          <Tap onPress={onPress} disabled={disabled} selected={chosen} label={`${label}, ${percent}%`} className={cn(row, disabled && "opacity-70")}>
            {inner}
          </Tap>
        ) : (
          <View className={row}>{inner}</View>
        )}
        {voters.length > 0 ? (
          <Tap
            onPress={() => setOpen((v) => !v)}
            label={`${open ? "Hide" : "Show"} the ${voters.length} who voted for ${label}`}
            className="items-center justify-center border-l border-border/60 px-2"
          >
            <View style={open ? { transform: [{ rotate: "180deg" }] } : undefined}>
              <Icon as={ChevronDown} size={14} />
            </View>
          </Tap>
        ) : null}
      </View>
      {open ? (
        <View className="border-t border-border/60 bg-muted/30 px-2.5 py-1.5">
          <T className="text-xs text-muted-foreground">{voters.join(", ")}</T>
        </View>
      ) : null}
    </View>
  );
}

function CardShell({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <View className="mt-1 rounded-lg border border-border bg-card/60 p-3">
      <View className="mb-2 flex-row items-start gap-2">
        <View className="mt-0.5">
          <Icon as={BarChart3} size={16} />
        </View>
        <T className="min-w-0 flex-1 text-[14.3px] font-medium leading-snug">{title}</T>
      </View>
      <View className="gap-1.5">{children}</View>
      <View className="mt-2 flex-row flex-wrap items-center gap-x-2 gap-y-1">{footer}</View>
    </View>
  );
}

function Foot({ children, className }: { children: ReactNode; className?: string }) {
  return <T className={cn("text-xs text-muted-foreground", className)}>{children}</T>;
}

export function PollCard({ message }: { message: MatrixMessage }) {
  const state = useChatter();
  const { votePoll, closePoll, loadPoll } = useChatterActions();
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const pollId = message.content.poll_id ?? message.event_id;
  const question = message.content.question ?? message.content.body ?? "";
  const options = useMemo(() => message.content.options ?? [], [message.content.options]);
  const live = state.polls[pollId];

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // A card from a pin or a search, or a page loaded before the poll existed,
  // has no state yet; ask once.
  useEffect(() => {
    if (!live) void loadPoll(pollId).catch(() => {});
  }, [live, pollId, loadPoll]);

  const voters = live?.voters ?? options.map(() => []);
  const counts = voters.map((v) => v.length);
  const totalVoters = live?.total_voters ?? 0;
  const endsAt = live?.ends_at ?? message.content.ends_at ?? 0;
  const multiSelect = live?.multi_select ?? message.content.multi_select ?? false;
  // Closed by the flag or by the clock: the server sweeps on a tick.
  const closed = (live?.closed ?? false) || (endsAt > 0 && now >= endsAt);

  const me = state.userId ?? "";
  const myVotes = voters.flatMap((list, index) => (list.includes(me) ? [index] : []));
  const winners = closed ? winningIndexes(counts) : [];
  const canEndEarly = !closed && (live?.creator === me || canManageMessages(state));
  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);

  const cast = async (index: number) => {
    if (closed || pending) return;
    // Sent whole: a single-answer poll replaces, a multi-answer one toggles,
    // and your own answer again takes it back.
    const next = multiSelect
      ? myVotes.includes(index)
        ? myVotes.filter((i) => i !== index)
        : [...myVotes, index]
      : myVotes.includes(index)
        ? []
        : [index];
    setPending(true);
    try {
      await votePoll(pollId, next);
    } catch (err) {
      showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not save your vote" });
    } finally {
      setPending(false);
    }
  };

  const endNow = async () => {
    setPending(true);
    try {
      await closePoll(pollId);
    } catch (err) {
      showToast({ tone: "error", message: err instanceof Error ? err.message : "Could not end the poll" });
    } finally {
      setPending(false);
    }
  };

  return (
    <CardShell
      title={question}
      footer={
        <>
          <Foot>{voterLabel(totalVoters)}</Foot>
          <Foot>·</Foot>
          <Foot>{closed ? "Final results" : remainingLabel(endsAt, now)}</Foot>
          {multiSelect && !closed ? (
            <>
              <Foot>·</Foot>
              <Foot>Pick as many as you like</Foot>
            </>
          ) : null}
          {pending ? <ActivityIndicator size="small" /> : null}
          {canEndEarly ? (
            <View className="ml-auto">
              <Tap onPress={() => void endNow()} disabled={pending} label="End the poll now" className="rounded px-1 py-0.5">
                <Foot className="underline">End now</Foot>
              </Tap>
            </View>
          ) : null}
        </>
      }
    >
      {options.map((option, index) => (
        <OptionRow
          key={index}
          label={option}
          count={counts[index] ?? 0}
          percent={sharePercent(counts[index] ?? 0, totalVoters)}
          chosen={myVotes.includes(index)}
          winner={winners.includes(index)}
          voters={(voters[index] ?? []).map(nameOf)}
          onPress={closed ? undefined : () => void cast(index)}
          disabled={pending}
        />
      ))}
    </CardShell>
  );
}

/** The message posted when a poll ends: drawn from its own content alone. */
export function PollResultsCard({ message }: { message: MatrixMessage }) {
  const state = useChatter();
  const question = message.content.question ?? message.content.body ?? "";
  const options = message.content.options ?? [];
  const counts = message.content.counts ?? [];
  const voters = message.content.voters ?? [];
  const totalVoters = message.content.total_voters ?? 0;
  const winners = winningIndexes(counts);
  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);

  return (
    <CardShell
      title={question}
      footer={
        <>
          <Foot className="font-medium text-foreground/80">Poll closed</Foot>
          <Foot>·</Foot>
          <Foot>{voterLabel(totalVoters)}</Foot>
          {winners.length > 1 ? (
            <>
              <Foot>·</Foot>
              <Foot>Tied at {voteLabel(counts[winners[0]] ?? 0)}</Foot>
            </>
          ) : null}
        </>
      }
    >
      {options.map((option, index) => (
        <OptionRow
          key={index}
          label={option}
          count={counts[index] ?? 0}
          percent={sharePercent(counts[index] ?? 0, totalVoters)}
          chosen={false}
          winner={winners.includes(index)}
          voters={(voters[index] ?? []).map(nameOf)}
        />
      ))}
    </CardShell>
  );
}
