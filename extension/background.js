// 后台 service worker：每日投递额度管理 + 消息路由
// 安全策略核心之一：单账号每日投递上限（默认 50，硬上限 150）

const DEFAULT_LIMIT = 50
const HARD_LIMIT = 150

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

chrome.runtime.onInstalled.addListener(async () => {
  const { dailyLimit } = await chrome.storage.local.get('dailyLimit')
  if (dailyLimit == null) await chrome.storage.local.set({ dailyLimit: DEFAULT_LIMIT })
})

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'getQuota':
      getQuota().then(sendResponse)
      return true
    case 'checkAndIncrement':
      checkAndIncrement().then(sendResponse)
      return true
    case 'resetQuota':
      resetQuota().then(sendResponse)
      return true
    case 'setDailyLimit':
      setDailyLimit(msg.limit).then(sendResponse)
      return true
    default:
      return false
  }
})

async function getQuota() {
  const key = todayKey()
  const data = await chrome.storage.local.get(['dailyLimit', key])
  const limit = clampLimit(data.dailyLimit)
  const used = Number(data[key]) || 0
  return { used, limit, remaining: Math.max(0, limit - used) }
}

async function checkAndIncrement() {
  const q = await getQuota()
  if (q.used >= q.limit) return { blocked: true, ...q }
  const next = q.used + 1
  await chrome.storage.local.set({ [todayKey()]: next })
  return { blocked: false, used: next, limit: q.limit, remaining: q.limit - next }
}

async function resetQuota() {
  await chrome.storage.local.set({ [todayKey()]: 0 })
  return { ok: true }
}

async function setDailyLimit(limit) {
  const v = clampLimit(limit)
  await chrome.storage.local.set({ dailyLimit: v })
  return { ok: true, limit: v }
}

function clampLimit(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, HARD_LIMIT)
}
