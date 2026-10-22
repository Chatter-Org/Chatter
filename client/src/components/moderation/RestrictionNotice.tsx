import { useEffect } from "react";
import { Clock, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/lib/store";
import { formatTimeoutEnd } from "./moderationUtils";

/**
 * What stands in for the composer while the user cannot take part: a timeout,
 * or rules they have not accepted. Null when neither holds, so the caller
 * falls through to its usual checks.
 */
export function RestrictionNotice({ onShowRules }: { onShowRules: () => void }) {
  const { state, loadMyPermissions } = useAppContext();
  const restriction = state.myRestriction;
  const timeoutUntil = restriction?.timeoutUntil ?? 0;
  const roomId = state.currentRoomId;
  const channelId = state.currentChannelId;

  // A timeout ends without anything being broadcast, so the client asks again
  // when it is due rather than waiting for the next room switch.
  useEffect(() => {
    if (!roomId || timeoutUntil <= 0) return;
    const wait = Math.max(0, timeoutUntil - Date.now()) + 1000;
    // setTimeout caps out near 24.8 days; a longer wait would fire at once.
    if (wait > 2_000_000_000) return;
    const timer = setTimeout(() => void loadMyPermissions(roomId, channelId), wait);
    return () => clearTimeout(timer);
  }, [roomId, channelId, timeoutUntil, loadMyPermissions]);

  // The server reports 0 once a timeout has ended, and the effect above asks
  // it again when that is due, so any nonzero value here is in force.
  if (timeoutUntil > 0) {
    return (
      <div className="border-t p-3 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Clock className="h-4 w-4 shrink-0" />
        You are timed out until {formatTimeoutEnd(timeoutUntil)}. You can read, but not post, react or speak.
      </div>
    );
  }
  if (restriction?.rulesPending) {
    return (
      <div className="border-t p-3 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
        <ScrollText className="h-4 w-4 shrink-0" />
        Read and accept this room&apos;s rules to start chatting.
        <Button size="sm" variant="outline" className="h-7" onClick={onShowRules}>
          View rules
        </Button>
      </div>
    );
  }
  return null;
}
