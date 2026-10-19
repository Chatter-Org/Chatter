import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Two variants, so a development build installs beside a release one:
 *   APP_VARIANT=development  → "Chatter Dev", io.zgaf.chatter.dev, talks to a
 *                              local server over plain http (adb reverse)
 *   (unset)                  → "Chatter", io.zgaf.chatter, https only
 */
const IS_DEV = process.env.APP_VARIANT === "development";

/** The server the sign-in screen offers first. Anyone self-hosting types their own. */
const DEFAULT_SERVER =
  process.env.CHATTER_ORIGIN ?? (IS_DEV ? "http://localhost:8000" : "https://chatter.zgaf.io");

const jetbrains = (weight: string) =>
  `./node_modules/@expo-google-fonts/jetbrains-mono/${weight}/JetBrainsMono_${weight}.ttf`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? "Chatter Dev" : "Chatter",
  slug: "chatter",
  version: "0.1.0",
  scheme: IS_DEV ? "chatter-dev" : "chatter",
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#0a0a0a",
  ios: {
    supportsTablet: true,
    bundleIdentifier: IS_DEV ? "io.zgaf.chatter.dev" : "io.zgaf.chatter",
  },
  android: {
    package: IS_DEV ? "io.zgaf.chatter.dev" : "io.zgaf.chatter",
    adaptiveIcon: {
      backgroundColor: "#0a0a0a",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: true,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sqlite",
    [
      "expo-font",
      {
        // Embedded in the native build: no asset round-trip before first paint.
        fonts: [jetbrains("400Regular"), jetbrains("500Medium"), jetbrains("700Bold")],
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          // Only a development build may talk to a local server over http.
          usesCleartextTraffic: IS_DEV,
        },
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Chatter needs your photos to send them in a conversation.",
        cameraPermission: "Chatter uses the camera to take photos and videos to send.",
        microphonePermission: "Chatter uses the microphone when you record a video to send.",
      },
    ],
    ["expo-video", { supportsPictureInPicture: true, supportsBackgroundPlayback: true }],
    "expo-audio",
    [
      "expo-notifications",
      {
        // The web's push badge: a white chat bubble Android tints itself.
        icon: "./assets/notification-icon.png",
        color: "#0a0a0a",
      },
    ],
    [
      "@config-plugins/react-native-webrtc",
      {
        cameraPermission: "Chatter uses the camera for video in calls.",
        microphonePermission: "Chatter uses the microphone for voice chat.",
      },
    ],
    "./plugins/withLongPathCmake",
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    defaultServer: DEFAULT_SERVER,
    isDev: IS_DEV,
  },
});
