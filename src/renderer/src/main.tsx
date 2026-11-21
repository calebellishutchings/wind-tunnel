import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { createBrowserRuntime } from '../../browser/runtime'

class ErrorBoundary extends React.Component<React.PropsWithChildren, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error: error.message }
  }
  render() {
    return this.state.error ? (
      <main className="startup">
        <h1>The display encountered an error</h1>
        <p>{this.state.error}</p>
        <button onClick={() => void window.tunnel?.disconnect()}>
          Disconnect USB and finalize recording
        </button>
        <p>
          Verify fan zero before reloading. Use the physical VFD Stop if zero cannot be confirmed.
        </p>
      </main>
    ) : (
      this.props.children
    )
  }
}
const root = createRoot(document.getElementById('root')!)
void createBrowserRuntime()
  .then((api) => {
    window.tunnel = api
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
  })
  .catch((error: unknown) => {
    root.render(
      <main className="startup">
        <h1>Wind tunnel could not start</h1>
        <p>{String(error)}</p>
      </main>,
    )
  })

if ('serviceWorker' in navigator && import.meta.env.PROD)
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
