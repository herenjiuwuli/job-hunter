import express from 'express'
import cors from 'cors'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import resumesRouter from './routes/resumes.js'
import authRouter from './routes/auth.js'
import { requireAuth } from './lib/auth.js'
import applicationsRouter from './routes/applications.js'
import funnelRouter from './routes/funnel.js'
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
import ammoRouter from './routes/ammo.js'
import exportRouter from './routes/export.js'
import importRouter from './routes/import.js'
import backupRouter from './routes/backup.js'
import dashboardRouter from './routes/dashboard.js'

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
  app.use(express.json({ limit: '5mb' })) // 上调以支持简历文件 base64 上传

  // ---- 公开路由（必须在 requireAuth 之前注册）----
  app.use(authRouter) // /api/auth/register|login 公开；me / password 在路由内部自己校验

  app.get('/api/health', (_req, res) => {
    const base = process.env.DEEPSEEK_BASE_URL || ''
    res.json({
      status: 'ok',
      aiMock: /127\.0\.0\.1|localhost/.test(base),               // true = 走 mock，不花钱
      dataDirIsolated: Boolean(process.env.JOB_HUNTER_DATA_DIR), // true = 数据目录已隔离
      auth: 'required',                                          // 前端据此判断要不要先登录
    })
  })

  // ---- 鉴权闸门 ----
  // 只挂 /api 前缀，**不能**写成 app.use(requireAuth)：那样会把 dist/ 静态资源
  // 和不带前缀的 SPA 路由（/、/login、/dashboard）也拦掉 —— 表现为「页面直接 401，白屏」。
  // 这条路径前缀是必须的，别顺手删。
  app.use('/api', requireAuth)

  // ---- 以下全部需要登录 ----
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
  app.use(ammoRouter)
  app.use(exportRouter)
  app.use(importRouter)
  app.use(backupRouter)
  app.use(dashboardRouter)
  app.use(funnelRouter)

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
