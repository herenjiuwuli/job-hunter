import { Router } from 'express'
import { listMine, readProfileOf } from '../lib/scope.js'
import { STAGE_KEYS } from '../lib/stages.js'

/**
 * 求职总览看板：聚合简历 / 投递 / 面试 / 画像四类数据，
 * 让用户一眼看清「投了多少、进行到哪、面了几场、错了几题」。
 * 只读接口，不写任何数据文件。
 */
const router = Router()

const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']
const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']
const WRONG_THRESHOLD = 70 // 与 records.js 的错题阈值保持一致

function countBy(list, keys, keyFn) {
  const map = {}
  for (const k of keys) map[k] = 0
  for (const item of list) {
    const k = keyFn(item)
    if (map[k] != null) map[k]++
  }
  return map
}

function byDateDesc(list, key) {
  return list.slice().sort((a, b) => new Date(b[key] || 0) - new Date(a[key] || 0))
}

router.get('/api/dashboard', async (req, res) => {
  // 这是「聚合读」接口：如果只过滤 CRUD 而漏了这里，别人的数据依然会以统计数字的形式泄露
  const [apps, recs, reses, profile] = await Promise.all([
    listMine('applications', req.userId),
    listMine('records', req.userId),
    listMine('resumes', req.userId),
    readProfileOf(req.userId),
  ])
  const prof = profile || {}

  const byStatus = countBy(apps, STATUSES, (a) => a.status)
  const byResult = countBy(apps, RESULTS, (a) => a.result)
  /**
   * 按平台阶段（stage）统计 —— 这才是「进度」的真实来源。
   *
   * status 是人工标注，采集器不写它，所以它长期停在初始值（实测 46 条全是「已投递」，
   * 而 stage 是 39 已投递 / 3 被查看 / 3 不合格 / 1 初筛）。
   * 页面只读 status 就等于把平台的真实进度全遮掉了，看起来像「没同步」。
   */
  const byStage = countBy(apps, STAGE_KEYS, (a) => a.stage)
  // 进行中 = 排除两个终态（不合格 / 录用）。
  // 有 stage 按 stage 判；没有 stage 的草稿回退到 status，避免把草稿算成「进行中」。
  const activeCount = apps.filter((a) => {
    // 我自己放弃的已经结束了（哪怕 stage 停在「被查看」）—— 算进「进行中」会把待办虚高
    if (a.withdrawnAt) return false
    if (a.stage) return a.stage !== 'rejected' && a.stage !== 'offer'
    return a.status !== '已拒绝' && a.status !== '已淘汰'
  }).length

  // 面试表现（records 原始未排序，这里按时间倒序取最新）
  const sortedRecs = byDateDesc(recs, 'createdAt')
  const scores = sortedRecs
    .map((r) => r.report?.totalScore)
    .filter((s) => typeof s === 'number' && !Number.isNaN(s))
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const latestScore = scores.length ? scores[0] : 0

  // 错题总数：以保存时打好的 wrong 标记为准，旧数据按 score<70 兜底
  let wrongCount = 0
  for (const r of recs) {
    const pq = r.report?.perQuestion
    if (!Array.isArray(pq)) continue
    for (const q of pq) {
      if (q.wrong === true || Number(q.score) < WRONG_THRESHOLD) wrongCount++
    }
  }

  const targets = Array.isArray(prof.targets?.primaryRoles) ? prof.targets.primaryRoles.filter(Boolean) : []

  res.json({
    counts: {
      resumes: reses.length,
      applications: apps.length,
      records: recs.length,
      profileFilled: Boolean(prof.basic?.name || prof.currentStatus?.currentRole || targets.length),
    },
    applications: {
      byStatus,
      byStage,
      byResult,
      activeCount,
      // 「待我回复」：只有**对方在聊天框里发了消息**才算。
      // 曾经按 stage ∈ {viewed,screening,...} && !repliedAt 算，把「简历被查看 / 进初筛」
      // 当成了待办 —— 那只是平台状态，压根没有消息等我回（2026-11-06 主人纠正）。
      // 判据与前端 needsMyAction 保持一致：awaitingReply + 非放弃 + 非不合格。
      needActionCount: apps.filter(
        (a) => a.awaitingReply === true && !a.withdrawnAt && a.stage !== 'rejected'
      ).length,
      recent: byDateDesc(apps, 'appliedAt')
        .slice(0, 5)
        .map((a) => ({
          company: a.company,
          jobTitle: a.jobTitle,
          status: a.status,
          stage: a.stage || '',
          result: a.result,
          appliedAt: a.appliedAt,
        })),
    },
    interview: {
      total: recs.length,
      avgScore,
      latestScore,
      wrongCount,
      recent: sortedRecs.slice(0, 3).map((r) => ({
        id: r.id,
        job: r.job,
        totalScore: r.report?.totalScore ?? null,
        createdAt: r.createdAt,
      })),
    },
    targets,
  })
})

export default router
