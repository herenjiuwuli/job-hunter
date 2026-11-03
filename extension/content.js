// 投递执行层（content script）：平台检测 → 填打招呼语 → 投递 → 回写
// 安全策略：随机间隔、每日额度、验证码/风控即停；默认「半自动」（只填不点，人工确认投递）
//
// ⚠️ 选择器是启发式的，实习僧/BOSS 真实 DOM 结构需真机校准：
//    在投递页点弹窗里的「探测页面结构」，把结果贴给 AI 即可锁定精确选择器。

const BACKEND_DEFAULT = 'http://localhost:3100'

/**
 * 后端地址与登录 token 都从 chrome.storage.local 读（在 popup 的「记录 → 后端连接」里配）。
 *
 * 为什么要 token：后端加了多用户隔离后，所有 /api 都要求登录，
 * 不带 token 一律 401。以前写死地址 + 裸请求，现在必须跟着主人自己的账号走。
 * 读不到就回退默认值，不让配置缺失把扩展整体搞崩。
 */
async function backendBase() {
  try {
    const { jhBackend } = await chrome.storage.local.get('jhBackend')
    return String(jhBackend || BACKEND_DEFAULT).replace(/\/+$/, '')
  } catch {
    return BACKEND_DEFAULT
  }
}

async function authHeaders(extra = {}) {
  const h = { ...extra }
  try {
    const { jhToken } = await chrome.storage.local.get('jhToken')
    if (jhToken) h.Authorization = `Bearer ${jhToken}`
  } catch {
    /* 不在扩展环境里跑（比如单测、控制台粘贴）时忽略 */
  }
  return h
}

function platform() {
  const h = location.hostname
  if (h.includes('shixiseng')) return '实习僧'
  if (h.includes('zhipin')) return 'BOSS直聘'
  return '其他'
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function rand(min, max) { return min + Math.random() * (max - min) }

// 去掉孤立的 UTF-16 代理项。字符串被 errorCaught 截断后会留下半个 emoji，
// 浏览器把它渲染成 �（用户看到的就是「乱码/方框」）。这里只删孤立的，成对的 emoji 保留。
function safeText(s) {
  return String(s == null ? '' : s).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  )
}

// 按「字形」安全截断：String.slice 是按 UTF-16 代码单元切的，
// 切在 emoji 中间就会把代理对劈开 → 显示成 �（2026-10-30 实测岗位标题乱码就是这个）
function truncate(s, n) {
  const str = safeText(s)
  if (str.length <= n) return str
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' })
    const parts = Array.from(seg.segment(str), (x) => x.segment)
    return parts.length > n ? parts.slice(0, n).join('') + '…' : str
  } catch (_) {
    // 老浏览器兜底：按 code point 迭代，至少不会劈开代理对
    const parts = [...str]
    return parts.length > n ? parts.slice(0, n).join('') + '…' : str
  }
}

// —— DOM 启发式探测（待校准点） ——
function findGreetingBox() {
  return (
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]') ||
    null
  )
}

function findApplyButton() {
  // 0) 实习僧：投递按钮是 <div class="btn-box resume_apply ...">，优先按类名命中
  const sxBtn = document.querySelector('[class*="resume_apply"]')
  if (sxBtn) return sxBtn
  // 1) 通用：按文本匹配
  const texts = ['立即投递', '立即申请', '投递简历', '申请职位', '立即沟通', '立即打招呼', '发消息', '发送', '投递', '沟通', '投个简历']
  const els = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
  for (const t of texts) {
    const hit = els.find((b) => (b.innerText || '').trim() === t)
    if (hit) return hit
  }
  for (const t of texts) {
    const hit = els.find((b) => (b.innerText || '').trim().includes(t))
    if (hit) return hit
  }
  return null
}

// 实习僧投递弹窗里的「确认投递」按钮
// 真实结构：<div class="btn">确认投递</div>（不是 button，必须直接点 div）
function findConfirmButton() {
  const texts = ['确认投递', '确认申请', '确定投递']
  const selectors = 'button, a, [role="button"], [class*="btn"], div, span'
  // 可见弹窗（含遮罩嵌套），后出现的通常在上层，倒序优先
  const dialogs = [...document.querySelectorAll('.el-dialog, [class*="dialog"], [class*="modal"]')]
    .filter((el) => {
      const s = getComputedStyle(el)
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0
    })
    .reverse()
  const scopes = [...dialogs, document.body]

  for (const scope of scopes) {
    const els = [...scope.querySelectorAll(selectors)]
    for (const t of texts) {
      const matches = els.filter((el) => (el.innerText || '').trim() === t)
      if (!matches.length) continue
      // 优先叶子节点（最深、最精确），否则退回第一个
      const hit = matches.find((el) => el.children.length === 0) || matches[0]
      // 若是外层容器，尝试向上找真正的 button
      let node = hit
      for (let i = 0; i < 3 && node; i++) {
        if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') return node
        node = node.parentElement
      }
      return hit
    }
  }
  return null
}

// 当前页的岗位 id（实习僧 inn_xxx / BOSS job_detail/xxx.html），用于本地账本去重
// 当前页岗位 id。统一走 jobIdOf，避免两套实现漂移
// （之前这里支持 BOSS、jobIdOf 只认实习僧，导致 BOSS 批量与账本全失效）
function currentJobId() {
  const fromUrl = jobIdOf(location.href)
  if (fromUrl) return fromUrl
  // BOSS 列表页是「左侧列表 + 右侧详情」布局，URL 里根本没有岗位 id（实探测确认）。
  // 这时只能去问「被选中的那张卡片」，从它的 job_detail 链接里取。
  const SEL = [
    '[class*="active"] a[href*="job_detail"]',
    '[class*="selected"] a[href*="job_detail"]',
    '[class*="current"] a[href*="job_detail"]',
    '[class*="hover"] a[href*="job_detail"]',
  ]
  for (const s of SEL) {
    const a = [...document.querySelectorAll(s)].find(isRendered)
    if (a) {
      const id = jobIdOf(a.href)
      if (id) return id
    }
  }
  return ''
}

function formatWhen(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 写本地账本（失败不阻断投递流程，只警告）
async function markAppliedLocal(item) {
  try {
    return await chrome.runtime.sendMessage({ action: 'markApplied', item })
  } catch (e) {
    console.warn('[job-hunter] 记账失败：', e.message)
    return null
  }
}

// 实习僧：判断这家是不是已经投过（按钮会变成「已投递」/「继续沟通」，再点不会弹窗）
function detectSxAppliedState() {
  // 详情页可能同时存在多个 resume_apply（底部相似职位卡片），优先取可见的那个
  const sxBtns = [...document.querySelectorAll('[class*="resume_apply"]')]
  const sxBtn = sxBtns.find(isElementVisible) || sxBtns[0]
  const txt = sxBtn ? (sxBtn.innerText || '').trim() : ''
  const appliedTexts = ['已投递', '已申请', '继续沟通', '已投递该职位']
  if (txt && appliedTexts.some((t) => txt.includes(t))) return { applied: true, btnText: txt }
  const body = (document.body && document.body.innerText) || ''
  if (/你已投递|已投递该职位|已投递过/.test(body)) return { applied: true, btnText: txt || '页面标记已投递' }
  return { applied: false, btnText: txt }
}

// 点完「投个简历」后轮询等弹窗，而不是死等一次 sleep（慢的时候 0.8~1.6s 不够）
async function waitForConfirm(maxMs = 6000, step = 400) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const b = findConfirmButton()
    if (b) return b
    await sleep(step)
  }
  return null
}

// 找不到按钮时给出页面上到底有啥，便于校准选择器（只取可见元素的前 10 个短文本）
function visibleButtonTexts(limit = 10) {
  const els = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
  const out = []
  for (const el of els) {
    const t = (el.innerText || '').trim().replace(/\s+/g, ' ')
    if (!t || t.length > 12) continue
    if (!isElementVisible(el)) continue
    if (out.includes(t)) continue
    out.push(t)
    if (out.length >= limit) break
  }
  return out
}

