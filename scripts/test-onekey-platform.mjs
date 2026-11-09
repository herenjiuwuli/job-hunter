// 「一键投递」必须投**眼前这个页面所在的平台**，不能投别的平台。
//
// 2026-11-06 真机事故：用户在 BOSS 页点「一键投递」，按钮上写死「（实习僧）」、
// 代码里写死 `findLineTab('sx')`，于是直接把他从 BOSS 拽到实习僧，并按实习僧的
// 关键词/城市开始投。这类 bug **跑起来完全不报错**（甚至投得挺顺），只是投错平台，
// 所以只能靠结构断言 + 纯函数断言抓。
//
// 两条断言各自防的东西不一样：
//   ① 结构：oneKeyBtn 的处理体里必须用当前页判断平台、必须用当前 tab 投 BOSS、
//      pending 标记里的 line 不能写死 'sx'；
//   ② 行为：buildBossSearchUrl 换词只动 query，其余筛选参数原样保留。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'extension/popup/popup.js'), 'utf8')
const html = fs.readFileSync(path.join(root, 'extension/popup/popup.html'), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) pass++
  else fail++
  console.log(cond ? '✅' : '❌', name, cond ? '' : detail)
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(name, a === e, `实际=${a} 期望=${e}`)
}

// ===== ① 结构断言：拿真的 oneKeyBtn 处理体 =====
const startAt = src.indexOf("document.getElementById('oneKeyBtn')")
const endAt = src.indexOf('// ===================== 标签页切换')
ok('找到 oneKeyBtn 处理体', startAt > 0 && endAt > startAt)
const handler = src.slice(startAt, endAt)

ok('平台由当前页判断（activeLine）', /await\s+activeLine\(\)/.test(handler), '没调用 activeLine()，可能又回去写死平台了')
ok('判不出平台就不开投', /if\s*\(!plat\.key\)/.test(handler), '缺少「当前页不是平台页」的拦截')
ok('BOSS 用当前 tab（不另找实习僧）', /isBoss\s*\?\s*plat\.tab\s*:\s*await\s+findLineTab\('sx'\)/.test(handler), 'tab 选择没有按平台分派')
ok('pending 的 line 用变量而非写死 sx', /line,\s*\n\s*limit:/.test(handler) && !/line:\s*'sx'/.test(handler), "oneKeyPending.line 仍写死 'sx'，content 侧会拒绝在 BOSS 页启动")
ok('启动日志用 lineName（不写死实习僧）', /startLogText\(res,\s*lineName\)/.test(handler) && !/startLogText\(res,\s*'实习僧'\)/.test(handler))

// 按钮文案必须动态，不能把平台写死在 HTML 上
ok('HTML 里按钮不再写死实习僧', !/一键投递（实习僧）<\/button>/.test(html), 'popup.html 的 oneKeyBtn 文案仍写死「（实习僧）」')
ok('按钮文案按平台更新', /updateOneKeyLabel/.test(src) && /一键投递（BOSS）/.test(src))

// ===== ② 行为断言：buildBossSearchUrl 用真实现 =====
const isBossSrc = src.match(/const isBossSearchUrl = \(u\) =>[^\n]+/)?.[0]
const buildSrc = src.match(/function buildBossSearchUrl\(baseUrl, keyword\) \{[\s\S]*?\n\}/)?.[0]
ok('取到 isBossSearchUrl', !!isBossSrc)
ok('取到 buildBossSearchUrl', !!buildSrc)
if (isBossSrc && buildSrc) {
  const build = new Function(`${isBossSrc}\n${buildSrc}\nreturn buildBossSearchUrl`)()
  const base = 'https://www.zhipin.com/web/geek/job?query=%E6%B5%8B%E8%AF%95&city=101280600&experience=102&degree=203'

  const u1 = new URL(build(base, '测试开发'))
  eq('换词只改 query', u1.searchParams.get('query'), '测试开发')
  eq('城市参数原样保留', u1.searchParams.get('city'), '101280600')
  eq('经验参数原样保留', u1.searchParams.get('experience'), '102')
  eq('学历参数原样保留', u1.searchParams.get('degree'), '203')
  eq('路径不变', u1.pathname, '/web/geek/job')

  // 上一页停在第 3 页时不能把 page 带进去，否则新一轮从第 3 页开始
  const u2 = new URL(build(base + '&page=3', '运营'))
  eq('剥掉 page 参数', u2.searchParams.get('page'), null)

  // 聊天页不能当模板：路径要纠正回搜索页，否则跳过去还是聊天页
  const u3 = new URL(build('https://www.zhipin.com/web/geek/chat?query=x', '测试'))
  eq('聊天页被纠正成搜索页', u3.pathname, '/web/geek/job')

  // 非 BOSS 域名一律拒绝（别把实习僧的地址喂进 BOSS 逻辑）
  eq('非 BOSS 域名返回空', build('https://www.shixiseng.com/interns?keyword=x', '测试'), '')
  eq('非法地址返回空', build('not-a-url', '测试'), '')
}

