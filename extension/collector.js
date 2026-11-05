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

/**
 * 翻页自检（纯函数，可单测）。
 *
 * 翻页最大的坑不是「翻不动」，而是**看着翻了、其实没翻**（站点忽略 page 参数），
 * 或者翻了但后面几页全是重复岗位 —— 两种都表现为「原地投一批重复简历」，
 * 而且没有任何报错。所以每到新一页，抓完先跑这三条：
 *   ① 一个可投岗位都没有 → 到底了，或被筛选条件全拦；
 *   ② 和上一页的 id 集合完全一样 → 翻页没生效；
 *   ③ 全部是已经见过的 id → 后面都是重复岗位。
 *
 * 判据只用「jobId 集合」，不碰分页组件的 class —— 站点改版也不会失效。
 *
 * @returns {{ok:boolean, reason:'empty'|'same-as-prev'|'all-seen'|'', fresh:string[]}}
 */
function checkPageFresh(ids, lastPageIds, seenIds) {
  const cur = (Array.isArray(ids) ? ids : []).filter(Boolean)
  if (!cur.length) return { ok: false, reason: 'empty', fresh: [] }
  const prev = (Array.isArray(lastPageIds) ? lastPageIds : []).filter(Boolean)
  if (prev.length && sameIdSet(cur, prev)) return { ok: false, reason: 'same-as-prev', fresh: [] }
  const seen = new Set((Array.isArray(seenIds) ? seenIds : []).filter(Boolean))
  const fresh = cur.filter((id) => !seen.has(id))
  if (!fresh.length) return { ok: false, reason: 'all-seen', fresh: [] }
  return { ok: true, reason: '', fresh }
}

/**
 * 关键词轮换：当前这个词用完了，下一个该用第几个？
 *
 * 抽成纯函数是因为它只有「数组边界」这一件事，而边界恰恰是最容易写错、
 * 又最难在真机上发现的地方 —— 写错就两种结果：最后一个词跑两遍、或者少跑一个词，
 * 两者都不会报错，只会让投递量莫名其妙地少/多一批。
 *
 * @param {number} total 一共几个词
 * @param {number} cur 当前是第几个（0 起）
 * @returns {number} 下一个的序号；-1 = 没有了
 */
function nextKeywordIndex(total, cur) {
  const n = Math.max(0, Number(total) || 0)
  const i = Math.max(0, Number(cur) || 0)
  if (n < 2) return -1
  const next = i + 1
  return next < n ? next : -1
}

/**
 * 一页岗位全都不能投时，把**每一类原因和数量**都说出来。
 *
 * 为什么不能只报一个原因：
 *   2026-11-05 真机报了「本页 15 家本地记录里都投过了，没有新岗位可投」，
 *   可那一页同时还有「全国」待定岗位和不符合筛选的岗位 —— 一句「都投过了」
 *   把另外两类全盖住，用户只能猜「是不是插件坏了 / 这页真的到底了」。
 *   页面上的岗位是**几类原因叠加**的，话就得把几类都说全。
 *
 * @param {{total:number, appliedSkip:number, blockedCount:number, pendingCount:number, blockedFirst:string, page?:number}} s
 *        page = 当前是第几页（翻页接力时传）。第 2 页起「一家都没抓到」只有一个含义：
 *        **这个搜索条件就这么多页**，和后缀「新建一批要在列表页启动」毫无关系。
 * @returns {string} 人话，例如「本页 20 家：15 家本地已投过、2 家写「全国」待定、3 家不符合筛选（例如：城市不符…）」
 */
function emptyPageReason(s) {
  const n = (v) => Math.max(0, Number(v) || 0)
  const total = n(s && s.total)
  const applied = n(s && s.appliedSkip)
  const blocked = n(s && s.blockedCount)
  const pending = n(s && s.pendingCount)
  const first = String((s && s.blockedFirst) || '').trim()
  const page = n(s && s.page)

  if (!total) {
    // 翻到第 2 页往后是空页 —— 这就是「到底了」，不是「不在列表页」。
    // 原来两种情形共用一句「当前页面没抓到岗位链接（新建一批要在搜索结果列表页启动）」，
    // 用户在列表页上翻页时看到这句会以为插件认错了页面（2026-11-05 真机：SDET 只有 1 页）
    if (page > 1) return `第 ${page} 页没有岗位了（这个搜索条件只有 ${page - 1} 页，已经到底）`
    return '当前页面没抓到岗位链接（新建一批要在搜索结果列表页启动）'
  }

  const parts = []
  if (applied) parts.push(`${applied} 家本地已投过`)
  if (pending) parts.push(`${pending} 家写「全国」待定（没自动投）`)
  if (blocked) parts.push(`${blocked} 家不符合筛选${first ? `（例如：${first}）` : ''}`)
  if (!parts.length) parts.push('都没能进队列')

  // 对账：认到的总数应该等于「几类原因之和」。对不上就是有岗位被静默吞了
  // （标题解析不出来、卡片结构变了…）—— 这种情况必须点名，否则永远查不到
  const rest = total - (applied + pending + blocked)
  if (rest > 0) parts.push(`另有 ${rest} 家原因不明（可能是标题没解析出来）`)

  // 页号写进前缀：翻页时同一句式反复出现，「本页」到底是第几页全靠脑补
  return `${page > 1 ? `第 ${page} 页` : '本页'} ${total} 家：${parts.join('、')}`
}

/**
 * 从搜索结果页 URL 读出「这一批到底投什么范围」。
 *
 * 为什么以 URL 为准而不是读插件里存的配置：
 *   配置可能没存上（填完立刻点、change 事件还没触发、旧版本残留），
 *   而 URL 是**页面事实**——页面显示什么岗位，就由它决定。
 *   2026-11-05 真机：配置里关键词是空的，算出的地址 `?city=深圳&type=intern`
 *   等于「深圳全部实习岗」，日志里却只有一句「正在跳到起点」看不出来。
 */
