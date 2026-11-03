/**
 * 平台投递进度采集器（实习僧「我的投递」/ BOSS 对话列表）
 *
 * 设计取向：**结构定位 + 文本解析**，不猜 class 名。
 *
 * 平台 DOM 的类名三天两头改（`.job-card` → `.job-card-v2`），但有两样东西很稳定：
 *  1. **每条投递里恰好有一个「岗位详情」链接**（实习僧 /intern/inn_xxx、BOSS /job_detail/xxx.html）
 *     —— 用它反推「这一行的容器」，比 class 可靠得多。
 *  2. **业务文案**（初筛 / 不合格 / 投递成功）是用户看得见的产品语言，不会随便改。
 *
 * ⚠️ 2026-11-02 真机教训（实习僧投递页）：
 *   旧实现按「阶段词向上找容器」，结果第一个命中的是**顶部分类 tab**
 *   （「已投递 被查看 初筛 笔试 面试 不合适 录用」这一串），一路向上找到 `.el-tabs`，
 *   于是整个页面被当成「一行」，company 抓成岗位名、jobTitle 抓成 tab 那串字，
 *   7 个阶段全部上报同一条记录。所以现在：
 *   - 行定位改由**岗位链接**驱动，tab 只是一行里的普通文字，永远不会当锚点；
 *   - 解析层加「一行里出现 ≥3 个阶段词 = tab 标签串」的硬过滤，双保险。
 *
 * 三条纪律：
 *  1. **认不出就不猜**：结构异常 → 这条不上报，宁可漏。
 *  2. **只动「看」不动「投」**：分阶段采集会点分类 tab、点分页「下一页」——
 *     这两样只改「显示哪一页」，不改平台状态；**绝不点投递/沟通/撤回/删除**。
 *     采完会把你原本停留的 tab 切回去。
 *  3. **结果可预览**：上传前先出预览，抓歪了一眼就能看出来。
 */

/* eslint-disable no-unused-vars */

// ============================================================
// 一、纯函数区（不碰 DOM，scripts/test-collector.mjs 直接测这里）
// ============================================================

// 平台上出现过的阶段文案（含实习僧列表里的「投递成功」——它不是规范词，
// 但确实是行内状态那一格的字，漏掉它这条就会因「取不到阶段」被丢掉）
const STAGE_WORDS = [
  '已投递', '投递成功', '已送达', '待查看', '未读',
  '被查看', '已查看', '已读',
  '初筛', '筛选中', '复筛',
  '笔试', '测评', '已笔试',
  '面试', '面试中', '已面试',
  '不合格', '不合适', '未通过', '已拒绝', '淘汰',
  '录用', '已录用',
]

// 与后端 server/lib/stages.js 的权重保持一致：
// 取「行内所有阶段词里最靠后的那个」，不能让「投递成功」盖掉「初筛」
const WEIGHT = {
  已投递: 1, 投递成功: 1, 已送达: 1, 待查看: 1, 未读: 1,
  被查看: 2, 已查看: 2, 已读: 2,
  初筛: 3, 筛选中: 3, 复筛: 3,
  笔试: 4, 测评: 4, 已笔试: 4,
  面试: 5, 面试中: 5, 已面试: 5,
  不合格: 8, 不合适: 8, 未通过: 8, 已拒绝: 8, 淘汰: 8,
  录用: 9, 已录用: 9,
}

// key → 权重（与上面 WEIGHT 同源，避免两套口径）
const WEIGHT_BY_KEY = { submitted: 1, viewed: 2, screening: 3, written: 4, interview: 5, rejected: 8, offer: 9 }

const STAGE_KEY = {
  已投递: 'submitted', 投递成功: 'submitted', 已送达: 'submitted', 待查看: 'submitted', 未读: 'submitted',
  被查看: 'viewed', 已查看: 'viewed', 已读: 'viewed',
  初筛: 'screening', 筛选中: 'screening', 复筛: 'screening',
  笔试: 'written', 测评: 'written', 已笔试: 'written',
  面试: 'interview', 面试中: 'interview', 已面试: 'interview',
  不合格: 'rejected', 不合适: 'rejected', 未通过: 'rejected', 已拒绝: 'rejected', 淘汰: 'rejected',
  录用: 'offer', 已录用: 'offer',
}

// 明显不是公司/岗位的行（日期、薪资、按钮文案）
const NOISE = /^\s*(查看|立即沟通|继续沟通|投递简历|已投递简历|撤回|删除|聊天|详情|更多|展开|收起|首页|下一页|上一页|尾页)\s*$/
const DATE_LIKE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(\s+\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}[-/.]\d{1,2}|今天|昨天|\d+\s*(分钟|小时|天|周|月)前)$/
const MONEY_LIKE = /^(\d+[-~]\d+\s*元?\/?天|\d+\s*[kK]|\d+[-~]\d+\s*[kK]|\d+\s*元\/天|面议)/

// 城市兜底表（页面上没有 filters-data 时也能拆「公司-城市」）
const COMMON_CITIES = [
  '北京', '上海', '天津', '重庆', '深圳', '广州', '东莞', '佛山', '珠海', '中山', '惠州', '江门', '汕头', '湛江',
  '杭州', '宁波', '温州', '嘉兴', '金华', '绍兴', '台州', '南京', '苏州', '无锡', '常州', '南通', '徐州', '扬州',
  '成都', '绵阳', '德阳', '武汉', '宜昌', '襄阳', '长沙', '株洲', '湘潭', '西安', '咸阳', '厦门', '福州', '泉州',
  '青岛', '济南', '烟台', '潍坊', '合肥', '芜湖', '郑州', '洛阳', '石家庄', '保定', '廊坊', '大连', '沈阳',
  '长春', '哈尔滨', '南昌', '赣州', '太原', '昆明', '贵阳', '南宁', '桂林', '柳州', '海口', '三亚', '兰州',
  '呼和浩特', '包头', '乌鲁木齐', '银川', '西宁', '拉萨',
  '中国香港', '中国澳门', '中国台湾',
]

