import 'dotenv/config'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3100

// 隔离数据目录时，播种岗位知识库（jobs.json 是随代码部署的静态资产，非运行时数据）
if (process.env.JOB_HUNTER_DATA_DIR) {
  const seed = join(__dirname, 'data', 'jobs.json')
  const target = join(process.env.JOB_HUNTER_DATA_DIR, 'jobs.json')
  if (existsSync(seed) && !existsSync(target)) {
    mkdirSync(process.env.JOB_HUNTER_DATA_DIR, { recursive: true }) // 全新隔离目录尚不存在
    copyFileSync(seed, target)
    console.log(`[job-hunter] 已播种岗位知识库到隔离目录: ${target}`)
  }
}

const app = createApp()

app.listen(PORT, () => {
  console.log(`[job-hunter] Dev server running at http://localhost:${PORT}`)
})
