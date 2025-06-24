import './polyfills'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { PrivyProvider } from '@privy-io/react-auth'
import App from './App.tsx'
import './style.css'

const appId = import.meta.env.VITE_PRIVY_APP_ID;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PrivyProvider appId={appId || ''}>
      <App />
    </PrivyProvider>
  </React.StrictMode>,
) 