// 高亮目标元素（半自动：让人一眼看到该点哪儿）
function highlightElement(el) {
  try {
    el.style.outline = '3px solid #ff4d4f'
    el.style.outlineOffset = '2px'
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch (_) {
    /* 忽略 */
  }
}

function isElementVisible(el) {
  if (!el) return false
  const s = getComputedStyle(el)
  if (s.display === 'none' || s.visibility === 'hidden') return false
  // 很多站点用 opacity:0 或把容器移到视口外（-9999px）来藏验证码组件，
  // 这两种在 getBoundingClientRect 下仍有尺寸，会骗过「有宽高就算可见」的旧判断。
  if (Number(s.opacity) < 0.05) return false
  const r = el.getBoundingClientRect()
  if (r.width < 8 || r.height < 8) return false
  if (r.bottom < 0 || r.right < 0) return false
  if (r.top > window.innerHeight || r.left > window.innerWidth) return false
  return true
}

// 元素是否「真的被渲染出来」：沿祖先链排除 display:none / visibility:hidden / opacity:0。
// 注意与 isElementVisible 的区别：这里不要求在视口内（页面下方的正文也在视口外，但没被隐藏）。
function isRendered(el) {
  if (!el) return false
  let cur = el
  for (let i = 0; i < 12 && cur && cur !== document.documentElement; i++) {
    const s = getComputedStyle(cur)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false
    cur = cur.parentElement
  }
  return true
}

// body.innerText 会漏掉 display:none，但**会保留 opacity:0 / 移出视口元素里的文字**，
// 所以命中关键词后要再确认这句话确实在渲染出来的元素里，否则常驻的隐藏验证组件会一直被当真。
function textIsRendered(kw) {
  const els = document.querySelectorAll('div, span, p, label, li, a, section, aside, footer, button')
  for (let i = 0; i < els.length; i++) {
    const el = els[i]
    if (el.children.length > 6) continue
    const t = el.textContent || ''
    if (t.indexOf(kw) < 0) continue
    if (isRendered(el)) return true
  }
  return false
}

// 返回详细原因，便于区分「真风控」和「页面常驻文案 / 隐藏 captcha 容器」误判
// 分档原因：旧版把 11 个词丢进整页 innerText 里 includes，像「今日沟通」「重新登录」
// 这类词在正常页面的侧栏、页脚、登录提示里常驻，第一家就被判死（2026-10-29 实测批量 1/10 停）。
const RISK_TEXT_STRONG = ['拖动滑块', '滑块验证', '访问受限', '账号异常', '操作过于频繁', '操作太频繁']
const RISK_TEXT_WEAK = ['安全验证', '完成验证', '请完成验证', '沟通上限', '今日沟通', '操作频繁', '重新登录', '验证码']

function textContext(body, kw) {
  const i = body.indexOf(kw)
  if (i < 0) return ''
  return body.slice(Math.max(0, i - 12), i + kw.length + 12).replace(/\s+/g, ' ').trim()
}

// 可见浮层（弹窗/遮罩）里的文本——弱关键词必须落在这里才算风控
function visibleLayerText() {
  const sels = [
    '[role="dialog"]',
    '.el-dialog',
    '.ant-modal',
    '[class*="modal"]',
    '[class*="dialog"]',
    '[class*="popup"]',
    '[class*="mask"]',
    '[class*="verify"]',
  ]
  const out = []
  document.querySelectorAll(sels.join(',')).forEach((el) => {
    if (!isElementVisible(el)) return
    const t = (el.innerText || '').trim()
    if (t) out.push(t)
  })
  return out.join('\n').slice(0, 3000)
}

function detectRisk() {
  const body = (document.body && document.body.innerText) || ''
  const layer = visibleLayerText()

  // 强关键词：整页命中 + 确认真的渲染出来（排除常驻的隐藏组件）
  const strongHits = RISK_TEXT_STRONG.filter((t) => body.includes(t) && textIsRendered(t))
  // 弱关键词：只在可见浮层里命中才算，避免侧栏「今日沟通」这类常驻文案误判
  const weakHits = RISK_TEXT_WEAK.filter((t) => layer && layer.includes(t))

  const captchaEls = [
    ...document.querySelectorAll('iframe[src*="captcha"], [class*="captcha"], [class*="geetest"], [id*="captcha"]'),
  ]
  const visibleCaptcha = captchaEls.filter(isElementVisible)

  const textHits = [...strongHits, ...weakHits]
  return {
    risk: textHits.length > 0 || visibleCaptcha.length > 0,
    textHits,
    strongHits,
    weakHits,
    // 带上命中词前后的上下文，误判时一眼能看出是页面文案还是真验证
    textSamples: textHits.slice(0, 3).map((kw) => `「${kw}」… ${textContext(body, kw)}`),
    captchaSel: visibleCaptcha.slice(0, 3).map((el) => `${el.tagName}.${String(el.className).slice(0, 50)}`),
    captchaTotal: captchaEls.length,
    layerLen: layer.length,
  }
}

// 把标题里混进来的薪资/标签行去掉。BOSS 的节点 innerText 常是
// 「商业分析师实习生\n200-250元/天」这种多行串，直接塞进账本会很难看。
function cleanLabel(s) {
  const first = String(s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)[0] || ''
  return first.replace(/\s*[\d.]+\s*[-~]\s*[\d.]+\s*[Kk元万千]*.*$/, '').trim()
}

function extractJobInfo() {
  const title = document.title || ''
  // 顺序按精确度排：BOSS 详情页 → 列表页右侧面板 → 通用
  // ⚠️ 裸的 .name 不能单独用：在 BOSS 上会命中别处的节点，把薪资也带进来
  const jobEl = document.querySelector(
    '.job-banner .name, .job-primary .name, .job-detail-box .name, .job-name, .job-title, .position-name, h1'
  )
  const companyEl = document.querySelector(
    '.job-banner .company-name, .company-info .company-name, [class*="company-name"], .company-name, .cname, .com-name'
  )
  return {
    company: cleanLabel(companyEl && companyEl.innerText) || '未知公司',
    jobTitle: cleanLabel(jobEl && jobEl.innerText) || title.split(/[-_—|｜]/)[0].trim() || '未知岗位',
  }
}

// BOSS 直聘活跃度检测：返回 'active' | 'inactive' | 'unknown'
// BOSS 会在 HR 头像/卡片上标注活跃状态，投「活跃」的回复率与账号安全都更好。
// ⚠️ 具体文字因版本而异，属启发式，真机校准后可按需增删关键词。
function detectBossActivity() {
  const body = (document.body && document.body.innerText) || ''
  const activeMarks = ['今日活跃', '刚刚活跃', '3日内活跃', '3天内活跃', '本周活跃', '近日活跃', '今日回复', '刚刚在线', '在线']
  const inactiveMarks = ['半年前活跃', '3个月前活跃', '一个月前活跃', '月内活跃', '本月活跃', '长期未活跃', '很久未活跃', '年前活跃', '不活跃']
  for (const m of activeMarks) if (body.includes(m)) return 'active'
  for (const m of inactiveMarks) if (body.includes(m)) return 'inactive'
  return 'unknown'
}

// ===== A 方案：按个人情况做硬门槛筛选 =====
async function getJobFilters() {
  const { filters } = await chrome.storage.local.get('filters')
  const base = (window.JH_FILTERS && window.JH_FILTERS.DEFAULT_FILTERS) || {}
  const f = { ...base, ...(filters || {}) }
  if (!Array.isArray(f.cities)) f.cities = []
  if (!Array.isArray(f.directions)) f.directions = []
  return f
}

// 命中哪些方向组
function matchedDirections(text) {
  const t = String(text || '').toLowerCase()
  const list = (window.JH_FILTERS && window.JH_FILTERS.DIRECTIONS) || []
  const ids = []
  for (const d of list) {
    if (d.keywords.some((k) => t.includes(String(k).toLowerCase()))) ids.push(d.id)
  }
  return ids
}

function dirLabel(id) {
  const list = (window.JH_FILTERS && window.JH_FILTERS.DIRECTIONS) || []
  const hit = list.find((d) => d.id === id)
  return hit ? hit.label : id
}

// JD 正文容器（找不到就退回 body 前 4000 字）
function jobBodyText() {
  const sels = [
    '.job_detail',
    '.job-detail',
    '.job-desc',
    '.intern-detail',
    '.detail-content',
    '.job-content',
    '.job_msg',
    '#job_detail',
  ]
  for (const s of sels) {
    const el = document.querySelector(s)
    if (el && (el.innerText || '').trim().length > 60) return el.innerText.trim()
  }
  return (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 4000)
}

/**
 * 硬门槛判断。返回 { blocked, reason, meta }
 * 规则：城市不符 / 每周天数不够 / 实习月数不够 / 方向不符 → 拦下（不消耗额度）
 */
function screenJob({ jobTitle, company, jdText, metaText }, f, allowUnknown = false) {
  if (!f || !f.enabled) return { blocked: false, reason: '', meta: {} }
  const F = window.JH_FILTERS
  if (!F) return { blocked: false, reason: '', meta: {} }

  const title = String(jobTitle || '')
  const metaSrc = String(metaText || '')

  // 1) 城市：在「已选城市」里找；找不到就看看是不是别的城市
  if (f.cities.length) {
    const hits = F.detectCity(metaSrc, f.cities)
    if (!hits.length) {
      const allCities = F.PROVINCES.flatMap((p) => p.cities)
      const other = F.detectCity(metaSrc, allCities)
      if (other.length) {
        return {
          blocked: true,
          reason: `城市不符（岗位在 ${[...new Set(other)].join('/')}，你只投 ${f.cities.join('/')}）`,
          meta: {},
        }
      }
      if (f.strictMeta && !allowUnknown) {
        return { blocked: true, reason: '读不到岗位城市（已开严格模式）', meta: {} }
      }
    }
  }

  // 2) 每周天数 / 实习月数
  const meta = F.detectMeta(metaSrc)
  if (meta.daysPerWeek && f.daysPerWeek && meta.daysPerWeek > f.daysPerWeek) {
    return {
      blocked: true,
      reason: `要求每周到岗 ${meta.daysPerWeek} 天，你最多 ${f.daysPerWeek} 天`,
      meta,
    }
  }
  if (meta.months && f.months && meta.months > f.months) {
    return {
      blocked: true,
      reason: `要求实习 ${meta.months} 个月，你最多 ${f.months} 个月`,
      meta,
    }
  }

  // 3) 方向：标题优先，标题看不出再看 JD 前 1500 字
  if (f.directions.length) {
    const inTitle = matchedDirections(title)
    const pool = inTitle.length ? inTitle : matchedDirections(String(jdText || '').slice(0, 1500))
    if (!pool.length) {
      return { blocked: true, reason: '方向无法识别（标题与 JD 都没命中你勾选的方向）', meta }
    }
    if (!pool.some((id) => f.directions.includes(id))) {
      return {
        blocked: true,
        reason: `方向不符（识别为「${pool.map(dirLabel).join('/')}」，你只投「${f.directions.map(dirLabel).join('/')}」）`,
        meta,
      }
    }
  }

  // 4) BOSS 专属：经验 / 学历门槛
  // 为什么单列一条：BOSS 卡片上**没有**「x天/周」「x个月」，上面两条对它形同虚设；
  // 但它明确写「经验不限 / 1-3年 / 3-5年」和「本科 / 硕士」，这两项才是 BOSS 上真正能筛的。
  // 实习僧卡片读不到这些词 → 不拦，对那条线零影响（宁可少拦，不可误杀）。
  if (typeof F.detectBossMeta === 'function') {
    const bm = F.detectBossMeta(metaSrc)
    if (f.maxExperience != null && bm.experienceYears != null && bm.experienceYears > f.maxExperience) {
      const mine = f.maxExperience === 0 ? '只投经验不限/在校' : `${f.maxExperience} 年以内`
      return { blocked: true, reason: `要求「${bm.experienceLabel}」经验（你${mine}）`, meta }
    }
    if (f.maxEduRank != null && bm.eduRank != null && bm.eduRank > f.maxEduRank) {
      const mine = F.EDU_LABELS ? F.EDU_LABELS[f.maxEduRank] : '本科'
      return { blocked: true, reason: `要求${bm.eduLabel}（你最高接受${mine}）`, meta }
    }
  }

  return { blocked: false, reason: '', meta }
}

// 投递前过滤：关键词黑名单 + BOSS 活跃度过滤（命中即跳过，不消耗额度）
async function applyFilters() {
  const { filterKeywords = '', bossActiveOnly = false } = await chrome.storage.local.get(['filterKeywords', 'bossActiveOnly'])
  const info = extractJobInfo()
  const haystack = `${info.company} ${info.jobTitle}`.toLowerCase()

  // 1. 关键词黑名单（逗号/换行分隔）
  const kws = String(filterKeywords).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  for (const k of kws) {
    if (k && haystack.includes(k.toLowerCase())) {
      return { blocked: true, reason: `命中黑名单关键词「${k}」，已跳过（不消耗额度）` }
    }
  }

  // 2. BOSS 活跃度过滤（仅 BOSS 平台生效）
  if (bossActiveOnly && platform() === 'BOSS直聘') {
    const act = detectBossActivity()
    if (act === 'inactive') {
      return { blocked: true, reason: '该岗位 HR 近期不活跃，已按「仅投活跃岗位」跳过（不消耗额度）' }
    }
  }

  // 3. A 方案：按个人情况（城市 / 出勤 / 时长 / 方向）做硬门槛筛选
  const f = await getJobFilters()
  const screen = screenJob(
    {
      jobTitle: info.jobTitle,
      company: info.company,
      jdText: jobBodyText(),
      metaText: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 1500),
    },
    f
  )
  if (screen.blocked) return { blocked: true, reason: `筛选跳过：${screen.reason}（不消耗额度）` }

  return { blocked: false }
}

