const $ = (s) => document.querySelector(s)

// 去掉孤立代理项 + 按字形截断。
// 直接 slice 会切在 emoji 中间，把代理对劈成单个 → 界面上显示成 �（乱码来源）
function safeText(s) {
  return String(s == null ? '' : s).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    ''
  )
}
function truncate(s, n) {
  const str = safeText(s)
  if (str.length <= n) return str
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'grapheme' })
    const parts = Array.from(seg.segment(str), (x) => x.segment)
    return parts.length > n ? parts.slice(0, n).join('') + '…' : str
  } catch (_) {
    const parts = [...str]
    return parts.length > n ? parts.slice(0, n).join('') + '…' : str
  }
}

function log(msg) {
  $('#log').textContent = msg
}

// 额度按平台分开：双线并行时共用一个池子，实习僧会把 BOSS 的份额吃掉
async function refreshQuota() {
  const fmt = (q, name) => {
    if (!q) return `${name} -/-`
    const full = q.limit > 0 && q.used >= q.limit
    return `${name} ${q.used}/${q.unlimited ? '不限' : q.limit}${full ? ' ⛔' : ''}`
  }
  try {
    const [sx, boss] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getQuota', platform: '实习僧' }),
      chrome.runtime.sendMessage({ action: 'getQuota', platform: 'BOSS直聘' }),
    ])
    $('#quota-sx').textContent = fmt(sx, '实习僧')
    $('#quota-boss').textContent = fmt(boss, 'BOSS')
    renderQuotaPanel([sx, boss])
  } catch {
    $('#quota-sx').textContent = '实习僧 -/-'
    $('#quota-boss').textContent = 'BOSS -/-'
    const el = document.getElementById('quotaPanel')
    if (el) el.textContent = '额度读取失败 —— 到 chrome://extensions 重载扩展再试'
  }
}

// 额度面板：数字 + 进度条 + 平台官方口径，一屏看清「还能投多少、为什么是这个数」
function renderQuotaPanel(qs) {
  const el = document.getElementById('quotaPanel')
  if (!el) return
  el.innerHTML = qs
    .filter(Boolean)
    .map((q) => {
      const unlimited = !!q.unlimited
      const pct = unlimited ? 100 : q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0
      const full = !unlimited && q.limit > 0 && q.used >= q.limit
      const cls = unlimited ? 'unlimited' : full ? 'full' : pct >= 80 ? 'warn' : ''
      const left = unlimited ? '不限量' : `还剩 ${Math.max(0, q.limit - q.used)} 家`
      const official = q.officialDaily
        ? `平台 ${q.officialDaily} 次（${q.officialWarn} 会提醒）→ 我们停在 ${unlimited ? '不限' : q.limit}`
        : unlimited
          ? '平台未公布上限 → 不设限'
          : `平台未公布上限 → 我们自设 ${q.limit}`
      return `<div class="qrow ${cls}">
        <div class="qtop"><b>${q.name}</b><span>今日 ${q.used} / ${unlimited ? '不限' : q.limit}</span></div>
        <div class="qbar"><i style="width:${pct}%"></i></div>
        <div class="qnote">${left}　·　${official}</div>
      </div>`
    })
    .join('')
}

// 近 7 天分平台投递量：判断「今天投得比平时多还是少」用
async function refreshHistory() {
  const el = document.getElementById('historyList')
  if (!el) return
  try {
    const r = await chrome.runtime.sendMessage({ action: 'quotaHistory', days: 7 })
    const rows = (r && r.rows) || []
    if (!rows.length) {
      el.textContent = '暂无记录'
      return
    }
    const p = (n) => String(n).padStart(3, ' ')
    const sumB = rows.reduce((a, x) => a + x.boss, 0)
    const sumS = rows.reduce((a, x) => a + x.sx, 0)
    el.textContent = [
      ...rows.map((x) => `${x.day}　BOSS ${p(x.boss)}　实习僧 ${p(x.sx)}`),
      '─'.repeat(28),
      `合计　　　　BOSS ${p(sumB)}　实习僧 ${p(sumS)}`,
    ].join('\n')
  } catch {
    el.textContent = '读取失败'
  }
}

// 上限输入框：读一次回填，改完即存（存的是该平台的日上限）
async function initLimits() {
  for (const [id, platform] of [
    ['lim-sx', '实习僧'],
    ['lim-boss', 'BOSS直聘'],
  ]) {
    const el = document.getElementById(id)
    if (!el) continue
    try {
      const q = await chrome.runtime.sendMessage({ action: 'getQuota', platform })
      if (q) el.value = q.limit
    } catch {
      /* 读不到就保留 HTML 里的默认值 */
    }
    el.addEventListener('change', async () => {
      const res = await chrome.runtime.sendMessage({ action: 'setDailyLimit', platform, limit: el.value })
      if (res && res.ok) {
        el.value = res.limit
        log(`${platform} 每日上限已设为 ${res.unlimited ? '不限' : res.limit}`)
        refreshQuota()
      } else {
        log(`❌ 上限设置失败`)
      }
    })
  }
}
initLimits()

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab || !tab.id) throw new Error('未找到当前标签页')
  return tab
}

