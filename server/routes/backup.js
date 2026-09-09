import { Router } from 'express'
import { readJSON, writeJSON } from '../lib/store.js'

const router = Router()

/**
 * 个人数据备份/恢复。只备份「个人数据」4 类，不含岗位知识库 jobs.json
 * （jobs.json 进 git、属代码资产非个人数据，无需备份）。
 */
const DATA_KEYS = ['resumes', 'applications', 'records', 'profile']

// 各 key 的合法类型：数组 or 对象，导入时校验，避免写入损坏数据
const KEY_TYPES = {
  resumes: 'array',
  applications: 'array',
  records: 'array',
  profile: 'object',
}

function defaultValue(key) {
  return KEY_TYPES[key] === 'array' ? [] : {}
}

// 导出：读取全部个人数据打包返回
router.get('/api/backup/export', async (_req, res) => {
  const data = {}
  for (const key of DATA_KEYS) {
    data[key] = (await readJSON(key)) || defaultValue(key)
  }
  res.json({
    app: 'job-hunter',
    version: 1,
    exportedAt: new Date().toISOString(),
    data,
  })
})

// 导入：校验后覆盖写入（危险操作，前端需二次确认）
router.post('/api/backup/import', async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') {
    return res.status(400).json({ error: '备份文件格式不正确：缺少 data 字段' })
  }

  const imported = []
  const skipped = []
  for (const key of DATA_KEYS) {
    const val = body.data[key]
    if (val === undefined) {
      skipped.push(key)
      continue
    }
    const expectType = KEY_TYPES[key]
    const isArray = Array.isArray(val)
    if ((expectType === 'array' && !isArray) || (expectType === 'object' && (isArray || typeof val !== 'object'))) {
      return res.status(400).json({ error: `备份文件字段类型错误：${key} 应为 ${expectType === 'array' ? '数组' : '对象'}` })
    }
    await writeJSON(key, val)
    imported.push(key)
  }

  res.json({ ok: true, imported, skipped })
})

export default router
