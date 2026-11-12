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
// URL 必须给：vm 的空上下文里没有它，searchScopeOf 会全都走 catch 返回空，
// 看着像「函数写错了」，其实只是测试环境缺浏览器自带的内建对象
const ctx = {
  window: {},
  document: {},
  NodeFilter: { SHOW_TEXT: 4 },
  location: { hostname: '', href: '' },
  URL,
  // vm 上下文是隔离的，不继承 Node 的全局 —— 采集器里 sleepMs 用 setTimeout，
  // 不补的话「点开会话」那批用例直接 ReferenceError（看着像函数写错了）。
  setTimeout: (fn, ms) => setTimeout(fn, ms),
}
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

// — 投递日期：BOSS 写「11-08 投递」，比「整行就是日期」宽松；但**薪资绝不能被当成日期** —
eq(C.dateFromText('11-08 投递') !== '', true, '「11-08 投递」要读得出（BOSS 投递记录页的写法）')
eq(new Date(C.dateFromText('11-08 投递')).getMonth() + 1, 11, '没有年份时补今年，月份不能错位')
eq(C.dateFromText('投递于 08-05') !== '', true, '「投递于 08-05」也要认')
eq(C.dateFromText('11月08日') !== '', true, '「11月08日」也要认（带汉字月/日）')
eq(C.dateFromText('2026-11-09 08:05') !== '', true, '完整日期照旧')
// 这三条是「宁可漏，不许错」的底线：把薪资当投递日期写进账本，比没有日期坏得多
eq(C.dateFromText('3-5K'), '', '★ 薪资「3-5K」不是日期')
eq(C.dateFromText('200-250元/天'), '', '★ 日薪「200-250元/天」不是日期')
eq(C.dateFromText('15-30K·14薪'), '', '★ 月薪「15-30K·14薪」不是日期')
// 夹着日期的行不能变成公司名/岗位名
eq(
  pick(C.parseRowLines(['测试开发实习生', '11-08 投递', '韶音科技-深圳'])),
  { company: '韶音科技', city: '深圳', jobTitle: '测试开发实习生', appliedAt: C.dateFromText('11-08 投递'), stage: null },
  '★ 「11-08 投递」只贡献日期，不许被当成公司名'
)

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

// ——————————————————————————————————————————————
console.log('— resolveMirror：行内文案印证过的 tab 不能被集合巧合判成镜像 —')
// 事故场景：初筛 tab 只有 1 条，点 tab 后列表没刷新就读到「已投递」整页 → 集合相同。
// confirmed 表示我们确实等到列表换成了这个阶段的数据，此时集合雷同只是巧合。
eq(
  C.resolveMirror({ ids: ['a', 'b', 'c'], confirmed: true }, tDelivered),
  false,
  'confirmed 的 tab 即使集合与基线相同也不算镜像（2026-11-03 初筛丢失事故）'
)
eq(
  C.resolveMirror({ ids: ['a', 'b', 'c'], confirmed: false }, tDelivered),
  true,
  '没确认过 + 集合相同 → 仍判镜像（平台改回全量渲染时兜底）'
)
eq(C.resolveMirror(tDelivered, tDelivered), false, '基线自己不是镜像')
eq(C.resolveMirror({ ids: ['b'], confirmed: false }, tDelivered), false, '集合不同 → 不是镜像')

// ——————————————————————————————————————————————
console.log('— isDisabledBtn：分页按钮的「假可点」—')
// 真机误报的根因：第一页的 prev 只加了 is-disabled 类，没设 disabled 属性。
// 只看 b.disabled 会以为可点 → 点一下没反应 → 误报「回不到第 1 页，可能漏前面几页」。
const btn = (attrs = {}, cls = '') => ({
  disabled: !!attrs.disabled,
  className: cls,
  getAttribute: (k) => (k in attrs ? attrs[k] : null),
  hasAttribute: (k) => k in attrs,
})
eq(C.isDisabledBtn(btn({ disabled: true })), true, '有 disabled 属性 → 禁用')
eq(C.isDisabledBtn(btn({}, 'btn-prev is-disabled')), true, '只有 is-disabled 类 → 也算禁用（真机第一页就是这种）')
eq(C.isDisabledBtn(btn({}, 'btn-prev')), false, '没有禁用标记 → 可点')
eq(C.isDisabledBtn(btn({ 'aria-disabled': 'true' }, 'btn-prev')), true, 'aria-disabled=true → 禁用')
eq(C.isDisabledBtn(null), true, '没有按钮就当禁用，别去点')
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

// ——————————————————————————————————————————————
// 岗位 id 提取：BOSS 必须带 boss_ 前缀
// 为什么守着：投递那一刻写进本地账本和后端的是 boss_xxx，采集端若返回裸 id，
// 同一条投递会出现两个 id —— 后端 sameApply 只能退回「公司+岗位名」硬猜，
// 岗位一改名就断，而且是静默的（没有任何报错）。
// ——————————————————————————————————————————————
console.log('— 岗位 id 提取 —')
eq(
  C.jobIdOfHref('https://www.zhipin.com/job_detail/7bd2d88a19b8f2ca0nJ729u1F1FY.html'),
  'boss_7bd2d88a19b8f2ca0nJ729u1F1FY',
  'BOSS 老版路径 → 带 boss_ 前缀'
)
eq(
  C.jobIdOfHref('https://www.zhipin.com/job_detail/?jobId=abc123XYZ'),
  'boss_abc123XYZ',
  'BOSS 新版 query 形式 → 带 boss_ 前缀'
)
eq(
  C.jobIdOfHref('https://www.shixiseng.com/intern/inn_waushlks3uhu'),
  'inn_waushlks3uhu',
  '实习僧保持裸 inn_ id，不加前缀'
)
eq(C.jobIdOfHref('https://example.com/nothing'), '', '认不出的链接返回空串，不瞎猜')

// ——————————————————————————————————————————————
// 翻页自检：翻页最大的坑是「看着翻了、其实没翻」
// 为什么守着：站点忽略 page 参数时，批量会把同一页反复投，而且每条都显示成功 ——
// 没有报错、没有异常，只有拿「这一页的 jobId 集合」和上一页比才能发现。
// ——————————————————————————————————————————————
console.log('— 翻页自检 —')
eq(
  C.checkPageFresh(['a', 'b', 'c'], [], ['a']),
  { ok: true, reason: '', fresh: ['b', 'c'] },
  '新页有没见过的岗位 → 放行，fresh 只给新的'
)
eq(C.checkPageFresh([], ['a', 'b'], ['a', 'b']), { ok: false, reason: 'empty', fresh: [] }, '一个岗位都没抓到 → 到底了')
eq(
  C.checkPageFresh(['c', 'b', 'a'], ['a', 'b', 'c'], ['a', 'b', 'c']),
  { ok: false, reason: 'same-as-prev', fresh: [] },
  '和上一页集合完全相同（顺序不同）→ 翻页没生效'
)
eq(
  C.checkPageFresh(['a', 'b', 'a'], ['a', 'b'], ['a', 'b', 'c']),
  { ok: false, reason: 'all-seen', fresh: [] },
  '条数不同但全是见过的 → 到底了，不能当成翻页成功'
)
eq(
  C.checkPageFresh(['d', 'a'], [], ['a', 'b', 'c']),
  { ok: true, reason: '', fresh: ['d'] },
  '上一页为空时不误判「没翻」'
)
eq(
  C.checkPageFresh(['a', 'b'], ['x', 'y'], []),
  { ok: true, reason: '', fresh: ['a', 'b'] },
  '和上一页不同、也没见过 → 正常翻页'
)
eq(
  C.checkPageFresh([null, '', 'a'], [], []),
  { ok: true, reason: '', fresh: ['a'] },
  '空 id 被忽略，不会把整页误判成空'
)

// ——————————————————————————————————————————————
// 搜索范围：从 URL 读「这批投什么」
// 2026-11-05 真机：表单只填了城市，算出的地址没有 keyword，
// 于是「投测试」变成了「投深圳全部实习岗」—— 日志里只有一句「正在跳到起点」看不出来。
// ——————————————————————————————————————————————
console.log('— 搜索范围 —')
eq(
  C.searchScopeOf('https://www.shixiseng.com/interns?keyword=%E6%B5%8B%E8%AF%95&city=%E6%B7%B1%E5%9C%B3&type=school').text,
  '关键词 测试｜城市 深圳｜类型 校招',
  '中文参数解码后拼成一句人话'
)
eq(
  C.searchScopeOf('https://www.shixiseng.com/interns?city=%E6%B7%B1%E5%9C%B3&type=intern').keyword,
  '',
  '缺 keyword 时读成空串（不是 undefined）'
)
eq(
  C.searchScopeOf('https://www.shixiseng.com/interns?city=%E6%B7%B1%E5%9C%B3&type=intern').risky,
  '关键词为空：这一批是「该城市全部岗位」，不是某个方向',
  '关键词为空必须标红：全城岗位 ≠ 某个方向'
)
eq(
  C.searchScopeOf('https://www.shixiseng.com/interns?keyword=%E6%B5%8B%E8%AF%95').risky,
  '',
  '有关键词就不算风险范围'
)
eq(
  C.searchScopeOf('https://www.shixiseng.com/interns?keyword=%E6%B5%8B%E8%AF%95').text,
  '关键词 测试｜城市 ⚠️ 不限｜类型 ⚠️ 未指定',
  '缺项用 ⚠️ 标出，不静默当成「不限」'
)
eq(C.searchScopeOf('not a url').text, '', '地址不合法返回空，不抛错')
eq(C.searchScopeOf('https://www.shixiseng.com/interns?keyword=%E6%B5%8B&type=company').typeName, '企业', 'type=company 也认得')

