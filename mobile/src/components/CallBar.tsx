import { memo, useEffect, useState } from "react";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { GestureDetector, usePanGesture, useTapGesture, useSimultaneousGestures } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import {
  Bluetooth,
  ChevronUp,
  HeadphoneOff,
  Headphones,
  Hand,
  Mic,
  MicOff,
  PhoneOff,
  Smartphone,
  Volume2,
  VolumeX,
} from "lucide-react-native";
import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react-native";
import { displayUserId } from "@chatter/core/utils";
import { readProfileAccent, speakingStyle } from "@chatter/core/profileTheme";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { useSpeaking } from "@/voice/speaking";
import { useAudioRoutes } from "@/voice/useCallService";
import { callService, type AudioRoute } from "../../modules/chatter-call";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";
import { cn } from "@/ui/cn";
import { useTheme } from "@/theme/ThemeProvider";
import Svg, { Rect } from "react-native-svg";
import type { ConnectionQuality } from "@chatter/core/voice/quality";
import { useCallQuality } from "@/voice/quality";

/**
 * The call, on a phone: the web's MobileCallBar and its sheet, natively.
 *
 * A strip along the bottom, under the composer as on the web, there whatever
 * channel is open: how good the connection is, the channel and how long the
 * call has run, and the three controls a thumb wants without looking (mute,
 * deafen, leave). Tapping the strip brings up the sheet behind it: everyone
 * in the call, who is talking, a volume for each, and the controls again
 * with their words underneath.
 */
export function CallBar({ bottomInset = 0, onHeight }: { bottomInset?: number; onHeight?(height: number): void }) {
  const state = useChatter();
  const { voice, selectRoom, selectChannel } = useChatterActions();
  const [sheetOpen, setSheetOpen] = useState(false);
  const quality = useCallQuality(state.inVoiceChannel, voice.peer);

  if (!state.inVoiceChannel) return null;
  const room = state.voiceRoomId ? state.roomInfoMap[state.voiceRoomId] : undefined;
  const since = state.voiceChannelId ? state.voiceChannelOccupiedSince[state.voiceChannelId] : undefined;
  const silenced = state.isMuted || state.isDeafened;
  const status = callStatus(state.voicePublisherState);

  // The call's text channel is where its chat is; take the reader there.
  const goToCall = async () => {
    if (!state.voiceRoomId) return;
    if (state.currentRoomId !== state.voiceRoomId) await selectRoom(state.voiceRoomId).catch(() => {});
    if (state.voiceChannelId) await selectChannel(state.voiceChannelId).catch(() => {});
  };

  return (
    <>
      <View
        className="flex-row items-center gap-1 border-t border-border bg-card px-2 pt-1.5"
        style={{ paddingBottom: Math.max(6, bottomInset) }}
        onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}
      >
        <Pressable
          onPress={() => setSheetOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Call details"
          className="min-h-11 flex-1 flex-row items-center gap-2 rounded-md px-2 active:bg-accent"
        >
          <SignalBars quality={quality} />
          <View className="min-w-0 flex-1">
            <T numberOfLines={1} className="text-sm font-medium text-success">
              {state.voiceChannelName ?? "Voice"}
            </T>
            <T numberOfLines={1} className={cn("text-3xs", status.connected ? "text-muted-foreground" : STATUS_TEXT[status.tone])}>
              {status.connected && since ? <CallTimer since={since} /> : status.label}
              {room?.name ? ` · ${room.name}` : ""}
            </T>
          </View>
          <Icon as={ChevronUp} size={16} />
        </Pressable>
        {state.voiceInputMode === "ptt" ? (
          <TalkButton disabled={state.isDeafened} talking={!state.isMuted} onTalk={voice.setTransmitting} />
        ) : (
          <BarButton
            icon={silenced ? MicOff : Mic}
            label={silenced ? "Unmute" : "Mute"}
            danger={silenced}
            disabled={state.isDeafened}
            onPress={voice.toggleMute}
          />
        )}
        <BarButton
          icon={state.isDeafened ? HeadphoneOff : Headphones}
          label={state.isDeafened ? "Undeafen" : "Deafen"}
          danger={state.isDeafened}
          onPress={voice.toggleDeafen}
        />
        <BarButton icon={PhoneOff} label="Leave call" hangup onPress={() => void voice.leave()} />
      </View>
      <CallSheet open={sheetOpen} onClose={() => setSheetOpen(false)} onGoToCall={goToCall} quality={quality} />
    </>
  );
}

