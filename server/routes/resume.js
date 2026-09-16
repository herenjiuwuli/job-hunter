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

  const systemPrompt = `你是一位专业的简历排版顾问。请严格按下方「单栏 A4、板块标题带下划线、日期右对齐」的目标版式生成 Markdown 简历。

【铁律】只基于用户提供的真实信息组织、排版和润色语言，绝不虚构任何经历、技能、数据、时间、奖项。信息不足的地方宁可不写，也不要编造。

【目标版式：严格参考用户提供的简历 PDF】
1. 顶部由前端自动渲染（姓名、电话、邮箱、城市、求职岗位、头像），因此正文 Markdown 不要输出「基本信息」「联系方式」等章节。
2. 正文固定使用以下二级标题（##），按顺序出现：
   ## 教育经历
   ## 项目经历
   ## 实习/工作经历
   ## 校园经历
   ## 技能证书
   ## 个人总结
3. 每个经历/项目条目的格式必须一致：
   - 第一行：\`**名称/公司/学校/项目名**  YYYY年MM月 - YYYY年MM月\`（时间放在行尾，例如：**广州科技职业技术大学**  2023年09月 - 2027年06月）
   - 第二行：职位/角色/学位描述（普通段落，例如：计算机应用工程 本科 全日制）
   - 后续要点用 \`- **关键词**：具体描述\` 的 bullet 格式，例如：
     - **活动前期筹备**：独立统筹完成 50+ 个服务项目，负责需求沟通、方案拆解...
     - **现场执行管控**：负责活动/拍摄现场的全流程执行...
4. 日期格式统一为 \`YYYY年MM月 - YYYY年MM月\`，未知结束时间用「至今」。
5. 所有关键数据、成果数字、核心技能词、担任角色用 **加粗** 标记。禁止使用 ==高亮== 等非标准 Markdown 语法。
6. 同一段经历内部的 bullet 要点控制在 2-4 条，突出量化成果；每条 bullet 不超过一行（约 40 个中文字），不要整段加粗。
7. 为不同目标岗位生成 versions 时，只调整经历排序、措辞侧重和强调点，不新增虚构内容。
8. 若某板块信息缺失（如没有校园经历、没有技能证书、没有项目、没有实习），**直接不要输出该 ## 标题及其内容**，绝不保留空板块标题。
9. **长度硬约束：全文必须能排版在一页 A4 纸内。** 项目/经历条目总数控制在 4-6 个；如内容过多，优先保留与目标岗位最相关的内容，合并或删减次要的校园/证书板块；个人总结控制在 2-3 行。

输出格式：严格输出 JSON：
{
  "resumeText": "通用版简历（Markdown，按上述固定二级标题顺序；只用 **加粗** 标关键数据，绝不使用 ==高亮==）",
  "versions": [{ "job": "岗位名", "text": "针对该岗位优化排序与措辞侧重的简历（Markdown），不新增内容" }]
}
要求：
1. versions 依次对应用户选择的每个目标岗位
2. Markdown 中不要使用一级标题（#），不要使用 ==高亮== 等非标准语法
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
