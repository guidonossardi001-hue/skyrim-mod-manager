import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            // Il build del main PULISCE la cartella: senza questo ogni build
            // accumulava bundle hashati stale (decine di file spediti nell'app).
            emptyOutDir: true,
            rollupOptions: {
              external: ['better-sqlite3', 'electron-store', '7zip-bin']
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            // Compilato DOPO il main nello stesso outDir: non deve svuotarlo
            // (cancellerebbe main.js appena generato).
            emptyOutDir: false,
          }
        }
      }
    ])
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  base: './',
  build: {
    outDir: 'dist'
  }
})