// BOSS 的参数名和实习僧不一样（query / 数字城市码）。只认 keyword 的话，
// BOSS 上一键投递会全程显示「关键词 ⚠️ 不限」，而它其实有词 —— 用户会以为在整城全投。
eq(
  C.searchScopeOf('https://www.zhipin.com/web/geek/job?query=%E6%B5%8B%E8%AF%95&city=101280600').keyword,
  '测试',
  '★ BOSS 的 query 也当关键词读，不再误报「不限」'
)
eq(
  C.searchScopeOf('https://www.zhipin.com/web/geek/job?query=%E6%B5%8B%E8%AF%95&city=101280600').risky,
  '',
  '★ 有 query 就不算风险范围（这是 2026-11-12 误报的那一条）'
)
eq(
  C.searchScopeOf('https://www.zhipin.com/web/geek/job?query=%E6%B5%8B%E8%AF%95&city=101280600').text,
  '关键词 测试｜城市 已锁(101280600)｜类型 ⚠️ 未指定',
  '★ 城市码不译成中文：只如实说「锁了」，猜错城市比不猜更糟'
)
eq(
  C.searchScopeOf('https://www.zhipin.com/web/geek/job').risky,
  '关键词为空：这一批是「该城市全部岗位」，不是某个方向',
  'BOSS 连 query 都没有时才该标红'
)
eq(
  C.searchScopeOf('https://www.zhipin.com/web/geek/job?query=%E6%B5%8B&jobType=1901').typeName,
  '已选(1901)',
  'BOSS 的 jobType 不认识就原样显示，不假装是「实习」'
)

// ===== 一页全投不了时，原因要说全（emptyPageReason） =====
eq(
  C.emptyPageReason({ total: 20, appliedSkip: 15, blockedCount: 3, pendingCount: 2, blockedFirst: '城市不符（岗位在 北京）' }),
  '本页 20 家：15 家本地已投过、2 家写「全国」待定（没自动投）、3 家不符合筛选（例如：城市不符（岗位在 北京））',
  '三类原因叠加时必须全说出来 —— 只报「都投过了」会盖住另外两类'
)
eq(
  C.emptyPageReason({ total: 20, appliedSkip: 20, blockedCount: 0, pendingCount: 0 }),
  '本页 20 家：20 家本地已投过',
  '只有一类原因时只报那一类'
)
eq(
  C.emptyPageReason({ total: 0, appliedSkip: 0, blockedCount: 0, pendingCount: 0 }),
  '当前页面没抓到岗位链接（新建一批要在搜索结果列表页启动）',
  '一个岗位都没认到：说的是「没抓到链接」，不是「都投过了」'
)
// 2026-11-05 真机：SDET 只有 1 页，翻到第 2 页空 → 原来报的也是「新建一批要在结果页启动」，
// 用户在列表页上看到这句会以为插件认错了页面。第 2 页起空了只有一个含义：到底了。
eq(
  C.emptyPageReason({ total: 0, page: 2 }),
  '第 2 页没有岗位了（这个搜索条件只有 1 页，已经到底）',
  '翻到第 2 页空 = 到底了，不能说成「不在列表页」'
)
eq(
  C.emptyPageReason({ total: 0, page: 4 }),
  '第 4 页没有岗位了（这个搜索条件只有 3 页，已经到底）',
  '第 N 页空 → 只有 N-1 页，数字要跟着页号走'
)
eq(
  C.emptyPageReason({ total: 4, page: 3, blockedCount: 4, blockedFirst: '「环境可靠性工程师」' }),
  '第 3 页 4 家：4 家不符合筛选（例如：「环境可靠性工程师」）',
  '翻页后的「为什么不能投」也要标出页号，并且举例用标题（用户才知道是不是误杀）'
)
eq(
  C.emptyPageReason({ total: 5, appliedSkip: 0, blockedCount: 0, pendingCount: 5 }),
  '本页 5 家：5 家写「全国」待定（没自动投）',
  '全是「全国」岗位时不能报成 0 家'
)
eq(
  C.emptyPageReason({ total: 20, appliedSkip: 15, blockedCount: 2, pendingCount: 2 }),
  '本页 20 家：15 家本地已投过、2 家写「全国」待定（没自动投）、2 家不符合筛选、另有 1 家原因不明（可能是标题没解析出来）',
  '三类原因之和对不上总数 → 必须点名「原因不明」，不允许静默吞岗位'
)

console.log('\n— 关键词轮换的边界 —')
// 写错的两种表现都不报错，只体现在「投递量莫名其妙多一批/少一批」，所以必须卡边界
eq(C.nextKeywordIndex(3, 0), 1, '3 个词，第 1 个跑完 → 第 2 个')
eq(C.nextKeywordIndex(3, 2), -1, '最后一个词跑完 → 没有了（不能回绕到第 1 个）')
eq(C.nextKeywordIndex(1, 0), -1, '只有 1 个词 = 不轮换')
eq(C.nextKeywordIndex(2, 1), -1, '2 个词的最后一个 → 没有了')
eq(C.nextKeywordIndex(5, 9), -1, '序号越界（配置被改小过）→ 当没有，别抛错')
eq(C.nextKeywordIndex(0, 0), -1, '空列表 → 没有')

console.log('\n— 结构兜底探测（BOSS 对话列表：没有岗位链接、也认不出阶段词）—')
// 这一组守的是「探测一次就能定位」：如果分组规则把全局容器当成列表项，
// 用户看到的是「div.container 有 1 条样本」，等于还是没说。
const G = (key, count) => ({ key, tag: key.split('.')[0], cls: key.split('.')[1], count })
eq(
  C.rankBlockGroups([G('DIV.item', 20), G('DIV.card', 5), G('DIV.app', 900), G('DIV.x', 2)]).map((g) => g.key),
  ['DIV.item', 'DIV.card'],
  '只留「重复 3~60 次」的组：太少的（2）是散件，太多的（900）是全局容器'
)
eq(
  C.rankBlockGroups([G('DIV.card', 5), G('DIV.item', 20), G('DIV.row', 8)]).map((g) => g.count),
  [20, 8, 5],
  '按出现次数降序 —— 列表项一定是最多的那一批'
)
eq(C.rankBlockGroups([G('DIV.item', 20), G('DIV.row', 8)]).length, 2, '默认只吐前 3 组，别把弹窗撑爆')
eq(C.rankBlockGroups([]).length, 0, '空输入不报错')
eq(C.rankBlockGroups(null).length, 0, 'null 不报错（探测跑在页面异常时）')

// 样本像不像「一行」：BOSS 会话行 = 公司 + 岗位 + 时间 + 已读，2~10 行
eq(C.looksLikeRow(['某某科技', '测试工程师', '昨天']), true, '三行文本 = 像一行')
eq(C.looksLikeRow(['某某科技']), false, '只有一行 → 可能是按钮/标题，不当成行')
eq(C.looksLikeRow([]), false, '空 → 不是行')
eq(C.looksLikeRow(Array.from({ length: 15 }, (_, i) => `第${i}行`)), false, '十几行 = 整个列表区，锁大了')
eq(C.looksLikeRow(['长'.repeat(400)]), false, '单块三百字以上 → 是容器不是一行')

// ——————————————————————————————————————————————
// 探测报告里的元素标签：说得清「哪一块」，且不会因为没 class / class 一堆而崩
// （2026-11-05 真机：探测只回了 stageHits:1，因为命中落在筛选栏的「未读」tab 上，
//   而当时输出结构信息的条件是 `!hits.length` —— 一条都不许漏，否则就白跑一趟）
const el = (tag, cls, id) => ({ tagName: tag, className: cls || '', id: id || '' })
eq(C.shortLabel(el('DIV', 'chat-user-item active')), 'DIV.chat-user-item.active', 'tag + 前两个 class，够定位又不啰嗦')
eq(C.shortLabel(el('LI', 'item')), 'LI.item', '单个 class 也照常')
eq(C.shortLabel(el('DIV', '')), 'DIV', '没 class 不崩，至少还知道是 DIV')
eq(C.shortLabel(el('DIV', 'x', 'panel')), 'DIV#panel.x', '有 id 时带 id（id 比 class 更能唯一定位）')
eq(C.shortLabel(null), '', 'null 返回空串 —— 探测里 rowOfStageNode 常返回 null')

// ——————————————————————————————————————————————
// 真的跑一遍结构扫描。
// 这段代码在真机上「只要命中 1 个阶段词就不执行」，所以从写出来那天起从没被走到过 ——
// v0.7.3 去掉抑制条件后第一次执行就炸 `g.els is not iterable`：
// rankBlockGroups 是纯函数，只回 key/tag/cls/count，元素实例留在 groups 里，必须按 key 取回来。
// 这类「从没执行过的分支」只能靠 DOM stub 逼它跑，靠真机试错太贵（用户点一次、我改一版）。
console.log('\n— 探测：跑一遍结构扫描（防止「从没执行过的分支」再炸）—')

const mkEl = (tag, cls, text, children) => {
  const el = {
    tagName: tag,
    className: cls || '',
    id: '',
    innerText: text || '',
    children: children || [],
    parentElement: null,
    querySelectorAll: () => [],
    // 会话采集里会 querySelector('.chat-position-content') / ('.salary') 等。
    // 默认返回 null（真机没这个节点也是这样），要测具体分支就在用例里覆盖。
    querySelector: () => null,
    // 逐条点开会话用；默认不做事，用例里覆盖来统计「到底点了哪几行」
    click: () => {},
    getAttribute: () => '',
    // 用在「排除列表自己那条分支」这类判断上：探测代码靠 contains 区分容器归属
    contains: (n) => {
      if (!n) return false
      if (el === n) return true
      return el.children.some((c) => c.contains && c.contains(n))
    },
  }
  for (const c of el.children) c.parentElement = el
  return el
}

// 一个聊天列表：UL 装 5 个会话行，每行 3 行文本（公司 / 岗位 / 时间或已读）
const chatRows = [
  mkEl('DIV', 'chat-user-item active', 'A公司\n测试实习生\n已读'),
  mkEl('DIV', 'chat-user-item', 'B公司\n测试开发\n昨天'),
  mkEl('DIV', 'chat-user-item', 'C公司\n自动化测试\n昨天'),
  mkEl('DIV', 'chat-user-item', 'D公司\n软件测试\n前天'),
  mkEl('DIV', 'chat-user-item', 'E公司\n测试工程师\n前天'),
]
const chatList = mkEl('UL', 'chat-list', '', chatRows)

