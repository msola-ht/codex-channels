import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from 'next-themes'
import App from './App.tsx'
import { setToken } from '@/lib/api'

const urlToken = new URLSearchParams(window.location.search).get('token')
if (urlToken !== null && urlToken.trim() !== '') {
  setToken(urlToken.trim())
  history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      disableTransitionOnChange
      enableSystem={false}
    >
      <App />
    </ThemeProvider>
  </StrictMode>,
)