// ===== B 方案：投前匹配打分（需网页端后端在跑；失败不阻断投递）=====
async function checkMatchScore(f, info) {
  if (!f || !f.minScore) return { blocked: false, note: '未启用' }
  const jd = jobBodyText()
  if (!jd || jd.length < 50) return { blocked: false, note: 'JD 太短，跳过打分' }
  try {
    const r = await fetch(`${await backendBase()}/api/match/jd`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        resumeId: f.resumeId || '',
        jdText: jd.slice(0, 6000),
        company: info.company,
        jobTitle: info.jobTitle,
      }),
    })
    if (!r.ok) return { blocked: false, note: `打分接口返回 ${r.status}` }
    const d = await r.json()
    const score = typeof d.score === 'number' ? d.score : null
    if (score == null) return { blocked: false, note: 'JD 无可比关键词' }
    if (score < f.minScore) {
      const hit = (d.matched || []).slice(0, 5).join('/') || '无'
      return {
        blocked: true,
        score,
        reason: `匹配分 ${score} < 门槛 ${f.minScore}（命中：${hit}）`,
      }
    }
    return { blocked: false, score, note: `匹配分 ${score}（阈值 ${f.minScore}）` }
  } catch (e) {
    return { blocked: false, note: `打分失败（后端未启动？）：${e.message}` }
  }
}

function fillGreeting(el, text) {
  if (!el) return
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return
  }
  // contenteditable：BOSS 聊天框是 React 受控组件，直接改 textContent 有时不认
  // （界面看着有字，一点发送却是空的）。先走浏览器原生插入，失败再退回赋值。
  try {
    el.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
    if (!document.execCommand('insertText', false, text)) throw new Error('execCommand 不可用')
  } catch (_) {
    el.textContent = text
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }))
}

/**
 * 把这条投递回写到后端。
 *
 * ⚠️ 走 background 转发，不在页面里直接 fetch：content script 的 fetch 受**页面 CSP** 管辖，
 * BOSS 的 connect-src 不允许 localhost，请求会被静默拦掉（2026-11-03 真机：三家全显示
 * 「已发送招呼语」、本地账本也有，后端一条记录都没有，因为下面只 console.warn，界面上看不见）。
 *
 * 返回值统一是 { ok, status, error }，调用方必须把它带进结果里 —— 回写失败是**用户该知道的事**，
 * 不是日志里的一句 warn。
 */
async function writeback(info, greeting, jobId) {
  const body = {
    company: info.company,
    jobTitle: info.jobTitle,
    platform: platform(),
    // jobId 必须带：采集进度时靠它精确对账。
    // 早期没传，导致本地 18 条投递全是 jobId 空，同步只能拿名字硬猜
    jobId: jobId || currentJobId() || '',
    greeting,
    status: '已投递',
    appliedAt: new Date().toISOString(),
  }

  // 优先走 background（不受页面 CSP 限制）
  try {
    const r = await chrome.runtime.sendMessage({ action: 'backendPost', path: '/api/applications', body })
    if (r && typeof r.ok === 'boolean') {
      if (r.ok) return { ok: true }
      // 401 = 没配 token / token 过期。本地账本照记，但网页端会有缺口，必须让人看得见
      if (r.status === 401) {
        return { ok: false, status: 401, error: '后端拒绝（401）：扩展里没配 token 或已过期' }
      }
      return { ok: false, status: r.status, error: r.error || `后端返回 ${r.status}` }
    }
  } catch {
    /* 不在扩展环境（比如控制台粘贴、单测）→ 落到下面的直连兜底 */
  }

  // 兜底：直连。CSP 宽松的站点（实习僧）走这条一直没问题
  try {
    const r = await fetch(`${await backendBase()}/api/applications`, {
      method: 'POST',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (r.ok) return { ok: true }
    if (r.status === 401) return { ok: false, status: 401, error: '后端拒绝（401）：扩展里没配 token 或已过期' }
    return { ok: false, status: r.status, error: `后端返回 ${r.status}` }
  } catch (e) {
    return { ok: false, status: 0, error: `连不上后端（${e.message}）` }
  }
}

/**
 * 发送成功但后端没写进去时，把这件事挂在结果消息上。
 * 用户只看得到这条消息，看不到 console —— 回写失败必须在界面上说出来，
 * 否则表现就是「我明明投了，漏斗里没有」，而且没有任何报错。
 */
function withBackendNote(message, wb) {
  if (!wb || wb.ok) return message
  return `${message}｜⚠️ 但没写进后端：${wb.error || '回写失败'}`
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 投递进度采集：collect = 按业务文案抓；probe = 原样吐结构给人工校准
  if (msg.action === 'collect' || msg.action === 'probe') {
    const c = window.__jhCollector
    if (!c) {
      sendResponse({ ok: false, error: '采集器脚本未加载，请重新加载扩展' })
      return
    }
    try {
      const data = msg.action === 'collect' ? c.collectFromPage() : c.probePage()
      sendResponse({ ok: true, data })
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message) })
    }
    return
  }

  // 自动采集：优先按分类 tab 分阶段采全（实习僧七档：已投递/被查看/初筛/笔试/面试/不合格/录用），
  // 不是 tab 页面（BOSS 对话列表、平台改版）时自动退回单视图翻页。
  // collectPages 保留成「只翻当前视图」的入口，排查用。
  if (msg.action === 'collectAll' || msg.action === 'collectPages') {
    const c = window.__jhCollector
    if (!c) {
      sendResponse({ ok: false, error: '采集器脚本未加载，请重新加载扩展' })
      return
    }
    // 异步（要切 tab、翻页、等刷新），返回 true 表示会异步调 sendResponse
    ;(async () => {
      try {
        const data =
          msg.action === 'collectPages'
            ? await c.collectAllPages({ maxPages: 30 })
            : await c.collectAllTabs({ maxPages: 30 })
        sendResponse({ ok: true, data })
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message) })
      }
    })()
    return true
  }

  if (msg.action === 'inspect') {
    const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')].map((el, i) => ({
      i,
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      placeholder: el.placeholder || '',
      editable: el.getAttribute('contenteditable'),
    }))

    // 可点击元素：不再只取前 40 个（会被导航/页脚占满而截断投递按钮）
    const KW = ['投递', '申请', '沟通', '打招呼', '发送', '简历', '完善']
    const clickable = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
      .map((el) => ({
        text: truncate((el.innerText || '').trim(), 30),
        cls: String(el.className).slice(0, 80),
        tag: el.tagName,
      }))
      .filter((x) => x.text)

    // 关键词命中的候选（最多 25 条）
    const hits = clickable
      .filter((x) => KW.some((k) => x.text.includes(k)))
      .slice(0, 25)
      .map((x, i) => ({ i, ...x }))

    // 兜底：任何标签，叶子节点文本恰好等于投递类文案
    const exactTexts = ['立即投递', '投递简历', '申请职位', '立即申请', '立即沟通', '立即打招呼', '一键投递', '完善简历']
    const exact = []
    document.querySelectorAll('div, span, button, a').forEach((el) => {
      const t = (el.innerText || '').trim()
      if (exactTexts.includes(t) && el.children.length === 0) {
        exact.push({ text: t, tag: el.tagName, cls: String(el.className).slice(0, 80) })
      }
    })

    // 可见弹窗/遮罩数量（遮挡会导致扫不到正文）
    const visibleDialogs = [...document.querySelectorAll('.el-dialog, .el-overlay, [class*="dialog"], [class*="modal"]')]
      .filter((el) => {
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetHeight > 0
      }).length

    // BOSS 专项：三个关键元素（沟通按钮 / 聊天输入框 / 发送按钮）是否命中、用的什么类名，
    // 一次探测就能看出选择器错在哪，不用反复试投。
    let bossProbe = null
    if (platform() === 'BOSS直聘') {
      const pick = (el) =>
        el
          ? {
              tag: el.tagName,
              id: el.id || '',
              cls: String(el.className || '').slice(0, 80),
              text: truncate((el.innerText || '').trim().replace(/\s+/g, ' '), 20),
            }
          : null
      bossProbe = {
        jobId: currentJobId(),
        info: extractJobInfo(),
        chatBtn: pick(findBossChatButton()),
        chatInput: pick(findBossChatInput()),
        sendBtn: pick(findBossSendButton()),
        applied: detectBossApplied(),
        activity: detectBossActivity(),
        // 聊天容器候选：看清 BOSS 实际用哪个类名装聊天面板
        panels: [...document.querySelectorAll('[class*="chat"], [class*="dialog"], [class*="im-"], [class*="message"]')]
          .filter(isRendered)
          .slice(0, 12)
          .map((el) => `${el.tagName}.${String(el.className || '').slice(0, 60)}`),
        // 所有可见可编辑元素：输入框找错时看这里
        editables: [...document.querySelectorAll('[contenteditable="true"], textarea, input')]
          .filter(isRendered)
          .slice(0, 12)
          .map((el) => `${el.tagName}#${el.id || '-'}.${String(el.className || '').slice(0, 50)}`),
        // 列表页没有 jobid 属性（实测 dataJobIds=0），只能靠「选中态卡片」定位当前岗位。
        // 这里把命中的卡片类名打出来，用来校准 currentJobId 的兜底选择器。
        activeCard: (() => {
          const cands = [
            ...document.querySelectorAll(
              '[class*="active"] a[href*="job_detail"], [class*="selected"] a[href*="job_detail"], [class*="current"] a[href*="job_detail"]'
            ),
          ]
          const hit = cands.find(isRendered)
          if (!hit) return null
          const card = hit.closest('[class*="job-card"]') || hit.parentElement
          return {
            id: jobIdOf(hit.href),
            link: hit.href,
            cardCls: String((card && card.className) || '').slice(0, 80),
          }
        })(),
      }
    }

    sendResponse({
      url: location.href,
      platform: platform(),
      boxes,
      totalClickable: clickable.length,
      hits,
      exact,
      iframes: document.querySelectorAll('iframe').length,
      visibleDialogs,
      bodyTextLen: ((document.body && document.body.innerText) || '').length,
      // 风控诊断：让你一眼看出是「真有验证码」还是「隐藏容器误判」
      risk: detectRisk(),
      boss: bossProbe,
      // 列表页专用：这批链接能不能被抓到（BOSS 新版若改成 div 绑点击就抓不到，需要换策略）
      jobLinks: (() => {
        const all = [...document.querySelectorAll('a[href*="job_detail"], a[href*="inn_"]')]
        return {
          count: all.length,
          dataJobIds: [...document.querySelectorAll('[data-jobid]')].length,
          samples: all.slice(0, 8).map((a) => ({
            href: String(a.href).slice(0, 90),
            cls: String(a.className || '').slice(0, 40),
            title: truncate(linkTitleOf(a), 24),
            id: jobIdOf(a.href),
          })),
        }
      })(),
    })
    return false
  }
  // 查当前岗位的投递状态：本地账本 + 页面显示，两个都给你看
  if (msg.action === 'appliedState') {
    ;(async () => {
      const jobId = currentJobId()
      const pf = platform()
      const local = jobId
        ? await chrome.runtime.sendMessage({ action: 'isApplied', platform: pf, jobId })
        : { applied: false }
      const pageState = pf === '实习僧' ? detectSxAppliedState() : { applied: false, btnText: '' }
      sendResponse({ ok: true, jobId, platform: pf, local, page: pageState })
    })()
    return true
  }
  // 手动标记当前岗位为「已投递」——页面不显示状态时，用它把账本补上，之后就不会重复投
  if (msg.action === 'markCurrentApplied') {
    ;(async () => {
      const jobId = currentJobId()
      if (!jobId) {
        sendResponse({ ok: false, error: '识别不到岗位 id，请先打开岗位详情页' })
        return
      }
      const info = extractJobInfo()
      const r = await markAppliedLocal({
        jobId,
        platform: platform(),
        title: info.jobTitle,
        company: info.company,
        url: location.href,
        verified: true,
        source: 'manual',
      })
      sendResponse({ ok: true, jobId, total: (r && r.total) || 0 })
    })()
    return true
  }
  if (msg.action === 'apply') {
    runApply(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  // ===== 批量投递 =====
  if (msg.action === 'batchStart') {
    startBatch(msg.limit, msg.force).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg.action === 'batchStop') {
    stopBatch().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg.action === 'batchStatus') {
    getBatch().then((b) => sendResponse({ ok: true, batch: b }))
    return true
  }
  // 卡住时手动推一把：直接跳到队列里当前该投的那家，并重置超时基准
  if (msg.action === 'batchJumpNext') {
    ;(async () => {
      const b = await getBatch()
      if (!b) {
        sendResponse({ ok: false, error: '没有批量任务记录' })
        return
      }
      const target = b.queue && b.queue[b.index]
      if (!target) {
        sendResponse({ ok: false, error: '队列已到末尾，没有下一家' })
        return
      }
      const idx = b.index
      const title = (b.titles && b.titles[idx]) || target
      // 先把状态写回去（重置 lastAt，避免刚跳过去就被「2 分钟超时」判停）
      await setBatch({ ...b, running: true, lastAt: new Date().toISOString(), stopReason: '' })
      sendResponse({ ok: true, url: target, title, index: idx + 1, total: b.total })
      // 先让响应回到 popup，再跳转
      setTimeout(() => {
        location.href = target
      }, 400)
    })()
    return true
  }
  if (msg.action === 'collectLinks') {
    collectJobLinks().then((r) =>
      sendResponse({ ok: true, count: r.links.length, blocked: r.blocked.length, sample: r.links.slice(0, 5) })
    )
    return true
  }
  return false
})

