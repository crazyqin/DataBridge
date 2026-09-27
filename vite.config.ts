import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const backend = 'http://localhost:8080'

export default defineConfig({
  root: 'web',
  plugins: [vue()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/admin': backend, '/auth': backend, '/open': backend } },
})
