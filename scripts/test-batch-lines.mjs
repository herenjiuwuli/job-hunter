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
// screenJob 依赖 window.JH_FILTERS（扩展里两个脚本都注入），不加载它就只能测到「没筛选」那条分支
const filtersSrc = fs.readFileSync(path.join(root, 'extension/shared/filters-data.js'), 'utf8')

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

function makeContext(href, store, withFilters = false) {
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
  if (withFilters) vm.runInContext(filtersSrc, ctx, { filename: 'filters-data.js' })
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

// ---- 6) 多关键词轮换：每个词的成绩必须单独留账 ----
// 换词时 batch 会被整体重置（queue / results / total 归零），不单独记账的话
// 用户按一次「一键投递」跑 4 个词、最后只看得到第 4 个词的结果 —— 前 3 个投了什么都消失。
{
  const store = makeStore()
  const c = makeContext(SX_URL, store)
  const kw = (k) =>
    `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(k)}&city=%E6%B7%B1%E5%9C%B3&type=school`
  const kwUrls = [kw('软件测试'), kw('SDET')]

  const b1 = {
    kwUrls,
    kwIndex: 0,
    kwOk: 3, // 跨页累积的成功数（results 已被清空）
    results: [],
    paging: { page: 2, maxPages: 2 },
    blockedTotal: 7,
  }
  check(
    '一个词跑完 → 一句账',
    c.kwStatLine(b1, '到底了'),
    '第 1/2 个「软件测试」：翻 2 页、投 3 家、拦 7 家 —— 到底了'
  )

  let stats = c.withKwStat(b1, '到底了')
  check('第一个词记账', stats.length, 1)

  // 换到第 2 个词：一个都没投到，也要留一行（「没投到」本身就是结论）
  const b2 = { ...b1, kwIndex: 1, kwOk: 0, results: [], blockedTotal: 3 }
  stats = c.withKwStat({ ...b2, kwStats: stats }, '翻满 2 页')
  check('换词后两个词各一行', stats.length, 2)
  check('第 1 个词的账没被第 2 个覆盖', stats[0].ok, 3)
  check('第 2 个词明说「没投到」', stats[1].line.includes('没投到'), true)
  check('顺序按词序', stats.map((x) => x.i), [0, 1])

  // 换词与收尾会重复调用同一个词 → 只留最后一次，不能堆成两行
  const again = c.withKwStat({ ...b2, kwStats: stats, kwOk: 5 }, '又一个原因')
  check('同一个词重复记账只留最后一次', again.length, 2)
  check('留下的是最新数字', again[1].ok, 5)
}

// ---- 7) 单关键词模式：没有 kwUrls 也不能崩 ----
{
  const store = makeStore()
  const c = makeContext(SX_URL, store)
  check('没有关键词队列时不抛错', typeof c.kwStatLine({ results: [] }, ''), 'string')
  check('空队列 → 用「第 1 个」兜底', c.kwStatLine({ kwIndex: 0, results: [], kwOk: 1 }, ''), '「第 1 个」：翻 1 页、投 1 家')
}

// ---- 8) 换词：拦截清单 / 计数必须清零，不能把上个词的数带给新词 ----
// 真机事故（2026-11-05）：4 个词跑完报「被筛选拦掉 56 家」，其中 40 家属于上一个词。
// 原因是换词只是 spread 旧批次，而新词第 1 页若 0 可投会走 startPageScan，
// 那里做「旧数 + 本页数」的累加 —— 跨词就串账了。
{
  const store = makeStore()
  const c = makeContext(SX_URL, store)
  const kw = (k) =>
    `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(k)}&city=%E6%B7%B1%E5%9C%B3&type=school`
  const kwUrls = [kw('软件测试'), kw('SDET')]

  await c.setBatch({
    running: true,
    kwUrls,
    kwIndex: 0,
    kwOk: 2,
    queue: [],
    titles: [],
    results: [],
    total: 0,
    blockedList: Array.from({ length: 20 }, (_, i) => ({ title: `开发${i}`, reason: '方向不符' })),
    blockedTotal: 56,
    paging: { enabled: true, page: 2, pagesDone: 1, maxPages: 2, baseUrl: kwUrls[0], scanOnly: true },
  })

  await c.jumpToNextKeyword({
    nk: { url: kwUrls[1], index: 1, total: 2 },
    prev: null,
    limit: 10,
    force: false,
    from: '第 2 页没有岗位了',
    kwUrls,
  })
  const b = await c.getBatch()
  check('换词后拦截计数归零（56 属于上个词）', b.blockedTotal, 0)
  check('换词后拦截清单清空', b.blockedList, [])
  check('换词后成功数归零', b.kwOk, 0)
  check('换词后上个词的账留下了', b.kwStats.length, 1)
  check('上个词的账里仍是「拦 56 家」', b.kwStats[0].line.includes('拦 56 家'), true)
  check('新词页码归 1', b.paging.page, 1)
}

// ---- 9) 拦截原因：说得清 + 塞得进弹窗 ----
// 弹窗内容宽 332px，10px 字号约放 33 个字。原因原来被挤到 max-width 45%（≈14 字），
// 「标题里没有你要的方向词」这 11 字套话一占，真正想看的「插件找的是什么词」永远显示成「「测…」」。
// 这里同时守两件事：① 念的是**真实关键词**，不是带斜杠的方向标签（那串字原文里不存在）；
// ② 整句不超过一行，改长了就会又被 CSS 切掉（2026-11-05 真机连续两轮都栽在这）。
{
  const store = makeStore()
  const c = makeContext(SX_URL, store, true)
  const f = {
    enabled: true,
    cities: [],
    // 用默认的 4 组（qa/auto/api/game），这样「等 4 组」那句也会被算进长度
    directions: ['qa', 'auto', 'api', 'game'],
    daysPerWeek: 0,
    months: 0,
    strictMeta: false,
    maxExperience: null,
    maxEduRank: null,
  }
  const MAXLEN = 33

  // 「环境可靠性工程师」是真机里被拦掉的一条：标题不含任何方向词
  const noDir = c.screenJob({ jobTitle: '环境可靠性工程师', jdText: '', metaText: '' }, f, false)
  check('无方向词 → 拦', noDir.blocked, true)
  check('无方向词的原因念真实关键词', noDir.reason.includes('「'), true)
  check('无方向词的原因不再用方向标签（带斜杠）', noDir.reason.includes(' / '), false)
  check(`无方向词的原因 ≤ ${MAXLEN} 字`, noDir.reason.length <= MAXLEN, true)

  const other = c.screenJob({ jobTitle: '游戏运营实习生', jdText: '', metaText: '' }, f, false)
  check('别的方向 → 拦', other.blocked, true)
  check('说清「它是什么方向」', other.reason.includes('方向'), true)
  check(`方向不符的原因 ≤ ${MAXLEN} 字`, other.reason.length <= MAXLEN, true)

  const hit = c.screenJob({ jobTitle: '软件测试工程师', jdText: '', metaText: '' }, f, false)
  check('测试岗放行', hit.blocked, false)
}

// ---- 停止之后才投出去的那一家，账必须记 ----
// 2026-11-12 真机：界面写「1/2 成功」，BOSS 后台两家都在 ——
// 原因是用户点停止时，聊天页正把这家的招呼发出去；旧代码写着
// `if (b && b.running) applyBatchResult(...)`，发送照发、记账被吞。
// 投递不可撤销，账不能跟着「还跑不跑」一起丢。
{
  const store = makeStore()
  const boss = makeContext(BOSS_URL, store)
  const b = { ...mkBatch(BOSS_URL, 2), running: false, stopReason: '已手动停止', index: 1 }
  await boss.setBatch(b)

  const cur = await boss.getBatch()
  await boss.applyBatchResult(cur.queue[1], { ok: true, message: '已发送招呼语' }, cur, { stopAfter: true })
  const after = await boss.getBatch()

  check('★ 停止后才投出的那家仍然记账', after.results.length, 1)
  check('★ 记账后不会自己继续投下一家', after.running, false)
  check('★ 停止原因里点名「已记账，别重复投」', /已记账/.test(after.stopReason || ''), true)
  check('★ 结果本身仍算成功（不能因为停止就写成失败）', after.results[0].ok, true)
}

// 结构断言：光有 applyBatchResult 的新参数还不够 —— 调用点必须真的用上它。
// 旧 bug 就在调用点（`if (b && b.running)`），只测 applyBatchResult 会漏掉它。
{
  const src = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8')
  const at = src.indexOf('async function bootPendingBoss')
  const body = at > 0 ? src.slice(at, at + 9000) : ''
  check('找到 bootPendingBoss', body.length > 0, true)
  // 「批次还在跑」不能当记账的前提。这条断言必须容忍中间夹杂注释，
  // 否则就变成恒 false 的空转断言（写的时候踩过一次：正则要求紧跟 await，实际中间隔了 4 行注释）
  check(
    '★ 聊天页不许用「批次还在跑」当记账前提',
    /if\s*\(\s*b\s*&&\s*b\.running\s*\)\s*\{[^}]{0,400}?applyBatchResult/.test(body),
    false
  )
  const calls = [...body.matchAll(/await applyBatchResult\(/g)].map((m) => body.slice(m.index, m.index + 260))
  check('找到聊天页的两处记账调用', calls.length >= 2, true)
  check(
    '★ 聊天页每处记账都带 stopAfter',
    calls.length > 0 && calls.every((s) => /stopAfter:\s*!b\.running/.test(s)),
    true
  )
  check('★ 开投前必须过鉴权预检', /checkBackendAuth\(\)/.test(src), true)
}

// ---- 岗位名白名单（2026-11-14）----
// 用户换方向后「现有九组方向里没有我想投的岗位」，于是让他从页面上勾具体岗位名。
// 关键不是「能不能命中」，而是**勾了名字之后方向表和排除词都不许再插嘴** ——
// 否则「算法工程师」「AI训练师」这类会被「其他方向词」误拦，白名单等于白设。
{
  // ⚠️ screenJob 是同步函数、直接吃 f 参数（真正去 storage 读的是 applyFilters 里的
  // getJobFilters），所以这里必须显式传 f —— 只传 job 会命中 `if (!f) 放行` 那条早返回，
  // 得到「全部放行」的假绿（写测试时踩过）。
  const ctx = makeContext(BOSS_URL, makeStore(), true)
  const baseF = (onlyTitles, cities = []) => ({
    enabled: true,
    cities,
    daysPerWeek: 4,
    months: 3,
    directions: ['qa', 'auto', 'api', 'game', 'ops'],
    onlyTitles,
    maxExperience: 99,
    maxEduRank: 6,
    strictMeta: false,
  })
  const job = (title, meta = '经验不限 本科') => ({ jobTitle: title, company: '', jdText: '', metaText: meta })

  // 没设白名单 → 老行为：不在方向表里的岗位被拦
  check('没设白名单：方向表里没有的岗位仍被拦', ctx.screenJob(job('AI训练师'), baseF([]), true).blocked, true)

  // 设了白名单 → 只认名字
  check(
    '★ 白名单命中 → 放行（方向表里根本没有这一类）',
    ctx.screenJob(job('AI训练师'), baseF(['AI训练师']), true).blocked,
    false
  )
  check(
    '★ 白名单没命中 → 拦，并说清勾的是什么',
    /不在你勾的岗位名里/.test(ctx.screenJob(job('Python开发'), baseF(['AI训练师']), true).reason),
    true
  )

  // 关键：白名单要压过「其他方向词」（算法 / 机器学习 等）
  check(
    '★ 白名单命中时不受「其他方向词」干扰',
    ctx.screenJob(job('算法工程师'), baseF(['算法工程师']), true).blocked,
    false
  )
  check(
    '★ 白名单外仍会被排除词拦住',
    ctx.screenJob(job('量化交易分析师'), baseF(['算法工程师']), true).blocked,
    true
  )

  // 子串匹配：标题常带后缀 / 城市
  check(
    '★ 子串命中（标题带后缀也算）',
    ctx.screenJob(job('数据标注专员-深圳'), baseF(['数据标注']), true).blocked,
    false
  )

  // 硬约束仍然生效：白名单只回答「投什么岗位」，城市照筛
  check(
    '★ 白名单不豁免城市：外地岗位照样拦',
    ctx.screenJob(job('AI训练师', '北京·朝阳 经验不限'), baseF(['AI训练师'], ['深圳']), true).blocked,
    true
  )
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exit(1)
