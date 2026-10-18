import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, AtSign, FileText, Film, Image as ImageIcon, MessagesSquare, Music, Pin, PinOff, Search, type LucideProps } from "lucide-react-native";
import type { ComponentType } from "react";
import { apiSearchMessages, type MatrixMessage, type PinnedMessage } from "@chatter/core/api";
import { canManageMessages } from "@chatter/core/permissions";
import { extractMedia } from "@chatter/core/messageFormat";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { MessageBody } from "@/components/MessageBody";
import { MessageMedia } from "@/components/MessageMedia";
import { useMessageRows } from "@/components/useMessageRows";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_META } from "@/ui/roles";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * Pinned messages, your mentions, and search — the web's MessagePanel, which
 * at phone width already covers the conversation; here it is a screen of its
 * own. Tapping a result goes to the message in the timeline.
 */

type Mode = "pins" | "mentions" | "search";

const TITLES: Record<Mode, string> = { search: "Search", mentions: "Mentions", pins: "Pinned messages" };
const ICONS: Record<Mode, ComponentType<LucideProps>> = { search: Search, mentions: AtSign, pins: Pin };

export default function Panel() {
  const { mode: param } = useLocalSearchParams<{ mode?: string }>();
  const mode: Mode = param === "pins" || param === "mentions" ? param : "search";
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const roomId = state.currentRoomId;

  // Pins: catch up on anything pinned or unpinned while away.
  useEffect(() => {
    if (mode === "pins") void actions.loadPins();
  }, [mode, roomId, state.currentChannelId, actions]);

  // Search: open while this screen is, closed when it goes. The request runs
  // a beat after the query or a filter changes, as on the web.
  useEffect(() => {
    if (mode !== "search") return;
    actions.updateSearch({ open: true });
    return () => actions.closeSearch();
  }, [mode, actions]);
  const { open, query, filter, fileTypeFilter, thisChannel } = state.search;
  useEffect(() => {
    if (mode !== "search" || !open) return;
    const timer = setTimeout(() => void actions.runSearch(), 300);
    return () => clearTimeout(timer);
  }, [mode, open, query, filter, fileTypeFilter, thisChannel, roomId, state.currentChannelId, actions]);

  const mentions = useMentions(mode === "mentions");

  const jump = useCallback(
    (m: MatrixMessage) => {
      if (!roomId) return;
      void actions.openMessage({ roomId, eventId: m.event_id, channelId: m.channel_id ?? null, ts: m.origin_server_ts });
      router.back();
    },
    [roomId, actions],
  );

  const items: MatrixMessage[] =
    mode === "pins" ? state.pinnedMessages : mode === "mentions" ? mentions.items : state.search.results;
  const loading = mode === "search" ? state.search.loading : mode === "mentions" ? mentions.loading : false;
  const hasMore = mode === "pins" ? state.pinsHasMore : mode === "mentions" ? mentions.hasMore : state.search.hasMore;
  const loadMore = mode === "pins" ? actions.loadMorePins : mode === "mentions" ? mentions.loadMore : actions.loadMoreSearchResults;

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent">
          <Icon as={ArrowLeft} size={22} />
        </Pressable>
        <Icon as={ICONS[mode]} size={16} />
        <T className="text-sm font-medium">{TITLES[mode]}</T>
        {mode === "pins" ? <T className="text-xs text-muted-foreground">({state.pinnedMessages.length})</T> : null}
      </View>

      {mode === "search" ? <SearchControls /> : null}

      {loading && items.length === 0 ? (
        <T className="py-4 text-center text-xs text-muted-foreground">{mode === "search" ? "Searching..." : "Loading mentions..."}</T>
      ) : items.length === 0 ? (
        <T className="py-4 text-center text-xs text-muted-foreground">
          {mode === "pins"
            ? "No pinned messages"
            : mode === "mentions"
              ? "No one has mentioned you here yet"
              : state.search.query.trim() || state.search.filter === "file" || state.search.filter === "thread"
                ? "No results"
                : "Type to search"}
        </T>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(m) => m.event_id}
          contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 8, paddingBottom: insets.bottom + 16 }}
          renderItem={({ item }) =>
            mode === "search" && state.search.filter === "thread" ? (
              <ThreadResult message={item} />
            ) : (
              <Result message={item} onPress={() => jump(item)} pinned={mode === "pins" ? (item as PinnedMessage) : undefined} />
            )
          }
          onEndReached={() => hasMore && void loadMore()}
          onEndReachedThreshold={0.5}
          ListFooterComponent={hasMore && loading ? <ActivityIndicator className="py-3" /> : null}
        />
      )}
    </View>
  );
}