ctx.getComputedStyle = () => ({ display: 'block', visibility: 'visible' })
ctx.document = {
  querySelectorAll: (sel) => {
    if (sel === 'div,li,article,section,tr,a,span') return chatRows
    if (sel === 'div,ul,ol,section,aside,main,form,table,tbody,dl') return [chatList]
    return []
  },
  body: { innerText: '' },
}

let layout = null
try {
  layout = C.probeLayout()
} catch (e) {
  console.log(`  ❌ probeLayout 抛错：${e.message}`)
}
eq(!!(layout && Array.isArray(layout.groups)), true, 'probeLayout 跑完不抛错（以前这里会 g.els is not iterable）')
eq(layout && layout.groups.length, 1, '5 个同 class 的会话行 → 合成 1 组重复结构')
eq(layout && layout.groups[0].count, 5, '带 active 的那行首个 class token 相同 → 仍算同一组')
eq(layout && layout.groups[0].samples.length, 3, '每组最多 3 条样本，别把弹窗撑爆')
eq(layout && layout.groups[0].samples[0].lines[1], '测试实习生', '样本带得出岗位名 —— 一眼认出这是会话行')

const boxes = C.probeContainers()
eq(boxes.list.length, 1, '5 个同构子元素 → 认出 1 个列表容器')
eq(boxes.list[0].itemKey, 'DIV.chat-user-item', '容器报的是每行的 tag+class')
eq(boxes.list[0].count, 5, '容器计数 = 5')
eq(boxes.list[0].ofChildren, 5, '父子比例 5/5 —— 说明这容器基本就是列表本体')
eq(boxes.list[0].parent, 'UL.chat-list', 'parent 是能定位到的容器标签')

eq(C.probeFrames().count, 0, '没有 iframe 时返回 count:0，不报错')

ctx.document.querySelectorAll = (sel) =>
  sel === 'iframe'
    ? [{ getAttribute: () => 'about:blank', contentDocument: { body: { innerText: '会话列表' }, querySelectorAll: () => ({ length: 7 }) } }]
    : []
const fr = C.probeFrames()
eq(fr.count, 1, '有 1 个 iframe 就报 1 个')
eq(fr.list[0].accessible, true, '同源 iframe 能读到 contentDocument → accessible:true')
eq(fr.list[0].divs, 7, '报出 iframe 内部 div 数 —— 判断「列表是不是被塞进 iframe 了」')

const cross = { getAttribute: () => 'https://other.example/x' }
Object.defineProperty(cross, 'contentDocument', {
  get: () => {
    throw new Error('SecurityError')
  },
})
ctx.document.querySelectorAll = (sel) => (sel === 'iframe' ? [cross] : [])
eq(C.probeFrames().list[0].accessible, false, '跨域 iframe 读不到 → accessible:false，不抛错')

// ——————————————————————————————————————————————
// BOSS 会话列表：结构取自 2026-11-05 真机探测（UL > LI > .friend-content，
// 状态是 <i class="message-status status-read|status-delivery">，页面上的字是 [已读]/[送达]）。
console.log('\n— BOSS 会话列表探测 —')

const mkChatRow = (who, status, msg) => {
  const icon = status && {
    tagName: 'I',
    className: `message-status status-${status}`,
    id: '',
    innerText: status === 'read' ? '[已读]' : '[送达]',
    children: [],
    parentElement: null,
    attributes: [],
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => '',
  }
  const li = {
    tagName: 'LI',
    className: '',
    id: '',
    innerText: '',
    children: [],
    parentElement: null,
    attributes: [
      { name: 'class', value: '' },
      { name: 'data-id', value: `id-${who}` },
      { name: 'title', value: who },
    ],
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => '',
  }
  const content = {
    tagName: 'DIV',
    className: 'friend-content',
    id: '',
    innerText: ['11月03日', who, status === 'read' ? '[已读]' : status === 'delivery' ? '[送达]' : '', msg]
      .filter(Boolean)
      .join('\n'),
    children: [],
    parentElement: li,
    attributes: [],
    querySelector: () => icon,
    querySelectorAll: () => [],
    closest: () => li,
    getAttribute: () => '',
  }
  li.children.push(content)
  return content
}

const chatContents = [
  mkChatRow('秦女士KeepHR', 'delivery', '您好，我是计算机应用工程大四在读…'),
  mkChatRow('张先生万兴科技招聘者', 'read', '您好，我是计算机应用工程大四在读…'),
  mkChatRow('周先生AnkerHR', null, '你好，方便发一份简历吗'),
]

ctx.getComputedStyle = () => ({ display: 'block', visibility: 'visible' })
ctx.document = {
  querySelectorAll: (sel) => (sel === '.friend-content' ? chatContents : []),
  querySelector: () => null,
  body: { innerText: '' },
}

const cl = C.probeChatList()
eq(cl.count, 3, '认出 3 条会话')
eq(cl.rows[0].read, false, 'status-delivery → read:false（只送达，对方还没看）')
eq(cl.rows[1].read, true, 'status-read → read:true（我方最后一条被读）')
eq(cl.rows[2].read, null, '没有送达图标 → read:null（多半是对方最后发的 ≈ 已回复）')
eq(cl.rows[0].attrs['data-id'], 'id-秦女士KeepHR', 'li 上的 data-* 带得出来 —— 加密 jobId 就藏在这里')
eq(cl.rows[0].lines[1], '秦女士KeepHR', '保留「对方 + 公司 + 角色」那行，公司名要从这里剥')
eq(cl.rows[2].lines.slice(-1)[0], '你好，方便发一份简历吗', '对方最后说的话也带得出来')

ctx.document.querySelectorAll = () => []
eq(C.probeChatList().count, 0, '没有 .friend-content（左栏空着）→ count:0，不报错')

const panel = C.probeChatPanel()
eq(!!panel.note, true, '找不到右侧会话区时给 note，不抛错')

// ——————————————————————————————————————————————
// 右侧对话区：BOSS 上 .chat-content 只装着左栏（.user-list），
// 真实的「当前会话」是它的**兄弟**节点。v0.7.5 把 .chat-content 当对话区，
// 于是「点开也拿不到岗位」这个结论是错的 —— 当时根本没打开会话。
console.log('\n— 右侧对话区探测（容器分层 + 消息行）—')

const buildChatDom = (withPanel) => {
  const listEl = mkEl('DIV', 'user-list', '11月03日 秦女士KeepHR [送达] 您好…')
  const holder = mkEl('DIV', 'chat-content', '')
  const outer = mkEl('DIV', 'chat-im', '')
  holder.children.push(listEl)
  listEl.parentElement = holder
  holder.parentElement = outer
  outer.children.push(holder)
  if (!withPanel) return { listEl, holder, outer }

  const msgList = mkEl('DIV', 'message-list', '')
  for (const t of ['你好，方便聊一下吗', '方便发一份简历吗', '好的，稍后发您']) {
    const row = mkEl('DIV', 'message-item', t)
    msgList.children.push(row)
  }
  const jobTag = mkEl('SPAN', 'job-name', '软件测试工程师 15-25K·13薪')
  const panelEl = mkEl('DIV', 'chat-record', '沟通职位 软件测试工程师 15-25K 你好，方便聊一下吗')
  panelEl.parentElement = outer
  panelEl.querySelectorAll = (sel) => {
    if (sel === 'div,ul,ol,section,aside,main') return [msgList]
    if (sel === 'div,span,a,p,h1,h2,h3') return [jobTag]
    if (sel.indexOf('message') >= 0) return msgList.children
    if (sel.indexOf('job') >= 0) return [{}, {}]
    return []
  }
  panelEl.getAttribute = () => ''
  outer.children.push(panelEl)
  return { listEl, holder, outer, panelEl, msgList }
}

// ① 没点开会话：只有左栏 → 必须明说「点开一条再探」
let dom = buildChatDom(false)
ctx.document.querySelector = (sel) => (sel === '.user-list' ? dom.listEl : null)
let noPane = C.probeChatPanel()
eq(noPane.panel, null, '只找到左栏时 panel:null —— 不假装拿到了对话区')
eq(/不在列表的兄弟节点/.test(noPane.note), true, 'note 说清「是结构问题」而不是「你没点开」—— 点开了却找不到，怪用户是错的')
eq(Array.isArray(noPane.jobLinkList), true, '找不到对话区时仍给出岗位链接明细（这是唯一可能带岗位名的地方）')
eq(noPane.shadowCount, 0, '没有 shadow root 时报 0（排除「对话区藏在 web component 里」）')
eq(noPane.upChain.length >= 2, true, '往上爬的层级照常输出，方便判断右侧到底挂在哪一层')

// ② 点开会话：右侧是左栏的兄弟 → 认出对话区 + 消息行结构
dom = buildChatDom(true)
ctx.document.querySelector = (sel) => (sel === '.user-list' ? dom.listEl : null)
const pane = C.probeChatPanel()
eq(pane.panel !== null, true, '打开会话后能定位到右侧对话区')
eq(/chat-record/.test(pane.panel.el), true, 'panel.el 指向真正的对话区（.chat-record），不是 .user-list')
eq(pane.panel.groups[0].itemKey, 'DIV.message-item', '消息行结构认得出来 —— 以后抓「对方最后一句」靠这个')
eq(pane.panel.groups[0].count, 3, '3 条消息全部计入')
eq(pane.panel.hints.some((h) => /15-25K/.test(h.text)), true, '薪资短文本被当成岗位线索捞出来')
eq(pane.panel.msgNodes, 3, 'msgNodes 报消息节点数（判断对话区有没有内容）')

// ③ 局部聚类不能把左栏算进来 —— 这是「一个页面两组列表」最容易串的地方
const groupsInPanel = C.localRowGroups(dom.panelEl, 4)
eq(
  groupsInPanel.every((g) => g.itemKey.indexOf('message') >= 0),
  true,
  '只在传进来的节点内部找结构，左栏的会话行不会混进来'
)

