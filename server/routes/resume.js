import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'

const router = Router()

router.post('/api/resume/generate', async (req, res) => {
  const { basicInfo } = req.body || {}
  const {
    name,
    school = '',
    major = '',
    skills = '',
    projects = '',
    targetJobs = [],
    gender = '',
    age = '',
    phone = '',
    email = '',
    jobTitle = '',
    city = '',
    political = '',
    education = '',
    gradYear = '',
  } = basicInfo || {}

  if (!basicInfo || !String(name).trim()) {
    return res.status(400).json({ error: '姓名不能为空' })
  }
  if (!String(skills).trim() && !String(projects).trim()) {
    return res.status(400).json({ error: '技能和项目经历至少填写一项' })
  }

  const jobs = Array.isArray(targetJobs) ? targetJobs.filter((j) => String(j).trim()).slice(0, 5) : []

  const systemPrompt = `你是一位专业的简历顾问。请根据用户提供的真实信息，主动判断该如何排版、哪里需要重点强调，组织生成结构化的 Markdown 简历。

【铁律】只基于用户提供的真实信息组织、排版和润色语言，绝不虚构任何经历、技能、数据、时间、奖项。信息不足的地方宁可不写，也不要编造。

【排版与强调要求】
1. 主动判断信息的重要性：把最亮眼、与目标岗位最匹配的经历放在更靠前的位置；为不同目标岗位调整技能与项目的呈现顺序和措辞侧重。
2. 用 Markdown 强调语法帮用户突出重点（用户之后仍可手动编辑调整，所以请大胆但克制地标注）：
   - 用 **加粗** 标记关键数据、成果数字、核心技能词、担任角色（例："将接口响应时间降低 **40%**"、"主导 **Node.js** 后端"）
   - 用 ==高亮== 标记每个板块中"最值得一眼看到"的 1 个重点（如旗舰项目名、最亮眼指标），全篇不宜过多，克制使用
3. 不要整句加粗、不要为了强调而编造内容；强调要精准服务于"让人一眼抓住亮点"。
4. 每段教育/工作/项目经历的"名称 + 起止时间"写在同一行，时间放在行尾（前端会自动把日期右对齐成两栏），例如：
   - 教育：\`XX大学 数字媒体技术专业（本科）  2021.09 - 2025.06\`
   - 工作/实习：\`XX公司 新媒体运营实习生  2023.07 - 2023.09\`
   - 项目：\`XX运营项目（负责人）  2022.03 - 2022.12\`
   若时间未知用"至今"。各经历下设要点用 \`- \` 列表，关键数据加 **加粗**。

输出格式：严格输出 JSON：
{
  "resumeText": "通用版简历（Markdown 格式，用 ## 二级标题分块，如：教育背景/专业技能/项目经历/自我评价；需按上述要求使用 **加粗** 与 ==高亮== 突出重点）。注意：姓名、电话、邮箱、求职岗位等基本信息由系统单独在顶部展示，简历正文从「教育背景」开始，不要输出「基本信息」章节",
  "versions": [{ "job": "岗位名", "text": "针对该岗位优化排版与强调点的简历（Markdown），调整技能与项目的呈现顺序和措辞侧重，但不新增内容" }]
}
要求：
1. versions 依次对应用户选择的每个目标岗位
2. Markdown 中不要使用一级标题（#）
3. 所有内容使用简体中文`

  const infoText = `姓名：${name}
性别：${gender || '未填写'}
年龄：${age || '未填写'}
电话：${phone || '未填写'}
邮箱：${email || '未填写'}
求职岗位：${jobTitle || '未填写'}
城市：${city || '未填写'}
政治面貌：${political || '未填写'}
学校：${school || '未填写'}
专业：${major || '未填写'}
学历：${education || '未填写'}
毕业时间：${gradYear || '未填写'}
技能（逗号分隔）：${skills || '未填写'}
项目经历要点：${projects || '未填写'}
目标岗位：${jobs.length ? jobs.join('、') : '无'}`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `我的真实信息如下：\n${infoText}\n\n请生成简历，严格输出 JSON。` },
    ])

    if (!data.resumeText) throw new Error('AI 未返回简历内容')

    res.json({
      resumeText: data.resumeText,
      versions: (data.versions || [])
        .filter((v) => v && v.text)
        .map((v) => ({ job: String(v.job || ''), text: String(v.text) })),
    })
  } catch (err) {
    console.error('[resume/generate] failed:', err.message)
    res.status(500).json({ error: '简历生成失败，请稍后重试' })
  }
})

router.post('/api/resume/score', async (req, res) => {
  const { resumeText, job = '' } = req.body || {}

  if (!resumeText || !String(resumeText).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }

  const systemPrompt = `你是一位资深 HR 兼简历顾问，请对下面这份简历进行专业评分。${job ? `目标岗位：${job}。` : ''}

严格输出 JSON：
{
  "totalScore": 0-100 的整数（简历综合评分）,
  "dimensions": [
    { "name": "内容完整性", "score": 0-100 的整数 },
    { "name": "亮点突出度", "score": 0-100 的整数 },
    { "name": "语言表达", "score": 0-100 的整数 },
    { "name": "岗位匹配", "score": 0-100 的整数 }
  ],
  "suggestions": ["优化建议1（具体可落地）", "优化建议2", "优化建议3"]
}
要求：
1. 评分客观严格，指出真实短板
2. 建议要具体到怎么改（如"项目经历缺少量化数据，建议补充 XX"），不泛泛而谈
3. 所有内容使用简体中文`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `请对这份简历评分：\n${String(resumeText).slice(0, 8000)}`,
      },
    ])

    if (!data.dimensions) throw new Error('AI 未返回评分')
    res.json({
      totalScore: Math.max(0, Math.min(100, Math.round(Number(data.totalScore) || 0))),
      dimensions: (data.dimensions || [])
        .filter((d) => d && d.name)
        .map((d) => ({ name: String(d.name), score: Math.max(0, Math.min(100, Math.round(Number(d.score) || 0))) }))
        .slice(0, 6),
      suggestions: (data.suggestions || []).map(String).filter(Boolean).slice(0, 6),
    })
  } catch (err) {
    console.error('[resume/score] failed:', err.message)
    res.status(500).json({ error: '简历评分失败，请稍后重试' })
  }
})

export default router
