import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Clock, ScrollText } from "lucide-react-native";
import { apiAcceptRules } from "@chatter/core/api";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { Icon, T } from "@/ui/primitives";
import { Button } from "@/ui/controls";
import { Sheet } from "@/ui/Sheet";

/** "3:45 PM", or "Oct 24, 3:45 PM" when it is not today. As on the web. */
function formatTimeoutEnd(ts: number): string {
  const end = new Date(ts);
  const sameDay = end.toDateString() === new Date().toDateString();
  return end.toLocaleString(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Whether the composer should give way to `RestrictionBar`. */
export function isRestricted(restriction: { timeoutUntil: number; rulesPending: boolean } | null): boolean {
  return !!restriction && (restriction.rulesPending || restriction.timeoutUntil > 0);
}

/**
 * What stands in for the composer while the user cannot take part — the web's
 * RestrictionNotice: a timeout, or the room's rules waiting to be accepted,
 * with a sheet to read and accept them.
 */
export function RestrictionBar({ bottomInset }: { bottomInset: number }) {
  const state = useChatter();
  const actions = useChatterActions();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId;
  const restriction = state.myRestriction;
  const timeoutUntil = restriction?.timeoutUntil ?? 0;
  const rules = roomId ? (state.roomInfoMap[roomId]?.moderation?.rules ?? "") : "";

  // A timeout ends without anything being broadcast, so ask again when due.
  useEffect(() => {
    if (!roomId || timeoutUntil <= 0) return;
    const wait = Math.max(0, timeoutUntil - Date.now()) + 1000;
    if (wait > 2_000_000_000) return;
    const timer = setTimeout(() => void actions.loadMyPermissions(roomId, channelId), wait);
    return () => clearTimeout(timer);
  }, [roomId, channelId, timeoutUntil, actions]);

  const accept = async () => {
    if (!roomId) return;
    setAccepting(true);
    try {
      await apiAcceptRules(roomId);
      await actions.loadMyPermissions(roomId, channelId);
      setRulesOpen(false);
    } catch (e) {
      showToast({ message: e instanceof Error ? e.message : "Failed to accept the rules", tone: "error" });
    } finally {
      setAccepting(false);
    }
  };

  return (
    <View className="border-t border-border bg-background p-3" style={{ paddingBottom: Math.max(12, bottomInset) }}>
      {timeoutUntil > 0 ? (
        <View className="flex-row items-center justify-center gap-2">
          <Icon as={Clock} size={15} />
          <T className="shrink text-center text-sm text-muted-foreground">
            You are timed out until {formatTimeoutEnd(timeoutUntil)}. You can read, but not post, react or speak.
          </T>
        </View>
      ) : (
        <View className="flex-row flex-wrap items-center justify-center gap-2">
          <Icon as={ScrollText} size={15} />
          <T className="text-sm text-muted-foreground">Accept this room&apos;s rules to start chatting.</T>
          <Button size="sm" variant="outline" onPress={() => setRulesOpen(true)}>
            View rules
          </Button>
        </View>
      )}
      <Sheet open={rulesOpen} onClose={() => setRulesOpen(false)} title="Room rules">
        <View className="gap-3 px-4 pb-2 pt-1">
          <ScrollView className="max-h-96 rounded-md border border-border bg-muted/20 p-3">
            <T className="text-sm leading-5">{rules || "This room has no rules."}</T>
          </ScrollView>
          <View className="flex-row justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={() => setRulesOpen(false)}>
              Not now
            </Button>
            <Button size="sm" onPress={() => void accept()} disabled={accepting}>
              {accepting ? "…" : "I agree"}
            </Button>
          </View>
        </View>
      </Sheet>
    </View>
  );
}