function callStatus(s: RTCPeerConnectionState): { label: string; tone: StatusTone; connected: boolean } {
  if (s === "connected") return { label: "Voice connected", tone: "success", connected: true };
  if (s === "failed") return { label: "Connection failed", tone: "destructive", connected: false };
  if (s === "disconnected") return { label: "Reconnecting…", tone: "warning", connected: false };
  return { label: "Connecting…", tone: "warning", connected: false };
}

type StatusTone = "success" | "warning" | "destructive";
const STATUS_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

/** The web's four signal bars, lit to the measured quality. */
function SignalBars({ quality }: { quality: ConnectionQuality }) {
  const { colors } = useTheme();
  const color = [colors["muted-foreground"], colors.destructive, "#ff8904", colors.success, colors.success][quality];
  return (
    <Svg width={14} height={12} viewBox="0 0 16 14">
      <Rect x={0} y={10} width={3} height={4} rx={0.5} fill={color} opacity={quality >= 1 ? 1 : 0.3} />
      <Rect x={4.5} y={7} width={3} height={7} rx={0.5} fill={color} opacity={quality >= 2 ? 1 : 0.3} />
      <Rect x={9} y={3.5} width={3} height={10.5} rx={0.5} fill={color} opacity={quality >= 3 ? 1 : 0.3} />
      <Rect x={13} y={0} width={3} height={14} rx={0.5} fill={color} opacity={quality >= 4 ? 1 : 0.3} />
    </Svg>
  );
}


