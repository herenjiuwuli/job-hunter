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

  // 岗位知识库是唯一真相源：岗位名、JD、技能点都从 jobs.json 来，不再硬编码
  let jobs
  try {
    jobs = await listJobs()
  } catch (err) {
    console.error('[analyze] jobs load failed:', err.message)
    return res.status(500).json({ error: '岗位知识库加载失败，请检查服务配置' })
  }
  const jobNames = jobs.map((j) => j.name)
  // 分析阶段不需要题目池（40 题全塞进去太长），只给 JD + 技能点作为打分依据
  const jobBrief = jobs.map((j) => describeJob(j, { withQuestions: false })).join('\n\n---\n\n')

  const systemPrompt = `你是一位资深 HR 兼技术面试官。请分析用户提供的简历，并输出严格 JSON（不要输出任何 JSON 以外的内容），字段要求：
{
  "matchScores": [{ "name": "维度名（如技术能力/项目经验/岗位匹配/表达结构）", "score": 0-100 的整数, "comment": "一句话点评" }],
  "highlights": ["简历亮点1", "简历亮点2", "简历亮点3"],
  "weaknesses": ["简历短板1", "简历短板2", "简历短板3"],
  "predictedQuestions": ["基于这份简历，面试官最可能问的问题（真实、具体）"],
  "recommendJobs": [{ "name": "岗位名", "score": 0-100 的整数, "reason": "推荐理由（一句话）" }]
}

以下是候选岗位及其职责要求，作为你判断岗位匹配度的依据：
${jobBrief}

要求：
1. matchScores 给 4 个维度
2. predictedQuestions 给 ${questionCount} 个问题
3. recommendJobs 给全部 ${jobNames.length} 个岗位并分别打分排序（分数高的在前），name 必须严格使用以下岗位名之一：${jobNames.join('、')}
4. 打分必须基于上方各岗位的"岗位职责与要求"与"核心考察技能"，结合简历中的实际经历，不要凭印象给分
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
      recommendJobs: (data.recommendJobs || []).filter((j) => jobNames.includes(j.name)),
    })
  } catch (err) {
    console.error('[analyze] failed:', err.message)
    res.status(500).json({ error: '简历分析失败，请稍后重试' })
  }
})

export default router
