// The platform layer has to be in place before any module of the shared core
// loads: it supplies Web Storage, points the API at a server, and gives the
// core its host (see src/platform/install.ts). Only then does the router load
// the app.
import "./src/platform/install";
import "expo-router/entry";
