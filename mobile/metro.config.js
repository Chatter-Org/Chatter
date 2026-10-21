// Learn more https://docs.expo.dev/guides/customizing-metro
const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, "../packages/core");
const coreSrc = path.join(coreRoot, "src");

const config = getDefaultConfig(projectRoot);

// ─── @chatter/core ───────────────────────────────────────────────────────────
//
// The protocol and state rules shared with the web client live beside this app
// as plain source (packages/core). Metro watches that folder and resolves
// `@chatter/core/<path>` to its files; anything they import from npm resolves
// from this app's node_modules, never the core's (which holds only its test
// tooling), so there is one React Native and one of everything else.
config.watchFolders = [...(config.watchFolders ?? []), coreSrc];
config.resolver.nodeModulesPaths = [path.join(projectRoot, "node_modules")];
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  new RegExp(`${escape(path.join(coreRoot, "node_modules"))}.*`),
  new RegExp(`${escape(coreSrc)}.*__tests__.*`),
];

function escape(p) {
  return p.replace(/[/\\]/g, "[/\\\\]").replace(/[.*+?^${}()|]/g, "\\$&");
}

// ─── Styling ─────────────────────────────────────────────────────────────────
//
// Uniwind compiles Tailwind classNames at build time. The web's classNames
// (bg-card, text-muted-foreground, border-border) mean the same thing here
// because src/theme/themes.css declares the same tokens for every theme.
const themeIds = require("./src/theme/theme-ids.json");
const styled = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
  extraThemes: themeIds.filter((id) => id !== "light" && id !== "dark"),
  dtsFile: "./src/uniwind-types.d.ts",
  // The web's root font size (client/src/index.css): 1rem is 17.6px there, so
  // every Tailwind size is a tenth larger than stock. The same here keeps a
  // className meaning the same size on both.
  polyfills: { rem: 17.6 },
});

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Let modules that need what Uniwind's `react-native` shim leaves out reach the
 * real package.
 *
 * Uniwind redirects every `import … from "react-native"` to its own
 * `uniwind/components`, a hand-written list of getters. React Native 0.88
 * exports names the list does not — `AssetRegistry` among them — so
 * expo-asset's `import { AssetRegistry } from "react-native"` would come back
 * undefined and every bundled font and image would fail to load ("Cannot read
 * property 'getAssetByID' of undefined").
 *
 * Rather than hard-code expo-asset, the gap is computed: real exports minus
 * shim exports. A module that mentions one of the missing names gets the real
 * `react-native`; every other import still goes through the shim, so
 * `className` keeps working. When the shim catches up the set is empty and
 * this does nothing.
 */
const getterNames = (file) =>
  new Set([...fs.readFileSync(file, "utf8").matchAll(/\bget (\w+)\(/g)].map((m) => m[1]));
const packageDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const rnExports = getterNames(path.join(packageDir("react-native"), "index.js"));
const shimExports = getterNames(path.join(packageDir("uniwind"), "dist/module/components/index.js"));
const missingFromShim = [...rnExports].filter((name) => !shimExports.has(name));
const missingPattern = missingFromShim.length ? new RegExp(`\\b(${missingFromShim.join("|")})\\b`) : null;

const needsRealReactNative = new Map();
function importerNeedsRealReactNative(file) {
  if (!missingPattern || !file) return false;
  let needs = needsRealReactNative.get(file);
  if (needs === undefined) {
    try {
      needs = missingPattern.test(fs.readFileSync(file, "utf8"));
    } catch {
      needs = false;
    }
    needsRealReactNative.set(file, needs);
  }
  return needs;
}

const styledResolve = styled.resolver.resolveRequest;
styled.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@chatter/core/")) {
    const target = path.join(coreSrc, moduleName.slice("@chatter/core/".length));
    return context.resolveRequest(context, target, platform);
  }
  if (moduleName === "react-native" && importerNeedsRealReactNative(context.originModulePath)) {
    return context.resolveRequest(context, moduleName, platform);
  }
  return styledResolve
    ? styledResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = styled;
