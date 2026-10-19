import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Two variants, so a development build installs beside a release one:
 *   APP_VARIANT=development  → "Chatter Dev", io.zgaf.chatter.dev, talks to a
 *                              local server over plain http (adb reverse)
 *   (unset)                  → "Chatter", io.zgaf.chatter, https only
 */
const IS_DEV = process.env.APP_VARIANT === "development";

/**
 * Release builds are numbered by CI (.github/workflows/mobile-release.yml):
 * the name from the tag (mobile-v1.2.0 → 1.2.0), the code from the run number,
 * which only ever grows — Android installs an APK over an older one only when
 * its versionCode is higher.
 */
const VERSION = process.env.CHATTER_VERSION ?? "0.1.0";
const VERSION_CODE = Number(process.env.CHATTER_VERSION_CODE ?? "1");

/**
 * The server the sign-in screen offers first. A release offers none: Chatter
 * is self-hosted, and the app is no one server's. A development build offers
 * the local dev server.
 */
const DEFAULT_SERVER = process.env.CHATTER_ORIGIN ?? (IS_DEV ? "http://localhost:8000" : "");

const jetbrains = (weight: string) =>
  `./node_modules/@expo-google-fonts/jetbrains-mono/${weight}/JetBrainsMono_${weight}.ttf`;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? "Chatter Dev" : "Chatter",
  slug: "chatter",
  version: VERSION,
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
    versionCode: VERSION_CODE,
    adaptiveIcon: {
      backgroundColor: "#0a0a0a",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: true,
    // In other apps' share sheets: text, links, pictures and files, one or
    // several (modules/chatter-share takes them from here).
    intentFilters: [
      { action: "SEND", category: ["DEFAULT"], data: [{ mimeType: "*/*" }] },
      { action: "SEND_MULTIPLE", category: ["DEFAULT"], data: [{ mimeType: "*/*" }] },
    ],
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      {
        // Chatter's mark on the app's own background, until the first screen draws.
        image: "./assets/splash-icon.png",
        imageWidth: 160,
        backgroundColor: "#0a0a0a",
        resizeMode: "contain",
      },
    ],
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
          // R8 shrinks and renames release builds, so anything native code
          // finds by name has to be kept. The WebRTC library's own rules keep
          // org.webrtc but not jni_zero, its JNI helper: the native side loads
          // org.jni_zero.JniZero by name at start-up, and with it removed every
          // release build aborted before drawing anything. CxxReactPackage is
          // the one other class native code names that R8 removed. The AV1
          // decoder stub is referred to but not shipped, and only needs R8 to
          // not stop at it.
          extraProguardRules: [
            "-keep class org.jni_zero.** { *; }",
            "-keepclasseswithmembers class * { @org.jni_zero.CalledByNative <methods>; }",
            "-keepclasseswithmembers class * { @org.jni_zero.CalledByNativeUnchecked <methods>; }",
            "-keepclasseswithmembers class * { @org.jni_zero.AccessedByNative <fields>; }",
            "-keep class com.facebook.react.runtime.cxxreactpackage.** { *; }",
            "-dontwarn org.webrtc.Dav1dDecoder$Natives",
          ].join("\n"),
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
    "./plugins/withReleaseSigning",
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    defaultServer: DEFAULT_SERVER,
    isDev: IS_DEV,
  },
});
