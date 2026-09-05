import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const configuredPort = Number(process.env.CODEXC_WEBUI_PORT)
const webuiPort = Number.isSafeInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535
  ? configuredPort
  : 8787
const webuiOrigin = `http://127.0.0.1:${webuiPort}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      '/api': {
        target: webuiOrigin,
        changeOrigin: true,
        configure(proxy) {
          // 管理 API 校验精确 Origin；开发页运行在 5173 时由代理还原为后端来源。
          proxy.on('proxyReq', (request) => {
            request.setHeader('origin', webuiOrigin)
          })
        },
      },
    },
  },
})
