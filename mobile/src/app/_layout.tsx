import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChatterProvider, useChatter } from "@/state/ChatterProvider";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";
import { AppearanceSync } from "@/theme/AppearanceSync";
import { useReadingColumn } from "@/ui/windowLayout";
import { ToastHost } from "@/components/ToastHost";
import { SessionGate } from "@/components/SessionGate";
import { ProfileProvider } from "@/components/ProfileSheet";

/** Screens that lay out the whole window themselves rather than a reading column. */
const FULL_WIDTH = new Set(["index", "sign-in"]);

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ThemeProvider>
            <ChatterProvider>
              <Root />
            </ChatterProvider>
          </ThemeProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Root() {
  const { mode, colors } = useTheme();
  const state = useChatter();
  const signedIn = !!state.accessToken;
  const column = useReadingColumn();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={mode === "light" ? "dark" : "light"} />
      <AppearanceSync />
      <SessionGate>
        <ProfileProvider>
        <Stack
          screenOptions={({ route }) => ({
            headerShown: false,
            // A pushed screen (settings, a post, the events) is a column, not
            // the full width of a tablet; the shell keeps the whole window, and
            // sign-in centres its own card over a backdrop that fills it.
            contentStyle: { backgroundColor: colors.background, ...(FULL_WIDTH.has(route.name) ? null : column) },
            animation: "default",
          })}
        >
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" />
            <Stack.Screen name="settings" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="thread" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="panel" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="profile" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="friends" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="people" options={{ animation: "slide_from_bottom" }} />
            <Stack.Screen name="poll" options={{ animation: "slide_from_bottom" }} />
            <Stack.Screen name="events" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="event-edit" options={{ animation: "slide_from_bottom" }} />
            <Stack.Screen name="forum-post" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="forum-new" options={{ animation: "slide_from_bottom" }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
        </Stack>
        </ProfileProvider>
      </SessionGate>
      <ToastHost />
    </View>
  );
}
