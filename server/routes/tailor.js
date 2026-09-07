import { Router } from 'express'
import { readJSON } from '../lib/store.js'
import { chatJSON } from '../lib/ai.js'

const router = Router()

function serializeResume(r) {
  const lines = []
  lines.push(`# ${r.title || '未命名简历'}（${r.target || '未设方向'}）`)
  const b = r.basic || {}
  const basicLine = [
    b.name, b.school, b.major, b.education, b.graduationYear, b.city, b.phone, b.email,
  ].filter(Boolean).join(' / ')
  if (basicLine) lines.push(`基本信息：${basicLine}`)
  if (Array.isArray(r.skills) && r.skills.length) lines.push(`技能：${r.skills.join('、')}`)
  if (Array.isArray(r.experiences) && r.experiences.length) {
    lines.push('工作/实习经历：')
    r.experiences.forEach((e, i) => {
      lines.push(`${i + 1}. ${e.company || ''} · ${e.role || ''}（${e.start || ''} - ${e.end || ''}）`)
      ;(e.points || []).forEach((p) => lines.push(`   - ${p}`))
    })
  }
  if (Array.isArray(r.projects) && r.projects.length) {
    lines.push('项目经历：')
    r.projects.forEach((p, i) => {
      const desc = p.desc ? `：${p.desc}` : ''
      lines.push(`${i + 1}. ${p.name || ''}（${p.role || ''}）${desc}`)
      ;(p.highlights || []).forEach((h) => lines.push(`   - ${h}`))
    })
  }
  if (r.selfEvaluation) lines.push(`自我评价：${r.selfEvaluation}`)
  return lines.join('\n')
}

router.post('/api/tailor', async (req, res) => {
  const { resumeId, jd = '', company = '', jobTitle = '' } = req.body || {}

  if (!resumeId) return res.status(400).json({ error: '请先选择简历' })
  if (!String(jd).trim()) return res.status(400).json({ error: '请先粘贴岗位 JD' })

  const resumes = (await readJSON('resumes')) || []
  const resume = resumes.find((r) => r.id === resumeId)
  if (!resume) return res.status(404).json({ error: '简历不存在' })

  const target = [company, jobTitle].filter(Boolean).join(' · ')

  const systemPrompt = `你是一位资深求职顾问与简历优化专家。候选人要投递「${target || '目标岗位'}」。请基于候选人的真实简历和岗位 JD，产出四份定制素材，严格输出 JSON：
{
  "greeting": "打招呼语：投递时发给 HR 的开场白，80-120 字，突出与 JD 最匹配的 1-2 个亮点，语气真诚不浮夸",
  "coverLetter": "求职信：300-400 字，结构为开头表明意向、中间用简历事实论证匹配度、结尾表达期待",
  "tailoredResume": "针对该 JD 定制的简历全文（Markdown，含基本信息/技能/经历/项目/自我评价五块；把与 JD 最相关的技能和经历排到前面，并适当改写措辞对齐 JD 关键词）",
  "matchPoints": ["候选人与该 JD 最匹配的 3 个点，各一句话"]
}
硬性要求：
1. 绝不虚构经历、技能、数据、公司名、奖项；只能基于候选人真实简历改写措辞、调整顺序、突出已有亮点
2. 若 JD 有明确要求而简历确实没有，不要编造对应内容，直接省略该点即可
3. 全部使用简体中文`

  const userContent = `候选人简历（真实，勿虚构）：
${serializeResume(resume)}

目标岗位 JD：
${String(jd).slice(0, 4000)}

请生成定制素材，严格输出 JSON。`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ])

    if (!data.greeting || !data.tailoredResume) throw new Error('AI 未返回完整素材')

    res.json({
      greeting: String(data.greeting),
      coverLetter: String(data.coverLetter || ''),
      tailoredResume: String(data.tailoredResume),
      matchPoints: Array.isArray(data.matchPoints) ? data.matchPoints.map(String).slice(0, 3) : [],
    })
  } catch (err) {
    console.error('[tailor] failed:', err.message)
    res.status(500).json({ error: 'AI 定制失败：' + err.message })
  }
})

export default router
