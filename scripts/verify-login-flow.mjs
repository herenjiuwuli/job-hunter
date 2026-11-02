#!/usr/bin/env node
/**
 * 真机验收：登录 + 邀请制 + 账号设置（零依赖 CDP，用本机 Chrome）。
 *
 * 为什么光跑 build / 单测不够：
 *   后端接口全是 401/200 的绿，也证明不了「浏览器里能登录进去」。
 *   实测踩到的真 bug：`app.use(requireAuth)` 少了 '/api' 前缀，
 *   结果连 dist 的静态资源都被拦了 —— 接口测试一条都不会红，页面却直接 401 白屏。
 *
 * 覆盖五条链路：
 *   ① 未登录访问内页 → 被守卫送回登录页
 *   ② 带邀请码注册 → 自动登录 → 进总览（token 真的存下来、路由真的跳了）
 *   ③ 普通成员进 /settings：能改密码，但看不到邀请码卡片（前端不露不该露的）
 *   ④ 换成 owner 登录 → /settings 能看到邀请码 → 生成一个 → 列表里真的出现
 *   ⑤ token 被改坏 → 自动弹回登录页并清掉本地 token
 *
 * 用法：
 *   node scripts/verify-login-flow.mjs [http://localhost:3100]
 *
 * 邀请码从哪来（二选一，都不给就跳过需要码的那几步）：
 *   JH_INVITE_CODE=ABCD-EFGH-JKLM          # 现成的一个码
 *   JH_OWNER_USER=chen JH_OWNER_PASS=xxx   # 脚本自己登录 owner 现生成一个
 *
 * 前置：目标实例已在跑（npm run dev 或 npm start）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const BASE = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '')
const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const OWNER_USER = process.env.JH_OWNER_USER || ''
const OWNER_PASS = process.env.JH_OWNER_PASS || ''
const GIVEN_CODE = process.env.JH_INVITE_CODE || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/** 极简 CDP 客户端：send 带超时，连接断了把挂起的调用全部拒掉 */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id)
        clearTimeout(timer)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    })
    ws.addEventListener('close', () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer)
        reject(new Error('CDP 连接已关闭'))
      }
      this.pending.clear()
    })
  }

  send(method, params = {}, timeout = 15000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 超时：${method}`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面内执行异常')
    return r.result.value
  }

  /** 轮询业务条件，别等 load 事件（SPA 的 load 早于框架渲染） */
  async waitFor(expr, label, timeout = 12000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.eval(expr)) return true
      } catch {
        /* 导航中 eval 会抖，忽略 */
      }
      await sleep(150)
    }
    throw new Error(`等待超时：${label}`)
  }
}

async function withBrowser(fn) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'jh-cdp-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' }
  )
  try {
    // 端口设 0 时，实际端口写在 DevToolsActivePort 文件首行
    const portFile = join(userDataDir, 'DevToolsActivePort')
    let port = null
    for (let i = 0; i < 60; i++) {
      if (existsSync(portFile)) {
        const { readFileSync } = await import('node:fs')
        port = readFileSync(portFile, 'utf-8').split('\n')[0].trim()
        if (port) break
      }
      await sleep(150)
    }
    if (!port) throw new Error('Chrome 没起来（拿不到调试端口）')

    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true })
    })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    try {
      await fn(cdp)
    } finally {
      try { ws.close() } catch {}
    }
  } finally {
    try { child.kill() } catch {}
    await sleep(300)
    try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  }
}

async function nav(cdp, path) {
  await cdp.send('Page.navigate', { url: BASE + path })
  await sleep(600)
}

/** 拿一个可用邀请码：优先用环境变量给的，否则登录 owner 现生成一个 */
async function obtainInvite() {
  if (GIVEN_CODE) return GIVEN_CODE
  if (!OWNER_USER || !OWNER_PASS) return ''
  try {
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: OWNER_USER, password: OWNER_PASS }),
    })
    if (!login.ok) {
      console.log(`  ⚠️ 登录 ${OWNER_USER} 失败（${login.status}），跳过需要邀请码的步骤`)
      return ''
    }
    const { token } = await login.json()
    const r = await fetch(`${BASE}/api/auth/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ note: '真机验收自动生成' }),
    })
    if (!r.ok) {
      console.log(`  ⚠️ 生成邀请码失败（${r.status}）`)
      return ''
    }
    return (await r.json()).code || ''
  } catch (e) {
    console.log(`  ⚠️ 取邀请码异常：${e.message}`)
    return ''
  }
}

