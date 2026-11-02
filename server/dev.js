import 'dotenv/config'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3100

// 隔离数据目录时，播种岗位知识库（jobs.json 是随代码部署的静态资产，非运行时数据）
if (process.env.JOB_HUNTER_DATA_DIR) {
  const seed = join(__dirname, 'data', 'jobs.json')
  const target = join(process.env.JOB_HUNTER_DATA_DIR, 'jobs.json')
  // ⚠️ 判「不存在 **或 空文件**」而不是只判存在：
  // 隔离目录里如果躺着一个空/坏的 jobs.json（手工建目录、上次中断留下的半截文件），
  // 只判存在就会跳过播种，然后 apply/interview 十条用例全 500，
  // 日志写「缺失或内容为空」—— 看着像代码坏了，其实只是环境里一个空文件。
  const needSeed = !existsSync(target) || statSync(target).size === 0
  if (existsSync(seed) && needSeed) {
    mkdirSync(process.env.JOB_HUNTER_DATA_DIR, { recursive: true }) // 全新隔离目录尚不存在
    copyFileSync(seed, target)
    console.log(`[job-hunter] 已播种岗位知识库到隔离目录: ${target}`)
  }
}

const app = createApp()

const server = app.listen(PORT, () => {
  console.log(`[job-hunter] Dev server running at http://localhost:${PORT}`)
})
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[job-hunter] 端口 ${PORT} 已被占用。请先关闭占用进程，或用 \`npm run dev\` 自动清理残留。`)
  } else {
    console.error(err)
  }
  process.exit(1)
})