function searchScopeOf(href) {
  const out = { keyword: '', city: '', type: '', typeName: '', text: '', risky: '' }
  let u
  try {
    u = new URL(String(href || ''))
  } catch {
    return out
  }
  const get = (k) => String(u.searchParams.get(k) || '').trim()
  out.keyword = get('keyword')
  out.city = get('city')
  out.type = get('type')
  out.typeName = { intern: '实习', school: '校招', company: '企业' }[out.type] || out.type || '未指定'

  const parts = [`关键词 ${out.keyword || '⚠️ 不限'}`]
  parts.push(`城市 ${out.city || '⚠️ 不限'}`)
  parts.push(out.typeName === '未指定' ? '类型 ⚠️ 未指定' : `类型 ${out.typeName}`)
  out.text = parts.join('｜')

  // 关键词为空 = 投该城市全部岗位，这是最容易误投的一种
  if (!out.keyword) out.risky = '关键词为空：这一批是「该城市全部岗位」，不是某个方向'
  return out
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
 * 最终判定：这个 tab 算不算镜像。
 *
 * 三条规则，顺序不能换：
 *   ① 基线自己不是镜像；
 *   ② **已被行内文案印证过的 tab（confirmed）永远不是镜像** —— 我们亲眼看到列表换成了这个阶段
 *      的数据，集合和基线雷同只是巧合。这条是 2026-11-03 事故的修复：初筛 tab 只有 1 条投递，
 *      点 tab 后列表还没刷新就读，读到的恰好是「已投递」整页 → 集合等于基线 → 被判镜像 →
 *      tab 名失效 → 那条初筛永远记成 submitted（后端推进数恒为 0）；
 *   ③ 其余按集合相同判镜像（平台哪天改回「7 个 pane 渲染同一份全量」时兜底）。
 */
function resolveMirror(tab, base) {
  if (!tab || !base || tab === base) return false
  if (tab.confirmed) return false
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
 * 纯标签行：届别 / 批次 / 急招这类**不是岗位名**的独立行。
 *
 * 真机事故（2026-11-03，华曦达 3 条）：实习僧岗位名元素的 innerText 实际是
 * 「27届\n测试实习生」—— 届别标签是第一行。`cleanLabel` 取第一行，
 * 于是账本里三条不同岗位的标题全成了「27届」：方向判不出来（3 条留空），
 * 界面上看过去像三条重复记录。
 *
 * ⚠️ 只认「整行就是一个标签」的情况（带 ^$）。「27届校园招聘-测试实习生」这种
 * 真标题里含届别的不受影响 —— 那条才是常见形态，别一刀切。
 */
const PURE_TAG_LINE =
  /^(?:\d{2,4}\s*届(?:\s*(?:校招|春招|秋招|提前批))?|应届(?:生)?|在校生?|实习生?|校招|社招|急招|热招|新职位|今日|置顶)$/

function isPureTagLine(s) {
  return PURE_TAG_LINE.test(String(s || '').trim())
}

/**
 * 多行文本 → 岗位名：跳过纯标签行，取第一条「像内容」的行。
 * 全部都是标签（或只有一行）时退回原文第一行 —— 有总比没有强，但调用方会知道它可疑。
 */
function firstTitleLine(s) {
  const lines = String(s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const hit = lines.find((x) => !isPureTagLine(x))
  return hit || lines[0]
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

  // 纯标签行不能当岗位名：列表卡把届别单独渲染成一行时，keep[0] 是「27届」、
  // keep[1] 才是公司，真正的岗位名压根没在文本里 —— 硬记下去就是
  // 「27届 / 华曦达」，三条不同岗位看着像三条重复记录。宁可漏这一条。
  if (isPureTagLine(keep[0])) return null

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

/** 容器里有多少个**不同**岗位（按 jobId 去重）。 */
function uniqueJobIdsIn(root) {
  const ids = new Set()
  for (const a of jobLinksIn(root)) {
    const id = jobIdOfHref(a.getAttribute('href'))
    if (id) ids.add(id)
  }
  return ids.size
}

/**
 * 由岗位链接反推「这一行的容器」：一路向上，直到**装进第二个岗位**为止，
 * 取最后一个「只有自己这一个岗位」的祖先。
 *
 * ⚠️ 判据是**不同 jobId 的个数**，不是链接元素个数。
 * 同一张卡里常有两个指向同一岗位的链接（标题 + 「投个简历」按钮），
 * 按元素数算会在第一层就停住 —— 只拿到标题，城市、公司全丢。
 * 后果不是「少采一条」，而是**城市筛选彻底失效**（读不到城市就放行）：
 * 2026-11-05 用户实测，实习僧上连西安的岗位也被投了。
 */
function rowOfLink(a) {
  let cur = a
  let best = null
  for (let i = 0; i < 12; i++) {
    const up = cur.parentElement
    if (!up || up === document.body || up === document.documentElement) break
    if (uniqueJobIdsIn(up) > 1) break // 越界了（装进了别的岗位），上一轮的 best 才是行
    const lines = linesOf(up)
    if (lines.length > 12) break // 太大，不像一行
    best = up
    cur = up
  }
  return best
}

/**
 * 从岗位链接里取平台岗位 id。
 *
 * ⚠️ BOSS 必须带 `boss_` 前缀：投递那一刻 content.js 的 `jobIdOf()` 写进本地账本的就是
 * `boss_xxx`，后端也是按这个 id 存的。采集端如果只返回裸 id，同一条投递会出现两个 id，
 * `sameApply` 就只能退回「公司+岗位名」硬猜 —— 岗位一改名就断，而且是静默的。
 * （2026-11-03 发现两套格式并存，统一到这里。）
 */
function jobIdOfHref(href) {
  const s = String(href || '')
  const sx = s.match(/inn_[a-z0-9]+/i)
  if (sx) return sx[0]
  const boss = s.match(/job_detail\/([a-z0-9~_-]+)\.html/i)
  if (boss) return `boss_${boss[1]}`
  const q = s.match(/[?&]jobId=([a-z0-9~_-]+)/i)
  if (q) return `boss_${q[1]}`
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
/**
 * 公司名候选选择器。
 * ⚠️ 只允许在「某个已知容器内」或「全页唯一候选」时用，
 * **绝不能拿它当 document.querySelector 的全页通配**（见 findCompanyName 的事故说明）。
 */
const COMPANY_SEL = '[class*="company-name"], .company-name, .cname, .com-name'

/** 像不像一个公司名（滤掉「公司信息」这类区块标题、纯数字、以及被拼成一段话的整块文本） */
function looksLikeCompany(s) {
  const t = String(s || '').trim()
  if (t.length < 2 || t.length > 30) return false
  if (/^\d+$/.test(t)) return false
  if (/^(公司|企业|查看|更多|公司信息|工商信息|未知)/.test(t)) return false
  // 公司信息块的典型特征：规模区间 / 融资状态 / 「查看全部」。整块文本被 textOf 压成一行后
  // 长度可能还不到 30 字（「正浩创新 智能硬件 1000-9999人」才 20 字），光靠长度拦不住。
  if (/融资|已上市|未上市|\d+\s*[-~]\s*\d+\s*人|人以上|查看全部/.test(t)) return false
  // 中文公司名里几乎不会有空格；出现 2 段以上空格说明是多个字段拼起来的
  if ((t.match(/\s/g) || []).length >= 2) return false
  return true
}

/** 某个范围里出现了哪些**不同**的公司名（去重；过滤掉不像公司名的候选） */
function namesIn(scope) {
  const out = []
  if (!scope || !scope.querySelectorAll) return out
  let list = []
  try {
    list = [...scope.querySelectorAll(COMPANY_SEL)]
  } catch (_) {
    list = []
  }
  for (const el of list) {
    const t = textOf(el)
    if (looksLikeCompany(t) && out.indexOf(t) === -1) out.push(t)
  }
  return out
}

/**
 * 找「这个岗位」的公司名。
 *
 * ⭐ 2026-11-05 真机事故：原实现是
 *   document.querySelector('.job-banner .company-name, .company-info .company-name,
 *                          [class*="company-name"], .company-name, .cname, .com-name')
 * 最后那个 `[class*="company-name"]` 是**全页通配**。BOSS 一键投递跑在
 * 「左侧列表 + 右侧详情」页面上（URL 里连岗位 id 都没有），
 * 文档序第一个匹配往往来自**左侧列表里别的卡片** —— 于是账本记下的是**别人的公司**。
 * 症状极隐蔽：岗位名全对（那个选择器是精确的），只有公司名错，
 * 10 条 BOSS 记录里错了 4 条，看界面「解析一切正常」。
 * 铁证：「【日常实习】数据运营实习生(A69277)」同一个内部编号挂在两家不同公司名下。
 *
 * 铁律：**company 必须和 jobTitle 出自同一个区域，且那个区域里只能有一家公司**。
 * 拿不到就返回 ''（上层显示「未知公司」），宁可空也不要一个错的 ——
 * 错的会稳定匹配到一条错误的记录，空的至少还能被标出来。
 */
function findCompanyName(jobEl, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null)
  if (!doc) return ''

  // ① 从岗位名往上 4 层，找「同时装着岗位名」的那个容器，公司名只在这个范围内取。
  //    这一条是核心：它保证 company 和 jobTitle 说的是同一个岗位。
  //    容器里出现**两家以上**公司就说明范围已经大了（列表/侧栏混进来），直接放弃 ——
  //    继续往上只会看到更多家。
  let box = jobEl || null
  for (let i = 0; box && i < 4; i++) {
    box = box.parentElement
    if (!box) break
    if (String(textOf(box)).length > 1200) break // 再往上就是整页，等于没定位
    const names = namesIn(box)
    if (names.length === 1) return names[0]
    if (names.length > 1) break
  }

  // ② 全页**只有唯一一个**像公司名的候选时才用（真正的单岗位详情页，不存在张冠李戴）
  const all = namesIn(doc)
  if (all.length === 1) return all[0]

  // ③ 其余一律留空。**绝不回退「第一个匹配」** —— 那正是 4/10 公司名出错的根因。
  return ''
}

/** 公司名取值自检：候选全列出来 + 岗位名元素，用来一次性校准选择器 */
function probeCompanyScope() {
  const jobEl = (() => {
    try {
      return document.querySelector(
        '.job-banner .name, .job-primary .name, .job-detail-box .name, .job-name, .job-title, .position-name, h1'
      )
    } catch (_) {
      return null
    }
  })()
  const cands = []
  try {
    for (const el of document.querySelectorAll(COMPANY_SEL)) {
      const t = textOf(el)
      if (!t) continue
      const path = []
      let q = el
      for (let k = 0; k < 3 && q && q.parentElement; k++) {
        q = q.parentElement
        path.push(shortLabel(q))
      }
      cands.push({ text: t.slice(0, 30), ok: looksLikeCompany(t), el: shortLabel(el), path })
      if (cands.length >= 12) break
    }
  } catch (_) {
    /* 读不到就给空数组 */
  }
  return {
    note:
      '公司名自检：cands = 全页候选（ok=像公司名）；picked = 实际采用的值（空=宁可留空也不用错的）；' +
      'jobTitleEl = 岗位名元素。列表页候选很多是**别的卡片**，picked 必须是详情区那一个。',
    jobTitleEl: jobEl ? shortLabel(jobEl) : null,
    picked: findCompanyName(jobEl),
    cands,
  }
}

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
    // 命中 ≠ 「会话行上有状态文字」。BOSS 聊天页顶部有个「全部 / 未读 / 新招呼 / 仅沟通 / 更多」
    // 筛选栏，「未读」两个字必然被当成阶段词，于是 stageHits 永远是 1，
    // 而这一条命中的 UL 根本不是一条会话（2026-11-05 真机：stageHits:1，sample 就是那个 UL）。
    const hitsAreRows = hits.some((h) => looksLikeRow(linesOf(rowOfStageNode(h.el) || h.el)))
    resp.mode = 'text'
    resp.fallback = {
      stageHits: hits.length,
      hitsAreRows,
      note: hits.length && !hitsAreRows
        ? '这几条命中落在筛选栏/工具栏里（例如「未读」tab），不是会话行的状态文字 —— 页面本身可能一条记录都没渲染出来'
        : '',
      sample: hits.slice(0, 6).map((h) => {
        const row = rowOfStageNode(h.el)
        return {
          stage: h.text,
          tag: row ? row.tagName : '',
          lines: row ? linesOf(row) : [],
        }
      }),
    }

    // ⚠️ 以前这里是 `if (!hits.length)`：只要命中 1 条（哪怕命中的是筛选栏的「未读」）
    // 就整个不输出 layout / signals —— 偏偏「一行都没认出来」才是最需要看结构的时候。
    // 结果用户点了探测，只拿到一个 stageHits:1，等于白跑一趟。现在无条件输出。
    //
    // 每一段单独兜住错误：探测是「拿信息」的手段，不该因为某一段在某个页面结构上炸了，
    // 就让整份报告变成一句 `xxx is not iterable`（v0.7.3 真机就吃过这个当）。
    const safe = (fn) => {
      try {
        return fn()
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }
    // BOSS 聊天页有会话列表时，优先吐「一条会话 = 什么」—— 比全局结构猜测精确得多，
    // 也省得用户贴一大段用不上的 JSON（18 条 × 长打招呼语，光 layout 就上千字）
    const chat = safe(probeChatList)
    resp.chatList = chat
    resp.chatPanel = safe(probeChatPanel)
    if (!(chat && chat.count > 0)) {
      resp.layout = safe(probeLayout)
      resp.containers = safe(probeContainers)
      resp.frames = safe(probeFrames)
    }
    resp.signals = safe(probeSignals)
  }

  // —— 列表页探测（BOSS 搜索结果页 / 实习僧列表页）——
  // 必须放在最后：它会覆盖 mode，因为「页面上一堆岗位卡」和「一条条投递记录」
  // 长得完全一样（都是「只含自己一个链接的容器」），不明确标出来就会把岗位卡当投递记录。
  const listing = probeListing()
  if (listing) {
    resp.mode = 'listing'
    resp.listing = listing
  }

  // 公司名自检：不跟着「有没有行」走，任何页面都带上。
  // 它存在的唯一原因就是「公司名曾经 4/10 取错，而界面上完全看不出来」。
  try {
    resp.company = probeCompanyScope()
  } catch (e) {
    resp.company = { error: String((e && e.message) || e) }
  }

  return resp
}

/**
 * 从「同 tag + 同首个 class token」的分组里，挑出像列表项的几组（纯函数）。
 *
 * 用途：BOSS 对话列表这类页面**一条岗位链接都没有**，按链接定位整条路走不通；
 * 文本兜底又只在认得出阶段词时才有输出 —— 两个条件同时不满足时，探测返回的就是
 * 「stageHits: 0」，等于什么都没说，得再改一版代码才能继续。
 *
 * 所以这里退一步：不管三七二十一，把页面上**重复出现最多的几块结构**吐出来。
 * 用户（或我）一眼就能看出「哦，这个 class 就是会话行」，一次探测定位到位。
 *
 * @param {Array<{key:string,tag:string,cls:string,count:number}>} entries
 * @returns {Array} 按出现次数降序；过少的（<minCount）是零散小组件，过多的（>maxCount）是全局容器
 */
function rankBlockGroups(entries, opts) {
  const minCount = (opts && opts.minCount) || 3
  const maxCount = (opts && opts.maxCount) || 60
  const limit = (opts && opts.limit) || 3
  const seen = new Set()
  const out = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !e.key || seen.has(e.key)) continue
    seen.add(e.key)
    const c = Number(e.count) || 0
    if (c < minCount || c > maxCount) continue
    out.push({ key: e.key, tag: e.tag, cls: e.cls, count: c })
  }
  out.sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)))
  return out.slice(0, limit)
}

