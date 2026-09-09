import 'dotenv/config'
import { createApp } from './index.js'

// 生产入口：单端口同时提供前端静态资源（dist/）与 /api
// 用法：npm run build && npm start
const PORT = process.env.PORT || 3100

const app = createApp({ serveStatic: true })

app.listen(PORT, () => {
  console.log(`[job-hunter] 已启动 http://localhost:${PORT}（前端 + API 同一端口）`)
})
