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

console.log(`\n${fail === 0 ? '✅' : '❌'} collector 解析用例：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
