import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, readJSON, updateJSON } from './store.js'

/**
 * 账号与登录。
 *
 * 为什么自己写 JWT 而不是装 jsonwebtoken：
 *   只需要 HS256 一种算法，node 的 createHmac 十行就够；少一个依赖，
 *   也少一次「依赖被投毒 / 版本冲突」的风险。代价是必须自己盯住下面这些点：
 *   - 必须校验签名（用 timingSafeEqual，不能用 ===，否则可被时序攻击逐字节爆破）
 *   - 必须校验 exp（否则 token 永久有效）
 *   - 密钥不能进 git（存 DATA_DIR/.jwt-secret，运行时数据目录已整体 gitignore）
 *
 * 口令用 scrypt 而不是 sha256：
 *   sha256 太快，GPU 每秒能算几十亿次，撞库极快；scrypt 故意吃内存和 CPU，
 *   单次约 16MB/几十毫秒，暴力破解成本高几个数量级。
 */

// ---------- 口令 ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

/** 生成 `scrypt$N$r$p$salt$hash` 格式的存储串（Base64URL，避免 `$`/`/` 之类分隔符冲突） */
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$')
}

/** 校验口令。任何解析异常一律当失败，不要抛出（避免 500 泄露内部结构） */
export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored || '').split('$')
    if (alg !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64url')
    const expect = Buffer.from(hashB64, 'base64url')
    const got = scryptSync(String(password), salt, expect.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    })
    return got.length === expect.length && timingSafeEqual(got, expect)
  } catch {
    return false
  }
}

// ---------- token ----------

const TOKEN_TTL_SEC = 7 * 24 * 3600 // 7 天：个人工具，太长不安全、太短天天重登

let cachedSecret = null

/**
 * 签名密钥：优先环境变量 JWT_SECRET（部署时用），否则自动生成并落到数据目录。
 * 落在数据目录而不是代码目录，是因为 server/data/ 已整体 gitignore —— 密钥不会被误提交。
 */
export function getSecret() {
  if (cachedSecret) return cachedSecret
  if (process.env.JWT_SECRET) {
    cachedSecret = process.env.JWT_SECRET
    return cachedSecret
  }
  const file = join(DATA_DIR, '.jwt-secret')
  if (existsSync(file)) {
    const s = readFileSync(file, 'utf-8').trim()
    if (s) {
      cachedSecret = s
      return cachedSecret
    }
  }
  mkdirSync(DATA_DIR, { recursive: true })
  cachedSecret = randomBytes(32).toString('hex')
  writeFileSync(file, cachedSecret, { mode: 0o600 })
  return cachedSecret
}

const b64u = (v) => Buffer.from(v).toString('base64url')

export function signToken(userId, ttlSec = TOKEN_TTL_SEC) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64u(JSON.stringify({ sub: userId, iat: now, exp: now + ttlSec }))
  const data = `${header}.${payload}`
  const sig = createHmac('sha256', getSecret()).update(data).digest('base64url')
  return `${data}.${sig}`
}

/** 校验 token，成功返回 payload（含 sub/iat/exp），失败返回 null */
export function verifyToken(token) {
  try {
    const parts = String(token || '').split('.')
    if (parts.length !== 3) return null
    const [header, payload, sig] = parts
    const expect = createHmac('sha256', getSecret()).update(`${header}.${payload}`).digest('base64url')
    const a = Buffer.from(sig)
    const b = Buffer.from(expect)
    // 长度不同时 timingSafeEqual 会抛异常，所以先比长度
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
    if (!claims.sub) return null
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/**
 * 鉴权中间件：挂在所有 /api 数据路由之前。
 * 之后的路由可以放心假设 req.userId 一定存在 —— 没登录的请求永远到不了。
 */
export function requireAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')
  const claims = m ? verifyToken(m[1]) : null
  if (!claims) return res.status(401).json({ error: '未登录或登录已过期' })
  req.userId = claims.sub
  next()
}

// ---------- 用户存储 ----------

const USERS_KEY = 'users'

export const normalizeUsername = (u) => String(u || '').trim()

/** 大小写不敏感查询（避免 Chen / chen 被当成两个账号） */
export async function findUserByName(username) {
  const name = normalizeUsername(username).toLowerCase()
  const users = (await readJSON(USERS_KEY)) || []
  return users.find((u) => String(u.username || '').toLowerCase() === name) || null
}

export async function findUserById(id) {
  const users = (await readJSON(USERS_KEY)) || []
  return users.find((u) => u.id === id) || null
}

/**
 * 创建用户。用户名唯一（大小写不敏感），口令只存 scrypt 派生值。
 * 读-改-写整段放在 updateJSON 的锁里，否则并发注册会互相覆盖。
 */
export async function createUser({ username, password }) {
  const name = normalizeUsername(username)
  if (!name) throw Object.assign(new Error('用户名不能为空'), { status: 400 })
  if (String(password || '').length < 6) {
    throw Object.assign(new Error('密码至少 6 位'), { status: 400 })
  }
  let created = null
  const next = await updateJSON(
    USERS_KEY,
    (list) => {
      const lower = name.toLowerCase()
      if (list.some((u) => String(u.username || '').toLowerCase() === lower)) return undefined
      created = {
        id: `u_${randomUUID()}`,
        username: name,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      }
      return [...list, created]
    },
    []
  )
  if (!next) throw Object.assign(new Error('用户名已存在'), { status: 409 })
  return created
}

export function publicUser(u) {
  return u ? { id: u.id, username: u.username } : null
}

// ---------- 登录失败限速 ----------

/**
 * 内存计数限速：同一「用户名 + IP」连续失败 5 次，锁 10 分钟。
 * 进程重启即清零（够用：这不是抗分布式爆破，只是挡住脚本无脑撞库）。
 * 存内存而不是落盘，是因为落盘反而给攻击者一个「写文件」的入口。
 */
const FAIL_LIMIT = 5
const FAIL_WINDOW_MS = 10 * 60 * 1000
const fails = new Map()

const failKey = (username, ip) => `${String(username || '').toLowerCase()}|${ip || ''}`

export function isLocked(username, ip) {
  const rec = fails.get(failKey(username, ip))
  if (!rec) return false
  if (Date.now() > rec.until) {
    fails.delete(failKey(username, ip))
    return false
  }
  return rec.count >= FAIL_LIMIT
}

export function recordFail(username, ip) {
  const k = failKey(username, ip)
  const rec = fails.get(k) || { count: 0, until: 0 }
  rec.count += 1
  rec.until = Date.now() + FAIL_WINDOW_MS
  fails.set(k, rec)
}

export function clearFail(username, ip) {
  fails.delete(failKey(username, ip))
}
