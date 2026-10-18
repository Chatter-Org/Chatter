import { useCallback, useMemo } from "react";
import type { MatrixMessage } from "@chatter/core/api";
import { senderNameColor, type FormatOptions } from "@chatter/core/messageFormat";
import { mentionRoleColors } from "@chatter/core/mentions";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import type { MessageRowProps } from "./MessageRow";

type RowData = Pick<
  MessageRowProps,
  "senderName" | "senderColor" | "avatarUrl" | "replySenderName" | "reactions" | "myUserId" | "mentionsMe" | "formatOptions" | "onReact"
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
    }),
    [state.userId, state.customRoles, roomInfo],
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
      return {
        senderName: nameOf(m.sender),
        senderColor: senderNameColor(state, roomInfo, m.sender),
        avatarUrl: state.userPresence[m.sender]?.avatarUrl,
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
