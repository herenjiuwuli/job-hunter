import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * 统一数据目录：默认 server/data/，可通过 JOB_HUNTER_DATA_DIR 覆盖（测试隔离用）。
 * - 运行时数据（简历库、投递记录）都在这里。
 * - 默认目录已整体 gitignore（含个人简历原文与投递记录，敏感）。
 */
export const DATA_DIR = process.env.JOB_HUNTER_DATA_DIR
  ? resolve(process.env.JOB_HUNTER_DATA_DIR)
  : join(__dirname, '..', 'data')

export function dataPath(key) {
  return join(DATA_DIR, `${key}.json`)
}

export async function readJSON(key) {
  const filePath = dataPath(key)
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// 临时文件名序号：进程内自增，跨进程靠 pid 区分。
// 不能用 Date.now() 做唯一性——同一毫秒内的并发写会撞同一个文件名，
// 两个 writeFile 抢同一个文件，先完成的 rename 走之后另一个直接 EPERM 失败。
let tmpSeq = 0

/**
 * 原子写：先写 .tmp，再 rename 覆盖目标文件。
 *
 * 为什么不直接 writeFile：
 *   1) writeFile 不是原子的。写到一半进程被杀 / 磁盘满 → 留下截断的 JSON，
 *      下次 readJSON 解析失败直接返回 null，等于整份数据凭空消失。
 *   2) 同一文件系统内 rename 是原子操作：要么完整换成新文件，要么还是旧的完整文件，
 *      不存在「半个 JSON」这个中间态。
 *   3) tmp 名字带 pid + 自增序号，保证并发写各写各的临时文件（不能用时间戳，见下方 tmpSeq 注释）。
 */
async function writeAtomic(key, data) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true })
  const target = dataPath(key)
  const tmp = `${target}.${process.pid}.${++tmpSeq}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  await renameWithRetry(tmp, target)
}

/**
 * Windows 上 rename 覆盖一个「正被别人打开/正在被另一个 rename 处理」的目标会抛 EPERM/EBUSY，
 * 而 Linux / macOS 的 rename(2) 是原子的、直接成功。
 * 有锁时（updateJSON）同一 key 不会并发到这里，但跨进程（开了两个服务实例、或备份脚本同时跑）
 * 仍可能撞上，所以退避重试几次。重试仍失败就抛出——宁可让调用方看到错误，也不要假装写成功。
 */
async function renameWithRetry(tmp, target, retries = 5) {
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, target)
      return
    } catch (e) {
      const transients = ['EPERM', 'EBUSY', 'EACCES']
      if (i >= retries || !transients.includes(e.code)) throw e
      await new Promise((r) => setTimeout(r, 10 * (i + 1)))
    }
  }
}

/**
 * 整表覆盖（不加锁）。只用于「确定没有并发」的场景：备份导入、初始化播种。
 * 正常业务写入请用 updateJSON —— 否则读-改-写仍会交错。
 */
export async function writeJSON(key, data) {
  await writeAtomic(key, data)
}

// key 级串行链：同一个 key 的「读-改-写」必须排队，不同 key 之间互不阻塞
const chains = new Map()

function serial(key, fn) {
  const prev = chains.get(key) || Promise.resolve()
  const run = prev.then(fn)
  // 链上挂的是「已处理失败」的版本：一次异常不能把后续请求永久卡死
  chains.set(key, run.then(() => {}, () => {}))
  return run
}

/**
 * 在锁内完成「读 → 改 → 写」，这是唯一正确的写法。
 *
 * 原来的写法（多处路由都是这个形状）：
 *   const list = await readJSON(KEY)   // ① 读到 [A]
 *   list.push(item)                     // ② 内存里改成 [A,B]
 *   await writeJSON(KEY, list)          // ③ 写回 [A,B]
 * 两个请求同时进来都读到 [A]，各自写回 [A,B] 和 [A,C]，后写的覆盖先写的，B 永久丢失。
 * 只给 writeJSON 加锁没用（锁住的只是 ③，①② 照样交错），必须把整段一起锁。
 *
 * @param {string} key
 * @param {(cur: any) => any | undefined | Promise<any | undefined>} mutator
 *        收到当前值，返回新值；返回 undefined 表示「不写」（用于 404 之类的提前退出）
 * @param {any} fallback 文件不存在时的初始值（数组用 []，对象用默认模板）
 * @returns 写入后的新值；mutator 返回 undefined 时也是 undefined
 */
export async function updateJSON(key, mutator, fallback = null) {
  return serial(key, async () => {
    const cur = await readJSON(key)
    const next = await mutator(cur === null ? fallback : cur)
    if (next !== undefined) await writeAtomic(key, next)
    return next
  })
}
