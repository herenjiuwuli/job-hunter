import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { resolveJob } from '../lib/jobs.js'

const router = Router()

const TYPES = ['技术复习', '公司调研', '材料准备', '问题预演']
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 }

router.post('/api/prep/checklist', async (req, res) => {
  const { resume, job, jd = '' } = req.body || {}

  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }
  if (!job) {
    return res.status(400).json({ error: '请先填写岗位' })
  }

  // 岗位不限：命中知识库用知识库 JD，否则按自定义岗位 + 自定义 JD
  const jobInfo = await resolveJob(job, jd)

  const systemPrompt = `你是一位资深求职教练。候选人在准备「${job}」岗位面试，请为其生成一份面试前准备清单。

候选人简历：
${String(resume).slice(0, 5000)}

岗位 JD：
${jobInfo.jd ? String(jobInfo.jd).slice(0, 2000) : `目标岗位：${jobInfo.name}（未提供 JD，请基于岗位名称与简历生成）`}

严格输出 JSON：
{
  "items": [{ "title": "准备事项（具体可执行，如：复习 Vue3 响应式原理，能手写简易实现）", "type": "技术复习|公司调研|材料准备|问题预演", "priority": "high|medium|low" }],
  "tips": ["面试前通用提醒（如：提前 10 分钟到场、准备好纸笔）", "..."]
}
要求：
1. items 覆盖 4 种类型（技术复习/公司调研/材料准备/问题预演），共 8-12 条
2. 针对候选人简历的薄弱点和岗位 JD 的核心要求给出复习项
3. priority：high = 面试前必须完成，medium = 建议完成，low = 有时间再做
4. 所有内容使用简体中文`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请生成面试准备清单，严格输出 JSON。' },
    ])

    if (!Array.isArray(data.items) || !data.items.length) throw new Error('AI 未返回清单')

    res.json({
      items: data.items
        .filter((it) => it && it.title)
        .map((it) => ({
          title: String(it.title),
          type: TYPES.includes(it.type) ? it.type : '问题预演',
          priority: PRIORITY_ORDER[it.priority] !== undefined ? it.priority : 'medium',
        }))
        .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
        .slice(0, 12),
      tips: (data.tips || []).map(String).filter(Boolean).slice(0, 6),
    })
  } catch (err) {
    console.error('[prep/checklist] failed:', err.message)
    res.status(500).json({ error: '准备清单生成失败，请稍后重试' })
  }
})

export default router
