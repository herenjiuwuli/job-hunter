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
    // ⭐ 我主动放弃 ≠ 被拒。塞进 stage=rejected 会把「被拒率」算高：
    //   HR 没拒我，是我不去了。所以单开一个字段，且**永不参与 stage 权重**。
    withdrawnAt: input.withdrawnAt || prev.withdrawnAt || '',
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
 * 库里这条的标题是不是「压根不是岗位名」——纯届别 / 批次 / 急招这类标签。
 *
 * 来源是真机事故：实习僧岗位名元素里是「27届\n测试实习生」，采集端取了第一行，
 * 3 条不同岗位的标题全成了「27届」。采集端已修（collector 的 PURE_TAG_LINE），
 * 但**已经写坏的标题不会自己好** —— 错一次就永久错，除非允许覆盖。
 */
const PURE_TAG_TITLE = /^(?:\d{2,4}\s*届(?:\s*(?:校招|春招|秋招|提前批))?|应届(?:生)?|在校生?|实习生?|校招|社招|急招|热招|新职位|今日|置顶)$/

function looksLikeTagTitle(s) {
  return PURE_TAG_TITLE.test(String(s || '').trim())
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
 * 只按岗位名认人 —— `sameApply` 的兜底，**只有名字在全库唯一时才认**。
 *
 * 为什么需要：BOSS 聊天页拿不到 jobId（「查看职位」是 button，`li` 上没有 data-*），
 * 后端只能「公司 + 岗位名」匹配。而账本里那一批一键投递的记录，公司名是靠选择器
 * 从页面上抓的 —— 跑在「左列表 + 右详情」页时会抓到**别人**的公司（2026-11-05
 * A69277 事故，10 条里 4 条错）。公司这一半一旦错，就永远匹配不上，
 * 已读 / 被拒的时间一条也传不进面板，界面看起来就「全都还是已投递」。
 *
 * 为什么必须唯一：BOSS 上「测试实习生」这种标题一堆，两条同名时按标题认人
 * 就是把 A 的进度写到 B 头上。这时宁可 ignored 让界面说出来，也不能猜。
 */
function matchByTitleOnly(list, remote, userId) {
  const t = normTitle(remote.jobTitle)
  if (!t) return -1
  const hits = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    if (!isMine(a, userId)) continue
    const lp = String(a.platform || '')
    const rp = String(remote.platform || '')
    if (lp && rp && lp !== rp) continue
    if (normTitle(a.jobTitle) === t) hits.push(i)
  }
  return hits.length === 1 ? hits[0] : -1
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
  /**
   * 每条上报的处置明细。
   *
   * 为什么必须返回：扩展端靠「jobId + 阶段」缓存判断「这条同步过了，下次别再报」。
   * 只看 HTTP 200 就记账会把 ignored 的也记成已同步 —— 那条以后永远不再上报，静默丢数据。
   * 2026-11-03 真机事故：法雷奥「测试实习生」被 ignored（本地账本没有这条投递），
   * 却被记成已同步，「初筛」状态从此再也传不上来。
   */
  const results = []
  const note = (raw, action, extra) => {
    results.push({
      jobId: String(raw.jobId || '').trim(),
      company: String(raw.company || '').trim(),
      jobTitle: String(raw.jobTitle || '').trim(),
      action,
      ...(extra || {}),
    })
  }

  await updateJSON(
    KEY,
    (list) => {
      const next = [...list]
      for (const raw of items) {
        const company = String(raw.company || '').trim()
        const jobTitle = String(raw.jobTitle || '').trim()
        if (!company && !jobTitle) {
          stats.ignored++
          note(raw, 'ignored', { reason: '缺公司和岗位，当噪声行丢弃' })
          continue
        }
        const remote = {
          platform: String(raw.platform || '').trim(),
          jobId: String(raw.jobId || '').trim(),
          company,
          jobTitle,
          // 扩展按标题判好的方向（投递那一刻算的，比后端查语料准）。
          // 空字符串是常态：标题里本来就没有方向词，这时才轮到 lookupDirection 兜底。
          direction: String(raw.direction || '').trim(),
        }
        // ⚠️ 用 || 不用 ??：采集端「只靠分类 tab 判定阶段」的行，stageRaw 是空串
        // （行内没有阶段词），而 stage 是有效的 key。?? 只挡 null/undefined，
        // 空串会原样传下去 → parseStage('') → null → 这一档永远推不上去。
        const stage = parseStage(raw.stageRaw || raw.stage)
        let idx = next.findIndex((a) => isMine(a, req.userId) && sameApply(a, remote))
        // 公司名对不上时再按标题试一次。**只对聊天页来的条目**：只有它有「公司名是现场读的、
        // 而账本里那条公司名错」这个已知事故，别的来源公司名对不上就是真的另一家。
        let viaTitle = false
        if (idx === -1 && raw.source === 'chat' && !remote.jobId) {
          idx = matchByTitleOnly(next, remote, req.userId)
          if (idx !== -1) viaTitle = true
        }

        if (idx === -1) {
          // HR 主动找上门、我一句话没发过的会话不是我的投递，建了会把「投递量」撑大
          if (raw.source === 'chat' && Number(raw.myMsgCount) === 0) {
            stats.ignored++
            note(raw, 'ignored', { reason: '我没发过消息（HR 主动找我），不算我的投递' })
            continue
          }
          if (!createMissing) {
            stats.ignored++
            note(raw, 'ignored', { reason: '账本里没有这条投递（未开启 createMissing，不自动新建）' })
            continue
          }
          if (!company || !jobTitle) {
            stats.ignored++ // 新建必须有公司+岗位，否则是噪声行
            note(raw, 'ignored', { reason: '新建必须有公司和岗位' })
            continue
          }
          const item = sanitize({
            company,
            jobTitle,
            platform: remote.platform,
            jobId: remote.jobId,
            // 扩展判好的方向优先；它判不出来（标题没有方向词）才轮到后端语料
            direction: remote.direction,
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
          if (raw.withdrawn) item.withdrawnAt = raw.withdrawnAt || now
          item.direction = item.direction || lookupDirection(company, jobTitle)
          next.push(item)
          stats.created++
          note(raw, 'created', { stage: boot })
          continue
        }

        const cur = next[idx]
        if (!isMine(cur, req.userId)) {
          stats.ignored++
          note(raw, 'ignored', { reason: '不属于当前账号' })
          continue
        }
        let changed = false
        const patch = { ...cur }

        // 按标题兜底命中的，顺手把错的公司名订正过来。
        // companyGuess 的不订正 —— 那是拆「姓名+公司」猜出来的，拿来覆盖真实值不划算。
        //
        // ⭐ 2026-11-06 补：**精确命中（jobId）也要订正，但只在库里没有公司名时**。
        // 之前这条只走 viaTitle，「未知公司」这种采集失败留下的空位就永远填不上：
        // 中金财富那 2 条 jobId 一直在库里、采集每次都能拿到「中金财富（深圳）」，
        // 却因为走的是精确匹配、viaTitle=false，公司名一直是「未知公司」。
        // 反过来（库里是真实名、本次是猜的）不覆盖 —— 那种仍归 viaTitle 管。
        let companyFixed = null
        let titleFixed = null
        const curCompanyRaw = String(cur.company || '').trim()
        const curCompanyMissing = !curCompanyRaw || /^未知/.test(curCompanyRaw)
        const nameShouldFix =
          !!company && !raw.companyGuess && !sameCompany(cur.company, company) && (viaTitle || curCompanyMissing)
        if (nameShouldFix) {
          patch.company = company
          companyFixed = { from: cur.company, to: company }
          changed = true
        }

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
          note(raw, 'advanced', {
            from: cur.stage || null,
            to: stage,
            ...(companyFixed ? { companyFixed } : {}),
          })
          changed = true
        } else {
          stats.unchanged++
          note(raw, 'unchanged', {
            stage: stage,
            current: cur.stage || null,
            ...(companyFixed ? { companyFixed } : {}),
          })
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
        // 「我放弃」单开时间字段，**不动 stage**：HR 没拒我，是我自己不去了。
        // 把它算进 rejected 会把被拒率算高，漏斗上「不合格」那层凭空多一批。
        if (raw.withdrawn && !cur.withdrawnAt) {
          patch.withdrawnAt = raw.withdrawnAt || now
          changed = true
        }
        if (!cur.direction) {
          // 先信扩展报的（投递那一刻按标题判的），没有再查语料
          const d = remote.direction || lookupDirection(company, jobTitle)
          if (d) {
            patch.direction = d
            changed = true
          }
        }
        if (!cur.jobId && remote.jobId) {
          patch.jobId = remote.jobId
          changed = true
        }

        // 标题自愈：jobId 是同一个岗位的硬证据，此时把「标签当标题」的旧值换掉。
        // 只在旧值确实是标签（如「27届」）时才改 —— 否则平台改文案就会来回覆盖，
        // 而标题是 sameApply 认人的主要依据，被乱改等于自己给自己制造错配。
        if (
          remote.jobId &&
          cur.jobId === remote.jobId &&
          remote.jobTitle &&
          remote.jobTitle !== cur.jobTitle &&
          looksLikeTagTitle(cur.jobTitle) &&
          !looksLikeTagTitle(remote.jobTitle)
        ) {
          patch.jobTitle = remote.jobTitle
          changed = true
          titleFixed = { from: cur.jobTitle, to: remote.jobTitle }
          // 单独一条 note：放在阶段 note 之后，两个都能出现（阶段推进 + 标题自愈是两件事）
          note(raw, 'titleFixed', { titleFixed })
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

  res.json({ ok: true, ...stats, advanced: advancedList, results })
})

export default router
