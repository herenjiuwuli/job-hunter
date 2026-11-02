import { Router } from 'express'
import { extractResumeText } from '../lib/parseResumeFile.js'
import { chatJSON } from '../lib/ai.js'

const router = Router()

const STRUCTURE_PROMPT = `你是一位简历信息抽取专家。下面是一份从 PDF/Word 简历中提取出的纯文本。请从中抽取结构化字段，严格输出 JSON：

{
  "title": "简短标题，如「张三-前端开发简历」，无法判断时用「导入简历」",
  "target": "求职方向/目标岗位（若文本中有则填，否则空串）",
  "basic": {
    "name": "姓名",
    "phone": "电话",
    "email": "邮箱",
    "city": "城市",
    "school": "学校",
    "major": "专业",
    "education": "学历（如 本科/硕士）",
    "graduationYear": "毕业年份（如 2027）"
  },
  "skills": ["技能1", "技能2"],
  "experiences": [
    { "company": "公司", "role": "职位", "start": "开始时间", "end": "结束时间", "points": ["成果1", "成果2"] }
  ],
  "projects": [
    { "name": "项目名", "role": "担任角色", "desc": "项目简介", "highlights": ["亮点1", "亮点2"] }
  ],
  "selfEvaluation": "自我评价原文或空串"
}

规则：
1. 只抽取文本中真实存在的信息，绝不虚构姓名、电话、公司、时间、数据。
2. 时间统一成「2025.07」这种简洁格式；未知留空串。
3. 每个经历/项目的 points/highlights 拆成独立短句数组，按原文要点拆分。
4. 文本中没有的字段填空串或空数组，不要编造。
5. 所有内容使用简体中文。`

/** 把 AI 返回整理成安全的结构，缺字段补默认值，避免前端崩溃 */
function normalize(r = {}) {
  const base = { title: '', target: '', basic: {}, skills: [], experiences: [], projects: [], selfEvaluation: '' }
  const basic = { ...base.basic, ...(r.basic || {}) }
  return {
    ...base,
    ...r,
    basic,
    skills: Array.isArray(r.skills) ? r.skills.map(String).filter(Boolean) : [],
    experiences: Array.isArray(r.experiences)
      ? r.experiences.filter(Boolean).map((e) => ({
          company: String(e.company || ''),
          role: String(e.role || ''),
          start: String(e.start || ''),
          end: String(e.end || ''),
          points: Array.isArray(e.points) ? e.points.map(String).filter(Boolean) : [],
        }))
      : [],
    projects: Array.isArray(r.projects)
      ? r.projects.filter(Boolean).map((p) => ({
          name: String(p.name || ''),
          role: String(p.role || ''),
          desc: String(p.desc || ''),
          highlights: Array.isArray(p.highlights) ? p.highlights.map(String).filter(Boolean) : [],
        }))
      : [],
    selfEvaluation: String(r.selfEvaluation || ''),
  }
}

router.post('/api/resume/import', async (req, res) => {
  const { filename, data } = req.body || {}
  if (!filename || !data) {
    return res.status(400).json({ error: '缺少文件（filename 与 data 必填）' })
  }

  // 1) 抽取纯文本（确定性）
  let text
  try {
    text = await extractResumeText({ filename, data })
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message })
  }
  if (!text) {
    return res.status(400).json({
      error: '未能从文件中提取到文字，可能是扫描版图片 PDF（请先用 OCR 转成可复制文本后再导入）。',
    })
  }

  // 2) AI 结构化映射（依赖 DeepSeek）
  try {
    const result = await chatJSON([
      { role: 'system', content: STRUCTURE_PROMPT },
      { role: 'user', content: `简历原文：\n${text.slice(0, 12000)}` },
    ])
    const resume = normalize(result)
    res.json({ resume, rawText: text })
  } catch (err) {
    console.error('[resume/import] structure failed:', err.message)
    // 抽取成功但 AI 结构化失败：仍返回原文，前端提示用户手动整理
    res.status(422).json({ error: '已读取文件，但 AI 结构化失败：' + err.message, rawText: text })
  }
})

export default router
