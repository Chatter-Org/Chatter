import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { router } from "expo-router";
import { ChevronDown, Gamepad2, MessageCircle, Pencil } from "lucide-react-native";
import { apiGetMutualFriends } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { profileWashStyle, readProfileTheme } from "@chatter/core/profileTheme";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { showToast } from "@/platform/toast";
import { useTheme } from "@/theme/ThemeProvider";
import { Sheet } from "@/ui/Sheet";
import { Button } from "@/ui/controls";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { serverImage } from "@/ui/media";
import { UI_HINT, UI_META } from "@/ui/roles";
import { Avatar } from "./Avatar";
import { NameText } from "./NameText";

/**
 * Someone's profile — the web's UserProfileDialog as a sheet: their banner and
 * picture, their name, how they are, what they wrote about themselves, and
 * what you can do about them (message them, friend them, block them).
 *
 * Opened from anywhere a person appears: `useShowProfile()(userId)`.
 */

const ShowProfileContext = createContext<(userId: string) => void>(() => {});

export function useShowProfile() {
  return useContext(ShowProfileContext);
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  // Kept while the sheet slides away, so it does not empty as it goes.
  const [shown, setShown] = useState<string | null>(null);
  const show = useCallback((id: string) => {
    setShown(id);
    setUserId(id);
  }, []);
  const close = useCallback(() => setUserId(null), []);
  return (
    <ShowProfileContext.Provider value={show}>
      {children}
      <Sheet open={!!userId} onClose={close} bare>
        {shown ? <Profile userId={shown} onClose={close} /> : null}
      </Sheet>
    </ShowProfileContext.Provider>
  );
}

// The web's presence colours and words (UserProfileDialog's statusColor/Label).
function statusLook(status: string): { dot: string; label: string } {
  if (status === "active" || status === "online") return { dot: "bg-success", label: "Online" };
  if (status === "idle" || status === "away") return { dot: "bg-warning", label: "Away" };
  if (status === "dnd") return { dot: "bg-destructive", label: "Do Not Disturb" };
  return { dot: "bg-muted-foreground", label: "Offline" };
}

/** h-[9.2rem], the web's banner. */
const BANNER = 162;
/** h-24 with a border-4 ring. */
const AVATAR = 105;