async function apply(force = false) {
  const greeting = $('#greeting').value
  const autoClick = $('#autoClick').checked
  log(force ? '强制继续（已跳过风控检测）…' : '投递中…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'apply', greeting, autoClick, force })
    if (res && res.jumped) {
      // BOSS 点「立即沟通」会整页跳到聊天页，这一句之后就由聊天页自己发消息
      log('⏳ 已点「立即沟通」，正跳到聊天页发送…\n发送结果稍后显示在这里，别关页面')
    } else if (res && res.needManual) {
      // 半自动模式走到「已高亮、等你手动点」是正常流程，不该显示成红色失败。
      // ⚠️ 这个分支必须排在 ok 前面：半自动返回的是 ok:true，否则永远走进 ✅ 那条
      log(`👉 ${res.error || res.message || '已填好，请手动点提交'}`)
    } else if (res && res.ok) {
      const detail = res.message || (res.autoClicked ? '已自动点击投递' : '已填好打招呼语，请手动点投递按钮')
      const quotaText =
        res.limit > 0
          ? `本平台今日 ${res.used}/${res.limit}，还剩 ${Math.max(0, res.limit - res.used)}`
          : `本平台今日 ${res.used} 次（不限）`
      log(`✅ ${res.company} · ${res.jobTitle}\n${detail}（${quotaText}）`)
    } else {
      log(`❌ ${(res && res.error) || '执行失败'}`)
    }
  } catch (e) {
    // 跳到新页面的瞬间 content script 会断开，sendMessage 必然 reject —— 这不是错误
    log('⏳ 页面正在跳转，结果稍后显示在这里…\n（等 10 秒没反应，就去聊天页点「探测页面结构」）')
  }
  refreshQuota()
}

async function inspect() {
  log('探测中…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'inspect' })
    $('#inspectOut').textContent = JSON.stringify(res, null, 2)
    log('已获取页面结构，展开下方「页面结构」查看')
  } catch (e) {
    log('❌ 请先打开「实习僧 / BOSS 直聘」页面')
  }
}

document.getElementById('applyBtn').addEventListener('click', () => apply(false))
document.getElementById('forceBtn').addEventListener('click', () => apply(true))
document.getElementById('inspectBtn').addEventListener('click', inspect)
document.getElementById('resetBtn').addEventListener('click', async () => {
  // 不传 platform = 两个平台一起清零
  await chrome.runtime.sendMessage({ action: 'resetQuota' })
  log('已重置：实习僧、BOSS 两个平台的今日计数都归零')
  refreshQuota()
})

// 防封配置：仅投 BOSS 活跃岗位 + 关键词黑名单
async function initFilters() {
  const {
    bossActiveOnly = false,
    filterKeywords = '',
    // 默认全自动：半自动「只填不发」在 BOSS 上等于什么都没做
    // （BOSS 的投递就是发那条消息），留着容易以为投了其实没发。
    autoClick = true,
  } = await chrome.storage.local.get(['bossActiveOnly', 'filterKeywords', 'autoClick'])
  $('#bossActiveOnly').checked = !!bossActiveOnly
  $('#filterKeywords').value = filterKeywords
  $('#autoClick').checked = !!autoClick
}
$('#bossActiveOnly').addEventListener('change', () => {
  chrome.storage.local.set({ bossActiveOnly: $('#bossActiveOnly').checked })
})
$('#autoClick').addEventListener('change', () => {
  chrome.storage.local.set({ autoClick: $('#autoClick').checked })
})
$('#filterKeywords').addEventListener('change', () => {
  chrome.storage.local.set({ filterKeywords: $('#filterKeywords').value })
})
initFilters()

refreshQuota()
refreshBatch()
refreshApplied()

// ===================== 批量投递（双线并行） =====================
// 两条线各存 batch:sx / batch:boss，互不覆盖，所以能同时跑。
// 老版本只有单一 'batch' 键：读不到线键时看一眼老键属不属于这条线（只读兼容，不迁移）。
const LINES = [
  { key: 'sx', name: '实习僧', pattern: '*://*.shixiseng.com/*' },
  { key: 'boss', name: 'BOSS 直聘', pattern: '*://*.zhipin.com/*' },
]

// 进度条用方块字符，避免为了一根进度条引入额外 DOM
function progressBar(done, total) {
  const n = 10
  const filled = total ? Math.min(n, Math.round((done / total) * n)) : 0
  return '█'.repeat(filled) + '░'.repeat(n - filled)
}

async function readBatchLine(line) {
  try {
    const key = `batch:${line}`
    const r = await chrome.storage.local.get([key, 'batch'])
    if (r[key]) return r[key]
    const legacy = r.batch
    if (legacy && Array.isArray(legacy.queue) && legacy.queue.length) {
      const legacyIsBoss = /zhipin\.com/i.test(String(legacy.queue[0]))
      if ((line === 'boss') === legacyIsBoss) return legacy
    }
    return null
  } catch {
    return null
  }
}

