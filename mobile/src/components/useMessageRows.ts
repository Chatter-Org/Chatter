import { useCallback, useMemo } from "react";
import type { MatrixMessage } from "@chatter/core/api";
import { externalSender, senderNameColor, type FormatOptions } from "@chatter/core/messageFormat";
import { mentionRoleColors } from "@chatter/core/mentions";
import { visibleChannels } from "@chatter/core/channelLinks";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import type { MessageRowProps } from "./MessageRow";

type RowData = Pick<
  MessageRowProps,
  "senderName" | "senderColor" | "senderFontUrl" | "avatarUrl" | "senderBadge" | "replySenderName" | "reactions" | "myUserId" | "mentionsMe" | "formatOptions" | "onReact"
>;

/**
 * What a message row needs to know about the room around it — names, colours,
 * reactions, whether it names you — for the channel and a thread alike, so the
 * two draw a message the same way.
 */
export function useMessageRows() {
  const state = useChatter();
  const { addReaction } = useChatterActions();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : undefined;

  const formatOptions = useMemo<FormatOptions>(
    () => ({
      currentUserId: state.userId,
      roleColors: mentionRoleColors(state.customRoles, roomInfo),
      emojiAliases: Object.fromEntries(Object.entries(roomInfo?.emoji_aliases ?? {}).map(([alias, url]) => [url as string, alias])),
      channels: visibleChannels(state),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.userId, state.customRoles, roomInfo, state.channels, state.roomMembers, state.memberCustomRoles],
  );

  const nameOf = useCallback(
    (userId: string) =>
      state.userPresence[userId]?.displayName || state.roomMembers.find((m) => m.userId === userId)?.displayName || displayUserId(userId),
    [state.userPresence, state.roomMembers],
  );

  const myName = state.userId ? displayUserId(state.userId).toLowerCase() : "";

  const rowData = useCallback(
    (m: MatrixMessage): RowData => {
      const body = m.content.body ?? "";
      // A bot or webhook names itself and brings its own picture.
      const external = externalSender(m);
      return {
        senderName: external ? external.name : nameOf(m.sender),
        senderColor: external ? undefined : senderNameColor(state, roomInfo, m.sender),
        senderFontUrl: external ? undefined : state.userPresence[m.sender]?.nameFontUrl,
        avatarUrl: external ? external.avatarUrl : state.userPresence[m.sender]?.avatarUrl,
        senderBadge: external?.badge,
        replySenderName: m.content.reply_to_sender ? nameOf(m.content.reply_to_sender) : undefined,
        reactions: state.messageReactions[m.event_id],
        myUserId: state.userId,
        mentionsMe:
          m.sender !== state.userId &&
          (m.content.reply_to_sender === state.userId || (!!myName && new RegExp(`@${myName}\\b`, "i").test(body))),
        formatOptions,
        onReact: addReaction,
      };
    },
    [state, roomInfo, nameOf, myName, formatOptions, addReaction],
  );

  return { rowData, nameOf, formatOptions };
}
