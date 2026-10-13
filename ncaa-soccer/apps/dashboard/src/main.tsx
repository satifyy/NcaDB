import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import { bootstrapData } from './analytics'
import { Boot } from './components/Boot'
import './styles/global.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)

/**
 * Loads the analytics index before the first render, because every analytics view reads
 * it synchronously. If it is simply not built yet the app still starts; if the API is
 * unreachable the reader is told so rather than shown an empty page.
 */
function start() {
  root.render(<Boot message="Loading…" />)
  bootstrapData()
    .then(analyticsReady =>
      root.render(
        <React.StrictMode>
          <App analyticsReady={analyticsReady} />
        </React.StrictMode>,
      ),
    )
    .catch(() => root.render(<Boot message="The data service could not be reached." onRetry={start} />))
}

start()
