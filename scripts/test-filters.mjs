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

const ctx = { window: {}, URL }
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

// checkCity 是三态（blocked / nationwide / 放行）。这一组只看「拦没拦、在哪个城市」，
// 「全国」那一态单独测 —— 否则每条老用例都要跟着加字段，改一次挂一片。
const cityOf = (text, cities) => {
  const r = F.checkCity(text, cities)
  return { blocked: r.blocked, city: r.city }
}

// 实习僧「我的投递」卡片形态（真实结构：岗位名 / 公司-城市 / 时间 / 状态）
const sxRow = (title, company, city) => `${title}\n${company}-${city}\n2026-11-02 16:42:21\n投递成功`

// 「全国」不是异地：既可能真在深圳，也可能在外地 → 单独一态，交给上层列成待定
console.log('— 城市门槛：「全国」既不算过也不算拦 —')
eq(
  F.checkCity('测试工程师\n东方金信\n全国\n应届生\n本科', ['深圳']),
  { blocked: true, city: '全国', nationwide: true },
  '写「全国」→ 标 nationwide，不当作普通异地丢掉'
)
eq(
  F.checkCity('测试工程师\n某公司\n不限\n应届生', ['深圳']),
  { blocked: false, city: '', nationwide: false },
  '「不限」不当城市（BOSS 卡片上「学历不限」到处都是，认了会误伤一大片）'
)
eq(
  F.checkCity('测试工程师\n某公司\n深圳\n应届生', ['深圳']).nationwide,
  false,
  '明确写了深圳 → 不是 nationwide'
)
eq(
  F.checkCity('测试实习生\n某公司-西安', ['深圳']).nationwide,
  false,
  '明确异地 → 是普通拦截，不是 nationwide（两者处理方式不同）'
)

eq(
  cityOf(sxRow('测试实习生', '某公司', '西安'), ['深圳']),
  { blocked: true, city: '西安' },
  '卡片写「西安」→ 拦（这就是用户遇到的）'
)
eq(
  cityOf(sxRow('测试实习生', '某公司', '深圳'), ['深圳']),
  { blocked: false, city: '深圳' },
  '卡片写「深圳」→ 放行'
)
eq(
  cityOf(sxRow('测试实习生', '某公司', '西安'), ['深圳', '广州']),
  { blocked: true, city: '西安' },
  '只投深圳/广州，岗位在西安 → 拦'
)

// 认不出城市 → 不拦（交给 strictMeta 决定），不能因为读不到就全拦
eq(cityOf('测试实习生\n某公司', ['深圳']), { blocked: false, city: '' }, '认不出城市 → 不拦（city 为空）')
// 没设城市门槛 → 永远不拦
eq(cityOf('测试实习生\n某公司-西安', []), { blocked: false, city: '' }, '没选城市 → 不判')

// ⚠️ 这条是在钉住「函数的局限」：整页文本里导航的「深圳」在岗位的「西安」前面，
// firstCity 会取到深圳 —— 所以详情页**必须**先用 cityTextNearTitle() 把范围收窄，
// 不能直接喂 document.body.innerText。测试在这里，是为了防止有人「顺手简化」回去。
eq(
  F.firstCity('深圳 [切换城市] 首页 实习 校招\n测试实习生 某公司 · 西安'),
  '深圳',
  '整页文本里导航城市在前 → 取到深圳（所以详情页必须收窄范围，不能喂整页）'
)
eq(
  cityOf('测试实习生\n某公司\n西安·雁塔区\n4天/周\n3个月', ['深圳']),
  { blocked: true, city: '西安' },
  '收窄后的岗位信息区 → 正确认出西安'
)
// 「深圳市」这类带后缀的写法
eq(cityOf('测试实习生\n某公司\n深圳市南山区', ['深圳']), { blocked: false, city: '深圳' }, '「深圳市南山区」也算深圳')

