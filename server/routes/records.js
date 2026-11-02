import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import { listMine, getMine, isMine } from '../lib/scope.js'

const router = Router()
const KEY = 'records'

router.get('/api/records', async (req, res) => {
  const records = await listMine(KEY, req.userId)
  const list = [...records].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  res.json(list)
})

router.post('/api/records', async (req, res) => {
  const { resume = '', job, questions, history = [], durations = [], report } = req.body || {}

  if (!job || !report) {
    return res.status(400).json({ error: '缺少岗位或报告数据' })
  }

  // 9.5 错题本：保存时把低分题（score < 70）标记为错题
  const WRONG_THRESHOLD = 70
  if (Array.isArray(report.perQuestion)) {
    report.perQuestion = report.perQuestion.map((q) => ({
      ...q,
      wrong: Number(q.score) < WRONG_THRESHOLD,
    }))
  }

  const record = {
    id: randomUUID(),
    ownerId: req.userId, // 归属只由后端决定
    resume: String(resume).slice(0, 8000),
    job,
    questions: Number(questions) || 0,
    history,
    durations: Array.isArray(durations) ? durations.slice(0, 20) : [], // 9.8 每题用时
    report,
    createdAt: new Date().toISOString(),
  }
  await updateJSON(KEY, (list) => [...list, record], [])

  res.json({ id: record.id })
})

router.get('/api/records/:id', async (req, res) => {
  const record = await getMine(KEY, req.userId, req.params.id)
  if (!record) {
    return res.status(404).json({ error: '记录不存在' })
  }
  res.json(record)
})

router.delete('/api/records/:id', async (req, res) => {
  let removed = false
  await updateJSON(
    KEY,
    (list) => {
      const target = list.find((r) => r.id === req.params.id)
      if (!target || !isMine(target, req.userId)) return undefined
      removed = true
      return list.filter((r) => r.id !== req.params.id)
    },
    []
  )
  if (!removed) return res.status(404).json({ error: '记录不存在' })
  res.json({ ok: true })
})

export default router
