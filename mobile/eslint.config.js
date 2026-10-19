// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // Build output and files a tool writes: `expo prebuild` makes android/,
    // Gradle fills each local module's android/build, Uniwind writes its
    // className types and `npm run port-theme` the theme table. A fix to any
    // of them belongs in whatever generates it.
    ignores: [
      "dist/*",
      ".expo/*",
      "android/*",
      "modules/*/android/build/*",
      "expo-env.d.ts",
      "src/uniwind-types.d.ts",
      "src/theme/themes.generated.ts",
    ],
  },
  {
    rules: {
      // Apostrophes and quotes in copy ("Can't reach the server") are text,
      // and read better as themselves than as &apos;. A stray > or } is still
      // most likely a broken tag or expression, so those stay errors.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
    },
  },
]);