/** 一组的样本像不像「一行投递/会话语义」：2~10 行、总字数别太长 */
function looksLikeRow(lines) {
  const ls = Array.isArray(lines) ? lines : []
  if (ls.length < 2 || ls.length > 10) return false
  return ls.join('').length <= 300
}

/**
 * 结构兜底探测：页面上什么都没有认出来时，描述一下「这页长什么样」。
 * 只读不点，纯观察。
 */
function probeLayout() {
  const groups = new Map()
  let scanned = 0
  try {
    for (const el of document.querySelectorAll('div,li,article,section,tr,a,span')) {
      scanned++
      const toks = classTokens(el)
      if (!toks.length) continue
      const tag = String(el.tagName || '').toUpperCase()
      const key = `${tag}.${toks[0]}`
      let rec = groups.get(key)
      if (!rec) {
        rec = { key, tag, cls: toks[0], count: 0, els: [] }
        groups.set(key, rec)
      }
      rec.count++
      if (rec.els.length < 3) rec.els.push(el)
    }
  } catch (_) {
    return { scanned, note: '扫页面时出错（页面结构异常）', groups: [] }
  }

  // 取 5 组而不是 3：BOSS 聊天页的「重复块」前几名经常是工具栏/头像列表，
  // 真正的会话行可能排在第 4、5 位。多吐两组比少吐一次再跑一趟便宜。
  const ranked = rankBlockGroups([...groups.values()], { limit: 5 })
  const out = []
  for (const g of ranked) {
    // ⚠️ rankBlockGroups 是纯函数，只回 { key, tag, cls, count } —— **没有 els**。
    // 元素实例留在 groups 里，必须按 key 取回来。
    // 以前这里直接写 `for (const el of g.els)`（g.els 恒为 undefined），
    // 只因为「有阶段词命中就不进这段」的抑制条件一直没让这段执行到，才从没报错；
    // v0.7.3 去掉抑制后第一次真机就炸 `g.els is not iterable`（2026-11-05）。
    const rec = groups.get(g.key)
    if (!rec || !Array.isArray(rec.els)) continue
    const samples = []
    for (const el of rec.els) {
      let lines = []
      try {
        lines = linesOf(el)
      } catch (_) {
        lines = []
      }
      if (!looksLikeRow(lines)) continue
      samples.push({ tag: g.tag, cls: g.cls, shown: isShown(el), lines })
    }
    // 一组里连一个像行的样本都没有 → 这组是布局容器，不是列表项，别占篇幅
    if (samples.length) out.push({ key: g.key, count: g.count, samples })
  }

  return {
    scanned,
    note: '没认出投递行。下面是页面上重复出现最多的几块结构（每块给几条样本）—— 哪块是「一行会话/一条投递」，把它的 tag + class 发我。',
    groups: out.slice(0, 3),
  }
}

/** 元素的 class token 列表。SVG 的 className 是 SVGAnimatedString（读 `.baseVal`），别直接 String() */
function classTokens(el) {
  const c = el && el.className
  const s = typeof c === 'string' ? c : c && typeof c.baseVal === 'string' ? c.baseVal : ''
  return String(s).trim().split(/\s+/).filter(Boolean)
}

/** 元素 id/class 拼成一个短标签，便于报告里定位（class 只取前两个 token） */
function shortLabel(el) {
  if (!el) return ''
  const toks = classTokens(el)
  const tag = String(el.tagName || '').toUpperCase()
  const id = el.id ? `#${el.id}` : ''
  return tag + id + (toks.length ? '.' + toks.slice(0, 2).join('.') : '')
}

/**
 * 容器聚类探测：找「子元素高度同构」的父容器。
 *
 * 为什么 `probeLayout` 不够：它按**全局** tag+首个 class 分组，只要有 3 个以上同 class 就成一堆。
 * 但聊天列表每行的 class 常常带状态修饰（`chat-user-item active` / `chat-user-item`），
 * 更麻烦的是父容器自己也可能跟别的容器撞名，分组结果里排在前面的是头像墙、工具栏。
 * 这里换个角度：先找**子元素 ≥4 个且大半同构**的父容器，那个父容器几乎必然就是列表本体。
 *
 * 纯只读，不点不滚。
 */
function probeContainers() {
  const ranked = []
  try {
    for (const el of document.querySelectorAll('div,ul,ol,section,aside,main,form,table,tbody,dl')) {
      const kids = [...el.children]
      if (kids.length < 4) continue

      const byKey = new Map()
      for (const k of kids) {
        const toks = classTokens(k)
        const key = String(k.tagName || '').toUpperCase() + '.' + (toks[0] || '(no-class)')
        let rec = byKey.get(key)
        if (!rec) {
          rec = { key, count: 0, els: [] }
          byKey.set(key, rec)
        }
        rec.count++
        if (rec.els.length < 3) rec.els.push(k)
      }

      for (const rec of byKey.values()) {
        // 列表容器的子元素绝大多数同构：至少 4 个，且占该容器子元素的一半以上
        if (rec.count < 4 || rec.count < kids.length * 0.6) continue
        const samples = []
        for (const k of rec.els) {
          let lines = []
          try {
            lines = linesOf(k)
          } catch (_) {
            lines = []
          }
          if (!looksLikeRow(lines)) continue
          samples.push({ item: shortLabel(k), lines, shown: isShown(k) })
        }
        // 一个像行的样本都没有 → 不是列表项（可能是按钮组、头像组），别占篇幅
        if (!samples.length) continue
        ranked.push({
          parent: shortLabel(el),
          itemKey: rec.key,
          count: rec.count,
          ofChildren: kids.length,
          samples,
        })
      }
    }
  } catch (_) {
    return { note: '扫容器时出错（页面结构异常）', list: [] }
  }

  ranked.sort((a, b) => b.count - a.count)
  return {
    note: '按「子元素高度同构」找到的列表容器。parent 是容器、itemKey 是每行的 tag+class —— BOSS 会话列表通常就是这里的第一项。',
    list: ranked.slice(0, 4),
  }
}

/**
 * BOSS 会话列表探测（2026-11-05 真机结构确认）。
 *
 * 实测结构（zhipin.com/web/geek/chat）：
 *   `UL > LI`（LI 没有 class）→ 每行一个 `.friend-content`
 *   行内文本固定 4 段：`时间` / `秦女士KeepHR` / `[已读]`或`[送达]` / 最后一条消息
 *   状态是 `<i class="message-status status-read|status-delivery">`，**不是**「已读」两个字
 *
 * 三个必须靠这段探测才能确定的事：
 *   1. `li` 上有没有 `data-*` 带加密 jobId（后端记录是 `boss_090350f0ddf5ca990nx_3Ny4E1NS`）。
 *      有 → 能精确匹配；没有 → 只能靠公司名，而「RAK瑞科慧联」「丽珠医药集团」各投了 2 个岗，会歧义。
 *   2. `read: null` 的行到底长什么样（18 条会话只有 6 已读 + 9 送达 = 15 个图标，
 *      缺的 3 条大概率是对方最后发的 → 那就是「已回复」）。
 *   3. 会话行本身没有岗位名 → 只能点开看右侧，所以必须知道右侧有没有岗位卡片。
 */
function probeChatList() {
  let contents = []
  try {
    contents = [...document.querySelectorAll('.friend-content')]
  } catch (_) {
    contents = []
  }
  if (!contents.length) {
    return { count: 0, note: '没找到 .friend-content —— 会话列表可能没渲染（左栏空着），或 BOSS 换了结构' }
  }

  const attrOf = (el) => {
    const out = {}
    let attrs = null
    try {
      attrs = el && el.attributes ? [...el.attributes] : []
    } catch (_) {
      attrs = []
    }
    for (const a of attrs) {
      if (!a || !a.name) continue
      // 只要可能带 id 的属性：data-*、id、href、title
      if (/^data-/.test(a.name) || a.name === 'id' || a.name === 'href' || a.name === 'title') {
        out[a.name] = String(a.value || '').slice(0, 70)
      }
    }
    return out
  }

  const rows = contents.slice(0, 20).map((el, i) => {
    const li = (el.closest && el.closest('li')) || el.parentElement
    let icon = null
    try {
      icon = el.querySelector('[class*="status-read"], [class*="status-delivery"]')
    } catch (_) {
      icon = null
    }
    const iconCls = icon ? String(icon.className || '') : ''
    return {
      i,
      li: shortLabel(li),
      attrs: attrOf(li),
      contentAttrs: attrOf(el),
      read: /status-read/.test(iconCls) ? true : /status-delivery/.test(iconCls) ? false : null,
      iconText: icon ? String(icon.innerText || '').trim() : '',
      lines: linesOf(el).map((s) => s.slice(0, 36)),
    }
  })

  return {
    count: contents.length,
    note:
      '一行 = 一个 li 里的 .friend-content。read=true 我方最后一条已被读；false 只送达未读；' +
      'null = 这行没有送达图标，多半是对方最后发的（≈ 已回复）。attrs 里找加密 jobId。',
    rows,
  }
}

