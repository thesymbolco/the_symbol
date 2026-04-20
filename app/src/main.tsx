import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import AppAuthGate from './components/AppAuthGate.tsx'
import { AppRuntimeProvider } from './providers/AppRuntimeProvider.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppRuntimeProvider>
      <AppAuthGate>
        <App />
      </AppAuthGate>
    </AppRuntimeProvider>
  </StrictMode>,
)