// ④ 标签栏陷阱：真机 .label-list（全部/未读/新招呼/仅沟通/更多）是左栏的兄弟、16 个字，
// 却是那层最长的那个 —— 只比字数就会把它当对话区，后面结论全歪。
const labelList = mkEl('DIV', 'label-list', '全部 未读 新招呼 仅沟通 更多')
const holder2 = mkEl('DIV', 'chat-content', '')
const outer2 = mkEl('DIV', 'chat-user', '')
const listEl2 = mkEl('DIV', 'user-list', '11月03日 秦女士KeepHR [送达] 您好…')
holder2.children.push(listEl2)
listEl2.parentElement = holder2
holder2.parentElement = outer2
outer2.children.push(holder2, labelList)
labelList.parentElement = outer2
ctx.document.querySelector = (sel) => (sel === '.user-list' ? listEl2 : null)
const labelPane = C.probeChatPanel()
eq(labelPane.panel, null, '16 字的标签栏不会被当成对话区（只比字数是错的）')
eq(C.looksLikeChatPanel(labelList, 16), false, 'looksLikeChatPanel：没消息节点 + 字数少 → false')
eq(C.looksLikeChatPanel(dom.panelEl, 200), true, '字数够多 → true（新建会话可能没有消息节点）')

// ⑤ 真机结构（2026-11-05 第三次探测）：
//   .chat-wrap > [ .list-warp > .chat-user > .chat-content > .user-list , .chat-conversation ]
// 对话区在**往上三层**的祖先兄弟上 —— 只看「直接父级的兄弟」永远找不到。
const deepList = mkEl('DIV', 'user-list', '11月03日 秦女士KeepHR [送达] 您好…')
const deepContent = mkEl('DIV', 'chat-content', '', [deepList])
const deepUser = mkEl('DIV', 'chat-user', '', [deepContent])
const deepWarp = mkEl('DIV', 'list-warp', '', [deepUser])
const conv = mkEl(
  'DIV',
  'chat-conversation',
  '沟通职位 软件测试工程师 20-30K·13薪 已查看你的简历 你好，方便聊一下吗 方便发一份简历吗 好的稍后发您 我们这边做智能硬件，测试团队六个人'
)
const chatWrap = mkEl('DIV', 'chat-wrap', '', [deepWarp, conv])
ctx.document.querySelector = (sel) => (sel === '.user-list' ? deepList : null)
ctx.document.querySelectorAll = () => []
const deepPane = C.probeChatPanel()
eq(deepPane.panel !== null, true, '对话区挂在更高层祖先的兄弟上时也能找到（真机就是这结构）')
eq(/chat-conversation/.test(deepPane.panel.el), true, 'panel.el 指到 .chat-conversation')

// ⑥ 已知 class 优先：结构推不出来时，靠 .chat-conversation 选择器兜底
ctx.document.querySelector = (sel) =>
  sel === '.user-list' ? deepList : sel === '.chat-conversation' ? conv : null
const byClass = C.probeChatPanel()
eq(/chat-conversation/.test(byClass.panel.el), true, '已知 class 优先命中，不依赖结构推断')
eq(byClass.panel.empty, false, '对话区有内容时 empty:false（别把正常会话标成空）')

// ⑧ 空状态占位：没选中会话时，对话区只有一句「与您进行过沟通的 Boss 都会在左侧列表中显示」。
// 这是「定位到了但没数据」，必须和「真的有消息」分开报，否则探测看着成功其实什么都没拿到。
const emptyConv = mkEl('DIV', 'chat-conversation', '与您进行过沟通的 Boss 都会在左侧列表中显示')
mkEl('DIV', 'chat-wrap', '', [deepWarp, emptyConv])
ctx.document.querySelector = (sel) =>
  sel === '.user-list' ? deepList : sel === '.chat-conversation' ? emptyConv : null
const emptyPane = C.probeChatPanel()
eq(emptyPane.panel !== null, true, '空状态时容器照样定位得到')
eq(emptyPane.panel.empty, true, '空状态占位被标成 empty:true')
eq(emptyPane.panel.msgNodes, 0, '空状态 0 条消息')
eq(emptyPane.panel.hints.length, 0, '空状态捞不到岗位线索（这才是「需要点开会话」的证据）')

// ⑨ 岗位卡 + 消息行：结构取自 2026-11-05 真机（赵怡和智传信那条会话）
//    panel.lines = ["赵怡","和智传信","招聘者","更多","社媒运营实习生（多平台 / 发布与维护）","120-150元/天","深圳","查看职位"]
//    panel.groups 里消息行 = UL.im-list > LI.message-item（3 条）
console.log('\n— 岗位卡 + 消息行（点开会话后能拿到什么）—')

const posLeft = mkEl('DIV', 'left-content', '社媒运营实习生（多平台 / 发布与维护）\n120-150元/天\n深圳')
const posRight = mkEl('DIV', 'right-content', '查看职位')
const posEl = mkEl(
  'DIV',
  'chat-position-content',
  '社媒运营实习生（多平台 / 发布与维护）\n120-150元/天\n深圳\n查看职位',
  [posLeft, posRight]
)
posEl.querySelector = () => null // 「查看职位」不是 <a> —— 真机 jobLinks 也是 0

const statusIcon = mkEl('I', 'message-status status-delivery', '[送达]')
const selfRow = mkEl('LI', 'message-item', '[送达] 您好，我是计算机应用工程大四在读…')
selfRow.querySelector = (sel) => (String(sel).indexOf('status') >= 0 ? statusIcon : null)
const otherRow = mkEl('LI', 'message-item', '16:12 Hello，你好啊，看到你的简历，觉得蛮合适的~')
otherRow.querySelector = () => null
const otherRow2 = mkEl('LI', 'message-item', '16:20 方便发一份简历吗')
otherRow2.querySelector = () => null
const imList = mkEl('UL', 'im-list', '', [selfRow, otherRow, otherRow2])

const convPanel = mkEl('DIV', 'chat-conversation', '赵怡 和智传信 招聘者 社媒运营实习生 120-150元/天 深圳 查看职位')
convPanel.querySelector = (sel) => {
  if (sel === '.chat-position-content') return posEl
  if (sel === '.im-list') return imList
  return null
}

const card = C.probePositionCard(convPanel)
eq(card !== null, true, '认出岗位卡（.chat-position-content）')
eq(card.lines[0], '社媒运营实习生（多平台 / 发布与维护）', '第 1 段是岗位名 —— 方向筛选就靠它')
eq(card.lines[1], '120-150元/天', '第 2 段是薪资')
eq(card.lines[2], '深圳', '第 3 段是城市')
eq(card.kids.length, 2, '岗位卡拆成 left-content / right-content 两块')
eq(card.link, null, '「查看职位」不是 <a> 时 link:null —— 说明拿不到 jobId，只能靠岗位名匹配')

const msgs = C.probeMessageRows(convPanel)
eq(msgs.count, 3, '消息列表报**全部**行数（不是只取前 10 条）')
eq(msgs.rows[0].hasStatus, true, '带 [送达] 图标 → 我方发的')
eq(msgs.rows[0].statusText, '[送达]', '状态文案原样带出来')
eq(msgs.rows[1].hasStatus, false, '没有状态图标 → 对方发的')
eq(/方便发一份简历/.test(msgs.rows[2].text), true, '消息正文拿得到（判断「最后一句是谁说的」靠它）')

// ⑦ 导航栏的假岗位链接必须滤掉：真机上 a[href*=job] 命中「职位 / 海归 / 无障碍专区」
// 4 条导航，报成「岗位链接 4 条」会把人往错的方向带。
const navA = mkEl('A', '', '职位')
navA.getAttribute = (k) => (k === 'href' ? '/web/geek/jobs' : '')
const navLi = mkEl('LI', '', '', [navA])
const navUl = mkEl('UL', '', '', [navLi])
const navDiv = mkEl('DIV', 'nav', '', [navUl])
ctx.document.querySelectorAll = (sel) => (String(sel).indexOf('a[href') === 0 ? [navA] : [])
ctx.document.querySelector = (sel) => (sel === '.user-list' ? deepList : null)
const navPane = C.probeChatPanel()
eq(navPane.jobLinks, 0, '导航类假链接不算岗位链接')
eq(navPane.navSkipped, 1, '被滤掉的数量单独报出来，别让它凭空消失')
eq(navPane.jobLinkList.length, 0, 'jobLinkList 里不出现导航链接')

// ——————————————————————————————————————————————
// 会话逐条采集（v0.7.12）
// 这块最容易出的错不是「读不到」，而是**读错对象**：
//   ① 按位置数第几段取薪资 → 岗位只写「面议」时整体错位，城市被当成薪资；
//   ② 点了会话但右栏还没换 → 把上一条的岗位名记到这一条头上（和实习僧切 tab 同一个坑）；
//   ③ 把系统消息「发送了面试结果」当成对方回复 → repliedAt 全脏、面试层虚高。
// 三条各钉一个用例，全是真机样本的变体。
// ——————————————————————————————————————————————————————————————
// 公司名取值：BOSS 一键投递跑在「左侧列表 + 右侧详情」页面上
//
// 2026-11-05 真机事故：`extractJobInfo` 用 document.querySelector 做全页通配，
// 文档序第一个 `[class*="company-name"]` 落在**左侧列表别的卡片**上 →
// 账本记下别人的公司。10 条 BOSS 记录错了 4 条，岗位名却全对，
// 所以界面上完全看不出问题。铁证是同一个内部编号 A69277 挂在两家公司名下。
//
// 用例直接复刻那个页面结构：左栏 3 张卡（各有公司名）在前，右侧详情区在后。
// ——————————————————————————————————————————————————————————————
console.log('\n— 公司名取值（只在岗位名所在容器里找，绝不取全页第一个）—')

