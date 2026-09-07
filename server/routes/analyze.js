import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { listJobs, describeJob } from '../lib/jobs.js'

const router = Router()

router.post('/api/analyze', async (req, res) => {
  const { resume, questions = 5 } = req.body || {}

  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '简历内容不能为空' })
  }
  const questionCount = Math.min(8, Math.max(3, Number(questions) || 5))

  // 岗位知识库仅作参考（提供部分常见岗位的 JD + 技能点，帮助 AI 判断匹配度）；
  // 即使知识库缺失，也照样能基于简历自由推荐岗位，不因岗位库而失败。
  let jobs = []
  try {
    jobs = await listJobs()
  } catch (err) {
    console.warn('[analyze] jobs load failed, continue without job base:', err.message)
  }
  const jobBrief = jobs.map((j) => describeJob(j, { withQuestions: false })).join('\n\n---\n\n')
  const jobRef = jobBrief
    ? `\n以下是部分常见岗位及其职责要求，仅作为你判断岗位匹配度的参考，你也可以根据简历推荐更贴合的其他岗位：\n${jobBrief}\n`
    : ''

  const systemPrompt = `你是一位资深 HR 兼技术面试官。请分析用户提供的简历，并输出严格 JSON（不要输出任何 JSON 以外的内容），字段要求：
{
  "matchScores": [{ "name": "维度名（如技术能力/项目经验/岗位匹配/表达结构）", "score": 0-100 的整数, "comment": "一句话点评" }],
  "highlights": ["简历亮点1", "简历亮点2", "简历亮点3"],
  "weaknesses": ["简历短板1", "简历短板2", "简历短板3"],
  "predictedQuestions": ["基于这份简历，面试官最可能问的问题（真实、具体）"],
  "recommendJobs": [{ "name": "岗位名", "score": 0-100 的整数, "reason": "推荐理由（一句话）" }]
}
${jobRef}
要求：
1. matchScores 给 4 个维度
2. predictedQuestions 给 ${questionCount} 个问题
3. recommendJobs 给 4-6 个与简历最匹配的岗位，按匹配度降序排列；name 为岗位名称（可用常见岗位名，也可推荐你认为更贴合简历的任意岗位）；score 为该岗位与简历的匹配分（0-100 整数）；reason 为一句推荐理由
4. 打分必须结合简历中的实际经历，不要凭印象给分
5. 所有内容使用简体中文`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `我的简历如下：\n\n${String(resume).slice(0, 8000)}` },
    ])

    res.json({
      matchScores: data.matchScores || [],
      highlights: data.highlights || [],
      weaknesses: data.weaknesses || [],
      predictedQuestions: data.predictedQuestions || [],
      recommendJobs: (data.recommendJobs || [])
        .filter((j) => j && String(j.name).trim())
        .map((j) => ({
          name: String(j.name).trim(),
          score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))),
          reason: String(j.reason || ''),
        }))
        .slice(0, 8),
    })
  } catch (err) {
    console.error('[analyze] failed:', err.message)
    res.status(500).json({ error: '简历分析失败，请稍后重试' })
  }
})

export default router
