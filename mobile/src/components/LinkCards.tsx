import { memo, useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { Image } from "expo-image";
import { Hash, Link2Off, MessageSquareQuote, MessagesSquare, Paperclip } from "lucide-react-native";
import { apiGetLinkPreview, type ForumPreview, type LinkPreview, type MessagePreview } from "@chatter/core/api";
import { parseMessageLink, peekMessagePreview, resolveMessagePreview } from "@chatter/core/messageLinks";
import { parseForumLink, peekForumPreview, resolveForumPreview } from "@chatter/core/forumLinks";
import { displayUserId } from "@chatter/core/utils";
import { useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "./Avatar";
import { Icon, T } from "@/ui/primitives";
import { UI_HINT } from "@/ui/roles";

/**
 * What a link in a message unfolds into, as the web draws it: a preview of a
 * page (MessageItem's LinkPreviewCard), a quoted message (MessageLinkEmbed)
 * or a forum post (ForumLinkEmbed). The resolvers are core's, shared and
 * cached, so a card drawn before does not blink on its way back.
 */

/** A web page: its picture, site, title and description. */
export const LinkPreviewCard = memo(function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  useEffect(() => {
    let live = true;
    apiGetLinkPreview(url)
      .then((data) => live && setPreview(data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [url]);
  if (!preview || (!preview.title && !preview.description && !preview.image)) return null;
  return (
    <Pressable
      onPress={() => void Linking.openURL(url)}
      accessibilityRole="link"
      accessibilityLabel={preview.title ?? url}
      className="mt-2 flex-row overflow-hidden rounded-md border border-border bg-secondary/30 active:bg-secondary/50"
      style={{ maxWidth: 448 }}
    >
      {preview.image ? <Image source={{ uri: preview.image }} style={{ width: 105, height: 105 }} contentFit="cover" /> : null}
      <View className="min-w-0 flex-1 justify-center px-3 py-2">
        {preview.site_name ? (
          <T className="text-xs text-muted-foreground" numberOfLines={1}>
            {preview.site_name}
          </T>
        ) : null}
        {preview.title ? (
          <T className="text-sm font-medium" numberOfLines={1}>
            {preview.title}
          </T>
        ) : null}
        {preview.description ? (
          <T className="text-xs text-muted-foreground" numberOfLines={2}>
            {preview.description}
          </T>
        ) : null}
      </View>
    </Pressable>
  );
});

/** Resolve through a shared cache: what is already known draws at once. */
function useResolved<T>(key: string | null, peek: () => { value: T | null } | null, resolve: () => Promise<T | null>) {
  const [fetched, setFetched] = useState<{ key: string; value: T | null } | null>(null);
  useEffect(() => {
    if (!key || peek()) return;
    let live = true;
    resolve()
      .then((value) => live && setFetched({ key, value }))
      .catch(() => {});
    return () => {
      live = false;
    };
    // The key names the thing; the functions follow it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return undefined;
  const cached = peek();
  if (cached) return cached.value;
  return fetched?.key === key ? fetched.value : undefined;
}

/** A link to a message: who said what, where — tap to go there. */
export const MessageLinkCard = memo(function MessageLinkCard({ url }: { url: string }) {
  const eventId = parseMessageLink(url);
  const { openMessage } = useChatterActions();
  const preview = useResolved<MessagePreview>(
    eventId,
    () => (eventId ? peekMessagePreview(eventId) : null),
    () => resolveMessagePreview(eventId!),
  );
  if (preview === undefined) return null;
  if (preview === null) return <Unavailable text="Message unavailable" />;
  const name = preview.sender_display_name || displayUserId(preview.sender);
  const where = preview.channel_name ? preview.channel_name : preview.room_name;
  return (
    <Pressable
      onPress={() =>
        void openMessage({ roomId: preview.room_id, eventId: preview.event_id, channelId: preview.channel_id, ts: preview.origin_server_ts })
      }
      accessibilityRole="button"
      accessibilityHint="Opens the message"
      className="mt-1 gap-1 rounded-md border border-border bg-secondary/40 p-2.5 active:bg-secondary/70"
      style={{ maxWidth: 572 }}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon as={MessageSquareQuote} size={15} />
        {preview.channel_name ? <Icon as={Hash} size={13} /> : null}
        <T className="shrink text-xs font-medium text-muted-foreground" numberOfLines={1}>
          {where}
        </T>
        {preview.channel_name && preview.room_name ? (
          <T className="shrink text-xs text-muted-foreground" numberOfLines={1}>
            · {preview.room_name}
          </T>
        ) : null}
      </View>
      <View className="flex-row items-start gap-2">
        <Avatar userId={preview.sender} name={name} url={preview.sender_avatar_url || undefined} size={22} textClassName="text-[10px]" />
        <View className="min-w-0 flex-1">
          <T numberOfLines={1}>
            <T className="text-xs font-semibold">{name} </T>
            <T className={UI_HINT}>{new Date(preview.origin_server_ts).toLocaleString()}</T>
          </T>
          <T className={`text-sm text-muted-foreground ${preview.spoiler || !preview.body ? "italic" : ""}`} numberOfLines={3}>
            {preview.spoiler ? "Spoiler message" : preview.body || "No text"}
            {preview.edited ? <T className={UI_HINT}> (edited)</T> : null}
          </T>
          {preview.attachment_count > 0 ? (
            <View className="mt-0.5 flex-row items-center gap-1">
              <Icon as={Paperclip} size={13} />
              <T className={UI_HINT}>
                {preview.attachment_count} {preview.attachment_count === 1 ? "attachment" : "attachments"}
              </T>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

/** A link to a forum post or reply: its title, who, a snippet, the replies. */
export const ForumLinkCard = memo(function ForumLinkCard({ url }: { url: string }) {
  const ref = parseForumLink(url);
  const key = ref ? `${ref.postId}|${ref.commentId ?? ""}` : null;
  const { selectRoom, selectChannel } = useChatterActions();
  const preview = useResolved<ForumPreview>(
    key,
    () => (ref ? peekForumPreview(ref.postId, ref.commentId) : null),
    () => resolveForumPreview(ref!.postId, ref!.commentId),
  );
  if (preview === undefined) return null;
  if (preview === null) return <Unavailable text="Post unavailable" />;
  const name = preview.author_display_name || displayUserId(preview.author);
  return (
    <Pressable
      // Forums open on the phone with their own screen; until then, the
      // forum's channel is where the post lives.
      onPress={async () => {
        await selectRoom(preview.room_id).catch(() => {});
        if (preview.channel_id) await selectChannel(preview.channel_id).catch(() => {});
      }}
      accessibilityRole="button"
      className="mt-1 gap-1 rounded-md border border-border bg-secondary/40 p-2.5 active:bg-secondary/70"
      style={{ maxWidth: 572 }}
    >
      <View className="flex-row items-center gap-1.5">
        <Icon as={MessagesSquare} size={15} />
        <T className="shrink text-xs font-medium text-muted-foreground" numberOfLines={1}>
          {preview.channel_name ?? preview.room_name}
        </T>
        <T className="text-xs text-muted-foreground">· {preview.kind === "reply" ? "reply" : "post"}</T>
      </View>
      <T className="text-sm font-semibold" numberOfLines={1}>
        {preview.title}
      </T>
      <View className="flex-row items-start gap-2">
        <Avatar userId={preview.author} name={name} url={preview.author_avatar_url || undefined} size={22} textClassName="text-[10px]" />
        <View className="min-w-0 flex-1">
          <T className="text-xs font-semibold">{name}</T>
          {preview.body ? (
            <T className="text-sm text-muted-foreground" numberOfLines={3}>
              {preview.body}
            </T>
          ) : null}
          <T className={UI_HINT}>
            {preview.comment_count} {preview.comment_count === 1 ? "reply" : "replies"}
          </T>
        </View>
      </View>
    </Pressable>
  );
});

function Unavailable({ text }: { text: string }) {
  return (
    <View className="mt-1 flex-row items-center gap-2 rounded-md border border-dashed border-border bg-secondary/20 px-2.5 py-2" style={{ maxWidth: 572 }}>
      <Icon as={Link2Off} size={15} />
      <T className="text-xs text-muted-foreground">{text}</T>
    </View>
  );
}
