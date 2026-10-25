import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ForumMarkdown } from "@/components/ForumMarkdown";
import { apiAcceptRules } from "@/lib/api";
import { useAppContext } from "@/lib/store";
import { onShowRoomRules } from "./moderationUtils";

/**
 * The current room's rules. While the user still has to accept them it asks
 * for that, and opens by itself once per room visit so nobody has to find it.
 * Mounted once, in the layout, so every kind of room is covered.
 */
export function RulesDialog() {
  const { state, loadMyPermissions } = useAppContext();
  const [open, onOpenChange] = useState(false);
  useEffect(() => onShowRoomRules(() => onOpenChange(true)), []);
  const roomId = state.currentRoomId;
  const info = roomId ? state.roomInfoMap[roomId] : undefined;
  const rules = info?.moderation?.rules ?? "";
  const pending = !!state.myRestriction?.rulesPending;
  const [accepting, setAccepting] = useState(false);

  // Shown unasked the first time the gate is met in a room, not every time
  // the restriction is refetched — closing it is an answer too.
  const promptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!roomId || !pending || !rules) return;
    if (promptedFor.current === roomId) return;
    promptedFor.current = roomId;
    onOpenChange(true);
  }, [roomId, pending, rules]);

  const accept = async () => {
    if (!roomId) return;
    setAccepting(true);
    try {
      await apiAcceptRules(roomId);
      await loadMyPermissions(roomId, state.currentChannelId);
      onOpenChange(false);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to accept the rules");
    } finally {
      setAccepting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{info?.name ? `${info.name} rules` : "Room rules"}</DialogTitle>
          {pending && (
            <DialogDescription>
              Read these before you start chatting. You can read the room in the meantime.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60 bg-muted/20 p-3">
          {rules ? (
            <ForumMarkdown content={rules} className="text-sm" />
          ) : (
            <p className="text-sm text-muted-foreground">This room has no rules.</p>
          )}
        </div>
        <DialogFooter className="shrink-0">
          {pending ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Not now
              </Button>
              <Button onClick={accept} disabled={accepting}>
                {accepting ? "…" : "I agree"}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