/**
 * 局部重复结构：只看某个节点**内部**，找「子元素 ≥3 且大半同构」的容器。
 * 和 probeContainers 的区别在作用域 —— 全局版把整页的列表混在一起，
 * 而这里要回答的是一句具体问题：「右侧对话区里，一条消息长什么样」。
 */
function localRowGroups(root, limit) {
  const out = []
  if (!root) return out
  try {
    for (const el of root.querySelectorAll('div,ul,ol,section,aside,main')) {
      const kids = [...el.children]
      if (kids.length < 3) continue
      const byKey = new Map()
      for (const k of kids) {
        const key = String(k.tagName || '').toUpperCase() + '.' + (classTokens(k)[0] || '(no-class)')
        let rec = byKey.get(key)
        if (!rec) {
          rec = { key, count: 0, first: k }
          byKey.set(key, rec)
        }
        rec.count++
      }
      for (const rec of byKey.values()) {
        if (rec.count < 3 || rec.count < kids.length * 0.6) continue
        let lines = []
        try {
          lines = linesOf(rec.first)
        } catch (_) {
          lines = []
        }
        out.push({
          parent: shortLabel(el),
          itemKey: rec.key,
          count: rec.count,
          sample: lines.slice(0, 4).map((s) => s.slice(0, 40)),
        })
      }
    }
  } catch (_) {
    return out
  }
  out.sort((a, b) => b.count - a.count)
  // 同一结构会被多层容器重复计入（消息行本身、包裹层、列表层），只留 count 最大那条
  const seen = new Set()
  const uniq = []
  for (const x of out) {
    if (seen.has(x.itemKey)) continue
    seen.add(x.itemKey)
    uniq.push(x)
    if (uniq.length >= (limit || 5)) break
  }
  return uniq
}

/** 节点里「含岗位/薪资/沟通职位线索」的短文本（太长的是聊天正文，没用） */
function collectJobHints(root, limit) {
  const hints = []
  if (!root) return hints
  try {
    for (const el of root.querySelectorAll('div,span,a,p,h1,h2,h3')) {
      const t = String(el.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!t || t.length > 40) continue
      if (!/沟通职位|查看职位|期望|薪资|K·|元\/天|招聘者|在线|投递|浏览|\d+-\d+K/.test(t)) continue
      hints.push({ el: shortLabel(el), text: t })
      if (hints.length >= (limit || 12)) break
    }
  } catch (_) {
    /* 读不到就算了 */
  }
  return hints
}

/**
 * 一个节点像不像「对话区」。
 * 只按字数挑会把**标签栏**选出来 —— 真机踩过：`DIV.label-list`
 * （全部/未读/新招呼/仅沟通/更多）是会话列表的兄弟、16 个字，
 * 却是那一层兄弟里最长的那个 → panel 指到它头上，后面所有结论全歪。
 */
function looksLikeChatPanel(el, len) {
  if (!el) return false
  // 60 字是个经验下限：标签栏那种（16 字）该被排除，而真机对话区是 212 字。
  // 刚打开、消息还没渲染的会话靠「有消息节点」这条兜底。
  if ((len || 0) >= 60) return true
  try {
    return el.querySelectorAll('[class*="message"], [class*="bubble"], [class*="dialog"]').length >= 1
  } catch (_) {
    return false
  }
}

/**
 * 岗位卡探测：点开会话后，岗位名 / 薪资 / 城市都在 `.chat-position-content` 里。
 * 真机样本（2026-11-05）：
 *   lines = ["社媒运营实习生（多平台 / 发布与维护）", "120-150元/天", "深圳", "查看职位"]
 * 这里把每个子元素拆开，是为了确认「哪一段是岗位名」—— 光靠位置猜，
 * 碰到没有薪资的岗位（只看「面议」）就会整体错位。
 */
function probePositionCard(panel) {
  if (!panel) return null
  let el = null
  for (const sel of ['.chat-position-content', '.position-content', '.chat-position']) {
    try {
      const hit = panel.querySelector(sel)
      if (hit) {
        el = hit
        break
      }
    } catch (_) {
      /* 下一个 */
    }
  }
  if (!el) return null

  const kids = [...el.children].slice(0, 6).map((c) => {
    let text = ''
    try {
      text = String(c.innerText || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 50)
    } catch (_) {
      text = ''
    }
    return { el: shortLabel(c), text }
  })

  // 「查看职位」到底是 <a> 还是 <button>：是 <a> 就有 jobId，是 button 就只能点开看
  let link = null
  try {
    const a = el.querySelector('a[href]')
    if (a) {
      link = {
        label: shortLabel(a),
        href: String(a.getAttribute('href') || '').slice(0, 100),
      }
    }
  } catch (_) {
    link = null
  }

  return { el: shortLabel(el), lines: linesOf(el).slice(0, 8), kids, link }
}

/**
 * 消息行探测：`UL.im-list > LI.message-item`。
 * 要判断「最后一条是谁说的」，靠的是**我方消息带 [已读]/[送达] 状态图标、对方不带** ——
 * 这比猜 class 后缀（self/right/mine）可靠：真机上两侧的 class 名往往一样。
 */
function probeMessageRows(panel) {
  if (!panel) return null
  let listEl = null
  for (const sel of ['.im-list', '.chat-message-list', '.message-list']) {
    try {
      const hit = panel.querySelector(sel)
      if (hit) {
        listEl = hit
        break
      }
    } catch (_) {
      /* 下一个 */
    }
  }
  if (!listEl) return { count: 0, note: '没找到消息列表容器（.im-list 等）' }

  const all = [...listEl.children]
  const rows = all.slice(0, 10).map((li, i) => {
    const cls = classTokens(li).join(' ')
    let text = ''
    try {
      text = String(li.innerText || '').replace(/\s+/g, ' ').trim()
    } catch (_) {
      text = ''
    }
    let statusText = ''
    let hasStatus = false
    try {
      const st = li.querySelector('[class*="message-status"], [class*="status-read"], [class*="status-delivery"]')
      if (st) {
        hasStatus = true
        statusText = String(st.innerText || '').trim()
      }
    } catch (_) {
      /* 没有就是对方发的 */
    }
    return {
      i,
      cls,
      hasStatus,
      statusText,
      text: text.slice(0, 90),
    }
  })

  return {
    el: shortLabel(listEl),
    count: all.length,
    note: 'hasStatus=true（带 [已读]/[送达]）就是我方发的；count 是列表里**全部**行数，不是只取的前 10 条',
    rows,
  }
}

/**
 * 会话区探测：确认「点开一条会话能不能拿到岗位名 / 岗位 id」。
 *
 * ⚠️ v0.7.5 踩过的坑：`.chat-content` 在 BOSS 上**不是右侧对话区**，
 * 它的直接孩子只有 `.user-list`（左侧会话列表）。上一版拿它当对话区，
 * 于是 `top` 里全是左侧的招聘者名、`jobLinks=0` —— 据此得出的
 * 「点开也拿不到岗位」是假的，因为当时压根没打开任何会话。
 *
 * 这一版换个走法：**从会话列表往上爬三层**，把每层的兄弟节点都摊开。
 * 右侧对话区一定会出现在某一层的兄弟里，且通常是最长的那个；
 * 同时对该节点跑局部结构聚类，直接看出「一条消息」的 class。
 */
