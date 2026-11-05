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
  // ⚠️ 不能直接取 innerText 第一行：实习僧岗位名元素里是「27届\n测试实习生」，
  // 第一行是届别标签。真机上 3 条不同岗位的标题全成了「27届」（见 collector 的 PURE_TAG_LINE）。
  const C0 = window.__jhCollector
  const rawLabel = (jobEl && jobEl.innerText) || ''
  const jobTitle =
    (C0 && C0.firstTitleLine ? C0.firstTitleLine(rawLabel) : cleanLabel(rawLabel)) ||
    title.split(/[-_—|｜]/)[0].trim() ||
    '未知岗位'

  // 公司名走 collector.js 的受控查找：只在「岗位名所在容器」里取，或全页唯一候选。
  //
  // ⭐ 原来这里是
  //   querySelector('.job-banner .company-name, .company-info .company-name,
  //                 [class*="company-name"], .company-name, .cname, .com-name')
  // 最后那个通配是**全页**的。BOSS 一键投递跑在「左侧列表 + 右侧详情」页面上，
  // 文档序第一个 `[class*="company-name"]` 常常是左侧列表里**别的卡片** ——
  // 账本于是记下别人的公司。10 条 BOSS 记录错了 4 条，而界面上「解析一切正常」：
  // 岗位名用的是精确选择器，所以全对，只有公司名错。
  // 铁证：「【日常实习】数据运营实习生(A69277)」同一个内部编号挂在两家不同公司名下。
  const C = window.__jhCollector
  const company = C && C.findCompanyName ? C.findCompanyName(jobEl) : ''

  return {
    // 空 → 未知公司：宁可留空让人看见，也不要一个错的（错的会稳定匹配到错误的记录）
    company: company || '未知公司',
    jobTitle,
    companyUnverified: !company,
  }
}

/**
 * 取「岗位自身的城市」所在的那段文本，越窄越准。
 *
 * 为什么不能用 document.body.innerText：实习僧详情页顶部有站点城市切换器、面包屑，
 * 里面永远写着你当前选的城市（深圳）；右边还有「相似岗位」。整页文本里「深圳」必然出现，
 * 于是西安的岗位在详情页复检时也会被判成「城市相符」—— 城市门槛等于没有。
 *
 * 做法：从岗位标题元素向上找，第一个「认得出城市」且文本不过长的容器就是岗位信息区。
 * 不写死 class 名（平台改版就废），只依赖「城市写在标题附近」这个结构事实。
 */
