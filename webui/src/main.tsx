import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import { setToken } from '@/lib/api'
import { consumeQueryToken } from '@/lib/query-token'

let initialTokenStorageFailed = false
consumeQueryToken({
  currentUrl: window.location.href,
  storeToken: setToken,
  replaceUrl: (url) => history.replaceState(null, '', url),
  onStorageFailure: () => { initialTokenStorageFailed = true },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      disableTransitionOnChange
      enableSystem={false}
    >
      <App initialTokenStorageFailed={initialTokenStorageFailed} />
    </ThemeProvider>
  </StrictMode>,
)
