#!/usr/bin/env node
/**
 * 单人数据 → 多用户数据的迁移脚本。
 *
 * 为什么需要它：
 *   老版本所有数据都没有 ownerId，加了鉴权之后「这条记录是谁的」无从判断。
 *   如果直接把缺 ownerId 的记录当「公共数据」显示，等于每个人都看得到全部；
 *   如果当「不属于任何人」丢弃，主人的历史数据就凭空消失。
 *   唯一正确的做法是迁移：把老数据显式划给一个已有账号。
 *
 * 处理四个文件（jobs.json 是岗位知识库，共享资产，不迁移）：
 *   - resumes.json / applications.json / records.json：数组，每条补 ownerId
 *   - profile.json：**不是数组**，是单个对象 → 变形为 { [ownerId]: profile }
 *     （加字段解决不了：一个人一个对象，两个用户必然互相覆盖）
 *   - users.json：没有就建，有就复用（保证 ownerId 指向真实存在的账号）
 *
 * 三个安全设计：
 *   1. 先整目录备份到 server/data.bak-<时间戳>，迁移失败可直接拷回
 *   2. 幂等：已经有 ownerId 的记录一律不动，重复跑结果不变
 *   3. --dry-run 只报告要改什么，不落盘
 *
 * 用法：
 *   node scripts/migrate-owner.mjs --username chen                 # 交互式提示输密码
 *   node scripts/migrate-owner.mjs --username chen --password xxx  # 非交互（注意 shell 历史留痕）
 *   node scripts/migrate-owner.mjs --username chen --dry-run
 */
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { hashPassword } from '../server/lib/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------- 参数 ----------

function parseArgs(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--username') out.username = argv[++i]
    else if (a === '--password') out.password = argv[++i]
    else if (a === '--data') out.data = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

// ---------- 路径 ----------

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      '用法：node scripts/migrate-owner.mjs --username <账号> [--password <密码>] [--data <目录>] [--dry-run]',
      '',
      '  --username  要归属老数据的账号（不存在会自动创建）',
      '  --password  口令，至少 6 位；省略则自动生成并打印一次',
      '  --data      数据目录，默认 server/data（与后端 JOB_HUNTER_DATA_DIR 一致的规则）',
      '  --dry-run   只报告，不写任何文件',
    ].join('\n')
  )
  process.exit(0)
}

if (!args.username) {
  console.error('缺少 --username。用 --help 看用法。')
  process.exit(1)
}

const DATA_DIR = args.data
  ? resolve(args.data)
  : process.env.JOB_HUNTER_DATA_DIR
    ? resolve(process.env.JOB_HUNTER_DATA_DIR)
    : join(ROOT, 'server', 'data')

const ARRAY_KEYS = ['resumes', 'applications', 'records']
const PROFILE_KEY = 'profile'
const USERS_KEY = 'users'

// ---------- 小工具 ----------

