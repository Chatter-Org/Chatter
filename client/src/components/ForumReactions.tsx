import { useState } from "react";
import { SmilePlus } from "lucide-react";
import { useAppContext } from "@/lib/store";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, displayUserId } from "@/lib/utils";

function isCustomEmojiUrl(s: string) {
  return s.startsWith("/") || s.startsWith("http");
}

/**
 * The reactions on a forum post or reply and the button that adds one, shared
 * by the card in the list, the open post and every reply so they cannot
 * disagree.
 *
 * A post's or reply's id is its reaction key, so it rides the same machinery
 * as a message: the store's `messageReactions` is what the `m.reaction`
 * broadcast updates, and is read in preference to the reactions the target
 * was fetched with. Without that, a reaction reached only the person who made
 * it.
 */
export function ForumReactions({
  targetId,
  initial,
  compact = false,
  revealAdd = false,
}: {
  /** The post id or comment id reacted to. */
  targetId: string;
  /** What the target arrived carrying from its fetch. */
  initial?: Record<string, string[]>;
  compact?: boolean;
  /** Show the add button only on hover where hovering exists — for replies,
   *  where a button on every one of them would be clutter. */
  revealAdd?: boolean;
}) {
  const { state, addReaction } = useAppContext();
  const [pickerOpen, setPickerOpen] = useState(false);
  const live = state.messageReactions[targetId];
  const reactions = live ?? initial ?? {};
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);

  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;

  // The optimistic toggle starts from the store's entry, or from what the
  // post arrived carrying, or the first click would wipe the others.
  const toggle = (emoji: string) => addReaction(targetId, emoji, reactions);

  return (
    // A card is one big button; nothing in here should open the post.
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {entries.map(([emoji, userIds]) => (
        <Tooltip key={emoji}>
          <TooltipTrigger asChild>
            <button
              onClick={() => toggle(emoji)}
              className={cn(
                // The same chip as a chat message's reactions.
                "inline-flex items-center gap-1 rounded-lg border transition-colors cursor-pointer",
                compact ? "h-6 px-1.5 text-xs" : "h-7 px-2 text-sm",
                userIds.includes(state.userId ?? "")
                  ? "border-ring/60 bg-ring/15 hover:bg-ring/25"
                  : "border-transparent bg-secondary/70 hover:border-border hover:bg-secondary",
              )}
            >
              {isCustomEmojiUrl(emoji) ? (
                <img
                  src={emoji}
                  alt="emoji"
                  className={cn("inline-block object-contain", compact ? "h-3 w-3" : "h-4 w-4")}
                />
              ) : (
                emoji
              )}
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">{userIds.length}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {userIds.map((id) => (
              <p key={id}>{state.userPresence[id]?.displayName || displayUserId(id)}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      ))}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            title="Add reaction"
            aria-label="Add reaction"
            className={cn(
              "inline-flex items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer",
              compact ? "h-6 w-7" : "h-7 w-8",
              revealAdd && !pickerOpen && "can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <SmilePlus className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <EmojiPicker
            onSelect={(emoji) => {
              toggle(emoji);
              setPickerOpen(false);
            }}
            roomCustomEmojis={roomInfo?.custom_emojis ?? []}
            emojiAliases={roomInfo?.emoji_aliases ?? {}}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