function citySet() {
  const out = new Set(COMMON_CITIES)
  try {
    const F = window.JH_FILTERS
    if (F && Array.isArray(F.PROVINCES)) {
      for (const p of F.PROVINCES) for (const c of p.cities || []) out.add(c)
    }
  } catch (_) {
    /* 没注入就是没注入，用兜底表 */
  }
  return out
}

function isStageWord(t) {
  return STAGE_WORDS.includes(t)
}

/** 一行里出现了几个阶段词 —— ≥3 基本可以断定是 tab 标签串 */
function stageWordCount(s) {
  let n = 0
  for (const w of STAGE_WORDS) if (s.includes(w)) n++
  return n
}

/**
 * 文本 → 阶段 key。
 * 短语优先：`投递成功` 里不含 `已投递`，但 `待查看` 含 `查看`，所以按权重而不是按顺序匹配。
 */
function stageOfText(t) {
  const s = String(t || '').trim()
  if (!s) return null
  let best = null
  for (const w of STAGE_WORDS) {
    if (!s.includes(w)) continue
    if (!best || WEIGHT[w] > WEIGHT[best]) best = w
  }
  return best ? STAGE_KEY[best] : null
}

/** tab 名 → 阶段。取名字里**最长**的阶段词（`已投递` 不该被更短的词抢走） */
function stageOfTabName(name) {
  const s = String(name || '').trim()
  if (!s || s.length > 16) return null
  let best = null
  for (const w of STAGE_WORDS) {
    if (!s.includes(w)) continue
    if (!best || w.length > best.length) best = w
  }
  if (!best) return null
  return { word: best, key: STAGE_KEY[best], weight: WEIGHT[best] }
}

function sameIdSet(a, b) {
  const x = Array.isArray(a) ? a : []
  const y = Array.isArray(b) ? b : []
  if (!x.length || x.length !== y.length) return false
  const s = new Set(x)
  for (const id of y) if (!s.has(id)) return false
  return true
}

/** 一段文本里出现了哪些阶段词、各几次（探测用：看某个 pane 里到底写的是什么状态） */
function stageWordStats(root) {
  const m = {}
  const txt = String((root && root.textContent) || '')
  for (const w of STAGE_WORDS) {
    let i = 0
    let n = 0
    while ((i = txt.indexOf(w, i)) !== -1) {
      n++
      i += w.length
    }
    if (n) m[w] = n
  }
  return m
}

/**
 * 基线 tab = 「已投递」那个；没有就取行数最多的。
 *
 * 为什么优先「已投递」而不是单纯「行最多」：
 *   真分组时已投递是**全集**（每条投过的都在），拿它当基线语义最对，用户看 debug 也一眼懂；
 *   镜像时 7 个 pane 行数完全一样，取谁都等价，不影响守卫。
 * 注意已投递采不到时（分页异常）自然退回「行最多」，不会返回 null。
 */
function pickBaseTab(tabs) {
  let base = null
  let submitted = null
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (!t || !Array.isArray(t.ids) || !t.ids.length) continue
    if (!base || t.ids.length > base.ids.length) base = t
    if (t.stage === 'submitted' && (!submitted || t.ids.length > submitted.ids.length)) submitted = t
  }
  return submitted || base
}

/** 该 tab 的 jobId 集合是否与基线**完全相同**（= 全量镜像，阶段不可信） */
function isMirrorOfBase(tab, base) {
  if (!tab || !base || tab === base) return false
  return sameIdSet(tab.ids, base.ids)
}

/**
 * 多来源采集结果合并：同一 jobId 只留一条，阶段取**权重最大**的那个。
 *
 * 为什么取最大而不是「最后采集到的」：
 *   tab 的遍历顺序不代表投递的推进顺序（已投递排第一，但它的行内文案可能是旧的）。
 *   权重规则与后端 lib/stages.js 的 shouldAdvance 完全一致 —— 前后端同一把尺子。
 *
 * @param {Array<{item:object, weight?:number}>} entries
 * @returns {{items: object[], duplicate: number}}
 */
function mergeEntries(entries) {
  const map = new Map()
  let duplicate = 0
  for (const e of Array.isArray(entries) ? entries : []) {
    const it = e && e.item
    if (!it) continue
    const key = it.jobId || `${it.company}|${it.jobTitle}`
    const w = e.weight != null ? e.weight : WEIGHT_BY_KEY[it.stage] || 0
    const cur = map.get(key)
    if (!cur) {
      map.set(key, { it, w })
      continue
    }
    duplicate++
    if (w > cur.w) map.set(key, { it, w })
    else if (it.read && !cur.it.read) cur.it.read = true
  }
  return { items: [...map.values()].map((v) => v.it), duplicate }
}

/** 一行里所有阶段词里最靠后的那个（返回原始文案 + key） */
function stageInLines(lines) {
  let best = null
  for (const l of lines) {
    if (l.length > 16) continue // 长句里的「面试」不是状态标签
    if (stageWordCount(l) >= 3) continue // tab 标签串
    for (const w of STAGE_WORDS) {
      if (!l.includes(w)) continue
      if (!best || WEIGHT[w] > WEIGHT[best.word]) best = { word: w, key: STAGE_KEY[w], weight: WEIGHT[w] }
    }
  }
  return best
}

/**
 * 「法雷奥-深圳」→ { company: '法雷奥', city: '深圳' }
 * 只有后半截确实是城市名才拆，否则整串当公司名（公司名里带 - 的情况真实存在）。
 */
