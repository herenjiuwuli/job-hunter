import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import { listMine, getMine, isMine } from '../lib/scope.js'

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
// 注意：ownerId 和 id 必须从入参里摘掉 —— 否则客户端可以自己指定归属/主键（批量赋值漏洞）。
// ownerId 一律由后端按登录身份写入，id 由后端生成。
function sanitize(input = {}) {
  const { ownerId: _ownerId, id: _id, ...rest } = input
  const base = emptyResume()
  const basic = { ...base.basic, ...(rest.basic || {}) }
  return {
    ...base,
    ...rest,
    basic,
    skills: Array.isArray(rest.skills) ? rest.skills.map(String) : [],
    experiences: Array.isArray(rest.experiences) ? rest.experiences : [],
    projects: Array.isArray(rest.projects) ? rest.projects : [],
    selfEvaluation: String(rest.selfEvaluation || ''),
    content: String(rest.content || ''),
  }
}

router.get('/api/resumes', async (req, res) => {
  const list = await listMine(KEY, req.userId)
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json(list)
})

router.get('/api/resumes/:id', async (req, res) => {
  // 别人的简历一律 404（不是 403）：403 等于确认「这个 id 存在」
  const item = await getMine(KEY, req.userId, req.params.id)
  if (!item) return res.status(404).json({ error: '简历不存在' })
  res.json(item)
})

router.post('/api/resumes', async (req, res) => {
  const item = sanitize(req.body)
  item.id = randomUUID()
  item.ownerId = req.userId
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
      // 不存在、或者是别人的 → 都不写，外层统一 404
      if (idx === -1 || !isMine(list[idx], req.userId)) return undefined
      const item = sanitize(body)
      item.id = req.params.id
      item.ownerId = req.userId
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
      const target = list.find((r) => r.id === req.params.id)
      if (!target || !isMine(target, req.userId)) return undefined
      removed = true
      return list.filter((r) => r.id !== req.params.id)
    },
    []
  )
  if (!removed) return res.status(404).json({ error: '简历不存在' })
  res.json({ ok: true })
})

export default router