{
  // 迷你 DOM：只实现这套逻辑真正用到的 querySelector / querySelectorAll
  //
  // ⚠️ 这里必须**真按选择器匹配**，不能自己维护一份「什么算公司节点」的白名单。
  // 第一版就是白名单：把 /gongsi/ 判断写进了白名单，于是把 COMPANY_SEL 里的
  // gongsi 候选删掉，测试照样全绿（变异测试白做）。选择器的正确性必须由选择器自己承担。
  const attrVal = (n, name) => {
    if (name === 'class') return String(n.className || '')
    if (name === 'href') return String(n.href || (n.getAttribute && n.getAttribute('href')) || '')
    return String((n.getAttribute && n.getAttribute(name)) || n[name] || '')
  }
  const matchOneSel = (n, raw) => {
    let s = String(raw || '').trim()
    if (!s) return true
    // 后代组合器只取最后一段（这套假 DOM 不做层级匹配；用到的三个复合选择器末段都够用）
    s = s.split(/\s+/).pop()
    const tagM = s.match(/^([a-zA-Z][\w-]*)/)
    if (tagM && String(n.tagName || '').toLowerCase() !== tagM[1].toLowerCase()) return false
    let m
    const attrRe = /\[([\w-]+)\*?=\s*["']?([^"'\]]*)["']?\]/g
    while ((m = attrRe.exec(s))) {
      if (!attrVal(n, m[1]).includes(m[2])) return false
    }
    const clsRe = /\.([\w-]+)/g
    while ((m = clsRe.exec(s))) {
      const toks = String(n.className || '').split(/\s+/)
      if (toks.indexOf(m[1]) === -1) return false
    }
    return true
  }
  const matchSel = (n, sel) => String(sel || '*').split(',').some((one) => matchOneSel(n, one))
  const descendants = (n, out = []) => {
    for (const c of n.children || []) {
      out.push(c)
      descendants(c, out)
    }
    return out
  }
  const mk = (tag, cls, text, children = []) => {
    const el = {
      tagName: tag,
      className: cls || '',
      innerText: text || '',
      textContent: text || '',
      children,
      parentElement: null,
    }
    el.querySelectorAll = (sel) => descendants(el).filter((n) => matchSel(n, sel))
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null
    for (const c of children) c.parentElement = el
    return el
  }
  const makeRoot = (children) => {
    const r = mk('DIV', 'root', '', children)
    return r
  }

  // 左栏 3 张卡：每张都有公司名（真机上它们排在前，所以旧实现永远取到「别的公司A」）
  const card = (co, title) =>
    mk('DIV', 'job-card-wrapper', `${title} ${co}`, [
      mk('SPAN', 'job-name', title),
      mk('SPAN', 'company-name', co),
    ])
  const list = mk('DIV', 'job-list', '', [
    card('别的公司A', '数据分析助理'),
    card('别的公司B', '用户运营实习'),
    card('别的公司C', '编导创意实习生'),
  ])

  // 右侧详情：岗位名在 .job-banner 里，公司名在它的兄弟 .company-info 里（同一个 .job-detail-box 下）
  const titleEl = mk('SPAN', 'name', '【日常实习】数据运营实习生(A69277)')
  const banner = mk('DIV', 'job-banner', '【日常实习】数据运营实习生(A69277) 200-250元/天 深圳', [titleEl])
  const info = mk('DIV', 'company-info', '正浩创新 智能硬件 1000-9999人', [
    mk('SPAN', 'company-name', '正浩创新'),
  ])
  const detail = mk('DIV', 'job-detail-box', '', [banner, info])

  const root = makeRoot([list, detail])

  eq(
    C.findCompanyName(titleEl, root),
    '正浩创新',
    '★ 列表在前、详情在后：取详情区那家，不取全页第一个「别的公司A」'
  )
  eq(
    C.namesIn(root).length,
    4,
    '全页有 4 个不同公司名（3 张卡的 + 详情区那家）→ 全页唯一候选那条兜底不成立'
  )

  // 岗位名往上 4 层都是「多家公司」的范围 → 必须留空，而不是随手挑一个
  const orphanTitle = mk('SPAN', 'name', '测试实习生')
  const orphanBox = mk('DIV', 'job-banner', '测试实习生 深圳', [orphanTitle])
  const root2 = makeRoot([list, orphanBox])
  eq(
    C.findCompanyName(orphanTitle, root2),
    '',
    '★ 找不到「只含一家公司」的容器时返回空 —— 宁可「未知公司」也不要一个错的'
  )

  // 真正的单岗位详情页（全页只有一家公司）→ 唯一候选兜底可以用
  const soloTitle = mk('SPAN', 'name', '软件测试工程师')
  const soloBanner = mk('DIV', 'job-banner', '软件测试工程师 15-20K 深圳', [soloTitle])
  const soloCo = mk('DIV', 'company-info', '桥介数物', [mk('SPAN', 'company-name', '桥介数物')])
  const soloRoot = makeRoot([soloBanner, soloCo])
  eq(C.findCompanyName(soloTitle, soloRoot), '桥介数物', '单岗位详情页：全页唯一候选，可以用')

  // 候选过滤：区块标题不算公司名
  eq(C.looksLikeCompany('公司信息'), false, '「公司信息」是区块标题，不是公司名')
  eq(C.looksLikeCompany('正浩创新'), true, '正常公司名通过')
  eq(C.looksLikeCompany('12345'), false, '纯数字不是公司名')
  eq(
    C.looksLikeCompany('深圳 智能硬件 1000-9999人 已融资 查看全部'),
    false,
    '被拼成一整段的整块文本不算公司名（长度超 30）'
  )

  // 直接测清洗函数：链接里常是「公司名 \n 规模 \n 融资」，取整串会被 looksLikeCompany 枪毙
  const gEl = {
    innerText: '深圳市云启智造科技有限公司\n100-499人\n已融资',
    textContent: '',
    getAttribute: () => null,
  }
  eq(
    C.companyTextOf(gEl),
    '深圳市云启智造科技有限公司',
    '多行链接文本：只取第一行公司名，不把「100-499人 / 已融资」带进账本'
  )
  eq(
    C.looksLikeCompany(
      C.companyTextOf({
        innerText: '深圳市云启智造科技有限公司 100-499人',
        textContent: '',
        getAttribute: () => null,
      })
    ),
    false,
    '单行挤在一起时不许硬猜，交给 looksLikeCompany 否决（上层留空 → 未知公司）'
  )

  // ★ 2026-11-09 真机：BOSS 新版详情页**全程没有 company-name 这类 class**，
  // 公司名只在公司页链接里，链接文本还是「公司名 \n 规模 \n 融资」这种多行。
  // 旧实现四个候选全是 class 名 → 候选 0 个 → 「0 ≠ 1」→ 返回空 → 46/61 条记成未知公司。
  const gco = mk('A', 'company-link', '深圳市云启智造科技有限公司\n100-499人\n已融资', [])
  gco.href = '/gongsi/8f1c2d3e4a.html'
  const gTitle = mk('H1', '', '测试实习生')
  const gbanner = mk('DIV', 'job-banner', '测试实习生 150-200元/天 深圳', [gTitle])
  const ginfo = mk('DIV', 'company-info', '深圳市云启智造科技有限公司 100-499人', [gco])
  const groot = makeRoot([gbanner, ginfo])
  eq(
    C.findCompanyName(gTitle, groot),
    '深圳市云启智造科技有限公司',
    '★ 没有 company-name class，靠 /gongsi/ 链接也能取到，且只取第一行公司名（不能把「100-499人」一起塞进账本）'
  )

  // 反例：全页出现多家公司（列表页 + 推荐位）时仍然必须留空 ——
  // 新加的选择器不能把 2026-11-05 那次「10 条错 4 条公司名」的事故带回来
  const another = mk('A', 'company-link', '别的公司B', [])
  another.href = '/gongsi/abc.html'
  const manyRoot = makeRoot([gbanner, ginfo, mk('DIV', 'recommend', '别的公司B', [another])])
  eq(
    C.findCompanyName(gTitle, manyRoot),
    '',
    '★ 全页多家公司且找不到「只含一家」的容器时仍返回空（宁可未知，不可张冠李戴）'
  )
}

console.log('\n— BOSS 投递记录页：按路由特征取字段（不靠行序赌公司名）—')

