// 验证 content.js 里的 jobIdOf / currentJobId 在实习僧与 BOSS 两种 URL 下都能正确取 id。
// 做法：用 vm 加载真实的 content.js（stub 掉 chrome / document / location），
// 直接调真函数，而不是把正则抄一遍来测（抄一遍等于没测）。
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8')

function makeContext(href) {
  const u = new URL(href)
  const noop = () => {}
  const el = () => ({
    innerText: '',
    className: '',
    style: {},
    children: [],
    offsetHeight: 0,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }),
    click: noop,
    scrollIntoView: noop,
  })
  const document = {
    title: '',
    body: { innerText: '' },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: el,
  }
  const chrome = {
    runtime: { onMessage: { addListener: noop }, sendMessage: async () => ({ ok: true }) },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  }
  const ctx = {
    location: { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search },
    document,
    chrome,
    window: {},
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    Date,
    Math,
    JSON,
    Intl,
    Promise,
    RegExp,
    String,
    Number,
    Object,
    Array,
    Error,
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(src, ctx, { filename: 'content.js' })
  return ctx
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass++
  else fail++
  console.log(ok ? '✅' : '❌', name, ok ? '' : `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

// ---- 实习僧 ----
check(
  '实习僧详情页',
  makeContext('https://www.shixiseng.com/intern/inn_abc123xyz?from=menu').jobIdOf(
    'https://www.shixiseng.com/intern/inn_abc123xyz?from=menu'
  ),
  'inn_abc123xyz'
)

// ---- BOSS：path 形式 ----
check(
  'BOSS /job_detail/xxx.html',
  makeContext('https://www.zhipin.com/job_detail/1a2b3c4d5e.html?lid=abc&securityId=xyz').jobIdOf(
    'https://www.zhipin.com/job_detail/1a2b3c4d5e.html?lid=abc&securityId=xyz'
  ),
  'boss_1a2b3c4d5e'
)

// ---- BOSS：query 形式 ----
check(
  'BOSS ?jobId=xxx',
  makeContext('https://www.zhipin.com/job_detail/?jobId=9f8e7d6c&lid=1').jobIdOf(
    'https://www.zhipin.com/job_detail/?jobId=9f8e7d6c&lid=1'
  ),
  'boss_9f8e7d6c'
)

// ---- 关键回归：两个 BOSS 岗位不能被判成同一个（旧代码两边都返回 ''，'' === '' 恒真）----
const a = makeContext('https://www.zhipin.com/job_detail/aaa111.html')
const b = makeContext('https://www.zhipin.com/job_detail/bbb222.html')
const idA = a.jobIdOf('https://www.zhipin.com/job_detail/aaa111.html')
const idB = b.jobIdOf('https://www.zhipin.com/job_detail/bbb222.html')
check('BOSS 不同岗位 id 不同', idA !== idB && idA !== '' && idB !== '', true)

// ---- currentJobId 与 jobIdOf 必须一致（同一概念不能两套实现）----
const c = makeContext('https://www.zhipin.com/job_detail/1a2b3c4d5e.html?lid=x')
check('currentJobId 与 jobIdOf 一致', c.currentJobId(), c.jobIdOf(c.location.href))

// ---- 列表页 / 非详情页不该被当岗位 ----
check(
  'BOSS 列表页返回空',
  makeContext('https://www.zhipin.com/web/geek/jobs?query=测试').jobIdOf(
    'https://www.zhipin.com/web/geek/jobs?query=测试'
  ),
  ''
)

// ---- 平台识别 ----
check('平台识别 BOSS', makeContext('https://www.zhipin.com/job_detail/x.html').platform(), 'BOSS直聘')
check('平台识别 实习僧', makeContext('https://www.shixiseng.com/intern/inn_x').platform(), '实习僧')

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
