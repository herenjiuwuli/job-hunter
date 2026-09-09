import { Router } from 'express'
import { readJSON } from '../lib/store.js'

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

router.get('/api/dashboard', async (_req, res) => {
  const [applications, records, resumes, profile] = await Promise.all([
    readJSON('applications'),
    readJSON('records'),
    readJSON('resumes'),
    readJSON('profile'),
  ])
  const apps = applications || []
  const recs = records || []
  const reses = resumes || []
  const prof = profile || {}

  const byStatus = countBy(apps, STATUSES, (a) => a.status)
  const byResult = countBy(apps, RESULTS, (a) => a.result)
  // 进行中 = 排除「已拒绝 / 已淘汰」两个终态
  const activeCount = apps.filter((a) => a.status !== '已拒绝' && a.status !== '已淘汰').length

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
      byResult,
      activeCount,
      recent: byDateDesc(apps, 'appliedAt')
        .slice(0, 5)
        .map((a) => ({
          company: a.company,
          jobTitle: a.jobTitle,
          status: a.status,
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
