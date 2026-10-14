import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Where the site is served from.
 *
 * A GitHub Pages project site lives under `/<repo>/`, not at the domain root, so every
 * asset URL Vite writes has to carry that prefix or the deployed page loads a blank
 * screen and a column of 404s. The deploy workflow passes the prefix in from
 * `actions/configure-pages`, which knows it; a local `vite build` sets nothing and gets
 * the root, so `npm run preview` still works. The trailing slash is Vite's requirement.
 */
const base = process.env.BASE_PATH ? `${process.env.BASE_PATH.replace(/\/+$/, '')}/` : '/'

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // Local development against a local API (`npm run api` at the repo root). In
    // production the site calls VITE_API_BASE_URL directly and this is not used.
    proxy: {
      '/api': { target: process.env.VITE_DEV_API_PROXY || 'http://localhost:3001', changeOrigin: true },
    },
    watch: {
      // The repo commonly sits on a bind mount (WSL2, Docker), where inotify events do
      // not cross the boundary: Vite keeps serving the module it first transformed and
      // edits appear to do nothing. Polling costs a little idle CPU and makes the dev
      // server actually reload.
      usePolling: true,
      interval: 300,
    },
  },
})