function renderLine(line, b) {
  const box = document.getElementById(`line-${line}`)
  const infoEl = document.getElementById(`info-${line}`)
  const stateEl = document.getElementById(`state-${line}`)
  const qEl = document.getElementById(`queue-${line}`)
  if (!box || !infoEl || !stateEl) return

  if (!b) {
    box.className = 'linebox'
    stateEl.textContent = '未启动'
    infoEl.textContent = '—'
    if (qEl) qEl.textContent = ''
    return
  }

  const total = b.total || (b.queue || []).length
  const done = (b.results || []).length
  const okCount = (b.results || []).filter((r) => r.ok).length
  const skipCount = (b.results || []).filter((r) => r.skipped).length
  const failCount = done - okCount - skipCount

  // 卡住检测：BOSS 正常间隔 30~60s，阈值要比实习僧宽，否则一直误报
  const lastMs = b.lastAt ? new Date(b.lastAt).getTime() : new Date(b.startedAt || Date.now()).getTime()
  const idleSec = Math.max(0, Math.round((Date.now() - lastMs) / 1000))
  const stuckAt = line === 'boss' ? 130 : 95
  const stuck = b.running && idleSec > stuckAt

  // 最近 3 家的明细：只看汇总的话，出了错根本不知道为什么失败
  const recent = (b.results || []).slice(-3).map((r) => {
    const tag = r.ok ? '✅' : r.skipped ? '⏭️' : '❌'
    return `· ${truncate(r.title, 18) || '(无标题)'}｜${tag} ${truncate(r.message, 46)}`
  })

  const lines = [
    `${progressBar(done, total)} ${done}/${total}　成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount}${b.force ? '　[跳过风控]' : ''}`,
    b.stopReason ? `原因：${truncate(b.stopReason, 110)}` : '',
    stuck ? `⚠️ 已 ${idleSec} 秒没动静，可能卡住了` : '',
    ...recent,
    b.running && b.queue && b.queue[b.index]
      ? `下一家：${(b.titles && b.titles[b.index]) || b.queue[b.index]}`
      : '',
  ].filter(Boolean)

  box.className = 'linebox' + (b.running ? ' running' : '') + (stuck ? ' stuck' : '')
  stateEl.textContent = b.running ? (stuck ? `卡住 ${idleSec}s` : '进行中') : '已结束'
  infoEl.textContent = lines.join('\n')

  // 队列清单：让你看清整批要投哪些、投到哪了
  if (qEl) {
    qEl.textContent = (b.queue || [])
      .map((u, i) => {
        const r = (b.results || [])[i]
        const mark = r ? (r.ok ? '✅' : r.skipped ? '⏭️' : '❌') : i === b.index && b.running ? '▶️' : '○'
        const t = (b.titles && b.titles[i]) || u
        return `${String(i + 1).padStart(2, ' ')}. ${mark} ${truncate(t, 22)}`
      })
      .join('\n') || '—'
  }
}

async function refreshBatch() {
  for (const L of LINES) {
    renderLine(L.key, await readBatchLine(L.key))
  }
}

// 找这条线的标签页：优先列表页（详情页上启动抓不到岗位链接）
async function findLineTab(line) {
  const L = LINES.find((x) => x.key === line)
  if (!L) return null
  let tabs = []
  try {
    tabs = await chrome.tabs.query({ url: L.pattern })
  } catch {
    return null
  }
  const usable = tabs.filter((t) => t && t.id && t.url)
  const isDetail = (u) => /job_detail\/|shixiseng\.com\/intern\/inn_/i.test(u)
  const isList = (u) => /search|joblist|geek\/job|interns|jobs?\?|keyword=/i.test(u)
  const lists = usable.filter((t) => !isDetail(t.url))
  return lists.find((t) => isList(t.url)) || lists[0] || usable[0] || null
}

async function startLine(line, limit, force) {
  const L = LINES.find((x) => x.key === line) || { name: line }
  const tab = await findLineTab(line)
  if (!tab) {
    return { ok: false, error: `没找到「${L.name}」的标签页 —— 先在浏览器打开它的搜索结果列表页` }
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, { action: 'batchStart', limit, force })
  } catch {
    return { ok: false, error: `「${L.name}」那个标签页还没注入脚本，刷新一下再试` }
  }
}

async function stopLine(line) {
  const tab = await findLineTab(line)
  if (!tab) return { ok: false, error: '没找到该平台的标签页' }
  try {
    return await chrome.tabs.sendMessage(tab.id, { action: 'batchStop' })
  } catch {
    return { ok: false, error: '页面正在跳转，等两秒再停' }
  }
}

// 每 1.5 秒刷新一次：原来只在打开 popup 那一刻读一次，
// 所以批量在后台继续跑时界面永远停在同一格（2026-10-30 用户以为卡住就是这个原因）
setInterval(refreshBatch, 1500)
// 额度变化比进度慢得多，5 秒一次就够（1.5 秒会白读 4 次 storage）
setInterval(refreshQuota, 5000)

// ===================== 跳页投递的结果回显 =====================
// BOSS 点「立即沟通」是整页跳转，原来 sendMessage 的响应必然丢失，界面看不到结果。
// content 在聊天页发完消息后写 lastBossResult，这里轮询补上。
let shownBossAt = null
async function refreshJumpResult() {
  try {
    const { lastBossResult: r } = await chrome.storage.local.get('lastBossResult')
    if (!r || !r.at || r.at === shownBossAt) return
    shownBossAt = r.at
    // 超过 5 分钟的旧结果不弹，避免一打开 popup 就显示上次的
    if (Date.now() - new Date(r.at).getTime() > 300000) return
    const head = `${r.ok ? '✅' : '❌'} ${r.company || ''}${r.jobTitle ? ` · ${r.jobTitle}` : ''}`
    log(`${head}\n${r.message || ''}`)
  } catch (_) {
    /* 读不到就算了，不影响主流程 */
  }
}
setInterval(refreshJumpResult, 1500)

