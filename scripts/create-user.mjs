#!/usr/bin/env node
/**
 * 账号运维脚本：建账号 / 重置密码 / 改角色 / 列出账号。
 *
 * 为什么要有它（而不是只在网页上注册）：
 *   1. 邀请制之后，注册必须要有邀请码。首个账号虽然能直接注册，但如果
 *      owner 忘了密码、或者想重置某人的口令，网页上没有任何入口 ——
 *      总不能把 users.json 手改一遍（口令是 scrypt 派生值，手改不了）。
 *   2. 测试也需要一条「不依赖邀请码就能建出账号」的正路。
 *      与其在注册接口里开一个「测试模式」后门（那是真后门，忘了关就是灾难），
 *      不如把这件事交给一个命令行工具：它本来就只有能登上这台机器的人才能跑。
 *
 * 用法：
 *   node scripts/create-user.mjs --username chen                  # 已存在则报错；密码自动生成并打印
 *   node scripts/create-user.mjs --username chen --reset           # 重置密码（旧的作废）
 *   node scripts/create-user.mjs --username chen --role owner      # 设为管理员
 *   node scripts/create-user.mjs --list                            # 列出所有账号
 *
 * 参数：
 *   --data <目录>   数据目录，默认 server/data（与后端 JOB_HUNTER_DATA_DIR 规则一致）
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from '../server/lib/auth.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { reset: false, list: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--reset') out.reset = true
    else if (a === '--list') out.list = true
    else if (a === '--username') out.username = argv[++i]
    else if (a === '--password') out.password = argv[++i]
    else if (a === '--role') out.role = argv[++i]
    else if (a === '--data') out.data = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || (!args.username && !args.list)) {
  console.log(
    [
      '用法：node scripts/create-user.mjs --username <账号> [选项]',
      '',
      '  --reset            账号已存在时重置密码（默认遇到重名直接报错退出）',
      '  --password <口令>  指定口令，至少 6 位；省略则随机生成并打印一次',
      '  --role <角色>      owner（管理员，能发邀请码）或 member（默认）',
      '  --list             列出所有账号，不做修改',
      '  --data <目录>      数据目录，默认 server/data',
      '',
      '例：node scripts/create-user.mjs --username chen --role owner --reset',
    ].join('\n')
  )
  process.exit(args.help ? 0 : 1)
}

const DATA_DIR = args.data
  ? resolve(args.data)
  : process.env.JOB_HUNTER_DATA_DIR
    ? resolve(process.env.JOB_HUNTER_DATA_DIR)
    : join(ROOT, 'server', 'data')

const USERS_FILE = join(DATA_DIR, 'users.json')

function readUsers() {
  if (!existsSync(USERS_FILE)) return []
  const raw = readFileSync(USERS_FILE, 'utf-8').trim()
  if (!raw) return []
  try {
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) throw new Error('users.json 不是数组')
    return data
  } catch (e) {
    // 宁可停下也不覆盖：这个文件一坏，所有人的登录就没了
    throw new Error(`${USERS_FILE} 内容异常（${e.message}）—— 先人工修复，本脚本不覆盖它`)
  }
}

function writeUsers(list) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8')
}

const log = (...a) => console.log(...a)

const users = readUsers()

if (args.list) {
  if (!users.length) {
    log('还没有任何账号。先跑一次后端（首个注册的账号会成为管理员），或用本脚本建一个。')
    process.exit(0)
  }
  log(`数据目录：${DATA_DIR}`)
  log('')
  log('账号'.padEnd(20) + '角色'.padEnd(10) + '创建时间')
  for (const u of users) {
    log(
      String(u.username).padEnd(20) +
        String(u.role || 'member').padEnd(10) +
        (u.createdAt ? new Date(u.createdAt).toLocaleString('zh-CN') : '-')
    )
  }
  process.exit(0)
}

const username = String(args.username || '').trim()
if (!username) {
  console.error('账号不能为空')
  process.exit(1)
}
if (username.length > 40) {
  console.error('账号太长（最多 40 个字符）')
  process.exit(1)
}

if (args.role && !['owner', 'member'].includes(args.role)) {
  console.error(`--role 只能是 owner 或 member，收到：${args.role}`)
  process.exit(1)
}

// 角色：显式指定优先；否则「第一个账号」自动当管理员，其余是普通成员
const role = args.role
  ? args.role === 'owner'
    ? 'owner'
    : 'member'
  : users.length === 0
    ? 'owner'
    : 'member'

// 口令：显式给了就用（校验长度），否则随机生成 —— 12 字节 base64url ≈ 16 个字符，够强
let password = args.password
let generated = false
if (!password) {
  password = randomBytes(12).toString('base64url')
  generated = true
}
if (password.length < 6) {
  console.error('口令至少 6 位')
  process.exit(1)
}

const idx = users.findIndex((u) => String(u.username || '').toLowerCase() === username.toLowerCase())

if (idx === -1) {
  const user = {
    id: `u_${randomUUID()}`,
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: new Date().toISOString(),
  }
  writeUsers([...users, user])
  log(`已创建账号 ${username}（角色 ${role}）`)
} else {
  if (!args.reset) {
    console.error(
      `账号 ${users[idx].username} 已存在。要重置密码请加 --reset，要改角色请加 --role owner 并配 --reset。`
    )
    process.exit(1)
  }
  const next = [...users]
  next[idx] = {
    ...users[idx],
    passwordHash: hashPassword(password),
    role: args.role ? role : users[idx].role || 'member',
    updatedAt: new Date().toISOString(),
  }
  writeUsers(next)
  log(`已重置账号 ${next[idx].username} 的密码（角色 ${next[idx].role}）`)
}

if (generated) {
  log('')
  log('⚠️  随机生成的口令（只显示这一次，请立刻记下）：')
  log(`    ${password}`)
  log('')
  log('   忘了也不要紧：本脚本加 --reset 可随时重置。')
}
