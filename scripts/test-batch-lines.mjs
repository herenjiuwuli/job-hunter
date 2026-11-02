// 验证「实习僧 + BOSS 双线并行」的批次隔离：
// 两条线必须各写各的 storage 键（batch:sx / batch:boss），否则并行时互相覆盖进度，
// 表现是「跳来跳去、每家投一半」。
//
// 做法：用 vm 加载真实的 content.js，用同一份 storage stub 造出「两个标签页」，
// 直接调真函数。抄一遍实现来测等于没测。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8')

// 共享 storage：模拟两个标签页读写同一份 chrome.storage.local
function makeStore(init = {}) {
  const data = { ...init }
  return {
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
}

function makeContext(href, store) {
  const u = new URL(href)
  const noop = () => {}
  // 定时器全部停掉：加载时会 setTimeout(resumeBatch/bootPendingBoss)，
  // 让它跑起来会去读 storage、甚至改 location.href，干扰断言
  const stopTimer = () => 0
  const ctx = {
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search },
    document: {
      title: '',
      readyState: 'complete',
      body: { innerText: '' },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
    },
    chrome: {
      runtime: {
        onMessage: { addListener: noop },
        sendMessage: async () => ({ ok: true, tabId: 1 }),
      },
      storage: { local: store.local },
    },
    setTimeout: stopTimer,
    clearTimeout: noop,
    setInterval: stopTimer,
    clearInterval: noop,
    console,
    URL,
    Date,
    Math,
    JSON,
    Intl,
    Promise,
    RegExp,
    String,
    Number,
    Object,
    Array,
    Error,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx, { filename: 'content.js' })
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

const SX_URL = 'https://www.shixiseng.com/interns?keyword=%E6%95%B0%E6%8D%AE'
const BOSS_URL = 'https://www.zhipin.com/web/geek/job?query=%E6%95%B0%E6%8D%AE'

const mkBatch = (url, n = 2) => ({
  running: true,
  queue: Array.from({ length: n }, (_, i) =>`${url}&i=${i}`),
  titles: Array.from({ length: n }, (_, i) => `岗位${i}`),
  index: 0,
  results: [],
  total: n,
})

// ---- 1) 分键：两条线各写各的 ----
{
  const store = makeStore()
  const sx = makeContext(SX_URL, store)
  const boss = makeContext(BOSS_URL, store)

  const b1 = mkBatch(SX_URL)
  const b2 = { ...mkBatch(BOSS_URL), index: 3 }

  await sx.setBatch(b1)
  check('实习僧写入 batch:sx', !!store.data['batch:sx'], true)
  check('实习僧写入后没有残留老键 batch', 'batch' in store.data, false)

  await boss.setBatch(b2)
  check('BOSS 写入 batch:boss', !!store.data['batch:boss'], true)
  // ★ 核心回归：BOSS 写入不能覆盖实习僧那条线
  check('BOSS 写入后实习僧进度还在', store.data['batch:sx'].index, 0)
  check('BOSS 自己的 index 正确', store.data['batch:boss'].index, 3)

  // 读回：各拿各的
  check('实习僧读到自己的批次', (await sx.getBatch()).queue[0], b1.queue[0])
  check('BOSS 读到自己的批次', (await boss.getBatch()).index, 3)
}

// ---- 2) 老键迁移：只有 batch 时，按队列 URL 判断归属 ----
{
  const store = makeStore({ batch: { ...mkBatch(BOSS_URL), index: 1 } })
  const sx = makeContext(SX_URL, store)
  const boss = makeContext(BOSS_URL, store)

  check('老键属于 BOSS → 实习僧线读不到（不能抢别人的队列）', await sx.getBatch(), null)
  check('老键属于 BOSS → BOSS 线能读到', (await boss.getBatch()).index, 1)
  check('读取后迁移成 batch:boss', !!store.data['batch:boss'], true)
}

// ---- 3) 老键归属反方向 ----
{
  const store = makeStore({ batch: mkBatch(SX_URL) })
  const boss = makeContext(BOSS_URL, store)
  const sx = makeContext(SX_URL, store)

  check('老键属于实习僧 → BOSS 线读不到', await boss.getBatch(), null)
  check('老键属于实习僧 → 实习僧线能读到', !!(await sx.getBatch()), true)
}

// ---- 4) 平台 / URL 归一化 ----
{
  const store = makeStore()
  const c = makeContext(SX_URL, store)
  check('lineOfPlatform(BOSS直聘)', c.lineOfPlatform('BOSS直聘'), 'boss')
  check('lineOfPlatform(实习僧)', c.lineOfPlatform('实习僧'), 'sx')
  check('lineOfPlatform(其他)', c.lineOfPlatform('其他'), 'other')
  check('lineOfUrl(zhipin chat)', c.lineOfUrl('https://www.zhipin.com/web/geek/chat'), 'boss')
  check('lineOfUrl(shixiseng 详情)', c.lineOfUrl('https://www.shixiseng.com/intern/inn_abc'), 'sx')
  check('lineOfUrl(空)', c.lineOfUrl(''), 'other')
  check('lineKey 在实习僧页 = batch:sx', c.lineKey(), 'batch:sx')
}

// ---- 5) 停止一条线不动另一条 ----
{
  const store = makeStore()
  const sx = makeContext(SX_URL, store)
  const boss = makeContext(BOSS_URL, store)
  await sx.setBatch(mkBatch(SX_URL))
  await boss.setBatch(mkBatch(BOSS_URL))

  await sx.stopBatch()
  check('停实习僧后：实习僧 running=false', store.data['batch:sx'].running, false)
  check('停实习僧后：BOSS 仍在跑', store.data['batch:boss'].running, true)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