// ===================== 本地投递账本 =====================
// 页面不一定显示「已投递」，所以状态以本地账本为准，页面显示只作参考
function fmtWhen(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function refreshApplied() {
  const curEl = $('#appliedInfo')
  const listEl = $('#appliedList')
  try {
    const tab = await activeTab()
    let state = null
    try {
      state = await chrome.tabs.sendMessage(tab.id, { action: 'appliedState' })
    } catch {
      state = null
    }
    const list = await chrome.runtime.sendMessage({ action: 'listApplied', limit: 8 })
    const total = (list && list.total) || 0

    // ① 当前岗位状态 → 单次投递页
    if (state && state.ok) {
      const localHit = !!(state.local && state.local.applied)
      const pageHit = !!(state.page && state.page.applied)
      if (localHit) {
        const when = state.local.at ? fmtWhen(state.local.at) : ''
        curEl.textContent = `✅ 已投过${when ? `（${when}）` : ''}${
          state.local.verified === false ? '\n⚠️ 当时没抓到成功提示，可能没投成' : ''
        }`
      } else if (pageHit) {
        curEl.textContent = `✅ 页面显示已投（${state.page.btnText}）`
      } else {
        curEl.textContent = '⬜ 账本里没有，页面也没显示已投'
      }
      if (!state.jobId) curEl.textContent += '\n⚠️ 识别不到岗位 id（请打开岗位详情页）'
    } else {
      curEl.textContent = '— 读取失败（刷新页面后再试）'
    }

    // ② 账本历史 → 记录页
    const lines = [`共 ${total} 条`]
    const rows = (list && list.list) || []
    if (!rows.length) lines.push('（还没有记录）')
    rows.forEach((x) => {
      lines.push(`· ${fmtWhen(x.at)} ${x.title || x.jobId}${x.verified === false ? '（未确认）' : ''}`)
    })
    if (total > rows.length) lines.push(`… 还有 ${total - rows.length} 条`)
    listEl.textContent = lines.join('\n')
  } catch {
    curEl.textContent = '—'
    listEl.textContent = '—'
  }
}

function batchForceChecked() {
  return !!(document.getElementById('batchForce') && document.getElementById('batchForce').checked)
}
function batchLimitValue(def = 5) {
  return Number($('#batchLimit').value) || def
}

function startLogText(res, name) {
  if (res && res.ok) {
    const parts = [`✅ ${name}：${res.total} 家已启动`]
    // 剩余额度不够整批时 content 会主动收缩，这里要说清楚为什么数量变少了
    if (res.shrunk && res.quota) {
      parts.push(`今日剩余额度只剩 ${res.quota.remaining} 家，本批按剩余量收缩`)
    }
    if (res.appliedSkip) parts.push(`本地记录里已投过 ${res.appliedSkip} 家，已排除`)
    if (res.blocked) parts.push(`不符合筛选 ${res.blocked} 家`)
    // 跑之前的额度基线：方便对账「这批投完应该到多少」
    if (res.quota) {
      parts.push(
        res.quota.limit > 0
          ? `今日 ${res.quota.used}/${res.quota.limit}`
          : `今日 ${res.quota.used} 次（不限）`
      )
    }
    return parts.join('；')
  }
  return `❌ ${name}：${(res && res.error) || '启动失败'}`
}

// 双线并发启动：两条线各发一条指令，各自跳自己的标签页，互不等待。
// 真正的并行发生在两个标签页里（各自的 content script 独立推进），popup 只是发令枪。
document.getElementById('batchBothBtn').addEventListener('click', async () => {
  const limit = batchLimitValue()
  const force = batchForceChecked()
  const btn = document.getElementById('batchBothBtn')
  btn.disabled = true
  log(`正在并行启动两条线（每条 ${limit} 家）…`)
  try {
    const results = await Promise.all(LINES.map((L) => startLine(L.key, limit, force)))
    log(results.map((r, i) => startLogText(r, LINES[i].name)).join('\n'))
  } finally {
    btn.disabled = false
    setTimeout(refreshBatch, 800)
  }
})

// 每条线单独的启动 / 停止
for (const L of LINES) {
  const startBtn = document.getElementById(`start-${L.key}`)
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true
      log(`正在启动「${L.name}」这条线…`)
      try {
        const res = await startLine(L.key, batchLimitValue(), batchForceChecked())
        log(startLogText(res, L.name))
      } finally {
        startBtn.disabled = false
        setTimeout(refreshBatch, 500)
      }
    })
  }

  const stopBtn = document.getElementById(`stop-${L.key}`)
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      const res = await stopLine(L.key)
      log(
        res && res.ok
          ? `${L.name}：${res.message || '已请求停止'}`
          : `❌ ${L.name}：${(res && res.error) || '停止失败'}`
      )
      refreshBatch()
    })
  }
}

// 只在当前标签页启动（就在那一页上操作时用）
document.getElementById('batchBtn').addEventListener('click', async () => {
  const limit = batchLimitValue()
  const force = batchForceChecked()
  log(force ? '正在抓取本页岗位链接（本批跳过风控检测）…' : '正在抓取本页岗位链接…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'batchStart', limit, force })
    const name = res && res.line === 'boss' ? 'BOSS 直聘' : res && res.line === 'sx' ? '实习僧' : '当前页'
    log(startLogText(res, name))
  } catch {
    log('❌ 当前页面无法通信（请在实习僧 / BOSS 的搜索结果列表页操作）')
  }
  refreshBatch()
})

document.getElementById('batchStopBtn').addEventListener('click', async () => {
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'batchStop' })
    log((res && res.message) || '已请求停止')
  } catch {
    log('❌ 当前页面无法通信（可能正在跳转）')
  }
  refreshBatch()
})

// 卡住时手动推进：跳到队列里当前该投的那家
document.getElementById('resumeBtn').addEventListener('click', async () => {
  log('正在跳到下一家…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'batchJumpNext' })
    if (res && res.ok) {
      log(`已跳到第 ${res.index}/${res.total} 家：${res.title}`)
    } else {
      log(`❌ ${(res && res.error) || '跳转失败'}`)
    }
  } catch {
    log('❌ 当前页面无法通信（可能正在跳转），等两秒再点')
  }
  setTimeout(refreshBatch, 800)
})