{
  // 第三套迷你 DOM：**真按选择器匹配**（tag / .class / [attr*=值]），并实现 getAttribute。
  // 为什么必须真匹配：2026-11-09 那次「假 DOM 白名单」让变异测试整个空转 ——
  // 把采集器里的候选选择器删掉，测试照样全绿。
  const desc3 = (n, out = []) => {
    for (const c of n.children || []) {
      out.push(c)
      desc3(c, out)
    }
    return out
  }
  const matchOne3 = (n, raw) => {
    let s = String(raw || '').trim()
    if (!s) return true
    s = s.split(/\s+/).pop() // 后代组合器只取最后一段
    const tagM = s.match(/^([a-zA-Z][\w-]*)/)
    if (tagM && String(n.tagName || '').toLowerCase() !== tagM[1].toLowerCase()) return false
    let m
    const attrRe = /\[([\w-]+)\*?=\s*["']?([^"'\]]*)["']?\]/g
    while ((m = attrRe.exec(s))) {
      if (!String(n.getAttribute(m[1]) || '').includes(m[2])) return false
    }
    const clsRe = /\.([\w-]+)/g
    while ((m = clsRe.exec(s))) {
      if (String(n.className || '').split(/\s+/).indexOf(m[1]) === -1) return false
    }
    return true
  }
  const match3 = (n, sel) => String(sel || '*').split(',').some((one) => matchOne3(n, one))
  const mk3 = (tag, cls, text, children = []) => {
    const el = {
      tagName: tag,
      className: cls || '',
      href: '',
      attrs: {},
      innerText: text || '',
      textContent: text || '',
      children,
      parentElement: null,
    }
    el.getAttribute = (n) =>
      n === 'href' ? el.href : n === 'class' ? el.className : el.attrs[n] || ''
    el.querySelectorAll = (sel) => desc3(el).filter((n) => match3(n, sel))
    el.querySelector = (sel) => el.querySelectorAll(sel)[0] || null
    for (const c of children) c.parentElement = el
    return el
  }
  const jobA = (title, id) => {
    const a = mk3('A', 'job-name', title)
    a.href = `/job_detail/${id}.html`
    return a
  }
  const coA = (name, id) => {
    const a = mk3('A', 'company-name', name)
    a.href = `/gongsi/${id}.html`
    return a
  }

  // 一张 BOSS 投递记录卡：岗位 / 薪资 / 公司 / 城市 / 状态 / 时间
  const lines1 = ['测试实习生', '3-5K', '乔安', '深圳', '已投递', '2026-11-10']
  const row1 = mk3('DIV', 'job-card', lines1.join('\n'), [
    jobA('测试实习生', '9b6af1f00b1a41a2'),
    mk3('SPAN', 'salary', '3-5K'),
    coA('乔安\n100-499人\n已融资', '8f1c2d3e'),
    mk3('SPAN', 'city', '深圳'),
    mk3('SPAN', 'state', '已投递'),
    mk3('SPAN', 'time', '2026-11-10'),
  ])
  eq(
    pick(C.parseRowDom(row1, lines1)),
    {
      company: '乔安',
      city: '深圳',
      jobTitle: '测试实习生',
      appliedAt: new Date(2026, 10, 10).toISOString(),
      stage: 'submitted',
    },
    '★ 公司名从 /gongsi/ 链接取，不从「第 2 行」猜'
  )

  // 岗位名不在链接文字里（链接只有「查看职位」）→ 退回行序取第一个不像噪声的行
  const btnOnly = mk3('A', 'btn', '查看职位')
  btnOnly.href = '/job_detail/e8c0dd36d4bc2ae1.html'
  const lines2 = ['产品测试实习生', '乔安', '已投递']
  const row2 = mk3('DIV', 'job-card', lines2.join('\n'), [
    btnOnly,
    coA('乔安', '8f1c2d3e'),
    mk3('SPAN', 'state', '已投递'),
  ])
  eq(
    pick(C.parseRowDom(row2, lines2)),
    {
      company: '乔安',
      city: '',
      jobTitle: '产品测试实习生',
      appliedAt: '',
      stage: 'submitted',
    },
    '岗位链接只有按钮文案时，岗位名从行文本取（不能记成「查看职位」）'
  )

  // 行内出现两家公司 → 容器锁大了，必须放弃公司名（宁可未知，不可张冠李戴）
  const row3 = mk3('DIV', 'job-card', '测试实习生 乔安 别的公司B 已投递', [
    jobA('测试实习生', 'aaa'),
    coA('乔安', 'c1'),
    coA('别的公司B', 'c2'),
    mk3('SPAN', 'state', '已投递'),
  ])
  eq(
    C.parseRowDom(row3, ['测试实习生', '乔安', '别的公司B', '已投递']),
    null,
    '★ 同一行两家公司 → 返回 null（交给上行留「未知公司」，不猜）'
  )

  // 岗位名带薪资 → 剥掉再入库（账本里出现过「测试实习生 3-5K」这种脏值）
  eq(C.stripSalary('测试实习生 3-5K'), '测试实习生', '剥「3-5K」')
  eq(C.stripSalary('软件测试工程师（双休自研 偏测开） 15-30K·14薪'), '软件测试工程师（双休自研 偏测开）', '剥「15-30K·14薪」')
  eq(C.stripSalary('运营实习生 200-210元/天'), '运营实习生', '剥「200-210元/天」')
  eq(C.stripSalary('A98648质量运营专员-深圳 面议'), 'A98648质量运营专员-深圳', '剥「面议」，但保留岗位名里的城市后缀')

  // 行容器边界：两张卡各有一家公司，靠公司链接定位时不能锁成一整片
  const jobB = jobA('内容运营实习生', 'bbb')
  const coB = coA('别的公司B', 'c2')
  const rowB = mk3('DIV', 'job-card', '内容运营实习生 别的公司B 已投递', [
    jobB,
    coB,
    mk3('SPAN', 'state', '已投递'),
  ])
  const list = mk3('DIV', 'job-list', '', [row1, rowB])
  const coInRow1 = row1.querySelectorAll('a[href*="/gongsi/"]')[0]
  eq(
    C.rowOfCompanyLink(coInRow1) === row1,
    true,
    '★ 公司链接向上找行：停在「只含一家公司」的卡片上，不锁到整个列表'
  )
  eq(C.uniqueCompanyHrefs(list), 2, '列表层有 2 家公司 → 边界判据就是它')
}

console.log('\n— 岗位名元素定位（BOSS 新版没有 .job-banner .name 时不能直接摆烂）—')

{
  // 第二个迷你 DOM：这次真的按选择器匹配（只实现 tag / .class 两种形式）
  const matchOne = (el, sel) => {
    const s = String(sel || '').trim()
    if (!s) return false
    // 复合选择器只取最后一段：`[class*="job-banner"] h1` → h1
    const last = s.split(/\s+/).pop()
    if (last.startsWith('.')) return String(el.className || '').includes(last.slice(1))
    if (last.startsWith('[')) return false // 属性选择器这套假 DOM 不实现
    return String(el.tagName || '').toLowerCase() === last.toLowerCase()
  }
  const matches = (el, sel) => String(sel).split(',').some((one) => matchOne(el, one))
  const desc = (n, out = []) => {
    for (const c of n.children || []) {
      out.push(c)
      desc(c, out)
    }
    return out
  }
  const mk2 = (tag, cls, text, children = []) => {
    const el = {
      tagName: tag,
      className: cls || '',
      id: '',
      innerText: text || '',
      textContent: text || '',
      offsetHeight: 20,
      offsetWidth: 100,
      children,
      parentElement: null,
    }
    el.querySelectorAll = (sel) => desc(el).filter((n) => matches(n, sel))
    for (const c of children) c.parentElement = el
    return el
  }

  // 回归 2026-11-09 真机：账本里出现「测试实习生 3-5K」这种岗位名，
  // 说明 jobEl 全落空、退回 document.title（真实节点不会把薪资和岗位名挤一行）
  const h1 = mk2('H1', '', '自动化测试工程师助理')
  const banner = mk2('DIV', 'job-banner-inner', '自动化测试工程师助理 7-9K 深圳', [h1])
  const page = mk2('DIV', 'page', '', [banner])
  eq(
    C.findJobTitleEl(page) === h1,
    true,
    '★ banner 里只有 h1、没有 .job-banner .name 时也要认得出来（否则岗位名退回 document.title，把薪资一起带进账本）'
  )
  eq(C.findJobTitleEl(page).innerText, '自动化测试工程师助理', '取到的是纯岗位名，不含薪资')
  eq(C.findJobTitleEl(mk2('DIV', 'page', '空页', [])), null, '真空页返回 null，交给上层回退')
}

console.log('\n— 会话逐条采集（点开 → 读岗位卡 → 判谁说的）—')

const mkMsg = (cls, text, hasStatus) => {
  const row = mkEl('LI', cls, text)
  row.querySelector = (sel) =>
    hasStatus && String(sel).indexOf('status') >= 0
      ? mkEl('I', 'message-status status-read', '[已读]')
      : null
  return row
}

const mkPanel = (opts) => {
  const card = mkEl('DIV', 'chat-position-content', opts.card || '')
  if (opts.salaryText) {
    card.querySelector = (sel) =>
      sel === '.salary' ? mkEl('SPAN', 'salary', opts.salaryText) : null
  }
  const im = mkEl('UL', 'im-list', '', opts.msgRows || [])
  const base = mkEl('DIV', 'base-info', opts.baseText || '')
  base.querySelector = (sel) => (sel === '.base-title' ? opts.titleEl || null : null)
  base.querySelectorAll = () => opts.spans || []
  const panel = mkEl('DIV', 'chat-conversation', '')
  panel.querySelector = (sel) => {
    if (sel === '.chat-position-content') return card
    if (sel === '.im-list') return im
    if (sel === '.base-info') return base
    return null
  }
  return panel
}

// ① 真机样本：赵怡和智传信 / 社媒运营实习生 / 120-150元/天 / 深圳
{
  const panel = mkPanel({
    card: '社媒运营实习生（多平台 / 发布与维护）\n120-150元/天\n深圳\n查看职位',
    msgRows: [mkMsg('message-item', '16:12 Hello，你好啊，看到你的简历', false)],
    baseText: '赵怡 和智传信 招聘者',
    spans: [mkEl('SPAN', '', '赵怡'), mkEl('SPAN', '', '和智传信'), mkEl('SPAN', 'base-title', '招聘者')],
    titleEl: mkEl('SPAN', 'base-title', '招聘者'),
  })
  const chat = C.readOpenChat(panel)
  eq(chat.jobTitle, '社媒运营实习生（多平台 / 发布与维护）', '岗位名 = 岗位卡第 1 段')
  eq(chat.salary, '120-150元/天', '薪资取到了')
  eq(chat.city, '深圳', '城市取到了')
  eq(chat.lastFrom, 'other', '最后一条没有状态图标 → 对方说的')
  const who = C.readRecruiter(panel)
  eq(who.name, '赵怡', '招聘者姓名从 .base-info 的 span 分字段读')
  eq(who.company, '和智传信', '公司名分字段读 —— 不靠拆文本猜')
  eq(who.guess, false, '分字段读出来的不算「猜」，预览里不该标警告')
}

// ①-b 谁先开口 / 我发过几条 —— 区分「我投的」和「HR 主动找我的」
//     HR 群发的招呼也算「对方最后发言」，但它没进过我的投递漏斗，
//     不区分就会把「投递量」撑大（珍岛那种「五险一金、股票期权…」就是群发）。
{
  const panel = mkPanel({
    card: '用户运营实习\n200-250元/天\n深圳',
    msgRows: [
      mkMsg('message-item', '11-02 16:49 您好，我们是一家互联网企业', false), // HR 先开口
      mkMsg('message-item', '', '11-02 17:02 您好，我是计算机应用工程大四在读', true),
    ],
    baseText: '刘女士珍岛集团集团校园招聘经理',
  })
  const chat = C.readOpenChat(panel)
  eq(chat.firstFrom, 'other', '第一条没有状态图标 → HR 先开口（这多半是群发招呼）')
  eq(chat.myMsgCount, 1, '带状态图标的消息计 1 条（我发过的）')
  eq(chat.lastFrom, 'me', '最后一条带图标 → 我方发的')
}

// ①-c 一句话都没发过 = 纯 HR 主动找我，不是我投的
{
  const panel = mkPanel({
    card: 'AI编剧实习生（海外短剧）\n200-300元/天\n深圳',
    msgRows: [
      mkMsg('message-item', '10-30 你去可以确认下哦', false),
      mkMsg('message-item', '10-30 那个岗位还看吗', false),
    ],
  })
  const chat = C.readOpenChat(panel)
  eq(chat.myMsgCount, 0, '一条带状态图标的都没有 → 我没发过言')
  eq(chat.firstFrom, 'other', '对方先开口')
}

