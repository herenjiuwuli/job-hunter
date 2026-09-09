import express from 'express'
import cors from 'cors'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import resumesRouter from './routes/resumes.js'
import applicationsRouter from './routes/applications.js'
import profileRouter from './routes/profile.js'
import tailorRouter from './routes/tailor.js'
import matchRouter from './routes/match.js'
// 面试准备板块（自 resume-interview 合并）
import analyzeRouter from './routes/analyze.js'
import interviewRouter from './routes/interview.js'
import recordsRouter from './routes/records.js'
import resumeRouter from './routes/resume.js'
import applyRouter from './routes/apply.js'
import salaryRouter from './routes/salary.js'
import introRouter from './routes/intro.js'
import prepRouter from './routes/prep.js'
import backupRouter from './routes/backup.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_DIR = join(__dirname, '..', 'dist')

/**
 * @param {{ serveStatic?: boolean }} options
 *   serveStatic=true 时托管 dist/ 并对非 /api 的 GET 请求回落到 index.html（SPA history 路由需要）。
 *   开发环境不要开（前端由 vite dev server 提供），否则改动必须重新 build 才生效。
 */
export function createApp({ serveStatic = false } = {}) {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.use(resumesRouter)
  app.use(applicationsRouter)
  app.use(profileRouter)
  app.use(tailorRouter)
  app.use(matchRouter)
  app.use(analyzeRouter)
  app.use(interviewRouter)
  app.use(recordsRouter)
  app.use(resumeRouter)
  app.use(applyRouter)
  app.use(salaryRouter)
  app.use(introRouter)
  app.use(prepRouter)
  app.use(backupRouter)

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // 生产模式：单端口同时提供前端静态资源与 API
  if (serveStatic) {
    if (!existsSync(DIST_DIR)) {
      console.warn(`[job-hunter] 未找到 dist/，请先执行 npm run build（当前只提供 API）`)
    } else {
      app.use(express.static(DIST_DIR))
      // SPA history 路由兜底：/applications、/profile 等直接访问也要返回 index.html
      app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
        res.sendFile(join(DIST_DIR, 'index.html'))
      })
    }
  }

  return app
}
