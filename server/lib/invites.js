import { randomBytes, randomUUID } from 'node:crypto'
import { readJSON, updateJSON } from './store.js'

/**
 * 邀请码：控制「谁能注册」。
 *
 * 为什么不是「注册后等审核」或「邮箱验证」：
 *   个人工具，没有邮件服务、也不想维护待审队列。邀请码是成本最低、
 *   攻击面最小的做法 —— 没有有效码就注册不了，一句话说清。
 *
 * 码的设计：
 *   - 12 位、32 个字符的字母表（去掉 I/O/0/1 这些看错就废的字符），
 *     随机源是 crypto.randomBytes，熵 = 12 × log2(32) = 60 bit。
 *     硬猜要 2^60 次，配合注册接口的失败限速，等于不可行。
 *   - 展示时按 4 位分组（ABCD-EFGH-JKLM）方便口头/微信转达；
 *     比对前统一归一化（去分隔符 + 转大写），用户手抄错了分隔符也能进。
 *   - 一次性：用过就打上 usedBy/usedAt，不能复用。要给别人再生成一个。
 *
 * 为什么「校验码 + 建账号 + 占码」必须串行（见 auth.js 的 withRegisterLock）：
 *   三者分属 invites / users 两张表，store.js 的锁是「每个 key 一把」，
 *   跨表拿不到共同锁。两个请求同时拿同一个码，各自都通过校验，
 *   就会建出两个账号而码只该用一次。用一个进程内注册锁把它们串起来。
 */

const KEY = 'invites'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 个字符，无 I O 0 1
const CODE_LEN = 12
export const DEFAULT_TTL_DAYS = 7
export const MAX_TTL_DAYS = 90

const DAY_MS = 24 * 3600 * 1000

