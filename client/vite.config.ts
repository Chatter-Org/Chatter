import path from "path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Protocol and state rules shared with the mobile app. Source-only: it is
      // compiled as part of this app, and the Dockerfile copies it alongside.
      "@chatter/core": path.resolve(__dirname, "../packages/core/src"),
    },
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
