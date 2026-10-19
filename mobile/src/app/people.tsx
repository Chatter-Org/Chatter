import { useMemo, useState } from "react";
import { FlatList, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Search, X } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_HEADING, UI_META } from "@/ui/roles";
import { useTheme } from "@/theme/ThemeProvider";

/** The server's cap on a DM's members, you included (GroupDMDialog). */
const MAX_DM_MEMBERS = 20;

/**
 * Who to talk to — the web's GroupDMDialog ("dm": one person is a DM, several
 * a group) and AddToDMDialog ("add": one more into the DM on screen), as the
 * phone's full-screen picker: a search on top, your friends first, then
 * everyone else you share a room with.
 */
export default function People() {
  const { mode: param } = useLocalSearchParams<{ mode?: string }>();
  const adding = param === "add";
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roomId = state.currentRoomId;
  const members = useMemo(() => (adding ? state.roomMembers.map((m) => m.userId) : []), [adding, state.roomMembers]);
  const atLimit = adding ? members.length + selected.length >= MAX_DM_MEMBERS : selected.length >= MAX_DM_MEMBERS - 1;

  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id) || id;

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const friends = new Set(state.friends);
    const blocked = new Set(state.blockedUsers);
    const ids = new Set([...state.friends, ...Object.keys(state.userPresence)]);
    return [...ids]
      .filter((id) => id !== state.userId && !blocked.has(id) && !members.includes(id))
      .filter((id) => {
        if (!q) return true;
        const display = (state.userPresence[id]?.displayName || displayUserId(id)).toLowerCase();
        return display.includes(q) || id.toLowerCase().includes(q);
      })
      .map((id) => ({ id, friend: friends.has(id) }))
      .sort((a, b) => Number(b.friend) - Number(a.friend) || nameOf(a.id).localeCompare(nameOf(b.id)));
    // nameOf reads userPresence, which is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, state.friends, state.blockedUsers, state.userPresence, state.userId, members]);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : atLimit ? prev : [...prev, id]));
  };

  const start = async (ids: string[]) => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (adding && roomId) {
        for (const id of ids) await actions.addToGroupDM(roomId, id);
      } else {
        await actions.openDM(ids.length === 1 ? ids[0] : ids);
      }
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : adding ? "Failed to add user" : "Failed to create group DM");
      setBusy(false);
    }
  };

  const title = adding ? "Add people" : "New Message";
  const hint = adding
    ? `${members.length}/${MAX_DM_MEMBERS} members`
    : selected.length > 1
      ? `Group · ${selected.length}/${MAX_DM_MEMBERS - 1} people`
      : `Pick one, or several for a group`;
  const actionLabel = busy ? (adding ? "Adding..." : "Creating...") : adding ? "Add" : selected.length > 1 ? "Create Group" : "Message";

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={X} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold">{title}</T>
          <T className={UI_META} numberOfLines={1}>
            {hint}
          </T>
        </View>
        <Button size="sm" disabled={selected.length === 0 || busy} onPress={() => void start(selected)}>
          {actionLabel}
        </Button>
      </View>

      <View className="gap-2 border-b border-border px-3 py-2">
        {selected.length > 0 ? (
          <View className="flex-row flex-wrap gap-1">
            {selected.map((id) => (
              <Pressable
                key={id}
                onPress={() => toggle(id)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${nameOf(id)}`}
                className="flex-row items-center gap-1 rounded-full bg-accent py-0.5 pl-2 pr-1.5 active:opacity-70"
              >
                <T className="text-xs">{nameOf(id)}</T>
                <Icon as={X} size={12} />
              </Pressable>
            ))}
          </View>
        ) : null}
        <View className="flex-row items-center rounded-md border border-input pl-2.5">
          <Icon as={Search} size={15} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search users..."
            placeholderTextColor={colors["muted-foreground"]}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            className="flex-1 px-2 py-2 font-mono text-sm text-foreground"
          />
        </View>
        {error ? <T className="text-sm text-destructive">{error}</T> : null}
      </View>

      <FlatList
        data={candidates}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: 8, paddingBottom: insets.bottom + 8 }}
        ListEmptyComponent={
          <T className="py-6 text-center text-sm text-muted-foreground">{query ? "No users found" : "No other users available"}</T>
        }
        renderItem={({ item, index }) => {
          const on = selected.includes(item.id);
          const disabled = !on && atLimit;
          const p = state.userPresence[item.id];
          // The two groups get a heading each where they start.
          const heading =
            index === 0 ? (item.friend ? "Friends" : "Others") : item.friend !== candidates[index - 1].friend ? "Others" : null;
          return (
            <View>
              {heading ? <T className={cn(UI_HEADING, "px-2 pb-1 pt-2 text-3xs")}>{heading}</T> : null}
              <Pressable
                onPress={() => toggle(item.id)}
                disabled={disabled}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled }}
                className={cn("flex-row items-center gap-2.5 rounded-md px-2 py-2", on ? "bg-accent" : "active:bg-accent/50", disabled && "opacity-50")}
              >
                <Avatar userId={item.id} name={nameOf(item.id)} url={p?.avatarUrl} size={31} status={p?.status ?? "offline"} textClassName="text-xs" />
                <View className="min-w-0 flex-1">
                  <T className="text-sm" numberOfLines={1}>
                    {nameOf(item.id)}
                  </T>
                  {p?.displayName ? (
                    <T className="text-2xs text-muted-foreground" numberOfLines={1}>
                      {displayUserId(item.id)}
                    </T>
                  ) : null}
                </View>
                <View
                  className={cn("size-5 items-center justify-center rounded-full border", on ? "border-primary bg-primary" : "border-input")}
                >
                  {on ? <Icon as={Check} size={13} tone="primary-foreground" /> : null}
                </View>
              </Pressable>
            </View>
          );
        }}
      />
    </View>
  );
}
