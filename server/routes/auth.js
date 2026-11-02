import { Router } from 'express'
import { updateJSON } from '../lib/store.js'
import {
  createUser,
  findUserByName,
  findUserById,
  verifyPassword,
  hashPassword,
  signToken,
  publicUser,
  requireAuth,
  isLocked,
  recordFail,
  clearFail,
} from '../lib/auth.js'

const router = Router()

/**
 * 一个固定「假口令哈希」：用来在「用户不存在」时也照样跑一遍 scrypt。
 *
 * 不这么做的话，「用户不存在」会在 1ms 内返回、「密码错」要 50ms 才返回，
 * 响应时间差本身就把「这个账号注册过没有」告诉了攻击者。
 */
const DUMMY_HASH = hashPassword('dummy-password-for-timing-equalization')

// 注册
router.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {}
  try {
    const user = await createUser({ username, password })
    res.json({ token: signToken(user.id), user: publicUser(user) })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '注册失败' })
  }
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

export default router
