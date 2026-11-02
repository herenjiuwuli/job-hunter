import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import { listMine, getMine, isMine } from '../lib/scope.js'

const router = Router()
const KEY = 'applications'

export const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']

/**
 * 单次投递「结果」（applypilot 五态结果机）：
 * 与 STATUSES 的「求职流程阶段」是正交的两个维度——
 * STATUSES 回答「这单推进到哪一步了」，RESULTS 回答「这一次投递到底成没成」。
 * 自动化/半自动投递后，只有看到「已确认提交」才算真的投出去了。
 */
export const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']

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
    result: RESULTS.includes(input.result) ? input.result : '待处理',
    note: String(input.note || '').slice(0, 3000),
    appliedAt: input.appliedAt || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

router.get('/api/applications', async (req, res) => {
  const list = await listMine(KEY, req.userId)
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json(list)
})

router.get('/api/applications/:id', async (req, res) => {
  const item = await getMine(KEY, req.userId, req.params.id)
  if (!item) return res.status(404).json({ error: '投递记录不存在' })
  res.json(item)
})

router.post('/api/applications', async (req, res) => {
  const item = sanitize(req.body)
  item.ownerId = req.userId // 归属只由后端决定，不看请求体
  if (!item.company || !item.jobTitle) {
    return res.status(400).json({ error: '公司名与岗位名不能为空' })
  }
  // 读-改-写必须在同一把锁里：扩展批量投递会连续 POST，
  // 分开做会「后一条覆盖前一条」，记录静默消失
  await updateJSON(KEY, (list) => [...list, item], [])
  res.json(item)
})

router.put('/api/applications/:id', async (req, res) => {
  const body = req.body
  const saved = await updateJSON(
    KEY,
    (list) => {
      const idx = list.findIndex((a) => a.id === req.params.id)
      // 不存在、或者是别人的 → 不写，外层统一 404
      if (idx === -1 || !isMine(list[idx], req.userId)) return undefined
      const item = sanitize(body)
      item.id = req.params.id
      item.ownerId = req.userId
      item.createdAt = list[idx].createdAt
      item.updatedAt = new Date().toISOString()
      const next = [...list]
      next[idx] = item
      return next
    },
    []
  )
  if (!saved) return res.status(404).json({ error: '投递记录不存在' })
  res.json(saved.find((a) => a.id === req.params.id))
})

router.delete('/api/applications/:id', async (req, res) => {
  let removed = false
  await updateJSON(
    KEY,
    (list) => {
      const target = list.find((a) => a.id === req.params.id)
      if (!target || !isMine(target, req.userId)) return undefined
      removed = true
      return list.filter((a) => a.id !== req.params.id)
    },
    []
  )
  if (!removed) return res.status(404).json({ error: '投递记录不存在' })
  res.json({ ok: true })
})

export default router