// ——————————————————————————————————————————————
// 真实事故样本：公司名里的「深圳」是注册地，不是岗位所在地
//
// 后端里躺着一条：`深圳市正浩创新科技股份有限公司 / 硬件测试工程师（西安）校招`
// 公司名带「深圳」+ 岗位在西安 → 「包含即命中」必然放行。
// 所以岗位名括号里的城市必须**优先于**任何位置推断。
// ——————————————————————————————————————————————
console.log('— 公司名带城市 ≠ 岗位在本地 —')
eq(
  cityOf('硬件测试工程师（西安）\n深圳市正浩创新科技股份有限公司', ['深圳']),
  { blocked: true, city: '西安' },
  '「…（西安）」+ 公司名带「深圳」→ 按西安拦（真实事故样本）'
)
eq(
  F.firstCity('深圳市正浩创新科技股份有限公司\n硬件测试工程师（西安）'),
  '西安',
  '即使公司名（含深圳）排在前面，括号里的城市照样优先'
)
eq(cityOf('测试实习生（深圳）\n北京某某科技', ['深圳']), { blocked: false, city: '深圳' }, '括号写深圳、公司名带北京 → 按深圳放行')

// ——————————————————————————————————————————————
console.log('\n— 方向词命中：中文包含 / 英文词边界 —')
// 2026-11-05 真机：搜「SDET」出的几条是英文岗名（Quality Assurance / Test Engineer），
// 词表当时只有中文 + 工具名 → 3 家全判「没有方向词」，一家都没投。
// 反过来，英文若是纯包含判断，`test` 会命中 `latest`，把关不严等于没关。
const dirHit = (title) =>
  F.DIRECTIONS.filter((d) => d.keywords.some((k) => F.hitKeyword(title, k))).map((d) => d.id)

eq(F.hitKeyword('软件测试工程师', '测试'), true, '中文用包含：长词里有「测试」就算命中')
eq(F.hitKeyword('SDET', 'sdet'), true, '英文不分大小写')
eq(F.hitKeyword('latest technologies intern', 'test'), false, 'latest 里没有独立的 test（词边界救回来）')
eq(F.hitKeyword('qax corp', 'qa'), false, 'qax 不是 qa')
eq(F.hitKeyword('QA工程师', 'qa'), true, '中英混写也认（中文不是字母，算边界）')
eq(F.hitKeyword('quality assurance intern', 'quality assurance'), true, '多词短语整串匹配')
eq(dirHit('Quality Assurance Intern'), ['qa'], '英文 QA 岗名 → 测试方向（原来全漏）')
eq(dirHit('Software Test Engineer'), ['qa'], '英文 Test Engineer → 测试方向')
eq(dirHit('SDET Intern'), ['auto'], 'SDET → 自动化方向')
eq(dirHit('Test Automation Intern'), ['qa', 'auto'], 'Test Automation 同时命中测试 / 自动化两组（都该放行）')
eq(dirHit('Latest Technologies Intern'), [], '标题里有 latest 不等于测试岗（不能误放行）')
eq(dirHit('前端开发实习生'), ['fe'], '中文方向分组不受影响')

// ——————————————————————————————————————————————
console.log('\n— 关键词切分（一键投递可以排多个词）—')
// 一个词在一个城市通常只有 20~40 个岗位，投完就没了，所以要能排几个词轮着跑。
// 切错了不会报错：多切出一个词 = 多跑一轮空搜索，少切 = 后面的词根本没跑。
eq(F.parseKeywords('软件测试, 测试开发'), ['软件测试', '测试开发'], '英文逗号')
eq(F.parseKeywords('软件测试，测试开发、QA'), ['软件测试', '测试开发', 'QA'], '中文逗号 / 顿号都算分隔符')
eq(F.parseKeywords('软件测试\n测试开发'), ['软件测试', '测试开发'], '换行也算（粘贴一列词就能用）')
eq(F.parseKeywords('  测试  ,,  , 测试 '), ['测试'], '去空、去重（重复的词不能跑两遍）')
eq(F.parseKeywords('测试 开发'), ['测试 开发'], '空格不是分隔符：「测试 开发」是一个词')
eq(F.parseKeywords(''), [], '空串 → 空数组（调用方据此走「关键词不限」）')
eq(F.parseKeywords('a,b,c,d,e,f,g,h,i,j,k,l'), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], '最多 10 个（防止一次排太多跑一整天）')
eq(
  F.DEFAULT_FILTERS.directions,
  ['qa', 'auto', 'api', 'game'],
  '默认方向只留测试类（前端/产品/运营/数据分析不该自动放行）'
)