// ===================== 标签页切换 =====================
function initTabs() {
  const tabs = [...document.querySelectorAll('.tab')]
  const activate = (name) => {
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === name))
    document.querySelectorAll('.pane').forEach((p) => {
      p.classList.toggle('active', p.id === `pane-${name}`)
    })
    if (name === 'records') refreshHistory()
    chrome.storage.local.set({ popupTab: name })
  }
  tabs.forEach((t) => {
    t.addEventListener('click', () => activate(t.dataset.tab))
  })
  // 记住上次停留的标签页，重开不用重新点
  chrome.storage.local.get('popupTab', (r) => {
    const saved = r && r.popupTab
    if (saved && document.getElementById(`pane-${saved}`)) activate(saved)
  })
}
initTabs()

// ===================== 账本按钮 =====================
$('#checkAppliedBtn').addEventListener('click', () => {
  refreshApplied()
})

$('#markAppliedBtn').addEventListener('click', async () => {
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'markCurrentApplied' })
    if (res && res.ok) log(`✅ 已记为已投（账本共 ${res.total} 条），之后不会重复投这家`)
    else log(`❌ ${(res && res.error) || '标记失败'}`)
  } catch {
    log('❌ 当前页面无法通信（请打开岗位详情页）')
  }
  refreshApplied()
})

$('#clearAppliedBtn').addEventListener('click', async () => {
  // 清空 = 放弃所有防重复投递保护，必须二次确认
  if (!window.confirm('确定清空全部投递记录？清空后无法再防止重复投递。')) return
  await chrome.runtime.sendMessage({ action: 'clearApplied' })
  log('已清空投递记录')
  refreshApplied()
})

// ===================== 投递筛选面板（A 方案配置） =====================
const F = window.JH_FILTERS
const DAY_OPTIONS = [2, 3, 4, 5]
const MONTH_OPTIONS = [1, 2, 3, 4, 6]
const SCORE_OPTIONS = [0, 40, 50, 60, 70]

let jobFilters = { ...F.DEFAULT_FILTERS }

function loadJobFilters() {
  return new Promise((resolve) => {
    chrome.storage.local.get('filters', (r) => {
      jobFilters = { ...F.DEFAULT_FILTERS, ...(r.filters || {}) }
      if (!Array.isArray(jobFilters.cities)) jobFilters.cities = []
      if (!Array.isArray(jobFilters.directions)) jobFilters.directions = []
      resolve(jobFilters)
    })
  })
}

function saveJobFilters() {
  chrome.storage.local.set({ filters: jobFilters })
}

function renderProvinceSelect() {
  const sel = $('#provinceSel')
  sel.innerHTML = ''
  F.PROVINCES.forEach((p) => {
    const o = document.createElement('option')
    o.value = p.name
    o.textContent = p.name
    sel.appendChild(o)
  })
  const first = jobFilters.cities[0]
  if (first) {
    const hit = F.PROVINCES.find((p) => p.cities.includes(first))
    if (hit) sel.value = hit.name
  }
}

function renderCityList() {
  const prov = F.PROVINCES.find((p) => p.name === $('#provinceSel').value)
  const box = $('#cityList')
  box.innerHTML = ''
  if (!prov) return
  prov.cities.forEach((c) => {
    const on = jobFilters.cities.includes(c)
    const label = document.createElement('label')
    label.className = 'chip' + (on ? ' on' : '')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = on
    const span = document.createElement('span')
    span.textContent = c
    label.append(input, span)
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!jobFilters.cities.includes(c)) jobFilters.cities.push(c)
      } else {
        jobFilters.cities = jobFilters.cities.filter((x) => x !== c)
      }
      label.classList.toggle('on', e.target.checked)
      renderPicked()
      saveJobFilters()
    })
    box.appendChild(label)
  })
}

function renderPicked() {
  $('#cityPicked').textContent = jobFilters.cities.length
    ? `已选：${jobFilters.cities.join('、')}`
    : '已选：—（不选 = 不限城市）'
}

function renderDirList() {
  const box = $('#dirList')
  box.innerHTML = ''
  F.DIRECTIONS.forEach((d) => {
    const on = jobFilters.directions.includes(d.id)
    const label = document.createElement('label')
    label.className = 'chip' + (on ? ' on' : '')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = on
    const span = document.createElement('span')
    span.textContent = d.label
    label.append(input, span)
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        if (!jobFilters.directions.includes(d.id)) jobFilters.directions.push(d.id)
      } else {
        jobFilters.directions = jobFilters.directions.filter((x) => x !== d.id)
      }
      label.classList.toggle('on', e.target.checked)
      saveJobFilters()
    })
    box.appendChild(label)
  })
}

function fillSelect(el, list, cur, fmt) {
  el.innerHTML = list.map((v) => `<option value="${v}">${fmt(v)}</option>`).join('')
  el.value = String(cur)
}

