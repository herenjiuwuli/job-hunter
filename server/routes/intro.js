import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { resolveJob } from '../lib/jobs.js'

const router = Router()

router.post('/api/intro/practice', async (req, res) => {
  const { resume, job, jd = '', duration = 60, intro } = req.body || {}

  if (!intro || !String(intro).trim()) {
    return res.status(400).json({ error: '请先填写自我介绍内容' })
  }
  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }
  if (!job) {
    return res.status(400).json({ error: '请先填写岗位' })
  }
  const dur = Number(duration) === 180 ? 180 : 60
  const wordTip = dur === 180 ? '600-800 字' : '200-260 字'

  // 岗位不限：命中知识库用知识库 JD，否则按自定义岗位 + 自定义 JD
  const jobInfo = await resolveJob(job, jd)

  const systemPrompt = `你是一位资深的求职辅导教练，擅长打磨面试自我介绍。候选人正在准备「${jobInfo?.name || '目标'}」岗位的面试，练习一段 ${dur === 180 ? '3 分钟' : '1 分钟'}的自我介绍（该时长合理的篇幅约 ${wordTip}）。候选人简历：
${String(resume).slice(0, 5000)}
${jobInfo ? (jobInfo.jd ? `\n岗位 JD：\n${jobInfo.jd.slice(0, 1000)}` : `\n目标岗位：${jobInfo.name}`) : ''}

候选人提交的自我介绍：
${String(intro).slice(0, 5000)}

请严格输出 JSON：
{
  "score": 0-100 的整数（综合评分：内容相关性、结构清晰度、亮点突出、篇幅适配）,
  "comments": [{ "sentence": "自我介绍中的原句（或要点摘要）", "comment": "针对这句的具体点评（好在哪/问题在哪/怎么改）" }],
  "suggestions": ["改进建议1", "改进建议2", "改进建议3"],
  "exampleIntro": "一份同场景下更优的自我介绍示例（基于候选人简历真实信息，绝不虚构经历、技能、数据；篇幅符合 ${dur === 180 ? '3 分钟' : '1 分钟'}）"
}
要求：
1. comments 逐句（或逐要点）点评，覆盖开头、主体、结尾
2. 点评具体、可落地，语气建设性，不打击信心
3. 所有内容使用简体中文`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: '请点评这段自我介绍，严格输出 JSON。' },
    ])

    if (!data.comments || !data.exampleIntro) throw new Error('AI 未返回完整点评')

    res.json({
      score: Math.max(0, Math.min(100, Math.round(Number(data.score) || 0))),
      comments: Array.isArray(data.comments)
        ? data.comments
            .filter((c) => c && (c.sentence || c.comment))
            .map((c) => ({ sentence: String(c.sentence || ''), comment: String(c.comment || '') }))
            .slice(0, 10)
        : [],
      suggestions: Array.isArray(data.suggestions) ? data.suggestions.map(String).filter(Boolean).slice(0, 6) : [],
      exampleIntro: String(data.exampleIntro),
    })
  } catch (err) {
    console.error('[intro/practice] failed:', err.message)
    res.status(500).json({ error: '点评生成失败，请稍后重试' })
  }
})

export default router
