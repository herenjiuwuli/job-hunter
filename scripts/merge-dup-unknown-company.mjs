/**
 * 合并「同一份投递被拆成两条」的重复记录（一次性数据修复）。
 *
 * 背景（2026-11-10 真机）：
 *   库里 75 条 BOSS 记录公司名是「未知公司」，标题是**页面原文带薪资**
 *   （「测试实习生 3-5K」）—— 那是一键投递时建的，公司名选择器当年是坏的。
 *   后来从聊天页 / 投递记录页采到的是「公司真名 + 剥了薪资的标题」。
 *   两半全对不上（公司：未知公司 vs 银河电力；标题：带不带薪资）→ `sameApply` 判不是同一条
 *   → **新建**一批重复记录，而投递日期留在了旧记录里
 *   （界面表现：补上公司名的那几条，投递日期反而没了）。
 *
 *   后端已修（`matchByPlaceholderCompany`：库里没公司名时允许只凭标题唯一认领），
 *   但**已经造出来的重复不会自己消失** —— 本脚本负责收尾。
 *
 * 匹配规则（宁可漏，不许错）：
 *   - 同平台、同 owner；
 *   - 一边公司名是占位（空 / 「未知公司」）且**有 jobId** → 主线（它有投递日期和平台主键）；
 *   - 另一边有真公司名、**没有 jobId** → 副线（是后来新建的重复）；
 *   - 剥掉薪资尾巴后标题**完全相同**，且在全库里唯一 —— 有第二条候选就整个跳过。
 *     认错等于把 A 的进度写到 B 头上，比留着重复难发现得多。
 *
 * 默认 dry-run 只打印；加 --write 才落盘（先备份 + 原子写）。
 *
 * 跑：
 *   node scripts/merge-dup-unknown-company.mjs           # 看会合并哪些
 *   node scripts/merge-dup-unknown-company.mjs --write   # 真合并
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DATA_DIR = process.env.JOB_HUNTER_DATA_DIR
  ? resolve(process.env.JOB_HUNTER_DATA_DIR)
  : join(process.cwd(), 'server', 'data')
const FILE = join(DATA_DIR, 'applications.json')

/** 与后端 stripSalaryTail / normTitleLoose 保持一致（这里是独立脚本，不 import 服务端模块） */
function stripSalaryTail(s) {
  return String(s || '')
    .replace(/\s*\d+(?:\.\d+)?\s*[-~－]\s*\d+(?:\.\d+)?\s*[kK千]\s*(?:·\s*\d+\s*薪)?\s*$/, '')
    .replace(/\s*\d+(?:\.\d+)?\s*[-~－]\s*\d+(?:\.\d+)?\s*(?:元)?\s*\/?\s*(?:天|月|小时|时)\s*$/, '')
    .replace(/\s*(?:面议|\d+(?:\.\d+)?\s*[kK])\s*$/, '')
    .trim()
}
function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]·、,，.。/\\|—-]/g, '')
}
const normLoose = (s) => normKey(stripSalaryTail(s))
const isPlaceholder = (s) => {
  const t = String(s || '').trim()
  return !t || /^未知/.test(t)
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

const owners = [...new Set(list.map((a) => String(a.ownerId || '')))]
const plans = []
const skipped = []

for (const owner of owners) {
  const mine = list.filter((a) => String(a.ownerId || '') === owner)
  // 副线：有真公司名、没有 jobId —— 采集端从页面上采到的新记录
  const dups = mine.filter((a) => !isPlaceholder(a.company) && !String(a.jobId || '').trim())
  for (const dup of dups) {
    const t = normLoose(dup.jobTitle)
    if (!t) continue
    // 主线候选：同平台、公司名占位、有 jobId、剥薪资后标题相同
    const cands = mine.filter(
      (a) =>
        a !== dup &&
        isPlaceholder(a.company) &&
        String(a.jobId || '').trim() &&
        String(a.platform || '') === String(dup.platform || '') &&
        normLoose(a.jobTitle) === t
    )
    if (cands.length === 1) {
      plans.push({ keep: cands[0], drop: dup })
    } else if (cands.length > 1) {
      skipped.push({ dup, reason: `同名 ${cands.length} 条主线候选，认不出是哪条` })
    }
  }
}

const dropIds = new Set(plans.map((p) => p.drop.id))
// 同一条副线被计划合并两次（两条主线候选都唯一？不可能，上面已排除）→ 保险去重
const seenDrop = new Set()
const finalPlans = plans.filter((p) => {
  if (seenDrop.has(p.drop.id)) return false
  seenDrop.add(p.drop.id)
  return true
})

console.log(`数据文件：${FILE}`)
console.log(`总记录 ${list.length} 条｜可合并 ${finalPlans.length} 组｜跳过 ${skipped.length} 组\n`)

for (const p of finalPlans) {
  const k = p.keep
  const d = p.drop
  const fill = ['city', 'direction', 'readAt', 'repliedAt', 'withdrawnAt', 'chatStep', 'chatStepEvidence'].filter(
    (f) => !k[f] && d[f]
  )
  console.log(`· ${d.company} / ${d.jobTitle}`)
  console.log(`    保留：jobId=${k.jobId}｜${k.company}｜${k.jobTitle}｜投递 ${k.appliedAt || '(空)'}`)
  console.log(`    删掉：无 jobId｜投递 ${d.appliedAt || '(空)'}`)
  console.log(`    补进保留那条的字段：${fill.length ? fill.join(', ') : '(无可补)'}`)
}

if (skipped.length) {
  console.log(`\n⚠️ 跳过 ${skipped.length} 组（同名多条，认错会把别人的进度写上去）：`)
  for (const s of skipped) console.log(`  · ${s.dup.company} / ${s.dup.jobTitle} —— ${s.reason}`)
}

const restUnknown = list.filter(
  (a) => String(a.platform || '').includes('BOSS') && isPlaceholder(a.company) && !dropIds.has(a.id)
)
if (restUnknown.length) {
  console.log(`\nℹ️ 合并后仍有 ${restUnknown.length} 条 BOSS 记录没有公司名 ——`)
  console.log('   这些是页面上没采到公司名的那部分，需要再同步一次（或看「探测」输出断在哪层）。')
}

if (!write) {
  console.log(`\n（dry-run）要真合并请加 --write。将合并 ${finalPlans.length} 组。`)
  process.exit(0)
}
if (!finalPlans.length) {
  console.log('\n无需写入。')
  process.exit(0)
}

const patchById = new Map()
for (const p of finalPlans) {
  const k = { ...p.keep }
  const d = p.drop
  k.company = d.company
  // 标题保留主线那条（带薪资）：它是投递当时的原文，改动越小越容易核对
  for (const f of ['city', 'direction', 'readAt', 'repliedAt', 'withdrawnAt', 'chatStep', 'chatStepEvidence', 'chatStepHistory', 'awaitingReplyAt']) {
    if (!k[f] && d[f]) k[f] = d[f]
  }
  if (typeof d.awaitingReply === 'boolean' && typeof k.awaitingReply !== 'boolean') {
    k.awaitingReply = d.awaitingReply
  }
  if (!k.appliedAt && d.appliedAt) k.appliedAt = d.appliedAt
  k.updatedAt = new Date().toISOString()
  patchById.set(k.id, k)
}

const next = list.filter((a) => !dropIds.has(a.id)).map((a) => patchById.get(a.id) || a)

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const bak = `${FILE}.bak-merge-${stamp}`
copyFileSync(FILE, bak)
const tmp = `${FILE}.tmp-${stamp}`
writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
renameSync(tmp, FILE)

console.log(`\n✅ 合并 ${finalPlans.length} 组：${list.length} → ${next.length} 条`)
console.log(`   备份：${bak}`)
console.log('   提醒：扩展本地账本（chrome.storage 的 applied）里这些岗位仍是「未知公司」，')
console.log('   下次「补传账本」会按标题匹配到已有记录、不会重复建；公司名以服务端为准。')
