import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'
import { resolveJob } from '../lib/jobs.js'

const router = Router()

const MAX_ROUNDS = 6

function hrSystemPrompt(jobInfo, resume, city, expectSalary) {
  return `你是一家公司的 HR，正在与候选人进行「${jobInfo?.name || '目标'}」岗位的薪资谈判。你专业但不咄咄逼人，会通过试探底线、适当压价、用福利和发展空间画饼等真实 HR 谈判手段来争取以合理成本达成录用。

候选人简历（节选）：
${String(resume || '').slice(0, 4000)}
${jobInfo ? (jobInfo.jd ? `\n岗位 JD：\n${jobInfo.jd}` : `\n目标岗位：${jobInfo.name}`) : ''}
${city ? `\n工作城市：${city}` : ''}
${expectSalary ? `\n候选人登记的期望薪资：${expectSalary}` : ''}

谈判规则：
1. 第一步先询问候选人的期望薪资（若已登记期望薪资，可以此为锚点展开试探）
2. 视候选人回应采取策略：适当压价、试探底线、用福利/发展空间画饼、讨论总包结构等
3. 每轮回应后先用一两句话点评候选人这个回应的策略好不好（结合谈判技巧：锚定效应、先让对方报价、谈总包不谈月薪、用市场行情支撑、留出让步空间等），再继续推进谈判
4. 候选人回应得当时你可以让步或给出接近的方案；候选人让步过快时要意识到还可以再谈
5. 全程使用简体中文，一次只说一段话（不超过 150 字），保持 HR 身份
6. 每轮输出 JSON：{ "comment": "对候选人上一句回应的策略点评（第一轮可为空字符串）", "nextMessage": "HR 的下一句谈判话术", "isLast": false }
7. 当谈判达成一致、或已明显无法达成一致、或你判断谈判已充分展开时，isLast 设为 true 且 nextMessage 为空字符串`
}

router.post('/api/salary/start', async (req, res) => {
  const { resume, job, jd = '', city = '', expectSalary = '' } = req.body || {}

  if (!resume || !String(resume).trim()) {
    return res.status(400).json({ error: '缺少简历内容' })
  }
  if (!job) {
    return res.status(400).json({ error: '请先填写岗位' })
  }

  // 岗位不限：命中知识库用知识库 JD，否则按自定义岗位 + 自定义 JD
  const jobInfo = await resolveJob(job, jd)

  try {
    const data = await chatJSON([
      { role: 'system', content: hrSystemPrompt(jobInfo, resume, city, expectSalary) },
      {
        role: 'user',
        content: `薪资谈判现在开始，你和候选人初次通话。请发出你的开场白（自然过渡到薪资话题），严格输出 JSON：{ "firstMessage": "你的开场白" }`,
      },
    ])

    if (!data.firstMessage) throw new Error('AI 未返回开场白')
    res.json({ firstMessage: data.firstMessage, maxRounds: MAX_ROUNDS, job: jobInfo.name })
  } catch (err) {
    console.error('[salary/start] failed:', err.message)
    res.status(500).json({ error: '薪资谈判启动失败，请稍后重试' })
  }
})

router.post('/api/salary/answer', async (req, res) => {
  const { history = [], answer, resume = '', job, jd = '', round = 1, city = '', expectSalary = '' } = req.body || {}

  if (!answer || !String(answer).trim()) {
    return res.status(400).json({ error: '回应内容不能为空' })
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: '对话历史不能为空' })
  }

  const cleanHistory = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content).trim())
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))

  const roundNum = Math.max(1, Math.min(MAX_ROUNDS, Number(round) || 1))
  let jobInfo = null
  if (job) {
    jobInfo = await resolveJob(job, jd)
  }

  // 对话历史拼接为单条 user 消息（模型兼容性处理，与 interview 一致）
  const transcript = [...cleanHistory, { role: 'user', content: String(answer) }]
    .map((m) => (m.role === 'assistant' ? 'HR：' : '候选人：') + m.content)
    .join('\n')

  try {
    const data = await chatJSON([
      { role: 'system', content: hrSystemPrompt(jobInfo, resume, city, expectSalary) },
      {
        role: 'user',
        content: `以下是本次薪资谈判的完整对话记录（第 ${roundNum} / ${MAX_ROUNDS} 轮）：\n${transcript}\n\n请点评候选人最后一句回应的策略，并继续推进谈判。若已是第 ${MAX_ROUNDS} 轮，请给出收尾话术并结束谈判。严格输出 JSON。`,
      },
    ])

    let isLast = data.isLast === true || roundNum >= MAX_ROUNDS
    let nextMessage = isLast ? '' : String(data.nextMessage || '')
    // 兜底：AI 标记结束但漏返 nextMessage，或判断与轮次冲突时以轮次为准
    if (!isLast && !nextMessage) isLast = true

    res.json({
      comment: String(data.comment || ''),
      nextMessage,
      isLast,
    })
  } catch (err) {
    console.error('[salary/answer] failed:', err.message)
    res.status(500).json({ error: '处理回应失败，请稍后重试' })
  }
})

router.post('/api/salary/report', async (req, res) => {
  const { history = [], job, jd = '' } = req.body || {}

  if (!Array.isArray(history) || history.length < 2) {
    return res.status(400).json({ error: '对话历史不完整，无法生成复盘' })
  }

  const transcript = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content).trim())
    .map((m) => (m.role === 'assistant' ? 'HR：' : '候选人：') + String(m.content).slice(0, 4000))
    .join('\n')

  let jobInfo = null
  if (job) {
    jobInfo = await resolveJob(job, jd)
  }

  const systemPrompt = `你是一位资深薪酬谈判教练。以下是候选人模拟「${jobInfo?.name || '目标'}」岗位薪资谈判的完整对话记录，请从候选人视角复盘表现，严格输出 JSON：
{
  "totalScore": 0-100 的整数（候选人整体谈判表现评分）,
  "comment": "一两句总体评价",
  "strategies": ["谈判策略建议1（如：应该先报高 10% 留出让步空间）", "策略建议2（如：关注总包而不只是月薪）", "策略建议3"],
  "scripts": ["可直接套用的话术建议1", "话术建议2", "话术建议3"]
}
要求：
1. 策略建议要针对对话中候选人实际暴露的问题（如过快让步、没问总包、被画饼带走等）
2. 话术建议要具体可直接使用，贴合该岗位与对话场景
3. 所有内容使用简体中文`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `以下是本次薪资谈判的完整对话记录：\n${transcript}\n\n请生成谈判复盘，严格输出 JSON。`,
      },
    ])

    res.json({
      totalScore: Math.max(0, Math.min(100, Math.round(Number(data.totalScore) || 0))),
      comment: String(data.comment || ''),
      strategies: Array.isArray(data.strategies) ? data.strategies.map(String).filter(Boolean) : [],
      scripts: Array.isArray(data.scripts) ? data.scripts.map(String).filter(Boolean) : [],
    })
  } catch (err) {
    console.error('[salary/report] failed:', err.message)
    res.status(500).json({ error: '谈判复盘生成失败，请稍后重试' })
  }
})

export default router
