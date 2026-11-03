import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Workers are started as modules (streamer mode's), as in the dev server.
  worker: { format: 'es' },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Protocol and state rules shared with the mobile app. Source-only: it is
      // compiled as part of this app, and the Dockerfile copies it alongside.
      "@chatter/core": path.resolve(__dirname, "../packages/core/src"),
    },
    // The core's npm imports resolve from this app, which installs them: the
    // Docker image copies the core's source and nothing else.
    dedupe: ["@noble/ciphers", "@noble/curves", "@noble/hashes"],
  },
  server: {
    fs: {
      // The core lives beside the client, outside Vite's root.
      allow: [__dirname, path.resolve(__dirname, "../packages/core")],
    },
    proxy: {
      '/_matrix': 'http://localhost:8000',
      '/api': 'http://localhost:8000',
      '/external': 'http://localhost:8000',
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true,
      },
    },
  },
})
