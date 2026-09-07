import express from 'express'
import cors from 'cors'
import resumesRouter from './routes/resumes.js'
import applicationsRouter from './routes/applications.js'
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

export function createApp() {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '1mb' }))

  app.use(resumesRouter)
  app.use(applicationsRouter)
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

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  return app
}