function splitCompanyCity(s) {
  const raw = String(s || '').trim()
  if (!raw) return { company: '', city: '' }
  const m = raw.match(/^(.*?)\s*[-－—|｜·/]\s*(.{2,8})$/)
  if (!m) {
    const tail = raw.match(/^(.{2,40}?)(北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|天津|重庆)$/)
    if (tail && tail[1].trim().length >= 2) return { company: tail[1].trim(), city: tail[2] }
    return { company: raw, city: '' }
  }
  const city = m[2].trim()
  if (!citySet().has(city)) return { company: raw, city: '' }
  const company = m[1].trim()
  if (!company) return { company: raw, city: '' }
  return { company, city }
}

/** `2026-11-02 16:42:21` → ISO；解析不出来返回空串 */
function toIso(s) {
  const m = String(s || '').match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (!m) return ''
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
  return isNaN(d.getTime()) ? '' : d.toISOString()
}

/**
 * 核心：一串行文本 → 一条投递。
 *
 * @param {string[]} lines     行容器的 innerText 拆行
 * @param {object}   opts
 * @param {string}   [opts.tabStage] 当前分类 tab 的阶段 key（行内只有「投递成功」这类泛化文案时用它兜底）
 * @returns {null|{company,city,jobTitle,appliedAt,stageRaw,stage}}
 */
function parseRowLines(lines, opts = {}) {
  const list = (Array.isArray(lines) ? lines : [])
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean)

  let appliedAt = ''
  let stageWord = ''
  const keep = []

  for (const s of list) {
    if (DATE_LIKE.test(s)) {
      if (!appliedAt) appliedAt = toIso(s)
      continue
    }
    if (stageWordCount(s) >= 3) continue // tab 标签串，整行丢掉
    if (NOISE.test(s)) continue
    if (MONEY_LIKE.test(s)) continue
    if (isStageWord(s)) {
      if (!stageWord) stageWord = s
      continue
    }
    if (s.length > 60) continue
    keep.push(s)
  }

  if (keep.length < 2) return null // 缺岗位或公司：宁可漏，也不上报半条

  const jobTitle = keep[0]
  const { company, city } = splitCompanyCity(keep[1])
  if (!jobTitle || !company) return null

  // 行内阶段 vs tab 分类：取权重更大的那个。
  // 实习僧「已投递」tab 下每行都写「投递成功」，切到「初筛」tab 后行内文案往往还是旧的，
  // 这时候要以 tab 为准 —— 它是平台对这条投递的最新归类。
  const rowKey = stageInLines(list)
  const rowW = rowKey ? rowKey.weight : 0
  const tabW = opts.tabStage ? WEIGHT_BY_KEY[opts.tabStage] || 0 : 0
  let stage = null
  if (rowW && tabW) stage = rowW >= tabW ? rowKey.key : opts.tabStage
  else stage = rowKey ? rowKey.key : opts.tabStage || null

  return {
    company,
    city,
    jobTitle,
    appliedAt,
    stageRaw: rowKey ? rowKey.word : stageWord || '',
    stage,
  }
}

// ============================================================
// 二、DOM 区
// ============================================================

function detectPlatform() {
  const h = location.hostname
  if (h.includes('shixiseng')) return '实习僧'
  if (h.includes('zhipin')) return 'BOSS直聘'
  return h
}

function linesOf(el) {
  return String((el && el.innerText) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isShown(el) {
  let cur = el
  for (let i = 0; i < 8 && cur; i++) {
    const s = getComputedStyle(cur)
    if (s.display === 'none' || s.visibility === 'hidden') return false
    cur = cur.parentElement
  }
  return true
}

/** 岗位详情链接：实习僧 /intern/inn_xxx、BOSS /job_detail/xxx.html */
function isJobLink(a) {
  const h = String(a.getAttribute('href') || '')
  if (!h) return false
  return /inn_[a-z0-9]{6,}/i.test(h) || /\/job_detail\//i.test(h)
}

function jobLinksIn(root) {
  const out = []
  const all = root.querySelectorAll('a[href]')
  for (const a of all) if (isJobLink(a)) out.push(a)
  return out
}

/**
 * 由岗位链接反推「这一行的容器」：一路向上，直到**装进第二个岗位链接**为止，
 * 取最后一个「只有自己一个岗位链接」的祖先。
 *
 * 这样得到的必然是单条投递卡片，绝不会是整张列表或整个 tab 容器。
 */
function rowOfLink(a) {
  let cur = a
  let best = null
  for (let i = 0; i < 12; i++) {
    const up = cur.parentElement
    if (!up || up === document.body || up === document.documentElement) break
    if (jobLinksIn(up).length > 1) break // 越界了，上一轮的 best 才是行
    const lines = linesOf(up)
    if (lines.length > 12) break // 太大，不像一行
    best = up
    cur = up
  }
  return best
}

function jobIdOfHref(href) {
  const s = String(href || '')
  const sx = s.match(/inn_[a-z0-9]+/i)
  if (sx) return sx[0]
  const boss = s.match(/job_detail\/([a-z0-9~_-]+)\.html/i)
  if (boss) return boss[1]
  const q = s.match(/[?&]jobId=([a-z0-9~_-]+)/i)
  if (q) return q[1]
  return ''
}

function jobIdFrom(row) {
  for (const a of row.querySelectorAll('a[href]')) {
    const id = jobIdOfHref(a.getAttribute('href'))
    if (id) return id
  }
  const holder = row.querySelector('[data-jobid], [data-job-id]')
  if (holder) return holder.getAttribute('data-jobid') || holder.getAttribute('data-job-id') || ''
  return ''
}

/** 当前选中的分类 tab（实习僧「已投递/被查看/初筛…」）。拿不到返回 null */
function activeTab() {
  const sels = [
    '.el-tabs__item.is-active',
    '[role="tab"][aria-selected="true"]',
    '[class*="tab"][class*="active"]',
    '[class*="tab"][class*="current"]',
  ]
  for (const s of sels) {
    let els = []
    try {
      els = [...document.querySelectorAll(s)]
    } catch (_) {
      continue
    }
    for (const el of els) {
      if (!isShown(el)) continue
      const t = (el.innerText || '').trim()
      // tab 名可能带徽标数字（「已投递 12」），放宽到 12 个字
      if (!t || t.length > 12) continue
      if (!isStageWord(t)) continue
      return { text: t, stage: STAGE_KEY[t] }
    }
  }
  return null
}

/**
 * 页面上所有分类 tab 面板（含 display:none 的）。
 *
 * 实习僧「投递反馈」是 Element UI 的 el-tabs：7 个 `.el-tab-pane`，
 * 每个 pane 通过 `aria-labelledby` 指向它自己的 tab 头。
 * 平台把数据渲染进所有 pane（不是懒加载），所以**不用点 tab 就能读到全部**。
 */
function tabPanes() {
  const panes = [...document.querySelectorAll('.el-tab-pane, [role="tabpanel"]')]
  if (!panes.length) return []
  const heads = [...document.querySelectorAll('.el-tabs__item, [role="tab"]')]
  return panes.map((pane, i) => {
    let head = null
    const lb = pane.getAttribute('aria-labelledby')
    if (lb) head = document.getElementById(lb)
    if (!head && heads[i]) head = heads[i]
    const name = head ? String(head.innerText || '').trim() : ''
    const st = stageOfTabName(name)
    return { pane, head, name, stage: st ? st.key : null, word: st ? st.word : '', weight: st ? st.weight : 0 }
  })
}

function idsOf(rows) {
  return rows.map((r) => r.jobId).filter(Boolean)
}

/** 某个 pane 自己的「下一页」（可能不可见，但 disabled 状态可读） */
function paneNextBtn(pane) {
  for (const b of pane.querySelectorAll('button.btn-next')) {
    if (!b.disabled) return b
  }
  return null
}

async function waitPaneChange(pane, prevKeys, timeoutMs = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 350))
    const now = idsOf(rowsInRoot(pane, false)).join('|')
    if (now && now !== prevKeys) return true
  }
  return false
}

