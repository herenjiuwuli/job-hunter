import { Router } from 'express'
import { listMine } from '../lib/scope.js'
import { scoreResumeVsJd } from '../lib/matcher.js'
import { chatJSON } from '../lib/ai.js'
import { serializeResume } from './tailor.js'

const router = Router()

// GET /api/match?resumeId=xxx
// 把简历与所有「带了 JD 的投递记录」逐一打分，按匹配分降序返回（快速关键词覆盖度，仅作粗排）
router.get('/api/match', async (req, res) => {
  const { resumeId } = req.query
  if (!resumeId) return res.status(400).json({ error: '请先选择简历' })

  const resumes = await listMine('resumes', req.userId)
  const resume = resumes.find((r) => r.id === resumeId)
  if (!resume) return res.status(404).json({ error: '简历不存在' })

  const apps = await listMine('applications', req.userId)
  const scored = apps
    .filter((a) => String(a.jd || '').trim())
    .map((a) => {
      const { score, matched, jdKeywords } = scoreResumeVsJd(resume, a.jd)
      return {
        id: a.id,
        company: a.company,
        jobTitle: a.jobTitle,
        platform: a.platform,
        score,
        matched,
        jdKeywords,
      }
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))

  res.json(scored)
})

// POST /api/match/jd  { resumeId?, jdText, company?, jobTitle? }
// 投前快速匹配：纯关键词加权（不调 LLM），给扩展在「投递前」判断是否值得投。
// resumeId 缺省时用「自己的」简历库第一份；返回 0-100 分 + 命中词 + 缺失词。
router.post('/api/match/jd', async (req, res) => {
  const { resumeId, jdText, company = '', jobTitle = '' } = req.body || {}
  const jd = String(jdText || '').trim()
  if (!jd) return res.status(400).json({ error: '缺少 jdText' })

  const resumes = await listMine('resumes', req.userId)
  if (!resumes.length) return res.status(404).json({ error: '简历库为空，请先在网页端导入简历' })

  // 指定了 id 就必须是自己的那份：老逻辑「找不到就退回到第一份」在多用户下
  // 等于「拿别人 id 也能拿到自己第一份简历」→ 现在直接 404，不猜。
  let resume
  if (resumeId) {
    resume = resumes.find((r) => r.id === resumeId)
    if (!resume) return res.status(404).json({ error: '简历不存在' })
  } else {
    resume = resumes[0]
  }
  const { score, matched, jdKeywords } = scoreResumeVsJd(resume, jd.slice(0, 8000))
  const matchedSet = new Set(matched)

  res.json({
    resumeId: resume.id,
    resumeTitle: resume.title || '',
    company: String(company),
    jobTitle: String(jobTitle),
    score, // null = JD 里没有词库中的关键词，无法评估
    matched,
    missing: jdKeywords.filter((k) => !matchedSet.has(k)),
    jdKeywordCount: jdKeywords.length,
  })
})

