import { Router } from 'express'
import { readJSON, writeJSON } from '../lib/store.js'

/**
 * 候选人画像：求职过程中的「不可猜测事实」唯一真相源。
 * 与简历库（resumes）不同——简历是「怎么写」，画像是「这些事 AI 不能瞎编」。
 * 借鉴 applypilot 的 candidate_profile 模板，精简到中文求职场景。
 * 存 server/data/profile.json（已 gitignore，敏感数据不进公开仓库）。
 */
const router = Router()
const KEY = 'profile'

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

router.get('/api/profile', async (_req, res) => {
  res.json((await readJSON(KEY)) || DEFAULT_PROFILE)
})

router.put('/api/profile', async (req, res) => {
  const body = req.body || {}
  const prev = (await readJSON(KEY)) || DEFAULT_PROFILE
  // 增量合并：未传字段保留旧值；首次写入（无旧值）回退默认值
  const next = {
    ...DEFAULT_PROFILE,
    ...prev,
    ...body,
    basic: { ...DEFAULT_PROFILE.basic, ...prev.basic, ...(body.basic || {}) },
    currentStatus: { ...DEFAULT_PROFILE.currentStatus, ...prev.currentStatus, ...(body.currentStatus || {}) },
    workAuthorization: { ...DEFAULT_PROFILE.workAuthorization, ...prev.workAuthorization, ...(body.workAuthorization || {}) },
    targets: { ...DEFAULT_PROFILE.targets, ...prev.targets, ...(body.targets || {}) },
    compensation: { ...DEFAULT_PROFILE.compensation, ...prev.compensation, ...(body.compensation || {}) },
    selfIdentification: { ...DEFAULT_PROFILE.selfIdentification, ...prev.selfIdentification, ...(body.selfIdentification || {}) },
    resumeMapping: Array.isArray(body.resumeMapping) ? body.resumeMapping : (Array.isArray(prev.resumeMapping) ? prev.resumeMapping : []),
    neverGuess: Array.isArray(body.neverGuess) ? body.neverGuess : (Array.isArray(prev.neverGuess) ? prev.neverGuess : DEFAULT_PROFILE.neverGuess),
  }
  await writeJSON(KEY, next)
  res.json(next)
})

export default router