/** Your mentions in this room, a page at a time (fetched here, as on the web). */
function useMentions(active: boolean) {
  const state = useChatter();
  const [items, setItems] = useState<MatrixMessage[]>([]);
  const [loading, setLoading] = useState(active);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const roomId = state.currentRoomId;
  const username = state.userId ? state.userId.replace(/^@/, "").replace(/:.*$/, "") : "";

  useEffect(() => {
    if (!active || !roomId || !username) return;
    let live = true;
    setLoading(true);
    apiSearchMessages(roomId, username, "mention")
      .then((page) => {
        if (!live) return;
        setItems(page.items);
        setHasMore(page.hasMore);
        setOffset(page.nextOffset);
      })
      .catch(() => live && setItems([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [active, roomId, username]);

  const loadMore = async () => {
    if (!roomId || !hasMore || loading) return;
    setLoading(true);
    try {
      const page = await apiSearchMessages(roomId, username, "mention", "all", undefined, undefined, offset);
      // Dedupe in case a new mention arrived and shifted the window.
      setItems((prev) => {
        const seen = new Set(prev.map((m) => m.event_id));
        return [...prev, ...page.items.filter((m) => !seen.has(m.event_id))];
      });
      setHasMore(page.hasMore);
      setOffset(page.nextOffset);
    } finally {
      setLoading(false);
    }
  };

  return { items, loading, hasMore, loadMore };
}

/** The query box and its filters, as the web's panel has them. */
function SearchControls() {
  const state = useChatter();
  const { updateSearch } = useChatterActions();
  const { colors } = useTheme();
  const { search } = state;
  const placeholder =
    search.filter === "user"
      ? "Search by username..."
      : search.filter === "file"
        ? "Search by filename..."
        : search.filter === "thread"
          ? "Search threads..."
          : "Search messages...";
  const FILTERS = [
    { key: "all", label: "All" },
    { key: "user", label: "Users" },
    { key: "file", label: "Files" },
    { key: "thread", label: "Threads" },
  ] as const;
  const TYPES = [
    { key: "all", label: "All types", icon: null },
    { key: "image", label: "Images", icon: ImageIcon },
    { key: "video", label: "Videos", icon: Film },
    { key: "audio", label: "Audio", icon: Music },
    { key: "document", label: "Docs", icon: FileText },
  ] as const;
  return (
    <View className="gap-2 border-b border-border px-3 py-2">
      <View className="flex-row items-center rounded-md border border-input pl-2.5">
        <Icon as={Search} size={15} />
        <TextInput
          value={search.query}
          onChangeText={(query) => updateSearch({ query })}
          placeholder={placeholder}
          placeholderTextColor={colors["muted-foreground"]}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          className="flex-1 px-2 py-2 font-mono text-sm text-foreground"
        />
      </View>
      <View className="flex-row flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="xs"
            variant={search.filter === f.key ? "default" : "outline"}
            onPress={() => updateSearch(f.key === "file" ? { filter: f.key } : { filter: f.key, fileTypeFilter: "all" })}
          >
            {f.label}
          </Button>
        ))}
        <Button size="xs" variant={search.thisChannel ? "default" : "outline"} className="ml-auto" onPress={() => updateSearch({ thisChannel: !search.thisChannel })}>
          This channel
        </Button>
      </View>
      {search.filter === "file" ? (
        <View className="flex-row flex-wrap gap-1">
          {TYPES.map((t) => (
            <Button
              key={t.key}
              size="xs"
              icon={t.icon ?? undefined}
              variant={search.fileTypeFilter === t.key ? "default" : "outline"}
              onPress={() => updateSearch({ fileTypeFilter: t.key })}
            >
              {t.label}
            </Button>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A message in a list: who, when, where, and what it says. */
function Result({ message, onPress, pinned }: { message: MatrixMessage; onPress(): void; pinned?: PinnedMessage }) {
  const state = useChatter();
  const { unpinMessage } = useChatterActions();
  const { nameOf, formatOptions } = useMessageRows();
  const channel = message.channel_id ? state.channels.find((c) => c.channel_id === message.channel_id) : undefined;
  const body = message.content.body ?? "";
  return (
    <View className="mb-1">
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint="Goes to the message" className="flex-row items-start gap-2 rounded-md px-2 py-2 active:bg-accent/30">
        <View className="mt-0.5">
          <Avatar userId={message.sender} name={nameOf(message.sender)} url={state.userPresence[message.sender]?.avatarUrl} size={31} />
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-baseline gap-2">
            <T className="shrink text-sm font-semibold" numberOfLines={1}>
              {nameOf(message.sender)}
            </T>
            <T className="text-xs text-muted-foreground">
              {new Date(message.origin_server_ts).toLocaleDateString([], { month: "short", day: "numeric" })}{" "}
              {new Date(message.origin_server_ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </T>
          </View>
          {channel ? <T className="text-xs text-muted-foreground">#{channel.name}</T> : null}
          <View className="mt-0.5">
            {message.content.spoiler ? (
              <T className="text-sm italic text-muted-foreground">Spoiler message</T>
            ) : (
              <>
                <MessageBody body={body} options={formatOptions} edited={message.edited} />
                <MessageMedia media={extractMedia(body)} />
              </>
            )}
          </View>
        </View>
      </Pressable>
      {pinned ? (
        <View className="flex-row items-center gap-2 px-2 pb-1">
          <T className={UI_META}>
            Pinned by {nameOf(pinned.pinned_by)} · {new Date(pinned.pinned_at).toLocaleDateString()}
          </T>
          {canManageMessages(state) ? (
            <Pressable onPress={() => void unpinMessage(pinned.event_id)} hitSlop={8} accessibilityRole="button" className="flex-row items-center gap-1">
              <Icon as={PinOff} size={12} />
              <T className="text-xs text-muted-foreground">Unpin</T>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A thread in the results: its name, what started it, its replies. */
function ThreadResult({ message }: { message: MatrixMessage }) {
  const { openThread } = useChatterActions();
  return (
    <Pressable
      onPress={() => {
        void openThread(message.event_id).catch(() => {});
        router.replace("/thread");
      }}
      accessibilityRole="button"
      className={cn("flex-row items-start gap-2 rounded-md px-2 py-2 active:bg-accent/30")}
    >
      <View className="mt-0.5">
        <Icon as={MessagesSquare} size={17} />
      </View>
      <View className="min-w-0 flex-1">
        <T className="text-sm font-medium" numberOfLines={1}>
          {message.thread_name || "Thread"}
        </T>
        {message.content.body ? (
          <T className="text-xs text-muted-foreground" numberOfLines={1}>
            {message.content.body}
          </T>
        ) : null}
        <T className="mt-0.5 text-xs text-muted-foreground">
          {message.thread_reply_count ?? 0} {(message.thread_reply_count ?? 0) === 1 ? "reply" : "replies"}
        </T>
      </View>
    </Pressable>
  );
}
