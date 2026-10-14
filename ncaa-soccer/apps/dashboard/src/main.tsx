import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { bootstrapData } from './analytics'
import { Boot } from './components/Boot'
import { ErrorBoundary } from './components/ErrorBoundary'
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

function start() {
  root.render(<Boot message="Loading NCAA Division I men’s soccer data…" />)
  withTimeout(bootstrapData(), STARTUP_TIMEOUT_MS)
    .then(analyticsReady =>
      root.render(
        <React.StrictMode>
          <ErrorBoundary scope="app">
            <App analyticsReady={analyticsReady} />
          </ErrorBoundary>
        </React.StrictMode>,
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
