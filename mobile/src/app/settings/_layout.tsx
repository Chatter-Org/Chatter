import { Stack } from "expo-router";
import { useTheme } from "@/theme/ThemeProvider";

/** Settings and its sections: a stack of its own, each sliding in from the
 *  side as a phone's settings do. */
export default function SettingsLayout() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: "slide_from_right" }} />;
}
