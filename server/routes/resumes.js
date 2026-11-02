import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { readJSON, updateJSON } from '../lib/store.js'

const router = Router()
const KEY = 'resumes'

const emptyResume = () => ({
  id: randomUUID(),
  title: '',
  target: '',
  basic: {
    name: '',
    phone: '',
    email: '',
    city: '',
    school: '',
    major: '',
    education: '',
    graduationYear: '',
  },
  skills: [],
  experiences: [],
  projects: [],
  selfEvaluation: '',
  content: '', // AI 生成的成品简历（Markdown），由简历编辑器「保存到简历库」写入
  updatedAt: new Date().toISOString(),
})

// 结构化字段白名单，避免前端传入无关字段污染数据
function sanitize(input = {}) {
  const base = emptyResume()
  const basic = { ...base.basic, ...(input.basic || {}) }
  return {
    ...base,
    ...input,
    basic,
    skills: Array.isArray(input.skills) ? input.skills.map(String) : [],
    experiences: Array.isArray(input.experiences) ? input.experiences : [],
    projects: Array.isArray(input.projects) ? input.projects : [],
    selfEvaluation: String(input.selfEvaluation || ''),
    content: String(input.content || ''),
  }
}

router.get('/api/resumes', async (_req, res) => {
  const list = (await readJSON(KEY)) || []
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json(list)
})

router.get('/api/resumes/:id', async (req, res) => {
  const list = (await readJSON(KEY)) || []
  const item = list.find((r) => r.id === req.params.id)
  if (!item) return res.status(404).json({ error: '简历不存在' })
  res.json(item)
})

router.post('/api/resumes', async (req, res) => {
  const item = sanitize(req.body)
  item.id = randomUUID()
  item.updatedAt = new Date().toISOString()
  await updateJSON(KEY, (list) => [...list, item], [])
  res.json(item)
})

router.put('/api/resumes/:id', async (req, res) => {
  const body = req.body
  const saved = await updateJSON(
    KEY,
    (list) => {
      const idx = list.findIndex((r) => r.id === req.params.id)
      if (idx === -1) return undefined
      const item = sanitize(body)
      item.id = req.params.id
      item.updatedAt = new Date().toISOString()
      const next = [...list]
      next[idx] = item
      return next
    },
    []
  )
  if (!saved) return res.status(404).json({ error: '简历不存在' })
  res.json(saved.find((r) => r.id === req.params.id))
})

router.delete('/api/resumes/:id', async (req, res) => {
  let removed = false
  await updateJSON(
    KEY,
    (list) => {
      const next = list.filter((r) => r.id !== req.params.id)
      if (next.length === list.length) return undefined
      removed = true
      return next
    },
    []
  )
  if (!removed) return res.status(404).json({ error: '简历不存在' })
  res.json({ ok: true })
})

export default router
