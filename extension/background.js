// 后台 service worker：每日投递额度管理 + 消息路由
//
// ⚠️ 额度按平台分开算（2026-11-02）。原来是一个全局池子，双线并行时
// 实习僧会把 BOSS 的份额吃掉 —— BOSS 还没到自己 120 就先被拦了，明显不对。
//
// BOSS 直聘：官方每天 150 次沟通，到 120 会弹提醒 → 默认停在 120，不碰 150 硬线。
// 实习僧：平台没公布上限，100 是自设护栏（可改，填 0 = 不限）。

const DEFAULT_LIMITS = { boss: 120, sx: 100, other: 100 }
// 硬线只用来挡误填的超大数字。BOSS 的 150 是平台事实，填不过去。
const HARD_LIMITS = { boss: 150, sx: 300, other: 300 }

// 平台公开信息：界面上要能说清「这个数字从哪来的」。
// officialDaily = 0 表示平台没有公布上限。
const PLATFORM_FACTS = {
  boss: {
    name: 'BOSS 直聘',
    officialDaily: 150,
    officialWarn: 120,
    official: '官方每天 150 次沟通，到 120 会提醒',
  },
  sx: {
    name: '实习僧',
    officialDaily: 0,
    officialWarn: 0,
    official: '官方未公布每日上限',
  },
  other: { name: '其他', officialDaily: 0, officialWarn: 0, official: '' },
}

function quotaLine(platform) {
  const raw = String(platform || '')
  if (/boss|直聘/i.test(raw)) return 'boss'
  if (raw.includes('实习僧')) return 'sx'
  return 'other'
}

function todayKey(line) {
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `quota:${line}:${day}`
}
function limitKey(line) {
  return `limit:${line}`
}

chrome.runtime.onInstalled.addListener(async () => {
  // 老版本的全局 dailyLimit 不再使用，留着只会误导，清掉
  await chrome.storage.local.remove('dailyLimit')
})

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    // 告诉 content script 自己在哪个 tab：同平台多标签页并行时，
    // 只有启动批次的那个 tab 能推进队列
    case 'whoAmI':
      sendResponse({ ok: true, tabId: (sender && sender.tab && sender.tab.id) || null })
      return false
    case 'getQuota':
      getQuota(msg.platform).then(sendResponse)
      return true
    case 'checkAndIncrement':
      checkAndIncrement(msg.platform).then(sendResponse)
      return true
    case 'resetQuota':
      resetQuota(msg.platform).then(sendResponse)
      return true
    case 'setDailyLimit':
      setDailyLimit(msg.platform, msg.limit).then(sendResponse)
      return true
    case 'quotaHistory':
      quotaHistory(msg.days).then(sendResponse)
      return true
    // ===== 本地投递账本 =====
    // 为什么要有：页面不一定显示「已投递」（有的岗位按钮还是「投个简历」），
    // 光靠 DOM 判断会出现「实际已投，界面看着能投」的误判。自己记账才是唯一可靠的。
    case 'isApplied':
      isApplied(msg.platform, msg.jobId).then(sendResponse)
      return true
    case 'markApplied':
      markApplied(msg.item).then(sendResponse)
      return true
    case 'listApplied':
      listApplied(msg.limit).then(sendResponse)
      return true
    case 'removeApplied':
      removeApplied(msg.key).then(sendResponse)
      return true
    case 'clearApplied':
      clearApplied().then(sendResponse)
      return true
    // ===== 后端回写代理 =====
    // 为什么不在 content script 里直接 fetch：content script 的 fetch 走**页面上下文**，
    // 受页面的 CSP `connect-src` 管辖；service worker 的 fetch 只受扩展 host_permissions 约束。
    // BOSS（zhipin.com）的 CSP 比实习僧严，2026-11-03 真机就是这个症状：
    // 页面上三家全部「已发送招呼语」、本地账本也记上了，后端一条记录都没有 ——
    // 请求被页面 CSP 拦掉，而 writeback 的 catch 只 console.warn，界面上完全不可见。
    case 'backendPost':
      backendPost(msg.path, msg.body).then(sendResponse)
      return true
    // 开投前探一次登录态。为什么值得单开一个 action：
    // 投递是**不可撤销**的动作，账本却是可选的 —— token 过期时整批照投不误，
    // 只是每家都带一句「没写进后端」，用户看的是数字（1/2 成功）而不是缺记录。
    // 2026-11-12 真机：token 7 天到期，一整天投的岗位全都没进账本。
    case 'backendCheck':
      backendCheck().then(sendResponse)
      return true
    default:
      return false
  }
})

/**
 * 代 content script 打后端。返回结构固定：{ ok, status, data, error }，
 * 让调用方能区分「没发出去（status 0）」和「发出去了但被拒（401/400）」。
 */
