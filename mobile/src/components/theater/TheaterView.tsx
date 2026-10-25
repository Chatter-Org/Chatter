import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { Pressable, TextInput, View, useWindowDimensions } from "react-native";
import Animated, { interpolate, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { Film, Link2, Pause, Play, RefreshCw, Volume2, VolumeX } from "lucide-react-native";
import { apiGetWatchPartyReactions, apiGetWatchPartyState, type WatchPartyReaction } from "@chatter/core/api";
import { displayUserId } from "@chatter/core/utils";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { on } from "@/platform/events";
import { useTheme } from "@/theme/ThemeProvider";
import { Slider } from "@/ui/Slider";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { Avatar } from "../Avatar";
import { ChatView } from "../ChatView";
import { FilePlayer, YouTubePlayer, type TheaterPlayerHandle } from "./TheaterPlayers";
import { TheaterSync, formatTime, youTubeId, type SyncFrame } from "./sync";

/**
 * A theater channel — the web's WatchPartyArea: a video everyone in the room
 * watches together, with the channel's conversation under it. Anyone can put
 * a video on (an upload, a direct link or YouTube), play, pause and skip; a
 * reaction is pinned to the moment in the video it was made at.
 *
 * On a phone held upright the video sits above the conversation; turned on
 * its side it takes the screen, and a wide window puts the two side by side.
 */
export function TheaterView() {
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  // A tablet, not a phone on its side (a Pixel on its side is 900 wide too).
  const wide = width >= 900 && height >= 600;
  if (landscape && !wide) {
    return (
      <View className="flex-1 bg-black">
        <Stage fill />
      </View>
    );
  }
  return (
    <View className={cn("flex-1", wide && "flex-row")}>
      <View className={cn(wide ? "flex-1 justify-center bg-black" : undefined)}>
        <Stage />
      </View>
      <View className={cn("flex-1", wide && "max-w-[420px] border-l border-border")}>
        <ChatView />
      </View>
    </View>
  );
}

/** The web's reaction shortcuts; any emoji can be stored. */
const REACTION_EMOJI = ["😂", "😮", "❤️", "🔥", "👀", "💀"] as const;
/** A reaction floats over the video when it lands this near where we are. */
const LIVE_REACTION_WINDOW_SECS = 4;
const FLOAT_LIFETIME_MS = 2600;
const MAX_VIEWER_AVATARS = 7;

interface Float {
  id: string;
  emoji: string;
  right: number;
}

function Stage({ fill }: { fill?: boolean }) {
  const state = useChatter();
  const actions = useChatterActions();
  const { colors } = useTheme();
  const roomId = state.currentRoomId ?? "";
  const channelId = state.currentChannelId ?? "";
  const me = state.userId;
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const player = useRef<TheaterPlayerHandle>(null);

  // The timeline is the room's: both its REST state and its frames are keyed
  // by the room, and every frame carries the channel for the server's notices.
  // (The view is mounted afresh for each channel, so these hold for its life.)
  const send = (frame: Record<string, unknown>) => void actions.send({ ...frame, room_id: roomId, channel_id: channelId });
  const [sync] = useState(() => new TheaterSync(me, send, redraw));

  const [restViewers, setRestViewers] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [linking, setLinking] = useState(false);
  const [link, setLink] = useState("");
  const [reactions, setReactions] = useState<WatchPartyReaction[]>([]);
  const [floats, setFloats] = useState<Float[]>([]);

  const videoUrl = sync.watch.videoUrl;
  const ytId = youTubeId(videoUrl);

  useEffect(() => {
    sync.start();
    return () => sync.stop();
  }, [sync]);

  // Where the room is: asked over REST (the socket's answer only comes when
  // there is a timeline at all), and on the socket, now and after a reconnect.
  useEffect(() => {
    if (!roomId) return;
    let live = true;
    void apiGetWatchPartyState(roomId).then((data) => {
      if (!live) return;
      setRestViewers(data.viewers ?? []);
      sync.load(data);
    });
    const request = () => void actions.send({ type: "watchparty_request_sync", room_id: roomId, channel_id: channelId });
    request();
    const offs = [
      on<SyncFrame>("watchparty_sync", (msg) => msg.room_id === roomId && sync.receive("watchparty_sync", msg)),
      on<SyncFrame>("watchparty_video_changed", (msg) => msg.room_id === roomId && sync.receive("watchparty_video_changed", msg)),
      on("socket_reopened", request),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [roomId, channelId, actions, sync]);

  // Among the watchers while there is something to watch. The server drops
  // everyone's place on any disconnect, so a reconnect takes it again.
  const hasVideo = videoUrl !== "";
  useEffect(() => {
    if (!roomId || !hasVideo) return;
    const join = () => void actions.send({ type: "watchparty_viewer_join", room_id: roomId });
    join();
    const off = on("socket_reopened", join);
    return () => {
      off();
      actions.send({ type: "watchparty_viewer_leave", room_id: roomId });
    };
  }, [roomId, hasVideo, actions]);

  // This video's reactions, and new ones as they land.
  useEffect(() => {
    if (!roomId || !videoUrl) return;
    let live = true;
    void apiGetWatchPartyReactions(roomId)
      .then((data) => live && data.video_url === videoUrl && setReactions(data.reactions))
      .catch(() => {});
    const off = on<WatchPartyReaction & { room_id: string; video_url: string }>("watchparty_reaction_added", (msg) => {
      if (msg.room_id !== roomId || msg.video_url !== videoUrl) return;
      setReactions((list) => (list.some((r) => r.reaction_id === msg.reaction_id) ? list : [...list, msg]));
      if (Math.abs(msg.position_secs - sync.display) <= LIVE_REACTION_WINDOW_SECS) {
        const float = { id: msg.reaction_id, emoji: msg.emoji, right: Math.random() * 60 };
        setFloats((f) => [...f, float]);
        setTimeout(() => setFloats((f) => f.filter((x) => x.id !== float.id)), FLOAT_LIFETIME_MS);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [roomId, videoUrl, sync]);

  const events = {
    onReady: () => {
      player.current?.setMuted(muted);
      sync.playerReady(player.current, !!ytId);
    },
    onPosition: (secs: number) => sync.playerPosition(secs),
    onDuration: (secs: number) => sync.playerDuration(secs),
    onEnded: () => sync.playerEnded(),
  };

  const loadLink = () => {
    const url = link.trim();
    if (!url) return;
    send({ type: "watchparty_set_video", video_url: url });
    setLink("");
    setLinking(false);
  };

  const viewers = (() => {
    const list = state.watchViewers[roomId] ?? restViewers;
    return me && hasVideo && !list.includes(me) ? [me, ...list] : list;
  })();
  const nameOf = (id: string) => state.userPresence[id]?.displayName || displayUserId(id);
  const duration = sync.duration;

  return (
    <View className={cn("bg-black", fill && "flex-1")}>
      {/* The picture, 16:9, or the whole screen on its side. */}
      <View style={fill ? { flex: 1 } : { width: "100%", aspectRatio: 16 / 9 }} className="bg-black">
        {!hasVideo ? (
          <View className="flex-1 items-center justify-center gap-1.5 px-6">
            <Icon as={Film} size={36} color="rgba(255,255,255,0.4)" />
            <T className="text-sm font-medium text-white/80">No video loaded</T>
            <T className="text-center text-xs text-white/50">Paste a YouTube or direct video link below</T>
          </View>
        ) : ytId ? (
          <YouTubePlayer key={videoUrl} ref={player} id={ytId} {...events} />
        ) : (
          <FilePlayer key={videoUrl} ref={player} url={videoUrl} {...events} />
        )}
        {floats.map((f) => (
          <FloatingReaction key={f.id} emoji={f.emoji} right={f.right} />
        ))}
        {hasVideo && viewers.length > 0 ? (
          <View className="absolute bottom-2 left-2 flex-row items-center gap-1.5 rounded-full bg-black/60 py-1 pl-1 pr-2.5" pointerEvents="none">
            <View className="flex-row">
              {viewers.slice(0, MAX_VIEWER_AVATARS).map((id, i) => (
                <Avatar key={id} userId={id} name={nameOf(id)} url={state.userPresence[id]?.avatarUrl} size={20} className={i > 0 ? "-ml-1.5" : undefined} />
              ))}
            </View>
            {viewers.length > MAX_VIEWER_AVATARS ? <T className="text-[11px] text-white/80">+{viewers.length - MAX_VIEWER_AVATARS}</T> : null}
            <T className="text-[11px] text-white/80">{viewers.length} watching</T>
          </View>
        ) : null}
      </View>

      {/* The room's controls: what anyone presses here, everyone sees. */}
      <View className="gap-1.5 bg-card px-3 pb-2 pt-1.5">
        {hasVideo ? (
          <>
            <View>
              {duration > 0 ? (
                // Reactions where they were made, above the bar.
                <View className="h-4" pointerEvents="none">
                  {reactions.map((r) => (
                    <T
                      key={r.reaction_id}
                      className="absolute text-[11px]"
                      style={{ left: `${Math.min(100, (r.position_secs / duration) * 100)}%`, marginLeft: -6 }}
                    >
                      {r.emoji}
                    </T>
                  ))}
                </View>
              ) : null}
              <Slider
                value={Math.min(sync.display, duration || 14400)}
                min={0}
                max={duration || 14400}
                step={1}
                onChange={(v) => sync.scrub(v)}
                onCommit={(v) => sync.seekTo(v)}
                accessibilityLabel="Position in the video"
              />
            </View>
            <View className="flex-row items-center gap-1">
              <ControlButton label={sync.watch.playing ? "Pause for everyone" : "Play for everyone"} onPress={() => sync.togglePlay()}>
                <Icon as={sync.watch.playing ? Pause : Play} size={20} tone="foreground" />
              </ControlButton>
              <T className="flex-1 text-xs text-muted-foreground">
                {formatTime(sync.display)}
                {duration > 0 ? ` / ${formatTime(duration)}` : ""}
              </T>
              <ControlButton
                label={muted ? "Unmute" : "Mute"}
                onPress={() => {
                  setMuted(!muted);
                  player.current?.setMuted(!muted);
                }}
              >
                <Icon as={muted ? VolumeX : Volume2} size={18} />
              </ControlButton>
              <ControlButton
                label="Catch up with the room"
                onPress={() => void actions.send({ type: "watchparty_request_sync", room_id: roomId, channel_id: channelId })}
              >
                <Icon as={RefreshCw} size={17} />
              </ControlButton>
              <ControlButton label="Change the video" selected={linking} onPress={() => setLinking(!linking)}>
                <Icon as={Link2} size={18} />
              </ControlButton>
            </View>
            {fill ? null : (
              <View className="flex-row items-center gap-1">
                {REACTION_EMOJI.map((emoji) => (
                  <Pressable
                    key={emoji}
                    onPress={() => send({ type: "watchparty_reaction", emoji, position_secs: Math.max(0, sync.display) })}
                    accessibilityRole="button"
                    accessibilityLabel={`React ${emoji}`}
                    className="h-9 w-9 items-center justify-center rounded-full active:bg-accent"
                  >
                    <T className="text-lg">{emoji}</T>
                  </Pressable>
                ))}
                <T className="ml-auto text-2xs text-muted-foreground">
                  {reactions.length} reaction{reactions.length === 1 ? "" : "s"}
                </T>
              </View>
            )}
          </>
        ) : null}
        {/* On its side the picture gets the room: just the bar and the buttons. */}
        {(linking || !hasVideo) && !fill ? (
          <View className="flex-row items-center gap-2">
            <TextInput
              value={link}
              onChangeText={setLink}
              onSubmitEditing={loadLink}
              placeholder="YouTube URL or direct video URL..."
              placeholderTextColor={colors["muted-foreground"]}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              className="h-10 flex-1 rounded-md border border-input px-3 font-mono text-sm text-foreground"
            />
            <Pressable
              onPress={loadLink}
              disabled={!link.trim()}
              accessibilityRole="button"
              className={cn("h-10 items-center justify-center rounded-md bg-primary px-4", !link.trim() && "opacity-50")}
            >
              <T className="text-sm font-medium text-primary-foreground">Load</T>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ControlButton({ label, onPress, selected, children }: { label: string; onPress(): void; selected?: boolean; children: ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn("h-10 w-10 items-center justify-center rounded-md active:bg-accent", selected && "bg-accent")}
    >
      {children}
    </Pressable>
  );
}

/** A reaction rising over the picture and fading, as on the web. */
function FloatingReaction({ emoji, right }: { emoji: string; right: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withTiming(1, { duration: FLOAT_LIFETIME_MS });
  }, [t]);
  const style = useAnimatedStyle(() => ({
    opacity: interpolate(t.value, [0, 0.15, 1], [0, 1, 0]),
    transform: [{ translateY: interpolate(t.value, [0, 0.15, 1], [0, -10, -90]) }, { scale: interpolate(t.value, [0, 0.15, 1], [0.7, 1.1, 1]) }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", bottom: 40, right: 16 + right }, style]}>
      <T className="text-3xl">{emoji}</T>
    </Animated.View>
  );
}