function probeChatPanel() {
  let list = null
  for (const sel of ['.user-list', '.friend-content', '.chat-content']) {
    try {
      const el = document.querySelector(sel)
      if (el) {
        list = el
        break
      }
    } catch (_) {
      /* 选择器不合法也继续试下一个 */
    }
  }
  if (!list) {
    return { note: '没找到会话列表（.user-list / .friend-content）—— 这一页可能不是聊天页' }
  }

  // 往上爬，直到 body：v0.7.7 只爬 3 层，结果只到 .list-warp.v2 就停了，
  // 而对话区如果挂在更高层（浮层 / portal）就完全看不见 —— 这次一路爬到顶。
  const upChain = []
  let p = list
  for (let i = 0; i < 8 && p && p.parentElement; i++) {
    p = p.parentElement
    const kids = [...p.children]
    upChain.push({
      level: i + 1,
      el: shortLabel(p),
      childCount: kids.length,
      kids: kids.slice(0, 8).map((c) => {
        let len = 0
        try {
          len = String(c.innerText || '').replace(/\s+/g, ' ').trim().length
        } catch (_) {
          len = 0
        }
        return `${shortLabel(c)}(${len}字)`
      }),
    })
    if (document.body && p === document.body) break
  }

  // 右侧对话区：定位逻辑统一走 findChatPanel（采集器也用同一份，避免两处各猜一套）。
  // ⭐ 真机结构（2026-11-05 第三次探测）：
  //     DIV.chat-wrap
  //       ├ DIV.list-warp.v2      (2739字，左栏)
  //       └ DIV.chat-conversation (212字，对话区)
  //   对话区在**第 4 层**祖先的兄弟上，比列表高两层。
  //   前一版只看「列表的直接父级」的兄弟（= .chat-user.v2 下面，只有搜索框和标签栏），
  //   层数错了，再怎么比字数也找不到。
  const panel = findChatPanel()

  // 岗位链接**明细**：v0.7.7 只报了个数字（0→4 变了却不知道为什么）。
  // ⚠️ 真机打脸：`a[href*="job"]` 那 4 条全是顶部导航（职位 / 海归 / 无障碍专区 / 去看看），
  // 跟岗位一点关系没有。所以这里把导航类过滤掉，并单独报出过滤了多少条 ——
  // 不然「岗位链接 4 条」会一直把人往错的方向带。
  const jobLinkList = []
  let pageLinks = 0
  let navSkipped = 0
  try {
    const all = [...document.querySelectorAll('a[href*="job_detail"], a[href*="job"]')]
    for (const a of all) {
      let text = ''
      let near = ''
      try {
        text = String(a.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40)
        near = shortLabel(a.parentElement)
      } catch (_) {
        /* 读不到就留空 */
      }
      let href = ''
      try {
        href = String(a.getAttribute('href') || '').slice(0, 90)
      } catch (_) {
        href = ''
      }
      // 往上四层的标签链：从「岗位链接」反查它到底挂在哪，比再猜一轮选择器快得多
      const path = []
      let q = a
      for (let k = 0; k < 4 && q && q.parentElement; k++) {
        q = q.parentElement
        path.push(shortLabel(q))
      }
      const isNav = /nav|header|logo|breadcrumb/i.test(near) || path.some((s) => /nav|header/i.test(s))
      if (isNav) {
        navSkipped++
        continue
      }
      pageLinks++
      if (jobLinkList.length < 8) jobLinkList.push({ href, text, near, path })
    }
  } catch (_) {
    pageLinks = 0
  }

  // Shadow DOM：web component 里的对话区用 querySelectorAll 永远扫不到。
  // BOSS 未必用了，但「整个链路找不到对话区」这个现象必须先排除它。
  const shadows = []
  try {
    let scanned = 0
    for (const el of document.querySelectorAll('*')) {
      if (++scanned > 5000) break
      if (el.shadowRoot) {
        shadows.push(shortLabel(el))
        if (shadows.length >= 5) break
      }
    }
  } catch (_) {
    /* 扫不动就算了，不拖垮整份报告 */
  }

  if (!panel) {
    return {
      note:
        '只找到左侧会话列表，右侧对话区不在列表的兄弟节点里。' +
        '要么它挂在更高层（看 upChain 到 body 为止）／Shadow DOM（看 shadows），' +
        '要么这一页确实是单栏布局、对话开在别处。',
      upChain,
      shadowCount: shadows.length,
      shadows,
      jobLinks: pageLinks,
      navSkipped,
      jobLinkList,
      panel: null,
    }
  }

  let panelLinks = 0
  try {
    panelLinks = panel.querySelectorAll('a[href*="job_detail"], a[href*="job"]').length
  } catch (_) {
    panelLinks = 0
  }

  let msgNodes = 0
  try {
    msgNodes = panel.querySelectorAll('[class*="message"], [class*="bubble"]').length
  } catch (_) {
    msgNodes = 0
  }

  // 空状态占位：BOSS 没选中会话时，右侧只写一句「与您进行过沟通的 Boss 都会在左侧列表中显示」。
  // 不判这个的话，报告里会出现「对话区已打开、0 条消息、0 条线索」—— 看着像采集成功其实什么都没拿到，
  // 用户还得再猜一轮到底要不要点开会话。
  let panelText = ''
  try {
    panelText = String(panel.innerText || '').replace(/\s+/g, ' ').trim()
  } catch (_) {
    panelText = ''
  }
  const emptyRe = /都会在左侧列表中显示|请选择一个?会话|点击左侧|暂无(会话|消息)|开始聊天/
  const panelEmpty = msgNodes === 0 && (emptyRe.test(panelText) || panelText.length < 40)

  return {
    note:
      '右侧对话区（当前打开的那个会话）。panel.empty=true 表示这是空状态占位、还没点开会话；' +
      'panel.groups = 消息行结构；panel.hints = 岗位/薪资线索；jobLinkList = 岗位链接明细',
    upChain,
    shadowCount: shadows.length,
    shadows,
    panel: {
      el: shortLabel(panel),
      empty: panelEmpty,
      textLength: panelText.length,
      lines: linesOf(panel).slice(0, 8).map((s) => s.slice(0, 40)),
      jobLinks: panelLinks,
      msgNodes,
      hints: collectJobHints(panel, 12),
      position: probePositionCard(panel),
      messages: probeMessageRows(panel),
      groups: localRowGroups(panel, 4),
    },
    jobLinks: pageLinks,
    navSkipped,
    jobLinkList,
  }
}
/* ================= BOSS 聊天页逐条采集 ================= */

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** 节点纯文本（压空白）。innerText 对隐藏元素会退化成 textContent，这里两个都试。 */
function textOf(el) {
  if (!el) return ''
  try {
    return String(el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
  } catch (_) {
    return ''
  }
}

/**
 * 右侧对话区（当前打开的那条会话）。
 *
 * ⭐ 真机结构（2026-11-05，第 3 次探测）：
 *     DIV.chat-wrap
 *       ├ DIV.list-warp.v2       (左栏)
 *       └ DIV.chat-conversation  (对话区 —— 比列表高**两层**)
 * 前两版只看「列表直接父级」的兄弟（那里只有搜索框和标签栏），层数错了怎么调阈值都找不到。
 * 已知 class 优先；找不到再逐层向上 6 层，比兄弟里最长的那个像不像对话区。
 */
function findChatPanel() {
  for (const sel of [
    '.chat-conversation',
    '.chat-dialog',
    '.chat-message',
    '.chat-panel',
    '.message-content',
  ]) {
    try {
      const el = document.querySelector(sel)
      if (el) return el
    } catch (_) {
      /* 选择器不合法就试下一个 */
    }
  }
  let list = null
  for (const sel of ['.user-list', '.friend-content', '.chat-content']) {
    try {
      list = document.querySelector(sel)
      if (list) break
    } catch (_) {
      list = null
    }
  }
  if (!list) return null
  let node = list
  for (let i = 0; i < 6 && node && node.parentElement; i++) {
    const parent = node.parentElement
    const sibs = [...parent.children].filter((c) => c !== node)
    let best = null
    for (const c of sibs) {
      const len = textOf(c).length
      if (!best || len > best.len) best = { el: c, len }
    }
    if (best && looksLikeChatPanel(best.el, best.len)) return best.el
    node = parent
  }
  return null
}

/**
 * 当前对话区的「指纹」，用来判断点开会话后右栏到底换没换。
 * ⚠️ 不能只看「有没有内容」：点开的瞬间右栏还是上一条会话的内容，
 * 按「有内容了」判成功会把 A 的岗位名记到 B 头上（和实习僧切 tab 那次同一个坑）。
 */
function chatPanelKey(panel) {
  if (!panel) return ''
  const who = textOf(panel.querySelector('.base-info') || panel.querySelector('.user-info'))
  const pos = textOf(panel.querySelector('.chat-position-content') || panel.querySelector('.position-content'))
  let first = ''
  try {
    const list = panel.querySelector('.im-list') || panel.querySelector('.chat-message-list')
    const f = list && list.firstElementChild
    first = f ? textOf(f).slice(0, 24) : ''
  } catch (_) {
    first = ''
  }
  return `${who}|${pos}|${first}`.slice(0, 200)
}

/** 等对话区内容换成别的（最多 timeoutMs）。返回新 panel，超时返回 null。 */
async function waitPanelChange(beforeKey, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleepMs(150)
    const p = findChatPanel()
    if (p && chatPanelKey(p) !== beforeKey) return p
  }
  return null
}

function clickEl(el) {
  if (!el) return
  try {
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center' })
  } catch (_) {
    /* 滚不动不影响点击 */
  }
  try {
    el.click()
  } catch (_) {
    /* 点不动就等超时，不抛 */
  }
}

/**
 * 这一行是不是「当前已经打开的会话」。
 * 为什么必须判：点开一条**本来就开着**的会话，右栏内容不会变 →
 * 指纹不变 → 被当成「点了没反应」跳过。而真实场景里用户刚聊完就点采集，
 * 第一条八成就是开着的，会稳定丢掉最新那条。
 */
const activeOf = (el, li) =>
  /\bactive\b/.test(String((el && el.className) || '')) ||
  /\bactive\b/.test(String((li && li.className) || ''))

/** 一行的文本指纹：只取前两行（招聘者 / 公司·岗位），去掉空白后比对 */
const rowTextOf = (el, lines) =>
  String((lines || linesOf(el) || []).slice(0, 2).join(' ')).replace(/\s+/g, '')

/**
 * 这一行的节点还挂在文档里吗？不在了就按**文本指纹**重新找一遍。
 *
 * 为什么必须做（真机 2026-11-05，扩展 0.8.1，赵怡和智传信那条）：
 * 左栏是 React 渲染的，**点开一条会把未读红点清掉 → 触发整列重画**，
 * 于是循环开头一次性抓下来的其它行 node 全部变成「游离节点」。
 * 对游离节点 `el.click()` **不抛错、也不触发跳转** —— 症状就是「点了没反应」，
 * 而且只丢中间那一条（前面几条点的时候节点还活着）。
 * 用文本指纹重定位而不是重抓下标：重画后顺序可能变，下标会点错人。
 */
function relocateRow(r) {
  const fp = rowTextOf(r.el, r.lines)
  if (!fp) return null
  let list = []
  try {
    list = [...document.querySelectorAll('.friend-content')]
  } catch (_) {
    list = []
  }
  for (const el of list) {
    if (rowTextOf(el) === fp) return el
  }
  return null
}

const SALARY_RE =
  /(\d+(\.\d+)?\s*[-~～]\s*\d+(\.\d+)?\s*(?:[kK]|元\/天|元\/月|元\/时))|(\d+\s*元\/天)|(\d+(\.\d+)?\s*[kK]\s*[-~～]\s*\d+(\.\d+)?\s*[kK])|面议/
const CARD_NOISE_RE = /查看职位|沟通职位|立即沟通|查看全部|感兴趣|继续沟通|举报/