async function backendPost(path, body) {
  try {
    const { jhBackend, jhToken } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
    const base = String(jhBackend || 'http://localhost:3100').replace(/\/+$/, '')
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jhToken ? { Authorization: `Bearer ${jhToken}` } : {}),
      },
      body: JSON.stringify(body || {}),
    })
    const text = await r.text()
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
    return {
      ok: r.ok,
      status: r.status,
      data,
      error: r.ok ? '' : (data && data.error) || String(text).slice(0, 120),
    }
  } catch (e) {
    // fetch 抛错 = 后端没启动 / 地址写错。和 HTTP 4xx 区分开，否则用户会去查 token
    return { ok: false, status: 0, error: `连不上后端（${e.message}）` }
  }
}

/**
 * 登录态预检。返回 { ok, status, username, error }。
 *
 * 三种失败要分得开，因为修法完全不同：
 *   status 0   → 后端没起 / 地址错（去启动后端）
 *   status 401 → token 没配 或 过期（去扩展下方「后端连接」点登录）
 *   其他        → 后端在但报错
 * 「没配」和「过期」在 401 里是同一个码，所以这里把有没有 token 一起带回去，
 * 界面上才能说「没填过」还是「填了但过期了」—— 前者要去找账号，后者点一下就好。
 */
async function backendCheck() {
  const { jhBackend, jhToken } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
  const base = String(jhBackend || 'http://localhost:3100').replace(/\/+$/, '')
  const token = String(jhToken || '').trim()
  if (!token) return { ok: false, status: 401, hasToken: false, error: '扩展里从来没填过 token' }
  try {
    const r = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    if (r.status === 401) return { ok: false, status: 401, hasToken: true, error: 'token 已过期（有效期 7 天）' }
    if (!r.ok) return { ok: false, status: r.status, hasToken: true, error: `后端返回 ${r.status}` }
    const u = await r.json().catch(() => ({}))
    return { ok: true, status: 200, hasToken: true, username: (u && u.username) || '' }
  } catch (e) {
    return { ok: false, status: 0, hasToken: true, error: `连不上后端（${e.message}）` }
  }
}

// ===================== 本地投递账本 =====================
// 结构：{ "sx:inn_xxx": {platform, jobId, title, company, url, at, verified} }
// key = 平台前缀 + 岗位 id，避免实习僧和 BOSS 的 id 撞车
const APPLIED_KEY = 'applied'
const APPLIED_MAX = 2000

function appliedKeyOf(platform, jobId) {
  // content.js 的 platform() 返回 '实习僧' / 'BOSS直聘' / '其他'，这里做归一化，
  // 避免 'BOSS' 和 'BOSS直聘' 被当成两个前缀、同一岗位记成两条。
  const raw = String(platform || 'x')
  const p = /boss/i.test(raw) || raw.includes('直聘') ? 'boss' : raw.includes('实习僧') ? 'sx' : raw
  return `${p}:${jobId}`
}

async function readApplied() {
  const { [APPLIED_KEY]: applied } = await chrome.storage.local.get(APPLIED_KEY)
  return applied && typeof applied === 'object' ? applied : {}
}

async function isApplied(platform, jobId) {
  if (!jobId) return { applied: false }
  const all = await readApplied()
  const key = appliedKeyOf(platform, jobId)
  const hit = all[key]
  if (!hit) return { applied: false, key }
  return { applied: true, key, at: hit.at || '', title: hit.title || '', verified: hit.verified !== false }
}

// ===================== storage 读改写串行化 =====================
// 并行投递（实习僧 + BOSS 两个标签页同时跑）会把这些「读全量 → 改 → 写回」的操作
// 交错执行：两边都读到 used=9，都写 10 → 额度只加了一次，实际发出两条。
// service worker 是单线程，用一条 promise 链就能把它们排成先后。
let storageChain = Promise.resolve()
function serial(task) {
  const run = storageChain.then(task, task)
  // 链上挂错误吞掉，避免一次失败卡死后面所有操作
  storageChain = run.catch(() => {})
  return run
}

function markApplied(item) {
  if (!item || !item.jobId) return Promise.resolve({ ok: false, error: '缺少 jobId' })
  // 整段在锁内执行：并发记账时「读全量→加一条→写回」会丢记录
  return serial(async () => {
  const all = await readApplied()
  const key = appliedKeyOf(item.platform, item.jobId)
  // 已存在就保留最早的投递时间，只补空字段（重复投递不该把日期覆盖成今天）
  const prev = all[key]
  all[key] = {
    platform: item.platform || '',
    jobId: item.jobId,
    title: item.title || (prev && prev.title) || '',
    company: item.company || (prev && prev.company) || '',
    url: item.url || (prev && prev.url) || '',
    at: (prev && prev.at) || item.at || new Date().toISOString(),
    verified: item.verified !== false,
    source: item.source || 'auto',
  }

  // 超上限按时间淘汰最旧的，避免 storage 无限长
  const keys = Object.keys(all)
  if (keys.length > APPLIED_MAX) {
    keys
      .sort((a, b) => String(all[a].at || '').localeCompare(String(all[b].at || '')))
      .slice(0, keys.length - APPLIED_MAX)
      .forEach((k) => delete all[k])
  }

  await chrome.storage.local.set({ [APPLIED_KEY]: all })
  return { ok: true, key, total: Object.keys(all).length }
  })
}

