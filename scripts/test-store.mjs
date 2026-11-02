/**
 * store 并发安全回归测试
 *
 * 背景：原来所有路由都是「读全量 → 改 → 写全量」三步，中间没有任何锁。
 * 单用户因为投递间隔 15~30 秒，几乎撞不上；两个人（或扩展批量投递连续 POST）
 * 同时进来就会「后一条覆盖前一条」，记录静默消失且不报错。
 *
 * 这个测试做两件事：
 *   1) 证明旧写法确实会丢（否则说明测试没测出问题，是假绿）
 *   2) 证明 updateJSON 在同样并发下一条不丢
 *
 * 用法：node scripts/test-store.mjs
 */
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
function checkTrue(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? `（${detail}）` : ''}`)
  }
}

// 必须在 import store.js 之前设好：DATA_DIR 是模块加载时求值的
const dir = await mkdtemp(join(tmpdir(), 'jh-store-test-'))
process.env.JOB_HUNTER_DATA_DIR = dir

const { updateJSON, readJSON, writeJSON, DATA_DIR } = await import('../server/lib/store.js')

console.log(`数据目录：${DATA_DIR}\n`)

// ---------- 1) 环境：DATA_DIR 真的被改了 ----------
console.log('1) 数据目录隔离')
checkTrue('DATA_DIR 指向临时目录', DATA_DIR === dir, `实际 ${DATA_DIR}`, '')

// ---------- 2) 旧写法确实会丢（对照组，证明测试有效） ----------
console.log('\n2) 对照组：旧的「读-改-写」并发会丢数据')
{
  const KEY = 'oldway'
  const oldWrite = async (item) => {
    const list = (await readJSON(KEY)) || []
    list.push(item)
    // 串行化锁保护的只有 writeJSON 内部，读-改-写这一步照样交错
    try {
      await writeJSON(KEY, list)
    } catch {
      // 旧写法下并发 rename 还可能直接失败——这本身也是它的问题，忽略以便统计最终条数
    }
  }
  await Promise.all(Array.from({ length: 50 }, (_, i) => oldWrite({ id: `old-${i}` })))
  const got = (await readJSON(KEY)) || []
  checkTrue(
    '50 个并发写入后明显少于 50 条（这就是丢数据）',
    got.length < 20,
    `实际留下 ${got.length} 条`
  )
}

// ---------- 3) updateJSON：同样 50 个并发，一条不丢 ----------
console.log('\n3) updateJSON：同样并发下一条不丢')
{
  const KEY = 'newway'
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      updateJSON(KEY, (list) => [...list, { id: `new-${i}` }], [])
    )
  )
  const got = (await readJSON(KEY)) || []
  check('50 个并发写入留下 50 条', got.length, 50)
  const ids = new Set(got.map((x) => x.id))
  check('50 条 id 互不重复', ids.size, 50)
}

// ---------- 4) mutator 返回 undefined 表示不写 ----------
console.log('\n4) 提前退出不产生写入')
{
  const KEY = 'skipwrite'
  await updateJSON(KEY, () => [{ id: 'a' }], [])
  const before = (await readJSON(KEY)).length
  const ret = await updateJSON(KEY, () => undefined, [])
  const after = (await readJSON(KEY)).length
  check('返回 undefined 时返回值是 undefined', ret, undefined)
  check('文件内容没变', after, before)
}

// ---------- 5) 文件不存在时使用 fallback ----------
console.log('\n5) 空文件使用初始值')
{
  const list = await updateJSON('fresh', (cur) => [...cur, { id: 'x' }], [])
  check('空目录下 cur 是 []，写入后 1 条', list.length, 1)
}

// ---------- 6) 一次异常不会把该 key 永久卡死 ----------
console.log('\n6) 异常不阻断后续写入')
{
  const KEY = 'boom'
  let threw = false
  try {
    await updateJSON(KEY, () => {
      throw new Error('故意抛错')
    }, [])
  } catch {
    threw = true
  }
  checkTrue('mutator 抛错会 reject 到调用方', threw)
  const ok = await updateJSON(KEY, () => [{ id: 'after-error' }], [])
  check('抛错后同一个 key 仍能正常写', ok.length, 1)
}

// ---------- 7) 原子写：不留 .tmp 残渣 ----------
console.log('\n7) 原子写不留临时文件')
{
  await updateJSON('atomic', () => [{ id: 'z' }], [])
  const files = await readdir(dir)
  const leftovers = files.filter((f) => f.endsWith('.tmp'))
  check('目录里没有 .tmp 残留', leftovers.length, 0)
  checkTrue('目标文件存在', existsSync(join(dir, 'atomic.json')))
}

// ---------- 8) 不同 key 互不阻塞 ----------
console.log('\n8) 不同 key 之间不串行')
{
  const t0 = Date.now()
  await Promise.all([
    updateJSON('k1', async (l) => {
      await new Promise((r) => setTimeout(r, 80))
      return [...l, { id: 1 }]
    }, []),
    updateJSON('k2', async (l) => {
      await new Promise((r) => setTimeout(r, 80))
      return [...l, { id: 2 }]
    }, []),
  ])
  const cost = Date.now() - t0
  checkTrue('两个 key 并行耗时 < 150ms（串行会 ~160ms）', cost < 150, `实际 ${cost}ms`)
}

// ---------- 9) 坏文件不会让读取崩掉 ----------
console.log('\n9) 损坏的 JSON 安全降级')
{
  await writeFile(join(dir, 'broken.json'), '{ 这不是合法 JSON', 'utf-8')
  check('解析失败返回 null 而不是抛异常', await readJSON('broken'), null)
}

await rm(dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