async function loadResumeOptions() {
  const sel = $('#resumeSel')
  sel.innerHTML = '<option value="">默认（简历库第一份）</option>'
  try {
    const r = await fetch('http://localhost:3100/api/resumes')
    if (!r.ok) throw new Error('bad status')
    const list = await r.json()
    if (!Array.isArray(list) || !list.length) return
    sel.innerHTML =
      '<option value="">默认（简历库第一份）</option>' +
      list
        .map((x) => `<option value="${x.id}">${(x.title || x.id).replace(/</g, '&lt;')}</option>`)
        .join('')
    // 没选过就默认挑「测试开发」那份，避免默认用了运营版导致分数偏低
    if (!jobFilters.resumeId) {
      const qa = list.find((x) => /测试开发/.test(x.title || ''))
      if (qa) {
        jobFilters.resumeId = qa.id
        saveJobFilters()
      }
    }
    sel.value = jobFilters.resumeId || ''
  } catch {
    sel.innerHTML = '<option value="">后端未启动，读不到简历列表</option>'
  }
}

async function initJobFilters() {
  await loadJobFilters()
  renderProvinceSelect()
  renderCityList()
  renderPicked()
  renderDirList()
  fillSelect($('#daysSel'), DAY_OPTIONS, jobFilters.daysPerWeek || 4, (v) => `${v} 天/周`)
  fillSelect($('#monthsSel'), MONTH_OPTIONS, jobFilters.months || 3, (v) =>
    v === 6 ? '6 个月及以上' : `${v} 个月`
  )
  fillSelect($('#scoreSel'), SCORE_OPTIONS, jobFilters.minScore || 0, (v) =>
    v === 0 ? '不启用' : `≥ ${v} 分`
  )
  $('#filterEnabled').checked = jobFilters.enabled !== false
  $('#strictMeta').checked = !!jobFilters.strictMeta
  await loadResumeOptions()

  $('#provinceSel').addEventListener('change', renderCityList)
  $('#clearCity').addEventListener('click', () => {
    jobFilters.cities = []
    renderCityList()
    renderPicked()
    saveJobFilters()
  })
  $('#daysSel').addEventListener('change', (e) => {
    jobFilters.daysPerWeek = Number(e.target.value)
    saveJobFilters()
  })
  $('#monthsSel').addEventListener('change', (e) => {
    jobFilters.months = Number(e.target.value)
    saveJobFilters()
  })
  $('#scoreSel').addEventListener('change', (e) => {
    jobFilters.minScore = Number(e.target.value)
    saveJobFilters()
  })
  $('#resumeSel').addEventListener('change', (e) => {
    jobFilters.resumeId = e.target.value
    saveJobFilters()
  })
  $('#filterEnabled').addEventListener('change', (e) => {
    jobFilters.enabled = e.target.checked
    saveJobFilters()
  })
  $('#strictMeta').addEventListener('change', (e) => {
    jobFilters.strictMeta = e.target.checked
    saveJobFilters()
  })
}

// 招呼语持久化。BOSS 没有「投递」这个动作，投递＝发这条消息，
// 所以批量时必须有内容（实习僧可以空，BOSS 不能）。
async function initGreeting() {
  const { greeting = '' } = await chrome.storage.local.get('greeting')
  if (greeting && !$('#greeting').value) $('#greeting').value = greeting
  let timer = null
  $('#greeting').addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => chrome.storage.local.set({ greeting: $('#greeting').value }), 400)
  })
}

initGreeting()
initJobFilters()

// ===================== 后端连接 =====================
// 后端加了多用户隔离后，所有 /api 都要带 token。
// content script 里的 backendBase() / authHeaders() 读的就是这两个键，键名必须一致。
const CONN_DEFAULT_BASE = 'http://localhost:3100'

async function testConnection() {
  const base = ($('#backendUrl').value.trim() || CONN_DEFAULT_BASE).replace(/\/+$/, '')
  const token = $('#authToken').value.trim()
  $('#connStatus').textContent = '测试中…'
  try {
    const r = await fetch(`${base}/api/auth/me`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (r.status === 401) {
      $('#connStatus').textContent = '❌ 401：token 无效或已过期，回网页端重新登录再复制'
      return false
    }
    if (!r.ok) {
      $('#connStatus').textContent = `❌ 后端返回 ${r.status}`
      return false
    }
    const u = await r.json()
    $('#connStatus').textContent = `✅ 已连接（${base}），当前账号：${u.username}`
    return true
  } catch (e) {
    $('#connStatus').textContent = `❌ 连不上 ${base}（后端没启动？）`
    return false
  }
}

async function initConnection() {
  const { jhBackend = '', jhToken = '' } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
  $('#backendUrl').value = jhBackend || ''
  $('#authToken').value = jhToken || ''
  if (jhBackend || jhToken) testConnection()
}

$('#saveConnBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({
    jhBackend: $('#backendUrl').value.trim(),
    jhToken: $('#authToken').value.trim(),
  })
  testConnection()
})

// 用账号密码换 token，自动填进 token 框，省去「复制 token 可能弄脏」这一步。
$('#loginBtn').addEventListener('click', async () => {
  const base = ($('#backendUrl').value.trim() || CONN_DEFAULT_BASE).replace(/\/+$/, '')
  const username = $('#loginUser').value.trim()
  const password = $('#loginPass').value
  if (!username || !password) {
    $('#connStatus').textContent = '❌ 先填用户名和密码'
    return
  }
  $('#connStatus').textContent = '登录中…'
  try {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.token) {
      $('#connStatus').textContent = `❌ 登录失败：${j.error || r.status}`
      return
    }
    $('#authToken').value = j.token
    await chrome.storage.local.set({ jhBackend: base, jhToken: j.token })
    $('#connStatus').textContent = '✅ 登录成功，token 已自动填入并保存'
    testConnection()
  } catch (e) {
    $('#connStatus').textContent = `❌ 连不上 ${base}（后端没启动？）`
  }
})

