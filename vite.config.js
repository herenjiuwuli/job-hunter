import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        target: process.env.JH_API_PORT ? 'http://localhost:' + process.env.JH_API_PORT : 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
  },
})
