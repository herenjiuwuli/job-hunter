/**
 * 回填投递记录的方向（`direction`）。
 *
 * 背景（2026-11-05 对账发现）：36 条投递里只有 2 条有 direction。
 * 后端补方向的唯一来源是 `lookupDirection()` → `data/jd/jobs.json`，
 * 而那份语料只有 5 条、direction 全空 —— 等于补不了。结果 `?groupBy=direction`
 * 只能分出「未分类 34 条」，漏斗最有价值的那句话（「X 类岗位回复率是 Y 类的 N 倍」）根本算不出来。
 *
 * 新投的记录已经在投递那一刻由扩展写入方向（见 content.js 的 `directionOf`），
 * 这个脚本只处理**存量**，做两件事：
 *   1. **归一化**：历史手工写的值（如「测试」）映射到标准方向标签（「测试开发 / 软件测试」）。
 *      不归一化的话同一个方向会拆成两个 key，漏斗里凭空多一层。
 *   2. **回填**：按岗位标题里出现的方向词补，标题判不出来就留空。
 *      留空是「不知道」，瞎填是「知道错」——后者在漏斗里会被当成一类的真实样本。
 *
 * 用法：
 *   node scripts/backfill-direction.mjs            # 只看会改什么（不写盘）
 *   node scripts/backfill-direction.mjs --write    # 真写（先自动备份）
 */
import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA = join(ROOT, 'server', 'data', 'applications.json')
const FILTERS = join(ROOT, 'extension', 'shared', 'filters-data.js')

const ctx = { window: {}, URL }
createContext(ctx)
runInContext(readFileSync(FILTERS, 'utf-8'), ctx)
const F = ctx.window.JH_FILTERS
if (!F || !Array.isArray(F.DIRECTIONS)) {
  console.error('❌ filters-data.js 没挂上 window.JH_FILTERS.DIRECTIONS')
  process.exit(1)
}

/**
 * 标题 → 方向标签。
 * 顺序跟 content.js 的 directionOf 一致（按 DIRECTIONS 声明顺序取第一个命中），
 * 否则同一个岗位「投的时候记成 A、回填成 B」，按方向分组会凭空多出一类。
 */
function directionOf(title) {
  const t = String(title || '').toLowerCase()
  for (const d of F.DIRECTIONS) {
    if (d.keywords.some((k) => F.hitKeyword(t, k))) return d.label
  }
  return ''
}

/** 旧值 → 标准标签（认不出来的原样保留：宁可留个怪值，也别篡改人写的备注） */
function normalizeDirection(v) {
  const raw = String(v || '').trim()
  if (!raw) return ''
  if (F.DIRECTIONS.some((d) => d.label === raw)) return raw
  const byId = F.DIRECTIONS.find((d) => d.id === raw)
  if (byId) return byId.label
  const t = raw.toLowerCase()
  const byKw = F.DIRECTIONS.find((d) => d.keywords.some((k) => F.hitKeyword(t, k)))
  return byKw ? byKw.label : raw
}

const write = process.argv.includes('--write')
const list = JSON.parse(readFileSync(DATA, 'utf-8'))
if (!Array.isArray(list)) {
  console.error('❌ applications.json 不是数组，先确认数据结构')
  process.exit(1)
}

const renamed = []
const filled = []
const stillEmpty = []

for (const a of list) {
  if (!a) continue
  if (a.direction) {
    const nv = normalizeDirection(a.direction)
    if (nv !== a.direction) renamed.push({ a, from: a.direction, to: nv })
    continue
  }
  const d = directionOf(a.jobTitle)
  if (!d) {
    stillEmpty.push(a)
    continue
  }
  filled.push({ a, d })
}

console.log(
  `共 ${list.length} 条｜需归一化 ${renamed.length} 条｜可回填 ${filled.length} 条｜补不上 ${stillEmpty.length} 条`
)

if (renamed.length) {
  console.log('\n— 旧值归一化（同一个方向不许有两个 key）—')
  for (const { a, from, to } of renamed.slice(0, 12)) {
    console.log(`  ${String(a.jobTitle || '(无标题)').slice(0, 24).padEnd(26)} ${from} → ${to}`)
  }
}

console.log('\n— 回填后会变成 —')
const byDir = {}
for (const { d } of filled) byDir[d] = (byDir[d] || 0) + 1
for (const [d, n] of Object.entries(byDir)) console.log(`  ${String(n).padStart(2)} 条 → ${d}`)
for (const { a, d } of filled.slice(0, 10)) {
  console.log(`     ${String(a.jobTitle || '(无标题)').slice(0, 24).padEnd(26)} → ${d}`)
}

if (stillEmpty.length) {
  console.log('\n— 标题里没有方向词、保持空白（交给人工或后端语料）—')
  for (const a of stillEmpty.slice(0, 12)) {
    console.log(`  ${a.company || '(无公司)'} / ${a.jobTitle || '(无标题)'}`)
  }
}

if (!write) {
  console.log('\n（只看不改。确认无误后加 --write 真写，会先备份）')
  process.exit(0)
}

if (!filled.length && !renamed.length) {
  console.log('\n没有需要改的记录，未写盘')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = `${DATA}.bak-direction-${stamp}`
copyFileSync(DATA, bak)
for (const { a, to } of renamed) a.direction = to
for (const { a, d } of filled) a.direction = d
// 原子写：后端进程（:3100）随时可能读这个文件，写到一半被读到就是「整份数据消失」
// （readJSON 解析失败会返回 null）。先写临时文件再 rename，和 server/lib/store.js 一个套路。
const tmp = `${DATA}.${process.pid}.tmp`
writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf-8')
renameSync(tmp, DATA)
console.log(`\n✅ 归一化 ${renamed.length} 条、回填 ${filled.length} 条，备份：${bak}`)