// 找出当前最上层、含「确认投递」的可见弹窗，作为补充信息的检查范围
function findSxDialog() {
  const dialogs = [...document.querySelectorAll('.el-dialog, [class*="dialog"], [class*="modal"]')].filter(isElementVisible)
  return dialogs.find((d) => (d.innerText || '').includes('确认投递')) || dialogs[0] || null
}

// 检查实习僧弹窗里的「请选择」下拉（到岗时间 / 实习时长 / 每周出勤）是否都填了
function checkSxExtras(confirmBtn) {
  const scope = findSxDialog() || (confirmBtn && confirmBtn.closest('.el-dialog')) || document.body
  const inputs = [...scope.querySelectorAll('input.el-input__inner, input[type="text"]')]
  const pending = inputs.filter((inp) => {
    const v = String(inp.value || '').trim()
    const ph = String(inp.placeholder || '')
    return !v && ph.includes('请选择')
  })
  return {
    visible: isElementVisible(scope),
    total: inputs.length,
    pending: pending.length,
    placeholders: pending.slice(0, 5).map((i) => i.placeholder),
  }
}

// 点击后的结果判定。返回结构化状态，因为「点了」不等于「投成功了」：
//   success = 明确看到成功提示（可信，入账为已确认）
//   pending = 弹窗还停着 → 多半缺必填/被拦下，算失败，不入账
//   unknown = 弹窗关了但没抓到提示（toast 消失很快）→ 按已投入账但标未确认
function detectSxResult() {
  const body = (document.body && document.body.innerText) || ''
  if (/投递成功|已投递成功|简历已投递|投递完成|投递已发送/.test(body)) {
    return { state: 'success', text: '页面提示投递成功' }
  }
  if (findConfirmButton()) return { state: 'pending', text: '弹窗仍在，可能缺少必填项或需要二次确认' }
  return { state: 'unknown', text: '弹窗已关闭但未抓到成功提示' }
}

// ===================== BOSS 直聘专用流程 =====================
// BOSS 没有「投递弹窗」。真实链路是：点「立即沟通」→ 打开聊天面板 → 填话术 → 点「发送」。
// 实习僧是「投个简历」→ 弹窗 → 「确认投递」。两条链完全不同，共用一套选择器必然失败
// （旧代码先找输入框，而 BOSS 的输入框要点了「立即沟通」才出现 → 永远报「未找到沟通输入框」）。
// ⚠️ 以下选择器为启发式，首次使用请先跑「探测页面结构」校准。

// 「立即沟通」按钮。注意已沟通过的岗位文案是「继续沟通」，不能当首次沟通点。
function findBossChatButton() {
  for (const s of ['.btn-startchat', '.op-btn-chat', '[class*="startchat"]']) {
    const el = document.querySelector(s)
    if (el && isRendered(el)) return el
  }
  const OK = /^(立即沟通|立即打招呼|马上沟通)$/
  const els = [...document.querySelectorAll('button, a, div[role="button"], span, div')]
  const leaf = els.find((e) => e.children.length === 0 && isRendered(e) && OK.test((e.innerText || '').trim()))
  if (!leaf) return null
  return leaf.closest('button, a, [role="button"], [class*="btn"], [class*="op-"]') || leaf
}

// 是否像「搜索框」——用来把页面顶部的搜索框从可编辑元素里剔掉
function looksLikeSearchBox(el) {
  if (!el) return true
  const ph = String(el.getAttribute('placeholder') || '')
  if (/搜索|search/i.test(ph)) return true
  const cls = String(el.className || '')
  if (/search/i.test(cls)) return true
  return false
}

// 聊天输入框。只在可见聊天面板里找，避免抓到页面别处的 contenteditable。
// BOSS 新版聊天组件用 zpchat- 前缀（实探测到 zpchat-push-notification-module__…），
// 所以面板候选里必须带上 [class*="zpchat"]，否则点开聊天也永远找不到输入框。
function findBossChatInput() {
  // 实测（2026-10-30 聊天页探测）：输入框就是 DIV#chat-input.chat-input（contenteditable），
  // 直接命中它最稳，别先绕一圈容器找。
  const direct = document.querySelector('#chat-input')
  if (direct && isRendered(direct)) return direct

  const IN = ['#chat-input', '.chat-input', '[class*="chat-input"]', '[contenteditable="true"]', 'textarea']
  const panels = [
    ...document.querySelectorAll(
      '.chat-panel, #chat-box, [class*="chat-panel"], [class*="chat-dialog"], [class*="dialog-container"], [class*="zpchat"]'
    ),
  ]
    .filter(isRendered)
    .reverse() // 后出现的通常在上层
  for (const p of panels) {
    for (const s of IN) {
      const el = [...p.querySelectorAll(s)].find((x) => isRendered(x) && !looksLikeSearchBox(x))
      if (el) return el
    }
  }
  for (const s of ['#chat-input', '.chat-input']) {
    const el = document.querySelector(s)
    if (el && isRendered(el)) return el
  }
  // 兜底：页面上任何可见的可编辑区（排除搜索框），取最后一个——最新弹出的那个
  const cands = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(
    (el) => isRendered(el) && !looksLikeSearchBox(el)
  )
  return cands.length ? cands[cands.length - 1] : null
}

function findBossSendButton() {
  const SEL = [
    // 实测：BUTTON.btn-v2.btn-sure-v2.btn-send，空输入时带 disabled 类
    '.btn-send',
    'button.btn-send',
    '[class*="btn-send"]',
    '.chat-op .btn-sure',
    '[class*="zpchat"] [class*="send"]',
    '[class*="chat-op"] [class*="sure"]',
  ]
  for (const s of SEL) {
    const el = [...document.querySelectorAll(s)].find(isRendered)
    if (el) return el
  }
  const OK = /^(发送|发送消息|发出去)$/
  const els = [...document.querySelectorAll('button, a, div[role="button"], span, div')]
  const leaf = els.find((e) => e.children.length === 0 && isRendered(e) && OK.test((e.innerText || '').trim()))
  if (!leaf) return null
  return leaf.closest('button, a, [role="button"], [class*="btn"]') || leaf
}

// 页面是否已经沟通过（BOSS 没有「已投递」概念，用的是「继续沟通」「已沟通」）
function detectBossApplied() {
  const btnText = (() => {
    const b = findBossChatButton()
    return b ? (b.innerText || '').trim() : ''
  })()
  if (/^(继续沟通|已沟通|已发送简历)$/.test(btnText)) return { applied: true, evidence: `按钮显示「${btnText}」` }
  const body = (document.body && document.body.innerText) || ''
  if (/已向对方发送过简历|已发送简历|已投递该职位/.test(body)) return { applied: true, evidence: '页面文案显示已发送简历' }
  return { applied: false, evidence: '' }
}

// 发送后的结果判定。BOSS 没有统一的成功 toast，最可靠的证据是
// 「聊天记录里出现了刚发出去的那句话」。
function detectBossSentResult(greeting) {
  const g = String(greeting || '').trim()
  if (g) {
    const panelText = [...document.querySelectorAll('[class*="chat"] [class*="item"], [class*="message"], [class*="msg"]')]
      .map((el) => (el.innerText || '').trim())
      .join('\n')
    const hay = panelText || ((document.body && document.body.innerText) || '')
    if (hay.includes(g)) return { state: 'success', text: '聊天记录里已出现刚发送的内容' }
  }
  const body = (document.body && document.body.innerText) || ''
  if (/发送成功/.test(body)) return { state: 'success', text: '页面提示发送成功' }
  if (/限流|发送太频繁|操作过于频繁/.test(body)) return { state: 'failed', text: '被限流' }
  return { state: 'unknown', text: '没抓到发送成功的证据（消息可能已发出，建议抽查看一眼）' }
}

// 轮询等待某个函数返回真值
async function waitForFn(fn, maxMs = 8000, step = 400) {
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(step)
  }
  return null
}

// ===================== BOSS 跨页接力 =====================
// 实测（2026-10-30）：点「立即沟通」**不是弹层，是整页跳转到聊天页**，且不会自动发出任何消息。
// 整页跳转会把当前 content script 的上下文直接销毁 —— 原来「点完 await 输入框」这套
// 在同页内等，永远等不到（表现为点了按钮就再没下文、批量卡在同一格）。
// 所以改成两段式：点击前把待办写进 storage，跳转后由新页面的脚本接管发送。
const PENDING_BOSS_KEY = 'pendingBoss'
const PENDING_BOSS_TTL = 300000 // 5 分钟没接上就当过期，避免旧待办误发到别人聊天框

async function setPendingBoss(p) {
  await chrome.storage.local.set({ [PENDING_BOSS_KEY]: p })
}
async function getPendingBoss() {
  const r = await chrome.storage.local.get(PENDING_BOSS_KEY)
  return r[PENDING_BOSS_KEY] || null
}
async function clearPendingBoss() {
  await chrome.storage.local.remove(PENDING_BOSS_KEY)
}

