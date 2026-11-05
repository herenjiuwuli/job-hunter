#!/usr/bin/env node
/**
 * 修 2026-11-05 18:06 那次「补录把 10 条全建成新记录」的重复数据。
 *
 * 事故经过：
 *   聊天页采集到 10 条 → 用户点「补录这 N 条」→ 后端一次建了 10 条。
 *   但后端进程是 13:04 启动的**旧代码**（路由文件 17:38 才改），于是：
 *     · 没有「按岗位名兜底认人」→ 万兴/迪阿/正浩/TCL 这 4 条明明账本里有，全被当成新的
 *     · 没有「HR 主动找我（myMsgCount=0）不建记录」→ 珍岛也被建了
 *     · 没有 withdrawnAt → 惊叹/和智传信的「我放弃」丢了
 *
 * 这份脚本做正确的合并：该并的并、该删的删、该留的留。
 *   合并：把新记录上的 readAt 挪到老记录，公司名用**聊天页读到的**（更准），再删掉新记录
 *   删除：珍岛（HR 群发找我，不是我投的）
 *   保留：和智传信 / 炽光 / 惊叹 / 未来范式 / 知羽俊采（账本里本来就没有，确实是新投递）
 *
 * 用法：
 *   node scripts/fix-dup-collect.mjs                 # 预演，只打印
 *   node scripts/fix-dup-collect.mjs --write         # 真写（先备份）
 *   node scripts/fix-dup-collect.mjs --data <目录>   # 指定数据目录
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const dataIdx = args.indexOf('--data')
const DATA = dataIdx >= 0 ? resolve(args[dataIdx + 1]) : resolve('server/data')
const FILE = join(DATA, 'applications.json')

const normKey = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·、,，。()（）[\]【】/|]/g, '')
const normTitle = (s) => normKey(s).replace(/(实习招聘|校园招聘|社会招聘|长期招聘|招聘|急招|热招)$/, '')

// 这次被误建的 10 条（company 用聊天页读到的写法，title 用原样）
const CHAT10 = [
  ['和智传信', '社媒运营实习生（多平台 / 发布与维护）'],
  ['万兴科技', '用户运营实习'],
  ['珍岛集团', '27届校招-TOB软件销售-保底无责月薪7500'],
  ['迪阿股份有限公司', 'AI 工作流搭建实习生'],
  ['炽光时代', '用户运营实习生（双休/AI赛道）'],
  ['惊叹科技', '编导创意实习生（可转正）'],
  ['正浩创新', '【日常实习】数据运营实习生(A69277)'],
  ['TCL实业', 'HR-数据运营实习生'],
  ['未来范式', 'AI编剧实习生（海外短剧）'],
  ['知羽俊采', '新媒体运营实习生'],
]

// 账本里本来就有对应记录、需要「合并后删除」的 4 家
const MERGE_INTO_EXISTING = new Set(['万兴科技', '迪阿股份有限公司', '正浩创新', 'TCL实业'])
// HR 主动找我（一条消息都没发过），不该算投递
const DROP = new Set(['珍岛集团'])

if (!existsSync(FILE)) {
  console.error(`❌ 找不到 ${FILE}`)
  process.exit(1)
}

const raw = JSON.parse(readFileSync(FILE, 'utf8'))
const isArr = Array.isArray(raw)
const list = isArr ? raw : Object.values(raw)

const cut = '2026-11-05T10:0' // 误建那一批的 createdAt 前缀
const newOnes = list.filter((x) => String(x.createdAt || '').startsWith(cut))
console.log(`账本共 ${list.length} 条；本次误建（createdAt ${cut}*）${newOnes.length} 条\n`)

if (!newOnes.length) {
  console.log('没有要处理的记录（可能已经修过了）。')
  process.exit(0)
}

const dropIds = new Set()
const report = []

for (const [company, jobTitle] of CHAT10) {
  const hit = newOnes.find((x) => normTitle(x.company + '') === normTitle(company) && normTitle(x.jobTitle) === normTitle(jobTitle))
  if (!hit) {
    report.push({ company, action: '⚠️ 没找到这条新记录，跳过', from: '-', to: '-' })
    continue
  }
  if (DROP.has(company)) {
    dropIds.add(hit.id)
    report.push({ company, action: '删除（HR 主动找我，不算投递）', from: hit.company, to: '-' })
    continue
  }
  if (MERGE_INTO_EXISTING.has(company)) {
    // 在「老记录」里按岗位名找唯一一条（排除本次误建的）
    const cands = list.filter(
      (x) => x.id !== hit.id && !String(x.createdAt || '').startsWith(cut) && normTitle(x.jobTitle) === normTitle(jobTitle)
    )
    if (cands.length !== 1) {
      report.push({ company, action: `❌ 老记录命中 ${cands.length} 条（要唯一），跳过不删`, from: hit.company, to: '-' })
      continue
    }
    const old = cands[0]
    const patch = []
    if (hit.readAt && !old.readAt) {
      old.readAt = hit.readAt
      patch.push('readAt')
    }
    if (normKey(old.company) !== normKey(hit.company)) {
      patch.push(`公司 ${old.company} → ${hit.company}`)
      old.company = hit.company
    }
    if (hit.withdrawnAt && !old.withdrawnAt) {
      old.withdrawnAt = hit.withdrawnAt
      patch.push('withdrawnAt')
    }
    old.updatedAt = new Date().toISOString()
    dropIds.add(hit.id)
    report.push({
      company,
      action: `合并后删除${patch.length ? `（${patch.join('、')}）` : '（无字段需要搬）'}`,
      from: hit.company,
      to: old.company,
    })
    continue
  }
  report.push({ company, action: '保留（账本里本来就没有这条投递）', from: hit.company, to: hit.company })
}

console.log('公司'.padEnd(16), '处置')
console.log('─'.repeat(78))
for (const r of report) {
  console.log(r.company.padEnd(16), r.action)
}

const after = list.filter((x) => !dropIds.has(x.id))
console.log(`\n条数：${list.length} → ${after.length}（删 ${dropIds.size} 条）`)
const boss = after.filter((x) => x.platform === 'BOSS直聘')
console.log(
  `BOSS ${boss.length} 条 | readAt ${boss.filter((x) => x.readAt).length} | repliedAt ${
    boss.filter((x) => x.repliedAt).length
  } | withdrawnAt ${boss.filter((x) => x.withdrawnAt).length}`
)

if (!WRITE) {
  console.log('\n（预演）确认无误后加 --write 真写。')
  process.exit(0)
}

const bak = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
copyFileSync(FILE, bak)
console.log(`\n已备份 → ${bak}`)

const out = isArr ? after : Object.fromEntries(Object.entries(raw).filter(([, v]) => !dropIds.has(v.id)))
writeFileSync(FILE, JSON.stringify(out, null, 2))
console.log(`已写入 ${FILE}`)