// ---------- 投递进度同步 ----------
// 采集只在「当前页」做，不翻页不点击；上传前必须人工看一眼预览。
// 为什么强制这一步：平台 DOM 一改就可能把公司名抓成奇怪的东西，
// 静默入库之后是脏数据，而脏数据比没数据更难发现。
let collectPreview = null

async function collectProgress(probeMode) {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  $('#collectUploadBtn').disabled = true
  collectPreview = null
  st.textContent = probeMode ? '探测中…' : '采集本页…'
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: probeMode ? 'probe' : 'collect' })
    if (!res || res.ok === false) {
      st.textContent = `❌ ${(res && res.error) || '采集失败'}`
      out.textContent = ''
      return
    }
    const d = res.data || {}
    if (probeMode) {
      out.textContent = JSON.stringify(d, null, 2)
      const m = d.mirror
      st.textContent = m
        ? `探测 ${d.rows ? d.rows.length : 0} 行｜${m.verdict}`
        : `探测 ${d.rows ? d.rows.length : 0} 行（无分类 tab，走文本兜底）`
      return
    }

    collectPreview = Array.isArray(d.items) ? d.items : []
    const dbg = d.debug || {}
    if (!collectPreview.length) {
      st.textContent = `没抓到可用的行（命中 ${dbg.hits || 0} 处｜取不到行 ${dbg.noRow || 0}｜取不到岗位 ${dbg.noName || 0}）`
      out.textContent = JSON.stringify(dbg, null, 2)
      return
    }
    st.textContent = `抓到 ${collectPreview.length} 条 —— 确认无误再上传`
    out.textContent = collectPreview
      .map((x, i) => {
        const stage = x.stageRaw || x.stage || (x.read ? '已读' : '未读')
        const where = x.city ? `${x.company}（${x.city}）` : x.company
        return `${i + 1}. ${where} / ${x.jobTitle} → ${stage}`
      })
      .join('\n')
    $('#collectUploadBtn').disabled = false
  } catch (e) {
    st.textContent = '❌ 请先打开实习僧「我的投递」或 BOSS 对话列表页'
  }
}

const STAGE_CN = {
  submitted: '已投递',
  viewed: '被查看',
  screening: '初筛',
  written: '笔试',
  interview: '面试',
  rejected: '不合格',
  offer: '录用',
}

/**
 * 预览渲染：**按阶段分组**，并标出「这条是按哪个 tab 判的」。
 * 分阶段采集最容易出错的地方就是「阶段判错」，所以预览里必须能一眼看出归属来源。
 */
function renderPreview(items, dbg) {
  const lines = []
  const byStage = new Map()
  for (const it of items) {
    const k = it.stage || 'unknown'
    if (!byStage.has(k)) byStage.set(k, [])
    byStage.get(k).push(it)
  }
  const order = ['submitted', 'viewed', 'screening', 'written', 'interview', 'rejected', 'offer', 'unknown']
  for (const k of order) {
    const list = byStage.get(k)
    if (!list || !list.length) continue
    const label = STAGE_CN[k] || k
    lines.push(`【${label}】${list.length} 条`)
    for (const x of list) {
      const where = x.city ? `${x.company}（${x.city}）` : x.company
      const from = x.fromTab && x.fromTab !== label ? `   ← 来自「${x.fromTab}」tab` : ''
      lines.push(`  · ${where} / ${x.jobTitle}${from}`)
    }
    lines.push('')
  }

  const tabs = (dbg.tabs || []).filter((t) => t.rows)
  if (tabs.length) {
    lines.push('各分类 tab 命中：')
    for (const t of tabs) {
      const tag = t.mirrored ? '镜像·只信行内文案' : t.paged ? '真分组·已翻页' : '仅第 1 页'
      lines.push(`  ${t.name}（${tag}）→ ${t.rows} 条 / ${t.pages} 页` + (t.note ? `｜${t.note}` : ''))
    }
  }
  if (dbg.baseTab) {
    lines.push(`\n基线 tab：${dbg.baseTab}（行最多的那个；与它集合相同的 tab 判为镜像，tab 名不参与阶段判定）`)
  }
  if (dbg.mirrored) {
    lines.push(`判定：${dbg.mirrored} 个 tab 与基线列表完全相同 → 全量镜像，阶段只信行内文案`)
  } else if (dbg.grouped) {
    lines.push('判定：各 tab 列表互不相同 → 真分组，阶段按 tab 名判定')
  }
  if (dbg.mode === 'single') lines.push('\n未识别到分类 tab（BOSS 列表或平台改版），按单视图翻页采集')
  if (dbg.notes && dbg.notes.length) lines.push(`\n[提示] ${dbg.notes.join('；')}`)
  return lines.join('\n')
}

// 全阶段采集：content.js 逐一切换分类 tab（已投递/被查看/初筛/…）并翻页，
// 按 jobId 合并取权重最大的阶段。不是 tab 页面时自动退回单视图翻页。
async function collectAllProgress() {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  $('#collectUploadBtn').disabled = true
  collectPreview = null
  st.textContent = '按阶段采集中…（会依次切各个分类 tab 并翻页，约 10~30 秒，别关弹窗）'
  out.textContent = ''
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'collectAll' })
    if (!res || res.ok === false) {
      st.textContent = `❌ ${(res && res.error) || '采集失败'}`
      return
    }
    const d = res.data || {}
    const items = Array.isArray(d.items) ? d.items : []
    const dbg = d.debug || {}
    if (!items.length) {
      st.textContent = `没抓到可用的行（${dbg.stopped || '该页面没有投递记录'}）`
      out.textContent = renderPreview([], dbg)
      return
    }
    collectPreview = items

    const hitTabs = (dbg.tabs || []).filter((t) => t.rows).length
    const where = dbg.mode === 'single' ? '单视图翻页' : `${hitTabs} 个阶段 tab`
    st.textContent = `采集到 ${items.length} 条（${where}，共 ${dbg.pages || 1} 页）—— 确认无误再上传`
    out.textContent = renderPreview(items, dbg)
    $('#collectUploadBtn').disabled = false
  } catch (e) {
    st.textContent = '❌ 请先打开实习僧「我的投递 → 投递反馈」页'
  }
}

