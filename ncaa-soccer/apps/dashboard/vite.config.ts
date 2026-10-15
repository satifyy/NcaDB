import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  /**
   * Where the site is served from.
   *
   * A GitHub Pages project site lives under `/<repo>/`, not at the domain root, so every
   * asset URL Vite writes has to carry that prefix or the deployed page loads a blank
   * screen and a column of 404s. The deploy workflow passes the prefix in from
   * `actions/configure-pages`, which knows it; a local `vite build` sets nothing and gets
   * the root, so `npm run preview` still works. The trailing slash is Vite's requirement.
   */
  const basePath = env.BASE_PATH || process.env.BASE_PATH
  const base = basePath ? `${basePath.replace(/\/+$/, '')}/` : '/'

  return {
    base,
    plugins: [react()],
    build: {
      // Small font subsets would otherwise be inlined as data: URIs, which the production
      // CSP (font-src 'self') blocks. Fonts always ship as files.
      assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    },
    server: {
      // Local development against a local API (`npm run api` at the repo root) or proxied
      // to a remote API. In production the site calls VITE_API_BASE_URL directly and this is not used.
      proxy: {
        '/api': {
          target: env.VITE_DEV_API_PROXY || process.env.VITE_DEV_API_PROXY || 'http://localhost:3001',
          changeOrigin: true,
          secure: false,
        },
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
  }
})
