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
console.log('')
if (fails.length) {
  console.log(`❌ filters 用例：${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log(`  ❌ ${f}`)
  process.exit(1)
} else {
  console.log(`✅ filters 用例：${pass} 通过 / 0 失败`)
}
