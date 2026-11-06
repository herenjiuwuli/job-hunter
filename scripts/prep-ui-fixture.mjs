/**
 * 造一份「界面截图用」的隔离数据（不动真实 server/data）。
 *
 * 做法：复制真实数据到临时目录 → 建一个截图专用账号 → 把所有记录归属改成它。
 * 这样截图里是真实密度（62 条投递、2 份简历、2 场面试），但令牌与真实账号无关。
 *
 * 跑：node scripts/prep-ui-fixture.mjs <目标目录>
 */
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const dest = resolve(process.argv[2] || 'D:/tmp/jh_ui_data')
const src = join(process.cwd(), 'server', 'data')

if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const f of ['applications.json', 'resumes.json', 'records.json', 'profile.json', 'jobs.json', 'invites.json']) {
  const p = join(src, f)
  if (existsSync(p)) cpSync(p, join(dest, f))
}

// 建号（已存在则重置密码）
execFileSync(
  process.execPath,
  ['scripts/create-user.mjs', '--username', 'ui_preview', '--password', 'ui-preview-pw', '--role', 'owner', '--reset', '--data', dest],
  { stdio: 'inherit' }
)

const users = JSON.parse(readFileSync(join(dest, 'users.json'), 'utf8'))
const uid = users.find((u) => u.username === 'ui_preview').id

for (const f of ['applications.json', 'resumes.json', 'records.json']) {
  const p = join(dest, f)
  if (!existsSync(p)) continue
  const list = JSON.parse(readFileSync(p, 'utf8'))
  for (const it of list) it.ownerId = uid
  writeFileSync(p, JSON.stringify(list, null, 2), 'utf8')
}

// profile 是 {ownerId: {...}} 的 map
const pp = join(dest, 'profile.json')
if (existsSync(pp)) {
  const map = JSON.parse(readFileSync(pp, 'utf8'))
  const first = Object.values(map)[0] || {}
  writeFileSync(pp, JSON.stringify({ [uid]: first }, null, 2), 'utf8')
}

console.log('fixture 就绪：', dest)
console.log('账号 ui_preview / ui-preview-pw  uid=', uid)