// ①-d 系统消息不参与「谁先开口」—— 否则第一句是「发送了面试结果」就会被当成对方开口
{
  const panel = mkPanel({
    card: '编导创意实习生\n200-250元/天\n深圳',
    msgRows: [
      mkMsg('message-item system-notice', '系统消息', false),
      mkMsg('message-item', '', '10-30 您好，我是计算机应用工程', true),
    ],
  })
  const chat = C.readOpenChat(panel)
  eq(chat.firstFrom, 'me', '跳过系统消息后，第一条是带图标的我方消息')
}

// ② 没写薪资：按位置取会把城市当薪资，所以必须按正则挑
{
  const panel = mkPanel({ card: '软件测试工程师\n深圳\n查看职位' })
  const chat = C.readOpenChat(panel)
  eq(chat.jobTitle, '软件测试工程师', '岗位名')
  eq(chat.salary, '', '没写薪资就留空 —— 不能把「深圳」当薪资')
  eq(chat.city, '深圳', '城市仍然落在城市位上')
}

// ③ .salary 元素比文本更准（「面议」旁边的那个 SPAN 才是真薪资）
{
  const panel = mkPanel({
    card: '测试工程师\n面议\n上海\n查看职位',
    salaryText: '15-20K·13薪',
  })
  const chat = C.readOpenChat(panel)
  eq(chat.salary, '15-20K·13薪', '.salary 元素优先于岗位卡里的文本')
  eq(chat.city, '上海', '薪资换来源也不影响城市')
}

// ④ 系统消息不是「对方回复」—— 否则 repliedAt 全脏
{
  const panel = mkPanel({
    card: '测试工程师\n10-15K\n深圳\n查看职位',
    msgRows: [mkMsg('message-item system-notice', '发送了面试结果', false)],
  })
  eq(C.readOpenChat(panel).lastFrom, 'system', '「发送了面试结果」是系统消息，既不是我方也不是对方')
}

// ⑤ 我方消息靠状态图标认，不靠 class 后缀（真机两侧 class 一样）
{
  const panel = mkPanel({
    card: '测试工程师\n10-15K\n深圳\n查看职位',
    msgRows: [mkMsg('message-item', '对方说：你好', false), mkMsg('message-item', '我回的：方便发简历', true)],
  })
  eq(C.readOpenChat(panel).lastFrom, 'me', '最后一条带 [已读] → 我方发的，不算对方回复')
}

// ⑥ 公司名拆文本：只在分字段失败时才用，规则必须窄
{
  const a = C.splitNameCompany('刘女士珍岛集团集团校园招聘经理')
  eq(a.name, '刘女士', '「X女士」这种确定是姓名的前缀可以剥')
  eq(a.company, '珍岛集团', '角色词连剥两层（集团校园招聘经理 → 集团）')
  const b = C.splitNameCompany('周先生AnkerHR')
  eq(b.company, 'Anker', 'HR 后缀也要剥掉')
  const c = C.splitNameCompany('刘静腾讯音乐招聘专家')
  eq(c.name, '', '没有「先生/女士」就不猜姓名 —— 2 字名和 3 字名互相矛盾，猜必错一半')
  eq(c.guess, true, '拆文本的结果必须标成「猜的」，预览里要能看见')
}

// ⑦ 只点「已读 / 对方最后发言」的，不碰「我发了对方还没看」的
{
  let activeRow = -1
  const clicked = []
  const mkRow = (idx, iconCls) => {
    const icon = iconCls ? mkEl('I', iconCls, '[x]') : null
    const content = mkEl('DIV', 'friend-content', `公司${idx}\n招聘者${idx}`)
    content.querySelector = (sel) => (icon && String(sel).indexOf('status') >= 0 ? icon : null)
    content.click = () => {
      clicked.push(idx)
      activeRow = idx
    }
    const li = mkEl('LI', '', '', [content])
    li.click = content.click
    return content
  }
  const rows = [
    mkRow(0, 'message-status status-read'), // 已读 → 要采
    mkRow(1, 'message-status status-delivery'), // 我发了对方没看 → 不点
    mkRow(2, null), // 对方最后发言 → 要采
  ]
  const panelAt = (idx) =>
    mkPanel({
      card: `岗位${idx}\n10-15K\n深圳\n查看职位`,
      baseText: `公司${idx} 招聘者${idx}`,
      spans: [mkEl('SPAN', '', `招聘者${idx}`), mkEl('SPAN', '', `公司${idx}`)],
      msgRows: [mkMsg('message-item', `你好${idx}`, false)],
    })
  ctx.document.querySelectorAll = (sel) => (sel === '.friend-content' ? rows : [])
  ctx.document.querySelector = (sel) =>
    sel === '.chat-conversation' ? (activeRow < 0 ? mkPanel({}) : panelAt(activeRow)) : null

  const r = await C.collectChatDetails({ scope: 'interactive', stepMs: 300, waitMs: 200 })
  eq(clicked, [0, 2], '只点了已读和对方最后发言的那两行，「送达未读」一次都没点')
  eq(r.items.length, 2, '采到 2 条（送达未读那条不进）')
  eq(r.items[0].company, '公司0', '第 1 条抓到公司名')
  eq(r.items[0].jobTitle, '岗位0', '岗位名来自点开后的岗位卡，不是列表')
  eq(r.items[0].read, true, '已读标记带上了')
  eq(r.items[1].replied, true, '对方最后发言 → replied:true（后端记 repliedAt）')
  eq(r.items[1].read, false, '没读过就报 false，不当成「已读」')
  eq(r.debug.failed.length, 0, '两条都点开了，没有失败')
  eq(r.debug.opened, 2, 'opened 计数 = 2')
}

// ⑧ 点了但右栏没换内容 → 必须跳过，绝不能把上一条的岗位名错标给它
// 面板里放的是**上一条会话**（公司/招聘者都对不上这一行），这才是真实风险场景：
// 点不动时右栏停在上一条，把它的岗位名记给这一行 = 数据静默错位。
{
  const fixed = mkPanel({
    card: '上一条的岗位\n10-15K\n深圳\n查看职位',
    baseText: '上一条公司 上一条招聘者',
    spans: [mkEl('SPAN', '', '上一条招聘者'), mkEl('SPAN', '', '上一条公司')],
    msgRows: [mkMsg('message-item', '你好', false)],
  })
  const content = mkEl('DIV', 'friend-content', '不动的公司\n不动的招聘者')
  content.querySelector = () => null
  content.click = () => {} // 点了没反应
  ctx.document.querySelectorAll = (sel) => (sel === '.friend-content' ? [content] : [])
  ctx.document.querySelector = (sel) => (sel === '.chat-conversation' ? fixed : null)

  const r = await C.collectChatDetails({ scope: 'all', waitMs: 200 })
  eq(r.items.length, 0, '点了没换内容 → 一条都不入（错标阶段比漏采严重）')
  eq(r.debug.failed.length, 1, '记进 failed，预览里会列出来')
  eq(r.debug.reused || 0, 0, '右栏是上一条会话（人对不上），不许当成「本来就开着」')
}

// ⑨ 本来就开着的那条不能被当成「点了没反应」
// 真实场景：刚跟某个 HR 聊完就点采集，第一条八成就是开着的 ——
// 点它内容不会变，指纹不变，会被稳定误判成失败，白白丢掉最新那条。
{
  const openPanel = mkPanel({
    card: '开着的岗位\n10-15K\n深圳\n查看职位',
    baseText: '开着的公司 招聘者',
    spans: [mkEl('SPAN', '', '招聘者'), mkEl('SPAN', '', '开着的公司')],
    msgRows: [mkMsg('message-item', '你好', false)],
  })
  const content = mkEl('DIV', 'friend-content active', '开着的公司\n招聘者')
  content.querySelector = () => null
  content.click = () => {
    throw new Error('已经开着的会话不该再点')
  }
  ctx.document.querySelectorAll = (sel) => (sel === '.friend-content' ? [content] : [])
  ctx.document.querySelector = (sel) => (sel === '.chat-conversation' ? openPanel : null)

  const r = await C.collectChatDetails({ scope: 'interactive', waitMs: 200 })
  eq(r.items.length, 1, '当前开着的会话直接读，不需要点')
  eq(r.debug.reused, 1, 'reused 计数 = 1（和「点开成功」分开统计）')
  eq(r.debug.failed.length, 0, '不能判成「点开没反应」')
  eq(r.items[0].jobTitle, '开着的岗位', '岗位名照样读得到')
}

// ⑪ 左栏节点被重渲染换掉（游离节点）→ 按文本指纹重新找到再点
// 真机 2026-11-05（扩展 0.8.1，赵怡和/智传信那条）：点开一条会话会清未读红点 →
// BOSS 把整列重画，循环开头一次性抓下来的其它行 node 全变成游离节点。
// 对游离节点 click() **不报错也不跳转** → 症状是「点了没反应」，只丢中间那一条。
{
  let activeRow = -1
  const clickedOn = []
  const stale = mkEl('DIV', 'friend-content', '智传信\n赵怡和招聘者')
  stale.isConnected = false // 已经不在文档里
  stale.querySelector = () => null
  stale.click = () => clickedOn.push('stale') // 点了什么都不会发生
  const live = mkEl('DIV', 'friend-content', '智传信\n赵怡和招聘者')
  live.querySelector = () => null
  live.click = () => {
    clickedOn.push('live')
    activeRow = 0
  }
  const prev = mkPanel({
    card: '上一条的岗位\n10-15K\n深圳\n查看职位',
    baseText: '上一条公司 上一条招聘者',
    spans: [mkEl('SPAN', '', '上一条招聘者'), mkEl('SPAN', '', '上一条公司')],
    msgRows: [mkMsg('message-item', '你好', false)],
  })
  const target = mkPanel({
    card: '社媒运营实习生\n120-150元/天\n深圳\n查看职位',
    baseText: '智传信 赵怡和招聘者',
    spans: [mkEl('SPAN', '', '赵怡和'), mkEl('SPAN', '', '智传信')],
    msgRows: [mkMsg('message-item', '你好', false)],
  })
  let listCalls = 0
  ctx.document.querySelectorAll = (sel) => {
    if (sel !== '.friend-content') return []
    listCalls += 1
    return listCalls === 1 ? [stale] : [live] // 首轮读列表 → 之后都是重画后的新节点
  }
  ctx.document.querySelector = (sel) =>
    sel === '.chat-conversation' ? (activeRow < 0 ? prev : target) : null

  const r = await C.collectChatDetails({ scope: 'interactive', waitMs: 200, stepMs: 300 })
  eq(clickedOn, ['live'], '只能点重定位到的新节点，不能点游离节点')
  eq(r.debug.relocated, 1, '记下重定位次数（预览里要能看见）')
  eq(r.items.length, 1, '重定位后照常采到，不再当「点开没反应」丢掉')
  eq(r.items[0].company, '智传信', '公司名来自点开后的面板')
  eq(r.items[0].jobTitle, '社媒运营实习生', '岗位名正确')
  eq(r.debug.failed.length, 0, '不能判失败')
}

