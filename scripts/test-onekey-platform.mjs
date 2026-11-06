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

console.log(`\n结果：${fail ? '失败' : '通过'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail ? 1 : 0)