// ——————————————————————————————————————————————
// 城市 × 关键词展开（一键投递多选城市）
//
// 为什么这组要测：实习僧的 `city` 是**单值** query 参数。界面上勾了 2 个城市，
// 如果展开逻辑漏了城市维度，插件会安静地只搜第一个城市 —— 而界面上明明勾着两个，
// 用户会以为「广州也投了」。反过来，顺序错了会让用户看到「第 5/8 个」却不知道在跑哪。
{
  const u = (p) =>
    `https://www.shixiseng.com/interns?keyword=${encodeURIComponent(p.keyword)}&city=${encodeURIComponent(
      p.city
    )}&type=${encodeURIComponent(p.type || 'intern')}`

  eq(
    F.taskNameOf('https://www.shixiseng.com/interns?keyword=%E8%BD%AF%E4%BB%B6%E6%B5%8B%E8%AF%95&city=%E6%B7%B1%E5%9C%B3&type=school'),
    '深圳·校招·软件测试',
    '任务名 = 城市·类型·关键词'
  )
  eq(
    F.taskNameOf('https://www.shixiseng.com/interns?keyword=%E6%B5%8B%E8%AF%95&type=school'),
    '校招·测试',
    '没有 city 时任务名是「类型·关键词」'
  )
  eq(
    F.taskNameOf('https://www.shixiseng.com/interns?city=%E6%B7%B1%E5%9C%B3&type=school'),
    '深圳·校招',
    '没有 keyword 时任务名是「城市·类型」（关键词不限）'
  )
  eq(F.taskNameOf('not a url'), '', '地址不合法时返回空串，不抛错')

  const t1 = F.expandSearchTasks(['软件测试', 'SDET'], ['深圳', '广州'], ['intern', 'school'], u)
  eq(t1.length, 8, '2 城 × 2 类型 × 2 词 = 8 个搜索任务')
  eq(
    t1.map((x) => `${x.city}/${x.type}/${x.keyword}`),
    [
      '深圳/intern/软件测试',
      '深圳/intern/SDET',
      '深圳/school/软件测试',
      '深圳/school/SDET',
      '广州/intern/软件测试',
      '广州/intern/SDET',
      '广州/school/软件测试',
      '广州/school/SDET',
    ],
    '城市在外层、类型在次外层、关键词在内层：先把深圳·实习跑完，再深圳·校招，最后广州'
  )
  eq(t1[0].url.includes(encodeURIComponent('深圳')), true, '每条任务的地址带自己的城市')

  eq(F.expandSearchTasks(['测试'], [], ['intern'], u).length, 1, '不选城市、单类型 = 只跑 1 轮（不限城市）')
  eq(F.expandSearchTasks(['测试'], [], ['intern'], u)[0].city, '', '不选城市时 city 为空（地址里不带 city）')
  eq(F.expandSearchTasks([], ['深圳', '广州'], ['intern'], u).length, 2, '关键词不限时按城市各跑一轮')
  eq(F.expandSearchTasks([], ['深圳'], ['intern'], u)[0].keyword, '', '关键词不限时 keyword 为空')
  eq(F.expandSearchTasks(['测试'], ['深圳'], [], u).length, 1, '类型为空 = 类型维度退化为 1（不筛选类型）')
  eq(F.expandSearchTasks(['测试'], ['深圳'], ['intern', 'school'], u).length, 2, '单城单词双类型 = 2 轮')
  eq(F.expandSearchTasks(['测试'], ['深圳'], ['intern'], null), [], '没给拼接函数时返回空数组，不抛错')
}

// ——————————————————————————————————————————————
console.log('')
if (fails.length) {
  console.log(`❌ filters 用例：${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log(`  ❌ ${f}`)
  process.exit(1)
} else {
  console.log(`✅ filters 用例：${pass} 通过 / 0 失败`)
}