// POST /api/match/analyze  { resumeId, applicationId }
// 深度匹配分析：用 job-match 方法论把 JD 拆成可核验要求，与简历证据逐项对照，
// 输出「要求—证据矩阵 + 硬性门槛 + 优先补强 + 投递建议」。明确不出伪精确百分比分数。
router.post('/api/match/analyze', async (req, res) => {
  const { resumeId, applicationId } = req.body || {}
  if (!resumeId) return res.status(400).json({ error: '请先选择简历' })
  if (!applicationId) return res.status(400).json({ error: '请先选择要分析的岗位' })

  const resumes = await listMine('resumes', req.userId)
  const resume = resumes.find((r) => r.id === resumeId)
  if (!resume) return res.status(404).json({ error: '简历不存在' })

  const apps = await listMine('applications', req.userId)
  const app = apps.find((a) => a.id === applicationId)
  if (!app) return res.status(404).json({ error: '投递记录不存在' })
  if (!String(app.jd || '').trim()) return res.status(400).json({ error: '该岗位没有 JD，无法深度分析' })

  // 复用 tailor 的简历序列化（把结构化简历压成可读文本）
  const resumeText = serializeResume(resume)

  const systemPrompt = `你是一位严谨的岗位匹配分析师。请把招聘 JD 拆成可核验的要求，再与候选人的简历证据逐项对照。
目标不是生成一个看似精确的匹配分数，而是判断：哪些要求已经有证据、哪些只是简历没写清、哪些确实要补，以及是否值得投这一次。

分析原则：
1. 从 JD 提取岗位职责、硬性条件、核心能力、加分项和申请约束；合并重复表述，不把公司宣传语当候选人要求。
2. 为每项要求寻找简历中的直接证据，记录证据位置与个人边界；团队成果不能自动视为个人能力。
3. 匹配状态只能取以下五种之一：
   - "已匹配"：存在明确、可展开的事实或作品证据；
   - "表达缺口"：候选人做过相关工作，但简历没清楚呈现；
   - "证据不足"：材料暗示可能具备，但无法支撑对外表述；
   - "真实缺口"：现有事实明确不满足或候选人确认尚未具备；
   - "待确认"：缺少决定性信息，不能替候选人猜测。
4. 硬性条件（地点、学历、工作授权、年限、必备证书）单独列在 hardGates，不被其他优势抵消。
5. 结论只能取以下四种之一："建议投递" / "补充材料后投递" / "谨慎投递" / "暂不建议投递"。
6. 不输出伪精确的百分比匹配分；不为了贴合 JD 添加候选人没做过的技能/职责/职级/项目/指标。
7. 所有内容使用简体中文，严格输出 JSON（不要输出 JSON 以外的任何内容）。

输出 JSON 结构：
{
  "conclusion": "一句话说明建议与最关键原因（30 字内）",
  "hardGates": [{ "requirement": "硬性要求", "status": "已满足|未满足|待确认", "note": "一句话说明" }],
  "matrix": [
    {
      "requirement": "JD 中的一项要求",
      "importance": "硬性|核心|加分",
      "evidence": "简历中对应的证据（引用具体项目/技能/经历；找不到写'未提供'）",
      "status": "已匹配|表达缺口|证据不足|真实缺口|待确认",
      "risk": "若不匹配，面试时会被怎么追问 / 风险点"
    }
  ],
  "priorityFix": [{ "type": "调整表达|补证据|补能力", "action": "最多 5 条，具体可操作" }],
  "strategy": {
    "advice": "建议投递|补充材料后投递|谨慎投递|暂不建议投递",
    "resumeVersion": "对该岗位建议使用哪版简历（如'突出测试开发经验的定制版'）",
    "questions": ["投递前需要向自己确认的问题（最多 3 条）"]
  }
}`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `候选人简历：\n${resumeText}\n\n目标岗位：\n公司：${app.company || '未填'}\n岗位：${app.jobTitle || '未填'}\n\n岗位 JD：\n${String(app.jd).slice(0, 4000)}\n\n请按上述结构做深度匹配分析，严格输出 JSON。`,
      },
    ])

    const matrix = Array.isArray(data.matrix) ? data.matrix : []
    const hardGates = Array.isArray(data.hardGates) ? data.hardGates : []
    const priorityFix = Array.isArray(data.priorityFix) ? data.priorityFix : []
    const strategy = data.strategy && typeof data.strategy === 'object' ? data.strategy : {}

    res.json({
      conclusion: String(data.conclusion || ''),
      hardGates: hardGates.map((g) => ({
        requirement: String(g.requirement || ''),
        status: ['已满足', '未满足', '待确认'].includes(g.status) ? g.status : '待确认',
        note: String(g.note || ''),
      })),
      matrix: matrix.map((m) => ({
        requirement: String(m.requirement || ''),
        importance: ['硬性', '核心', '加分'].includes(m.importance) ? m.importance : '核心',
        evidence: String(m.evidence || '未提供'),
        status: ['已匹配', '表达缺口', '证据不足', '真实缺口', '待确认'].includes(m.status)
          ? m.status
          : '待确认',
        risk: String(m.risk || ''),
      })),
      priorityFix: priorityFix.slice(0, 5).map((f) => ({
        type: ['调整表达', '补证据', '补能力'].includes(f.type) ? f.type : '调整表达',
        action: String(f.action || ''),
      })),
      strategy: {
        advice: ['建议投递', '补充材料后投递', '谨慎投递', '暂不建议投递'].includes(strategy.advice)
          ? strategy.advice
          : '补充材料后投递',
        resumeVersion: String(strategy.resumeVersion || ''),
        questions: Array.isArray(strategy.questions) ? strategy.questions.map(String).slice(0, 3) : [],
      },
    })
  } catch (err) {
    console.error('[match/analyze] failed:', err.message)
    res.status(500).json({ error: '深度匹配分析失败：' + err.message })
  }
})

export default router
