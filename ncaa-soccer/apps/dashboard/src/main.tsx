import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { bootstrapData } from './analytics'
import { Boot } from './components/Boot'
import { ErrorBoundary } from './components/ErrorBoundary'
import { AccountProvider } from './auth/account'
import { AuthShell } from './auth/AuthShell'
import { authPageFromPath } from './auth/config'
import { SessionProvider } from './auth/session'
import { parseHash } from './route'
import { preloadView } from './viewLoaders'
// Self-hosted, so the production CSP (style-src/font-src 'self') does not block them.
import '@fontsource-variable/newsreader/opsz.css'
import '@fontsource-variable/newsreader/opsz-italic.css'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/global.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

/**
 * Loads the analytics index before the first render, because every analytics view reads
 * it synchronously. If it is simply not built yet the app still starts; if the API is
 * unreachable the reader is told so rather than shown an empty page.
 */
/** How long startup may wait on the API before the reader is told, rather than left waiting. */
const STARTUP_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Session state for the masthead and the account pages, around everything. */
function withSession(children: React.ReactNode) {
  return (
    <React.StrictMode>
      <SessionProvider>
        <AccountProvider>{children}</AccountProvider>
      </SessionProvider>
    </React.StrictMode>
  )
}

function start() {
  // Account pages (/ncadb/login, /ncadb/profile, …) need no statistics to render, so they
  // do not wait on the analytics index.
  const page = authPageFromPath(window.location.pathname)
  if (page) {
    root.render(withSession(<ErrorBoundary scope="app"><AuthShell page={page} /></ErrorBoundary>))
    return
  }
  root.render(<Boot message="Loading NCAA Division I men’s soccer data…" />)
  // The view's code downloads alongside the analytics index, not after it.
  preloadView(parseHash(window.location.hash, 'overview').view)
  withTimeout(bootstrapData(), STARTUP_TIMEOUT_MS)
    .then(analyticsReady =>
      root.render(
        withSession(
          <ErrorBoundary scope="app">
            <App analyticsReady={analyticsReady} />
          </ErrorBoundary>,
        ),
      ),
    )
    .catch((err: Error) =>
      root.render(
        <Boot
          message={
            err.message === 'timeout'
              ? 'The data service is taking too long to respond.'
              : 'The data service could not be reached.'
          }
          onRetry={start}
        />,
      ),
    )
}

start()
