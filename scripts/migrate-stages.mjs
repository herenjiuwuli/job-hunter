/**
 * 老投递记录补 stage（漏斗口径）。一次性、幂等。
 *
 * 老数据只有人工 status，没有平台阶段。这里按 stageFromStatus 尽力反推一个，
 * 并标 source=migrated —— 之后采集器采到真实阶段时，权重更高就会覆盖它，
 * 所以这个「猜」不会长期留在数据里。
 *
 * 和 migrate-owner.mjs 一样的纪律：先算计划 → 有变更才备份 → 再落盘。
 * （踩过的坑：无条件备份会在「没什么可改」时白复制一份含个人数据的目录）
 *
 * 用法：
 *   node scripts/migrate-stages.mjs --dry-run
 *   node scripts/migrate-stages.mjs
 */
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { stageFromStatus, stageLabel } from '../server/lib/stages.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const dirArg = args.indexOf('--data')
const DATA_DIR = dirArg !== -1 ? resolve(args[dirArg + 1]) : resolve(process.cwd(), 'server', 'data')
const FILE = join(DATA_DIR, 'applications.json')

function log(s = '') {
  console.log(s)
}

if (!existsSync(FILE)) {
  log(`没有 ${FILE}，跳过（全新环境不需要迁移）。`)
  process.exit(0)
}

const list = JSON.parse(readFileSync(FILE, 'utf-8'))
if (!Array.isArray(list)) {
  console.error('applications.json 不是数组，不认识这个形状，请人工检查。')
  process.exit(1)
}

const now = new Date().toISOString()
let planned = 0
const skipped = []
const next = list.map((a) => {
  // 已有 stage 的不动（采集器写过的更可信）
  if (a.stage) return a
  const boot = stageFromStatus(a.status)
  if (!boot) {
    skipped.push(`${a.company || '(无公司)'} / ${a.status || '(无状态)'}`)
    return a
  }
  planned++
  return {
    ...a,
    stage: boot,
    stageUpdatedAt: a.updatedAt || now,
    stageHistory: Array.isArray(a.stageHistory) && a.stageHistory.length
      ? a.stageHistory
      : [{ stage: boot, source: 'migrated', raw: a.status || '', at: a.updatedAt || now }],
  }
})

log(`数据目录：${DATA_DIR}`)
log(`投递记录：${list.length} 条`)
log(`将补 stage：${planned} 条`)
if (skipped.length) log(`不猜（待投递/空）跳过：${skipped.length} 条`)

if (!planned) {
  log('')
  log('无需迁移。')
  process.exit(0)
}

if (dryRun) {
  const preview = next.filter((a, i) => !list[i].stage && a.stage).slice(0, 10)
  log('')
  log('预览（前 10 条）：')
  for (const a of preview) {
    log(`  ${String(a.company || '').padEnd(12)} ${String(a.status).padEnd(6)} → ${stageLabel(a.stage)}`)
  }
  log('')
  log('DRY RUN 结束，未写任何文件。')
  process.exit(0)
}

const stamp = now.replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
const backup = `${DATA_DIR}.bak-${stamp}`
mkdirSync(DATA_DIR, { recursive: true })
cpSync(DATA_DIR, backup, { recursive: true })
log(`备份：${backup}`)

writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf-8')
log('')
log(`完成：${planned} 条记录已补 stage。`)