// ⑫ 本来就开着、但 active 类名认不出来 → 用「招聘者+公司都对得上」兜底读，不跳过
// 这是 ⑧ 的镜像：⑧ 防「把上一条记给它」，⑫ 防「明明就是它却丢掉」。差别只在右栏人对不对得上。
{
  const openPanel = mkPanel({
    card: '社媒运营实习生\n120-150元/天\n深圳\n查看职位',
    baseText: '智传信 赵怡和招聘者',
    spans: [mkEl('SPAN', '', '赵怡和'), mkEl('SPAN', '', '智传信')],
    msgRows: [mkMsg('message-item', '你好', false)],
  })
  const content = mkEl('DIV', 'friend-content', '智传信\n赵怡和招聘者') // 没有 active
  content.querySelector = () => null
  content.click = () => {} // 点了不换内容（本来就开着）
  ctx.document.querySelectorAll = (sel) => (sel === '.friend-content' ? [content] : [])
  ctx.document.querySelector = (sel) => (sel === '.chat-conversation' ? openPanel : null)

  const r = await C.collectChatDetails({ scope: 'interactive', waitMs: 200 })
  eq(r.items.length, 1, '右栏就是这个人的会话 → 直接读，不能丢')
  eq(r.debug.reused, 1, 'reused 计数 = 1')
  eq(r.debug.failed.length, 0, '有明确证据时不算「点开没反应」')
}

// ⑩ 届别标签不能当岗位名（2026-11-03 华曦达 3 条：标题全是「27届」）// 真实形态：岗位名元素的 innerText 是「27届\n测试实习生」—— 届别在第一行。
// 这判定错了两层：方向判不出来（3 条留空）+ 界面上像三条重复记录。
{
  eq(C.firstTitleLine('27届\n测试实习生'), '测试实习生', 'skip 第一行的届别标签，取真正的岗位名')
  eq(C.firstTitleLine('27届校园招聘-测试实习生'), '27届校园招聘-测试实习生', '真标题里含届别的不受影响')
  eq(C.firstTitleLine('测试实习生'), '测试实习生', '单行没标签就原样返回')
  eq(C.firstTitleLine('27届'), '27届', '整块只有标签 → 退回原文（有总比没有强，调用方会标可疑）')
  eq(C.isPureTagLine('2027届'), true, '2027届 也是标签')
  eq(C.isPureTagLine('27届 春招'), true, '带批次的也算')
  eq(C.isPureTagLine('测试实习生'), false, '岗位名不是标签')

  // 列表卡里岗位名压根没渲染时 → 宁可漏这一条，也不上报「27届 / 华曦达」
  const r = C.parseRowLines(['27届', 'SDMC华曦达科技', '深圳'], { tabStage: 'submitted' })
  eq(r, null, '首行是届别标签且没有别的标题行 → 整条丢弃，不硬记')
  const r2 = C.parseRowLines(['27届', '测试实习生', 'SDMC华曦达科技', '深圳'], { tabStage: 'submitted' })
  eq(r2, null, '即使后面有真标题也不猜位置（猜错就是张冠李戴）')
}

// ⑪ 「我放弃」≠「被拒」（2026-10-30 惊叹科技：我发「不太适合我，祝您早日找到」）
// 混进 rejected 会把被拒率算高；而它恰恰是「我主动筛掉」的唯一数据，值得单记。
{
  const me = '不好意思，我觉得该职位不太适合我，祝您早日找到满意的工作人选'
  eq(C.looksWithdrawn('me', me), true, '我最后说不合适 → 我放弃')
  eq(C.looksWithdrawn('me', '你好，请问这个岗位还招人吗？'), false, '我问问题不是放弃')
  eq(C.looksWithdrawn('me', '我的经历是不是不合适？'), false, '问句里含「不合适」也不算（那是提问）')
  eq(C.looksWithdrawn('other', '抱歉，你不太合适'), false, 'HR 说我不合适 = 被拒，不是我自己放弃')
  eq(C.looksWithdrawn('me', ''), false, '空文本不判')
  eq(C.looksWithdrawn('me', '好的，我明天过来面试'), false, '正常约面不判成放弃')
}

// ⑫ 对方明确拒了 → 才推进「不合格」
//
// 为什么单独测：BOSS **不会改平台状态**，HR 拒绝只发一句「不太匹配」，
// 列表页 tab 一直停在「已投递」。不读聊天内容，账本就永远显示已投递。
// 但这是**不可逆结论**（判成 rejected，漏斗里就少一条进行中），
// 所以问句 / 否定式 / 客套话 / 正在谈的，一律不许命中。
{
  const V = (arr) => C.chatVerdictOf(arr).verdict
  eq(V(['您好，经过评估您与该岗位不太匹配，祝您早日找到合适的工作']), 'rejected', '★ 婉拒话术 → 不合格')
  eq(V(['抱歉，该岗位已招满，感谢您的关注']), 'rejected', '已招满 → 不合格')
  eq(V(['您的简历未通过初筛']), 'rejected', '未通过初筛 → 不合格')
  eq(V(['我们这边暂时不需要实习生，谢谢']), 'rejected', '暂时不需要 → 不合格')

  eq(V(['您的简历已收到，我们会尽快与您联系']), '', '★ 已收到简历 ＝ 客套，不是拒绝')
  eq(V(['方便的话我们约个面试时间？']), '', '约面试不是拒绝')
  eq(V(['是哪里不合适吗？']), '', '★ 问句不是结论（「不合适」出现在问句里也不判）')
  eq(V(['不是不合适，是岗位编制调整了']), '', '★ 否定式不判（「不是不合适」）')
  eq(V(['薪资方面不太合适的话我们再谈']), '', '★ 正在谈的不判 —— 同一句里既有「不合适」又有「再谈」')
  eq(V([]), '', '没有对方消息 → 判不出来')
  eq(V(['']), '', '空串不判')

  // 关键：拒绝在**前一条**，后面我又回了句客套 —— 只看最后一条会漏掉
  eq(
    V(['您好，您和岗位不太匹配', '好的，谢谢您']),
    'rejected',
    '★ 拒绝在前、客套在后，仍要判出来（所以扫全部对方消息，不只看最后一条）'
  )
  eq(C.chatVerdictOf(['抱歉岗位已招满']).text, '抱歉岗位已招满', '命中时带上原文，界面能核对')
  eq(C.chatVerdictOf(['抱歉岗位已招满']).hit, '已招满', '带上命中词，排查时不用猜')
}

// ⑬ BOSS 聊天推进六档（2026-11-10 主人定的口径）
//
//   已投递 → 已读不回 → 有进一步交流 → 交换微信 / 要简历 → 面试邀请 → 拿到 Offer
//
// 为什么要单测：BOSS 不推进平台状态，90 条投递在库里全停在「已投递」，
// 而其中一部分 HR 已经要了微信。这一层判错不会报错，只会让看板长期显示「没进展」——
// 于是用户干脆不看它了。
{
  const S = (texts, extra = {}) => C.chatStepOf({ texts, ...extra }).step
  eq(S(['方便加个微信聊吗']), 'contact', '★ 要微信 → 交换微信（问句也是明确意图，这里不当噪声）')
  eq(S(['我加你微信，把简历发你']), 'contact', '我发微信 + 发简历：命中更高档')
  eq(S(['能不能先把简历发我一份']), 'contact', '★ HR 主动要简历也算一步')
  eq(S(['周三下午方便来面试吗']), 'interview', '★ 约面试 → 面试邀请')
  eq(S(['面试通过了，稍后给你发 offer']), 'offer', '★ 同一句里既像面试又像 offer → 取最高档')
  eq(S(['我们决定录用你，下周入职']), 'offer', '录用 → 拿到 Offer')
  eq(S(['这个岗位主要做接口自动化和性能压测']), 'replied', '★ 真聊起来了 → 有进一步交流')
  eq(S(['你好，我们对你的简历很感兴趣']), 'submitted', '★ 自动招呼模板不算「聊起来了」')

  // 被拒 / 在谈的话不许当进展证据（同一句在拒绝判定里也是噪声）
  eq(S(['面试不合适，抱歉']), 'submitted', '★ 「面试不合适」不是面试邀请')
  eq(S(['薪资不合适的话我们再谈']), 'submitted', '「再谈」不是在谈进展')
  eq(S(['您好，您和岗位不太匹配']), 'submitted', '拒信不能算「有进一步交流」')

  // 已读不回必须建立在「我方消息真被读了」这个事实上
  eq(S([], { read: true, lastFrom: 'me' }), 'readNoReply', '★ 已读但对方没回 → 已读不回')
  eq(S([], { read: false, lastFrom: 'me' }), 'submitted', '★ 只送达未读 ≠ 已读不回（没人看过）')
  eq(S([], { read: null, lastFrom: 'me' }), 'submitted', '读不出来也不许猜成已读不回')
  eq(S([], { read: true, lastFrom: 'other' }), 'submitted', '对方最后说话了就不叫「不回」')
  eq(S([]), 'submitted', '什么都没发生 → 已投递（最低档，不撒谎）')
}

console.log(`\n${fail === 0 ? '✅' : '❌'} collector 解析用例：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
