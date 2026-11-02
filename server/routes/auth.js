import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import {
  createUser,
  findUserByName,
  findUserById,
  countUsers,
  verifyPassword,
  hashPassword,
  signToken,
  publicUser,
  requireAuth,
  requireOwner,
  withRegisterLock,
  isLocked,
  recordFail,
  clearFail,
} from '../lib/auth.js'
import {
  checkInvite,
  consumeInvite,
  createInvite,
  listInvites,
  normalizeInvite,
  releaseInvite,
  revokeInvite,
  maskCode,
} from '../lib/invites.js'

const router = Router()

/**
 * 一个固定「假口令哈希」：用来在「用户不存在」时也照样跑一遍 scrypt。
 *
 * 不这么做的话，「用户不存在」会在 1ms 内返回、「密码错」要 50ms 才返回，
 * 响应时间差本身就把「这个账号注册过没有」告诉了攻击者。
 */
const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalization')

/**
 * 注册（邀请制）。
 *
 * 两条合法的路，别的地方都进不来：
 *   1. 系统里一个账号都没有 → 允许直接注册，并成为 owner（否则新部署永远进不去）。
 *      这个口子只在 users 表为空时存在，注册锁内判定，并发注册也只会成功第一个。
 *   2. 已有账号 → 必须带一个有效的、未使用的、未过期的邀请码。
 *
 * 为什么邀请码不写在 URL 里让用户点链接注册：链接会被转发、被聊天记录留存，
 * 而一次性码贴在 URL 上就意味着「谁先点谁进」。邀请码只在注册表单里手输/粘贴。
 */
router.post('/api/auth/register', async (req, res) => {
  const { username, password, inviteCode } = req.body || {}
  try {
    const result = await withRegisterLock(async () => {
      const total = await countUsers()

      // 路径 1：全新部署的首个账号
      if (total === 0) {
        const user = await createUser({ username, password, role: 'owner' })
        return { user, bootstrap: true }
      }

      // 路径 2：邀请制
      if (!inviteCode) {
        throw Object.assign(new Error('本站为邀请制，需要邀请码才能注册'), { status: 403 })
      }

      // 先占码再建账号：中途失败的代价是白费一个码，而不是「码还能复用」
      const uid = `u_${randomUUID()}`
      const name = String(username || '').trim()
      const taken = await consumeInvite(inviteCode, uid, name)
      if (!taken.ok) {
        console.warn(`[auth] 注册被拒（邀请码 ${maskCode(inviteCode)}）`)
        throw Object.assign(new Error(taken.reason), { status: 403 })
      }

      try {
        const user = await createUser({ id: uid, username, password, role: 'member' })
        return { user, bootstrap: false }
      } catch (e) {
        // 账号没建成（用户名重复 / 密码太短），把码退回去，别让用户白丢一个
        await releaseInvite(inviteCode, uid)
        throw e
      }
    })

    res.json({ token: signToken(result.user.id), user: publicUser(result.user), bootstrap: result.bootstrap })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '注册失败' })
  }
})

// 邀请码是否可用（注册页边输边提示用，公开接口，不消耗码）
// 码有 60 bit 熵，暴力试码不现实；而且这里只回 usable 布尔，不泄露码是否存在以外的信息。
router.get('/api/auth/invite/:code', async (req, res) => {
  const { usable } = await checkInvite(req.params.code)
  res.json({ usable })
})

// 登录
router.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {}
  const ip = req.ip || ''

  if (isLocked(username, ip)) {
    return res.status(429).json({ error: '失败次数过多，请 10 分钟后再试' })
  }

  const user = await findUserByName(username)
  const ok = verifyPassword(password, user ? user.passwordHash : DUMMY_HASH)

  if (!user || !ok) {
    recordFail(username, ip)
    // 用户不存在 / 口令错误给同一句话：不泄露账号是否存在
    return res.status(401).json({ error: '用户名或密码错误' })
  }

  clearFail(username, ip)
  res.json({ token: signToken(user.id), user: publicUser(user) })
})

// 当前身份：前端启动时用它校验本地 token 还有没有效
router.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = await findUserById(req.userId)
  if (!user) return res.status(401).json({ error: '账号已不存在' })
  res.json(publicUser(user))
})

// 改密码：迁移脚本生成的是随机口令，必须给一条能自己改的路
router.put('/api/auth/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  const user = await findUserById(req.userId)
  if (!user) return res.status(401).json({ error: '账号已不存在' })
  if (!verifyPassword(oldPassword, user.passwordHash)) {
    return res.status(401).json({ error: '原密码错误' })
  }
  if (String(newPassword || '').length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' })
  }

  // 只改自己这一条，锁在 users 表上，避免并发注册时整表覆盖
  await updateJSON(
    'users',
    (list) =>
      list.map((u) =>
        u.id === user.id
          ? { ...u, passwordHash: hashPassword(newPassword), updatedAt: new Date().toISOString() }
          : u
      ),
    []
  )
  res.json({ ok: true })
})

// ---------- 邀请码管理（仅 owner）----------
// 注意路由顺序：'invite/:code' 是公开的单码校验（上面），'invites' 是管理接口，
// 两者路径不同，不冲突；但别把 invites 写成 invite，否则会吃掉上面的校验路由。

router.get('/api/auth/invites', requireAuth, requireOwner, async (_req, res) => {
  res.json(await listInvites())
})

router.post('/api/auth/invites', requireAuth, requireOwner, async (req, res) => {
  const { note, ttlDays } = req.body || {}
  const inv = await createInvite({ createdBy: req.userId, note, ttlDays })
  res.json(normalizeInvite(inv))
})

router.delete('/api/auth/invites/:code', requireAuth, requireOwner, async (req, res) => {
  // 已使用的码会被拒绝删除：它是「谁邀请了谁」的唯一凭证
  const r = await revokeInvite(req.params.code)
  if (!r.ok) return res.status(400).json({ error: r.reason })
  res.json({ ok: true })
})

export default router
