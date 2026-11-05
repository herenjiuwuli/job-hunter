/**
 * 弹窗 HTML ←→ popup.js 的元素 id 对齐检查。
 *
 * 为什么需要：popup.html 被重排过两次（v0.7.15 的瘦身：5 个 tab 合 3 个、
 * 十几个按钮收进 <details>），而 popup.js 里 80 多个 `$('#id')` 是**运行时**才取值的。
 * 少写一个 id 的后果是：`null.addEventListener` 直接把整个弹窗脚本炸掉 ——
 * 表现是「弹窗一片空白/所有按钮都不响应」，但控制台里那行报错很容易被当成无关噪音。
 * 这类错误 py/单测都扫不到，只能靠对表。
 *
 * 跑：node scripts/test-popup-ids.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = readFileSync(join(ROOT, 'extension/popup/popup.js'), 'utf8')
const html = readFileSync(join(ROOT, 'extension/popup/popup.html'), 'utf8')

/** popup.js 里所有静态引用到的 id */
const REF = new Set()
for (const m of js.matchAll(/\$\('#([\w-]+)'\)/g)) REF.add(m[1])
for (const m of js.matchAll(/getElementById\('([\w-]+)'\)/g)) REF.add(m[1])

/** 动态拼的 id：`${prefix}-${L.key}` 这种，LINES 只有 sx / boss 两条线 */
const LINES = ['sx', 'boss']
for (const k of LINES) {
  for (const p of ['state', 'start', 'stop', 'info', 'queue', 'pending']) REF.add(`${p}-${k}`)
}

const HAVE = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]))
const missing = [...REF].filter((i) => !HAVE.has(i)).sort()
const unused = [...HAVE].filter((i) => !REF.has(i) && !i.startsWith('pane-')).sort()

let fail = 0
if (missing.length) {
  fail++
  console.log(`❌ popup.html 缺少 ${missing.length} 个 id（popup.js 会取到 null）：`)
  for (const i of missing) console.log(`     · #${i}`)
} else {
  console.log(`✅ ${REF.size} 个 id 全部能在 popup.html 里找到`)
}

// 反向只提示不判红：有些 id 是纯展示/纯 CSS 用的，没有 JS 引用是正常的
if (unused.length) console.log(`ℹ️  ${unused.length} 个 id 没被 JS 引用（可能是纯展示）：${unused.join(', ')}`)

// 折叠区必须能展开：<details> 数量对不上说明结构被改坏了
const openTags = (html.match(/<details>/g) || []).length
const closeTags = (html.match(/<\/details>/g) || []).length
if (openTags !== closeTags) {
  fail++
  console.log(`❌ <details> 标签不配对：开 ${openTags} / 闭 ${closeTags}`)
}

/**
 * 主流程按钮不能被收进 <details>。
 *
 * 这是 v0.8.0 瘦身踩过的坑：为了「按钮砍一半」，把「确认上传」一起收进了
 * 「高级 · 预览 / 校准 / 重置」，但聊天页采集是**只预览、不自动传**的，
 * 而状态栏还写着「确认无误再上传」—— 主流程上没有入口，采完 9 条看着全对、
 * 一条也没进库，而且不留任何报错。按钮藏起来不会报错，只能靠这条规则钉住。
 */
const MUST_VISIBLE = [
  'goBtn', // 开始投递
  'stopBtn', // 停止
  'collectOneClickBtn', // 同步（实习僧）
  'collectChatBtn', // 同步（BOSS 聊天页）
  'collectUploadBtn', // 确认上传 ← 就是它被藏过
  'collectAdoptBtn', // 补录账本里没有的投递
  'checkAppliedBtn', // 刷新账本
  'markAppliedBtn', // 标记当前岗位为已投
  'fetchGreetingBtn', // 重新取话术
]
const depthOf = new Map()
{
  const re = /<details>|<\/details>|<button[^>]*id="([\w-]+)"[^>]*>/g
  let depth = 0
  let m
  while ((m = re.exec(html))) {
    const t = m[0]
    if (t === '<details>') depth++
    else if (t === '</details>') depth--
    else if (m[1]) depthOf.set(m[1], depth)
  }
}
const buried = MUST_VISIBLE.filter((i) => depthOf.has(i) && depthOf.get(i) > 0)
const unbound = MUST_VISIBLE.filter((i) => !depthOf.has(i))
if (buried.length) {
  fail++
  console.log(`❌ 这些主流程按钮被收进了 <details>，用户点不到：${buried.join(', ')}`)
}
if (unbound.length) {
  fail++
  console.log(`❌ 这些主流程按钮在 popup.html 里找不到（改名了？）：${unbound.join(', ')}`)
}
if (!buried.length && !unbound.length) {
  console.log(`✅ ${MUST_VISIBLE.length} 个主流程按钮都在折叠区之外`)
}

console.log(fail ? `\n结果：${fail} 项失败` : '\n结果：通过')
process.exit(fail ? 1 : 0)
