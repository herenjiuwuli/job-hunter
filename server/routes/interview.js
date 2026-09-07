import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { resolveJob } from '../lib/jobs.js'

const router = Router()

/**
 * 当 AI 在非末轮漏返回 nextQuestion 时，从题库里挑一道还没问过的题兜底续面。
 * 纯函数，便于单测；返回 null 表示无题可兜底（调用方应优雅结束面试）。
 */
export function pickFallbackQuestion(pool, askedQuestions) {
  if (!Array.isArray(pool) || pool.length === 0) return null
  const asked = (askedQuestions || []).map((s) => String(s))
  // 精确匹配：兜底取的题会原样进入 history，能准确识别「已取过」，
  // 避免题库题高度同前缀（如「请介绍一下你的…」）时前 N 字模糊匹配导致过度去重。
  return pool.find((q) => !asked.includes(String(q))) || null
}

const DIFFICULTIES = {
  easy: {
    label: '简单',
    rule: '难度设定：简单。只问基础、常规的问题，不进行任何追问（isFollowUp 恒为 false），点评语气更加鼓励、肯定。',
  },
  medium: {
    label: '中等',
    rule: '难度设定：中等。提问常规难度，候选人回答后若有值得深挖的点，允许追问一次。',
  },
  hard: {
    label: '困难',
    rule: '难度设定：困难。问题更有挑战、深挖简历与回答中的细节，候选人回答后允许追问一次。',
  },
}

const INTERVIEWER_TYPES = {
  tech: {
    label: '技术面',
    persona: (name) => `你是一位「${name}」岗位的资深技术面试官，风格专业、友好但不失严谨。`,
    poolKey: 'questions',
    focus: '重点考察岗位专业技能、项目深度与解决问题的能力。',
    review: '',
  },
  hr: {
    label: 'HR面',
    persona: (name) => `你是一位「${name}」岗位的 HR 面试官，风格亲和、专业。`,
    poolKey: 'hrQuestions',
    focus: '重点考察求职动机、稳定性、沟通表达、职业规划与团队融入，不考察技术细节。',
    review: '',
  },
  star: {
    label: '行为面',
    persona: (name) => `你是一位「${name}」岗位的行为面试官，擅长用 STAR 方法深挖候选人的真实经历。`,
    poolKey: 'starQuestions',
    focus: '重点考察候选人过去真实行为经历，必要时追问事件细节。',
    review: '点评时按 STAR 四要素检查候选人的回答：情境（Situation）、任务（Task）、行动（Action）、结果（Result）；明确指出回答中缺少哪个要素，并提示补充该要素的具体内容。',
  },
}

/** 构造面试官系统提示词 */
function buildSystemPrompt(jobInfo, resume, round, total, difficulty = 'medium', allowFollowUp = true, interviewerType = 'tech') {
  const type = INTERVIEWER_TYPES[interviewerType] || INTERVIEWER_TYPES.tech
  const pool = (jobInfo && (jobInfo[type.poolKey] || jobInfo.questions)) || []
  let jd = ''
  if (jobInfo) {
    const parts = []
    if (jobInfo.jd) {
      parts.push(`岗位 JD：\n${jobInfo.jd}`)
    } else {
      parts.push(`目标岗位：${jobInfo.name}（用户未提供 JD，请基于岗位名称与候选人简历内容自行出题）`)
    }
    if (pool.length) parts.push(`题目池参考：\n${pool.join('\n')}`)
    jd = parts.join('\n\n')
  }
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES.medium
  const followRule = allowFollowUp
    ? `5. 候选人回答后，若回答中有值得深挖的点，可以对本题追问一次：此时 nextQuestion 输出追问问题，并把 isFollowUp 设为 true（追问不算新的一题，不计入总题数）；若无需追问则 isFollowUp 为 false`
    : `5. 本题不允许追问（难度为简单，或本题已经追问过一次）：isFollowUp 必须为 false，直接进入下一个问题或在全部答完时结束`
  return `${type.persona(jobInfo?.name || '资深')}你正在对一位候选人进行模拟面试，共 ${total} 个问题，当前是第 ${round} 个问题。

候选人简历：
${String(resume).slice(0, 6000)}
${jd}

考察重点：${type.focus}
${diff.rule}

提问规则：
1. 基于候选人简历和岗位要求提问，优先从题目池选取，也可根据简历个性化提问
2. 一次只问一个问题，问题简短明确
3. 候选人回答后，先给出简短点评（具体但温和，指出做得好的点和改进方向，不打击信心）${type.review ? '。' + type.review : ''}，再进行追问或提出下一个问题
4. 全程使用简体中文，保持面试官身份，不跳出角色
${followRule}

输出格式：严格输出 JSON：
{ "comment": "对候选人上一个回答的点评", "score": 0-100 的整数（表示对候选人本题回答的评分）, "referencePoints": ["本题的参考答案要点1（好的回答应包含的角度/内容）", "要点2", "要点3"], "polish": "对该回答的润色版本（更结构化、表达更清晰，保留原意、绝不虚构内容；若回答已经很好则输出空字符串）", "nextQuestion": "下一个问题或追问；若全部问题已答完则为空字符串", "isFollowUp": false }`
}