// 一键：按阶段采集 → 过滤已同步且没变化的 → 直接上传 → 显示整体汇总。
async function collectAndUpload() {
  const btn = $('#collectOneClickBtn')
  // 采集要切 7 个 tab、翻页，耗时几秒到几十秒；不禁用的话连点两次会两路同时点 tab 互相打架
  if (btn.disabled) return
  btn.disabled = true
  try {
    await runCollectAndUpload()
  } finally {
    btn.disabled = false
  }
}

async function runCollectAndUpload() {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  await collectAllProgress()
  if (!collectPreview || !collectPreview.length) return

  // 过滤掉「上次已同步、阶段也没变」的，只报有变化的部分
  const before = collectPreview.length
  collectPreview = await filterAlreadySynced(collectPreview)
  const skipped = before - collectPreview.length
  if (!collectPreview.length) {
    st.textContent = `✅ 无新变化（${before} 条均已同步且阶段未变）`
    out.textContent =
      '平台没往后推进，没有需要更新的。\n\n想确认「全阶段采集」本身抓到了什么，点「全阶段采集（先看预览）」。'
    $('#collectUploadBtn').disabled = true
    return
  }
  if (skipped > 0) {
    out.textContent = `已跳过 ${skipped} 条未变化的，剩余 ${collectPreview.length} 条待上报：\n\n` + out.textContent
  }
  await uploadProgress()
  // 上传成功后把本次的 jobId+阶段 记进缓存（无论 matched 还是 created，都算「已同步」）
  await rememberSynced(collectPreview)
}

// 「已同步」缓存：记下上次上传时「jobId + 阶段」的组合。
// 下次采集时，jobId 相同且阶段没变的直接跳过（省重复请求），阶段变了的照报（不漏推进）。
// 存 chrome.storage.local，键 jhSyncedJobs = { [jobId]: stageKey }。
async function filterAlreadySynced(items) {
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  return items.filter((it) => {
    const id = it.jobId
    if (!id) return true // 没有 jobId 的没法判断，照报
    const prevStage = jhSyncedJobs[id]
    return prevStage !== it.stage // 阶段变了要报；没变过或没记过的也报（prevStage undefined 时 !== 成立）
  })
}

async function rememberSynced(items) {
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  const next = { ...jhSyncedJobs }
  for (const it of items) {
    if (it.jobId && it.stage) next[it.jobId] = it.stage
  }
  await chrome.storage.local.set({ jhSyncedJobs: next })
}

async function uploadProgress() {
  if (!collectPreview || !collectPreview.length) return
  const st = $('#collectStatus')
  const out = $('#collectOut')
  const { jhBackend, jhToken } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
  const base = (jhBackend || 'http://localhost:3100').replace(/\/+$/, '')
  st.textContent = '上传中…'
  try {
    const r = await fetch(`${base}/api/applications/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jhToken ? { Authorization: `Bearer ${jhToken}` } : {}),
      },
      body: JSON.stringify({ items: collectPreview }),
    })
    if (r.status === 401) {
      st.textContent = '❌ 401：先在下面「后端连接」里填 token'
      return
    }
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      st.textContent = `❌ 后端返回 ${r.status}：${data.error || ''}`
      return
    }
    // 整体汇总：把上报条数 + 后端处理结果一起呈现，扫一眼就知道干了什么
    const lines = []
    lines.push(`上报 ${collectPreview.length} 条，已提交后端：`)
    lines.push(`  · 匹配 ${data.matched || 0}（本地已有这条投递）`)
    lines.push(`  · 推进 ${data.advancedCount || 0}（阶段往前走了）`)
    lines.push(`  · 新建 ${data.created || 0}（本地账本没有，新入库）`)
    lines.push(`  · 忽略 ${data.ignored || 0}（对不上，未入库）`)
    if (data.matched && !data.advancedCount) lines.push('')
    if (data.matched && !data.advancedCount) lines.push('阶段没变化 = 平台还没往后走，正常。')
    st.textContent =
      `✅ 完成｜匹配 ${data.matched || 0}｜推进 ${data.advancedCount || 0}` +
      `｜新建 ${data.created || 0}｜忽略 ${data.ignored || 0}`
    out.textContent = lines.join('\n')
    $('#collectUploadBtn').disabled = true
  } catch (e) {
    st.textContent = `❌ 连不上 ${base}（后端没启动？）`
  }
}

document.getElementById('collectBtn').addEventListener('click', () => collectProgress(false))
document.getElementById('collectAllBtn').addEventListener('click', collectAllProgress)
document.getElementById('collectOneClickBtn').addEventListener('click', collectAndUpload)
document.getElementById('collectProbeBtn').addEventListener('click', () => collectProgress(true))
document.getElementById('collectUploadBtn').addEventListener('click', uploadProgress)

initConnection()
