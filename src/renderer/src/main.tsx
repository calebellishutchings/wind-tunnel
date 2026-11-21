import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

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
        <p>Close the app to finalize the run log, then restart it.</p>
      </main>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
