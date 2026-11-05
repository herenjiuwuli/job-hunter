/**
 * 修正库里 BOSS 记录的公司名（一次性数据修复）。
 *
 * 背景（2026-11-05 真机事故）：
 *   `extractJobInfo()` 取公司名时用了全页通配
 *   `document.querySelector('..., [class*="company-name"], ...')`。
 *   BOSS 一键投递跑在「左侧列表 + 右侧详情」页面上，文档序第一个匹配
 *   往往来自**左侧列表里别的卡片** → 账本记下了别人的公司。
 *   岗位名用的是精确选择器，所以全对 —— 于是界面上看起来「解析一切正常」，
 *   只有公司名是错的（10 条 BOSS 记录错了 4 条）。
 *
 *   铁证：「【日常实习】数据运营实习生(A69277)」这个内部编号挂在两家不同公司名下。
 *
 * 本脚本只改「有证据」的那几条：证据 = BOSS 聊天页里同一个岗位的真实公司名
 * （点开会话后右栏 .chat-position-content 的岗位卡），其中 A69277 那条已由用户确认。
 *
 * 默认 dry-run 只打印将要做的修改；加 --write 才会落盘（先备份 + 原子写）。
 *
 * 跑：
 *   node scripts/fix-boss-company.mjs            # 看将要改什么
 *   node scripts/fix-boss-company.mjs --write    # 真改
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DATA_DIR = process.env.JOB_HUNTER_DATA_DIR
  ? resolve(process.env.JOB_HUNTER_DATA_DIR)
  : join(process.cwd(), 'server', 'data')
const FILE = join(DATA_DIR, 'applications.json')

/**
 * jobId → 真实公司名（+ 证据来源）。
 *
 * jobId 是平台主键，用它定位最稳 —— 岗位名和公司名都可能带噪声，
 * jobId 不会。
 */
const FIX = {
  // 用户 2026-11-05 明确确认：这个岗位投的时候详情页显示的是「正浩创新」
  boss_6ee158b8afd9e76d0nx53Nu8F1VY: {
    company: '正浩创新',
    jobTitle: '【日常实习】数据运营实习生(A69277)',
    evidence: '用户确认（岗位编号 A69277 唯一，公司不可能是两家）',
  },
  boss_6a22cf53a2e3c2210nx_2tu1FlRR: {
    company: '万兴科技',
    jobTitle: '用户运营实习',
    evidence: 'BOSS 聊天页：「张先生万兴科技招聘者」，同一岗位名、同日',
  },
  boss_507526b39a437a520nx53Ny1GFBQ: {
    company: '迪阿股份有限公司',
    jobTitle: 'AI 工作流搭建实习生',
    evidence: 'BOSS 聊天页：「李希迪阿股份有限公司招聘者」，同一岗位名',
  },
  boss_090350f0ddf5ca990nx_3Ny4E1NS: {
    company: 'TCL实业',
    jobTitle: 'HR-数据运营实习生',
    evidence: 'BOSS 聊天页：「赵亦凡TCL实业HR」，同一岗位名',
  },
}

const write = process.argv.includes('--write')

if (!existsSync(FILE)) {
  console.error(`❌ 找不到 ${FILE}`)
  process.exit(1)
}

const list = JSON.parse(readFileSync(FILE, 'utf-8'))
if (!Array.isArray(list)) {
  console.error('❌ applications.json 不是数组，先确认数据格式（可能已经换存储）')
  process.exit(1)
}

const notFound = []
const changed = []
const next = list.map((a) => {
  const f = FIX[String(a.jobId || '')]
  if (!f) return a
  if (a.company === f.company) {
    changed.push({ ...a, _skip: '已经是正确公司名' })
    return a
  }
  changed.push({ ...a, _from: a.company, _to: f.company, _evidence: f.evidence })
  return { ...a, company: f.company }
})

for (const id of Object.keys(FIX)) {
  if (!list.some((a) => String(a.jobId || '') === id)) notFound.push(id)
}

console.log(`数据文件：${FILE}`)
console.log(`总记录 ${list.length} 条\n`)

if (!changed.length) {
  console.log('没有可改的记录（这几条 jobId 都不在库里）。')
} else {
  console.log('将要修改：')
  for (const c of changed) {
    if (c._skip) {
      console.log(`  = ${c.company} / ${c.jobTitle} —— ${c._skip}`)
      continue
    }
    console.log(`  · ${c.jobTitle}`)
    console.log(`      ${c._from}  →  ${c._to}`)
    console.log(`      jobId: ${c.jobId}`)
    console.log(`      依据：${c._evidence}`)
  }
}

if (notFound.length) {
  console.log(`\n⚠️ 这 ${notFound.length} 个 jobId 在库里找不到（可能已被删/改）：`)
  for (const id of notFound) console.log(`  · ${id}`)
}

// 其余 BOSS 记录：没有独立证据，不敢动 —— 但必须列出来，别让人以为「没报错就是全对」
const others = list.filter(
  (a) => String(a.platform || '').indexOf('BOSS') >= 0 && !FIX[String(a.jobId || '')]
)
if (others.length) {
  console.log(`\n⚠️ 另有 ${others.length} 条 BOSS 记录**没有独立证据**，本次不动 ——`)
  console.log('   但它们的公司名来自同一个坏选择器，可能同样是错的，别当它们是对的：')
  for (const a of others) console.log(`  · ${a.company} / ${a.jobTitle}`)
}

const realChanges = changed.filter((c) => !c._skip)
if (!write) {
  console.log(`\n（dry-run）要真改请加 --write。将修改 ${realChanges.length} 条。`)
  process.exit(0)
}
if (!realChanges.length) {
  console.log('\n无需写入。')
  process.exit(0)
}

// 备份 + 原子写：写一半断掉会留下坏 JSON，整个库都读不出来
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = `${FILE}.bak-company-${stamp}`
copyFileSync(FILE, bak)
const tmp = `${FILE}.tmp-${stamp}`
writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
renameSync(tmp, FILE)

console.log(`\n✅ 已修改 ${realChanges.length} 条`)
console.log(`   备份：${bak}`)
console.log('   提醒：扩展本地账本（chrome.storage 的 applied）里这几条的公司名仍是旧的，')
console.log('   下次「补传账本」会按 jobId 匹配到已有记录、不会重复建，但也不会覆盖公司名。')