async function listApplied(limit = 20) {
  const all = await readApplied()
  const list = Object.keys(all)
    .map((k) => ({ key: k, ...all[k] }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  return { ok: true, total: list.length, list: list.slice(0, Math.max(1, Number(limit) || 20)) }
}

async function removeApplied(key) {
  const all = await readApplied()
  if (all[key]) {
    delete all[key]
    await chrome.storage.local.set({ [APPLIED_KEY]: all })
  }
  return { ok: true, total: Object.keys(all).length }
}

async function clearApplied() {
  await chrome.storage.local.set({ [APPLIED_KEY]: {} })
  return { ok: true }
}

async function getQuota(platform) {
  const line = quotaLine(platform)
  const f = PLATFORM_FACTS[line] || PLATFORM_FACTS.other
  const lk = limitKey(line)
  const tk = todayKey(line)
  const data = await chrome.storage.local.get([lk, tk])
  const limit = data[lk] == null ? DEFAULT_LIMITS[line] : clampLimit(line, data[lk])
  const used = Number(data[tk]) || 0
  return {
    line,
    name: f.name,
    // 平台公开数字（给界面做说明，不参与拦截）
    officialDaily: f.officialDaily,
    officialWarn: f.officialWarn,
    official: f.official,
    used,
    limit,
    unlimited: limit === 0,
    // -1 表示不限：给 popup 显示用，别让 Infinity 变成 NaN
    remaining: limit === 0 ? -1 : Math.max(0, limit - used),
  }
}

function checkAndIncrement(platform) {
  // 并行投递时两条线会几乎同时进来：整段必须串行，否则两边都读到 used=9
  // 都写 10，额度少记一次 → 实际投递量会超过上限
  return serial(async () => {
    const q = await getQuota(platform)
    if (q.limit > 0 && q.used >= q.limit) return { blocked: true, ...q }
    const next = q.used + 1
    await chrome.storage.local.set({ [todayKey(q.line)]: next })
    return {
      blocked: false,
      line: q.line,
      used: next,
      limit: q.limit,
      unlimited: q.limit === 0,
      remaining: q.limit === 0 ? -1 : q.limit - next,
    }
  })
}

// 不传平台 = 两个平台一起重置（popup 的「重置额度」就是清今天两条线）
async function resetQuota(platform) {
  const lines = platform ? [quotaLine(platform)] : ['boss', 'sx', 'other']
  const patch = {}
  lines.forEach((l) => {
    patch[todayKey(l)] = 0
  })
  await chrome.storage.local.set(patch)
  return { ok: true, lines }
}

async function setDailyLimit(platform, limit) {
  const line = quotaLine(platform)
  const v = clampLimit(line, limit)
  await chrome.storage.local.set({ [limitKey(line)]: v })
  return { ok: true, line, limit: v, unlimited: v === 0 }
}

// 近 N 天分平台用量：投递量要按平台记账，只记「今天」看不出趋势。
// 顺手把 30 天前的 quota 键清掉，否则 storage 会一直涨。
async function quotaHistory(days = 7) {
  const n = Math.min(Math.max(Number(days) || 7, 1), 30)
  const all = await chrome.storage.local.get(null)
  const rows = []
  for (let i = 0; i < n; i++) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    rows.push({
      day,
      boss: Number(all[`quota:boss:${day}`]) || 0,
      sx: Number(all[`quota:sx:${day}`]) || 0,
    })
  }

  const keep = new Set(rows.map((r) => r.day))
  const expired = Object.keys(all).filter((k) => {
    const m = k.match(/^quota:(?:boss|sx|other):(\d{4}-\d{2}-\d{2})$/)
    if (!m || keep.has(m[1])) return false
    const ageDays = (Date.now() - new Date(`${m[1]}T00:00:00`).getTime()) / 86400000
    return ageDays > 30
  })
  if (expired.length) await chrome.storage.local.remove(expired)

  return { ok: true, rows }
}

// 0 有特殊含义：不限。其余按平台的硬线夹住，挡掉手滑填的 1000
function clampLimit(line, v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMITS[line]
  if (n === 0) return 0
  const hard = HARD_LIMITS[line] || 300
  return Math.min(Math.round(n), hard)
}
