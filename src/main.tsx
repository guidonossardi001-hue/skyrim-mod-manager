import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Diagnostica di ultima istanza nel renderer: errori non catturati e promise
// rejettate finiscono in console (e nei log DevTools) invece di sparire.
window.addEventListener('error', (e) => console.error('[renderer] uncaught:', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) =>
  console.error('[renderer] unhandled rejection:', e.reason),
)

// Inject the mock API only in the DEV browser preview. In Electron the preload
// script has already defined window.api. The DEV gate matters: a production
// build where the preload failed must fail VISIBLY, not fall back silently to a
// simulated backend that pretends downloads/installs are working.
async function bootstrap() {
  if (!(window as unknown as Record<string, unknown>).api) {
    if (import.meta.env.DEV) {
      await import('./mockApi')
    } else {
      document.getElementById('root')!.innerHTML =
        '<div style="color:#f87171;font-family:sans-serif;padding:2rem">Errore: bridge IPC non disponibile (preload non caricato). Reinstalla o avvia l\'app desktop.</div>'
      return
    }
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

bootstrap()
