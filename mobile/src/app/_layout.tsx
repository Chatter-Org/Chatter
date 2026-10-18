import "../global.css";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChatterProvider, useChatter } from "@/state/ChatterProvider";
import { ThemeProvider, useTheme } from "@/theme/ThemeProvider";
import { ToastHost } from "@/components/ToastHost";
import { SessionGate } from "@/components/SessionGate";

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
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={mode === "light" ? "dark" : "light"} />
      <SessionGate>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background }, animation: "default" }}>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="index" />
            <Stack.Screen name="settings" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="thread" options={{ animation: "slide_from_right" }} />
            <Stack.Screen name="panel" options={{ animation: "slide_from_right" }} />
          </Stack.Protected>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
        </Stack>
      </SessionGate>
      <ToastHost />
    </View>
  );
}
