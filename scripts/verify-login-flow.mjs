#!/usr/bin/env node
/**
 * 真机验收：登录链路（零依赖 CDP，用本机 Chrome）。
 *
 * 为什么光跑 build / 单测不够：
 *   后端接口全是 401/200 的绿，也证明不了「浏览器里能登录进去」。
 *   实测踩到的真 bug：`app.use(requireAuth)` 少了 '/api' 前缀，
 *   结果连 dist 的静态资源都被拦了 —— 接口测试一条都不会红，页面却直接 401 白屏。
 *
 * 覆盖三条链路：
 *   ① 登录页渲染（表单在、按钮在）
 *   ② 注册 → 自动登录 → 进总览（token 真的存下来、路由真的跳了）
 *   ③ token 无效 → 自动弹回登录页（不能卡在空白的总览）
 *
 * 用法：node scripts/verify-login-flow.mjs [http://localhost:3100]
 * 前置：目标实例已在跑（npm run dev 或 npm start）
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const BASE = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '')
const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'

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

  await withBrowser(async (cdp) => {
    // ① 未登录访问 /dashboard 应被守卫送到 /login
    await nav(cdp, '/dashboard')
    await cdp.waitFor(`location.pathname === '/login'`, '未登录跳转登录页')
    check('未登录访问 /dashboard → 跳到 /login', true, await cdp.eval('location.pathname'))

    const formReady = await cdp.eval(
      `Boolean(document.querySelector('.login-card') && document.querySelector('input[type=password]'))`
    )
    check('登录页表单渲染', formReady)

    // ② 注册 → 自动登录 → 进总览
    await cdp.eval(`
      (() => {
        const set = (el, v) => {
          const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          d.set.call(el, v)
          el.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const inputs = [...document.querySelectorAll('.login-card input')]
        // 切到「注册」页签
        ;[...document.querySelectorAll('.login-tab')].find(b => b.textContent.trim() === '注册').click()
        set(inputs[0], ${JSON.stringify(username)})
        set(inputs[1], ${JSON.stringify(password)})
        return inputs.length
      })()
    `)
    await sleep(200)
    await cdp.eval(`document.querySelector('.login-submit').click()`)

    await cdp.waitFor(`location.pathname === '/dashboard'`, '登录后跳到总览', 15000)
    check('注册后自动登录并进入总览', true, await cdp.eval('location.pathname'))

    await cdp.waitFor(
      `document.body.innerText.includes('求职总览')`,
      '总览页内容渲染'
    )
    check('总览页渲染出内容', true)

    const stored = await cdp.eval(`Boolean(localStorage.getItem('jh_token'))`)
    check('token 已写入 localStorage', stored)

    const sidebarUser = await cdp.eval(`(document.querySelector('.sidebar-user')||{}).textContent||''`)
    check('侧边栏显示当前账号', sidebarUser.trim() === username, sidebarUser.trim())

    // ③ token 失效 → 自动弹回登录页
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
