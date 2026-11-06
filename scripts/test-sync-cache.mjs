// 「已同步」缓存要不要重报 —— 决定一条采集到的投递能不能进后端。
//
// 2026-11-06 真机死结：库里 2 条公司名是「未知公司」（中金财富 ×2），
// 采集每轮都能拿到真名，但缓存只按 **stage** 判断「变没变」：
// viewed → viewed = 没变 → 直接跳过 → 后端一次都收不到订正数据。
// 后端那边刚修好「精确命中也要补公司名」，却永远等不到这次上报。
//
// 所以缓存必须同时记公司名，且「从空/未知变成已知」也算有变化。
//
// 用真实现（从 popup.js 抽函数源码），不是抄一遍。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'extension/popup/popup.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  console.log(ok ? '✅' : '❌', name, ok ? '' : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

const missSrc = src.match(/function isMissingCompany\(s\) \{[\s\S]*?\n\}/)?.[0]
const filterSrc = src.match(/async function filterAlreadySynced\(items\) \{[\s\S]*?\n\}/)?.[0]
const rememberSrc = src.match(/async function rememberSynced\(items\) \{[\s\S]*?\n\}/)?.[0]
check('取到 isMissingCompany', !!missSrc, true)
check('取到 filterAlreadySynced', !!filterSrc, true)
check('取到 rememberSynced', !!rememberSrc, true)
if (!missSrc || !filterSrc || !rememberSrc) process.exit(1)

/** 假 chrome.storage：够 filterAlreadySynced / rememberSynced 用就行 */
function makeEnv(initial = {}) {
  const data = { ...initial }
  const chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys]
          const out = {}
          for (const k of list) if (k in data) out[k] = data[k]
          return out
        },
        set: async (obj) => Object.assign(data, obj),
      },
    },
  }
  const api = new Function(
    'chrome',
    `${missSrc}\n${filterSrc}\n${rememberSrc}\nreturn { filterAlreadySynced, rememberSynced, isMissingCompany }`
  )(chrome)
  return { api, data }
}

const item = (jobId, stage, company) => ({ jobId, stage, company })

// ---- 1. 阶段变了必须报 ----
{
  const { api } = makeEnv({ jhSyncedJobs: { A: { stage: 'submitted', company: '甲公司' } } })
  const r = await api.filterAlreadySynced([item('A', 'viewed', '甲公司')])
  check('阶段前进要重报', r.items.length, 1)
  check('新缓存不算迁移', r.migrated, false)
}

// ---- 2. 阶段没变 + 公司名从「未知」变已知 → 必须报（这次修的核心） ----
{
  const { api } = makeEnv({ jhSyncedJobs: { B: { stage: 'viewed', company: '未知公司' } } })
  const r = await api.filterAlreadySynced([item('B', 'viewed', '中金财富')])
  check('公司名从未知变已知要重报', r.items.length, 1)
}
{
  const { api } = makeEnv({ jhSyncedJobs: { B2: { stage: 'viewed', company: '' } } })
  const r = await api.filterAlreadySynced([item('B2', 'viewed', '中金财富')])
  check('公司名为空变已知要重报', r.items.length, 1)
}

// ---- 3. 阶段没变、公司名都在 → 跳过（否则每次同步都全量重报） ----
{
  const { api } = makeEnv({ jhSyncedJobs: { C: { stage: 'viewed', company: '中金财富' } } })
  const r = await api.filterAlreadySynced([item('C', 'viewed', '中金财富')])
  check('真的没变化就跳过', r.items.length, 0)
}

// ---- 4. 没有 jobId 的一律照报（没法判断） ----
{
  const { api } = makeEnv({ jhSyncedJobs: {} })
  const r = await api.filterAlreadySynced([item('', 'viewed', '某公司')])
  check('无 jobId 照报', r.items.length, 1)
}

// ---- 5. 旧缓存（字符串）→ 迁移标记为真，且全量重报一轮 ----
{
  const { api } = makeEnv({ jhSyncedJobs: { D: 'viewed' } })
  const r = await api.filterAlreadySynced([item('D', 'viewed', '法雷奥')])
  check('旧缓存要迁一轮（migrated）', r.migrated, true)
  check('旧缓存这轮全量重报', r.items.length, 1)
}

// ---- 6. rememberSynced 存的是对象，且能接住下一轮的判断 ----
{
  const { api, data } = makeEnv({ jhSyncedJobs: {} })
  await api.rememberSynced([item('E', 'screening', '科锐国际')])
  check('缓存记下了公司名', data.jhSyncedJobs.E, { stage: 'screening', company: '科锐国际' })
  const r = await api.filterAlreadySynced([item('E', 'screening', '科锐国际')])
  check('记完之后同一状态不再重报', r.items.length, 0)
  check('记完之后不再是旧形状', r.migrated, false)
}

console.log(`\n结果：${fail ? '失败' : '通过'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail ? 1 : 0)
