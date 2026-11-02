/**
 * 投递漏斗 —— 回答「投了这么多，到底投出什么结果」。
 *
 * 与 /api/dashboard 的区别：
 *   dashboard 数的是「我现在手上有什么」（简历几份、投递几条）；
 *   funnel 数的是「转化」—— 同一批投递从 已投递 走到 面试 漏了多少。
 *
 * 口径上最要紧的两件事：
 *
 * 1. **到达数用 stageHistory，不用当前 stage**。
 *    当前态是快照：一条记录现在是「不合格」，光看它就不知道它曾经到过面试。
 *    用快照算漏斗会把每一层都算成「此刻停在这里的人数」，
 *    最后画出来的不是漏斗而是分布图 —— 看起来层与层之间还能变大，明显不对。
 *
 * 2. **分母是「已投递出去并被平台确认过的」**，即 stage 非空。
 *    「待投递」的草稿不算进去，否则转化率被自己的草稿稀释。
 */
import { Router } from 'express'
import { readJSON } from '../lib/store.js'
import { listMine } from '../lib/scope.js'
import { FUNNEL_ORDER, STAGES, highestNormalStage, stageLabel } from '../lib/stages.js'

const router = Router()

/** 一条记录「到达过」的阶段集合（含保底 submitted） */
function reachedSet(a) {
  const set = new Set()
  // 有 stage 就说明确实投出去了 —— 哪怕历史是空的（老数据），也至少到过「已投递」
  if (a.stage) set.add('submitted')
  const hist = Array.isArray(a.stageHistory) ? a.stageHistory : []
  for (const h of hist) {
    const key = typeof h === 'string' ? h : h?.stage
    if (key && key !== 'rejected' && STAGES[key]) set.add(key)
  }
  if (a.stage && a.stage !== 'rejected' && STAGES[a.stage]) set.add(a.stage)
  // 历史里出现过的更高阶段，保底也要把中间层算上（平台可能跳着报：直接 初筛 → 面试）
  const top = highestNormalStage(hist)
  if (top) {
    const topOrder = STAGES[top].order
    for (const k of FUNNEL_ORDER) {
      if (STAGES[k].order <= topOrder) set.add(k)
    }
  }
  return set
}

function hoursBetween(fromIso, toIso) {
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round(((b - a) / 3600000) * 10) / 10
}

function summarize(list) {
  const withStage = list.filter((a) => a.stage)
  const reached = Object.fromEntries(FUNNEL_ORDER.map((k) => [k, 0]))
  const current = Object.fromEntries([...FUNNEL_ORDER, 'rejected'].map((k) => [k, 0]))
  const viewGaps = []
  const replyGaps = []

  for (const a of withStage) {
    const set = reachedSet(a)
    for (const k of set) reached[k] = (reached[k] || 0) + 1
    if (a.stage && current[a.stage] !== undefined) current[a.stage]++
    const v = hoursBetween(a.appliedAt, a.readAt)
    if (v !== null) viewGaps.push(v)
    const r = hoursBetween(a.appliedAt, a.repliedAt)
    if (r !== null) replyGaps.push(r)
  }

  const total = withStage.length
  const replied = withStage.filter((a) => a.repliedAt).length
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : null)

  // 逐层转化率：本层到达数 / 上一层到达数
  const rates = {}
  for (let i = 1; i < FUNNEL_ORDER.length; i++) {
    const prev = reached[FUNNEL_ORDER[i - 1]]
    rates[`${FUNNEL_ORDER[i - 1]}→${FUNNEL_ORDER[i]}`] = prev > 0 ? Math.round((reached[FUNNEL_ORDER[i]] / prev) * 1000) / 10 : null
  }

  return {
    total,
    reached,
    current,
    rateView: total ? Math.round((reached.viewed / total) * 1000) / 10 : null,
    rateReply: total ? Math.round((replied / total) * 1000) / 10 : null,
    rateInterview: total ? Math.round((reached.interview / total) * 1000) / 10 : null,
    rateOffer: total ? Math.round((reached.offer / total) * 1000) / 10 : null,
    replied,
    rates,
    avgFirstViewHours: avg(viewGaps),
    avgFirstReplyHours: avg(replyGaps),
  }
}

/**
 * GET /api/funnel?groupBy=platform|direction|resume
 *
 * 分组的意义：只给一个总数没法治——「回复率 12%」到底是简历问题还是方向问题，
 * 只有拆开看才知道。三个维度分别对应简历版本、投递方向、平台。
 */
router.get('/api/funnel', async (req, res) => {
  const groupBy = ['platform', 'direction', 'resume'].includes(req.query.groupBy)
    ? req.query.groupBy
    : null

  const list = await listMine('applications', req.userId)
  const overall = summarize(list)
  if (!groupBy) return res.json({ groupBy: null, overall, groups: [] })

  const keys = new Map()
  let resumeMap = null
  if (groupBy === 'resume') {
    const resumes = (await readJSON('resumes')) || []
    resumeMap = new Map(resumes.map((r) => [r.id, r.title || r.id]))
  }

  for (const a of list) {
    if (!a.stage) continue
    let key = ''
    if (groupBy === 'platform') key = a.platform || '未知平台'
    else if (groupBy === 'direction') key = a.direction || '未分类'
    else key = resumeMap?.get(a.resumeId) || '未指定简历'
    if (!keys.has(key)) keys.set(key, [])
    keys.get(key).push(a)
  }

  const groups = [...keys.entries()]
    .map(([key, arr]) => ({ key, label: key, ...summarize(arr) }))
    .sort((a, b) => b.total - a.total)

  res.json({ groupBy, overall, groups, stages: FUNNEL_ORDER.map((k) => ({ key: k, label: stageLabel(k) })) })
})

export default router