// ===== ③ 「投完这个岗位，继续投」——BOSS 非搜索页的四层条件回退（2026-11-09）=====
// 真机事故：用户投完一个岗位、人停在职位详情页，点继续投被拒（「非搜索页，没有筛选条件」）。
// 但「继续投」这个动作**天生**发生在详情页 —— 不修等于这个功能永远用不上。
// 所以这里断言：四条回退一条都不能少，且必须把「用的是哪份条件」写在日志里。
ok('不再直接拒绝（旧文案已删）', !/没有筛选条件可用，所以没开投/.test(handler), '还在用旧的一刀切拒绝')
ok('回退①：当前页是搜索页', /isBossSearchUrl\(cur\)/.test(handler))
ok('回退②：BOSS 模板', /oneKeyBossTemplate/.test(handler))
ok('回退③：其他开着的 BOSS 搜索页标签', /findBossSearchTab\(cur\)/.test(handler))
ok('回退④：插件记住的上次筛选', /BOSS_LAST_BASE_KEY/.test(handler))
ok('兜底：从当前页 URL 捞筛选参数', /bossBaseFromAnyUrl\(cur\)/.test(handler), '少了详情页兜底')
ok('日志写明条件来源', /条件来源：\$\{bossBaseSrc\}/.test(src), '用户看不出这一跳用的是哪份筛选')
ok('城市没锁要显式告警', /城市没锁/.test(src), '城市以站点默认为准时必须写出来，否则配错了没人发现')
ok('记住的条件只有真搜索页才更新', /bossBaseSrc === '当前页（BOSS 搜索结果页）'/.test(handler) || /await rememberBossBase\(bossBase\)/.test(handler))

// 行为：bossBaseFromAnyUrl 只搬白名单参数
const keepSrc = src.match(/const BOSS_KEEP_PARAMS = \[[^\]]+\]/)?.[0]
const anySrc = src.match(/function bossBaseFromAnyUrl\(u\) \{[\s\S]*?\n\}/)?.[0]
ok('取到 bossBaseFromAnyUrl', !!keepSrc && !!anySrc)
if (keepSrc && anySrc) {
  const fromAny = new Function(`${keepSrc}\n${anySrc}\nreturn bossBaseFromAnyUrl`)()

  // BOSS 详情页：路径是 /job_detail/xxx.html，但 URL 上常挂着点进来时的 city
  const detail = fromAny(
    'https://www.zhipin.com/job_detail/abc123.html?lid=8x&securityId=SEC&city=101280600&ka=header'
  )
  const d = new URL(detail)
  eq('详情页 → 纠正成搜索页路径', d.pathname, '/web/geek/job')
  eq('详情页 → 保住城市', d.searchParams.get('city'), '101280600')
  eq('详情页 → 丢掉一次性签名 securityId', d.searchParams.get('securityId'), null)
  eq('详情页 → 丢掉 lid', d.searchParams.get('lid'), null)
  eq('详情页 → 丢掉 ka', d.searchParams.get('ka'), null)

  // 聊天页什么都没有：只能给出一个干净的搜索入口，不能凭空造城市
  const chat = fromAny('https://www.zhipin.com/web/geek/chat?id=99')
  const c = new URL(chat)
  eq('聊天页 → 搜索页路径', c.pathname, '/web/geek/job')
  eq('聊天页 → 不编造城市', c.searchParams.get('city'), null)
  eq('聊天页 → 只剩路径', c.search, '')

  eq('非 BOSS 域名返回空', fromAny('https://www.shixiseng.com/interns?city=深圳'), '')
  eq('非法地址返回空', fromAny('nope'), '')
}

// 启动结果的回显不能写死平台：BOSS 上启动后 5 分钟内重开插件，
// 日志会写「✅ 实习僧：3 家已启动」，而实际一家都没投到实习僧（2026-11-09 顺手修）
const contentSrc = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8')
ok('回显平台名不写死', !/startLogText\(lastOneKeyResult, '实习僧'\)/.test(src), '还在写死实习僧')
ok('content 上报结果带平台名', /lastOneKeyResult: \{ \.\.\.res, platform: platform\(\)/.test(contentSrc), 'content 没把平台名写进 lastOneKeyResult')

console.log(`\n结果：${fail ? '失败' : '通过'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail ? 1 : 0)