// 只在 BOSS 聊天页接管。聊天页 URL 不带 jobId（实测），所以对账不能靠 URL，
// 只能靠 pending 里存的 jobId / 标题这些元数据。
function isBossChatPage() {
  if (platform() !== 'BOSS直聘') return false
  const p = `${location.pathname}${location.search}`
  return /\/chat|\/im\/|talk/i.test(p)
}

// 归一化岗位/公司名做包含匹配：括号里的英文、空格、标点都去掉，
// 这样「数据产品实习生（Data Product Intern）」和「数据产品实习生」能对上。
function normJobText(s) {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000·\-—_/|｜,，.。:：]+/g, '')
    .toLowerCase()
}
function sameJobText(a, b) {
  const x = normJobText(a)
  const y = normJobText(b)
  if (!x || !y) return true // 有一边抓不到就别拦，宁可放过让人复核，也不要莫名全停
  return x.includes(y) || y.includes(x)
}

// 当前聊天对象的岗位名。实测聊天页有 DIV.chat-position-content 装岗位卡片。
function bossChatJobTitle() {
  const el = document.querySelector('.chat-position-content, [class*="position-content"], .chat-position')
  const t = el ? cleanLabel(el.innerText) : ''
  return t || extractJobInfo().jobTitle
}

// 会话说没自动打开时，按公司/岗位名去左侧联系人列表里点开一条。
// ⚠️ 纯启发式：点错也不致命，后面会用岗位名再校验一次，对不上就中止不发。
function openBossConversation(p) {
  const keys = [p.company, p.jobTitle]
    .map((s) => String(s || '').trim())
    .filter((s) => s && s !== '未知公司' && s !== '未知岗位')
  if (!keys.length) return false
  const roots = [
    ...document.querySelectorAll(
      '.chat-user, .chat-user-list, [class*="user-list"], [class*="chat-user"], [class*="conversation-list"]'
    ),
  ].filter(isRendered)
  for (const r of roots) {
    const items = [...r.querySelectorAll('li, [class*="item"], a')].filter(isRendered)
    const hit = items.find((el) => {
      const t = (el.innerText || '').replace(/\s+/g, ' ')
      return keys.some((k) => t.includes(k))
    })
    if (hit) {
      ;(hit.closest('li, a, [class*="item"]') || hit).click()
      return true
    }
  }
  return false
}

// 「发送」按钮在输入框为空时带 disabled 类（实测 class="btn-v2 btn-sure-v2 btn-send disabled"）。
// 这条比「找到按钮」更重要：填了话术但按钮还 disabled ＝ React 没收到输入，
// 这时候点下去什么都不会发生，最后误判成「已发送」是最糟的结果。
function isSendDisabled(el) {
  if (!el) return true
  if (el.disabled) return true
  const cls = String(el.className || '')
  return /\bdisabled\b/.test(cls) || el.getAttribute('aria-disabled') === 'true'
}

// 填话术 → 点发送 → 判定结果。单次投递与跨页接力共用，避免两处逻辑跑偏。
async function sendBossMessage(box, greeting) {
  if (greeting) fillGreeting(box, greeting)
  await sleep(rand(300, 800))

  let sendBtn = findBossSendButton()
  if (!sendBtn) {
    return { state: 'failed', text: `已填入招呼语，但没找到「发送」按钮。可见按钮：${visibleButtonTexts()}` }
  }

  // 仍然禁用 → 再补一次原生输入事件（有些版本只认 keydown/change），最多补两次
  for (let i = 0; i < 2 && isSendDisabled(sendBtn); i++) {
    try {
      box.dispatchEvent(new InputEvent('input', { bubbles: true, data: greeting, inputType: 'insertText' }))
      box.dispatchEvent(new Event('change', { bubbles: true }))
      box.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }))
    } catch (_) {
      /* 事件构造失败就算了，下一轮还会试 */
    }
    await sleep(900)
    sendBtn = findBossSendButton()
  }
  if (isSendDisabled(sendBtn)) {
    return {
      state: 'failed',
      text: '话术已写进输入框，但「发送」按钮仍是禁用态（页面没收到内容），已中止、未发送',
    }
  }

  await sleep(rand(1200, 2600))
  sendBtn.click()
  await sleep(rand(1200, 2200))
  return detectBossSentResult(greeting)
}

// BOSS 投递主流程
async function runBossApply(msg) {
  const greeting = (msg.greeting || '').trim()
  const info = extractJobInfo()
  const jobId = currentJobId()

  // 0) 本地账本 —— 唯一不依赖页面显示的判断
  if (jobId) {
    const local = await chrome.runtime.sendMessage({ action: 'isApplied', platform: 'BOSS直聘', jobId })
    if (local && local.applied) {
      const when = local.at ? `${formatWhen(local.at)} ` : ''
      return {
        ok: false,
        skipped: true,
        mode: 'local-applied',
        company: info.company,
        jobTitle: info.jobTitle,
        error: `本地记录显示 ${when}已投过${local.title ? `「${local.title}」` : ''}，已跳过`,
      }
    }
  }

  // 1) 页面说已沟通 → 补记账后跳过（下次不靠页面也能拦）
  const applied = detectBossApplied()
  if (applied.applied) {
    if (jobId) {
      await markAppliedLocal({
        jobId,
        platform: 'BOSS直聘',
        title: info.jobTitle,
        company: info.company,
        url: location.href,
        verified: true,
        source: 'page',
      })
    }
    return {
      ok: false,
      skipped: true,
      mode: 'already-applied',
      company: info.company,
      jobTitle: info.jobTitle,
      error: `该岗位${applied.evidence}，已跳过（已记入本地账本）`,
    }
  }

  // 2) 打开聊天：输入框没出现就先点「立即沟通」
  let box = findBossChatInput()
  if (!box) {
    const chatBtn = findBossChatButton()
    if (!chatBtn) {
      // fatal：这是「页面结构对不上」，不是这家岗位特殊。后面每一家都会一样，
      // 批量必须第 1 家就停，否则一路失败会白白消耗沟通额度、还把账号暴露在风控里。
      return {
        ok: false,
        fatal: true,
        error: `没找到「立即沟通」按钮，也没有聊天输入框。当前页可见按钮：${visibleButtonTexts()}`,
      }
    }
    if (!msg.autoClick) {
      highlightElement(chatBtn)
      return {
        ok: false,
        needManual: true,
        error: '已定位「立即沟通」并高亮，请手动点开聊天框后再点「执行投递」',
      }
    }
    // 先把待办落盘：真跳页时下面每一行都不会再执行，只能靠新页面 bootPendingBoss() 接力。
    // 弹层模式（没跳页）则在发送成功后清掉，不留残渣。
    const batchNow = await getBatch()
    await setPendingBoss({
      jobId,
      company: info.company,
      jobTitle: info.jobTitle,
      url: location.href,
      greeting,
      inBatch: !!(batchNow && batchNow.running),
      at: new Date().toISOString(),
      claimedAt: 0,
    })
    const startHref = location.href
    chatBtn.click()
    box = await waitForFn(findBossChatInput, 8000, 400)
    if (!box) {
      // SPA 内 pushState 跳转（文档没被销毁，脚本还活着）→ 保留待办、把这一家标成中继，
      // 后面由 bootPendingBoss 接着发。不能让批量把它记成失败。
      if (location.href !== startHref) {
        return { ok: true, jumped: true, mode: 'boss-jump', message: '已跳到聊天页，正在自动填话术发送…' }
      }
      await clearPendingBoss()
      // 走到这里＝页面没跳、也没弹出输入框。记下现场，方便下次校准选择器
      return {
        ok: false,
        error: `点了「立即沟通」但 8 秒内既没跳转也没出现聊天输入框（当前地址 ${truncate(location.href, 70)}）`,
      }
    }
  }

  // 3) 额度：聊天框真的打开了才扣（这一步之后才算真实消耗）
  const quota = await chrome.runtime.sendMessage({ action: 'checkAndIncrement', platform: platform() })
  if (quota.blocked) return { ok: false, error: `「${platform()}」今日额度已用完（${quota.used}/${quota.limit}），已自动停止` }

  // 4) 填话术
  if (greeting) fillGreeting(box, greeting)
  await sleep(rand(300, 800))

  // 5) 半自动：只填不发，高亮发送按钮让人自己点
  if (!msg.autoClick) {
    const sendBtn = findBossSendButton()
    highlightElement(sendBtn || box)
    return {
      ok: true,
      needManual: true,
      autoClicked: false,
      company: info.company,
      jobTitle: info.jobTitle,
      used: quota.used,
      limit: quota.limit,
      message: '已填入招呼语，请手动点「发送」',
      error: '话术已填好，但「自动提交」没勾 → 需要你自己点「发送」。想全自动就勾上那个选项再点执行',
    }
  }

  // 6) 自动发送
  const result = await sendBossMessage(box, greeting)
  // 原地发完了 → 清掉待办，别把它留给下一个页面误发到别人聊天框
  await clearPendingBoss()
  if (result.state === 'failed') {
    return { ok: false, company: info.company, jobTitle: info.jobTitle, error: result.text }
  }
  if (result.state !== 'failed' && jobId) {
    await markAppliedLocal({
      jobId,
      platform: 'BOSS直聘',
      title: info.jobTitle,
      company: info.company,
      url: location.href,
      verified: result.state === 'success',
      source: 'auto',
    })
  }
  const wbBoss = await writeback(info, greeting, jobId)

  return {
    ok: result.state !== 'failed',
    mode: 'boss-sent',
    autoClicked: true,
    verified: result.state === 'success',
    company: info.company,
    jobTitle: info.jobTitle,
    used: quota.used,
    limit: quota.limit,
    backendError: wbBoss && !wbBoss.ok ? wbBoss.error || '回写后端失败' : '',
    message: withBackendNote(
      result.state === 'success'
        ? `已发送招呼语（${result.text}）`
        : result.state === 'unknown'
          ? `已点「发送」，${result.text}`
          : `发送失败：${result.text}`,
      wbBoss
    ),
  }
}