/**
 * 「我放弃」的措辞。**只在最后一条是我方消息时**才判，且问句不算。
 *
 * 为什么必须单独识别（真机样本 2026-10-30 惊叹科技）：
 * 我发的是「不好意思，我觉得该职位不太适合我，祝您早日找到满意的工作人选」——
 * 这是我自己放弃，不是 HR 拒我。混进 rejected 会让「被拒率」虚高，
 * 而那条恰恰是漏斗里唯一能反映「我主动筛掉」的数据，值得单独记。
 */
const WITHDRAW_RE =
  /(不太适合我|不适合我|不合适|不匹配|不考虑了?|不感兴趣|放弃|另谋|祝您?早日找到|已入职|已找到工作|暂时不(?:考虑|去|面))/

function looksWithdrawn(lastFrom, lastText) {
  if (lastFrom !== 'me') return false
  const s = String(lastText || '')
  if (!s) return false
  if (/[？?]\s*$/.test(s)) return false // 问句不是放弃（「我的经历不合适吗？」）
  return WITHDRAW_RE.test(s)
}

/**
 * 读当前打开的那条会话。
 * 真机样本（2026-11-05，赵怡和智传信）：
 *   `.chat-position-content` 的 lines = ["社媒运营实习生（多平台 / 发布与维护）", "120-150元/天", "深圳", "查看职位"]
 * 薪资优先取 `.salary`（单独一个 SPAN），比按位置数第几段靠得住 ——
 * 有的岗位只写「面议」，按位置取会把城市当薪资，后面全错位。
 */
function readOpenChat(panel) {
  if (!panel) return { jobTitle: '', salary: '', city: '', msgCount: 0, lastFrom: '', lastText: '' }
  const card =
    panel.querySelector('.chat-position-content') || panel.querySelector('.position-content') || null

  let jobTitle = ''
  let salary = ''
  let city = ''
  for (const raw of card ? linesOf(card) : []) {
    const s = String(raw || '').trim()
    if (!s || CARD_NOISE_RE.test(s)) continue
    if (!salary && SALARY_RE.test(s)) {
      salary = s
      continue
    }
    if (!jobTitle && s.length >= 3) {
      jobTitle = s
      continue
    }
    if (jobTitle && !city && s.length <= 8 && !/\d/.test(s)) city = s
  }
  try {
    const t = textOf(card && card.querySelector('.salary'))
    if (t) salary = t
  } catch (_) {
    /* 没有就用手上那个 */
  }

  let imList = null
  for (const sel of ['.im-list', '.chat-message-list', '.message-list']) {
    try {
      const hit = panel.querySelector(sel)
      if (hit) {
        imList = hit
        break
      }
    } catch (_) {
      /* 试下一个 */
    }
  }
  const rows = imList ? [...imList.children] : []
  let lastFrom = ''
  let lastText = ''
  // 谁先开口 / 我发过几条 —— 用来区分「我投的」和「HR 主动找我的」。
  // 只读最后一条是不够的：HR 群发的招呼也算「对方最后发言」，
  // 但那条根本没进过我的投递漏斗，混进「已投递」分母会把投递量撑大。
  let firstFrom = ''
  let myMsgCount = 0
  for (let k = 0; k < rows.length; k++) {
    const row = rows[k]
    const cls = classTokens(row).join(' ')
    // 我方消息带 [已读]/[送达] 图标；对方不带；系统消息（"发送了面试结果"）也不带，
    // 但它不是「对方在跟我说话」—— 不排除的话会把拒信记成 repliedAt，面试层跟着虚高。
    const hasStatus = !!(
      row.querySelector &&
      row.querySelector('[class*="message-status"], [class*="status-read"], [class*="status-delivery"]')
    )
    const isSystem = /system|notice/i.test(cls)
    const from = isSystem ? 'system' : hasStatus ? 'me' : 'other'
    if (hasStatus) myMsgCount++
    if (!firstFrom && from !== 'system') firstFrom = from
    if (k === rows.length - 1) {
      lastFrom = from
      lastText = textOf(row).slice(0, 60)
    }
  }

  return {
    jobTitle,
    salary,
    city,
    msgCount: rows.length,
    lastFrom,
    lastText,
    firstFrom,
    myMsgCount,
    // 只看最后一条且必须是我发的：HR 说「不合适」是被拒，我说「不合适」是我放弃
    withdrawn: looksWithdrawn(lastFrom, lastText),
  }
}

/** 招聘者角色词，拆「姓名+公司」时要剥掉的尾巴（长的排前面） */
const ROLE_RE =
  /(集团校园招聘经理|校园招聘经理|校招经理|招聘经理|招聘专家|招聘专员|招聘总监|招聘者|人事招聘|人事专员|人事经理|人力资源|hrbp|HR|校招|社招|招聘|人事|经理|主管|总监|副总裁|负责人)$/i

/**
 * 拆「姓名 + 公司」。**只在分字段读失败时才用**，规则注定不完美
 * （公司名本身可能以「集团」「招聘」结尾），所以结果必须带 guess 标记让预览能核对。
 * 只剥「X先生/女士/小姐」这种确定是姓名的前缀，**不猜 2~3 字姓名** ——
 * 「胡浩云绿联科技」（3 字名）和「刘静腾讯音乐」（2 字名）互相矛盾，猜必错一半。
 */
function splitNameCompany(raw) {
  let s = String(raw || '').trim()
  if (!s) return { name: '', company: '', guess: false }
  for (let i = 0; i < 2; i++) {
    const next = s.replace(ROLE_RE, '')
    if (next === s) break
    s = next
  }
  const m = s.match(/^(.{1,4}?(?:先生|女士|小姐))/)
  if (m) return { name: m[1], company: s.slice(m[1].length), guess: true }
  return { name: '', company: s, guess: true }
}

/**
 * 从对话区头部取「招聘者姓名 + 公司名」。
 * 优先分字段：`.base-info` 里姓名 / 公司 / 角色各占一个 span（真机 text = "赵怡 和智传信 招聘者"）。
 * 分不出来才退回拆文本。
 */
function readRecruiter(panel) {
  let name = ''
  let company = ''
  let guess = false
  const box = panel ? panel.querySelector('.base-info') || panel.querySelector('.user-info') : null
  if (box) {
    const title = textOf(box.querySelector('.base-title'))
    let segs = []
    try {
      segs = [...box.querySelectorAll('span')].map((s) => textOf(s)).filter(Boolean)
    } catch (_) {
      segs = []
    }
    const rest = []
    for (const s of segs) {
      if (title && s === title) continue
      if (s.length <= 12 && ROLE_RE.test(s)) continue
      if (rest.includes(s)) continue // 父 span 会把子 span 的文本再报一遍
      rest.push(s)
    }
    if (rest.length >= 2) {
      name = rest[0]
      company = rest[1]
    } else if (rest.length === 1) {
      const sp = splitNameCompany(rest[0])
      name = sp.name
      company = sp.company
      guess = sp.guess
    }
  }
  return { name, company, guess }
}

/**
 * BOSS 聊天页：逐条点开会话，把「岗位名 / 薪资 / 城市 / 已读 / 对方是否回过话」采下来。
 *
 * 为什么必须点开：左栏 `.friend-content` 的 li 上**没有任何 id / data-\***（真机实测 attrs 全空），
 * 岗位名只在右侧对话区 → 「只读列表就采」这条路是堵死的。
 *
 * ⚠️ 副作用：点开会话会把对方发来的未读消息标成已读（HR 那边显示「已读」）。
 * 默认 scope='interactive' 只点「有互动」的：我方最后一条已被读（read=true），
 * 或最后一条是对方发的（read=null）。「我发了但对方还没看」的点了纯浪费。
 *
 * ⚠️ 拿不到 jobId（「查看职位」是 button 不是 a），后端只能按「公司 + 岗位名」匹配。
 */
