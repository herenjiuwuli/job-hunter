import { readJSON, updateJSON } from './store.js'

/**
 * 数据归属（多用户隔离）的唯一入口。
 *
 * 为什么要单独一个文件而不是在 18 个路由里各写一遍 filter：
 *   过滤逻辑写散了，就必然有一处漏 —— 而漏一处等于没做。
 *   所有「按用户取数据」都走这里，改规则只改一处，审代码也只审一处。
 */

/**
 * 一条记录是否属于该用户。
 * 缺 ownerId 的数据（迁移前的老数据）对**所有人**都不可见 —— 宁可让主人跑一次迁移脚本，
 * 也不要让「没归属的数据」变成公共数据。迁移脚本会把它们显式划到主人名下。
 */
export const isMine = (item, ownerId) => Boolean(item && item.ownerId === ownerId)

export async function listMine(key, ownerId) {
  const all = (await readJSON(key)) || []
  return all.filter((x) => isMine(x, ownerId))
}

export async function getMine(key, ownerId, id) {
  const all = (await readJSON(key)) || []
  return all.find((x) => x.id === id && isMine(x, ownerId)) || null
}

// ---------- 候选人画像 ----------
// 画像不是数组，是「一人一个对象」。多用户只能存成 { [ownerId]: profile }，
// 否则两个人必然互相覆盖（这也是迁移脚本必须给它做变形的唯一原因）。

const PROFILE_KEY = 'profile'

function profileMap(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return {}
  if (Object.prototype.hasOwnProperty.call(raw, 'basic')) {
    const err = new Error('profile.json 仍是旧版单人格式，请先执行 npm run migrate:owner')
    err.status = 500
    throw err
  }
  return raw
}

export async function readProfileOf(ownerId) {
  const map = profileMap(await readJSON(PROFILE_KEY))
  return map[ownerId] || null
}

/**
 * 读-改-写画像：整段在 store 的 key 级锁里完成。
 * mutator 返回 undefined 表示不写（用于「没有任何变化」的场景）。
 */
export async function updateProfileOf(ownerId, mutator) {
  let result
  await updateJSON(
    PROFILE_KEY,
    (raw) => {
      const map = profileMap(raw)
      const next = mutator(map[ownerId] || null)
      if (next === undefined) return undefined
      result = next
      return { ...map, [ownerId]: next }
    },
    {}
  )
  return result
}
