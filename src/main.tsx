import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

async function mount() {
  if (import.meta.env.DEV && import.meta.env.VITE_BROWSER_PREVIEW === 'true') {
    const { installBrowserPreview } = await import('./dev/browser-api')
    installBrowserPreview()
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>
  )
}
void mount()
