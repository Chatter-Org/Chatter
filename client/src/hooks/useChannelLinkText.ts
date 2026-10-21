import { useCallback, useMemo } from "react";
import { useAppContext } from "@/lib/store";
import { plainChannelLinks, visibleChannels } from "@/lib/channelLinks";

/** A body as plain text for a preview row, its `<#channel>` links read as this
 *  user sees them: `#name`, or `#unknown` for a channel they cannot see. */
export function useChannelLinkText(): (body: string) => string {
  const { state } = useAppContext();
  const channels = useMemo(
    () => visibleChannels(state),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.channels, state.userId, state.roomMembers, state.customRoles, state.memberCustomRoles],
  );
  return useCallback((body: string) => plainChannelLinks(body, channels), [channels]);
}