function Profile({ userId, onClose }: { userId: string; onClose(): void }) {
  const state = useChatter();
  const actions = useChatterActions();
  const { colors } = useTheme();
  const isSelf = userId === state.userId;
  const presence = state.userPresence[userId];
  const member = state.roomMembers.find((m) => m.userId === userId);
  const username = displayUserId(userId) || member?.displayName || userId;
  const name = presence?.displayName || member?.displayName || username;
  const status = presence?.status || "offline";
  const look = statusLook(status);
  const banner = serverImage(presence?.bannerUrl);
  const wash = useMemo(() => profileWashStyle(readProfileTheme(presence), "modal"), [presence]);

  const [mutuals, setMutuals] = useState<string[]>([]);
  const [mutualsOpen, setMutualsOpen] = useState(false);
  // Someone else's profile starts with nobody in common until theirs loads.
  const [mutualsOf, setMutualsOf] = useState({ userId, isSelf });
  if (mutualsOf.userId !== userId || mutualsOf.isSelf !== isSelf) {
    setMutualsOf({ userId, isSelf });
    setMutuals([]);
    setMutualsOpen(false);
  }
  useEffect(() => {
    if (isSelf) return;
    let live = true;
    apiGetMutualFriends(userId)
      .then((d) => live && setMutuals(d.mutuals))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [userId, isSelf]);

  // Their roles here, as the web shows them to you once you can see roles.
  const myRole = state.roomMembers.find((m) => m.userId === state.userId)?.role;
  const canSeeRoles = isSelf || myRole === "owner" || myRole === "moderator";
  const roles = canSeeRoles
    ? (state.memberCustomRoles[userId] ?? [])
        .map((id) => state.customRoles.find((r) => r.role_id === id))
        .filter((r): r is NonNullable<typeof r> => !!r)
    : [];
  const joined = member?.joinedAt ? new Date(member.joinedAt) : null;

  const fail = (what: string) => (e: unknown) =>
    showToast({ tone: "error", message: what, description: e instanceof Error ? e.message : undefined });

  const message = () => {
    onClose();
    void actions.openDM(userId).catch(fail("Couldn't open the conversation"));
  };

  return (
    <View>
      {/* The banner fades into the card below it. */}
      <View style={{ height: BANNER }}>
        {banner ? (
          <Image source={banner} style={StyleSheet.absoluteFill} contentFit="cover" />
        ) : (
          <View style={StyleSheet.absoluteFill} className="bg-secondary" />
        )}
        <View
          style={[StyleSheet.absoluteFill, { backgroundImage: `linear-gradient(to bottom, transparent 62%, ${colors.background} 100%)` }]}
        />
      </View>
      {/* Their colour, over the whole card, the banner too: laid under the
          content rather than over the banner's fade, so there is no seam
          where one ends. */}
      {wash ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundImage: wash.backgroundImage }]} /> : null}

      <View className="px-5" style={{ marginTop: -40 }}>
        <View className="self-start rounded-full border-4 border-background">
          <Avatar userId={userId} name={name} url={presence?.avatarUrl} size={AVATAR - 8} textClassName="text-xl" />
        </View>
      </View>

      <View className="gap-4 px-5 pb-1 pt-1">
        <View className="items-center gap-1">
          <NameText fontUrl={presence?.nameFontUrl} className="text-lg font-semibold" numberOfLines={2}>
            {name}
          </NameText>
          {presence?.displayName ? <T className={UI_HINT}>{username}</T> : null}
        </View>

        <View className="flex-row items-center justify-center gap-2">
          <View className={cn("size-2.5 rounded-full", look.dot)} />
          <T className="text-sm">{look.label}</T>
        </View>

        {mutuals.length > 0 ? (
          <View>
            <Pressable
              onPress={() => setMutualsOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: mutualsOpen }}
              className="flex-row items-center justify-between rounded-md border border-border/40 bg-muted/20 px-3 py-2 active:bg-muted/40"
            >
              <T className="text-xs font-medium text-muted-foreground">
                {mutuals.length} Mutual Friend{mutuals.length !== 1 ? "s" : ""}
              </T>
              <View style={mutualsOpen ? { transform: [{ rotate: "180deg" }] } : undefined}>
                <Icon as={ChevronDown} size={14} />
              </View>
            </Pressable>
            {mutualsOpen ? (
              <View className="mt-1.5 rounded-md border border-border/40 bg-muted/10 py-1">
                {mutuals.map((id) => {
                  const p = state.userPresence[id];
                  const n = p?.displayName || displayUserId(id) || id;
                  return (
                    <View key={id} className="flex-row items-center gap-2 px-3 py-1.5">
                      <Avatar userId={id} name={n} url={p?.avatarUrl} size={24} status={p?.status ?? "offline"} textClassName="text-3xs" />
                      <T className="flex-1 text-xs font-medium" numberOfLines={1}>
                        {n}
                      </T>
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        ) : null}

        {presence?.customStatus ? <T className="text-center text-sm italic text-muted-foreground">"{presence.customStatus}"</T> : null}

        {presence?.steamGame && status !== "offline" ? (
          <SteamGame game={presence.steamGame} appId={presence.steamAppId} since={presence.gameSessionStart} />
        ) : null}

        {presence?.about ? (
          <View className="gap-1.5">
            <T className="text-xs font-medium text-muted-foreground">About Me</T>
            <T className="text-sm">{presence.about}</T>
          </View>
        ) : null}

        {roles.length > 0 ? (
          <View className="gap-1.5">
            <T className="text-xs font-medium text-muted-foreground">{isSelf ? "Your roles" : "Roles"}</T>
            <View className="flex-row flex-wrap gap-1.5">
              {roles.map((r) => (
                <View key={r.role_id} className="flex-row items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                  <View className="size-2.5 rounded-full" style={{ backgroundColor: r.color || colors["muted-foreground"] }} />
                  <T className="text-xs">{r.name}</T>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {joined ? (
          <T className="text-center text-xs text-muted-foreground">
            Joined {joined.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
          </T>
        ) : null}

        {isSelf ? (
          <Button
            icon={Pencil}
            onPress={() => {
              onClose();
              router.push("/profile");
            }}
          >
            Edit profile
          </Button>
        ) : (
          <View className="gap-1.5">
            <Button icon={MessageCircle} onPress={message} className="mt-2">
              Message
            </Button>
            <FriendActions userId={userId} name={name} onClose={onClose} fail={fail} />
          </View>
        )}
      </View>
    </View>
  );
}

/** Add, accept, remove; block and unblock — the web's buttons, in its order. */
function FriendActions({
  userId,
  name,
  onClose,
  fail,
}: {
  userId: string;
  name: string;
  onClose(): void;
  fail(what: string): (e: unknown) => void;
}) {
  const state = useChatter();
  const actions = useChatterActions();
  const isFriend = state.friends.includes(userId);
  const isBlocked = state.blockedUsers.includes(userId);
  const outgoing = state.outgoingFriendRequests.some((r) => r.userId === userId);
  const incoming = state.incomingFriendRequests.some((r) => r.userId === userId);

  return (
    <>
      {isBlocked ? (
        <Button variant="outline" onPress={() => void actions.unblockUser(userId).catch(fail("Couldn't unblock"))}>
          Unblock
        </Button>
      ) : isFriend ? (
        <Button
          variant="outline"
          className="border-orange-400/30"
          textClassName="text-orange-400"
          onPress={() =>
            Alert.alert(`Remove ${name} as a friend?`, undefined, [
              { text: "Cancel", style: "cancel" },
              { text: "Remove", style: "destructive", onPress: () => void actions.removeFriend(userId).catch(fail("Couldn't remove friend")) },
            ])
          }
        >
          Remove Friend
        </Button>
      ) : incoming ? (
        <View className="flex-row gap-2">
          <Button variant="outline" className="flex-1" onPress={() => void actions.rejectFriendRequest(userId).catch(fail("Couldn't reject"))}>
            Reject
          </Button>
          <Button className="flex-1" onPress={() => void actions.acceptFriendRequest(userId).catch(fail("Couldn't accept"))}>
            Accept Request
          </Button>
        </View>
      ) : outgoing ? (
        <Button variant="outline" disabled>
          Request Sent
        </Button>
      ) : (
        <Button variant="outline" onPress={() => void actions.sendFriendRequest(userId).catch(fail("Couldn't send the request"))}>
          Add Friend
        </Button>
      )}
      {!isBlocked ? (
        <Button
          variant="outline"
          className="border-destructive/30"
          textClassName="text-destructive"
          onPress={() =>
            Alert.alert(`Block ${name}?`, "Any friendship or pending requests are removed too.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Block",
                style: "destructive",
                onPress: () => {
                  onClose();
                  void actions.blockUser(userId).catch(fail("Couldn't block"));
                },
              },
            ])
          }
        >
          Block User
        </Button>
      ) : null}
    </>
  );
}

function playingFor(since: number) {
  const elapsed = Math.floor(Date.now() / 1000 - since);
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "just started";
}

/** The web's SteamGameCard: the game's capsule, its name, how long. */
function SteamGame({ game, appId, since }: { game: string; appId?: string; since?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [since]);
  const [broken, setBroken] = useState(false);
  return (
    <View className="overflow-hidden rounded-md border border-border/40 bg-muted/20">
      {appId && !broken ? (
        <Image
          source={{ uri: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg` }}
          style={{ width: "100%", aspectRatio: 460 / 215, maxHeight: 120 }}
          contentFit="cover"
          onError={() => setBroken(true)}
        />
      ) : null}
      <View className="flex-row items-center gap-2 px-3 py-2">
        <Icon as={Gamepad2} size={14} color="#60a5fa" />
        <View className="min-w-0 flex-1">
          <T className="text-xs font-medium text-blue-400" numberOfLines={1}>
            {game}
          </T>
          {since ? <T className={UI_META}>Playing for {playingFor(since)}</T> : null}
        </View>
      </View>
    </View>
  );
}
