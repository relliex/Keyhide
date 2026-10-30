import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [react()],
  define: { 'import.meta.env.VITE_BROWSER_PREVIEW': JSON.stringify('true') },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  resolve: { alias: { '@': resolve(__dirname, 'src'), '@shared': resolve(__dirname, 'electron/shared') } }
})
