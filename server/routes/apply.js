import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { resolveJob } from '../lib/jobs.js'

const router = Router()

router.post('/api/apply/assist', async (req, res) => {
  const { resume, job, jd = '' } = req.body || {}

  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }
  if (!job) {
    return res.status(400).json({ error: '请先填写岗位' })
  }

  // 岗位不限：命中知识库用知识库 JD，否则按「自定义岗位 + 用户粘贴的 JD」生成
  const jobInfo = await resolveJob(job, jd)

  const systemPrompt = `你是一位专业的求职顾问。候选人正在投递「${jobInfo.name}」岗位，请基于候选人简历、岗位 JD 和用户粘贴的真实 JD（如有），生成投递辅助素材，严格输出 JSON：
{
  "applyList": [{ "company": "推荐投递的公司类型/行业方向", "reason": "匹配理由（一句话）" }],
  "greeting": "打招呼语：投递时发给招聘方的简短自我介绍，100 字左右，突出与岗位最匹配的 1-2 个亮点，语气真诚不浮夸",
  "coverLetter": "求职信完整版：300-400 字，结构为开头表明意向、中间用简历事实论证匹配度、结尾表达期待"
}
要求：
1. applyList 给 4-5 条；company 字段填写「公司类型/行业方向」（如：中大型电商平台、SaaS 软件公司、传统企业数字化转型团队），绝不虚构具体公司名称
2. 所有内容只基于候选人简历的真实信息，绝不虚构经历、技能、数据
3. 所有内容使用简体中文`

  const userContent = `候选人简历：
${String(resume).slice(0, 6000)}

岗位 JD：
${jobInfo.jd || `目标岗位：${jobInfo.name}（未提供 JD，请基于岗位名称生成）`}

请生成投递辅助素材，严格输出 JSON。`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ])

    if (!data.greeting || !data.coverLetter) throw new Error('AI 未返回完整素材')

    res.json({
      applyList: (data.applyList || []).filter((a) => a && a.company),
      greeting: String(data.greeting),
      coverLetter: String(data.coverLetter),
    })
  } catch (err) {
    console.error('[apply/assist] failed:', err.message)
    res.status(500).json({ error: '投递素材生成失败，请稍后重试' })
  }
})

export default router
