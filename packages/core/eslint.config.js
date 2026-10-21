import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The core runs in the browser and on a phone. These exist in only one of
// them; anything that needs one goes through `host` (src/platform.ts).
const browserOnly = [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "Notification",
  "indexedDB",
  "Audio",
  "AudioContext",
  "MediaStream",
  "HTMLElement",
  "Image",
].map((name) => ({
  name,
  message: `"${name}" is not available on every platform the core runs on. Go through host (src/platform.ts), or guard with typeof.`,
}));

export default tseslint.config(
  { ignores: ["node_modules"] },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.es2021 },
    },
    rules: {
      "no-restricted-globals": ["error", ...browserOnly],
      // The moved code predates these and is out of scope for this split.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