async function main() {
  console.log(`目标：${BASE}\n`)

  // 先确认实例活着（node 原生 fetch，不受沙箱代理影响）
  try {
    const h = await (await fetch(`${BASE}/api/health`)).json()
    if (h.status !== 'ok') throw new Error(JSON.stringify(h))
  } catch (e) {
    console.error(`后端不可达：${e.message}`)
    process.exit(1)
  }

  const username = `ui_${randomBytes(3).toString('hex')}`
  const password = 'ui-check-123456'
  const inviteCode = await obtainInvite()
  if (!inviteCode) console.log('（未提供邀请码，将跳过注册与 owner 相关步骤）\n')

  // 页面里改 input 的值必须走原生 setter + 派发 input 事件，
  // 否则 Vue 的双向绑定收不到（直接 el.value = x 只改 DOM，不改响应式状态）
  const SET_FN =
    "const set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};"

  await withBrowser(async (cdp) => {
    // ① 未登录访问 /dashboard 应被守卫送到 /login
    await nav(cdp, '/dashboard')
    await cdp.waitFor(`location.pathname === '/login'`, '未登录跳转登录页')
    check('未登录访问 /dashboard → 跳到 /login', true, await cdp.eval('location.pathname'))

    const formReady = await cdp.eval(
      `Boolean(document.querySelector('.login-card') && document.querySelector('input[type=password]'))`
    )
    check('登录页表单渲染', formReady)

    if (inviteCode) {
      // ② 带邀请码注册 → 自动登录 → 进总览
      await cdp.eval(`
        (() => {
          ;[...document.querySelectorAll('.login-tab')].find(b => b.textContent.trim() === '注册').click()
        })()
      `)
      await sleep(250) // 等注册专用字段（邀请码）渲染出来
      const inputCount = await cdp.eval(`document.querySelectorAll('.login-card input').length`)
      check('注册表单出现邀请码输入框', inputCount === 3, `输入框 ${inputCount} 个`)

      await cdp.eval(`
        (() => {
          ${SET_FN}
          const inputs = [...document.querySelectorAll('.login-card input')]
          set(inputs[0], ${JSON.stringify(username)})
          set(inputs[1], ${JSON.stringify(password)})
          set(inputs[2], ${JSON.stringify(inviteCode)})
        })()
      `)
      await sleep(200)
      await cdp.eval(`document.querySelector('.login-submit').click()`)

      await cdp.waitFor(`location.pathname === '/dashboard'`, '登录后跳到总览', 15000)
      check('带邀请码注册 → 自动登录并进入总览', true, await cdp.eval('location.pathname'))

      await cdp.waitFor(`document.body.innerText.includes('求职总览')`, '总览页内容渲染')
      check('总览页渲染出内容', true)

      const stored = await cdp.eval(`Boolean(localStorage.getItem('jh_token'))`)
      check('token 已写入 localStorage', stored)

      const sidebarUser = await cdp.eval(`(document.querySelector('.sidebar-user')||{}).textContent||''`)
      check('侧边栏显示当前账号', sidebarUser.trim() === username, sidebarUser.trim())

      // ③ 普通成员进设置页：能改密码，但看不到邀请码
      await nav(cdp, '/settings')
      await cdp.waitFor(`document.body.innerText.includes('账号设置')`, '设置页渲染')
      const memberPw = await cdp.eval(`document.body.innerText.includes('修改密码')`)
      const memberInvite = await cdp.eval(`document.body.innerText.includes('邀请码')`)
      check('成员能看到改密码表单', memberPw)
      check('成员看不到邀请码管理', !memberInvite, memberInvite ? '普通成员竟然看到了邀请码卡片' : '')

      // ④ 换成 owner：设置页能看到邀请码，且能生成一个新的
      if (OWNER_USER && OWNER_PASS) {
        await cdp.eval(`(document.querySelector('.sidebar-logout')||{click(){}}).click()`)
        await cdp.waitFor(`location.pathname === '/login'`, '退出回登录页')

        await cdp.eval(`
          (() => {
            ${SET_FN}
            const inputs = [...document.querySelectorAll('.login-card input')]
            set(inputs[0], ${JSON.stringify(OWNER_USER)})
            set(inputs[1], ${JSON.stringify(OWNER_PASS)})
          })()
        `)
        await sleep(150)
        await cdp.eval(`document.querySelector('.login-submit').click()`)
        await cdp.waitFor(`location.pathname === '/dashboard'`, 'owner 登录成功', 15000)

        await nav(cdp, '/settings')
        await cdp.waitFor(`document.body.innerText.includes('邀请码')`, 'owner 能看到邀请码卡片')
        check('owner 在设置页看到邀请码卡片', true)

        const before = await cdp.eval(`document.querySelectorAll('.inv-table tbody tr').length`)
        await cdp.eval(`
          ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '生成邀请码').click()
        `)
        await cdp.waitFor(`Boolean(document.querySelector('.fresh-code'))`, '生成后出现新码', 12000)
        const shown = await cdp.eval(`(document.querySelector('.fresh-code')||{}).textContent||''`)
        check('点「生成邀请码」后页面显示新码', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(shown.trim()), shown.trim())

        const after = await cdp.eval(`document.querySelectorAll('.inv-table tbody tr').length`)
        check('新码出现在列表里', after > before, `${before} → ${after} 行`)

        // 可选截图：样式问题接口测试看不出来，只有真看一眼才知道有没有错位/溢出
        if (process.env.JH_SHOT) {
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
          })
          await sleep(300)
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
          writeFileSync(process.env.JH_SHOT, Buffer.from(shot.data, 'base64'))
          console.log(`  📷 截图：${process.env.JH_SHOT}`)
        }
      }
    }

    // ⑤ token 失效 → 自动弹回登录页
    await cdp.eval(`localStorage.setItem('jh_token','broken.token.value')`)
    await cdp.send('Page.reload')
    await sleep(800)
    await cdp.waitFor(`location.pathname === '/login'`, '坏 token 自动回登录页', 15000)
    check('token 失效自动回登录页', true, await cdp.eval('location.pathname'))

    const cleared = await cdp.eval(`localStorage.getItem('jh_token') === null`)
    check('失效 token 已被清掉', cleared)
  })

  const failed = checks.filter((c) => !c.pass)
  console.log(`\n通过 ${checks.length - failed.length} / ${checks.length}`)
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error('\n验收中断：', e.message)
  process.exit(1)
})
