import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { readJSON, writeJSON } from '../lib/store.js'

const router = Router()
const KEY = 'applications'

export const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']

function sanitize(input = {}) {
  return {
    id: randomUUID(),
    resumeId: input.resumeId || '',
    company: String(input.company || '').trim(),
    jobTitle: String(input.jobTitle || '').trim(),
    platform: String(input.platform || '').trim(),
    jd: String(input.jd || '').slice(0, 8000),
    greeting: String(input.greeting || '').slice(0, 3000),
    coverLetter: String(input.coverLetter || '').slice(0, 6000),
    tailoredResume: String(input.tailoredResume || '').slice(0, 12000),
    status: STATUSES.includes(input.status) ? input.status : '待投递',
    note: String(input.note || '').slice(0, 3000),
    appliedAt: input.appliedAt || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

router.get('/api/applications', async (_req, res) => {
  const list = (await readJSON(KEY)) || []
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json(list)
})

router.get('/api/applications/:id', async (req, res) => {
  const list = (await readJSON(KEY)) || []
  const item = list.find((a) => a.id === req.params.id)
  if (!item) return res.status(404).json({ error: '投递记录不存在' })
  res.json(item)
})

router.post('/api/applications', async (req, res) => {
  const list = (await readJSON(KEY)) || []
  const item = sanitize(req.body)
  if (!item.company || !item.jobTitle) {
    return res.status(400).json({ error: '公司名与岗位名不能为空' })
  }
  list.push(item)
  await writeJSON(KEY, list)
  res.json(item)
})

router.put('/api/applications/:id', async (req, res) => {
  const list = (await readJSON(KEY)) || []
  const idx = list.findIndex((a) => a.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: '投递记录不存在' })

  const prev = list[idx]
  const item = sanitize(req.body)
  item.id = req.params.id
  item.createdAt = prev.createdAt
  item.updatedAt = new Date().toISOString()
  list[idx] = item
  await writeJSON(KEY, list)
  res.json(item)
})

router.delete('/api/applications/:id', async (req, res) => {
  const list = (await readJSON(KEY)) || []
  const next = list.filter((a) => a.id !== req.params.id)
  if (next.length === list.length) return res.status(404).json({ error: '投递记录不存在' })
  await writeJSON(KEY, next)
  res.json({ ok: true })
})

export default router