async function collectChatDetails(opts = {}) {
  const scope = opts.scope || 'interactive' // interactive | all
  const maxRows = Math.min(Number(opts.max) || 30, 40)
  const stepMs = Math.max(Number(opts.stepMs) || 700, 300)
  // 点开会话后等右栏换内容的上限。真机一个来回几百毫秒，给 2.5 秒很宽；
  // 可调是为了单测能把它压到几百毫秒（否则「点了没反应」那条用例要等 5 秒）。
  const waitMs = Math.max(Number(opts.waitMs) || 2500, 200)
  const platform = detectPlatform()

  let contents = []
  try {
    contents = [...document.querySelectorAll('.friend-content')]
  } catch (_) {
    contents = []
  }

  const debug = {
    platform,
    scope,
    rowsTotal: contents.length,
    picked: 0,
    opened: 0,
    reused: 0, // 本来就开着、直接读的条数（不算进 opened 的「点开成功」）
    relocated: 0, // 左栏节点被重渲染换掉、按文本指纹重新找到的条数
    failed: [],
    noCard: [],
    duplicate: 0,
    notes: [],
  }
  if (!contents.length) {
    return {
      items: [],
      debug: { ...debug, notes: ['没找到左侧会话列表（.friend-content）—— 这一页可能不是 BOSS 聊天页'] },
    }
  }

  // 先把左栏读全：read 三态取自**点开前**的行内图标。
  // 点开会把对方消息标成已读，但左栏那个图标显示的是「我方最后一条」，理论上不受影响；
  // 保险起见还是在点击前一次性读掉，后面不再回头读。
  const rows = contents.slice(0, maxRows).map((el, i) => {
    const li = (el.closest && el.closest('li')) || el.parentElement
    let icon = null
    try {
      icon = el.querySelector('[class*="status-read"], [class*="status-delivery"]')
    } catch (_) {
      icon = null
    }
    const cls = icon ? String(icon.className || '') : ''
    return {
      i,
      el,
      li,
      read: /status-read/.test(cls) ? true : /status-delivery/.test(cls) ? false : null,
      lines: linesOf(el).map((s) => s.slice(0, 40)),
    }
  })

  const picked = rows.filter((r) => (scope === 'all' ? true : r.read === true || r.read === null))
  debug.picked = picked.length
  debug.notes.push(
    scope === 'all'
      ? `点了全部 ${picked.length} 条会话`
      : `只点「已读 / 对方最后发言」的 ${picked.length} 条（共 ${rows.length} 条）`
  )

  const items = []
  const seen = new Set()

  for (const r of picked) {
    let panel = null
    // 节点可能已经被列表重渲染换掉了（见 relocateRow 的说明）。
    // `r.el.isConnected === false` 才动手：stub 环境里这个属性是 undefined，不能当 false 处理。
    if (r.el && r.el.isConnected === false) {
      const fresh = relocateRow(r)
      if (fresh) {
        r.el = fresh
        r.li = (fresh.closest && fresh.closest('li')) || fresh.parentElement
        debug.relocated += 1
      }
    }
    // 已经开着的那条不用点（点了内容也不会变，会被误判成「点开没反应」）
    const already = activeOf(r.el, r.li) ? findChatPanel() : null
    if (already && readOpenChat(already).jobTitle) {
      panel = already
      debug.reused = (debug.reused || 0) + 1
    } else {
      const before = chatPanelKey(findChatPanel())
      clickEl(r.el)
      panel = await waitPanelChange(before, waitMs)
      if (!panel && r.li) {
        // 第二次尝试：直接点 li（有的站点把事件绑在 li 上而不是内容块）
        clickEl(r.li)
        panel = await waitPanelChange(before, waitMs)
      }
    }
    const label = r.lines[1] || r.lines[0] || `第 ${r.i + 1} 行`
    if (!panel) {
      // 兜底：指纹没变 ≠ 点失败了 —— 也可能是「本来就开着，只是 active 类名认不出来」。
      // 判定必须严：右栏读到的**招聘者名和公司名都要在这行的文本里出现**。
      // 少一个条件都可能把上一条会话的岗位名记到这条头上（那比漏一条严重得多）。
      const cur = findChatPanel()
      const w = cur ? readRecruiter(cur) : { name: '', company: '' }
      const rowTxt = rowTextOf(r.el, r.lines)
      const sameWho =
        !!w.name && !!w.company && rowTxt.includes(w.name.replace(/\s+/g, '')) && rowTxt.includes(w.company.replace(/\s+/g, ''))
      if (cur && sameWho && readOpenChat(cur).jobTitle) {
        panel = cur
        debug.reused += 1
        debug.notes.push(`${label}：点了没换内容，但右栏招聘者/公司都对得上 → 按「本来就开着」读`)
      }
    }
    if (!panel) {
      // ⚠️ 点开没换成新内容时**必须跳过**，否则会把上一条会话的岗位名记到这条头上
      debug.failed.push(`${label}（点了没换内容）`)
      continue
    }
    debug.opened++
    await sleepMs(150) // 岗位卡/消息列表可能比容器晚一帧渲染

    const chat = readOpenChat(panel)
    const who = readRecruiter(panel)
    if (!chat.jobTitle) {
      debug.noCard.push(`${who.company || label}（会话里没有岗位卡）`)
      continue
    }

    const key = `${who.company}|${chat.jobTitle}`
    if (seen.has(key)) {
      debug.duplicate++
      continue
    }
    seen.add(key)

    items.push({
      platform,
      company: who.company,
      jobTitle: chat.jobTitle,
      jobId: '', // 聊天页拿不到，后端按「公司 + 岗位名」匹配
      city: chat.city,
      salary: chat.salary,
      read: r.read === true,
      // readRaw 是**三态**，read 只是给后端用的布尔。
      // 以前预览拿 read 渲染，于是「没有图标」被显示成「未读」——
      // 而这批数据里根本没有「对方没看我消息」这条信息（左栏图标说的是「我方最后一条」），
      // 「未读 · 对方最后发言」这种自相矛盾的标签就是这么来的。
      readRaw: r.read === true ? '已读' : r.read === false ? '未读' : '',
      readState: r.read === true ? 'read' : r.read === false ? 'delivered' : 'none',
      replied: chat.lastFrom === 'other',
      // 我主动放弃（最后一条是我发的「不太适合我」之类）。不动 stage，后端单独记 withdrawnAt。
      withdrawn: chat.withdrawn,
      source: 'chat',
      // 公司名是拆文本猜出来的 → 预览里必须标出来，让用户能核对
      companyGuess: who.guess,
      lastFrom: chat.lastFrom,
      lastText: chat.lastText,
      msgCount: chat.msgCount,
      firstFrom: chat.firstFrom,
      // 0 = 这条会话里我一句话都没说过 → 是 HR 主动找我，不是我投的
      myMsgCount: chat.myMsgCount,
      chatAt: r.lines[0] || '',
    })
    await sleepMs(stepMs)
  }

  if (debug.failed.length) debug.notes.push(`${debug.failed.length} 条点开没反应，已跳过`)
  if (debug.relocated) debug.notes.push(`${debug.relocated} 条左栏被重渲染，按文本重定位后点开的`)
  if (debug.reused) debug.notes.push(`${debug.reused} 条本来就开着，直接读了没再点`)
  if (debug.noCard.length) debug.notes.push(`${debug.noCard.length} 条会话里没有岗位卡`)
  if (debug.duplicate) debug.notes.push(`${debug.duplicate} 条公司+岗位重复，已去重`)
  debug.items = items.length

  return { items, debug }
}

/**
 * iframe 概览：BOSS 有些页面把列表塞进同源 iframe（真机 inspect 报 `iframes: 3`）。
 * 如果会话行在 iframe 里，主文档怎么扫都扫不到 —— 得先确认这件事。
 */
function probeFrames() {
  let list = []
  try {
    list = [...document.querySelectorAll('iframe')]
  } catch (_) {
    return { count: 0, note: '读不到 iframe 列表' }
  }
  return {
    count: list.length,
    note: '同源 iframe 能读到内部结构；crossOrigin 的读不到（会标 accessible:false）。会话列表若在 iframe 里，采集器也要进去扫。',
    list: list.slice(0, 8).map((f, i) => {
      let doc = null
      try {
        doc = f.contentDocument || (f.contentWindow && f.contentWindow.document) || null
      } catch (_) {
        doc = null
      }
      let divs = 0
      let textLen = 0
      if (doc && doc.body) {
        try {
          divs = doc.querySelectorAll('div').length
          textLen = String(doc.body.innerText || '').replace(/\s+/g, ' ').length
        } catch (_) {
          /* 读不到就算了 */
        }
      }
      return {
        i,
        src: String(f.getAttribute('src') || '(no src)').slice(0, 70),
        accessible: !!doc,
        divs,
        textLen,
      }
    }),
  }
}

/**
 * 信号普查：页面上到底用什么表示「已读 / 未读 / 未读条数」。
 *
 * 为什么要单独做：BOSS 聊天页的「已读」是**图标 class**（`i.message-status.status-read`），
 * 页面上根本没有「已读」这两个字 —— 按文本找阶段词永远 0 命中（2026-11-05 真机探测确认）。
 * 采集器得改成读 class，但在改之前必须先把「哪个 class 是哪个状态、各有多少个」数清楚，
 * 否则改完还是猜。
 */
function probeSignals() {
  const probes = [
    ['对话已读（我方消息被读）', 'i[class*="status-read"], [class*="status-read"]'],
    ['已送达未读', '[class*="status-delivery"]'],
    ['未读/角标', '[class*="unread"], [class*="badge"], [class*="red-dot"]'],
    ['会话项候选', '[class*="chat-user"], [class*="chat-item"], [class*="conversation"], [class*="session"]'],
    ['岗位详情链接', 'a[href*="job_detail"]'],
    ['新消息提示', '[class*="new-message"], [class*="message-tip"]'],
  ]
  return probes.map(([name, sel]) => {
    let els = []
    try {
      els = [...document.querySelectorAll(sel)]
    } catch (_) {
      els = []
    }
    const first = els[0]
    return {
      name,
      sel,
      count: els.length,
      sample: first
        ? {
            tag: String(first.tagName || ''),
            cls: String(first.className || '').slice(0, 70),
            text: String(first.innerText || '')
              .replace(/\s+/g, ' ')
              .slice(0, 50),
          }
        : null,
    }
  })
}

/**
 * 列表页卡片探测：确认「一张卡的边界锁得准不准」。
 *
 * 为什么这件事比看起来重要：
 *   采集器靠 `rowOfLink`（向上找到「只装了自己一个岗位链接」的最大容器）定位一行。
 *   在搜索结果页，每张岗位卡同样满足这个条件 —— 所以同一套定位能复用；
 *   但一旦锁大了（把整个列表区当一张卡），筛选就会拿**所有岗位混在一起的文本**
 *   去判城市和方向：命中外地城市 → 整批跳过，或方向被别的岗位带跑。
 *   这种错在页面上完全看不出来，只会表现为「怎么一家都没投」。
 *
 * 判据：不同岗位链接锁到同一个容器 = 锁错了。`sharedRows` 非空就是警报。
 */
