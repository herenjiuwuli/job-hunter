// 本地投递账本的回归测试（不依赖浏览器）
// 做法：用假的 chrome.storage.local 把 background.js 跑在 vm 里，直接调账本函数验行为。
// 跑法：node scripts/test-applied-ledger.mjs
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BG = path.join(__dirname, '..', 'extension', 'background.js')

const store = {}
const chrome = {
  runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
  storage: {
    local: {
      async get(keys) {
        if (keys == null) return { ...store }
        if (typeof keys === 'string') return { [keys]: store[keys] }
        if (Array.isArray(keys)) {
          const o = {}
          for (const k of keys) o[k] = store[k]
          return o
        }
        return { ...store }
      },
      async set(obj) {
        Object.assign(store, obj)
      },
    },
  },
}

const code = fs.readFileSync(BG, 'utf8')
const ctx = vm.createContext({ chrome, console, Date, Object, String, Number, Array, JSON, Math, isNaN })
vm.runInContext(
  code +
    '\n;globalThis.__t = { markApplied, isApplied, listApplied, removeApplied, clearApplied }',
  ctx
)
const T = ctx.__t

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const run = async () => {
  console.log('账本测试：')

  // 1) 空账本查询
  let r = await T.isApplied('实习僧', 'inn_aaa')
  check('空账本 → 未投过', r.applied === false)

  // 2) 记账后能查到
  await T.markApplied({ jobId: 'inn_aaa', platform: '实习僧', title: '测试实习生', company: 'A 公司' })
  r = await T.isApplied('实习僧', 'inn_aaa')
  check('记账后 → 判定已投过', r.applied === true)
  check('带上标题', r.title === '测试实习生', r.title)
  check('默认视为已确认', r.verified === true)

  // 3) 平台隔离：同 id 不同平台不能互相污染
  r = await T.isApplied('BOSS', 'inn_aaa')
  check('平台隔离（实习僧的 inn_aaa ≠ BOSS 的 inn_aaa）', r.applied === false)

  // 4) 重复记账保留最早时间（不把日期刷成今天）
  const firstAt = (await T.listApplied(10)).list.find((x) => x.jobId === 'inn_aaa').at
  await new Promise((res) => setTimeout(res, 15))
  await T.markApplied({ jobId: 'inn_aaa', platform: '实习僧', title: '改过的标题' })
  const after = (await T.listApplied(10)).list.find((x) => x.jobId === 'inn_aaa')
  check('重复记账保留首次投递时间', after.at === firstAt, `${after.at} vs ${firstAt}`)
  check('重复记账会更新标题', after.title === '改过的标题', after.title)

  // 5) verified:false 要能带出来（unknown 状态）
  await T.markApplied({ jobId: 'boss_x1', platform: 'BOSS', title: 'BOSS 岗位', verified: false })
  r = await T.isApplied('BOSS', 'boss_x1')
  check('未确认状态可读出 verified=false', r.verified === false)

  // 6) 列表按时间倒序 + 总数
  const list = await T.listApplied(10)
  check('列表总数 2', list.total === 2, String(list.total))
  check('最新一条在最前', list.list[0].jobId === 'boss_x1', list.list[0].jobId)

  // 7) 删除单条
  await T.removeApplied('sx:inn_aaa')
  r = await T.isApplied('实习僧', 'inn_aaa')
  check('删除后 → 未投过', r.applied === false)
  check('删除后总数 1', (await T.listApplied(10)).total === 1)

  // 8) 清空
  await T.clearApplied()
  check('清空后总数 0', (await T.listApplied(10)).total === 0)

  // 8.5) 平台名归一化：content.js 的 platform() 返回 'BOSS直聘'，
  //      若和 'BOSS' 被当成两个前缀，同一岗位会记成两条、去重失效
  await T.markApplied({ jobId: 'boss_norm', platform: 'BOSS直聘', title: '归一化测试' })
  check("'BOSS直聘' 写入后可用 'BOSS' 查到", (await T.isApplied('BOSS', 'boss_norm')).applied === true)
  check("'BOSS直聘' 自己也能查到", (await T.isApplied('BOSS直聘', 'boss_norm')).applied === true)
  const nk = Object.keys(store.applied || {})
  check('只落一条 key，没有重复', nk.length === 1, nk.join(','))

  // 9) 缺 jobId 不能写脏数据
  const bad = await T.markApplied({ platform: '实习僧' })
  check('缺 jobId 拒绝写入', bad.ok === false)

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

run()
