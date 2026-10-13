import { useState, type ReactElement } from "react";
import { HoverCard } from "radix-ui";
import { useScreenThumbnail } from "@/hooks/useScreenShareThumbnails";
import { LivePill } from "./LivePill";

/** Hovering a sharer shows a still of what they have on screen, for a viewer
 *  who is not in their call (`peekableSharers` decides who; anyone else has no
 *  still in the map, so this draws nothing for them).
 *
 *  The root is always rendered and only the card is conditional: wrapping the
 *  row only once a still arrives would remount it, closing any menu open on it.
 *  A hover card never opens on touch, which is right — a still nobody can
 *  reach is better than one stuck open over the list. */
export function ScreenPeek({
  userId,
  name,
  side = "right",
  children,
}: {
  userId: string;
  name: string;
  side?: "left" | "right";
  children: ReactElement;
}) {
  const thumbnail = useScreenThumbnail(userId);
  const [open, setOpen] = useState(false);

  return (
    <HoverCard.Root open={open && !!thumbnail} onOpenChange={setOpen} openDelay={200} closeDelay={50}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      {thumbnail && (
        <HoverCard.Portal>
          <HoverCard.Content
            side={side}
            align="center"
            sideOffset={8}
            collisionPadding={8}
            className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg animate-in fade-in-0 zoom-in-95"
          >
            <img
              src={thumbnail}
              alt={`${name}'s screen`}
              className="block max-h-40 max-w-64 rounded-sm"
            />
            <div className="flex items-center gap-1.5 px-1 pt-1 text-xs text-muted-foreground">
              <LivePill />
              <span className="truncate">{name}'s screen</span>
            </div>
          </HoverCard.Content>
        </HoverCard.Portal>
      )}
    </HoverCard.Root>
  );
}
