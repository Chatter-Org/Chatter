/**
 * Builds on Windows need a CMake whose bundled ninja understands long paths.
 *
 * New Architecture modules (react-native-worklets, gesture-handler's codegen)
 * put their object files under paths that embed the project path twice, past
 * Windows' 260-character limit. Turning on Win32 long paths is necessary but
 * not enough: the SDK's default CMake 3.22 ships ninja 1.10, which ignores the
 * setting. CMake 3.31+ ships ninja 1.12, which honours it.
 *
 * `externalNativeBuild.cmake.version` cannot be forced for every module (some
 * are configured before a root build script runs), so this writes `cmake.dir`
 * into the generated android/local.properties, which every module reads. It
 * picks the newest CMake ≥ 3.31 installed in the SDK, and does nothing off
 * Windows or when none is installed — install one with:
 *   sdkmanager "cmake;3.31.6"
 */
const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

function sdkRoot() {
  return (
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk"))
  );
}

function newestLongPathCmake(sdk) {
  const dir = path.join(sdk, "cmake");
  if (!fs.existsSync(dir)) return null;
  const versions = fs
    .readdirSync(dir)
    .map((v) => ({ v, parts: v.split(".").map(Number) }))
    .filter(({ parts }) => parts.length >= 2 && (parts[0] > 3 || (parts[0] === 3 && parts[1] >= 31)))
    .sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || (b.parts[2] ?? 0) - (a.parts[2] ?? 0));
  return versions.length ? path.join(dir, versions[0].v) : null;
}

module.exports = function withLongPathCmake(config) {
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      if (process.platform !== "win32") return cfg;
      const sdk = sdkRoot();
      const cmake = sdk && newestLongPathCmake(sdk);
      if (!cmake) {
        console.warn("withLongPathCmake: no CMake ≥ 3.31 in the Android SDK; a Windows build may hit the path limit.");
        return cfg;
      }
      const file = path.join(cfg.modRequest.platformProjectRoot, "local.properties");
      const slash = (p) => p.replace(/\\/g, "/");
      const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
      const keep = lines.filter((l) => l && !l.startsWith("cmake.dir=") && !l.startsWith("sdk.dir="));
      keep.push(`sdk.dir=${slash(sdk)}`, `cmake.dir=${slash(cmake)}`);
      fs.writeFileSync(file, keep.join("\n") + "\n");
      return cfg;
    },
  ]);
};