/** 生成一个新的邀请码（纯随机，不带业务含义） */
export function generateCode() {
  const bytes = randomBytes(CODE_LEN)
  let out = ''
  // 256 % 32 === 0，所以直接取模没有偏差（不会偏爱前几个字符）
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

/** 归一化：去分隔符/空白，转大写。存库与比对都用归一化后的形式 */
export function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/** 展示形式：ABCD-EFGH-JKLM */
export function formatCode(code) {
  const c = normalizeCode(code)
  return c.replace(/(.{4})/g, '$1-').replace(/-$/, '')
}

/**
 * 粗筛：形状不对的码直接判无效，不去查表。
 * 这一步挡的是「脚本拿 'test' / 'aaaa' 之类乱撞」，避免每次请求都读一遍 invites.json。
 */
export function looksLikeCode(raw) {
  const c = normalizeCode(raw)
  if (c.length !== CODE_LEN) return false
  for (const ch of c) if (!ALPHABET.includes(ch)) return false
  return true
}

function expiresAt(createdAtMs, ttlDays) {
  const days = Math.min(MAX_TTL_DAYS, Math.max(1, Number(ttlDays) || DEFAULT_TTL_DAYS))
  return new Date(createdAtMs + days * DAY_MS).toISOString()
}

/**
 * 码的状态：unused / used / expired。
 * 只用一个函数判定，避免各处各写一遍「过期了吗」而出现口径不一致
 * （比如列表显示「可用」、注册时却拒绝）。
 */
export function statusOf(invite, now = Date.now()) {
  if (!invite) return 'invalid'
  if (invite.usedBy) return 'used'
  if (Date.parse(invite.expiresAt || 0) <= now) return 'expired'
  return 'unused'
}

/** 对外统一的拒绝文案。为什么不区分「不存在 / 已用 / 过期」：码本身就是秘密，多说一个字都是提示 */
export const INVITE_REJECT = '邀请码无效、已过期或已被使用'

export function normalizeInvite(invite) {
  return {
    code: formatCode(invite.code),
    note: invite.note || '',
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    status: statusOf(invite),
    usedBy: invite.usedBy ? invite.usedByUsername || invite.usedBy : null,
    usedAt: invite.usedAt || null,
  }
}

/** 生成邀请码。同一把锁内查重，避免极小概率的撞码 */
export async function createInvite({ createdBy, note = '', ttlDays = DEFAULT_TTL_DAYS } = {}) {
  const now = Date.now()
  let created = null
  await updateJSON(
    KEY,
    (list) => {
      const used = new Set(list.map((i) => i.code))
      let code = generateCode()
      while (used.has(code)) code = generateCode()
      created = {
        id: `iv_${randomUUID()}`,
        code,
        note: String(note || '').slice(0, 60),
        createdBy,
        createdAt: new Date(now).toISOString(),
        expiresAt: expiresAt(now, ttlDays),
        usedBy: null,
        usedAt: null,
      }
      return [...list, created]
    },
    []
  )
  return created
}

/** 列表：可用在前，其次按创建时间倒序（最常用的码排最上面） */
export async function listInvites() {
  const list = (await updateJSON(KEY, (cur) => cur, [])) || []
  const order = { unused: 0, used: 1, expired: 2 }
  return [...list]
    .sort((a, b) => {
      const d = (order[statusOf(a)] ?? 9) - (order[statusOf(b)] ?? 9)
      if (d !== 0) return d
      return new Date(b.createdAt) - new Date(a.createdAt)
    })
    .map(normalizeInvite)
}

/** 只读查一个码（注册页「检查邀请码」用；不占用） */
export async function peekInvite(rawCode) {
  if (!looksLikeCode(rawCode)) return null
  const code = normalizeCode(rawCode)
  const list = (await updateJSON(KEY, (cur) => cur, [])) || []
  return list.find((i) => i.code === code) || null
}

/** 只判断能不能用，给公开校验接口用 */
export async function checkInvite(rawCode) {
  const inv = await peekInvite(rawCode)
  const status = statusOf(inv)
  return { usable: status === 'unused', status }
}

/**
 * 占用邀请码：校验 + 打标记，在 invites 这一把锁内完成。
 * 调用方必须已经持有注册锁（见 auth.js），否则「先校验再建用户」之间会插进另一个请求。
 */
export async function consumeInvite(rawCode, userId, userName) {
  if (!looksLikeCode(rawCode)) return { ok: false, reason: INVITE_REJECT }
  const code = normalizeCode(rawCode)
  let failure = null
  let done = null
  await updateJSON(
    KEY,
    (list) => {
      const idx = list.findIndex((i) => i.code === code)
      if (idx === -1) {
        failure = INVITE_REJECT
        return undefined
      }
      const status = statusOf(list[idx])
      if (status !== 'unused') {
        failure = INVITE_REJECT
        return undefined
      }
      const next = [...list]
      next[idx] = {
        ...list[idx],
        usedBy: userId,
        usedByUsername: userName,
        usedAt: new Date().toISOString(),
      }
      done = next[idx]
      return next
    },
    []
  )
  if (failure) return { ok: false, reason: failure }
  if (!done) return { ok: false, reason: INVITE_REJECT }
  return { ok: true, invite: done }
}

/**
 * 撤销：直接把这条记录删掉。
 * 已使用的码不允许删 —— 它会作为「谁邀请谁进来的」凭证留在列表里，
 * 删了就查不出来某个账号是从哪来的。
 */
export async function revokeInvite(rawCode) {
  if (!looksLikeCode(rawCode)) return { ok: false, reason: INVITE_REJECT }
  const code = normalizeCode(rawCode)
  let failure = null
  await updateJSON(
    KEY,
    (list) => {
      const target = list.find((i) => i.code === code)
      if (!target) {
        failure = INVITE_REJECT
        return undefined
      }
      if (target.usedBy) {
        failure = '该邀请码已被使用，不能撤销'
        return undefined
      }
      return list.filter((i) => i.code !== code)
    },
    []
  )
  if (failure) return { ok: false, reason: failure }
  return { ok: true }
}

/**
 * 释放邀请码：只在「已经占码、但建账号失败」这一条路径上调用。
 *
 * 为什么不换顺序（先建账号再占码）：那样中途崩溃会留下「账号建好了、码还能用」，
 * 一个码可能建出多个账号；而先占码后崩溃只是白费一个码，owner 再发一个就行。
 * 两种失败模式里，选代价小的那个。
 */
export async function releaseInvite(rawCode, userId) {
  const code = normalizeCode(rawCode)
  if (!code) return
  await updateJSON(
    KEY,
    (list) => {
      const idx = list.findIndex((i) => i.code === code)
      // 只释放「自己刚占的那一个」，别把别人后来正常用掉的码给退了
      if (idx === -1 || list[idx].usedBy !== userId) return undefined
      const next = [...list]
      next[idx] = { ...list[idx], usedBy: null, usedByUsername: null, usedAt: null }
      return next
    },
    []
  )
}

/** 给错误日志用（不含完整码，避免日志泄露） */
export function maskCode(rawCode) {
  const c = normalizeCode(rawCode)
  return c ? `${c.slice(0, 2)}***${c.slice(-2)}` : '-'
}
