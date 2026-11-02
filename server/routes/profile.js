import { Router } from 'express'
import { readProfileOf, updateProfileOf } from '../lib/scope.js'

/**
 * 候选人画像：求职过程中的「不可猜测事实」唯一真相源。
 * 与简历库（resumes）不同——简历是「怎么写」，画像是「这些事 AI 不能瞎编」。
 * 借用 applypilot 的 candidate_profile 模板，精简到中文求职场景。
 * 存 server/data/profile.json（已 gitignore，敏感数据不进公开仓库）。
 * 多用户后文件形状是 { [ownerId]: 画像 }，读写一律走 lib/scope.js。
 */
const router = Router()

const DEFAULT_PROFILE = {
  basic: {
    name: '',
    email: '',
    phone: '',
    location: '',
    linkedin: '',
    portfolio: '',
    github: '',
  },
  currentStatus: {
    currentRole: '',
    employmentStatus: '',
    availableStart: '',
  },
  workAuthorization: {
    country: '中国',
    currentAuthorization: '',
    requiresSponsorship: '',
  },
  targets: {
    primaryRoles: [],      // 想投的岗位
    rolesToAvoid: [],      // 不想投的岗位
    targetLocations: [],   // 目标城市
    remotePreference: '',  // 远程/混合/现场/不限
  },
  compensation: {
    baseRange: '',
    totalRange: '',
    answerStrategy: '优先延后回答；无法延后时给出区间',
  },
  resumeMapping: [],       // [{ roleFamily, resumeId, useWhen }] 关联简历库
  selfIdentification: {
    strategy: 'prefer_not_to_say', // prefer_not_to_say / decline / leave_blank
    notes: '',
  },
  neverGuess: [
    'legal name', 'work authorization', 'sponsorship', 'employment status',
    'salary expectations', 'relocation', 'degree dates', 'employment dates',
    'voluntary self-identification', 'background check / non-compete',
  ],
}

router.get('/api/profile', async (req, res) => {
  // 画像按用户分槽存：profile.json = { [ownerId]: {...} }
  // 没填过就回默认模板（不落盘，直到用户第一次保存）
  res.json((await readProfileOf(req.userId)) || DEFAULT_PROFILE)
})

router.put('/api/profile', async (req, res) => {
  const body = req.body || {}
  // 增量合并：未传字段保留旧值；首次写入（无旧值）回退默认值。
  // 必须在锁内做：两个人同时改画像，后写的会把先写的整段覆盖掉
  const next = await updateProfileOf(req.userId, (prev) => {
    const old = prev || DEFAULT_PROFILE
    return {
      ...DEFAULT_PROFILE,
      ...old,
      ...body,
      basic: { ...DEFAULT_PROFILE.basic, ...old.basic, ...(body.basic || {}) },
      currentStatus: { ...DEFAULT_PROFILE.currentStatus, ...old.currentStatus, ...(body.currentStatus || {}) },
      workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, ...old.workAuthorization, ...(body.workAuthorization || {}) },
      targets: { ...DEFAULT_PROFILE.targets, ...old.targets, ...(body.targets || {}) },
      compensation: { ...DEFAULT_PROFILE.compensation, ...old.compensation, ...(body.compensation || {}) },
      selfIdentification: { ...DEFAULT_PROFILE.selfIdentification, ...old.selfIdentification, ...(body.selfIdentification || {}) },
      resumeMapping: Array.isArray(body.resumeMapping) ? body.resumeMapping : (Array.isArray(old.resumeMapping) ? old.resumeMapping : []),
      neverGuess: Array.isArray(body.neverGuess) ? body.neverGuess : (Array.isArray(old.neverGuess) ? old.neverGuess : DEFAULT_PROFILE.neverGuess),
    }
  })
  res.json(next)
})

export default router