router.post('/api/interview/start', async (req, res) => {
  const { resume, job, jd = '', questions = 5, difficulty = 'medium', interviewerType = 'tech' } = req.body || {}

  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }
  if (!job) {
    return res.status(400).json({ error: '请先填写岗位' })
  }
  const total = Math.min(8, Math.max(3, Number(questions) || 5))
  const diff = DIFFICULTIES[difficulty] ? difficulty : 'medium'
  const type = INTERVIEWER_TYPES[interviewerType] ? interviewerType : 'tech'

  // 岗位不限：命中知识库用题库，否则按「自定义岗位 + 自定义 JD」出题
  const jobInfo = await resolveJob(job, jd)

  try {
    const data = await chatJSON([
      {
        role: 'system',
        content: buildSystemPrompt(jobInfo, resume, 1, total, diff, true, type),
      },
      {
        role: 'user',
        content: `面试现在开始。请发出第 1 个问题，严格输出 JSON：{ "firstQuestion": "你的第一个问题" }`,
      },
    ])

    if (!data.firstQuestion) throw new Error('AI 未返回第一题')
    res.json({ firstQuestion: data.firstQuestion, total, job: jobInfo.name, difficulty: diff, interviewerType: type })
  } catch (err) {
    console.error('[interview/start] failed:', err.message)
    res.status(500).json({ error: '面试启动失败，请稍后重试' })
  }
})

router.post('/api/interview/answer', async (req, res) => {
  const { history = [], answer, resume = '', job, jd = '', total = 5, difficulty = 'medium', current, followUpUsed = false, interviewerType = 'tech' } = req.body || {}

  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ error: '回答内容不能为空' })
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: '对话历史不能为空' })
  }

  // 只保留合法角色，防止注入异常内容
  const cleanHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content).trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))

  const diff = DIFFICULTIES[difficulty] ? difficulty : 'medium'
  const type = INTERVIEWER_TYPES[interviewerType] ? interviewerType : 'tech'
  // 当前题号：优先用前端传入（追问不计题号）；兜底用 user 消息数
  const answeredFromHistory = cleanHistory.filter((m) => m.role === 'user').length
  const round = Math.max(1, Math.min(Number(total) || 5, Number(current) || answeredFromHistory))

  // 追问控制：easy 不追问；同一道题最多追问 1 次（前端传 followUpUsed）
  const allowFollowUp = diff !== 'easy' && !followUpUsed

  let jobInfo = null
  if (job) {
    jobInfo = await resolveJob(job, jd)
  }

  // 将对话历史拼接为单条 user 消息（该模型对「多轮 assistant 历史 + json_object」存在兼容问题）
  const transcript = [...cleanHistory, { role: 'user', content: String(answer) }]
    .map((m) => (m.role === 'assistant' ? '面试官：' : '候选人：') + m.content)
    .join('\n')

  try {
    const data = await chatJSON([
      { role: 'system', content: buildSystemPrompt(jobInfo, resume, round, Number(total) || 5, diff, allowFollowUp, type) },
      {
        role: 'user',
        content: `以下是本次面试的完整对话记录：\n${transcript}\n\n请点评候选人最后一条回答（含 score 与 referencePoints），并决定是否追问或给出下一个问题。严格输出 JSON。`,
      },
    ])

    const comment = data.comment || '回答收到，我们继续。'
    const score = Number.isFinite(Number(data.score))
      ? Math.max(0, Math.min(100, Math.round(Number(data.score))))
      : null
    const referencePoints = Array.isArray(data.referencePoints)
      ? data.referencePoints.map((s) => String(s)).filter(Boolean).slice(0, 4)
      : []
    // 9.4 回答润色：保留原意的结构化优化版本，AI 判断回答已很好时可能为空
    const polish = String(data.polish || '').trim()

    // 追问判定：需同时满足 难度允许/未追问过/AI 标记追问/有追问内容
    let isFollowUp = allowFollowUp && data.isFollowUp === true

    let nextQuestion = isFollowUp ? String(data.nextQuestion || '') : data.nextQuestion || ''
    if (isFollowUp && !nextQuestion) isFollowUp = false

    let isLast = round >= (Number(total) || 5) && !isFollowUp
    if (isLast) nextQuestion = ''

    // 兜底：非末轮且非追问但 AI 漏返 nextQuestion（偶发模型抖动），不硬 500 中断，
    // 改为从题库取一道未问过的题续面；题库空了则优雅结束面试。
    if (!isLast && !isFollowUp && !nextQuestion) {
      const asked = cleanHistory.filter((m) => m.role === 'assistant').map((m) => m.content)
      const fallback = pickFallbackQuestion(jobInfo?.questions || [], asked)
      if (fallback) {
        nextQuestion = fallback
        console.warn('[interview/answer] AI 漏返 nextQuestion，已从题库兜底续面')
      } else {
        isLast = true
        console.warn('[interview/answer] AI 漏返 nextQuestion 且无剩余题库，优雅结束面试')
      }
    }

    res.json({ comment, score, referencePoints, polish, nextQuestion, isFollowUp, isLast })
  } catch (err) {
    console.error('[interview/answer] failed:', err.message)
    res.status(500).json({ error: '处理回答失败，请稍后重试' })
  }
})

