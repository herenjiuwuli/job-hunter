import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import { listMine, getMine, isMine } from '../lib/scope.js'
import { STAGE_KEYS, STAGES, parseStage, shouldAdvance, pushHistory, stageFromStatus } from '../lib/stages.js'
import { lookupDirection, normKey } from '../lib/jobsIndex.js'

const router = Router()
const KEY = 'applications'

export const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']

/**
 * 单次投递「结果」（applypilot 五态结果机）：
 * 与 STATUSES 的「求职流程阶段」是正交的两个维度——
 * STATUSES 回答「这单推进到哪一步了」，RESULTS 回答「这一次投递到底成没成」。
 * 自动化/半自动投递后，只有看到「已确认提交」才算真的投出去了。
 */
export const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']

/**
 * @param {object} input 请求体
 * @param {object} [prev] 编辑时的旧记录。**必须传**，否则 PUT 会把采集来的
 *   stage / readAt / stageHistory 全部清空 —— 用户在网页上改个备注，
 *   平台的真实进度就丢了，这类「编辑顺手删数据」最难发现。
 */
function sanitize(input = {}, prev = {}) {
  const keepStage = STAGE_KEYS.includes(input.stage) ? input.stage : prev.stage || null
  return {
    id: randomUUID(),
    resumeId: input.resumeId || prev.resumeId || '',
    company: String(input.company || '').trim(),
    jobTitle: String(input.jobTitle || '').trim(),
    platform: String(input.platform || '').trim(),
    jobId: String(input.jobId || prev.jobId || '').trim(),
    direction: String(input.direction || prev.direction || '').trim(),
    jd: String(input.jd || '').slice(0, 8000),
    greeting: String(input.greeting || '').slice(0, 3000),
    coverLetter: String(input.coverLetter || '').slice(0, 6000),
    tailoredResume: String(input.tailoredResume || '').slice(0, 12000),
    status: STATUSES.includes(input.status) ? input.status : '待投递',
    result: RESULTS.includes(input.result) ? input.result : '待处理',
    note: String(input.note || '').slice(0, 3000),
    appliedAt: input.appliedAt || prev.appliedAt || '',
    // ---- 以下五个字段只由采集器写，人工编辑一律原样保留 ----
    stage: keepStage,
    stageUpdatedAt: input.stageUpdatedAt || prev.stageUpdatedAt || '',
    readAt: input.readAt || prev.readAt || '',
    repliedAt: input.repliedAt || prev.repliedAt || '',
    stageHistory: Array.isArray(input.stageHistory)
      ? input.stageHistory.slice(-60)
      : Array.isArray(prev.stageHistory)
        ? prev.stageHistory
        : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

router.get('/api/applications', async (req, res) => {
  const list = await listMine(KEY, req.userId)
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
  res.json(list)
})

router.get('/api/applications/:id', async (req, res) => {
  const item = await getMine(KEY, req.userId, req.params.id)
  if (!item) return res.status(404).json({ error: '投递记录不存在' })
  res.json(item)
})

router.post('/api/applications', async (req, res) => {
  const item = sanitize(req.body)
  item.ownerId = req.userId // 归属只由后端决定，不看请求体
  if (!item.company || !item.jobTitle) {
    return res.status(400).json({ error: '公司名与岗位名不能为空' })
  }
  // 方向能自动补就补（岗位库里有同公司同岗位的 JD 时），补不到留空，前端显示「未分类」
  if (!item.direction) item.direction = lookupDirection(item.company, item.jobTitle)
  // 新建时用人工 status 兜一个初始 stage（真实投递那一刻就是「已投递」），
  // 之后只由采集器推进；这样新记录立刻能进漏斗，不用等第一次同步
  if (!item.stage) {
    const boot = stageFromStatus(item.status)
    if (boot) {
      item.stage = boot
      item.stageUpdatedAt = new Date().toISOString()
      item.stageHistory = pushHistory([], boot, { source: 'create', raw: item.status })
    }
  }
  // 读-改-写必须在同一把锁里：扩展批量投递会连续 POST，
  // 分开做会「后一条覆盖前一条」，记录静默消失
  await updateJSON(KEY, (list) => [...list, item], [])
  res.json(item)
})

router.put('/api/applications/:id', async (req, res) => {
  const body = req.body
  const saved = await updateJSON(
    KEY,
    (list) => {
      const idx = list.findIndex((a) => a.id === req.params.id)
      // 不存在、或者是别人的 → 不写，外层统一 404
      if (idx === -1 || !isMine(list[idx], req.userId)) return undefined
      const item = sanitize(body, list[idx]) // 传旧记录：保住采集来的 stage/readAt/stageHistory
      item.id = req.params.id
      item.ownerId = req.userId
      item.createdAt = list[idx].createdAt
      item.updatedAt = new Date().toISOString()
      const next = [...list]
      next[idx] = item
      return next
    },
    []
  )
  if (!saved) return res.status(404).json({ error: '投递记录不存在' })
  res.json(saved.find((a) => a.id === req.params.id))
})

router.delete('/api/applications/:id', async (req, res) => {
  let removed = false
  await updateJSON(
    KEY,
    (list) => {
      const target = list.find((a) => a.id === req.params.id)
      if (!target || !isMine(target, req.userId)) return undefined
      removed = true
      return list.filter((a) => a.id !== req.params.id)
    },
    []
  )
  if (!removed) return res.status(404).json({ error: '投递记录不存在' })
  res.json({ ok: true })
})

/**
 * 岗位名归一化，专治「同一条投递两边写法不同」。
 *
 * 平台列表页的标题常常带一个尾巴：实习僧是「台架测试实习生**实习招聘**」，
 * 而详情页 / 本地面试记录里是「台架测试实习生」。不剥掉尾巴，同一条投递永远匹配不上，
 * 表现就是「同步完一个都没推进」，而且不报错 —— 2026-11-02 真机就是这个毛病。
 */
function normTitle(s) {
  return normKey(s).replace(/(实习招聘|校园招聘|社会招聘|长期招聘|招聘|急招|热招)$/, '')
}

/**
 * 公司名是否同一家。
 * 除了完全相同，还允许「一边是另一边的子串」：本地存「法雷奥」、平台写「法雷奥汽车」，
 * 或者反过来。这不会造成张冠李戴 —— 下面还要同时比岗位名，两道一起过才算同一条。
 */
function sameCompany(a, b) {
  const x = normKey(a)
  const y = normKey(b)
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  return short.length >= 2 && long.includes(short)
}

/**
 * 判断平台上报的一条 vs 本地一条，是不是同一份投递。
 *
 * 优先用 jobId（平台主键，最可靠）；没有 jobId 才退回「平台+公司+岗位」。
 * 为什么不能只用公司名：同一家公司同时投两个岗位很常见，只按公司名配会张冠李戴。
 */
function sameApply(local, remote) {
  if (remote.jobId && local.jobId) {
    return local.jobId === remote.jobId
  }
  const lp = String(local.platform || '')
  const rp = String(remote.platform || '')
  if (lp && rp && lp !== rp) return false
  return sameCompany(local.company, remote.company) && normTitle(local.jobTitle) === normTitle(remote.jobTitle)
}

/**
 * POST /api/applications/collect —— 扩展把平台页面上的进度一次性报上来。
 *
 * body: { items: [{ platform, jobId?, company, jobTitle, stageRaw?, read?, replied?, appliedAt? }], createMissing? }
 *
 * 三条规则（每条都有测试守着）：
 *   1. **阶段只前进**：见 lib/stages.js 的 shouldAdvance —— 抓取是有时序的，
 *      页面偶尔渲染出旧状态很正常，回退一次就把漏斗搞脏了。
 *   2. **已读/已回复只记首次时间**：重复同步不会把时间刷新成今天，
 *      否则「平均多久被查看」这种指标永远等于最后一次同步时间。
 *   3. **默认不新建**：先只更新已有记录。本地账本没这家的，多半是账本没记上，
 *      静默造一条会把「我投过的」和「平台上有记录的」混成一锅。
 *      要导入历史投递得显式传 createMissing: true。
 */
router.post('/api/applications/collect', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  if (!items.length) return res.status(400).json({ error: 'items 不能为空' })
  if (items.length > 500) return res.status(400).json({ error: '一次最多上报 500 条' })
  const createMissing = req.body?.createMissing === true
  const now = new Date().toISOString()
  const stats = { matched: 0, created: 0, advancedCount: 0, unchanged: 0, ignored: 0 }
  const advancedList = []

  await updateJSON(
    KEY,
    (list) => {
      const next = [...list]
      for (const raw of items) {
        const company = String(raw.company || '').trim()
        const jobTitle = String(raw.jobTitle || '').trim()
        if (!company && !jobTitle) {
          stats.ignored++
          continue
        }
        const remote = {
          platform: String(raw.platform || '').trim(),
          jobId: String(raw.jobId || '').trim(),
          company,
          jobTitle,
        }
        const stage = parseStage(raw.stageRaw ?? raw.stage)
        const idx = next.findIndex((a) => isMine(a, req.userId) && sameApply(a, remote))

        if (idx === -1) {
          if (!createMissing) {
            stats.ignored++
            continue
          }
          if (!company || !jobTitle) {
            stats.ignored++ // 新建必须有公司+岗位，否则是噪声行
            continue
          }
          const item = sanitize({
            company,
            jobTitle,
            platform: remote.platform,
            jobId: remote.jobId,
            status: '已投递',
            appliedAt: raw.appliedAt || '',
          })
          item.ownerId = req.userId
          const boot = stage || 'submitted'
          item.stage = boot
          item.stageUpdatedAt = now
          item.stageHistory = pushHistory([], boot, { source: 'collect', raw: raw.stageRaw || '' })
          if (raw.read) item.readAt = raw.readAt || now
          if (raw.replied) item.repliedAt = raw.repliedAt || now
          item.direction = item.direction || lookupDirection(company, jobTitle)
          next.push(item)
          stats.created++
          continue
        }

        const cur = next[idx]
        if (!isMine(cur, req.userId)) {
          stats.ignored++
          continue
        }
        let changed = false
        const patch = { ...cur }

        if (shouldAdvance(cur.stage, stage)) {
          patch.stage = stage
          patch.stageUpdatedAt = now
          patch.stageHistory = pushHistory(cur.stageHistory, stage, {
            source: 'collect',
            raw: raw.stageRaw || '',
            at: now,
          })
          advancedList.push({ company, jobTitle, from: cur.stage || null, to: stage })
          stats.advancedCount++
          changed = true
        } else {
          stats.unchanged++
        }

        // 已读：只记第一次。重复同步不能把时间刷成「今天」
        if (raw.read && !cur.readAt) {
          patch.readAt = raw.readAt || now
          changed = true
        }
        if (raw.replied && !cur.repliedAt) {
          patch.repliedAt = raw.repliedAt || now
          changed = true
        }
        if (!cur.direction) {
          const d = lookupDirection(company, jobTitle)
          if (d) {
            patch.direction = d
            changed = true
          }
        }
        if (!cur.jobId && remote.jobId) {
          patch.jobId = remote.jobId
          changed = true
        }

        if (changed) {
          patch.updatedAt = now
          next[idx] = patch
        }
        stats.matched++
      }
      return next
    },
    []
  )

  res.json({ ok: true, ...stats, advanced: advancedList })
})

export default router
