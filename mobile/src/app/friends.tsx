import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { ArrowLeft, Ban, ChevronDown, Clock, Gamepad2, MessageCircle, UserCheck, UserPlus, type LucideProps } from "lucide-react-native";
import type { ComponentType } from "react";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Avatar } from "@/components/Avatar";
import { useShowProfile } from "@/components/ProfileSheet";
import { showToast } from "@/platform/toast";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { UI_META } from "@/ui/roles";
import { useTheme } from "@/theme/ThemeProvider";

/** Online, then away, then busy, then offline (ActivityPage's sort). */
function rank(status: string | undefined) {
  if (status === "active" || status === "online") return 0;
  if (status === "idle" || status === "away") return 1;
  if (status === "dnd") return 2;
  return 3;
}

/**
 * Your friends — the web's Activity page's friends column as a screen:
 * requests waiting on you, your friends with who is on first, adding someone
 * by their username, and the people you have blocked.
 */
export default function Friends() {
  const state = useChatter();
  const actions = useChatterActions();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const showProfile = useShowProfile();
  const [target, setTarget] = useState("");
  const [blockedOpen, setBlockedOpen] = useState(false);

  useEffect(() => {
    void actions.loadFriends();
  }, [actions]);
  // Faces and status for friends you share no room with.
  useEffect(() => {
    void actions.loadFriendPresence();
  }, [actions, state.friends, state.incomingFriendRequests]);

  const keyboard = useReanimatedKeyboardAnimation();
  const lift = useAnimatedStyle(() => ({ transform: [{ translateY: Math.min(0, keyboard.height.value + insets.bottom) }] }));

  const friends = useMemo(
    () => [...state.friends].sort((a, b) => rank(state.userPresence[a]?.status) - rank(state.userPresence[b]?.status)),
    [state.friends, state.userPresence],
  );
  const online = friends.filter((id) => rank(state.userPresence[id]?.status) < 3).length;

  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id) || id;
  const fail = (what: string) => (e: unknown) =>
    showToast({ tone: "error", message: what, description: e instanceof Error ? e.message : undefined });

  const add = async () => {
    const who = target.trim();
    if (!who) return;
    try {
      await actions.sendFriendRequest(who);
      setTarget("");
      showToast({ message: `Friend request sent to ${who}` });
    } catch (e) {
      fail("Could not send friend request")(e);
    }
  };

  const message = (id: string) => {
    router.back();
    void actions.openDM(id).catch(fail("Couldn't open the conversation"));
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center gap-1 border-b border-border px-2 py-1.5">
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          className="h-10 w-10 items-center justify-center rounded-lg active:bg-accent"
        >
          <Icon as={ArrowLeft} size={22} />
        </Pressable>
        <View className="min-w-0 flex-1 px-1">
          <T className="text-sm font-semibold">Friends</T>
          <T className={UI_META}>
            {online} online · {friends.length} total
          </T>
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerClassName="gap-6 px-4 py-4" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {state.incomingFriendRequests.length > 0 ? (
          <Section icon={UserPlus} title="Requests" count={state.incomingFriendRequests.length}>
            <View className="gap-2">
              {state.incomingFriendRequests.map((req) => (
                <View key={req.userId} className="flex-row items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
                  <Pressable onPress={() => showProfile(req.userId)} className="min-w-0 flex-1 flex-row items-center gap-2.5">
                    <Avatar
                      userId={req.userId}
                      name={nameOf(req.userId)}
                      url={state.userPresence[req.userId]?.avatarUrl}
                      size={31}
                      status={state.userPresence[req.userId]?.status ?? "offline"}
                      textClassName="text-xs"
                    />
                    <T className="flex-1 text-sm font-medium" numberOfLines={1}>
                      {nameOf(req.userId)}
                    </T>
                  </Pressable>
                  <Button size="sm" variant="outline" onPress={() => void actions.rejectFriendRequest(req.userId).catch(fail("Couldn't reject"))}>
                    Reject
                  </Button>
                  <Button size="sm" onPress={() => void actions.acceptFriendRequest(req.userId).catch(fail("Couldn't accept"))}>
                    Accept
                  </Button>
                </View>
              ))}
            </View>
          </Section>
        ) : null}

        <Section icon={UserCheck} title="Friends" count={friends.length || undefined}>
          {friends.length === 0 ? (
            <T className="py-2 text-xs text-muted-foreground">No friends yet. Add someone by their username below, or from their profile.</T>
          ) : (
            <View className="gap-0.5">
              {friends.map((id) => {
                const p = state.userPresence[id];
                const status = p?.status || "offline";
                const steam = status !== "offline" && p?.steamGame;
                return (
                  <Pressable
                    key={id}
                    onPress={() => showProfile(id)}
                    accessibilityRole="button"
                    className={cn("flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-accent/50", status === "offline" && "opacity-60")}
                  >
                    <Avatar userId={id} name={nameOf(id)} url={p?.avatarUrl} size={36} status={status} />
                    <View className="min-w-0 flex-1">
                      <T className="text-sm font-medium" numberOfLines={1}>
                        {nameOf(id)}
                      </T>
                      {steam ? (
                        <View className="flex-row items-center gap-1">
                          <Icon as={Gamepad2} size={12} color="#60a5fa" />
                          <T className="flex-1 text-2xs text-muted-foreground" numberOfLines={1}>
                            {p?.steamGame}
                          </T>
                        </View>
                      ) : p?.customStatus ? (
                        <T className="text-2xs text-muted-foreground" numberOfLines={1}>
                          {p.customStatus}
                        </T>
                      ) : null}
                    </View>
                    <Pressable
                      onPress={() => message(id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Message ${nameOf(id)}`}
                      hitSlop={6}
                      className="size-9 items-center justify-center rounded-full bg-secondary active:bg-secondary/70"
                    >
                      <Icon as={MessageCircle} size={16} tone="secondary-foreground" />
                    </Pressable>
                  </Pressable>
                );
              })}
            </View>
          )}
        </Section>

        {state.outgoingFriendRequests.length > 0 ? (
          <Section icon={Clock} title="Pending" count={state.outgoingFriendRequests.length}>
            <View className="gap-0.5">
              {state.outgoingFriendRequests.map((req) => (
                <Pressable
                  key={req.userId}
                  onPress={() => showProfile(req.userId)}
                  className="flex-row items-center gap-2.5 rounded-md px-2 py-2 active:bg-accent/50"
                >
                  <Avatar userId={req.userId} name={nameOf(req.userId)} url={state.userPresence[req.userId]?.avatarUrl} size={31} textClassName="text-xs" />
                  <T className="flex-1 text-sm" numberOfLines={1}>
                    {nameOf(req.userId)}
                  </T>
                  <T className={UI_META}>Request sent</T>
                </Pressable>
              ))}
            </View>
          </Section>
        ) : null}

        {state.blockedUsers.length > 0 ? (
          <View className="gap-3">
            <Pressable
              onPress={() => setBlockedOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: blockedOpen }}
              className="flex-row items-center gap-2"
            >
              <SectionTitle icon={Ban} title="Blocked" count={state.blockedUsers.length} />
              <View style={blockedOpen ? { transform: [{ rotate: "180deg" }] } : undefined}>
                <Icon as={ChevronDown} size={14} />
              </View>
            </Pressable>
            {blockedOpen ? (
              <View className="gap-2">
                {state.blockedUsers.map((id) => (
                  <View key={id} className="flex-row items-center justify-between rounded-lg border border-border px-3 py-2.5">
                    <T className="flex-1 text-sm font-medium" numberOfLines={1}>
                      {displayUserId(id)}
                    </T>
                    <Button size="sm" variant="outline" onPress={() => void actions.unblockUser(id).catch(fail("Couldn't unblock"))}>
                      Unblock
                    </Button>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/* Adding someone, at the bottom where the thumb is, above the keyboard. */}
      <Animated.View style={[lift, { paddingBottom: insets.bottom + 8 }]} className="flex-row items-center gap-2 border-t border-border bg-background px-3 pt-2">
        <TextInput
          value={target}
          onChangeText={setTarget}
          onSubmitEditing={() => void add()}
          placeholder="Add friend by username"
          placeholderTextColor={colors["muted-foreground"]}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          className="h-9 flex-1 rounded-md border border-input px-3 font-mono text-sm text-foreground"
        />
        <Button variant="outline" disabled={!target.trim()} onPress={() => void add()}>
          Add
        </Button>
      </Animated.View>
    </View>
  );
}

function SectionTitle({ icon, title, count }: { icon: ComponentType<LucideProps>; title: string; count?: number }) {
  return (
    <View className="flex-row items-center gap-2">
      <Icon as={icon} size={16} />
      <T className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</T>
      {count !== undefined ? <T className="text-xs text-muted-foreground">({count})</T> : null}
    </View>
  );
}

function Section({ icon, title, count, children }: { icon: ComponentType<LucideProps>; title: string; count?: number; children: ReactNode }) {
  return (
    <View className="gap-3">
      <SectionTitle icon={icon} title={title} count={count} />
      {children}
    </View>
  );
}