function cityTextNearTitle() {
  const F = window.JH_FILTERS
  if (!F || typeof F.firstCity !== 'function') return ''
  const el = document.querySelector(
    '.job-banner .name, .job-primary .name, .job-detail-box .name, .job-name, .job-title, .position-name, h1'
  )
  if (!el) return ''
  let cur = el
  for (let i = 0; i < 6; i++) {
    const up = cur.parentElement
    if (!up || up === document.body) break
    const t = (up.innerText || '').trim()
    // 超过 600 字 = 已经越过岗位信息区（整栏/整页），里面的城市不可信
    if (t.length > 600) break
    if (F.firstCity(t)) return t
    cur = up
  }
  return ''
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

/**
 * 把当前筛选条件压成一句话，放在「启动批量」的日志里。
 *
 * 为什么需要：2026-11-05 用户在实习僧投出了西安的岗位，界面上完全看不出
 * 「城市门槛这次到底参没参与」。筛选是**静默生效**的 —— 配错了不会报错，
 * 只会安静地放行不该投的岗位。把条件摆在启动日志里，才有可能一眼发现没生效。
 */
function describeFilters(f) {
  const F = window.JH_FILTERS
  if (!f || !f.enabled) return '⚠️ 筛选已关闭（全部放行）'
  const parts = []
  parts.push(f.cities && f.cities.length ? `城市 ${f.cities.join('/')}` : '⚠️ 城市不限')
  if (f.directions && f.directions.length) {
    parts.push(`方向 ${dirShort(f.directions)}`)
  } else {
    parts.push('⚠️ 方向不限')
  }
  if (f.maxExperience != null) {
    parts.push(
      f.maxExperience === 99
        ? '经验不限'
        : f.maxExperience === 0
          ? '经验不限/在校'
          : `经验≤${f.maxExperience}年`
    )
  }
  if (f.maxEduRank != null && f.maxEduRank < 6) {
    parts.push(`学历≤${(F && F.EDU_LABELS && F.EDU_LABELS[f.maxEduRank]) || f.maxEduRank}`)
  }
  return parts.join('｜')
}

/**
 * 命中哪些方向组。
 *
 * 命中判断走 filters-data 的 hitKeyword（纯函数、有单测）：中文包含、英文词边界。
 * 英文必须按词边界 —— 直接 includes 时 `test` 会命中 `latest`，`qa` 会命中 `qax`，
 * 标题里出现这类词就把岗位放行，方向筛选等于没有。
 * （2026-11-05 真机：搜 SDET 出来的几条是英文岗名，词表里只有中文 + 工具名，全被判「没有方向词」）
 */
function matchedDirections(text) {
  const t = String(text || '').toLowerCase()
  const F = window.JH_FILTERS
  const list = (F && F.DIRECTIONS) || []
  const hit = F && typeof F.hitKeyword === 'function'
    ? F.hitKeyword
    : (s, k) => String(s || '').includes(String(k || '').toLowerCase())
  const ids = []
  for (const d of list) {
    if (d.keywords.some((k) => hit(t, k))) ids.push(d.id)
  }
  return ids
}

function dirLabel(id) {
  const list = (window.JH_FILTERS && window.JH_FILTERS.DIRECTIONS) || []
  const hit = list.find((d) => d.id === id)
  return hit ? hit.label : id
}

/**
 * 这条岗位属于哪个方向（写进投递记录用）。
 *
 * 为什么要在**投递那一刻**算：筛选器刚刚为了放行这条岗，已经把标题里的方向词匹配过一遍，
 * 这是最准的一手信息。不记下来的后果是后端只能拿「公司+岗位」去查 `data/jd/jobs.json`
 * 那份语料补 —— 语料是 9 月的，对不上新岗位，于是 36 条里 34 条 direction 是空的，
 * 漏斗的「按方向分组」直接废掉（2026-11-05 实测）。
 *
 * 只看标题不看 JD：这里可能已经在 BOSS 聊天页，页面正文是聊天记录，
 * 拿它判方向会把「面试」这类词也当方向证据。标题判不出来就留空，交给后端语料兜底——
 * 空着是「不知道」，瞎填是「知道错」，后者更难发现。
 */
function directionOf(jobTitle) {
  const pool = matchedDirections(jobTitle)
  return pool.length ? dirLabel(pool[0]) : ''
}

/**
 * 方向标签压成一句话：超过 3 个只列前 3 个 + 「等 N 个」。
 *
 * 为什么：勾了 7 个方向时，「标题里没有『测试开发 / 软件测试/自动化测试 / SDET/前端开发/产品/…』这类词」
 * 一句话能占两行，弹窗里被 truncate 截掉，反而看不出拦的是什么（2026-11-05 真机日志）。
 */
function dirShort(ids) {
  const labels = (ids || []).map(dirLabel)
  return labels.length > 3
    ? `${labels.slice(0, 3).join('、')} 等 ${labels.length} 个`
    : labels.join('、')
}

/**
 * 「你勾的方向，插件到底在标题里找哪些词」——举例，最多 3 个。
 *
 * 为什么不再拿方向**标签**去拼原因：原来报的是
 *   「标题里没有『测试开发 / 软件测试、自动化测试 / SDET、接口测试 / 性能测试 等 4 个』这类词」
 * 标签是给人选的分类名，不是插件真正找的字符串；用户照着这句话去原文里找，
 * 永远找不到「测试开发 / 软件测试」这串带斜杠的字（2026-11-05 真机日志）。
 * 报**真实关键词**，用户一眼就能对照岗位标题判断是不是误杀。
 */
function dirSamples(ids, n = 2) {
  const list = (window.JH_FILTERS && window.JH_FILTERS.DIRECTIONS) || []
  const out = []
  for (const id of ids || []) {
    const d = list.find((x) => x.id === id)
    if (!d || !d.keywords || !d.keywords.length) continue
    const k = d.keywords[0]
    if (!out.includes(k)) out.push(k)
  }
  if (!out.length) return ''
  // 弹窗宽度见底：`等 4 组` 带空格会白占 2px，写紧凑点
  const more = out.length > n ? `等${out.length}组` : ''
  return `「${out.slice(0, n).join('」「')}」${more}`
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

  // 1) 城市：先找「岗位城市」，再比是不是你要的
  //    不能用「文本里包含深圳就算过」—— 站点城市切换器、面包屑、右侧相似岗位、页脚热门城市
  //    都会出现「深圳」，那样任何外地岗位都能过（2026-11-05 实测投出了西安的岗位）。
  if (f.cities.length) {
    const cc = typeof F.checkCity === 'function'
      ? F.checkCity(metaSrc, f.cities)
      : { blocked: false, city: '' }
    // 「全国」不是异地，是「没写死在哪」：既可能真在深圳，也可能在外地。
    // 不自动投，也不当垃圾丢掉 —— 交给上层收进「待定」让用户自己决定（2026-11-05 用户选的方案）
    if (cc.nationwide) {
      return {
        pending: true,
        mode: 'nationwide',
        city: cc.city,
        reason: `岗位写的是「${cc.city}」，可能在外地也可能在 ${f.cities.join('/')}，没自动投，等你决定`,
        meta: {},
      }
    }
    if (cc.blocked) {
      return {
        blocked: true,
        reason: `城市不符（岗位在 ${cc.city}，你只投 ${f.cities.join('/')}）`,
        meta: {},
      }
    }
    if (!cc.city && f.strictMeta && !allowUnknown) {
      return { blocked: true, reason: '读不到岗位城市（已开严格模式）', meta: {} }
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
    const samples = dirSamples(f.directions)
    if (!pool.length) {
      // 「一个方向词都没有」和「明确是别的方向」是两件事，原来都报成「方向无法识别」：
      // 列表页一页拦掉 16 家时，满屏「无法识别」看着像插件坏了，其实筛选在正常工作
      // （2026-11-05 真机：第 2 页的岗位是「环境可靠性工程师」「技术质量工程师」这类，
      //   标题本来就不含任何方向词，拦掉是对的）。
      //
      // 报的是**真实关键词**不是方向标签：标签里带斜杠的那种串在原文里根本不存在，
      // 用户没法拿它去核对（真机日志里那句「标题里没有『测试开发 / 软件测试、…等 4 个』」）
      // ⚠️ 文案要**短到弹窗放得下**：拦截清单每行只有一个说法位（约 30 字，CSS max-width 52%）。
      // 上一版写「标题里没有你要的方向词（插件找的是「测试开发」…）」，光套话就吃掉 11 字，
      // 结果真机里永远显示成「标题里没有你要的方向词（插件找的是 「测…」」——
      // 想看「找的是什么词」的那半句恰好被截断，等于没写（2026-11-05）。
      // 现在关键词前置、只列 2 组，完整版留给 hover（popup 的 title 属性）。
      const lookFor = samples ? `（找${samples}）` : ''
      return {
        blocked: true,
        reason: allowUnknown
          ? `无方向词${lookFor}｜看不到 JD`
          : `标题和 JD 都无方向词${lookFor}`,
        meta,
      }
    }
    if (!pool.some((id) => f.directions.includes(id))) {
      // 标签本身带斜杠（「产品 / 新媒体运营」），用 '/' 连接多个会糊成一串认不出来，
      // 所以只念第一个 + 「等 N 类」。这句话的作用是让用户一眼判断「是不是误杀」，不是报全量。
      const first = dirLabel(pool[0])
      const more = pool.length > 1 ? `等 ${pool.length} 类` : ''
      return {
        blocked: true,
        // 同上：先说「它是什么方向」比说「你投什么」有用 —— 前者是判据，后者用户自己知道
        reason: `是「${first}」${more}方向`,
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
  // 城市优先用「标题附近」那段窄文本；拿不到才退回整页（整页里城市不可信，见 cityTextNearTitle）
  const cityText = cityTextNearTitle()
  const screen = screenJob(
    {
      jobTitle: info.jobTitle,
      company: info.company,
      jdText: jobBodyText(),
      metaText:
        cityText || (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 1500),
    },
    f
  )
  // 「全国」岗位不自动投（列表页那关会把它收进待定）。走到详情页还判成
  // pending 说明是在手动投/续跑旧队列 —— 这一家同样不投，理由照实说。
  if (screen.pending) return { blocked: true, reason: `筛选跳过：${screen.reason}（不消耗额度）` }
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
    // 方向：投的这一刻标题就在眼前，判得最准（后端语料兜底只对老岗位有效）
    direction: directionOf(info.jobTitle),
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
  // 探活：popup 跳转页面后要等脚本注入完成才能发批量指令。
  // 没有这个探针就只能「发一次失败 → 猜是不是没注入」，页慢一点就误报。
  if (msg.action === 'ping') {
    sendResponse({ ok: true, platform: platform() })
    return
  }

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

  // BOSS 聊天页逐条采集：**会真的点击左侧会话行**，点开才能拿到岗位名 / 已读 / 对方回复。
  // ⚠️ 点开会把对方发来的未读消息标成已读（HR 那边能看到「已读」），所以筛选交给 collector，
  // 默认只点「已读 / 对方最后发言」的，不碰「我发了对方还没看」的那批。
  if (msg.action === 'collectChat') {
    const c = window.__jhCollector
    if (!c) {
      sendResponse({ ok: false, error: '采集器脚本未加载，请重新加载扩展' })
      return
    }
    ;(async () => {
      try {
        const data = await c.collectChatDetails({ scope: msg.scope || 'interactive', max: msg.max })
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
  // 当前页面的岗位信息（只读）：弹窗拿它去后端取「这个岗位该用什么话术」
  if (msg.action === 'jobInfo') {
    try {
      const info = extractJobInfo() || {}
      sendResponse({
        ok: true,
        platform: platform(),
        jobId: currentJobId(),
        company: info.company || '',
        jobTitle: info.jobTitle || '',
        url: location.href,
      })
    } catch (e) {
      sendResponse({ ok: false, error: e.message })
    }
    return false
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
    startBatch(msg.limit, msg.force, {
      pagingConfig: msg.pagingConfig,
      kwUrls: msg.kwUrls,
      kwIndex: msg.kwIndex,
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  if (msg.action === 'batchStop') {
    stopBatch().then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  // 「全国」待定岗位：用户点了「加进队列」才投这几家
  if (msg.action === 'batchAdoptPending') {
    adoptPending(msg.indexes).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
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
  const pending = []
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
    // 「全国」岗位：不进队列（不自动投），但要留下列表让用户自己决定
    if (screen.pending) {
      pending.push({ id, url: clean, title: truncate(title, 40), city: screen.city || '全国', reason: screen.reason })
      return
    }
    if (screen.blocked) {
      blocked.push({ title: truncate(title, 40), reason: screen.reason })
      return
    }
    out.push({ id, url: clean, title: truncate(title, 40) })
  })
  // allIds = 这一页**认到的全部岗位 id**（含已投过 / 被筛掉 / 待定的）。
  // 「可投的」一条都没有时，只有它还能回答「翻页到底有没有换内容」
  // —— 否则第 2 页全是已投过的岗位时，links 是空的，跟第 1 页一模一样，
  //    永远分不清「翻页没生效」和「这页真的都是重复的」。
  return { links: out, blocked, appliedSkip, pending, allIds: [...seen] }
}

/**
 * 在详情页点「启动」时接管旧队列：不重新抓链接，直接把上一批复活，从停下的那家继续。
 *
 * 为什么需要：「启动」的本质是**建队列**，队列只能从列表页 DOM 里抓出来；
 * 详情页只有一个岗位链接，抓不出一页 → 以前一律拒绝，用户停在详情页想接着投
 * 就必须先退回列表页重新抓一遍，直觉上说不通（2026-11-05 实测反馈）。
 * 但只要还有没跑完的旧队列，重新抓本来就没必要。
 *
 * 返回 null = 没有可续跑的队列（交回调用方报「没抓到链接」）。
 */
// ===== 翻页：页码就在地址里 =====
// 实习僧 / BOSS 的搜索页都用 `page` 参数翻页，所以翻页不用去点「下一页」按钮 ——
// 改参数跳过去就行。好处是目标 URL 是确定的：可以用「新页抓到哪些岗位」反推它到底翻成功没有。
function stripPageUrl(u) {
  try {
    const x = new URL(u)
    for (const k of ['page', 'p', 'pageNum']) x.searchParams.delete(k)
    x.hash = ''
    return x.toString()
  } catch {
    return ''
  }
}

function pageUrlOf(base, n) {
  try {
    const x = new URL(base)
    x.searchParams.set('page', String(n))
    return x.toString()
  } catch {
    return ''
  }
}

// ===== 关键词轮换：一个词投到底，自动换下一个词 =====
// 为什么需要：一个搜索词在某个城市通常只对应 20~40 个岗位，投完就没了
// （2026-11-05：「测试 + 深圳 + 校招」翻两页共 0 家可投）。换词是唯一能继续加量的办法，
// 但每换一次都要回网站改条件、回弹窗点启动 —— 所以排成队列，一批词自动一个个跑。
//
// 关键词列表存在 **batch** 上、不塞进 paging：翻页 / 扫描 / 续跑三条路径都会整体重写 paging，
// 重写就丢字段；batch 是这三条路径共同的读写对象。
function kwListOf(b) {
  return b && Array.isArray(b.kwUrls) ? b.kwUrls : []
}

/**
 * 第 i 个搜索任务叫什么（从地址里现读，不另存一份，避免两处不一致）。
 * 多城市时 kwUrls 里每一项是「城市 × 关键词」的组合，所以要显示成「深圳·软件测试」，
 * 否则跑到第 5 个时用户会以为插件把同一个词跑了两遍。
 */
function kwNameOf(b, i) {
  const u = kwListOf(b)[Number(i) || 0]
  if (!u) return ''
  const F = window.JH_FILTERS
  if (F && typeof F.taskNameOf === 'function') {
    const n = F.taskNameOf(u)
    if (n) return n
  }
  try {
    return new URL(u).searchParams.get('keyword') || ''
  } catch (_) {
    return ''
  }
}

/** 还有下一个关键词吗？有就给出「跳到哪、第几个、一共几个」 */
function nextKeywordOf(b) {
  const list = kwListOf(b)
  const i = Number(b && b.kwIndex) || 0
  // 边界判断走 collector 的纯函数（有单测）：写错只会让最后一个词跑两遍或少跑一个，
  // 两种都不报错，只体现在投递量上 —— 那种 bug 在真机上极难发现
  const C = window.__jhCollector
  const nxt =
    C && typeof C.nextKeywordIndex === 'function'
      ? C.nextKeywordIndex(list.length, i)
      : list.length >= 2 && i + 1 < list.length
        ? i + 1
        : -1
  if (nxt < 0) return null
  return { url: list[nxt], index: nxt, total: list.length }
}

/**
 * 换词后的翻页状态：页码归 1、翻页计数归零、上一页集合清空。
 *
 * lastPageIds / lastAllIds 必须清空：它们是「这一页 vs 上一页有没有变」的对照物，
 * 而新关键词的列表跟旧词本来就不是一回事 —— 留着会让自检误判成「翻页没生效」。
 * seenIds 同理清空（跨词去重交给本地账本，不靠这个集合）。
 */
function resetPagingForKey(p, url) {
  return {
    ...p,
    scanOnly: false,
    page: 1,
    pagesDone: 0,
    baseUrl: stripPageUrl(url),
    lastPageIds: [],
    lastAllIds: [],
    seenIds: [],
    pendingPage: true,
    stopped: '',
  }
}

async function resumeExistingBatch() {
  const old = await getBatch()
  if (!old || !Array.isArray(old.queue) || !old.queue.length) return null
  const total = old.queue.length
  const index = Math.max(0, Number(old.index) || 0)
  if (index >= total) return null // 上一批已经跑完，没得续

  const now = Date.now()
  const { greeting = '' } = await chrome.storage.local.get('greeting')
  const samePage = jobIdOf(old.queue[index]) === jobIdOf(location.href)
  const b = {
    ...old,
    running: true,
    line: lineOfPlatform(platform()),
    tabId: await myTabId(),
    greeting: String(greeting || old.greeting || '').trim(),
    stopReason: '',
    failStreak: 0,
    lastAt: new Date(now).toISOString(),
    // 当前页就是该投的那家 → 跳转基准设成「刚刚」，别被当成还在加载；
    // 不是那家 → 设成 1 分钟前，让 resumeBatch 立刻跳过去（否则要白等 15 秒）
    jumpedAt: new Date(samePage ? now : now - 60000).toISOString(),
    jumpAttempts: 0,
    // 手动续跑时清掉「待翻页」：队列已经存在，再让 bootNextPage 抓一次会把同一页开成两批
    paging: old.paging ? { ...old.paging, pendingPage: false } : old.paging,
    startedAt: old.startedAt || new Date(now).toISOString(),
  }
  await setBatch(b)
  // 页面早就加载完了，不会再触发 DOMContentLoaded 里的 resumeBatch → 主动推一把
  setTimeout(resumeBatch, 300)

  let filters = ''
  try {
    filters = describeFilters(await getJobFilters())
  } catch (_) {
    /* 描述筛选失败不该影响续跑 */
  }
  return {
    ok: true,
    resumed: true,
    line: b.line,
    total: total - index,
    done: index,
    all: total,
    blocked: 0,
    appliedSkip: 0,
    filters,
  }
}

/** 当前磁盘上这份扩展的版本号（弹窗用它区分「这批是不是旧脚本跑的」） */
function scriptVersion() {
  try {
    return chrome.runtime.getManifest().version
  } catch (_) {
    return ''
  }
}

/** 「这页为什么一家都投不了」—— 规则在 collector 的 emptyPageReason（纯函数、有单测） */
function reasonOfPage({ allIds, blocked, appliedSkip, pending }) {
  // 页号从地址里读（翻页是改 page 参数跳过来的，地址就是事实）。
  // 判「第 2 页空了该怎么说」全靠它 —— 翻到后面空了是「到底了」，
  // 起始页空了才是「不在列表页」，两句话不能混（2026-11-05 真机 SDET 只有 1 页）
  let pageNo = 1
  try {
    pageNo = Math.max(1, Number(new URL(location.href).searchParams.get('page')) || 1)
  } catch (_) {
    pageNo = 1
  }
  const C = window.__jhCollector
  if (C && typeof C.emptyPageReason === 'function') {
    return C.emptyPageReason({
      total: (allIds || []).length,
      appliedSkip,
      blockedCount: (blocked || []).length,
      pendingCount: (pending || []).length,
      // 举例用**岗位标题**而不是原因：用户看到「Quality Assurance Intern」才知道
      // 是自己想投的被误杀、还是本来就该拦；只给原因（「标题里没有…这类词」）等于自证清白
      blockedFirst: blocked && blocked[0] ? (blocked[0].title || blocked[0].reason) : '',
      page: pageNo,
    })
  }
  return `本页 ${(allIds || []).length} 家都没有可投的岗位`
}

/**
 * 本页一家可投的都没有时，如果开了「投完自动翻页」，就跳去下一页继续找。
 *
 * 为什么必须自动翻：点一次「一键投递」的承诺是「它自己干完」。可
 * 2026-11-05 真机卡在这里 —— 第 1 页 20 家里 15 家投过、2 家「全国」待定、
 * 3 家不符合筛选，可投的 0 家，于是直接报错收工，让人手动去翻页。
 * 既然翻页逻辑本来就有，就没有理由把「换一页」这件事丢回给人。
 *
 * @returns {Promise<object|null>} null = 不翻（没开翻页 / 已到上限 / 地址拼不出来）
 */
async function startPageScan({ why, limit, force, opts, allIds, pending, blocked, kw }) {
  const cfg = opts && opts.pagingConfig && opts.pagingConfig.enabled ? opts.pagingConfig : null
  const prev = opts && opts.paging && opts.paging.enabled ? opts.paging : null
  // 两个入口：① 一键投递首次启动（只有 pagingConfig）；② 翻过去一页又是空页（bootNextPage 传来 paging）
  if (!cfg && !prev) return null

  const baseUrl = (prev && prev.baseUrl) || stripPageUrl(location.href)
  if (!baseUrl) return null

  let pageNo = 1
  try {
    pageNo = Math.max(1, Number(new URL(location.href).searchParams.get('page')) || 1)
  } catch (_) {
    pageNo = 1
  }

  const maxPages = Math.max(1, Math.min(10, Number((prev && prev.maxPages) || (cfg && cfg.maxPages)) || 3))
  const pagesDone = Number((prev && prev.pagesDone) || 0)

  // 关键词队列：调用方传（首次启动）或沿用上一次批次（翻页接力）
  const oldB = await getBatch()
  const kwUrls =
    kw && Array.isArray(kw.kwUrls) && kw.kwUrls.length
      ? kw.kwUrls
      : oldB && Array.isArray(oldB.kwUrls)
        ? oldB.kwUrls
        : []
  const kwIndex = kw && typeof kw.kwIndex === 'number' ? kw.kwIndex : Number(oldB && oldB.kwIndex) || 0

  // maxPages 的语义 = **总共最多看几页（含当前这页）**，与「翻几次」不是一回事。
  // 口径必须和「投完翻页」那段一致（那里判 pagesDone + 1 < maxPages），
  // 否则同一次任务里，扫描能翻到第 3 页、投完翻页只能到第 2 页。
  if (pagesDone + 1 >= maxPages) {
    // 这个词的页数看完了 → 换下一个词；一个词的都没有了才真的收工
    const nk = nextKeywordOf({ kwUrls, kwIndex })
    if (!nk) return null
    await jumpToNextKeyword({ nk, prev, limit, force, from: why, kwUrls })
    return { ok: true, scanning: true, keyword: nk.index + 1, keywordTotal: nk.total, note: why }
  }

  const nextPage = pageNo + 1
  const jump = pageUrlOf(baseUrl, nextPage)
  if (!jump) return null

  const scanPaging = {
    enabled: true,
    scanOnly: true, // 还没开投，只是在找「有活可干」的那一页
    page: nextPage,
    pagesDone: pagesDone + 1,
    maxPages,
    done: 0,
    limit: Number(limit) || 10,
    force: !!force,
    baseUrl,
    // 「翻没翻动」由 lastAllIds 判：它记的是**当前这一页**认到的全部岗位
    // （含已投过 / 被筛掉的）。只记可投的没用 —— 扫描模式下可投的恒为 0。
    lastPageIds: [],
    lastAllIds: [...allIds],
    seenIds: (prev && Array.isArray(prev.seenIds)) ? prev.seenIds : [],
    pendingPage: true,
    stopped: '',
  }

  const scope = (window.__jhCollector && window.__jhCollector.searchScopeOf)
    ? window.__jhCollector.searchScopeOf(location.href)
    : { text: '', risky: '' }

  // 「全国」待定清单要**跨页累积**：第 1 页有 2 家、第 2 页有 1 家，
  // 直接覆盖的话前面那 2 家就消失了 —— 而它们正是要用户逐条决定的东西
  const prevPending = oldB && Array.isArray(oldB.pending) ? oldB.pending : []
  const pSeen = new Set(prevPending.map((x) => x.id))
  const mergedPending = [...prevPending]
  for (const x of pending || []) {
    if (!x || !x.id || pSeen.has(x.id)) continue
    pSeen.add(x.id)
    mergedPending.push(x)
  }

  // 被筛掉的岗位同理跨页累积（只按标题+原因去重，它们没有 id 之外的稳定标识）
  const prevBlocked = oldB && Array.isArray(oldB.blockedList) ? oldB.blockedList : []
  const bSeen = new Set(prevBlocked.map((x) => `${x.title}|${x.reason}`))
  const mergedBlocked = [...prevBlocked]
  for (const x of blocked || []) {
    const k = `${x.title}|${x.reason}`
    if (bSeen.has(k)) continue
    bSeen.add(k)
    mergedBlocked.push(x)
  }
  // 总数按页累加（跨页重复出现的岗位可能算两次 —— 这是给人看的量级，不做精确对账）
  const blockedTotal = (Number(oldB && oldB.blockedTotal) || 0) + (blocked || []).length

  await setBatch({
    running: true,
    codeVersion: scriptVersion(),
    scope: scope.text || '',
    scopeRisky: scope.risky || '',
    line: lineOfPlatform(platform()),
    tabId: await myTabId(),
    greeting: '',
    force: !!force,
    queue: [],
    titles: [],
    index: 0,
    results: [],
    failStreak: 0,
    // 扫描中不写 stopReason —— 它代表「结束了」。原因单放 scanNote，
    // 否则弹窗里「原因：…」和「正在往后翻…」并排出现，像已经停了
    stopReason: '',
    scanNote: why,
    jumpedAt: new Date().toISOString(),
    jumpAttempts: 0,
    startedAt: new Date().toISOString(),
    total: 0,
    paging: scanPaging,
    // 关键词队列必须跟着走：翻页会把整个批次状态重写一遍，漏带就变成「只剩一个词」
    kwUrls,
    kwIndex,
    // 同一个关键词的第 2、3 页：成功数和已跑完的词账都要接着带，否则「投 3 家」会变回「没投到」
    kwOk: Number(oldB && oldB.kwOk) || 0,
    kwStats: Array.isArray(oldB && oldB.kwStats) ? oldB.kwStats : [],
    pending: mergedPending.slice(0, 20),
    // 存 50 条而不是 20：一页就有 20 家、翻两页 40+，「只列前 20 条」等于后一半永远看不到 ——
    // 而被拦的恰恰是需要人眼复核的东西（2026-11-05：56 家只露出 20 条）
    blockedList: mergedBlocked.slice(0, 50),
    blockedTotal,
  })

  setTimeout(() => {
    location.href = jump
  }, 150)

  return { ok: true, scanning: true, page: nextPage, maxPages, note: why }
}

/**
 * 一个关键词跑完后的「账」：翻了几页、投了几家、拦了几家。
 *
 * 为什么必须单独记：换词时 batch 被整体重置（queue / results / total 全部归零），
 * 上一个词的战果就地蒸发 —— 用户按一次「一键投递」跑了 4 个词，
 * 弹窗最后只剩第 4 个词的结果，前 3 个投了什么都看不见（2026-11-05 真机：
 * 最后一句是 SDET 的「3 家都被筛选拦掉」，实际前 3 个词投没投过完全无从得知）。
 * 一站式跑完，就得给一份一站的账。
 */
function kwStatLine(b, note) {
  const i = Number(b && b.kwIndex) || 0
  const n = kwListOf(b).length
  const kw = kwNameOf(b, i) || `第 ${i + 1} 个`
  const res = (b && b.results) || []
  // kwOk = 这个词**跨页累积**的成功数。每页 startBatch 都会把 results 清零，
  // 只数 results 会把「第 1 页投了 3 家」当成没投过
  const ok = Number(b && b.kwOk) || res.filter((r) => r.ok).length
  const skip = res.filter((r) => r.skipped).length
  const pages = Number(b && b.paging && b.paging.page) || 1
  const blocked = Number(b && b.blockedTotal) || ((b && b.blockedList) || []).length
  const head = n > 1 ? `第 ${i + 1}/${n} 个「${kw}」` : `「${kw}」`
  const parts = [`翻 ${pages} 页`, ok ? `投 ${ok} 家` : '没投到']
  if (skip) parts.push(`跳过 ${skip}`)
  if (blocked) parts.push(`拦 ${blocked} 家`)
  return `${head}：${parts.join('、')}${note ? ` —— ${truncate(note, 40)}` : ''}`
}

/** 把某个词的账合并进 batch.kwStats（同一个词只留最后一次 —— 换词/收尾会重复调用） */
function withKwStat(b, note) {
  const i = Number(b && b.kwIndex) || 0
  const line = kwStatLine(b, note)
  const res = (b && b.results) || []
  // ok / pages 单独存一份结构化字段：弹窗要按它们算「本轮一共投了几家」，
  // 从人话字符串里正则抠数字迟早出错
  const ok = Number(b && b.kwOk) || res.filter((r) => r.ok).length
  const pages = Number(b && b.paging && b.paging.page) || 1
  const list = (Array.isArray(b && b.kwStats) ? b.kwStats : []).filter((x) => x && x.i !== i)
  list.push({ i, line, ok, pages })
  list.sort((a, c) => a.i - c.i)
  return list.slice(-20)
}

/**
 * 换到下一个关键词：写状态 + 跳过去。
 *
 * 两条路共用：① 这个词翻到底了（扫描里发现没页可看）；② 这个词的队列投完、页数也翻满了。
 * 换成两处各写一份的话，「换词时批次该长什么样」迟早会分叉 —— 这是本项目的老毛病。
 *
 * 关键：**队列清空、页码归 1、翻页计数归零**，否则新词会接着旧词的进度跑，
 * 一落地就判「已经翻满」直接收工。
 */
async function jumpToNextKeyword({ nk, prev, limit, force, from, kwUrls }) {
  const name = kwNameOf({ kwUrls }, nk.index)
  const note = `${from}，换下一个搜索「${name || `第 ${nk.index + 1} 个`}」（第 ${nk.index + 1}/${nk.total} 个）`
  const base =
    prev && prev.enabled
      ? prev
      : {
          enabled: true,
          page: 1,
          pagesDone: 0,
          maxPages: 1,
          done: 0,
          limit: Number(limit) || 10,
          force: !!force,
          baseUrl: stripPageUrl(nk.url),
        }
  const old = (await getBatch()) || {}
  await setBatch({
    ...old,
    running: true,
    codeVersion: scriptVersion(),
    line: lineOfPlatform(platform()),
    tabId: await myTabId(),
    queue: [],
    titles: [],
    index: 0,
    results: [],
    // 上一个词的账先落盘再清空 —— 顺序反了就什么都不剩
    kwStats: withKwStat(old, from),
    kwOk: 0,
    // ⚠️ 拦截清单 / 计数必须按**词**清零：它们是「这个词为什么没投到」的证据，
    // 留着上一个词的会串账 —— 新词第 1 页若 0 可投会走 startPageScan，那里做的是
    // 「旧数 + 本页数」，于是「被筛选拦掉 56 家」里其实混着上个词的 40 家，
    // 各词总账的「拦 N 家」也跟着虚高（2026-11-05 真机：56 家里有 40 家属上一个词）
    blockedList: [],
    blockedTotal: 0,
    failStreak: 0,
    total: 0,
    stopReason: '',
    scanNote: note,
    // 范围必须清掉：这一批的 scope 是上一个词的，留着会让人以为现在还在跑旧词
    scope: '',
    scopeRisky: '',
    kwUrls,
    kwIndex: nk.index,
    paging: resetPagingForKey(
      { ...base, limit: Number(limit) || base.limit || 10, force: !!force },
      nk.url
    ),
    jumpedAt: new Date().toISOString(),
    jumpAttempts: 0,
  })
  setTimeout(() => {
    location.href = nk.url
  }, 200)
  return true
}

async function startBatch(limit, force, opts = {}) {
  // 关键词队列：一键投递时 popup 把每个词算成一条搜索页地址传进来，
  // 这里只负责带着它走（这个词投完了由 applyBatchResult / bootNextPage 接力换下一个）
  const kwUrls = Array.isArray(opts.kwUrls) ? opts.kwUrls.filter(Boolean).slice(0, 20) : []
  const kwIndex = Math.max(0, Number(opts.kwIndex) || 0)
  // 同一个关键词翻到下一批（pendingPage）时要把「这个词已经投了几家」带过来；
  // 用户从 popup 新开一轮则不带（opts 里没有）→ 自然归零
  const kwOk = Math.max(0, Number(opts.kwOk) || 0)
  const kwStats = Array.isArray(opts.kwStats) ? opts.kwStats : []
  opts = { ...opts, kwUrls, kwIndex, kwOk, kwStats }

  // 先算好筛选描述：后面一旦 setBatch 落盘，就不能再抛错，
  // 否则 popup 显示「启动失败」而批次其实已经在跑（状态和界面打架）
  let filtersText = ''
  try {
    filtersText = describeFilters(await getJobFilters())
  } catch (_) {
    filtersText = '⚠️ 筛选条件读不出来'
  }

  const onDetail = !!jobIdOf(location.href)

  // 详情页上「启动」＝ 接着投，不是重新开一批。
  // 这里放在抓链接**之前**：详情页里那些 inn_/job_detail 链接多是右侧「相似岗位」推荐，
  // 在这儿新建队列会把推荐位当成待投清单。
  if (onDetail) {
    const resumed = await resumeExistingBatch()
    if (resumed) return resumed
    return {
      ok: false,
      error:
        '当前停在岗位详情页：这里没有「一批岗位」可抓（只有当前这家和右侧「相似岗位」推荐），所以新建不了批次。\n要开新一批 → 回到搜索结果列表页点启动；想在详情页接着投 → 需要上一批还没跑完（跑来一批后中途停了，回到任意岗位页点启动就会从那里继续）。',
    }
  }

  const { links, blocked, appliedSkip = 0, pending = [], allIds = [] } = await collectJobLinks()
  if (!links.length) {
    // 一页岗位不能投，通常**几类原因叠加**（投过了 + 「全国」待定 + 被筛选拦）。
    // 只报一类会把另外几类盖住，看着像「插件坏了」或「页面到底了」（2026-11-05 真机）
    const why = reasonOfPage({ allIds, blocked, appliedSkip, pending })

    // 开了「投完自动翻页」就别报错收工，自己往后翻去找
    const scan = await startPageScan({ why, limit, force, opts, allIds, pending, blocked, kw: { kwUrls, kwIndex } })
    if (scan) return scan

    return { ok: false, error: why, blocked: blocked.length, appliedSkip, pending: pending.length, pendingList: pending.slice(0, 20) }
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

  // 这一批投什么范围：读 URL（页面事实），不读插件配置（可能没存上）
  const scope = (window.__jhCollector && window.__jhCollector.searchScopeOf)
    ? window.__jhCollector.searchScopeOf(location.href)
    : { text: '', risky: '' }
  const scopeText = scope.text || ''
  const scopeRisky = scope.risky || ''

  const asked = Math.min(Number(limit) || 10, BATCH_MAX)
  // remain = -1 表示该平台设成了「不限」
  const cap = remain > 0 ? Math.min(asked, remain) : asked
  const shrunk = cap < asked
  const queue = links.slice(0, cap)

  // ===== 翻页状态 =====
  // opts.paging       = 续页（bootNextPage 已经算好的完整对象，原样带过来）
  // opts.pagingConfig = 首次启动时的配置 { enabled, maxPages }
  //
  // 为什么要存 baseUrl / lastPageIds / seenIds：
  //   翻页最容易出的问题不是「翻不动」，而是**看着翻了、其实没翻**（站点忽略 page 参数）。
  //   有了这三个字段，下一页抓完可以立刻自检：集合和第上一页一模一样 = 没翻成功；
  //   全是见过的 = 已经到底了。两条都在**投任何一家之前**就能判出来，不用等跑空。
  let paging = opts && opts.paging ? opts.paging : null
  if (!paging && opts && opts.pagingConfig && opts.pagingConfig.enabled) {
    const ids = queue.map((x) => jobIdOf(x.url)).filter(Boolean)
    // 从**当前页**开始算：用户可能已经翻到第 3 页才点「只启动当前页」，
    // 这里若固定写 1，翻页会从第 2 页接上，把前面几页重新投一遍
    let startPage = 1
    try {
      startPage = Math.max(1, Number(new URL(location.href).searchParams.get('page')) || 1)
    } catch (_) {
      startPage = 1
    }
    paging = {
      enabled: true,
      page: startPage,
      // pagesDone = 已经翻了几次；maxPages = 总共最多看几页（含起始页），两处判据必须同口径
      pagesDone: 0,
      maxPages: Math.max(1, Math.min(10, Number(opts.pagingConfig.maxPages) || 3)),
      done: 0,
      limit: asked,
      force: !!force,
      baseUrl: stripPageUrl(location.href), // 翻页基准（去掉 page，自己拼 page=N）
      lastPageIds: ids,
      lastAllIds: allIds,
      seenIds: ids,
      pendingPage: false,
      stopped: '',
    }
  }

  const batch = {
    running: true,
    // 跑这一批的脚本版本。popup 会拿它和当前版本比：
    // 改完代码没重载扩展/没刷新页面时，页面里跑的还是旧脚本，
    // 但旧批次在弹窗里看起来就像「刚跑的结果」—— 2026-11-05 就这么误判过一次。
    codeVersion: scriptVersion(),
    // 这一批投的是什么范围（关键词 / 城市 / 类型）—— 直接读 URL，不读插件配置：
    // 配置可能没存上，URL 才是页面事实。留空关键词会投全城，必须一直显示着。
    scope: scopeText,
    scopeRisky: scopeRisky,
    // 这条线属于哪个平台：popup 与 resumeBatch 都靠它判断归属
    // ⚠️ 必须把 platform() 传进去：lineOfPlatform() 无参时返回 'other'，
    // popup 就认不出这条批次属于实习僧还是 BOSS
    line: lineOfPlatform(platform()),
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
    // 投完这一批要不要翻页（null = 不翻）
    paging,
    // 这轮一共排了几个关键词、现在是第几个（popup 显示「关键词 2/5」）。
    // 空数组 = 单关键词模式（从「启动这条线」进来就是这种），不轮换。
    kwUrls,
    kwIndex,
    // 跨页累积：这个词已经投了几家 + 前面几个词的账
    kwOk,
    kwStats,
    // 写「全国」的岗位：没进队列（不自动投），留在这里等用户决定
    // 上限 20 条：只是给人看的清单，不需要全量
    pending: pending.slice(0, 20),
    // 被筛选拦掉的岗位（同样只是给人看的）：
    // 光有「16 家不符合筛选」用户没法判断是筛选正常工作还是误杀 —— 列出标题他一点就知道
    blockedList: blocked.slice(0, 50),
    blockedTotal: blocked.length,
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
    // 启动时把这次用的筛选条件说出来：筛选是静默生效的，配错了不会报错，
    // 只会安静放行不该投的岗位（2026-11-05 投出西安岗位就是这么来的）
    filters: filtersText,
    // 这次投的范围（关键词 / 城市 / 类型）：直接从 URL 读，配错了一眼看得出
    scope: scopeText,
    scopeRisky: scopeRisky,
    // popup 用来说清楚「这是第几页 / 一共打算翻几页」
    paging: paging ? { page: paging.page, maxPages: paging.maxPages } : null,
    // 这轮排了几个关键词（>1 = 会轮换），popup 用它提示「后面还有几个词」
    keywords: kwUrls.length,
    keywordIndex: kwIndex,
    // 「全国」待定：数量 + 清单（标题 / 城市 / 链接），由用户逐个决定要不要投
    pending: pending.length,
    pendingList: pending.slice(0, 20),
  }
}

async function stopBatch() {
  const b = await getBatch()
  if (!b) return { ok: true, message: '没有进行中的批量任务' }
  await setBatch({
    ...b,
    running: false,
    stopReason: '已手动停止',
    // 必须清掉「待翻页」：否则下次打开这个页面，bootNextPage 会自己接着翻，
    // 用户明明点了停止却在几小时后自己动起来
    paging: b.paging ? { ...b.paging, pendingPage: false } : b.paging,
  })
  return { ok: true, message: '已停止（当前这家投完就停）' }
}

/**
 * 把「全国」待定岗位加进队列（用户点了才加）。
 *
 * 为什么要这一步：「全国」既不是本地也不是异地。自动投可能投到北京（2026-11-05 教训），
 * 当异地丢掉又会漏掉真在深圳的。所以默认只列出来，由人看一眼岗位再决定。
 *
 * 不打断正在跑的批次：只有「已经停下来」时才跳转，否则只往后追加，等它自然接上。
 */
async function adoptPending(indexes) {
  const b = await getBatch()
  if (!b) return { ok: false, error: '没有批量任务记录' }
  const list = Array.isArray(b.pending) ? b.pending : []
  if (!list.length) return { ok: false, error: '没有待定岗位' }

  const want = Array.isArray(indexes) && indexes.length ? indexes : list.map((_, i) => i)
  const pick = want.map((i) => list[i]).filter(Boolean)
  if (!pick.length) return { ok: false, error: '没选中任何待定岗位' }

  const queue = [...(b.queue || [])]
  const titles = [...(b.titles || [])]
  const oldLen = queue.length
  let added = 0
  for (const p of pick) {
    if (!p || !p.url || queue.includes(p.url)) continue
    queue.push(p.url)
    titles.push(p.title || p.url)
    added++
  }
  if (!added) return { ok: false, error: '这些岗位已经在队列里了' }

  const pickUrls = new Set(pick.map((p) => p && p.url))
  const keep = list.filter((p) => !pickUrls.has(p && p.url))

  // 从哪儿接着跑：
  //   ① 旧队列还有没跑的（index < oldLen）→ 从 index 接着，不能跳过它们直接跳到新加的
  //   ② 旧队列已经跑完 → 从新加的第一家开始
  const index = Number(b.index) || 0
  const hasUnfinished = index < oldLen
  const startAt = hasUnfinished ? index : oldLen
  // 正在跑就别打断，只往后追加，等它自然接上
  const needJump = !b.running || !hasUnfinished

  await setBatch({
    ...b,
    queue,
    titles,
    pending: keep,
    // 认领权转给当前这个标签页：后续推进要由「正在跑的那个页面」做，
    // 否则用户在另一个同平台标签页点「加入」，跳转发生在这里、而旧页以为自己还是主人
    tabId: await myTabId(),
    total: queue.length,
    index: startAt,
    running: true,
    stopReason: '',
    lastAt: new Date().toISOString(),
    jumpedAt: new Date().toISOString(),
    jumpAttempts: 0,
    // 手动加进来的岗位不受「翻页」管：翻页状态保留但清掉待翻标记，避免刚加完又去翻页
    paging: b.paging ? { ...b.paging, pendingPage: false } : b.paging,
  })

  if (needJump) {
    const target = queue[startAt]
    setTimeout(() => {
      location.href = target
    }, 450)
    return { ok: true, added, index: startAt, total: queue.length, jumped: true }
  }
  return { ok: true, added, index: startAt, total: queue.length, jumped: false }
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
  let pagingNext = nb.paging || null
  let pageJump = ''
  let kwNextIndex = Number(nb.kwIndex) || 0
  // 这个词跨页累积的成功数（每页都会清零 results，只数 results 会把前面几页投的全忘掉）
  let kwOkNext = (Number(nb.kwOk) || 0) + (res.ok ? 1 : 0)
  let kwStatsNext = Array.isArray(nb.kwStats) ? nb.kwStats : []
  // 这个词是不是到此为止了（不再翻页、也不再换词）→ 该把账落下来了
  let kwFinishedNote = ''
  if (running && nextIndex >= nb.queue.length) {
    running = false
    const okN = results.filter((r) => r.ok).length
    const skipN = results.filter((r) => r.skipped).length
    const failN = results.length - okN - skipN
    stopReason = `本批 ${nb.queue.length} 家已全部执行完（成功 ${okN} / 跳过 ${skipN} / 失败 ${failN}）`

    // 本批跑完 → 看还有没有下一页。这里只是**跳过去**，下一页行不行由 bootNextPage 自检，
    // 因为「翻页到底成没成功」只有抓到新页的岗位集合才能判。
    const p = nb.paging
    // maxPages = **总共最多看几页（含当前这页）**，不是「翻几次」。
    // 口径要和 startPageScan 一致，否则扫描和投完翻页能到的页数不一样。
    if (p && p.enabled && (p.pagesDone || 0) + 1 < p.maxPages) {
      const nextPage = p.page + 1
      const jump = pageUrlOf(p.baseUrl, nextPage)
      if (jump) {
        pageJump = jump
        pagingNext = {
          ...p,
          page: nextPage,
          pagesDone: (p.pagesDone || 0) + 1,
          done: (p.done || 0) + results.length,
          pendingPage: true,
          stopped: '',
        }
        stopReason = `第 ${p.page} 页投完（成功 ${okN}/跳过 ${skipN}/失败 ${failN}），正在翻到第 ${nextPage} 页`
      } else {
        pagingNext = { ...p, stopped: '翻页地址拼不出来（起始页地址缺失）' }
        stopReason += '｜翻页已停：起始页地址缺失'
      }
    } else if (p && p.enabled) {
      // 这个词的页数看完了 → 先看还有没有下一个词（多关键词轮换），没有才真的收工
      const nk = nextKeywordOf(nb)
      if (nk) {
        pageJump = nk.url
        pagingNext = resetPagingForKey(p, nk.url)
        kwNextIndex = nk.index
        // 说「翻满 N 页」而不是「翻到底了」：这个分支是**页数上限**触发的，
        // 不是真的没有下一页了。两者混用会让用户以为「就该这么多岗位」（2026-11-05 真机）
        stopReason = `「${kwNameOf(nb, nb.kwIndex)}」翻满设定的 ${p.maxPages} 页（本页成功 ${okN}/跳过 ${skipN}/失败 ${failN}），换下一个搜索「${kwNameOf(nb, nk.index)}」（第 ${nk.index + 1}/${nk.total} 个）`
        kwFinishedNote = `翻满 ${p.maxPages} 页`
      } else {
        pagingNext = { ...p, stopped: `已翻满设定的 ${p.maxPages} 页` }
        stopReason += `｜已翻满设定的 ${p.maxPages} 页上限`
        const n = kwListOf(nb).length
        // 「搜索」不是「关键词」：多城市时列表里是「城市 × 关键词」的组合，
        // 说「3 个关键词都跑完了」会让人以为只跑了 3 个词，其实可能是 2 城 × 3 词 = 6 轮
        if (n > 1) stopReason += `（${n} 个搜索都跑完了）`
        kwFinishedNote = `翻满 ${p.maxPages} 页`
      }
    } else {
      // 队列投完了但没开翻页 / 或本批因风控·结构失败提前停 → 这个词也到此为止
      kwFinishedNote = '本批结束'
    }
  } else if (!running) {
    // 风控 / 页面结构对不上 / 连续失败：整批提前收工，这个词的账也要留下
    kwFinishedNote = truncate(stopReason, 36)
  }

  if (kwFinishedNote) {
    kwStatsNext = withKwStat({ ...nb, results, kwOk: kwOkNext }, kwFinishedNote)
    // 换了词 → 成功数归零，别把上一个词的 3 家算到新词头上
    if (kwNextIndex !== (Number(nb.kwIndex) || 0)) kwOkNext = 0
  }

  await setBatch({
    ...nb,
    results,
    failStreak,
    running,
    index: nextIndex,
    stopReason,
    paging: pagingNext,
    kwIndex: kwNextIndex,
    kwOk: kwOkNext,
    kwStats: kwStatsNext,
    lastAt: new Date().toISOString(),
  })

  // 翻页优先于一切：跳过去之后由新页面接管（bootNextPage）
  if (pageJump) {
    await sleep(1200)
    location.href = pageJump
    return { running: false, nextIndex, stopReason, paging: true }
  }

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

/**
 * 翻页接力：上一页投完跳过来的这一页，在这里自检 + 开新一批。
 *
 * 自检三条，全部在**投任何一家之前**跑完：
 *   ① 一页岗位都没抓到 → 到底了 / 被筛选全拦，停；
 *   ② 抓到的 jobId 集合和上一页**完全一样** → 翻页没生效（站点忽略了 page 参数），停；
 *   ③ 全是已经见过的 jobId → 后面的页都是重复岗位，停。
 * 这三条 1 秒内就能判出来，不用等投了几家才发现整批在原地打转。
 *
 * 为什么能这么判：翻页是**改 URL 参数跳过去的**（不是点按钮），所以「预期应该看到哪一页」
 * 是确定的；拿实际抓到的集合和上一页比，既不用猜分页组件的 class，也不受改版影响。
 */
async function bootNextPage() {
  const b = await getBatch()
  if (!b || !b.paging || !b.paging.pendingPage) return false
  const p = b.paging
  const pageNo = p.page

  const stopPaging = async (why) => {
    await setBatch({
      ...b,
      running: false,
      paging: { ...p, pendingPage: false, stopped: why },
      stopReason: why,
      // 收工前把这个词的账也记下来：多关键词轮换时，用户最后看到的应该是一张
      // 「4 个词各自投了几家」的总表，不是只剩最后一个词的糊涂账
      kwStats: withKwStat(b, '到底了'),
    })
    // popup 可能已经关了，结果落盘，下次打开能看到为什么停
    try {
      await chrome.storage.local.set({
        lastOneKeyResult: { ok: false, error: why, at: new Date().toISOString() },
      })
    } catch (_) {
      /* 落盘失败不影响停 */
    }
    return true
  }

  let { links, blocked = [], appliedSkip = 0, pending = [], allIds = [] } = await collectJobLinks()

  // 列表是前端渲染的：跳过来那一刻可能还没画出来。空页先等一拍再重抓一次，
  // 否则「还没渲染」会被当成「这页没岗位」→ 非扫描分支里就会误判成「到底了」，
  // 直接跳到下一页/下一个词 —— 轻则漏一页，重则每个词都只看一眼就走（2026-11-05 换词时新增）
  if (!allIds.length) {
    await sleep(2500)
    ;({ links, blocked = [], appliedSkip = 0, pending = [], allIds = [] } = await collectJobLinks())
  }

  const ids = links.map((x) => x.id).filter(Boolean)

  // ===== 扫描模式：前几页都没活可干，这一页是翻过来找的 =====
  // 这时候可投的本来就是 0，「翻没翻动」只能看**认到的全部岗位**有没有变。
  // 只看可投的会永远分不清「page 参数没生效」和「这页真的都是重复的」。
  if (p.scanOnly) {
    let cur = { links, blocked, appliedSkip, pending, allIds }

    // 列表是前端渲染的：脚本注入那一刻可能还没画出来。空页先等一拍再判，
    // 否则会把「还没渲染」当成「这页没岗位」，一路翻到上限 —— 那就是空转。
    if (!cur.allIds.length) {
      await sleep(2500)
      cur = await collectJobLinks()
    }
    const curIds = cur.links.map((x) => x.id).filter(Boolean)

    const C = window.__jhCollector
    const sameAsPrev =
      cur.allIds.length &&
      (p.lastAllIds || []).length &&
      C &&
      typeof C.sameIdSet === 'function' &&
      C.sameIdSet(cur.allIds, p.lastAllIds)
    if (sameAsPrev) {
      return stopPaging(
        `翻页自检：第 ${pageNo} 页和第 ${pageNo - 1} 页的岗位完全一样 —— 翻页没生效（page 参数没起作用），已停止，避免原地空转`
      )
    }

    if (cur.links.length) {
      // 终于翻到有活可干的页 → 转成正常批次开投
      const seen = new Set(p.seenIds || [])
      const nextPaging = {
        ...p,
        scanOnly: false,
        pendingPage: false,
        lastPageIds: curIds,
        lastAllIds: cur.allIds,
        seenIds: [...seen, ...curIds],
        stopped: '',
      }
      try {
        const res = await startBatch(p.limit || 10, p.force, {
          paging: nextPaging,
          kwUrls: b.kwUrls,
          kwIndex: b.kwIndex,
          kwOk: Number(b.kwOk) || 0,
          kwStats: b.kwStats,
        })
        if (!res.ok) {
          await setBatch({
            ...(await getBatch()),
            running: false,
            paging: { ...nextPaging, pendingPage: false, stopped: res.error || '启动失败' },
            stopReason: `第 ${pageNo} 页没能开投：${res.error || '未知原因'}`,
          })
        }
        try {
          await chrome.storage.local.set({ lastOneKeyResult: { ...res, at: new Date().toISOString() } })
        } catch (_) {
          /* 落盘失败不影响投递 */
        }
      } catch (e) {
        await setBatch({
          ...b,
          running: false,
          paging: { ...p, pendingPage: false },
          stopReason: `翻页启动异常：${e.message}`,
        })
      }
      return true
    }

    // 这页也没活可干 → 接着往后翻；到上限 startPageScan 返回 null
    const why = reasonOfPage(cur)
    const scan = await startPageScan({
      // 「本页 17 家：…」→「第 2 页 17 家：…」，否则和其它地方拼起来会出现「本页：本页…」
      why: why.replace(/^本页 /, `第 ${pageNo} 页 `),
      limit: p.limit,
      force: p.force,
      opts: { paging: p },
      allIds: cur.allIds,
      pending: cur.pending,
      blocked: cur.blocked,
    })
    if (scan) return true
    // 走到这儿有两种完全不同的收场，不能共用一句「已到上限」：
    //   ① 这一页**一个岗位都没有** → 这个搜索条件就这么几页，是真到底了；
    //      再说「最多看 N 页」会让用户以为「要不是我设了 2 页，还能再翻出岗位」。
    //   ② 这一页有岗位但都被拦 → 确实是页数上限卡住的，该提示调大上限或换条件。
    if (!cur.allIds.length) {
      // why 本身已经说完（「第 N 页没有岗位了（只有 N-1 页）」），
      // 再补一句「翻到这里就没岗位了」是同义反复 —— 弹窗里两句话占三行，还互相解释
      return stopPaging(why)
    }
    return stopPaging(
      `${why}｜已到设定的上限（最多看 ${p.maxPages} 页），没找到还有新岗位的页 —— 这个搜索条件基本投到底了，换个关键词或城市`
    )
  }

  // 判定规则在 collector 的 checkPageFresh（纯函数、有单测），这里只负责把原因说成人话
  const c = window.__jhCollector
  if (!c || typeof c.checkPageFresh !== 'function') {
    return stopPaging('翻页自检不可用（collector 没加载），为安全起见停止翻页')
  }
  const chk = c.checkPageFresh(ids, p.lastPageIds, p.seenIds)
  if (!chk.ok) {
    // 「这页 0 条」有两种完全不同的原因：真的到底了，还是全被筛选/账本滤掉了。
    // 只说「到底了或全被拦」等于什么都没说 —— 得把量摆出来，才知道该换条件还是该收工。
    // 举例用**标题**：用户看到「Quality Assurance Intern」才知道是自己想投的被误杀。
    const detail =
      appliedSkip && blocked.length
        ? `（${appliedSkip} 家本地已投过、${blocked.length} 家被筛选拦掉${blocked[0] ? `，例如「${blocked[0].title || blocked[0].reason}」` : ''}）`
        : appliedSkip
          ? `（这页 ${appliedSkip} 家都是本地记录里已投过的）`
          : blocked.length
            ? `（这页 ${blocked.length} 家都被筛选拦掉${blocked[0] ? `，例如「${blocked[0].title || blocked[0].reason}」` : ''}）`
            : ''
    let why = ''
    if (chk.reason === 'empty') {
      // 这一页连岗位都没认到 → 是真到底，不是「都被拦了」（交给同一个函数说，措辞统一）
      why = allIds.length ? `第 ${pageNo} 页没有可投岗位${detail}` : reasonOfPage({ allIds, blocked, appliedSkip, pending })
    } else if (chk.reason === 'same-as-prev')
      why = `第 ${pageNo} 页和第 ${pageNo - 1} 页抓到的是同一批岗位 —— 翻页没生效（page 参数没起作用）`
    else why = `第 ${pageNo} 页全是投过的岗位，已经到底${detail}`

    // 翻页没生效 = 机制坏了，立刻停，别往后空转
    if (chk.reason === 'same-as-prev') return stopPaging(`翻页自检：${why}，已停止翻页`)

    // 这页没活可干 ≠ 整轮结束：先往后翻，翻到底 startPageScan 会自动换下一个关键词。
    // 「一键投递」的本意就是一站到底，不该每页都要人再点一次（2026-11-05 用户反复问「怎么又停了」）
    const scan = await startPageScan({
      why,
      limit: p.limit,
      force: p.force,
      opts: { paging: p },
      allIds,
      pending,
      blocked,
      kw: { kwUrls: b.kwUrls, kwIndex: b.kwIndex },
    })
    if (scan) return true
    return stopPaging(`翻页自检：${why}，已停止翻页`)
  }

  const seen = new Set(p.seenIds || [])

  // 自检通过 → 开新一批（沿用同一份 paging，把 page / seenIds 往前推）
  const nextPaging = {
    ...p,
    pendingPage: false,
    lastPageIds: ids,
    lastAllIds: allIds,
    seenIds: [...seen, ...ids],
    stopped: '',
  }
  try {
    const res = await startBatch(p.limit || 10, p.force, {
      paging: nextPaging,
      kwUrls: b.kwUrls,
      kwIndex: b.kwIndex,
    })
    if (!res.ok) {
      // 启动失败（额度用完 / 抓不到链接）：必须清掉 pendingPage，否则这个页面会被反复重试
      await setBatch({
        ...b,
        running: false,
        paging: { ...p, pendingPage: false, stopped: res.error || '启动失败' },
        stopReason: `第 ${pageNo} 页没能开投：${res.error || '未知原因'}`,
      })
    }
    try {
      await chrome.storage.local.set({ lastOneKeyResult: { ...res, at: new Date().toISOString() } })
    } catch (_) {
      /* 落盘失败不影响投递 */
    }
  } catch (e) {
    await setBatch({
      ...b,
      running: false,
      paging: { ...p, pendingPage: false },
      stopReason: `翻页启动异常：${e.message}`,
    })
  }
  return true
}

/**
 * 一键投递的「接力段」。
 *
 * popup 点「一键投递」时只做两件事：把前置条件拼成一条搜索页 URL、落一个待启动标记，
 * 然后跳过去。真正的启动在这里发生 —— 页面加载完、脚本注入了，自己读标记开投。
 *
 * 为什么不放在 popup 里轮询等页面就绪：popup 一失去焦点就被销毁，
 * 用户顺手点一下页面等待就断了，表现是「跳过去了但没开始投」（静默失败）。
 */
async function bootOneKey() {
  const { oneKeyPending } = await chrome.storage.local.get('oneKeyPending')
  if (!oneKeyPending) return false

  // 过期就丢掉：否则几天后在随便一个搜索页打开，会突然自己开投
  const age = Date.now() - new Date(oneKeyPending.at || 0).getTime()
  if (!(age >= 0 && age < 5 * 60 * 1000)) {
    await chrome.storage.local.remove('oneKeyPending')
    return false
  }
  if (oneKeyPending.line && oneKeyPending.line !== lineOfPlatform(platform())) return false

  await chrome.storage.local.remove('oneKeyPending')

  let res
  try {
    res = await startBatch(oneKeyPending.limit, oneKeyPending.force, {
      pagingConfig: oneKeyPending.pagingConfig,
      // 关键词队列：第 1 个词的页面就是当前这页，后面几个词投完自动接上
      kwUrls: oneKeyPending.kwUrls,
      kwIndex: 0,
    })
    // 列表是前端渲染的，脚本注入得早可能还没画出来 → 没抓到就等一拍再试一次
    if (!res.ok && !res.resumed && /没抓到岗位链接/.test(String(res.error || ''))) {
      await sleep(2500)
      res = await startBatch(oneKeyPending.limit, oneKeyPending.force, {
        pagingConfig: oneKeyPending.pagingConfig,
        kwUrls: oneKeyPending.kwUrls,
        kwIndex: 0,
      })
    }
  } catch (e) {
    res = { ok: false, error: e.message }
  }
  // popup 可能已经关了，结果落盘，下次打开能看到上次发生了什么
  try {
    await chrome.storage.local.set({ lastOneKeyResult: { ...res, at: new Date().toISOString() } })
  } catch (_) {
    /* 落盘失败不影响投递 */
  }
  return true
}

// 页面就绪后自动检查：一键投递 > 翻页接力 > 普通续跑（先到先得，只跑一个）
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(bootPendingBoss, 500)
    setTimeout(async () => {
      if (await bootOneKey()) return
      if (await bootNextPage()) return
      await resumeBatch()
    }, 1200)
  })
} else {
  setTimeout(bootPendingBoss, 500)
  setTimeout(async () => {
    if (await bootOneKey()) return
    if (await bootNextPage()) return
    await resumeBatch()
  }, 1200)
}
