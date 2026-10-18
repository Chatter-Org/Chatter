import { Pressable, View } from "react-native";
import { Bell, BellOff, BellRing, Check, type LucideProps } from "lucide-react-native";
import type { ComponentType } from "react";
import { resolveNotificationLevel, settingsKey, type NotificationLevel } from "@chatter/core/notifications";
import { useChatter, useChatterActions } from "@/state/ChatterProvider";
import { Sheet } from "@/ui/Sheet";
import { Icon, T } from "@/ui/primitives";

const LEVELS: { value: NotificationLevel; label: string; hint: string; icon: ComponentType<LucideProps> }[] = [
  { value: "all", label: "All messages", hint: "Notify for every message", icon: BellRing },
  { value: "mentions", label: "Only @mentions", hint: "Notify when you're mentioned", icon: Bell },
  { value: "none", label: "Nothing", hint: "Never notify", icon: BellOff },
];

/**
 * How loud a channel (or, without one, its room) is — the web's
 * NotificationSettingsPopover as a sheet. A channel can also follow the room,
 * which is the absence of a setting rather than one of the three.
 */
export function NotificationSheet({ open, onClose, channelId }: { open: boolean; onClose(): void; channelId?: string }) {
  const state = useChatter();
  const { setNotificationLevel } = useChatterActions();
  const roomId = state.currentRoomId;
  if (!roomId) return null;
  const effective = resolveNotificationLevel(state.notificationSettings, roomId, channelId);
  const hasOverride = state.notificationSettings[settingsKey(roomId, channelId ?? "")] !== undefined;
  const apply = (level: NotificationLevel | "default") => {
    void setNotificationLevel(roomId, level, channelId).catch(() => {});
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={channelId ? "Channel notifications" : "Room notifications"}>
      <View className="pb-2 pt-1">
        {channelId ? <Choice label="Use room default" selected={!hasOverride} onPress={() => apply("default")} /> : null}
        {LEVELS.map(({ value, label, hint, icon }) => (
          <Choice
            key={value}
            label={label}
            hint={hint}
            icon={icon}
            // Inherited from the room, nothing here is chosen.
            selected={channelId ? hasOverride && effective === value : effective === value}
            onPress={() => apply(value)}
          />
        ))}
      </View>
    </Sheet>
  );
}

function Choice({
  label,
  hint,
  icon,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  icon?: ComponentType<LucideProps>;
  selected: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityHint={hint}
      className="flex-row items-center gap-3 px-4 py-3 active:bg-accent"
    >
      <View className="w-4 items-center">{selected ? <Icon as={Check} size={15} tone="foreground" /> : null}</View>
      <View className="flex-1">
        <T className="text-sm">{label}</T>
        {hint ? <T className="text-2xs text-muted-foreground/80">{hint}</T> : null}
      </View>
      {icon ? <Icon as={icon} size={15} /> : null}
    </Pressable>
  );
}
