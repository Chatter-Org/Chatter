# Chatter mobile

The Android (later iOS) client for Chatter. See ROADMAP.md for what is done
and what is next.

## How it is built

- **Shared logic lives in `../packages/core`** (imported as `@chatter/core/*`):
  the API, the store (reducer, socket handler, actions), the message format.
  The web client runs the same files. A fix to how a room loads or a message
  parses is made there, once. Anything platform-specific goes through `host`
  (`packages/core/src/platform.ts`); this app's implementation is
  `src/platform/host.ts`.
- **`src/platform/`** is the phone's side: Web Storage (expo-sqlite), the
  refresh token in the Keystore, the chosen server, toasts, the event bus.
  `install.ts` runs before anything else (see `index.ts`).
- **`src/state/ChatterProvider.tsx`** is the store plus a phone's lifecycle
  (restore from Keystore, socket on foreground/background). It adds no
  actions of its own beyond sign-in/out: new actions go in core.
- **Styling is Uniwind** (Tailwind 4): use the web's classNames (`bg-card`,
  `text-muted-foreground`). Colours come from `src/theme/themes.css`,
  generated from `client/src/index.css` by `npm run port-theme` — never hand
  edit it. Text goes through `T` (`src/ui/primitives.tsx`) for the font.
- **Gestures** use react-native-gesture-handler v3's hook API
  (`usePanGesture`, `GestureDetector`). Rightward swipes belong to the panels,
  leftward ones to messages (swipe to reply) unless they start at the edge.

## Building on Windows

Long paths must be enabled, and a CMake ≥ 3.31 installed in the SDK
(`sdkmanager "cmake;3.31.6"`); `plugins/withLongPathCmake.js` points the
build at it. Build the dev variant with `APP_VARIANT=development`.

## Testing against a server

Never point development at a server other people use. `scripts/dev-backend.ps1`
runs a private one (its own MongoDB on :27018); `scripts/seed-dev.mts` fills
it. Test accounts live in `~/.chatter-dev/test-accounts.json`, outside the repo.

---

This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
