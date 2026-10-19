import { useCallback, useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Image } from "expo-image";
import { Directory, File, Paths } from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Trash2 } from "lucide-react-native";
import { formatBytes } from "@chatter/core/utils";
import { updateDevicePrefs, useDevicePrefs } from "@/state/devicePrefs";
import { showToast } from "@/platform/toast";
import { Button, Switch } from "@/ui/controls";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { T } from "@/ui/primitives";
import { UI_HINT } from "@/ui/roles";
import { SettingsSection } from "@/ui/settings";

/**
 * What "Clear cache" may delete: pictures and video already shown, HTTP
 * responses, and files fetched to open or share. Not what the picker copied
 * in — a staged upload still points at it — nor the dev tools' own.
 */
const CLEARABLE = ["image_cache", "image_manager_disk_cache", "ExpoVideoCache", "http-cache", "shared", "downloads"];

function clearable(): Directory[] {
  return CLEARABLE.map((name) => new Directory(Paths.cache, name)).filter((d) => d.exists);
}

/** Bytes under a directory, all the way down. */
function sizeOf(dir: Directory): number {
  let total = 0;
  try {
    for (const entry of dir.list()) {
      if (entry instanceof Directory) total += sizeOf(entry);
      else if (entry instanceof File) total += entry.size ?? 0;
    }
  } catch {
    // Unreadable: counted as nothing.
  }
  return total;
}

/**
 * What the phone plays and fetches by itself, and what it keeps — the
 * settings a phone needs and a browser tab does not. All of it stays on this
 * phone.
 */
export default function DataSettings() {
  const insets = useSafeAreaInsets();
  const prefs = useDevicePrefs();
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  const measure = useCallback(() => {
    setCacheBytes(clearable().reduce((total, dir) => total + sizeOf(dir), 0));
  }, []);
  useEffect(measure, [measure]);

  const clear = async () => {
    setClearing(true);
    try {
      await Image.clearDiskCache();
      await Image.clearMemoryCache();
      for (const dir of clearable()) {
        for (const entry of dir.list()) {
          try {
            entry.delete();
          } catch {
            // In use right now; it goes next time.
          }
        }
      }
      showToast({ message: "Cache cleared" });
    } catch (e) {
      showToast({ tone: "error", message: "Could not clear everything", description: e instanceof Error ? e.message : undefined });
    } finally {
      setClearing(false);
      measure();
    }
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="Data and storage" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-4 p-4">
        <T className={UI_HINT}>These stay on this device rather than on your account, and take effect as soon as you change them.</T>

        <SettingsSection title="Media">
          <Toggle
            label="Play animated pictures"
            hint="GIFs and animated emoji move on their own. Off, they hold still until you open them."
            value={prefs.autoplayAnimated}
            onChange={(autoplayAnimated) => updateDevicePrefs({ autoplayAnimated })}
          />
          <Toggle
            label="Show link previews"
            hint="Fetch a title and picture for links in messages. Off, a link is just the link."
            value={prefs.linkPreviews}
            onChange={(linkPreviews) => updateDevicePrefs({ linkPreviews })}
          />
        </SettingsSection>

        <SettingsSection title="Storage" hint="Pictures and videos already seen, and files you opened or shared. Cleared, they are fetched again when needed.">
          <View className="flex-row items-center justify-between">
            <T className="text-sm">Cached on this device</T>
            <T className="text-sm text-muted-foreground">{cacheBytes === null ? "…" : formatBytes(cacheBytes)}</T>
          </View>
          <Button variant="outline" icon={Trash2} className="self-start" disabled={clearing} onPress={() => void clear()}>
            {clearing ? "Clearing..." : "Clear cache"}
          </Button>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange(value: boolean): void }) {
  return (
    <View className="flex-row items-center gap-3">
      <View className="flex-1 gap-0.5">
        <T className="text-sm">{label}</T>
        <T className={UI_HINT}>{hint}</T>
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}
