#!/usr/bin/env node
// JD 语料统计：把收进来的岗位 JD 汇总成「市场要什么」的快照。
// 用法：npm run jd:stats
// 目的不是好看，是回答三个问题：
//   1) 我盯的方向里，哪些硬性要求反复出现（→ 该补的技能）
//   2) 哪些是我有但没写进简历的（→ 改简历）
//   3) 排除的岗位为什么排除（→ 下次筛得更快）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'data/jd/jobs.json')
const data = JSON.parse(readFileSync(file, 'utf8'))
const all = data.jobs || []
const live = all.filter((j) => j.status !== '已排除')
const dead = all.filter((j) => j.status === '已排除')

const line = (s = '') => console.log(s)
const head = (s) => {
  line('')
  line(`── ${s} ${'─'.repeat(Math.max(0, 46 - s.length * 2))}`)
}

line(`JD 语料库　更新于 ${data.updated || '未知'}`)
line(`共 ${all.length} 份：在跟 ${live.length} 份 / 已排除 ${dead.length} 份`)

// ---------- 按方向 ----------
head('按方向')
const byDir = new Map()
for (const j of live) {
  const k = j.direction || '未分类'
  if (!byDir.has(k)) byDir.set(k, [])
  byDir.get(k).push(j)
}
for (const [dir, list] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const pays = list.filter((j) => j.salaryDay).map((j) => j.salaryDay)
  const avg = pays.length
    ? Math.round(pays.reduce((s, p) => s + (p[0] + p[1]) / 2, 0) / pays.length)
    : null
  const days = [...new Set(list.map((j) => j.daysPerWeek).filter(Boolean))].sort()
  const months = [...new Set(list.map((j) => j.months).filter(Boolean))].sort()
  const bits = [
    `${list.length} 份`,
    avg ? `均价 ${avg}/天` : '薪资未记录',
    days.length ? `${days.join('/')} 天每周` : '',
    months.length ? `${months.join('/')} 个月` : '',
  ].filter(Boolean)
  line(`  ${dir.padEnd(10)} ${bits.join('　')}`)
}

// ---------- 硬性要求频次 ----------
head('硬性要求出现频次（在跟岗位）')
const freq = new Map()
for (const j of live) {
  for (const s of [...(j.hardSkills || []), ...(j.tags || [])]) {
    if (!s) continue
    freq.set(s, (freq.get(s) || 0) + 1)
  }
}
const topFreq = [...freq.entries()].sort((a, b) => b[1] - a[1])
if (!topFreq.length) line('  （暂无可统计项）')
for (const [k, n] of topFreq) {
  if (n < 2) continue
  line(`  ${String(n).padStart(2)}×  ${k}`)
}

// ---------- 缺口 ----------
head('我的缺口 / 风险点')
let gapN = 0
for (const j of live) {
  const flags = [...(j.redFlags || [])]
  if (flags.length) {
    gapN += flags.length
    line(`  ${j.title}`)
    flags.forEach((f) => line(`    ! ${f}`))
  }
}
if (!gapN) line('  （无）')

// ---------- 资料不全 ----------
head('资料待补（补全后统计才准）')
const incomplete = live.filter((j) => (j.dataGaps || []).length)
if (!incomplete.length) line('  （无）')
for (const j of incomplete) {
  line(`  ${j.title}　缺：${j.dataGaps.join('、')}`)
}

// ---------- 排除原因 ----------
head('已排除（下次直接跳过同类）')
if (!dead.length) line('  （无）')
for (const j of dead) line(`  ${j.title}　→ ${j.excludeReason || '未写原因'}`)

line('')
