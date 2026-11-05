/**
 * filters-data.js 单测：BOSS 卡片的经验 / 学历识别
 *
 * 为什么必须测：
 *   这两条门槛是**靠正则猜**的，猜错了不会报错 —— 它只会安静地把岗位判成「不符合」
 *   然后跳过。表现是「怎么一家都没投」，页面上一点线索都没有。
 *   而反向猜错（该拦没拦）更贵：会真的发消息给 5-10 年经验的社招岗。
 *
 * 用例直接取自 2026-11-03 BOSS 搜索结果页的真实探测数据。
 *
 * 跑：node scripts/test-filters.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'extension', 'shared', 'filters-data.js')

const ctx = { window: {} }
createContext(ctx)
runInContext(readFileSync(SRC, 'utf-8'), ctx)

const F = ctx.window.JH_FILTERS
if (!F) {
  console.error('❌ filters-data.js 没挂上 window.JH_FILTERS')
  process.exit(1)
}

let pass = 0
const fails = []
function eq(actual, expect, name) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expect)
  if (a === e) {
    pass++
  } else {
    fails.push(`${name}\n     期望 ${e}\n     实际 ${a}`)
  }
}

// ——————————————————————————————————————————————
console.log('— BOSS 卡片：经验要求 —')
// 真实卡片文本（数字被 BOSS 字体混淆吃掉了，只剩「-K」，这是平台行为不是解析 bug）
const card = (title, meta, edu, company, addr) => `${title}\n-K\n${meta}\n${edu}\n${company}\n${addr}`

eq(F.detectBossMeta(card('量化交易分析师', '经验不限', '本科', '高塔量化', '深圳·南山区·科技园')).experienceYears, 0, '「经验不限」→ 0')
eq(F.detectBossMeta(card('数据分析', '3-5年', '本科', '大梦龙途', '深圳·南山区')).experienceYears, 5, '「3-5年」→ 5')
eq(F.detectBossMeta(card('经营分析专员', '5-10年', '本科', '启创数智', '深圳·龙岗区')).experienceYears, 10, '「5-10年」→ 10')
eq(F.detectBossMeta(card('数据分析', '1-3年', '本科', 'VDX', '深圳·南山区')).experienceYears, 3, '「1-3年」→ 3')
eq(F.detectBossMeta(card('测试实习', '1年以内', '本科', '某公司', '深圳')).experienceYears, 1, '「1年以内」→ 1')
eq(F.detectBossMeta(card('架构师', '10年以上', '本科', '某公司', '深圳')).experienceYears, 99, '「10年以上」→ 99')

// 关键边界：「经验不限 1-3年」这种写法真实存在（标题行 + 要求行），必须按最宽的算，
// 否则会把「经验不限」的岗位漏掉 —— 漏投比错投更隐蔽。
eq(
  F.detectBossMeta('测试工程师\n经验不限\n1-3年\n本科\n某公司\n深圳').experienceYears,
  0,
  '「经验不限」与「1-3年」同时出现 → 按经验不限（0）'
)
// 实习僧卡片没有任何经验词 → null（不参与判定，不会误杀）
eq(F.detectBossMeta('系统测试实习生\n法雷奥-深圳\n2026-11-02 16:42:21\n投递成功').experienceYears, null, '实习僧卡片 → 经验识别不出（null）')

// ——————————————————————————————————————————————
console.log('— BOSS 卡片：学历要求 —')
eq(F.detectBossMeta(card('测试实习', '经验不限', '本科', '某公司', '深圳')).eduRank, 4, '「本科」→ 4')
eq(F.detectBossMeta(card('测试实习', '经验不限', '大专', '某公司', '深圳')).eduRank, 3, '「大专」→ 3')
eq(F.detectBossMeta(card('算法实习', '经验不限', '硕士', '某公司', '深圳')).eduRank, 5, '「硕士」→ 5')
eq(F.detectBossMeta(card('研究员', '经验不限', '博士', '某公司', '深圳')).eduRank, 6, '「博士」→ 6')
eq(F.detectBossMeta(card('测试实习', '经验不限', '中专/中技', '某公司', '深圳')).eduRank, 1, '「中专/中技」→ 1')

// 「学历不限」是门槛为零的显式声明，不能被卡片上别处的「本科」压过去
eq(F.detectBossMeta('数据标注\n3-5年\n学历不限\n本科优先\n某公司\n深圳').eduRank, 0, '「学历不限」优先于「本科」→ 0')
// 卡片同时出现「本科」「硕士优先」→ 按更严的算（用户是本科，投不了硕士岗）
eq(F.detectBossMeta('算法工程师\n经验不限\n本科\n硕士优先\n某公司\n深圳').eduRank, 5, '「本科」+「硕士优先」→ 取更严的 5')
eq(F.detectBossMeta('系统测试实习生\n法雷奥-深圳\n投递成功').eduRank, null, '实习僧卡片 → 学历识别不出（null）')

// ——————————————————————————————————————————————
console.log('— 默认门槛下的判定（模拟 screenJob 的两条）—')
const D = F.DEFAULT_FILTERS
function verdict(text) {
  const m = F.detectBossMeta(text)
  if (m.experienceYears != null && m.experienceYears > D.maxExperience) return 'block:经验'
  if (m.eduRank != null && m.eduRank > D.maxEduRank) return 'block:学历'
  return 'pass'
}
eq(verdict(card('测试实习', '经验不限', '本科', '某公司', '深圳')), 'pass', '经验不限 + 本科 → 放行')
eq(verdict(card('数据分析', '1-3年', '本科', '某公司', '深圳')), 'block:经验', '1-3年 → 拦（默认只投经验不限）')
eq(verdict(card('量化交易', '3-5年', '本科', '某公司', '深圳')), 'block:经验', '3-5年 → 拦')
eq(verdict(card('算法实习', '经验不限', '硕士', '某公司', '深圳')), 'block:学历', '硕士 → 拦（用户本科）')
eq(verdict('系统测试实习生\n法雷奥-深圳\n投递成功'), 'pass', '实习僧卡片读不到经验/学历 → 放行（不会误杀）')

// ——————————————————————————————————————————————
console.log('— 城市识别（卡片文本直接喂）—')
const gd = F.PROVINCES.find((p) => p.name === '广东').cities
eq(F.detectCity(card('数据分析', '3-5年', '本科', '大梦龙途', '深圳·南山区·科技园'), gd), ['深圳'], '「深圳·南山区」→ 深圳')
eq(F.detectCity(card('数据分析', '3-5年', '本科', '某公司', '北京·朝阳区'), gd), [], '「北京·朝阳区」→ 不在广东列表')

// ——————————————————————————————————————————————
// 城市门槛：**先找岗位城市，再比是不是你要的**
//
// 守的是 2026-11-05 的事故：用户在实习僧上投出了西安的岗位。
// 原因不是城市表缺西安（表里有），而是判定写成「文本里包含深圳就算过」——
// 而页面上永远有「深圳」（站点城市切换器、面包屑、右侧相似岗位、页脚热门城市）。
// 一旦把整页文本喂进去，任何外地岗位都能通过。
// ——————————————————————————————————————————————
console.log('— 城市门槛：岗位在西安就该拦 —')

// 实习僧「我的投递」卡片形态（真实结构：岗位名 / 公司-城市 / 时间 / 状态）
const sxRow = (title, company, city) => `${title}\n${company}-${city}\n2026-11-02 16:42:21\n投递成功`

eq(
  F.checkCity(sxRow('测试实习生', '某公司', '西安'), ['深圳']),
  { blocked: true, city: '西安' },
  '卡片写「西安」→ 拦（这就是用户遇到的）'
)
eq(
  F.checkCity(sxRow('测试实习生', '某公司', '深圳'), ['深圳']),
  { blocked: false, city: '深圳' },
  '卡片写「深圳」→ 放行'
)
eq(
  F.checkCity(sxRow('测试实习生', '某公司', '西安'), ['深圳', '广州']),
  { blocked: true, city: '西安' },
  '只投深圳/广州，岗位在西安 → 拦'
)

// 认不出城市 → 不拦（交给 strictMeta 决定），不能因为读不到就全拦
eq(F.checkCity('测试实习生\n某公司', ['深圳']), { blocked: false, city: '' }, '认不出城市 → 不拦（city 为空）')
// 没设城市门槛 → 永远不拦
eq(F.checkCity('测试实习生\n某公司-西安', []), { blocked: false, city: '' }, '没选城市 → 不判')

// ⚠️ 这条是在钉住「函数的局限」：整页文本里导航的「深圳」在岗位的「西安」前面，
// firstCity 会取到深圳 —— 所以详情页**必须**先用 cityTextNearTitle() 把范围收窄，
// 不能直接喂 document.body.innerText。测试在这里，是为了防止有人「顺手简化」回去。
eq(
  F.firstCity('深圳 [切换城市] 首页 实习 校招\n测试实习生 某公司 · 西安'),
  '深圳',
  '整页文本里导航城市在前 → 取到深圳（所以详情页必须收窄范围，不能喂整页）'
)
eq(
  F.checkCity('测试实习生\n某公司\n西安·雁塔区\n4天/周\n3个月', ['深圳']),
  { blocked: true, city: '西安' },
  '收窄后的岗位信息区 → 正确认出西安'
)
// 「深圳市」这类带后缀的写法
eq(F.checkCity('测试实习生\n某公司\n深圳市南山区', ['深圳']), { blocked: false, city: '深圳' }, '「深圳市南山区」也算深圳')

// ——————————————————————————————————————————————
// 真实事故样本：公司名里的「深圳」是注册地，不是岗位所在地
//
// 后端里躺着一条：`深圳市正浩创新科技股份有限公司 / 硬件测试工程师（西安）校招`
// 公司名带「深圳」+ 岗位在西安 → 「包含即命中」必然放行。
// 所以岗位名括号里的城市必须**优先于**任何位置推断。
// ——————————————————————————————————————————————
console.log('— 公司名带城市 ≠ 岗位在本地 —')
eq(
  F.checkCity('硬件测试工程师（西安）\n深圳市正浩创新科技股份有限公司', ['深圳']),
  { blocked: true, city: '西安' },
  '「…（西安）」+ 公司名带「深圳」→ 按西安拦（真实事故样本）'
)
eq(
  F.firstCity('深圳市正浩创新科技股份有限公司\n硬件测试工程师（西安）'),
  '西安',
  '即使公司名（含深圳）排在前面，括号里的城市照样优先'
)
eq(F.checkCity('测试实习生（深圳）\n北京某某科技', ['深圳']), { blocked: false, city: '深圳' }, '括号写深圳、公司名带北京 → 按深圳放行')

// ——————————————————————————————————————————————
console.log('')
if (fails.length) {
  console.log(`❌ filters 用例：${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log(`  ❌ ${f}`)
  process.exit(1)
} else {
  console.log(`✅ filters 用例：${pass} 通过 / 0 失败`)
}