function probeListing() {
  const links = [...document.querySelectorAll('a[href]')].filter(isJobLink)
  if (links.length < 2) return null

  const F = window.JH_FILTERS
  const allCities = F ? F.PROVINCES.flatMap((p) => p.cities) : []
  const buckets = new Map() // 容器元素 → 落在它上面的 jobId
  const cards = []

  for (const a of links.slice(0, 40)) {
    const href = a.getAttribute('href') || ''
    const jobId = jobIdOfHref(href)
    const row = rowOfLink(a)
    if (!row) continue
    if (!buckets.has(row)) buckets.set(row, [])
    buckets.get(row).push(jobId || '(无id)')

    const text = (row.innerText || '').trim()
    const btns = [...row.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
    cards.push({
      jobId,
      rowTag: row.tagName + (row.className ? '.' + String(row.className).split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''),
      lines: linesOf(row).slice(0, 6),
      textLen: text.length,
      hasChatBtn: /立即沟通|立即打招呼|继续沟通/.test(btns.join('|')),
      buttons: [...new Set(btns)].slice(0, 5),
      // 筛选就是吃这些：城市命中几个、天/周与月数能不能读出来。
      // 读不到 = 这两项门槛在列表页等于没生效（不会误杀，但也不会拦）。
      cities: F ? F.detectCity(text, allCities).slice(0, 3) : [],
      // 真正决定城市门槛的那个值：位置最靠前的城市。
      // city 为空 = 这张卡的文本里根本没有城市 → 城市筛选在这张卡上必然放行。
      city: F && F.firstCity ? F.firstCity(text) : '',
      meta: F ? F.detectMeta(text) : null,
    })
  }

  const sharedRows = [...buckets.values()].filter((ids) => ids.length > 1)
  return {
    links: links.length,
    uniqueIds: new Set(links.map((a) => jobIdOfHref(a.getAttribute('href'))).filter(Boolean)).size,
    rowCount: buckets.size,
    // 空数组 = 每张卡各自锁到独立容器（正确）；有内容 = 多张卡挤在一个容器里（锁大了）
    sharedRows,
    cards: cards.slice(0, 8),
    note: sharedRows.length
      ? '⚠️ 多个岗位链接锁到了同一个容器 → 卡片边界锁大了，筛选会拿混在一起的文本判断，必须先修 rowOfLink'
      : '每张卡各自独立，卡片边界正确',
  }
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

/**
 * 按钮是不是禁用态。
 * Element UI 的「第一页」只给 prev 加 `is-disabled` 类，**不一定设 disabled 属性** ——
 * 只看 `b.disabled` 会把它当可点，点一下没反应，于是误报「回不到第 1 页」。
 */
function isDisabledBtn(b) {
  if (!b) return true
  if (b.disabled) return true
  if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return true
  if (b.hasAttribute && b.hasAttribute('disabled')) return true
  const cls = String((b.className && b.className.baseVal) || b.className || '')
  return /(^|\s)(is-disabled|disabled)(\s|$)/.test(cls)
}

/**
 * 读当前页码。返回 null = 页面上读不到页码（自定义分页 / 只有前后按钮）。
 * 为什么要读页码：判「已经在第 1 页」比「猜 prev 能不能点」可靠得多。
 */
function currentPage() {
  const scope = pagerScope()
  const sels = [
    'ul.el-pager li.active',
    'ul.el-pager li.is-active',
    '.el-pager .number.active',
    '.el-pager .number.is-active',
    '.el-pagination li.active',
  ]
  const roots = scope === document ? [document] : [scope, document]
  for (const root of roots) {
    if (!root) continue
    for (const s of sels) {
      let el = null
      try {
        el = root.querySelector(s)
      } catch (_) {
        el = null
      }
      if (!el) continue
      const n = parseInt(String(el.textContent || '').trim(), 10)
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  return null
}

/** 找「下一页」按钮。标准 Element UI 分页是 <button class="btn-next">。 */
function nextBtn() {
  const scope = pagerScope()
  const cands = [
    ...scope.querySelectorAll('button.btn-next'),
    ...scope.querySelectorAll('.el-pagination .btn-next'),
  ]
  for (const b of cands) {
    if (isDisabledBtn(b)) continue
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
    if (isDisabledBtn(b)) continue
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
  // 页码可读时先信它：已经在第 1 页就直接收工，别去点那个「假可点」的 prev
  if (currentPage() === 1) return true
  for (let i = 0; i < maxSteps; i++) {
    const b = prevBtn()
    if (!b) return true // 没有可点的上一页 = 已经在第 1 页
    const prev = idsOf(candidateRows()).join('|')
    b.click()
    if (await waitForListChange(prev, 3000)) {
      if (currentPage() === 1) return true
      continue
    }
    // 点了没反应，两种可能：① 本来就在第 1 页（按钮只是样式禁用）；② 点到别的 pane 的分页。
    // 页码是唯一能区分两者的证据。
    if (currentPage() === 1) return true
    return false
  }
  return currentPage() === 1
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
 * 轮询等待：可见列表换成了**别的 jobId 集合**（含变成空），或行内文案出现目标阶段词。
 *
 * 为什么需要它（2026-11-03 真机事故）：
 *   `waitTabReady` 只确认「tab 头变成 active + loading 遮罩消失」，**不确认列表内容换了**。
 *   点 tab 后请求可能几百毫秒才回来，此时读到的还是上一个 tab 的列表。
 *   初筛 tab 只有 1 条，一旦读到「已投递」的 10 条，它的 jobId 集合就恰好等于基线 →
 *   被镜像守卫误判成「全量镜像」→ tab 名失效 → 那条初筛被记成 submitted，推进永远是 0。
 *
 * @param {string[]} beforeIds 切换前的可见行 jobId
 * @param {string} [stageKey]  目标阶段；行内文案命中它也算切换成功
 */
async function waitListReplaced(beforeIds, stageKey, timeoutMs = 3500) {
  const before = new Set(Array.isArray(beforeIds) ? beforeIds : [])
  const t0 = Date.now()
  let emptyStreak = 0
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250))
    const rows = candidateRows()
    if (!rows.length) {
      // 空列表也是「切过去了」（该阶段确实没有投递），但要连续两次确认，防加载中闪空
      emptyStreak++
      if (emptyStreak >= 2) return true
      continue
    }
    emptyStreak = 0
    const ids = idsOf(rows)
    const same = ids.length === before.size && ids.every((id) => before.has(id))
    if (!same) return true
    // 集合雷同也可能内容真换了（不同 tab 恰好同一批岗位）→ 用行内文案兜底
    if (stageKey && rows.some((r) => stageOfText(r.lines.join(' ')) === stageKey)) return true
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

  /**
   * 切到指定 tab，并确认**列表真的换成了这个阶段的数据**。
   * @returns {Promise<'ok'|'uncertain'>} uncertain = 点了但列表没刷新，读到的可能是上一个 tab
   */
  async function switchToTab(t) {
    const target = stageOfTabName(t.name)
    const stageKey = target ? target.key : null
    // 已经是 active 且行内文案对得上 → 不用动
    if (t.head.classList.contains('is-active') && stageKey) {
      const rows = candidateRows()
      if (!rows.length || rows.some((r) => stageOfText(r.lines.join(' ')) === stageKey)) return 'ok'
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = idsOf(candidateRows())
      t.head.click()
      const ready = await waitTabReady(t.name)
      if (ready && (await waitListReplaced(before, stageKey))) {
        // 切换瞬间旧 pane 可能还没完成 display 切换，给一帧缓冲再读
        await new Promise((r) => setTimeout(r, 250))
        return 'ok'
      }
    }
    return 'uncertain'
  }

  // ---- 阶段 A：逐个点开 tab，**只读第 1 页**，拿 jobId 集合 ----
  // 这一步故意不翻页：7 个 tab 若是同一份全量镜像，逐个翻页就是把同一份数据读 7 遍
  // （7 × N 页 × 最多 8 秒等刷新），白等一分钟，还容易在某个 tab 上卡住。
  debug.phase = 'probe'
  const buckets = []
  for (const t of tabs) {
    const tb = {
      name: t.name, stage: t.stage, pages: 0, rows: 0, ids: [],
      note: '', mirrored: false, paged: false, confirmed: false, skipped: false,
    }
    debug.tabs.push(tb)

    const isCur = initialKey && initialKey === t.stage && t.head.classList.contains('is-active')
    if (isCur) {
      // 用户本来就停在这个 tab，可见列表按定义就是它的数据
      tb.confirmed = true
    } else if ((await switchToTab(t)) !== 'ok') {
      // ⚠️ 切换没确认成功时**必须跳过**：此时页面上还是上一个 tab 的列表，
      // 直接采会把那些投递错标成本阶段的记录 —— 错的阶段比漏采一条严重得多。
      // 注：这一档漏采了，note 里会写明，点第二次通常就能采到。
      tb.skipped = true
      tb.note = '切到本阶段后列表没刷新（读到的可能是上个 tab 的数据），已跳过'
      continue
    } else {
      tb.confirmed = true
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
    b.tb.mirrored = resolveMirror(b.tb, baseTb)
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

    if ((await switchToTab(b.tab)) !== 'ok') {
      b.tb.note = (b.tb.note ? b.tb.note + '；' : '') + '翻页前切回该 tab 未确认，只保留第 1 页'
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
  debug.uncertain = debug.tabs.filter((t) => t.skipped).length
  if (debug.uncertain) {
    debug.notes.push(
      `${debug.uncertain} 个 tab 没能确认列表已切换，已跳过（避免错标阶段）；再点一次通常能补上`
    )
  }
  debug.phase = 'done'
  return { items: merged.items, debug }
}

// content.js 通过 window.__jhCollector 调用
window.__jhCollector = {
  collectFromPage,
  collectAllPages,
  collectAllTabs,
  probePage,
  probeListing,
  probeLayout,
  probeContainers,
  probeFrames,
  probeChatList,
  probeChatPanel,
  probePositionCard,
  probeMessageRows,
  probeCompanyScope,
  findCompanyName,
  namesIn,
  looksLikeCompany,
  findChatPanel,
  chatPanelKey,
  readOpenChat,
  readRecruiter,
  splitNameCompany,
  collectChatDetails,
  localRowGroups,
  collectJobHints,
  looksLikeChatPanel,
  shortLabel,
  probeSignals,
  // 纯函数也导出：单测与日后排查直接调，不用再复制一份规则
  parseRowLines,
  rowOfLink,
  jobIdOfHref,
  stageOfText,
  stageOfTabName,
  mergeEntries,
  pickBaseTab,
  isMirrorOfBase,
  resolveMirror,
  isDisabledBtn,
  currentPage,
  sameIdSet,
  checkPageFresh,
  nextKeywordIndex,
  emptyPageReason,
  searchScopeOf,
  stageWordStats,
  splitCompanyCity,
  rankBlockGroups,
  looksLikeRow,
  isPureTagLine,
  firstTitleLine,
  looksWithdrawn,
  STAGE_WORDS,
}