/** 页面上有没有正在转的 loading 遮罩（Element UI 的 el-loading-mask） */
function loadingNow() {
  for (const m of document.querySelectorAll('.el-loading-mask')) {
    const s = getComputedStyle(m)
    if (s.display !== 'none' && s.visibility !== 'hidden') return true
  }
  return false
}

/** 点完 tab 后，等「激活态切到目标 tab」且「loading 消失」 */
async function waitTabReady(name, timeoutMs = 5000) {
  const target = stageOfTabName(name)
  const t0 = Date.now()
  await new Promise((r) => setTimeout(r, 150))
  while (Date.now() - t0 < timeoutMs) {
    const cur = activeTab()
    const now = cur ? stageOfTabName(cur.text) : null
    if (target && now && now.key === target.key && !loadingNow()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * 结构策略：按岗位链接收集候选行。
 *
 * @param {Element} [root]        在哪个子树里找（默认整页）
 * @param {boolean} [onlyShown]   是否跳过不可见的行（默认 true）
 *
 * ⚠️ onlyShown 的来历：实习僧 7 个分类 tab 是同一份列表复制了 7 份，
 * 其他 6 份是 display:none 但 DOM 还在，querySelectorAll 照样能找到。
 * 不跳过隐藏 tab，翻页判断会把 7 份链接混在一起，永远判「列表没变」。
 * 但也正因为这份重复，**分阶段采集时反而要主动进到隐藏 pane 里读**（onlyShown: false）。
 */
function rowsInRoot(root, onlyShown = true) {
  const out = []
  const seen = new Set()
  const scope = root || document
  for (const a of jobLinksIn(scope)) {
    const el = rowOfLink(a)
    if (!el || seen.has(el)) continue
    if (onlyShown && !isShown(el)) continue
    seen.add(el)
    const lines = linesOf(el)
    if (lines.length < 2) continue
    // 必须带日期或状态词，否则多半抓到了导航/页脚之类的容器
    if (!lines.some((l) => DATE_LIKE.test(l)) && !lines.some((l) => isStageWord(l))) continue
    out.push({ el, lines, jobId: jobIdFrom(el) || jobIdOfHref(a.getAttribute('href')) })
  }
  return out
}

function candidateRows() {
  return rowsInRoot(document, true)
}

// ---- 兜底策略：没有岗位链接的页面（BOSS 对话列表）只能按阶段词反查 ----

function inTabNav(el) {
  let cur = el
  for (let i = 0; i < 6 && cur; i++) {
    const cls = String(cur.className || '')
    const role = cur.getAttribute && cur.getAttribute('role')
    if (role === 'tablist' || role === 'tab') return true
    if (/el-tabs__(header|nav|item)|tab-list|tabs__nav/i.test(cls)) return true
    cur = cur.parentElement
  }
  return false
}

function stageNodes(root) {
  const out = []
  const walker = document.createTreeWalker(root || document, NodeFilter.SHOW_TEXT, null)
  let n
  while ((n = walker.nextNode())) {
    const t = String(n.nodeValue || '').trim()
    if (!t || !isStageWord(t)) continue
    const el = n.parentElement
    if (!el) continue
    if (String(el.textContent || '').trim() !== t) continue
    if (inTabNav(el)) continue // ⚠️ 顶部 tab 的「初筛」不是某一行的状态
    out.push({ el, text: t })
  }
  return out
}

function rowOfStageNode(el, maxUp = 8) {
  let cur = el
  for (let i = 0; i < maxUp; i++) {
    cur = cur.parentElement
    if (!cur || cur === document.body) break
    if (jobLinksIn(cur).length > 1) break
    const lines = linesOf(cur)
    if (lines.length > 12) break
    if (lines.length >= 2) return cur
  }
  return null
}

// ============================================================
// 三、对外接口
// ============================================================

function collectFromPage() {
  const platform = detectPlatform()
  const tab = activeTab()
  const tabStage = tab ? tab.stage : null

  const items = []
  const seenKey = new Set()
  const debug = {
    url: location.href,
    platform,
    tab: tab ? tab.text : '',
    rows: 0,
    parsed: 0,
    noName: 0,
    duplicate: 0,
    via: 'link',
    samples: [],
  }

  const push = (raw, jobId, source) => {
    const key = jobId || `${raw.company}|${raw.jobTitle}`
    if (seenKey.has(key)) {
      debug.duplicate++
      return
    }
    seenKey.add(key)
    const item = {
      platform,
      company: raw.company,
      jobTitle: raw.jobTitle,
      jobId: jobId || '',
      appliedAt: raw.appliedAt || '',
    }
    if (raw.city) item.city = raw.city
    if (raw.stageRaw) item.stageRaw = raw.stageRaw
    if (raw.stage) item.stage = raw.stage
    // BOSS：已读/未读是「读没读」，不是流程阶段 —— 分开报，免得把 submitted 覆盖掉
    if (raw.stageRaw === '已读') {
      item.read = true
      delete item.stageRaw
      delete item.stage
    }
    if (raw.stageRaw === '未读') {
      delete item.stageRaw
      delete item.stage
    }
    items.push(item)
    debug.parsed++
    if (debug.samples.length < 5) debug.samples.push({ source, lines: raw.__lines || [], item })
  }

  // 策略 A：结构（实习僧投递列表走这条）
  const rows = candidateRows()
  debug.rows = rows.length
  for (const r of rows) {
    const parsed = parseRowLines(r.lines, { tabStage })
    if (!parsed) {
      debug.noName++
      if (debug.samples.length < 5) debug.samples.push({ source: 'link', lines: r.lines, skipped: '取不到岗位/公司' })
      continue
    }
    parsed.__lines = r.lines
    push(parsed, r.jobId, 'link')
  }

  // 策略 B：文本兜底（没有岗位链接的页面，如 BOSS 对话列表）
  if (!rows.length) {
    debug.via = 'text'
    for (const hit of stageNodes()) {
      const row = rowOfStageNode(hit.el)
      debug.rows++
      if (!row) {
        debug.noName++
        continue
      }
      const lines = linesOf(row)
      const parsed = parseRowLines(lines, { tabStage })
      if (!parsed) {
        debug.noName++
        if (debug.samples.length < 5) debug.samples.push({ source: 'text', stage: hit.text, lines, skipped: '取不到岗位/公司' })
        continue
      }
      // 兜底路径下 hit.text 就是这一行的状态，比行内扫描更可信
      parsed.stageRaw = hit.text
      parsed.stage = STAGE_KEY[hit.text] || parsed.stage
      parsed.__lines = lines
      push(parsed, jobIdFrom(row), 'text')
    }
  }

  return { items, debug }
}

/**
 * 探测模式：**输出解析后的结果**，不是原始文本。
 * 校准的时候最想知道的是「岗位/公司抓对了吗、阶段判对了吗」，
 * 把原文和解析结果并排放出来，一眼就能看出是哪一步错的。
 */
function probePage() {
  const tab = activeTab()
  const tabStage = tab ? tab.stage : null
  const rows = candidateRows().slice(0, 12)

  const out = rows.map((r) => {
    const parsed = parseRowLines(r.lines, { tabStage })
    return {
      tag: r.el.tagName + (r.el.className ? '.' + String(r.el.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''),
      jobId: r.jobId,
      lines: r.lines,
      parsed: parsed
        ? {
            company: parsed.company,
            city: parsed.city || '',
            jobTitle: parsed.jobTitle,
            appliedAt: parsed.appliedAt,
            stage: parsed.stage,
            stageRaw: parsed.stageRaw,
          }
        : null,
    }
  })

  const resp = {
    url: location.href,
    platform: detectPlatform(),
    activeTab: tab ? { text: tab.text, stage: tab.stage } : null,
    mode: 'link',
    count: out.length,
    rows: out,
  }

  // 每个分类 tab 里有多少个岗位链接 —— 这是判断「7 个 pane 是同一份全量镜像，还是按阶段真分组」
  // 最直接的证据：链接数不依赖 innerText，隐藏 pane 里也数得准。
  const tabs = tabPanes()
  if (tabs.length) {
    const probed = tabs.map((t) => {
      const ids = [...new Set(jobLinksIn(t.pane).map((a) => jobIdOfHref(a.getAttribute('href'))).filter(Boolean))]
      return {
        name: t.name,
        stage: t.stage,
        links: jobLinksIn(t.pane).length,
        ids,
        // pane 里出现过的阶段词及次数（读 textContent，隐藏 pane 也读得到）。
        // 「被查看」pane 里若统计出 10 次「投递成功」且 0 次「被查看」，镜像基本坐实。
        words: stageWordStats(t.pane),
        shown: isShown(t.pane),
      }
    })
    let base = null
    for (const p of probed) if (!base || p.ids.length > base.ids.length) base = p
    const mirrors = base ? probed.filter((p) => p !== base && sameIdSet(p.ids, base.ids)) : []
    resp.tabs = probed.map((p) => ({
      name: p.name,
      stage: p.stage,
      links: p.links,
      words: p.words,
      shown: p.shown,
      sameAsBase: base ? p === base || sameIdSet(p.ids, base.ids) : false,
    }))
    resp.mirror = {
      base: base ? base.name : '',
      baseLinks: base ? base.links : 0,
      mirroredTabs: mirrors.length,
      // ⚠️ 这是**未点击**的静态快照：隐藏 pane 的 DOM 也许只是初始渲染，
      // 点击后才真正请求过滤数据。结论仅供预判，最终以采集时点开每个 tab 后的集合为准。
      verdict:
        mirrors.length >= probed.length - 2
          ? '大概率全量镜像（7 个 pane 挂的是同一份列表）→ 阶段只信行内文案'
          : '各 pane 列表不同，可能是真分组 → 阶段可用 tab 名',
      note: '未点击的静态快照，仅供参考；采集时会点开每个 tab 用真实集合复核',
    }
  }

  // 结构策略一条都没命中 → 附上文本兜底看到了什么，方便判断是「页面没投递」还是「链接抓不到」
  if (!rows.length) {
    const hits = stageNodes()
    resp.mode = 'text'
    resp.fallback = {
      stageHits: hits.length,
      sample: hits.slice(0, 6).map((h) => {
        const row = rowOfStageNode(h.el)
        return {
          stage: h.text,
          tag: row ? row.tagName : '',
          lines: row ? linesOf(row) : [],
        }
      }),
    }
  }

  return resp
}

// ============================================================
// 四、自动翻页采集（实习僧「我的投递」列表，标准 el-pagination 分页）
// ============================================================

/**
 * 当前可见的分类面板。拿不到返回 null。
 *
 * 为什么需要它：7 个 pane 各自带一套 el-pagination，`document.querySelectorAll('.btn-prev')`
 * 会把隐藏 pane 的按钮也找出来。隐藏 pane 若用 height:0 / overflow:hidden 隐藏（而不是 display:none），
 * `isShown` 判不出来 → 点到别的 pane 的分页 → 当前列表一动不动 → 翻页判断失败 → 整个 tab 被跳过。
 * 真机事故：2026-11-03「已投递」11 条一条没采到，就是这么来的。
 *
 * Element UI 里 pane 的 aria-labelledby 指向它自己的 tab 头 id，反查最准。
 */
function activePane() {
  for (const h of document.querySelectorAll('.el-tabs__item.is-active, [role="tab"][aria-selected="true"]')) {
    const id = h.id
    if (!id) continue
    let p = null
    try {
      p = document.querySelector(`[aria-labelledby="${id}"]`)
    } catch (_) {
      p = null
    }
    if (p) return p
  }
  // 兜底：可见的 pane，优先有岗位链接的那个
  let fallback = null
  for (const p of document.querySelectorAll('.el-tab-pane, [role="tabpanel"]')) {
    if (!isShown(p)) continue
    if (!fallback) fallback = p
    if (jobLinksIn(p).length) return p
  }
  return fallback
}

/**
 * 分页按钮该在哪个子树里找。
 * 只有页面上真有多档分类 tab 时才收窄到当前 pane；单视图（BOSS）仍是整页找。
 */
function pagerScope() {
  if (tabPanes().length >= 2) {
    const p = activePane()
    if (p) return p
  }
  return document
}

/** 找「下一页」按钮。标准 Element UI 分页是 <button class="btn-next">。 */
function nextBtn() {
  const scope = pagerScope()
  const cands = [
    ...scope.querySelectorAll('button.btn-next'),
    ...scope.querySelectorAll('.el-pagination .btn-next'),
  ]
  for (const b of cands) {
    if (b.disabled) continue
    if (!isShown(b)) continue
    return b
  }
  return null
}

/** 找「上一页」按钮。标准 Element UI 分页是 <button class="btn-prev">。 */
function prevBtn() {
  const scope = pagerScope()
  const cands = [
    ...scope.querySelectorAll('button.btn-prev'),
    ...scope.querySelectorAll('.el-pagination .btn-prev'),
  ]
  for (const b of cands) {
    if (b.disabled) continue
    if (!isShown(b)) continue
    return b
  }
  return null
}

/**
 * 回到第 1 页。
 *
 * ⚠️ 为什么每次切 tab 都要做：Element UI 的分页组件若被平台复用同一个实例，
 * 切 tab **不会**把页码重置回 1。用户上次手动翻到第 3 页，采集就从第 3 页开始，
 * 前两页静默漏掉 —— 不报错，只表现为「怎么只有这么几条」，最难查的一类 bug。
 */
async function gotoFirstPage(maxSteps = 12) {
  for (let i = 0; i < maxSteps; i++) {
    const b = prevBtn()
    if (!b) return true
    const prev = idsOf(candidateRows()).join('|')
    b.click()
    // 超时给短一点：翻页确认本来就快，硬等 8 秒 x 多步会把整个采集拖成几分钟
    if (!(await waitForListChange(prev, 3000))) return false
  }
  return false
}

/** 轮询等待：列表刷新（行集合变化）或超时。返回「是否还在刷新」。 */
async function waitForListChange(prevKeys, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 400))
    const now = candidateRows().map((r) => r.jobId).filter(Boolean).join('|')
    if (now && now !== prevKeys) return true
  }
  return false
}

/**
 * 自动翻页采集：采当前页 → 点「下一页」→ 等刷新 → 再采，直到没有下一页。
 *
 * 为什么默认只翻当前 tab：实习僧 7 个分类 tab 的列表是同一份数据复制（见真机 HTML），
 * 目前所有投递都停在「已投递」，翻当前 tab 就采全了；真需要跨 tab 遍历再加。
 *
 * @param {object} opts
 * @param {number} [opts.maxPages=30] 翻页上限，防死循环（页数异常时止损）
 * @returns {{items, debug}}
 */
async function collectAllPages(opts = {}) {
  const maxPages = opts.maxPages || 30
  const all = []
  const seen = new Set()
  const debug = {
    url: location.href,
    platform: detectPlatform(),
    pages: 0,
    rows: 0,
    parsed: 0,
    duplicate: 0,
    noName: 0,
    stopped: '',
  }

  for (let page = 1; page <= maxPages; page++) {
    const res = collectFromPage()
    debug.pages = page
    debug.rows += res.debug.rows
    debug.noName += res.debug.noName

    for (const it of res.items) {
      const key = it.jobId || `${it.company}|${it.jobTitle}`
      if (seen.has(key)) {
        debug.duplicate++
        continue
      }
      seen.add(key)
      all.push(it)
      debug.parsed++
    }

    const btn = nextBtn()
    if (!btn) {
      debug.stopped = `第 ${page} 页后无「下一页」（已到底或分页组件不认识）`
      break
    }

    // 记录当前页 jobId 集合，用来判断翻页后列表有没有真的变
    const prevKeys = candidateRows().map((r) => r.jobId).filter(Boolean).join('|')
    btn.click()
    const changed = await waitForListChange(prevKeys)
    if (!changed) {
      debug.stopped = `第 ${page} 页点「下一页」后列表没变化，停止（可能已到底或加载慢）`
      break
    }
  }

  debug.items = all
  return { items: all, debug }
}

// ============================================================
// 五、分阶段采集（实习僧七档：已投递 / 被查看 / 初筛 / 笔试 / 面试 / 不合格 / 录用）
// ============================================================

/** 解析结果 → 上报 item（字段规则与 collectFromPage 保持一致） */
function itemOf(parsed, jobId, platform) {
  const it = {
    platform,
    company: parsed.company,
    jobTitle: parsed.jobTitle,
    jobId: jobId || '',
    appliedAt: parsed.appliedAt || '',
  }
  if (parsed.city) it.city = parsed.city
  if (parsed.stageRaw) it.stageRaw = parsed.stageRaw
  if (parsed.stage) it.stage = parsed.stage
  // BOSS：已读/未读是「读没读」，不是流程阶段 —— 分开报，免得把 submitted 覆盖掉
  if (parsed.stageRaw === '已读') {
    it.read = true
    delete it.stageRaw
    delete it.stage
  }
  if (parsed.stageRaw === '未读') {
    delete it.stageRaw
    delete it.stage
  }
  return it
}

/**
 * 采全部阶段，分两趟：
 *   阶段 A（快检）逐个点开分类 tab，**只读第 1 页**，拿到每个 tab 的 jobId 集合；
 *   阶段 B（翻页）只给「基线 tab」和「真分组的 tab」翻到底，最后按 jobId 合并取权重最大的阶段。
 *
 * 为什么要拆两趟：7 个 tab 若渲染的是同一份全量列表（本平台真机即如此），
 * 逐 tab 翻页等于把同一份数据读 7 遍 —— 7 × N 页 × 最多 8 秒等刷新，白等一分钟还容易卡在某个 tab。
 * 快检一遍就知道是不是镜像，镜像时只翻基线那个 tab。
 *
 * 为什么不直接在隐藏 pane 里读（那本是零副作用的最优解）：
 *   `innerText` 对不可渲染的元素会退化成 `textContent` —— 卡片里各字段之间**没有换行**，
 *   整条投递会糊成一行，`lines.length < 2` 直接被丢。真机上验证过这个行为，
 *   所以只能点 tab 让列表真正可见，innerText 才给得出分行文本。
 *
 * ⚠️ 镜像守卫（这是本函数的核心判断，别删）：
 *   平台上 7 个 pane 渲染的是**同一份全量列表**（每条都写「投递成功」）。
 *   如果无条件拿 tab 名当阶段，就会把所有投递都标成「录用」之类的高阶段。
 *   所以：与「基线 tab（行最多那个）」jobId 集合**完全相同**的 tab 判为镜像，
 *   **它的 tab 名不参与阶段判定，只信行内文案**。等某条投递真进了「初筛」，
 *   该 tab 的集合就不再等于基线，守卫自动失效，tab 名开始生效。
 */
async function collectAllTabs(opts = {}) {
  const maxPages = opts.maxPages || 15
  const platform = detectPlatform()
  const debug = {
    url: location.href,
    platform,
    mode: 'tabs',
    pages: 0,
    rows: 0,
    parsed: 0,
    duplicate: 0,
    noName: 0,
    tabs: [],
    notes: [],
  }

  const tabs = tabPanes().filter((t) => t.head && t.stage)
  if (tabs.length < 2) {
    // 不是「七档 tab」页面（BOSS 对话列表 / 平台改版）→ 退回单视图翻页
    const res = await collectAllPages({ maxPages })
    return {
      items: res.items,
      debug: { ...debug, ...res.debug, mode: 'single', notes: ['未识别到分类 tab，按单视图翻页采集'] },
    }
  }

  const initial = activeTab()
  const initialKey = initial ? initial.stage : null

  /** 切到指定 tab；已经是 active 就不动。返回是否确实切过去了 */
  async function switchToTab(t) {
    if (t.head.classList.contains('is-active')) return true
    t.head.click()
    const ok = await waitTabReady(t.name)
    // 切换瞬间旧 pane 可能还没完成 display 切换，给一帧缓冲再读
    if (ok) await new Promise((r) => setTimeout(r, 250))
    return ok
  }

  // ---- 阶段 A：逐个点开 tab，**只读第 1 页**，拿 jobId 集合 ----
  // 这一步故意不翻页：7 个 tab 若是同一份全量镜像，逐个翻页就是把同一份数据读 7 遍
  // （7 × N 页 × 最多 8 秒等刷新），白等一分钟，还容易在某个 tab 上卡住。
  debug.phase = 'probe'
  const buckets = []
  for (const t of tabs) {
    const tb = { name: t.name, stage: t.stage, pages: 0, rows: 0, ids: [], note: '', mirrored: false, paged: false }
    debug.tabs.push(tb)

    const isCur = initialKey && initialKey === t.stage && t.head.classList.contains('is-active')
    if (!isCur) {
      const ok = await switchToTab(t)
      if (!ok) {
        // ⚠️ 切换没确认成功时**必须跳过**：此时页面上还是上一个 tab 的列表，
        // 直接采会把那些投递错标成本阶段的记录 —— 错的阶段比漏采一条严重得多。
        tb.note = '切换 tab 失败，跳过（避免把上个 tab 的数据错标成本阶段）'
        continue
      }
    }

    // 分页可能停在用户上次翻到的页码 —— 不回到第 1 页就会静默漏掉前面的记录。
    // ⚠️ 失败也**照样采**：漏一页好过漏掉整个 tab（真机事故里「已投递」11 条就是这么全丢的）。
    if (!(await gotoFirstPage())) {
      tb.note = (tb.note ? tb.note + '；' : '') + '回不到第 1 页，可能漏前面几页'
    }

    const rows = candidateRows()
    tb.pages = rows.length ? 1 : 0
    tb.rows = rows.length
    tb.ids = [...new Set(idsOf(rows))]
    if (!rows.length) tb.note = '该阶段暂无投递'
    buckets.push({ tab: t, rows, tb })
  }

  // ---- 镜像判定：与「基线 tab（行最多那个）」jobId 集合完全相同的，阶段不可信 ----
  const nonEmpty = buckets.filter((b) => b.rows.length)
  if (!nonEmpty.length) {
    debug.notes.push('七个分类 tab 都是空的')
    debug.phase = 'done'
    return { items: [], debug }
  }
  const baseTb = pickBaseTab(nonEmpty.map((b) => b.tb))
  for (const b of nonEmpty) {
    b.tb.mirrored = isMirrorOfBase(b.tb, baseTb)
    if (b.tb.mirrored) {
      b.tb.note = (b.tb.note ? b.tb.note + '；' : '') + '列表与基线完全相同 → 全量镜像，只信行内文案，不重复翻页'
    }
  }
  debug.baseTab = baseTb ? baseTb.name : ''
  debug.mirrored = nonEmpty.filter((b) => b.tb.mirrored).length
  debug.grouped = nonEmpty.length - debug.mirrored > 1

  // ---- 阶段 B：只给「基线 tab」和「真分组的 tab」翻页 ----
  // 镜像 tab 第 1 页的行内文案与基线逐条相同（同一份数据），翻页拿不到任何增量。
  debug.phase = 'paging'
  for (const b of nonEmpty) {
    if (b.tb !== baseTb && b.tb.mirrored) continue

    if (!(await switchToTab(b.tab))) {
      b.tb.note = (b.tb.note ? b.tb.note + '；' : '') + '翻页前切回该 tab 失败，只保留第 1 页'
      continue
    }
    if (!(await gotoFirstPage())) {
      b.tb.note = (b.tb.note ? b.tb.note + '；' : '') + '回不到第 1 页，只保留第 1 页已读到的'
      continue
    }

    let rows = candidateRows()
    const allRows = [...rows]
    b.tb.paged = true
    for (let p = 1; p <= maxPages; p++) {
      const btn = nextBtn()
      if (!btn) break
      const prev = idsOf(rows).join('|')
      btn.click()
      if (!(await waitForListChange(prev))) {
        b.tb.note = (b.tb.note ? b.tb.note + '；' : '') + `第 ${p} 页后翻不动`
        break
      }
      b.tb.pages = p + 1
      rows = candidateRows()
      allRows.push(...rows)
    }
    b.tb.rows = allRows.length
    b.tb.ids = [...new Set(idsOf(allRows))]
    b.rows = allRows
  }

  // 还原用户原本停留的 tab（不擅自改页面状态）
  if (initialKey) {
    const back = tabs.find((t) => t.stage === initialKey)
    if (back && !back.head.classList.contains('is-active')) {
      back.head.click()
      await waitTabReady(back.name)
    }
  }

  // ---- 解析 + 按 jobId 合并（取权重最大的阶段）----
  const entries = []
  for (const b of nonEmpty) {
    const tabStage = b.tb.mirrored ? null : b.tab.stage
    for (const r of b.rows) {
      const parsed = parseRowLines(r.lines, { tabStage })
      if (!parsed) {
        debug.noName++
        continue
      }
      const it = itemOf(parsed, r.jobId, platform)
      if (b.tb.name) it.fromTab = b.tb.name
      entries.push({ item: it })
    }
  }
  const merged = mergeEntries(entries)
  debug.duplicate = merged.duplicate
  debug.parsed = merged.items.length
  debug.pages = debug.tabs.reduce((s, t) => s + (t.pages || 0), 0)
  debug.rows = debug.tabs.reduce((s, t) => s + (t.rows || 0), 0)
  debug.phase = 'done'
  return { items: merged.items, debug }
}

// content.js 通过 window.__jhCollector 调用
window.__jhCollector = {
  collectFromPage,
  collectAllPages,
  collectAllTabs,
  probePage,
  // 纯函数也导出：单测与日后排查直接调，不用再复制一份规则
  parseRowLines,
  stageOfText,
  stageOfTabName,
  mergeEntries,
  pickBaseTab,
  isMirrorOfBase,
  sameIdSet,
  stageWordStats,
  splitCompanyCity,
  STAGE_WORDS,
}
