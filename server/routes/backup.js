import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { updateJSON } from '../lib/store.js'
import { listMine, readProfileOf, updateProfileOf } from '../lib/scope.js'

const router = Router()

/**
 * 个人数据备份/恢复。只备份「个人数据」，不含岗位知识库 jobs.json
 * （jobs.json 进 git、属代码资产非个人数据，无需备份）。
 *
 * 多用户下这个接口有两个致命点，都必须堵住：
 *   1. 导出：只导自己的。否则一次 GET 就把全站数据打包带走，比任何越权都彻底。
 *   2. 导入：老实现是 writeJSON(key, val) —— 整文件覆盖。
 *      多用户下等于「B 恢复一次备份，A 的数据全没了」，
 *      而且 val 里带着 ownerId，B 改一改就能往 A 名下塞数据。
 *      现在改为「只替换属于我的那部分，且 ownerId 一律重写为我」。
 */

const ARRAY_KEYS = ['resumes', 'applications', 'records']
const PROFILE_KEY = 'profile'

// 导出：只读当前用户自己的数据
router.get('/api/backup/export', async (req, res) => {
  const data = {}
  for (const key of ARRAY_KEYS) {
    data[key] = await listMine(key, req.userId)
  }
  data[PROFILE_KEY] = (await readProfileOf(req.userId)) || {}

  res.json({
    app: 'job-hunter',
    version: 2, // v1 是单人格式（无 ownerId），v2 起每条记录带归属
    exportedAt: new Date().toISOString(),
    data,
  })
})

// 导入：校验后替换「我自己的」数据（危险操作，前端需二次确认）
router.post('/api/backup/import', async (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') {
    return res.status(400).json({ error: '备份文件格式不正确：缺少 data 字段' })
  }

  // 先全部校验，再动手写 —— 写到一半发现格式错，会留下半套数据
  for (const key of [...ARRAY_KEYS, PROFILE_KEY]) {
    const val = body.data[key]
    if (val === undefined) continue
    if (key === PROFILE_KEY) {
      if (Array.isArray(val) || typeof val !== 'object' || val === null) {
        return res.status(400).json({ error: '备份文件字段类型错误：profile 应为对象' })
      }
    } else if (!Array.isArray(val)) {
      return res.status(400).json({ error: `备份文件字段类型错误：${key} 应为数组` })
    }
  }

  const imported = []
  const skipped = []

  for (const key of ARRAY_KEYS) {
    const val = body.data[key]
    if (val === undefined) {
      skipped.push(key)
      continue
    }
    // 归属强制重写：备份文件里的 ownerId 一律不可信（可能是别人的、也可能被手改过）
    const mine = val.map((item) => ({
      ...(item && typeof item === 'object' ? item : {}),
      id: item?.id || randomUUID(),
      ownerId: req.userId,
    }))
    await updateJSON(
      key,
      (all) => [...all.filter((x) => x.ownerId !== req.userId), ...mine],
      []
    )
    imported.push(key)
  }

  if (body.data[PROFILE_KEY] !== undefined) {
    const val = body.data[PROFILE_KEY]
    await updateProfileOf(req.userId, () => val)
    imported.push(PROFILE_KEY)
  } else {
    skipped.push(PROFILE_KEY)
  }

  res.json({ ok: true, imported, skipped })
})

export default router
