/**
 * 无头 Chrome 截图（CDP）。用于改完 UI 后自查版面，不做像素比对。
 *
 * 为什么不用 `chrome --screenshot`：要先注入 token，命令行做不到；
 * 这里走 CDP：先打开 /login 写 localStorage，再逐页 navigate + 截整页。
 *
 * 跑：node scripts/ui-shots.mjs [baseUrl] [outDir]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const BASE = process.argv[2] || 'http://127.0.0.1:3200'
const OUT = process.argv[3] || 'D:/tmp/shots3'
const PROFILE = 'D:/tmp/cdp-profile-ui'

const PAGES = [
  ['/', 'dashboard'],
  ['/applications', 'applications'],
  ['/interview-prep', 'interview-prep'],
  ['/funnel', 'funnel'],
  ['/resumes', 'resumes'],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'ui_preview', password: 'ui-preview-pw' }),
})
const auth = await login.json()
if (!auth.token) {
  console.error('登录失败：', auth)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
try {
  rmSync(PROFILE, { recursive: true, force: true })
} catch (_) {
  /* 旧 profile 清不掉就让 chrome 自己建新的 */
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--headless=new',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

async function waitPort() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) return r.json()
    } catch (_) {
      /* 还没起 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来')
}

const ver = await waitPort()
const target = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
).json()

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const waiters = new Map()
const events = []

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && waiters.has(msg.id)) {
    const { resolve, reject } = waiters.get(msg.id)
    waiters.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  } else if (msg.method) {
    events.push(msg.method)
  }
})

await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})

function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject })
    setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id)
        reject(new Error(`${method} 超时`))
      }
    }, 30000)
  })
}

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return r.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})

// 先落地到 /login，把 token 写进 localStorage（前端 key = jh_token）
await send('Page.navigate', { url: `${BASE}/login` })
await sleep(1500)
await evaluate(`localStorage.setItem('jh_token', ${JSON.stringify(auth.token)})`)
console.log('token 已注入', String(auth.token).slice(0, 12) + '…')

for (const [path, name] of PAGES) {
  await send('Page.navigate', { url: BASE + path })
  await sleep(2000)
  const h = await evaluate(
    `(() => {
       const c = document.querySelector('.content') || document.body
       return Math.max(c.scrollHeight, c.offsetHeight, 900) + 40
     })()`
  )
  const height = Math.min(Number(h) || 900, 4200)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(400)
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(shot.data, 'base64'))
  console.log(`${name}.png  ${1440}x${height}`)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

ws.close()
chrome.kill()
console.log('完成 →', OUT)
