import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ plugins: [vue()], server: { host: '0.0.0.0', proxy: { '/admin': 'http://localhost:8080', '/auth': 'http://localhost:8080', '/open': 'http://localhost:8080' } } })