const readJson = (key) => {
  const p = join(DATA_DIR, `${key}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    throw new Error(`${p} 不是合法 JSON（${e.message}）——先修好再迁移，不要拿坏数据赌`)
  }
}

const writeJson = (key, value) => {
  const p = join(DATA_DIR, `${key}.json`)
  writeFileSync(p, JSON.stringify(value, null, 2), 'utf-8')
  return p
}

const log = (...a) => console.log(...a)

async function askPassword() {
  if (args.password) return args.password
  // 非交互环境（CI / 管道）直接生成，避免卡死在等输入
  if (!process.stdin.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const pw = await rl.question(`为账号 ${args.username} 设置密码（至少 6 位）：`)
  rl.close()
  return pw
}

// ---------- 主流程 ----------

async function main() {
  if (!existsSync(DATA_DIR)) {
    console.error(`数据目录不存在：${DATA_DIR}`)
    process.exit(1)
  }

  log(`数据目录：${DATA_DIR}`)
  log(`模式：${args.dryRun ? 'DRY RUN（不写任何文件）' : '实际写入'}`)
  log('')

  // 1) 账号
  const users = readJson(USERS_KEY) || []
  const lower = String(args.username).trim().toLowerCase()
  let user = users.find((u) => String(u.username || '').toLowerCase() === lower)
  let generatedPassword = null

  if (user) {
    log(`账号：已存在 ${user.username}  (${user.id})`)
  } else {
    let pw = await askPassword()
    if (!pw) {
      pw = randomBytes(9).toString('base64url') // 12 字符
      generatedPassword = pw
    }
    if (String(pw).length < 6) {
      console.error('密码至少 6 位。')
      process.exit(1)
    }
    user = {
      id: `u_${randomUUID()}`,
      username: String(args.username).trim(),
      passwordHash: hashPassword(pw),
      createdAt: new Date().toISOString(),
    }
    // 这里只构造对象、不落盘 —— 落盘统一放在「备份之后」，保证备份覆盖到全部变更
    log(`账号：新建 ${user.username}  (${user.id})`)
  }

  const ownerId = user.id

  // 2) 先算计划：这一阶段只读不写，避免「没东西可改却先备份一份个人数据」
  const plans = []
  let totalStamped = 0
  for (const key of ARRAY_KEYS) {
    const list = readJson(key)
    if (!Array.isArray(list)) {
      log(`${key.padEnd(13)} 不存在或不是数组，跳过`)
      continue
    }
    let stamped = 0
    let already = 0
    let foreign = 0
    const next = list.map((item) => {
      if (item.ownerId === ownerId) {
        already++
        return item
      }
      if (item.ownerId) {
        foreign++ // 别人的数据：不抢
        return item
      }
      stamped++
      return { ...item, ownerId }
    })
    totalStamped += stamped
    if (stamped > 0) plans.push({ key, next })
    log(
      `${key.padEnd(13)} 共 ${list.length} 条：补 ownerId ${stamped}｜已是本人 ${already}` +
        (foreign ? `｜属于他人 ${foreign}` : '')
    )
  }

  // 3) profile：单对象 → { ownerId: 对象 }
  const profile = readJson(PROFILE_KEY)
  if (profile === null) {
    log(`${'profile'.padEnd(13)} 不存在，跳过`)
  } else if (Array.isArray(profile)) {
    log(`${'profile'.padEnd(13)} ⚠️ 是数组（预期为对象），不认识这个形状，请人工检查`)
  } else if (profile.basic && !Object.prototype.hasOwnProperty.call(profile, ownerId)) {
    // 旧格式：顶层就是画像本身（总能见到 basic 字段，因为 PUT 会与默认模板合并）
    plans.push({ key: PROFILE_KEY, next: { [ownerId]: profile } })
    log(`${'profile'.padEnd(13)} 旧格式（单对象）→ 将包装为 { ${ownerId}: ... }`)
  } else if (Object.prototype.hasOwnProperty.call(profile, ownerId)) {
    log(`${'profile'.padEnd(13)} 已是多用户格式且含本人画像，跳过`)
  } else {
    // 已经是 map 但没有本人的槽位：补一个空槽交给 PUT 时初始化
    plans.push({ key: PROFILE_KEY, next: { ...profile, [ownerId]: {} } })
    log(`${'profile'.padEnd(13)} 多用户格式，将补本人空槽位`)
  }

  const userIsNew = !existsSync(join(DATA_DIR, `${USERS_KEY}.json`)) || !users.some((u) => u.id === ownerId)
  const willWrite = plans.length > 0 || userIsNew

  // 4) 有变更才备份（先备份后写，任何中间失败都能整体拷回）
  if (!args.dryRun && willWrite) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-')
    const backup = `${DATA_DIR}.bak-${stamp}`
    cpSync(DATA_DIR, backup, { recursive: true })
    log(`备份：${backup}`)
  }
  log('')

  // 5) 落盘
  if (!args.dryRun) {
    if (userIsNew) {
      mkdirSync(DATA_DIR, { recursive: true })
      writeJson(USERS_KEY, [...users, user])
    }
    for (const p of plans) writeJson(p.key, p.next)
  }

  log('')
  if (args.dryRun) {
    log(`DRY RUN 结束：将补 ${totalStamped} 条 ownerId，未写任何文件。`)
  } else if (!willWrite) {
    log('无需迁移：数据已是多用户格式。')
  } else {
    log(`完成：补 ${totalStamped} 条 ownerId。账号 ${user.username} 现在能看到全部历史数据。`)
  }
  if (generatedPassword && !args.dryRun) {
    log('')
    log('⚠️  自动生成的密码（只显示这一次，请立刻记下）：')
    log(`    ${generatedPassword}`)
  }
}

main().catch((e) => {
  console.error('迁移失败：', e.message)
  process.exit(1)
})
