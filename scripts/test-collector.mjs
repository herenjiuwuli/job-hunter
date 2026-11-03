/**
 * collector.js 解析层单测（不依赖浏览器、不依赖后端）
 *
 * 为什么要单独测：
 *   采集器有两块，DOM 定位和文本解析。DOM 定位错了能靠「探测」一眼看出来，
 *   解析错了不会报错 —— 它只会安静地把岗位名和公司名对调，然后写进漏斗。
 *   2026-11-02 真机事故就是这么发生的：company 抓成「系统测试实习生」、
 *   jobTitle 抓成「已投递被查看初筛笔试面试不合适录用」，7 条记录全是同一家。
 *
 * 用例直接取自那天实习僧「我的投递」页的真实 innerText，不是编的。
 *
 * 跑：node scripts/test-collector.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'extension', 'collector.js')

// collector.js 顶层只挂 window.__jhCollector，DOM 全在函数里 → 给个空壳就能加载
const ctx = { window: {}, document: {}, NodeFilter: { SHOW_TEXT: 4 }, location: { hostname: '', href: '' } }
createContext(ctx)
runInContext(readFileSync(SRC, 'utf-8'), ctx)

const C = ctx.window.__jhCollector
if (!C) {
  console.error('❌ collector.js 没挂上 window.__jhCollector')
  process.exit(1)
}

let pass = 0
let fail = 0

function eq(actual, expect, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expect)}\n     实际 ${JSON.stringify(actual)}`)
  }
}

const pick = (o) =>
  o && {
    company: o.company,
    city: o.city || '',
    jobTitle: o.jobTitle,
    appliedAt: o.appliedAt,
    stage: o.stage,
  }

console.log('— 城市拆分 —')
eq(C.splitCompanyCity('法雷奥-深圳'), { company: '法雷奥', city: '深圳' }, '法雷奥-深圳')
eq(C.splitCompanyCity('OPPO-深圳'), { company: 'OPPO', city: '深圳' }, 'OPPO-深圳')
eq(C.splitCompanyCity('亿道集团-深圳'), { company: '亿道集团', city: '深圳' }, '亿道集团-深圳')
eq(C.splitCompanyCity('法雷奥'), { company: '法雷奥', city: '' }, '没有城市就不拆')
// 公司名自带 - 且尾巴不是城市：整串保留，不能把「数据」当城市切走
eq(C.splitCompanyCity('某公司-数据部'), { company: '某公司-数据部', city: '' }, '尾巴不是城市不拆')
// 无分隔符但以城市结尾（部分平台的排布）
eq(C.splitCompanyCity('腾讯深圳'), { company: '腾讯', city: '深圳' }, '紧贴城市名也能拆')

console.log('— 阶段识别（与后端 stages.js 权重对齐）—')
eq(C.stageOfText('投递成功'), 'submitted', '投递成功 → submitted')
eq(C.stageOfText('已投递'), 'submitted', '已投递')
eq(C.stageOfText('待查看'), 'submitted', '待查看：还没被看')
eq(C.stageOfText('简历被查看'), 'viewed', '带前缀也能认')
eq(C.stageOfText('初筛'), 'screening', '初筛')
eq(C.stageOfText('面试'), 'interview', '面试')
eq(C.stageOfText('不合适'), 'rejected', '不合适 → rejected')
eq(C.stageOfText('录用'), 'offer', '录用')
eq(C.stageOfText('岗位描述里随便一段话'), null, '认不出来就返回 null，不瞎猜')

console.log('— 行解析：实习僧真实结构 —')
// 真机抓到的行（法雷奥「系统测试实习生」）
eq(
  pick(
    C.parseRowLines(['系统测试实习生', '法雷奥-深圳', '2026-11-02 16:42:21', '投递成功'], {
      tabStage: 'submitted',
    })
  ),
  {
    company: '法雷奥',
    city: '深圳',
    jobTitle: '系统测试实习生',
    appliedAt: new Date(2026, 10, 2, 16, 42, 21).toISOString(),
    stage: 'submitted',
  },
  '标准四行：岗位 / 公司-城市 / 时间 / 投递成功'
)

// ⚠️ 事故复现：整块 tab 容器被当成一行时，必须能自救
eq(
  pick(
    C.parseRowLines(
      ['已投递被查看初筛笔试面试不合适录用', '系统测试实习生', '法雷奥-深圳', '2026-11-02 16:42:21', '投递成功'],
      { tabStage: 'submitted' }
    )
  ),
  {
    company: '法雷奥',
    city: '深圳',
    jobTitle: '系统测试实习生',
    appliedAt: new Date(2026, 10, 2, 16, 42, 21).toISOString(),
    stage: 'submitted',
  },
  '首行是 tab 标签串时整行丢掉，不影响解析'
)

// 在「初筛」tab 下，行内文案还写着「投递成功」→ 以 tab 为准
eq(
  C.parseRowLines(['测试实习生', '法雷奥-深圳', '2026-11-02 16:41:51', '投递成功'], { tabStage: 'screening' })
    .stage,
  'screening',
  '行内是旧文案，tab 分类更新 → 取 tab'
)

// 在「已投递」tab 下，行内明确写了「面试」→ 取行内（更具体）
eq(
  C.parseRowLines(['测试实习生', '法雷奥-深圳', '2026-10-30 13:28:33', '面试'], { tabStage: 'submitted' })
    .stage,
  'interview',
  '行内更靠后 → 取行内'
)

// 缺公司名 → 宁可不报
eq(C.parseRowLines(['系统测试实习生', '2026-11-02 16:42:21', '投递成功']), null, '只有岗位没有公司 → 返回 null')

// 空行 / 全是噪声
eq(C.parseRowLines([]), null, '空行返回 null')
eq(C.parseRowLines(['投递成功', '2026-11-02 16:42:21']), null, '只有状态和时间 → 返回 null')

// 薪资行不能变成公司名
eq(
  pick(C.parseRowLines(['测试开发实习生', '200-250元/天', '韶音科技-深圳', '2026-10-30 13:32:55', '投递成功'])),
  { company: '韶音科技', city: '深圳', jobTitle: '测试开发实习生', appliedAt: new Date(2026, 9, 30, 13, 32, 55).toISOString(), stage: 'submitted' },
  '薪资行被跳过，公司名不错位'
)

console.log('— 时间格式 —')
eq(C.parseRowLines(['A岗位', 'B公司', '今天', '投递成功']).appliedAt, '', '相对时间（今天）不硬转成日期')
eq(
  C.parseRowLines(['A岗位', 'B公司', '2026/11/2 9:05', '投递成功']).appliedAt,
  new Date(2026, 10, 2, 9, 5, 0).toISOString(),
  '斜杠格式也能解析'
)

console.log('— 批量：10 条真实数据整体过一遍 —')
const REAL = [
  ['系统测试实习生', '法雷奥-深圳', '2026-11-02 16:42:21', '投递成功'],
  ['测试实习生', '法雷奥-深圳', '2026-11-02 16:41:51', '投递成功'],
  ['AI模型接入测试实习生（多模态/工程方向）', '分布顺云-深圳', '2026-11-02 16:41:17', '投递成功'],
  ['软件测试实习岗', '鑫斌科技-深圳', '2026-11-02 16:38:50', '投递成功'],
  ['测试工程师（可转正）', '墨泊可士-深圳', '2026-11-02 16:38:15', '投递成功'],
  ['测试实习生（笔记本电脑功能测试）', '亿道集团-深圳', '2026-11-02 16:37:34', '投递成功'],
  ['测试开发实习生', '韶音科技-深圳', '2026-10-30 13:32:55', '投递成功'],
  ['软件测试实习生', 'OPPO-深圳', '2026-10-30 13:31:53', '投递成功'],
  ['测试实习生', '蓝网科技-深圳', '2026-10-30 13:30:13', '投递成功'],
  ['台架测试实习生', '法雷奥-深圳', '2026-10-30 13:28:33', '投递成功'],
]
const parsedAll = REAL.map((lines) => C.parseRowLines(lines, { tabStage: 'submitted' }))
eq(parsedAll.every(Boolean), true, '10 条全部解析成功')
eq(
  parsedAll.map((x) => x.company),
  ['法雷奥', '法雷奥', '分布顺云', '鑫斌科技', '墨泊可士', '亿道集团', '韶音科技', 'OPPO', '蓝网科技', '法雷奥'],
  '公司名逐个正确（不带城市后缀）'
)
eq(
  parsedAll.map((x) => x.jobTitle),
  REAL.map((r) => r[0]),
  '岗位名逐个正确'
)
eq(
  parsedAll.every((x) => x.stage === 'submitted'),
  true,
  '全部判定为已投递'
)
// 同名岗位不同公司（法雷奥两个岗位名不同、不同公司同名「测试实习生」）不能被误合并
eq(parsedAll[1].company !== parsedAll[8].company, true, '「测试实习生」两家公司没串')

// ——————————————————————————————————————————————
console.log('— 分类 tab 名 → 阶段（实习僧七档）—')
// 名字来自真机 HTML：7 个 el-tabs__item
const TAB_NAMES = ['已投递', '被查看', '初筛', '笔试', '面试', '不合格', '录用']
eq(
  TAB_NAMES.map((n) => C.stageOfTabName(n)?.key),
  ['submitted', 'viewed', 'screening', 'written', 'interview', 'rejected', 'offer'],
  '七个 tab 名一一对上七档'
)
eq(C.stageOfTabName('已投递 12')?.key, 'submitted', '带徽标数字也能认（「已投递 12」）')
eq(C.stageOfTabName('不合适')?.key, 'rejected', '「不合适」也算不合格')
// ⚠️ 这条最容易写错：待查看 = 还没看，必须算已投递而不是被查看
eq(C.stageOfTabName('待查看')?.key, 'submitted', '「待查看」算已投递（不能算被查看）')
eq(C.stageOfTabName('')?.key, undefined, '空名字返回 null')
eq(C.stageOfTabName('消息')?.key, undefined, '非阶段词返回 null')
// 名字里同时含两个词时取最长的（「已录用」不能被「录用」先匹配后错位）
eq(C.stageOfTabName('已录用')?.word, '已录用', '同时命中多个词取最长的')

// ——————————————————————————————————————————————
console.log('— 镜像守卫（7 个 pane 渲染同一份全量列表时不能信 tab 名）—')
const tDelivered = { name: '已投递', ids: ['a', 'b', 'c'], rows: 3 }
const tCheckedMirror = { name: '被查看', ids: ['a', 'b', 'c'], rows: 3 }
const tCheckedReal = { name: '被查看', ids: ['b'], rows: 1 }
eq(C.pickBaseTab([tCheckedReal, tDelivered])?.name, '已投递', '基线取行数最多的 tab')
eq(C.isMirrorOfBase(tCheckedMirror, tDelivered), true, '集合完全相同 → 判为镜像')
eq(C.isMirrorOfBase(tCheckedReal, tDelivered), false, '集合是子集（不等长）→ 不是镜像')
eq(C.isMirrorOfBase(tDelivered, tDelivered), false, '基线和自己比不算镜像')
eq(C.isMirrorOfBase({ ids: [] }, tDelivered), false, '空 tab 不算镜像')
eq(C.pickBaseTab([]), null, '没有 tab 时返回 null')
// 真分组时基线优先「已投递」（全集），哪怕它行数不是最多
eq(
  C.pickBaseTab([
    { name: '被查看', stage: 'viewed', ids: ['a', 'b', 'c'] },
    { name: '已投递', stage: 'submitted', ids: ['a'] },
  ]).name,
  '已投递',
  '有「已投递」就用它当基线，即使行数更少'
)
eq(
  C.pickBaseTab([
    { name: '被查看', stage: 'viewed', ids: ['a', 'b', 'c'] },
    { name: '初筛', stage: 'screening', ids: ['d'] },
  ]).name,
  '被查看',
  '没有「已投递」→ 退回行最多的那个'
)
// 同长度但内容不同（全部投递都推进到下一档）也不能算镜像
eq(C.isMirrorOfBase({ ids: ['x', 'y', 'z'] }, tDelivered), false, '等长但内容不同 → 不是镜像')

// ——————————————————————————————————————————————
console.log('— 探测：pane 里到底写了什么阶段词 —')
eq(Object.keys(C.stageWordStats({ textContent: '' })).length, 0, '空文本 → 没有阶段词')
eq(C.stageWordStats({ textContent: '投递成功' }).投递成功, 1, '单个「投递成功」计 1')
// 用户 2026-11-03 真机数据：「被查看」pane 里 10 条全是「投递成功」→ 镜像的确凿证据
const paneText = Array.from({ length: 10 }, () => '系统测试实习生 法雷奥-深圳 投递成功').join(' ')
const w = C.stageWordStats({ textContent: paneText })
eq(w.投递成功, 10, '10 条投递成功 → 计 10')
eq(w.被查看, undefined, '没有「被查看」就不到表里 —— 说明该 pane 不是按阶段过滤的')
eq(C.stageWordStats({ textContent: '待查看' }).待查看, 1, '「待查看」按整词计 1，不会被更短的词拆开')

// ——————————————————————————————————————————————
console.log('— 多 tab 合并：同一条取权重最大的阶段 —')
const mk = (jobId, company, jobTitle, stage) => ({ item: { jobId, company, jobTitle, stage } })
// 在「已投递」tab 采到 submitted，又在「初筛」tab 采到 screening → 应该是 screening
const m1 = C.mergeEntries([mk('inn_a', '法雷奥', '系统测试实习生', 'submitted'), mk('inn_a', '法雷奥', '系统测试实习生', 'screening')])
eq(m1.items.length, 1, '同一 jobId 只留一条')
eq(m1.items[0].stage, 'screening', '取权重更大的阶段')
eq(m1.duplicate, 1, '重复计数')
// 顺序反过来结果必须一样（不能依赖采集顺序）
const m2 = C.mergeEntries([mk('inn_a', 'A', 'B', 'interview'), mk('inn_a', 'A', 'B', 'submitted')])
eq(m2.items[0].stage, 'interview', '顺序颠倒也取权重最大的')
// 录用(9) 不该被后来的「不合格」(8) 覆盖
const m3 = C.mergeEntries([mk('inn_a', 'A', 'B', 'offer'), mk('inn_a', 'A', 'B', 'rejected')])
eq(m3.items[0].stage, 'offer', '录用不被「不合格」拉回')
// 不同 jobId 各留一条
const m4 = C.mergeEntries([mk('inn_a', 'A', 'B', 'submitted'), mk('inn_b', 'A', 'C', 'submitted')])
eq(m4.items.length, 2, '不同 jobId 互不合并')
// 没有 jobId 时退回「公司+岗位」做键
const m5 = C.mergeEntries([
  { item: { company: 'X', jobTitle: '测试', stage: 'submitted' } },
  { item: { company: 'X', jobTitle: '测试', stage: 'viewed' } },
])
eq(m5.items.length, 1, '无 jobId 时按公司+岗位合并')
eq(m5.items[0].stage, 'viewed', '无 jobId 也取权重最大的')
// read 只要任一来源标了就保留
const m6 = C.mergeEntries([
  { item: { jobId: 'inn_c', company: 'A', jobTitle: 'B', stage: 'submitted' } },
  { item: { jobId: 'inn_c', company: 'A', jobTitle: 'B', stage: 'submitted', read: true } },
])
eq(m6.items[0].read, true, '任一来源标了已读就保留已读')

console.log(`\n${fail === 0 ? '✅' : '❌'} collector 解析用例：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
