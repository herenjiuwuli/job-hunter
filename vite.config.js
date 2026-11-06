import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/api': {
        // 默认打 3100（正式后端）。JH_API_PORT 只在需要把前端指到隔离后端时用：
        // 截图核对版式 / 拿真实账本副本回放时，起一个 3212 的隔离实例，前端不用改代码。
        target: process.env.JH_API_PORT
          ? 'http://localhost:' + process.env.JH_API_PORT
          : 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2018',
    chunkSizeWarningLimit: 1500,
  },
})