router.post('/api/interview/report', async (req, res) => {
  const { history = [], job, jd = '' } = req.body || {}

  if (!Array.isArray(history) || history.length < 2) {
    return res.status(400).json({ error: '对话历史不完整，无法生成报告' })
  }

  const cleanHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content).trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))

  const transcript = cleanHistory
    .map((m) => (m.role === 'assistant' ? '面试官：' : '候选人：') + m.content)
    .join('\n')

  let jobInfo = null
  if (job) {
    jobInfo = await resolveJob(job, jd)
  }

  const systemPrompt = `你是一位资深面试官，刚刚完成了一场「${jobInfo?.name || '技术'}」岗位的模拟面试。请根据以下完整对话记录，对候选人的表现生成一份复盘报告，严格输出 JSON：
{
  "totalScore": 0-100 的整数，
  "dimensions": [{ "name": "表达清晰度", "score": 0-100 }, { "name": "技术深度", "score": 0-100 }, { "name": "逻辑性", "score": 0-100 }, { "name": "岗位匹配度", "score": 0-100 }],
  "perQuestion": [{ "q": "面试官的问题", "answer": "候选人当时回答的简要内容（保留关键原意，可适当压缩）", "score": 0-100, "comment": "针对这道题回答的具体点评（含改进方向）" }],
  "suggestions": ["改进建议1", "改进建议2", "改进建议3"],
  "keyPoints": ["复盘要点1", "复盘要点2", "复盘要点3"],
  "otherJobs": ["还适合投的岗位1", "还适合投的岗位2"]
}
要求：
1. dimensions 固定为这 4 个维度
2. perQuestion 覆盖面试中的每一道题（追问不算单独一题，并入所属题目）
3. 点评具体但温和，给出可落地的改进方向，不打击信心
4. 所有内容使用简体中文
5. otherJobs 只给简短岗位名（如「测试开发」「DevOps」），不要带括号或长串说明`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `以下是本次面试的完整对话记录：\n${transcript}\n\n请生成面试报告，严格输出 JSON。`,
      },
    ])

    res.json({
      totalScore: Number(data.totalScore) || 0,
      dimensions: data.dimensions || [],
      perQuestion: data.perQuestion || [],
      suggestions: data.suggestions || [],
      keyPoints: data.keyPoints || [],
      otherJobs: data.otherJobs || [],
    })
  } catch (err) {
    console.error('[interview/report] failed:', err.message)
    res.status(500).json({ error: '报告生成失败，请稍后重试' })
  }
})

export default router