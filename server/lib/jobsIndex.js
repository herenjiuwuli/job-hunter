/**
 * 岗位方向索引 —— 把「这条投递属于哪个方向」从手工录入变成自动补齐。
 *
 * 数据源是 data/jd/jobs.json（你自己收集的 JD 语料，字段含 company/title/direction）。
 * 它不在 server/data 下（不进 git、也不是运行时数据），所以这里独立读、独立缓存：
 *   - 读不到就当空表（新克隆的仓库 / 测试环境没有这个文件），不影响任何主流程
 *   - 缓存 5 分钟：jd-stats 脚本改完文件不用重启服务
 */
import { readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = join(__dirname, '..', '..', 'data', 'jd', 'jobs.json')

let cache = { at: 0, map: new Map(), mtimeMs: 0 }

/** 归一化用于匹配：去空格、去标点、小写。公司名「字节跳动」与「字节跳动 」要能对上 */
export function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[（）()【】\[\]·、,，.。/\\|—-]/g, '')
}

function load() {
  const now = Date.now()
  if (now - cache.at < 5 * 60 * 1000) return cache.map
  try {
    const st = statSync(FILE)
    if (st.mtimeMs === cache.mtimeMs && cache.map.size) {
      cache.at = now
      return cache.map
    }
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'))
    const arr = Array.isArray(raw) ? raw : raw.jobs || raw.items || []
    const map = new Map()
    for (const j of arr) {
      const d = String(j.direction || '').trim()
      if (!d) continue
      // 公司+岗位 精确配；岗位单独配作为退路（同一家公司可能多个岗位同方向）
      if (j.company && j.title) map.set(`${normKey(j.company)}|${normKey(j.title)}`, d)
      if (j.title) {
        const k = normKey(j.title)
        if (!map.has(`*|${k}`)) map.set(`*|${k}`, d)
      }
    }
    cache = { at: now, map, mtimeMs: st.mtimeMs }
    return map
  } catch {
    cache = { at: now, map: new Map(), mtimeMs: 0 }
    return cache.map
  }
}

/**
 * @returns {string} 方向；查不到返回空串（调用方决定要不要写 '未分类'）
 */
export function lookupDirection(company, title) {
  const map = load()
  if (!map.size) return ''
  const exact = map.get(`${normKey(company)}|${normKey(title)}`)
  if (exact) return exact
  return map.get(`*|${normKey(title)}`) || ''
}
