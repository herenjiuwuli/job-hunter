// 验证按平台分开的每日额度：
// BOSS 默认 120（官方 150 会提醒，不碰硬线）、实习僧默认 100（平台没数字，自设护栏）、
// 填 0 = 不限、clamp 挡误填、以及 10 个并发只加 10 次（serial 锁）。
//
// 用 vm 加载真实的 background.js，不抄实现来测。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'extension/background.js'), 'utf8')

function makeCtx(init = {}) {
  const data = { ...init }
  const store = {
    data,
    local: {
      get: async (keys) => {
        const list = Array.isArray(keys) ? keys : keys == null ? Object.keys(data) : [keys]
        const out = {}
        list.forEach((k) => {
          if (k in data) out[k] = data[k]
        })
        return out
      },
      set: async (obj) => {
        Object.assign(data, obj)
      },
      remove: async (k) => {
        ;(Array.isArray(k) ? k : [k]).forEach((x) => delete data[x])
      },
    },
  }
  const noop = () => {}
  const ctx = {
    chrome: {
      runtime: {
        onInstalled: { addListener: noop },
        onMessage: { addListener: noop },
      },
      storage: { local: store.local },
    },
    console,
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    JSON,
    Promise,
    Error,
  }
  ctx.store = store
  vm.createContext(ctx)
  vm.runInContext(src, ctx, { filename: 'background.js' })
  return ctx
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  console.log(ok ? '✅' : '❌', name, ok ? '' : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

// ---- 1) 默认值：按平台各一套 ----
{
  const c = makeCtx()
  check('BOSS 默认上限 120（官方提醒线）', (await c.getQuota('BOSS直聘')).limit, 120)
  check('实习僧默认上限 100', (await c.getQuota('实习僧')).limit, 100)
  check('平台名归一化：BOSS', c.quotaLine('BOSS直聘'), 'boss')
  check('平台名归一化：实习僧', c.quotaLine('实习僧'), 'sx')
}

// ---- 2) 各记各的，互不吃额度 ----
{
  const c = makeCtx()
  await c.checkAndIncrement('BOSS直聘')
  await c.checkAndIncrement('实习僧')
  await c.checkAndIncrement('实习僧')
  check('BOSS 只记 1 次', (await c.getQuota('BOSS直聘')).used, 1)
  check('实习僧记 2 次', (await c.getQuota('实习僧')).used, 2)
  check('BOSS 剩余 119', (await c.getQuota('BOSS直聘')).remaining, 119)
  check('实习僧剩余 98', (await c.getQuota('实习僧')).remaining, 98)
}

// ---- 3) BOSS 到 120 就停，不碰 150 ----
{
  const c = makeCtx()
  const k = c.todayKey('boss')
  c.store.data[k] = 119
  check('第 120 次允许', (await c.checkAndIncrement('BOSS直聘')).blocked, false)
  check('第 121 次被拦', (await c.checkAndIncrement('BOSS直聘')).blocked, true)
  const q = await c.getQuota('BOSS直聘')
  check('停在 120（没冲到 150）', q.used, 120)
  check('剩余归零', q.remaining, 0)
}

// ---- 4) 填 0 = 不限 ----
{
  const c = makeCtx()
  const r = await c.setDailyLimit('实习僧', 0)
  check('设 0 成功', r.limit, 0)
  const q = await c.getQuota('实习僧')
  check('unlimited=true', q.unlimited, true)
  check('remaining=-1（显示「不限」）', q.remaining, -1)
  c.store.data[c.todayKey('sx')] = 500
  check('不限时 500 次也不拦', (await c.checkAndIncrement('实习僧')).blocked, false)
}

// ---- 5) clamp：挡手滑 ----
{
  const c = makeCtx()
  check('BOSS 填 500 夹到 150', (await c.setDailyLimit('BOSS直聘', 500)).limit, 150)
  check('BOSS 填 1000 夹到 150', (await c.setDailyLimit('BOSS直聘', 1000)).limit, 150)
  check('BOSS 填 80 保留 80', (await c.setDailyLimit('BOSS直聘', 80)).limit, 80)
  check('负数视为无效 → 回默认', (await c.setDailyLimit('BOSS直聘', -5)).limit, 120)
}

// ---- 6) 并发：10 个同时扣，只能加 10 ----
{
  const c = makeCtx()
  await Promise.all(Array.from({ length: 10 }, () => c.checkAndIncrement('BOSS直聘')))
  check('10 个并发 = used 10（锁生效）', (await c.getQuota('BOSS直聘')).used, 10)
}

// ---- 7) 重置 ----
{
  const c = makeCtx()
  await c.checkAndIncrement('BOSS直聘')
  await c.checkAndIncrement('实习僧')
  await c.resetQuota()
  check('重置后 BOSS 归零', (await c.getQuota('BOSS直聘')).used, 0)
  check('重置后实习僧归零', (await c.getQuota('实习僧')).used, 0)
}

// ---- 8) 上限改了立刻生效 ----
{
  const c = makeCtx()
  await c.setDailyLimit('实习僧', 3)
  await c.checkAndIncrement('实习僧')
  await c.checkAndIncrement('实习僧')
  await c.checkAndIncrement('实习僧')
  check('改成 3 之后第 4 次被拦', (await c.checkAndIncrement('实习僧')).blocked, true)
}

// ---- 9) 平台官方口径要能读到（界面上要说明数字来源）----
{
  const c = makeCtx()
  const boss = await c.getQuota('BOSS直聘')
  check('BOSS 官方上限 150', boss.officialDaily, 150)
  check('BOSS 官方提醒线 120', boss.officialWarn, 120)
  check('BOSS 显示名', boss.name, 'BOSS 直聘')
  const sx = await c.getQuota('实习僧')
  check('实习僧官方未公布（0 表示没有）', sx.officialDaily, 0)
  check('实习僧显示名', sx.name, '实习僧')
}

// ---- 10) 近 N 天分平台记账 ----
{
  const c = makeCtx()
  const today = c.todayKey('boss').replace('quota:boss:', '')
  const y = new Date()
  y.setDate(y.getDate() - 1)
  const yday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
  c.store.data[`quota:boss:${today}`] = 7
  c.store.data[`quota:sx:${today}`] = 3
  c.store.data[`quota:boss:${yday}`] = 5

  const r = await c.quotaHistory(7)
  check('返回 7 天', r.rows.length, 7)
  check('今天 BOSS = 7', r.rows[0].boss, 7)
  check('今天实习僧 = 3', r.rows[0].sx, 3)
  check('昨天 BOSS = 5', r.rows[1].boss, 5)
  check('昨天实习僧 = 0（没记录算 0）', r.rows[1].sx, 0)
  check('日期倒序（第 0 条是今天）', r.rows[0].day, today)
}

// ---- 11) 30 天前的旧键会被清掉 ----
{
  const c = makeCtx()
  const old = new Date()
  old.setDate(old.getDate() - 45)
  const oldDay = `${old.getFullYear()}-${String(old.getMonth() + 1).padStart(2, '0')}-${String(old.getDate()).padStart(2, '0')}`
  c.store.data[`quota:boss:${oldDay}`] = 9
  await c.quotaHistory(7)
  check('45 天前的 quota 键被清理', `quota:boss:${oldDay}` in c.store.data, false)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
