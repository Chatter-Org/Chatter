import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CHANGELOG } from "@/changelog.generated";
import { ScreenHeader } from "@/ui/ScreenHeader";
import { T } from "@/ui/primitives";
import { UI_HINT, UI_META } from "@/ui/roles";
import { SettingsSection } from "@/ui/settings";

/**
 * What changed in each version, newest first: CHANGELOG.md, the same notes a
 * release is shared with, read on the phone.
 */
export default function WhatsNew() {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScreenHeader title="What's new" />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} contentContainerClassName="gap-4 p-4">
        {CHANGELOG.map((release) => (
          <SettingsSection
            key={release.version}
            title={release.version === "Unreleased" ? "In development" : `Version ${release.version}`}
            hint={release.date ?? undefined}
          >
            {release.intro ? <T className="text-sm">{release.intro}</T> : null}
            {release.groups.map((group) => (
              <View key={group.title} className="gap-1.5">
                {group.title ? <T className={UI_META}>{group.title}</T> : null}
                {group.items.map((item, i) => (
                  <View key={i} className="flex-row gap-2">
                    <T className={UI_HINT}>•</T>
                    <T className="flex-1 text-sm">{item}</T>
                  </View>
                ))}
              </View>
            ))}
          </SettingsSection>
        ))}
      </ScrollView>
    </View>
  );
}