function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const total = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return <>{h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`}</>;
}

function BarButton({
  icon,
  label,
  onPress,
  danger,
  hangup,
  disabled,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  onPress(): void;
  danger?: boolean;
  hangup?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn(
        "h-11 w-11 items-center justify-center rounded-md",
        hangup ? "bg-destructive" : danger ? "bg-destructive/15" : "bg-secondary",
        disabled && "opacity-40",
      )}
    >
      <Icon as={icon} size={20} color={hangup ? "#fff" : undefined} tone={danger ? "destructive" : "secondary-foreground"} />
    </Pressable>
  );
}

/** Push-to-talk: the mic is open for as long as this is held. */
function TalkButton({ talking, disabled, onTalk }: { talking: boolean; disabled?: boolean; onTalk(on: boolean): void }) {
  return (
    <Pressable
      onPressIn={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onTalk(true);
      }}
      onPressOut={() => onTalk(false)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Hold to talk"
      className={cn(
        "h-11 flex-row items-center gap-1.5 rounded-md px-3",
        talking ? "bg-success/20" : "bg-secondary",
        disabled && "opacity-40",
      )}
    >
      <Icon as={talking ? Mic : MicOff} size={18} tone={talking ? "success" : "secondary-foreground"} />
      <T className={cn("text-xs", talking ? "text-success" : "text-secondary-foreground")}>Talk</T>
    </Pressable>
  );
}

// ─── The sheet ───────────────────────────────────────────────────────────────

function CallSheet({
  open,
  onClose,
  onGoToCall,
  quality,
}: {
  open: boolean;
  onClose(): void;
  onGoToCall(): void;
  quality: ConnectionQuality;
}) {
  const state = useChatter();
  const { voice } = useChatterActions();
  const { height } = useWindowDimensions();
  const speaking = useSpeaking(open, state.userId, voice.isSpeaking);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  const room = state.voiceRoomId ? state.roomInfoMap[state.voiceRoomId] : undefined;
  const members = (state.voiceChannelId && state.voiceChannelMembers[state.voiceChannelId]?.map((m) => m.userId)) || state.voiceMembers;
  const silenced = state.isMuted || state.isDeafened;
  const routes = useAudioRoutes(open);
  const route = routes.find((r) => r.active) ?? routes[0];

  // One tap moves to the next way of hearing the call; with only a speaker
  // and an earpiece that is the familiar speakerphone toggle.
  const nextRoute = () => {
    if (routes.length < 2 || !route) return;
    const next = routes[(routes.indexOf(route) + 1) % routes.length];
    callService.setRoute(next.id);
  };

  const setVolume = (userId: string, volume: number) => {
    setVolumes((v) => ({ ...v, [userId]: volume }));
    voice.setUserVolume(userId, volume);
  };

  return (
    <Sheet open={open} onClose={onClose}>
      <Pressable
        onPress={() => {
          onClose();
          onGoToCall();
        }}
        accessibilityRole="button"
        accessibilityLabel="Go to the call's channel"
        className="flex-row items-center gap-2 px-4 pb-3"
      >
        <SignalBars quality={quality} />
        <View className="min-w-0 flex-1">
          <T numberOfLines={1} className="font-mono-bold text-sm text-success">
            {state.voiceChannelName ?? "Voice"}
          </T>
          <T numberOfLines={1} className="text-xs text-muted-foreground">
            {room?.name ?? ""}
          </T>
        </View>
        <View className="rounded-full bg-secondary px-2 py-0.5">
          <T className="text-[11px] text-muted-foreground">{members.length}</T>
        </View>
      </Pressable>

      <ScrollView style={{ maxHeight: height * 0.45 }} className="border-t border-border" contentContainerClassName="px-2 py-1">
        {members.map((id) => (
          <Participant
            key={id}
            userId={id}
            isSelf={id === state.userId}
            speaking={speaking.has(id)}
            volume={volumes[id] ?? 1}
            volumeOpen={volumeFor === id}
            onToggleVolume={() => setVolumeFor((v) => (v === id ? null : id))}
            onVolume={(v) => setVolume(id, v)}
          />
        ))}
      </ScrollView>

      <View className="flex-row items-start gap-1 border-t border-border px-3 pt-3">
        {state.voiceInputMode === "ptt" ? null : (
          <CallAction
            icon={silenced ? MicOff : Mic}
            label={silenced ? "Unmute" : "Mute"}
            tone={silenced ? "danger" : "neutral"}
            disabled={state.isDeafened}
            onPress={voice.toggleMute}
          />
        )}
        <CallAction
          icon={state.isDeafened ? HeadphoneOff : Headphones}
          label={state.isDeafened ? "Undeafen" : "Deafen"}
          tone={state.isDeafened ? "danger" : "neutral"}
          onPress={voice.toggleDeafen}
        />
        <CallAction
          icon={state.voiceInputMode === "ptt" ? Hand : Mic}
          label={state.voiceInputMode === "ptt" ? "Push to talk" : "Open mic"}
          tone="neutral"
          onPress={voice.toggleInputMode}
        />
        {route ? (
          <CallAction
            icon={ROUTE_ICON[route.id]}
            label={route.label}
            tone="neutral"
            disabled={routes.length < 2}
            onPress={nextRoute}
          />
        ) : null}
        <CallAction
          icon={PhoneOff}
          label="Leave"
          tone="hangup"
          onPress={() => {
            onClose();
            void voice.leave();
          }}
        />
      </View>
    </Sheet>
  );
}

const ROUTE_ICON: Record<AudioRoute["id"], ComponentType<LucideProps>> = {
  speaker: Volume2,
  earpiece: Smartphone,
  wired: Headphones,
  bluetooth: Bluetooth,
};

const Participant = memo(function Participant({
  userId,
  isSelf,
  speaking,
  volume,
  volumeOpen,
  onToggleVolume,
  onVolume,
}: {
  userId: string;
  isSelf: boolean;
  speaking: boolean;
  volume: number;
  volumeOpen: boolean;
  onToggleVolume(): void;
  onVolume(volume: number): void;
}) {
  const state = useChatter();
  const { colors } = useTheme();
  const presence = state.userPresence[userId];
  const name = presence?.displayName || displayUserId(userId);
  const flags = state.voiceMemberStates[userId];
  // Deafening also closes the mic, so a deafened person is never an open mic.
  const deafened = flags?.deafened || (isSelf && state.isDeafened);
  const muted = deafened || flags?.muted || (isSelf && state.isMuted);
  const talking = speaking && !muted;
  const accent = talking ? speakingStyle(readProfileAccent(presence), "")?.color : undefined;
  const ring = talking ? (accent ?? colors.success) : "transparent";

  return (
    <View className="px-2 py-1">
      <View className="flex-row items-center gap-3">
        <View style={{ borderRadius: 999, borderWidth: 2, borderColor: ring, padding: 1 }}>
          <Avatar userId={userId} name={name} url={presence?.avatarUrl} size={36} />
        </View>
        <View className="min-w-0 flex-1">
          <T
            numberOfLines={1}
            className={cn("text-sm", talking && "font-mono-bold", talking && !accent && "text-success")}
            style={accent ? { color: accent } : undefined}
          >
            {name}
            {isSelf ? <T className="text-muted-foreground"> (You)</T> : null}
          </T>
          <View className="flex-row items-center gap-1">
            <Icon as={deafened ? HeadphoneOff : muted ? MicOff : Mic} size={12} tone={muted ? "destructive" : "success"} />
            <T className="text-[11px] text-muted-foreground">{deafened ? "Deafened" : muted ? "Muted" : "Open"}</T>
          </View>
        </View>
        {!isSelf ? (
          <Pressable
            onPress={onToggleVolume}
            accessibilityRole="button"
            accessibilityLabel={`Volume for ${name}`}
            accessibilityState={{ expanded: volumeOpen }}
            className={cn("h-11 w-11 items-center justify-center rounded-md", (volumeOpen || volume === 0) && "bg-secondary")}
          >
            <Icon as={volume === 0 ? VolumeX : Volume2} size={18} tone={volumeOpen ? "foreground" : "muted-foreground"} />
          </Pressable>
        ) : null}
      </View>
      {volumeOpen && !isSelf ? (
        <View className="flex-row items-center gap-3 py-2 pl-12 pr-1">
          <VolumeSlider value={volume} max={1.5} onChange={onVolume} label={`Volume for ${name}`} />
          <T className="w-11 text-right text-[11px] text-muted-foreground">{Math.round(volume * 100)}%</T>
        </View>
      ) : null}
    </View>
  );
});

/** A round button with its word underneath, as on the web's call sheet. */
function CallAction({
  icon,
  label,
  onPress,
  tone,
  disabled,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  onPress(): void;
  tone: "neutral" | "danger" | "hangup";
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className={cn("flex-1 items-center gap-1.5", disabled && "opacity-40")}
    >
      <View
        className={cn(
          "h-14 w-14 items-center justify-center rounded-full",
          tone === "hangup" ? "bg-destructive" : tone === "danger" ? "bg-destructive/20" : "bg-secondary",
        )}
      >
        <Icon
          as={icon}
          size={24}
          color={tone === "hangup" ? "#fff" : undefined}
          tone={tone === "danger" ? "destructive" : "secondary-foreground"}
        />
      </View>
      <T className="text-[11px] text-muted-foreground">{label}</T>
    </Pressable>
  );
}

/** A horizontal slider: drag or tap along the track. */
function VolumeSlider({ value, max, onChange, label }: { value: number; max: number; onChange(v: number): void; label: string }) {
  const [width, setWidth] = useState(1);
  const fraction = useSharedValue(value / max);
  useEffect(() => {
    fraction.value = value / max;
  }, [value, max, fraction]);

  const set = (x: number) => {
    "worklet";
    const f = Math.min(1, Math.max(0, x / width));
    // Snap to 100% when close: the level most people come back to.
    const snapped = Math.abs(f * max - 1) < 0.04 ? 1 / max : f;
    fraction.value = snapped;
    scheduleOnRN(onChange, Math.round(snapped * max * 100) / 100);
  };
  const pan = usePanGesture({
    activeOffsetX: [-4, 4],
    onUpdate: (e) => {
      "worklet";
      set(e.x);
    },
  });
  const tap = useTapGesture({
    onActivate: (e) => {
      "worklet";
      set(e.x);
    },
  });
  const gesture = useSimultaneousGestures(pan, tap);
  const fill = useAnimatedStyle(() => ({ width: `${fraction.value * 100}%` }));
  const thumb = useAnimatedStyle(() => ({ left: fraction.value * width - 10 }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        className="h-8 flex-1 justify-center"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: Math.round(max * 100), now: Math.round(value * 100) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) =>
          onChange(Math.min(max, Math.max(0, value + (e.nativeEvent.actionName === "increment" ? 0.1 : -0.1))))
        }
      >
        <View className="h-1.5 overflow-hidden rounded-full bg-secondary">
          <Animated.View className="h-full bg-primary" style={fill} />
        </View>
        <Animated.View className="absolute h-5 w-5 rounded-full border-2 border-primary bg-background" style={thumb} />
      </View>
    </GestureDetector>
  );
}
