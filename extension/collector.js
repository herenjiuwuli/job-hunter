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
 *  2. **只读当前页**：不翻页、不点按钮、不发任何请求。
 *  3. **结果可预览**：探测模式直接给「解析后」的结果，抓歪了一眼就能看出来。
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
      if (!t || t.length > 8) continue
      if (!isStageWord(t)) continue
      return { text: t, stage: STAGE_KEY[t] }
    }
  }
  return null
}

/** 结构策略：按岗位链接收集候选行 */
function candidateRows() {
  const out = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    if (!isJobLink(a)) continue
    const el = rowOfLink(a)
    if (!el || seen.has(el)) continue
    seen.add(el)
    const lines = linesOf(el)
    if (lines.length < 2) continue
    // 必须带日期或状态词，否则多半抓到了导航/页脚之类的容器
    if (!lines.some((l) => DATE_LIKE.test(l)) && !lines.some((l) => isStageWord(l))) continue
    out.push({ el, lines, jobId: jobIdFrom(el) || jobIdOfHref(a.getAttribute('href')) })
  }
  return out
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

// content.js 通过 window.__jhCollector 调用
window.__jhCollector = {
  collectFromPage,
  probePage,
  // 纯函数也导出：单测与日后排查直接调，不用再复制一份规则
  parseRowLines,
  stageOfText,
  splitCompanyCity,
  STAGE_WORDS,
}