async function runApply(msg) {
  const greeting = (msg.greeting || '').trim()
  // 实习僧是纯投简历、没有话术环节，所以不强制要求填打招呼语
  if (!greeting && platform() !== '实习僧') return { ok: false, error: '请先在弹窗填入打招呼语' }

  // 1. 风控/验证码检测（命中即停，不消耗额度）
  // msg.force=true：忽略「文本命中」（多半是页面常驻文案误判），但仍拦「可见验证码元素」——
  // 真出现滑块时强制模式也不该硬点下去，这是最后一道闸。
  const risk0 = detectRisk()
  const hasCaptcha = (risk0.captchaSel || []).length > 0
  const risk = msg.force ? { ...risk0, risk: hasCaptcha, skippedText: true } : risk0
  if (risk.risk) {
    const why = [
      !msg.force && risk.textHits.length
        ? `命中文本「${risk.textHits.join('、')}」${risk.textSamples && risk.textSamples[0] ? `，上下文：${risk.textSamples[0]}` : ''}`
        : '',
      risk.captchaSel.length ? `可见验证码元素 ${risk.captchaSel.join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('；')
    return {
      ok: false,
      error: `检测到风控提示，已停止（${why}）。如确认页面正常，可点「强制继续」跳过文本检测。`,
      risk: true,
      riskDetail: risk,
    }
  }

  // 2. 关键词黑名单 + BOSS 活跃度过滤（命中即跳过，不消耗额度）
  const filter = await applyFilters()
  if (filter.blocked) return { ok: false, error: filter.reason, filtered: true }

  // 2.5 B 方案：匹配分门槛（后端没跑或打分失败时自动放行，不阻断投递）
  const scoreFilter = await getJobFilters()
  const scoreCheck = await checkMatchScore(scoreFilter, extractJobInfo())
  if (scoreCheck.blocked) {
    return { ok: false, error: `匹配跳过：${scoreCheck.reason}（不消耗额度）`, filtered: true }
  }

  // 注：每日额度检查统一放到实习僧分支之后，避免同一次调用扣两次额度

  // 3.5 实习僧：没有话术环节，纯投简历 → 展开弹窗 + 高亮「确认投递」
  if (platform() === '实习僧') {
    const sxInfo = extractJobInfo()
    const jobId = currentJobId()

    // 0-A) 先查本地账本 —— 这是唯一不依赖页面显示的判断。
    //      页面可能还写着「投个简历」（UI 没刷新 / 换了简历版本），只有自己的记录不会骗人。
    if (jobId) {
      const local = await chrome.runtime.sendMessage({ action: 'isApplied', platform: '实习僧', jobId })
      if (local && local.applied) {
        const when = local.at ? `${formatWhen(local.at)} ` : ''
        const mark = local.verified === false ? '（当时未抓到成功提示，可能没投成）' : ''
        return {
          ok: false,
          skipped: true,
          mode: 'local-applied',
          company: sxInfo.company,
          jobTitle: sxInfo.jobTitle,
          error: `本地记录显示 ${when}已投过${local.title ? `「${local.title}」` : ''}${mark}，已跳过`,
        }
      }
    }

    // 0-B) 再看页面状态。页面说投过了 → 顺手补记账，下次不靠页面也能跳过。
    const appliedState = detectSxAppliedState()
    if (appliedState.applied) {
      if (jobId) {
        await markAppliedLocal({
          jobId,
          platform: '实习僧',
          title: sxInfo.jobTitle,
          company: sxInfo.company,
          url: location.href,
          verified: true,
          source: 'page',
        })
      }
      return {
        ok: false,
        skipped: true,
        mode: 'already-applied',
        company: sxInfo.company,
        jobTitle: sxInfo.jobTitle,
        error: `页面按钮已显示「${appliedState.btnText}」，说明投过了，已跳过（已记入本地账本）`,
      }
    }

    // 弹窗可能已经开着（用户手动点过），有就直接用，避免重复点击
    let confirmBtn = findConfirmButton()
    if (!confirmBtn) {
      const applyBtn = findApplyButton()
      if (!applyBtn) {
        return {
          ok: false,
          error: `未找到「投个简历」按钮。页面可见按钮：${visibleButtonTexts().join(' / ') || '(无)'}`,
        }
      }
      applyBtn.click()
      // 轮询等弹窗，最多 6 秒（固定 sleep 一次在慢加载时会误判成「弹窗未展开」）
      confirmBtn = await waitForConfirm(6000, 400)
    }
    if (!confirmBtn) {
      return {
        ok: false,
        error: `投递弹窗未展开或未找到「确认投递」（已等 6 秒）。页面可见按钮：${visibleButtonTexts().join(' / ') || '(无)'}`,
      }
    }

    const extras = checkSxExtras(confirmBtn)

    // 全自动前置检查：补充信息（到岗时间/实习时长/每周出勤）没填就不代提交——投出去收不回来。
    // 此分支在扣额度之前 return，所以不会白扣次数。
    if (msg.autoClick && extras.pending > 0) {
      highlightElement(confirmBtn)
      return {
        ok: false,
        mode: 'need-input',
        company: sxInfo.company,
        jobTitle: sxInfo.jobTitle,
        error: `弹窗里还有 ${extras.pending} 项「请选择」没填（${extras.placeholders.join(' / ')}），已停止自动提交。填完再点一次即可。`,
      }
    }

    const sxQuota = await chrome.runtime.sendMessage({ action: 'checkAndIncrement', platform: platform() })
    if (sxQuota.blocked)
      return { ok: false, error: `「实习僧」今日额度已用完（${sxQuota.used}/${sxQuota.limit}），已自动停止` }

    // 半自动（不勾「自动点击投递」）：只高亮，由人工点
    if (!msg.autoClick) {
      highlightElement(confirmBtn)
      return {
        ok: true,
        mode: 'manual-confirm',
        company: sxInfo.company,
        jobTitle: sxInfo.jobTitle,
        used: sxQuota.used,
        limit: sxQuota.limit,
        message: '已展开投递弹窗并高亮「确认投递」，请人工检查简历与补充信息后点击',
      }
    }

    // 全自动：随机停顿（模拟人工）→ 点「确认投递」→ 判定结果 → 入账 + 回写投递记录
    await sleep(rand(1500, 3500))
    confirmBtn.click()
    await sleep(rand(1200, 2200))
    const sxResult = detectSxResult()

    // 只有「弹窗确实关掉了」才入账：弹窗还停着说明没提交成功，记了会污染账本。
    // success 记为已确认；unknown（没抓到 toast）也记，但标 verified:false，下次跳过时会提示「可能没投成」。
    if (sxResult.state !== 'pending' && jobId) {
      await markAppliedLocal({
        jobId,
        platform: '实习僧',
        title: sxInfo.jobTitle,
        company: sxInfo.company,
        url: location.href,
        verified: sxResult.state === 'success',
        source: 'auto',
      })
    }
    const wbSx = await writeback(sxInfo, '', jobId)

    return {
      ok: sxResult.state !== 'pending',
      mode: 'auto-submitted',
      autoClicked: true,
      verified: sxResult.state === 'success',
      company: sxInfo.company,
      jobTitle: sxInfo.jobTitle,
      used: sxQuota.used,
      limit: sxQuota.limit,
      backendError: wbSx && !wbSx.ok ? wbSx.error || '回写后端失败' : '',
      message: withBackendNote(
        sxResult.state === 'success'
          ? `已投递成功（${sxResult.text}）`
          : sxResult.state === 'unknown'
            ? `已点「确认投递」，${sxResult.text}，已记为已投（未确认，建议抽查）`
            : `点击后${sxResult.text}，未计入已投`,
        wbSx
      ),
    }
  }

  // 2.8 BOSS 直聘：整条链路独立（点「立即沟通」→ 聊天框 → 输入 → 发送），走专用流程。
  //     下面的通用逻辑是给未知平台兜底的，BOSS 一旦走到那里必然失败（它没有投递弹窗）。
  if (platform() === 'BOSS直聘') return runBossApply(msg)

  // 兜底：未知平台才走这套「填话术 + 点按钮」的通用逻辑
  const bossJobId = currentJobId()
  if (bossJobId) {
    const localBoss = await chrome.runtime.sendMessage({ action: 'isApplied', platform: platform(), jobId: bossJobId })
    if (localBoss && localBoss.applied) {
      const when = localBoss.at ? `${formatWhen(localBoss.at)} ` : ''
      return {
        ok: false,
        skipped: true,
        mode: 'local-applied',
        error: `本地记录显示 ${when}已投过，已跳过`,
      }
    }
  }

  // 3. 每日额度检查（BOSS 走这条；实习僧已在上面自查过，不重复扣）
  const quota = await chrome.runtime.sendMessage({ action: 'checkAndIncrement', platform: platform() })
  if (quota.blocked) return { ok: false, error: `「${platform()}」今日额度已用完（${quota.used}/${quota.limit}），已自动停止` }

  // 4. 找到沟通输入框并填入
  const box = findGreetingBox()
  if (!box) return { ok: false, error: '未找到沟通输入框。请确认当前在投递页，或用「探测页面结构」校准选择器。' }

  fillGreeting(box, greeting)
  await sleep(300)

  const info = extractJobInfo()

  // 5. 半自动：默认只填不点；自动模式才在随机间隔后点击
  let autoClicked = false
  if (msg.autoClick) {
    const btn = findApplyButton()
    if (!btn) return { ok: false, error: '已填入打招呼语，但未找到投递按钮（请手动点击投递）。' }
    await sleep(rand(4000, 10000))
    btn.click()
    autoClicked = true
  }

  // 6. 入账 + 回写投递记录
  // BOSS 没有明确的「投递成功」提示，所以只记 verified:false（下次跳过时会提示可能未投成）
  if (autoClicked && bossJobId) {
    await markAppliedLocal({
      jobId: bossJobId,
      platform: platform(),
      title: info.jobTitle,
      company: info.company,
      url: location.href,
      verified: false,
      source: 'auto',
    })
  }
  const wbSingle = await writeback(info, greeting, bossJobId)

  return {
    ok: true,
    autoClicked,
    company: info.company,
    jobTitle: info.jobTitle,
    used: quota.used,
    limit: quota.limit,
    backendError: wbSingle && !wbSingle.ok ? wbSingle.error || '回写后端失败' : '',
    message: wbSingle && !wbSingle.ok ? `⚠️ 没写进后端：${wbSingle.error || '回写失败'}` : '',
  }
}

// ===================== 批量投递（列表页 → 逐个详情页） =====================
// 跨页状态存 chrome.storage.local：页面一导航，content script 会重新注入，
// 只有 storage 能跨页保留进度。
//
// ⚠️ 2026-11-02 改成按平台分键（batch:sx / batch:boss）。原来只有单一 'batch' 键，
// 实习僧和 BOSS 同时跑时会往同一个 key 写 index/results —— 两家互相覆盖进度，
// 表现是「跳来跳去、每家都投一半」，所以并行前必须先拆键。
const BATCH_KEY_LEGACY = 'batch'
const BATCH_LINE_PREFIX = 'batch:'
const BATCH_MAX = 20

function lineOfPlatform(pf) {
  const p = String(pf || '')
  if (/boss|直聘/i.test(p)) return 'boss'
  if (p.includes('实习僧')) return 'sx'
  return 'other'
}
function lineOfUrl(u) {
  const s = String(u || '')
  if (/zhipin\.com/i.test(s)) return 'boss'
  if (/shixiseng\.com/i.test(s)) return 'sx'
  return 'other'
}
// 当前页面属于哪条线；popup 也按这个口径读状态
function lineKey(pf) {
  return BATCH_LINE_PREFIX + lineOfPlatform(pf || platform())
}

// 自己在哪个 tab：同一条线可能被开成多个标签页（不同关键词各开一个），
// 只有「启动批次的那个 tab」能推进，否则两个 tab 会各自认领同一家、重复投。
async function myTabId() {
  try {
    const r = await chrome.runtime.sendMessage({ action: 'whoAmI' })
    return (r && r.tabId) || null
  } catch (_) {
    return null
  }
}

async function getBatch(pf) {
  const me = pf || platform()
  const key = lineKey(me)
  const r = await chrome.storage.local.get([key, BATCH_KEY_LEGACY])
  if (r[key]) return r[key]
  // 老版本只存 'batch'：确认它属于当前这条线才迁过来继续跑。
  // 属于另一条线就必须忽略——否则两条线会同时认领同一份队列。
  const legacy = r[BATCH_KEY_LEGACY]
  if (legacy && Array.isArray(legacy.queue) && legacy.queue.length) {
    if (lineOfUrl(legacy.queue[0]) === lineOfPlatform(me)) {
      await chrome.storage.local.set({ [key]: legacy })
      return legacy
    }
  }
  return null
}
async function setBatch(b) {
  await chrome.storage.local.set({ [lineKey()]: b })
  // 老键只当迁移源用，写完就清掉，避免下次被另一条线读到
  try {
    await chrome.storage.local.remove(BATCH_KEY_LEGACY)
  } catch (_) {
    /* stub 环境没有 remove，忽略 */
  }
}

// 取岗位 id，用于跨页比对与账本去重（忽略 query 参数差异）
// 两个平台都要认，否则批量里 jobIdOf 双双返回 '' → '' === '' 恒成立，
// 会把「任何页面」都当成目标页（2026-10-30 补 BOSS 时发现）
function jobIdOf(url) {
  const s = String(url || '')
  const sx = s.match(/inn_[a-z0-9]+/i)
  if (sx) return sx[0]
  // BOSS：/job_detail/xxxx.html 与新版 /job_detail/?jobId=xxxx 两种都要认
  const bossPath = s.match(/job_detail\/([a-z0-9~_-]+)\.html/i)
  if (bossPath) return `boss_${bossPath[1]}`
  const bossQuery = s.match(/[?&]jobId=([a-z0-9~_-]+)/i)
  if (bossQuery) return `boss_${bossQuery[1]}`
  return ''
}

// 取岗位卡片整体文本（向上找含「x天/周」或「x个月」的容器）
function cardTextOf(a) {
  let el = a
  for (let i = 0; i < 6 && el; i++) {
    const t = (el.innerText || '').trim()
    if (t.length > 15 && (/天\s*\/\s*周/.test(t) || /个月/.test(t))) return t
    el = el.parentElement
  }
  el = a.parentElement
  for (let i = 0; i < 4 && el; i++) {
    if ((el.innerText || '').trim().length > 15) return el.innerText.trim()
    el = el.parentElement
  }
  return (a.innerText || '').trim()
}

// 岗位链接的标题。BOSS 列表页 <a class="job-card-left"> 的 innerText 混着岗位名、
// 城市、薪资，直接拿会得到「测试开发深圳·南山区13-20K」这种串，所以优先取子节点。
function linkTitleOf(a) {
  const named = a.querySelector('.job-name, .job-title, .job-card-name')
  if (named && (named.innerText || '').trim()) return named.innerText.trim().replace(/\s+/g, ' ')
  const raw = (a.innerText || '').trim().replace(/\s+/g, ' ')
  // 多行时第一行通常是岗位名
  const firstLine = raw.split(/[\n\r]/)[0].trim()
  return firstLine || raw
}

// 从列表页抓岗位链接，并顺手按 A 方案粗筛（不合条件的不进队列）
async function collectJobLinks() {
  const f = await getJobFilters()

  // 平台决定：认哪种详情页链接、账本 key 用什么前缀
  const pf = platform()
  const keyPrefix = pf === 'BOSS直聘' ? 'boss' : 'sx'
  const linkRe = pf === 'BOSS直聘' ? /zhipin\.com\/job_detail\//i : /shixiseng\.com\/intern\/inn_/i

  // 账本预筛：本地已投过的不进队列。省一次页面跳转 + 15~30 秒等待，也避免重复投。
  const appliedKeys = new Set()
  try {
    const r = await chrome.runtime.sendMessage({ action: 'listApplied', limit: 2000 })
    if (r && Array.isArray(r.list)) r.list.forEach((x) => appliedKeys.add(x.key))
  } catch (_) {
    /* 读不到账本就当作没有，不影响正常抓取 */
  }

  const seen = new Set()
  const out = []
  const blocked = []
  let appliedSkip = 0
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href || ''
    if (!linkRe.test(href)) return
    const id = jobIdOf(href)
    if (!id || seen.has(id)) return
    seen.add(id)

    // 本地账本里已有 → 直接跳过（列表页就把重复投挡掉）
    if (appliedKeys.has(`${keyPrefix}:${id}`)) {
      appliedSkip++
      return
    }

    // 保留原始链接，只去锚点。原来剥掉 query 后实习僧有时会重定向回列表页，
    // 跳转过去 jobId 对不上 → 批量卡在原地（2026-10-30 实测）
    let clean = href
    try {
      const u = new URL(href)
      u.hash = ''
      clean = u.toString()
    } catch (_) {
      /* 保留原样 */
    }

    const title = linkTitleOf(a)
    if (!title) return
    // 卡片文本优先用「链接向上锁定的容器」（采集器那套），而不是 cardTextOf 的猜测。
    // BOSS 卡片上没有「x天/周」，cardTextOf 会退化成「任意够长的父级」，可能拿到整个列表区 →
    // 文本里混进别的岗位和别的城市 → detectCity 命中外地 → 整批误跳过（页面上看不出错）。
    // 探测已确认：BOSS 列表页每张卡各自锁到独立的 DIV.card-area。
    const rowEl = window.__jhCollector && window.__jhCollector.rowOfLink
      ? window.__jhCollector.rowOfLink(a)
      : null
    const card = rowEl ? (rowEl.innerText || '').trim() : cardTextOf(a)
    // 列表页信息不全，识别不到城市/时长时不拦（allowUnknown=true），详情页会再校验一次
    const screen = screenJob({ jobTitle: title, company: '', jdText: card, metaText: card }, f, true)
    if (screen.blocked) {
      blocked.push({ title: truncate(title, 40), reason: screen.reason })
      return
    }
    out.push({ id, url: clean, title: truncate(title, 40) })
  })
  return { links: out, blocked, appliedSkip }
}

async function startBatch(limit, force) {
  const { links, blocked, appliedSkip = 0 } = await collectJobLinks()
  if (!links.length) {
    const why = appliedSkip
      ? `本页 ${appliedSkip} 家本地记录里都投过了，没有新岗位可投（换一页或清空记录再试）`
      : blocked.length
        ? `本页 ${blocked.length} 家都不符合筛选条件（第 1 家：${blocked[0].reason}）`
        : '当前页面没抓到岗位链接（请在搜索结果列表页启动）'
    return { ok: false, error: why, blocked: blocked.length, appliedSkip }
  }

  // BOSS 批量必须有招呼语：BOSS 没有「投递」这个动作，投递＝发出这条消息。
  // 批量里没人手工输入，所以要从存储里带过去，否则每一家都会因「请先填入打招呼语」失败。
  const { greeting = '' } = await chrome.storage.local.get('greeting')
  const greetingText = String(greeting || '').trim()
  if (platform() === 'BOSS直聘' && !greetingText) {
    return {
      ok: false,
      error: 'BOSS 批量投递必须先填「打招呼语」：BOSS 的投递就是发这条消息。请到「单次投递」页填好（会自动保存），再回来启动批量。',
    }
  }

  // 剩余额度不够就别开整批：跑到一半被拦会让每家都判失败，
  // failStreak 一到 2 整批就停，前面白跑。按剩余量收缩更划算。
  const q = await chrome.runtime.sendMessage({ action: 'getQuota', platform: platform() })
  const remain = q && typeof q.remaining === 'number' ? q.remaining : -1
  if (remain === 0) {
    return {
      ok: false,
      error: `「${platform()}」今日额度已用完（${q.used}/${q.limit}）—— 去「记录」页点「重置额度」，或把上限调高`,
    }
  }

  const asked = Math.min(Number(limit) || 10, BATCH_MAX)
  // remain = -1 表示该平台设成了「不限」
  const cap = remain > 0 ? Math.min(asked, remain) : asked
  const shrunk = cap < asked
  const queue = links.slice(0, cap)
  const batch = {
    running: true,
    // 这条线属于哪个平台：popup 与 resumeBatch 都靠它判断归属
    line: lineOfPlatform(),
    // 认领这个批次的标签页，其他同平台标签页看到就不许推进
    tabId: await myTabId(),
    // 整批复用的招呼语（实习僧可空，BOSS 必填）
    greeting: greetingText,
    // 用户在 popup 勾了「跳过风控检测」时整批都不再拦（风控误判后的续跑开关）
    force: !!force,
    queue: queue.map((x) => x.url),
    titles: queue.map((x) => x.title),
    index: 0,
    results: [],
    failStreak: 0,
    stopReason: '',
    // jumpedAt 必须有值：resumeBatch 用「距上次跳转多久」判断页面是否还在加载
    jumpedAt: new Date().toISOString(),
    jumpAttempts: 0,
    startedAt: new Date().toISOString(),
    total: queue.length,
  }
  await setBatch(batch)
  // 先让 sendResponse 回到 popup，再跳转
  setTimeout(() => {
    location.href = batch.queue[0]
  }, 600)
  return {
    ok: true,
    line: batch.line,
    total: batch.total,
    skipped: links.length - queue.length,
    blocked: blocked.length,
    appliedSkip,
    shrunk,
    quota: { used: q.used, limit: q.limit, remaining: remain },
  }
}

async function stopBatch() {
  const b = await getBatch()
  if (!b) return { ok: true, message: '没有进行中的批量任务' }
  await setBatch({ ...b, running: false, stopReason: '已手动停止' })
  return { ok: true, message: '已停止（当前这家投完就停）' }
}

let batchBusy = false

// 单家结果入库 → 判断整批还跑不跑 → 跑就跳下一家。
// 抽成独立函数的原因：BOSS 点「立即沟通」会整页跳到聊天页，那家的收尾（发送 + 判定 + 入账 + 推进）
// 只能由聊天页的脚本完成。若只写在 resumeBatch 里，聊天页投完就没人推进，整批停在同一格。
async function applyBatchResult(target, res, b) {
  const nb = (await getBatch()) || b
  const results = [
    ...(nb.results || []),
    {
      url: target,
      title: (nb.titles && nb.titles[nb.index]) || '',
      ok: !!res.ok,
      skipped: !!res.skipped,
      mode: res.mode || '',
      message: res.message || res.error || '',
      at: new Date().toISOString(),
    },
  ]

  // 跳过（已投递过 / 不符合筛选）不算失败，否则撞上几家老岗位就会整批停
  let failStreak = res.ok || res.skipped ? 0 : (nb.failStreak || 0) + 1
  let running = true
  let stopReason = ''

  if (res.risk) {
    running = false
    // 带上命中原因，否则只有一句「遇到风控」，分不清是真验证码还是页面文案误判
    const why = String(res.error || '')
      .replace(/^检测到风控提示，已停止（/, '')
      .replace(/）。.*$/, '')
    stopReason = `第 ${nb.index + 1} 家触发风控判定${why ? `：${why}` : ''}；已停整批保护账号。若页面实际正常，勾「跳过风控检测」再跑一次`
  } else if (res.fatal) {
    // 结构性失败（选择器对不上 / 页面改版）：第一家就停，不赌后面
    running = false
    stopReason = `第 ${nb.index + 1} 家页面结构对不上，已停整批：${truncate(res.error || '', 110)}　→　请在该岗位页点「探测页面结构」，把 boss 段发我校准选择器`
  } else if (failStreak >= 2) {
    running = false
    stopReason = `连续 2 家失败，已停止（查页面结构 / 额度 / 补充信息三项）${nb.results && nb.results.length ? `｜最后一次：${truncate(results[results.length - 1].message, 80)}` : ''}`
  }

  const nextIndex = nb.index + 1
  if (running && nextIndex >= nb.queue.length) {
    running = false
    const okN = results.filter((r) => r.ok).length
    const skipN = results.filter((r) => r.skipped).length
    const failN = results.length - okN - skipN
    stopReason = `本批 ${nb.queue.length} 家已全部执行完（成功 ${okN} / 跳过 ${skipN} / 失败 ${failN}）`
  }

  await setBatch({
    ...nb,
    results,
    failStreak,
    running,
    index: nextIndex,
    stopReason,
    lastAt: new Date().toISOString(),
  })

  if (running) {
    // 家与家之间随机停顿，降风控。BOSS 比实习僧严得多（独立沟通额度 + 风控更敏感），
    // 间隔拉到 30~60s；实习僧维持 15~30s。
    await sleep(platform() === 'BOSS直聘' ? rand(30000, 60000) : rand(15000, 30000))
    const still = await getBatch()
    if (still && still.running) {
      // 跳转前先把时间戳和 jumpedAt 写进去：
      // 否则「上一家完成时刻」会成为跳转后页面的超时基准，加载慢一点就被误判停批
      await setBatch({
        ...still,
        lastAt: new Date().toISOString(),
        jumpedAt: new Date().toISOString(),
        jumpAttempts: 0,
      })
      location.href = nb.queue[nextIndex]
    }
  }
  return { running, nextIndex, stopReason }
}

// 页面加载后自动续跑；若发现「当前不在该投的那一页」会主动纠正跳转
async function resumeBatch() {
  if (batchBusy) return
  // 有跨页待办（刚点了「立即沟通」跳到聊天页）→ 交给 bootPendingBoss 处理。
  // 这里必须直接退出：否则本函数会认为「不在目标岗位页」而把聊天页踢回岗位页，
  // 待办就永远发不出去了。
  //
  // ⚠️ 只在 BOSS 线判断：待办是 BOSS 专用的。以前无条件 return，
  // 只要 BOSS 有一条待发送的消息，实习僧那条线就整批停摆（并行时必现）。
  if (platform() === 'BOSS直聘') {
    const pending = await getPendingBoss()
    if (pending) return
  }

  const b = await getBatch()
  if (!b || !b.running) return

  // 同一平台开了多个标签页时，只有启动批次的 tab 能推进。
  // BOSS 例外：点「立即沟通」可能另起新标签，tabId 会变，卡住反而会不发。
  if (b.tabId && platform() !== 'BOSS直聘') {
    const me = await myTabId()
    if (me && b.tabId !== me) return
  }

  const target = b.queue && b.queue[b.index]
  if (!target) return

  const curId = jobIdOf(location.href)
  const targetId = jobIdOf(target)

  // A. 不在目标页：多半是上一次跳转没成功（被重定向回列表页 / 页面没打开 / 加载中断）。
  //    原实现这里直接 return 就静默退出，没人推进，只能等 2 分钟超时——
  //    表现就是「批量卡在同一格不动」（2026-10-30 实测）。
  if (curId !== targetId) {
    const sinceJump = b.jumpedAt ? Date.now() - new Date(b.jumpedAt).getTime() : Infinity
    const attempts = b.jumpAttempts || 0

    // 刚发起跳转 15 秒内不动，给页面加载时间
    if (sinceJump < 15000) return

    if (attempts < 3) {
      await setBatch({
        ...b,
        jumpAttempts: attempts + 1,
        jumpedAt: new Date().toISOString(),
        lastAt: new Date().toISOString(),
      })
      location.href = target
      return
    }

    await setBatch({
      ...b,
      running: false,
      stopReason: `第 ${b.index + 1} 家打不开（目标 ${targetId || target}，当前停在 ${curId || '非详情页'}），重试 3 次仍失败，已停止`,
    })
    return
  }

  // B. 已在目标页：清掉跳转重试计数，正常执行
  if (b.jumpAttempts) await setBatch({ ...b, jumpAttempts: 0 })

  // 兜底：真的卡死时（比如页面渲染异常）别无限挂着
  const last = b.lastAt ? new Date(b.lastAt).getTime() : Date.now()
  if (Date.now() - last > 180000) {
    await setBatch({ ...b, running: false, stopReason: '3 分钟没推进，已自动停止（页面加载异常）' })
    return
  }

  batchBusy = true
  try {
    // 等页面渲染稳定
    await sleep(rand(2500, 4500))

    const res = await runApply({ autoClick: true, greeting: b.greeting || '', force: !!b.force })

    // 中继状态：点了「立即沟通」、页面正在跳到聊天页，这家还没投完。
    // 不记结果也不推进 —— 收尾交给聊天页的 bootPendingBoss()，这里直接退出。
    if (res.jumped) return

    await applyBatchResult(target, res, b)
  } catch (e) {
    const nb = (await getBatch()) || b
    await setBatch({ ...nb, running: false, stopReason: `异常：${e.message}` })
  } finally {
    batchBusy = false
  }
}

// ===================== 聊天页接管（跨页接力第二段） =====================
let pendingBusy = false

// 点「立即沟通」→ 整页跳到聊天页 → 本函数接管：填话术 → 发送 → 入账 → 推进批量。
// 单次投递也会走到这里（p.inBatch=false），结果写进 storage 供 popup 显示。
async function bootPendingBoss() {
  if (pendingBusy) return
  const p = await getPendingBoss()
  if (!p) return
  if (platform() !== 'BOSS直聘') return

  // 过期的待办直接丢掉：否则可能在完全不相干的页面上误发一条消息出去
  const age = Date.now() - new Date(p.at || 0).getTime()
  if (age > PENDING_BOSS_TTL) {
    await clearPendingBoss()
    return
  }

  // 认领标记：同标签跳转 + BOSS 另起新标签两种情况可能都会加载本脚本，
  // 只让第一个进来的往下做，避免同一个岗位发两遍。
  await setPendingBoss({ ...p, claimedAt: Date.now() })
  pendingBusy = true
  batchBusy = true // 压住 resumeBatch：别把它当成「不在目标岗位页」把聊天页踢回详情页

  const fail = async (error, extra) => {
    await clearPendingBoss()
    const b = await getBatch()
    if (b && b.running) {
      await applyBatchResult(p.url, { ok: false, error, ...(extra || {}) }, b)
    } else {
      await chrome.storage.local.set({
        lastBossResult: { ok: false, company: p.company, jobTitle: p.jobTitle, message: error, at: new Date().toISOString() },
      })
    }
  }

  try {
    // BOSS 聊天面板是首屏后异步挂载的，给足 20 秒
    let box = await waitForFn(findBossChatInput, 20000, 500)
    if (!box) {
      // 实测：跳到 /web/geek/chat 后**不会自动打开那家的会话**，右侧是 chat-no-data 空态，
      // 输入框压根不渲染（第一次探测时 chatInput 就是 null）。所以按公司/岗位名去左侧列表点一条。
      if (openBossConversation(p)) {
        box = await waitForFn(findBossChatInput, 15000, 500)
      }
    }
    if (!box) {
      await fail(
        `已跳到聊天页，但没找到聊天输入框，也没能自动点开会话（当前地址 ${truncate(location.href, 60)}）。请手动点开该公司的会话后重试`
      )
      return
    }

    // 发错人比漏投严重得多：先确认当前会话就是目标岗位，对不上就停整批（fatal）
    const curTitle = bossChatJobTitle()
    if (p.jobTitle && curTitle && !sameJobText(p.jobTitle, curTitle)) {
      await fail(
        `当前打开的聊天不是目标岗位（页面显示「${truncate(curTitle, 30)}」，目标是「${truncate(p.jobTitle, 30)}」），已中止以免发错人`,
        { fatal: true }
      )
      return
    }

    // 额度：真正要发消息了才扣
    const quota = await chrome.runtime.sendMessage({ action: 'checkAndIncrement', platform: platform() })
    if (quota && quota.blocked) {
      await fail(`「${platform()}」今日额度已用完（${quota.used}/${quota.limit}），已自动停止`)
      return
    }

    const result = await sendBossMessage(box, p.greeting || '')
    await clearPendingBoss()

    if (result.state !== 'failed' && p.jobId) {
      await markAppliedLocal({
        jobId: p.jobId,
        platform: 'BOSS直聘',
        title: p.jobTitle,
        company: p.company,
        url: p.url,
        verified: result.state === 'success',
        source: 'jump',
      })
    }
    // jobId 必须带上：批量路径原来只传公司+岗位名，BOSS 记录的 jobId 全是空，
    // 之后「进度采集」拿平台 id 对账时对不上，岗位一改名就断（只能靠名字硬猜）
    const wb = await writeback({ company: p.company, jobTitle: p.jobTitle }, p.greeting || '', p.jobId)

    const res = {
      ok: result.state !== 'failed',
      mode: 'boss-sent',
      verified: result.state === 'success',
      company: p.company,
      jobTitle: p.jobTitle,
      used: quota && quota.used,
      limit: quota && quota.limit,
      // 回写失败不影响「消息已发出」这个事实，但必须让人看见 —— 否则网页端漏记录，
      // 表现是「我明明投了，漏斗里没有」。这和 2026-11-03 BOSS 三家的症状一模一样。
      backendError: wb && !wb.ok ? wb.error || '回写后端失败' : '',
      message:
        (result.state === 'success'
          ? `已发送招呼语（${result.text}）`
          : result.state === 'unknown'
            ? `已点「发送」，${result.text}`
            : `发送失败：${result.text}`) +
        (wb && !wb.ok ? `｜⚠️ 但没写进后端：${wb.error || '回写失败'}` : ''),
    }
    await chrome.storage.local.set({
      lastBossResult: { ...res, at: new Date().toISOString() },
    })

    const b = await getBatch()
    if (b && b.running) {
      // 收尾这家的记账 + 推进下一家（含 30~60s 间隔）
      await applyBatchResult(p.url, res, b)
    }
  } finally {
    pendingBusy = false
    batchBusy = false
  }
}

// 页面就绪后自动检查是否该续跑
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(bootPendingBoss, 500)
    setTimeout(resumeBatch, 800)
  })
} else {
  setTimeout(bootPendingBoss, 500)
  setTimeout(resumeBatch, 800)
}
