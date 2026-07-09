import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Config per preview web (senza plugin Electron). Il mock viene iniettato a
// runtime da src/main.tsx (solo in DEV): nessun define/stub testuale fragile.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  base: './',
  server: {
    watch: {
      // data/ contiene decine di GB (StockGame + cache download): il watcher
      // non deve mai enumerarli. Idem per gli output di build.
      ignored: ['**/data/**', '**/release/**', '**/dist/**', '**/dist-electron/**'],
    },
  },
  build: { outDir: 'dist' }
})
