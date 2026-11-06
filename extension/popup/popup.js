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

/**
 * 岗位标题 → 方向标签（弹窗侧用）。
 *
 * 为什么弹窗也要有一份：采集/补传都是弹窗发起的，带上 direction 才能让「按方向看漏斗」
 * 有数据。content.js 里那份只在**投递那一刻**跑得到，历史账本补传时早就没有那个上下文了。
 * 规则必须一致（按 DIRECTIONS 声明顺序取第一个命中），否则同一个岗位
 * 「投的时候记成 A、补传成 B」，按方向分组会凭空多一类。
 */
function directionOfTitle(title) {
  const F = window.JH_FILTERS
  if (!F || !Array.isArray(F.DIRECTIONS)) return ''
  const t = String(title || '').toLowerCase()
  for (const d of F.DIRECTIONS) {
    if (d.keywords.some((k) => F.hitKeyword(t, k))) return d.label
  }
  return ''
}

// 扩展版本：排查「改了代码却没生效」的第一现场。
// 页面里跑的 content 脚本可能是重载扩展**之前**注入的，只有刷新页面才会换新。
function extVersion() {
  try {
    return chrome.runtime.getManifest().version
  } catch {
    return ''
  }
}

;(() => {
  const el = document.getElementById('extVer')
  if (el) el.textContent = extVersion() ? `v${extVersion()}` : ''
})()

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
  // 只剩「当前页」一条线，状态固定渲染到单一容器（id 不再带 line 后缀）。
  const box = document.getElementById('line-current')
  const nameEl = document.getElementById('line-current-name')
  const infoEl = document.getElementById('info-current')
  const stateEl = document.getElementById('state-current')
  const qEl = document.getElementById('queue-current')
  if (!box || !infoEl || !stateEl) return

  if (nameEl) nameEl.textContent = line === 'boss' ? 'BOSS 直聘' : '实习僧'

  if (!b) {
    box.className = 'linebox'
    stateEl.textContent = '未启动'
    infoEl.textContent = '—'
    if (qEl) qEl.textContent = ''
    const pEl = document.getElementById('pending-current')
    if (pEl) pEl.textContent = ''
    return
  }

  const total = b.total || (b.queue || []).length
  const done = (b.results || []).length
  const okCount = (b.results || []).filter((r) => r.ok).length
  const skipCount = (b.results || []).filter((r) => r.skipped).length
  const failCount = done - okCount - skipCount
  // 本轮（可能 4 个词）累计投出去多少家：已经跑完的词只留在 kwStats 里，
  // 当前这个词的成功数在 kwOk（跨页累积）/ results 里。不加这些，
  // 跑到第 4 个词时界面会说「本批没有开投」，把前 3 个词投的成果整个抹掉（2026-11-05 真机）
  const kwIdxNow = Number(b.kwIndex) || 0
  const kwStats = Array.isArray(b.kwStats) ? b.kwStats : []
  const prevOk = kwStats
    .filter((x) => x && Number(x.i) !== kwIdxNow)
    .reduce((s, x) => s + (Number(x.ok) || 0), 0)
  // kwOk 才是当前词的真值（翻页会把 results 清零）；老批次没有 kwOk 就退回数 results，
  // 两者不能相加 —— 那是同一个词的同一批成功数，加两次就是虚报
  const okAll = prevOk + (Number(b.kwOk) || okCount)

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
    // 版本对不上 = 这批是改代码前跑的老结果，数字不代表当前逻辑。
    // 不提示的话，旧记录看起来和「刚跑的结果」一模一样（2026-11-05 真踩）
    b.codeVersion && b.codeVersion !== extVersion()
      ? `⚠️ 这批由 v${b.codeVersion} 跑的，当前扩展是 v${extVersion()} —— 重新加载扩展 + 页面 F5 再跑一次，新逻辑才生效`
      : '',
    // 扫描模式：这批还没开投，只是在往后翻找有活可干的页。
    // 这时候队列是空的（0/0），照常打进度条就是「0/0 进行中」的鬼状态
    b.paging && b.paging.scanOnly && b.running
      ? `↻ 本页没有可投岗位，正在往第 ${b.paging.page} 页找（最多看到第 ${b.paging.maxPages} 页）…`
      : // 队列从头就是空的（翻页也没找到活）→ 别显示「0/0 成功 0」，那看着像跑完了
        !total
        ? okAll > 0
          ? `— 当前这轮没开投；本轮 ${(b.kwUrls || []).length || ''} 个搜索已合计投出 ${okAll} 家（明细见「本轮明细」）`
          : '— 本批没有开投：这一页没有可投的岗位'
        : `${progressBar(done, total)} ${done}/${total}　成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount}${b.force ? '　[跳过风控]' : ''}`,
    // 整批的范围：长跑期间一直挂着，投错了能立刻看出「当初是按什么范围抓的」
    b.scope ? `范围：${truncate(b.scope, 90)}${b.scopeRisky ? '　⚠️ 不限关键词' : ''}` : '',
    // 多关键词轮换：现在跑到第几个词、下一个是什么 —— 不然用户不知道还剩几个词没跑
    b.kwUrls && b.kwUrls.length > 1
      ? `搜索：第 ${(Number(b.kwIndex) || 0) + 1}/${b.kwUrls.length} 个「${kwOfUrl(b.kwUrls[Number(b.kwIndex) || 0]) || '?'}」`
      : '',
    // 各词总账：换词时 queue / results 会被重置，不单独记就只剩最后一个词的结果，
    // 用户按一次「一键投递」跑了 4 个词、最后只看到第 4 个词的「3 家被拦」，
    // 前 3 个投了什么都无从得知（2026-11-05 真机）
    b.kwStats && b.kwStats.length
      ? `本轮明细：\n${b.kwStats.map((x) => `  · ${(x && x.line) || x}`).join('\n')}`
      : '',
    // 翻页进度：翻页自检失败时这里会写原因，这是排查「怎么只投了一页」的第一现场
    b.paging && b.paging.enabled
      ? `翻页：当前第 ${b.paging.page} 页｜最多看 ${b.paging.maxPages} 页${b.paging.stopped ? `｜已停：${truncate(b.paging.stopped, b.paging.stopped === b.stopReason ? 150 : 60)}` : ''}`
      : '',
    // 为什么这一页一家没投：投过 / 「全国」待定 / 不符合筛选，全都摆出来
    // （scanNote 自带「本页 N 家：」前缀，前面不能再加「本页：」）
    b.scanNote ? `${truncate(b.scanNote, 130)}` : '',
    // 同一句话不打印两遍：翻页停止原因常常就是整批停止原因，
    // 两行都写「第 2 页没有岗位了…」等于占了弹窗四行还说同一件事（2026-11-05 真机）
    b.stopReason && b.stopReason !== (b.paging && b.paging.stopped)
      ? `原因：${truncate(b.stopReason, 150)}`
      : '',
    stuck ? `⚠️ 已 ${idleSec} 秒没动静，可能卡住了` : '',
    ...recent,
    b.running && b.queue && b.queue[b.index]
      ? `下一家：${(b.titles && b.titles[b.index]) || b.queue[b.index]}`
      : '',
  ].filter(Boolean)

  box.className = 'linebox' + (b.running ? ' running' : '') + (stuck ? ' stuck' : '')
  stateEl.textContent = b.running
    ? b.paging && b.paging.scanOnly
      ? '翻页找岗位'
      : stuck
        ? `卡住 ${idleSec}s`
        : '进行中'
    : '已结束'
  infoEl.textContent = lines.join('\n')

  // 队列清单：让你看清整批要投哪些、投到哪了
  if (qEl) {
    qEl.textContent = (b.queue || [])
      .map((u, i) => {
        const r = (b.results || [])[i]
        const mark = r ? (r.ok ? '✅' : r.skipped ? '⏭️' : '❌') : i === b.index && b.running ? '▶️' : '○'
        const t = (b.titles && b.titles[i]) || u
        const head = `${String(i + 1).padStart(2, ' ')}. ${mark} ${truncate(t, 22)}`
        // 没投成的原因跟在下面一行：只显示「失败 1」而不说为什么，
        // 就得去翻页面才知道是「城市不符」还是「投过了」（2026-11-05 真机）
        const why = r && !r.ok && r.message ? `\n      ${truncate(r.message, 70)}` : ''
        return head + why
      })
      .join('\n') || '—'
  }

  renderPending(line, b)
}

/**
 * 「全国」待定清单：默认不投，逐条让用户决定。
 *
 * 为什么不做成自动投：站点在「深圳」搜索里会掺「全国」岗位，有的其实就在深圳，
 * 有的详情页写着北京（2026-11-05 实测东方金信那条）。当异地丢掉太亏，自动投又可能投错，
 * 所以只列出来 —— 点标题能先看岗位，点「加入」才进队列。
 */
function renderPending(line, b) {
  const box = document.getElementById('pending-current')
  if (!box) return
  const list = Array.isArray(b && b.pending) ? b.pending : []
  const blocked = Array.isArray(b && b.blockedList) ? b.blockedList : []
  box.textContent = ''
  if (!list.length && !blocked.length) return

  if (list.length) {
    const head = document.createElement('div')
    head.className = 'pendhead'
    head.textContent = `「全国」岗位 ${list.length} 家 · 没自动投，点标题先看岗位，确认了再「加入」`
    box.appendChild(head)

    list.forEach((p, i) => {
      const row = document.createElement('div')
      row.className = 'pendrow'

      const a = document.createElement('a')
      a.textContent = truncate(`${p.title || p.url}${p.city ? `（${p.city}）` : ''}`, 30)
      a.href = p.url || '#'
      a.title = `${p.reason || ''}\n${p.url || ''}`
      a.addEventListener('click', (e) => {
        e.preventDefault()
        if (p.url) chrome.tabs.create({ url: p.url, active: true })
      })

      const btn = document.createElement('button')
      btn.className = 'mini'
      btn.textContent = '加入'
      btn.addEventListener('click', () => adoptPendingOne(i, line))

      row.appendChild(a)
      row.appendChild(btn)
      box.appendChild(row)
    })
  }

  // 被筛选拦掉的岗位也要列：只说「16 家不符合筛选」，
  // 用户没法判断这是筛选在正常工作、还是把自己想投的岗位误杀了（2026-11-05 真机）
  if (blocked.length) {
    const totalBlocked = Number(b && b.blockedTotal) || blocked.length
    const head = document.createElement('div')
    head.className = 'pendhead'
    head.textContent = `被筛选拦掉 ${totalBlocked} 家 · 没投${
      totalBlocked > blocked.length ? `（只列前 ${blocked.length} 条）` : ''
    }，看一眼就知道该不该拦`
    box.appendChild(head)

    blocked.forEach((x) => {
      const row = document.createElement('div')
      row.className = 'pendrow blocked'
      const t = document.createElement('span')
      t.className = 'bktitle'
      t.textContent = truncate(x.title || '(无标题)', 30)
      t.title = `${x.title || ''}\n${x.reason || ''}`
      const why = document.createElement('span')
      why.className = 'bkwhy'
      // 原因现在独占一行（332px ≈ 33 个 10px 字），给到 34 就基本不会再被 CSS 截；
      // 原来给 20 是配合「同行 45% 宽」的，那版实测只会露出「「测…」」
      why.textContent = x.reason || ''
      why.title = x.reason || ''
      row.appendChild(t)
      row.appendChild(why)
      box.appendChild(row)
    })
  }
}

// 加入队列：必须发给「持有这个批次」的那个标签页，不能随便找个同平台的页
async function adoptPendingOne(index, line) {
  const tab = await findLineTab(line)
  if (!tab) {
    log('❌ 找不到该平台的标签页 —— 先在浏览器打开它（批量要跑在页面里）')
    return
  }
  let res
  try {
    res = await chrome.tabs.sendMessage(tab.id, { action: 'batchAdoptPending', indexes: [index] })
  } catch (e) {
    log(`❌ 加入失败：${(e && e.message) || '页面连不上'}（页面可能在跳转，等两秒再试）`)
    return
  }
  if (res && res.ok) {
    log(
      res.jumped
        ? `✅ 这 ${res.added} 家已加进队列，正在跳过去投（队列共 ${res.total} 家）`
        : `✅ 这 ${res.added} 家已加进队列，等当前这家投完就接上（队列共 ${res.total} 家）`
    )
  } else {
    log(`❌ ${(res && res.error) || '加入失败'}`)
  }
  setTimeout(refreshBatch, 800)
}

// 判断当前活动标签页属于哪条线（只剩「当前页」操作后，状态只显示这一条）。
async function currentLine() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const u = String((tab && tab.url) || '')
    if (/zhipin\.com/i.test(u)) return 'boss'
    if (/shixiseng\.com/i.test(u)) return 'sx'
  } catch {
    /* 读不到就退回按批次数据判断 */
  }
  // 当前页不是平台页时，优先显示有活动的线（BOSS 优先，因为它在聊天页跳转后 url 会变）
  const boss = await readBatchLine('boss')
  const sx = await readBatchLine('sx')
  if (boss && boss.running) return 'boss'
  if (sx && sx.running) return 'sx'
  if (boss) return 'boss'
  return 'sx'
}

async function refreshBatch() {
  const line = await currentLine()
  renderLine(line, await readBatchLine(line))
  updateOneKeyLabel()
}

/**
 * 按钮上写清「这一下会投哪个平台」。
 * 旧版把「（实习僧）」写死在按钮上、逻辑也写死找实习僧的 tab：用户在 BOSS 页点它，
 * 被直接拽到实习僧并按实习僧的条件开投（2026-11-06 真机事故）。
 */
async function updateOneKeyLabel() {
  const el = document.getElementById('oneKeyBtn')
  const plat = await activeLine()
  const text =
    plat.key === 'boss'
      ? '一键投递（BOSS）'
      : plat.key === 'sx'
        ? '一键投递（实习僧）'
        : '一键投递（先切到平台页）'
  if (el && el.textContent !== text) el.textContent = text
  if (el) {
    el.title = plat.key
      ? `在眼前这个${plat.name}页面按表单条件开投；城市 / 类型等筛选以该页 URL 为准`
      : '当前标签页不是实习僧 / BOSS，先切过去再点'
  }

  /**
   * 平台名必须一直看得见。
   *
   * v0.9.0 把「一键投递」那个按钮收进了 hidden（它和「投递范围」单选是同一件事），
   * 而平台名原来只写在那颗按钮上 —— 收起来就等于把「这一下会投哪个平台」也一起藏了，
   * 那正是 2026-11-06「在 BOSS 页点一键却被拽去实习僧」的同一个信息缺口。
   * 现在钉在操作卡标题旁：判不出平台时显示警告色，用户点之前就能看见。
   */
  const hint = document.getElementById('pagePlat')
  if (hint) {
    hint.textContent = plat.key ? `当前页 · ${plat.name}` : '当前页不是招聘平台页'
    hint.className = 'ophead-note' + (plat.key ? '' : ' bad')
  }
  const go = document.getElementById('goBtn')
  if (go) go.title = plat.key ? `将在当前这个${plat.name}页面开投` : '先切到实习僧 / BOSS 的页面再点开始'
}

const isDetailUrl = (u) => /job_detail\/|shixiseng\.com\/intern\/inn_/i.test(String(u || ''))
const isListUrl = (u) => /search|joblist|geek\/job|interns|campus|jobs?\?|keyword=/i.test(String(u || ''))

// 日志里显示哪个页面足够定位就行，别把 200 字符的 query 全铺出来
function shortUrl(u) {
  try {
    const x = new URL(String(u))
    return x.host + x.pathname + (x.search ? `${x.search.slice(0, 40)}…` : '')
  } catch {
    return String(u || '').slice(0, 80)
  }
}

/**
 * 日志里给人看的地址：去掉协议、解码中文、**不截断 query**。
 * 为什么不用 shortUrl：它会砍掉 query 前 40 字之后的部分，
 * 而「参数缺没缺」正是要一眼看的东西（2026-11-05 少了 keyword 就是被截掉才没发现）。
 */
function plainUrl(u) {
  let s = String(u || '')
  try {
    s = decodeURI(s)
  } catch {
    /* 解不开就原样显示 */
  }
  return s.replace(/^https?:\/\//i, '')
}

/** 一个搜索任务叫什么（「深圳·软件测试」；只有词时就是词）。规则在 filters-data 的 taskNameOf */
function kwOfUrl(u) {
  if (window.JH_FILTERS && typeof window.JH_FILTERS.taskNameOf === 'function') {
    return window.JH_FILTERS.taskNameOf(u)
  }
  try {
    return new URL(u).searchParams.get('keyword') || ''
  } catch {
    return ''
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
  if (!usable.length) return null

  // ① 当前窗口的活动标签页最优先。
  //    为什么不按「像不像列表页」在全部同平台 tab 里挑：同时开着好几个实习僧页时，
  //    会挑到后台那个扩展重载**之前**就打开的旧页 —— 它没有脚本，于是报
  //    「还没注入脚本」，而用户眼前的页面其实是好的（2026-11-05 真机踩到）。
  //    ⚠️ 详情页也合法：详情页上「启动」＝ 接着投上一批（content 的 resumeExistingBatch），
  //    所以这里不能再把详情页排除掉。
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (active && active.id) {
      const hit = usable.find((t) => t.id === active.id)
      if (hit) return hit
    }
  } catch {
    /* 查不到活动页就按老逻辑挑 */
  }

  const lists = usable.filter((t) => !isDetailUrl(t.url))
  return lists.find((t) => isListUrl(t.url)) || lists[0] || usable[0] || null
}

/**
 * 发批量指令，并把「通信失败」的两种原因分开报。
 *
 * 以前一律报「还没注入脚本，刷新一下再试」，用户刷新了也没用 —— 因为真正的原因
 * 可能是扩展挑到了另一个旧标签页，或者页面还在加载。错报比不报更浪费时间。
 */
async function sendToLine(tab, L, msg, fallback) {
  const send = () => chrome.tabs.sendMessage(tab.id, msg)
  const noScriptRe = /Receiving end does not exist|Could not establish connection|message port closed/i
  const where = shortUrl(tab.url)

  try {
    return await send()
  } catch (e) {
    const text = String((e && e.message) || e || '')
    if (!noScriptRe.test(text)) {
      return { ok: false, error: `${fallback}\n原因：${text || '未知错误'}\n标签页：${where}` }
    }

    // 页面可能刚刷新完、脚本还没跑到 document_idle —— 等一拍再试一次，
    // 免得用户「刷完立刻点」又白跑一趟
    await new Promise((r) => setTimeout(r, 1200))
    try {
      return await send()
    } catch {
      return {
        ok: false,
        error: `「${L.name}」这个标签页里还没有脚本。扩展重新加载后，**已经打开的页面不会自动装上新脚本**，要在那个页面按一次 F5 再点启动（刷新的是页面，不是扩展）。\n扩展这次用的标签页：${where}`,
      }
    }
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
    // 扫描模式：本页一家可投的都没有，正在往后翻找
    if (res.scanning) {
      // 换关键词也走「扫描」这条返回路：note 里已经写清换到哪个词了
      if (res.keyword) {
        return (
          `↻ ${name}：${res.note || '这个词跑完了'}\n` +
          `正在打开第 ${res.keyword}/${res.keywordTotal} 个关键词的搜索页，加载完自动开投。`
        )
      }
      return (
        `↻ ${name}：${res.note || '本页没有可投的岗位'}\n` +
        `正在往后翻，找有可投岗位的一页（第 ${res.page} 页，最多看到第 ${res.maxPages} 页）…\n` +
        '找到就开始投，不用管它，弹窗可以直接关。'
      )
    }
    // 续跑和新建是两回事：新建说「N 家已启动」，续跑要说清「从第几家接着跑」，
    // 否则用户以为又重新抓了一批（详情页启动走的就是续跑）
    const parts = [
      res.resumed
        ? `▶️ ${name}：接着上次的队列跑（已完成 ${res.done}/${res.all}，还剩 ${res.total} 家）`
        : `✅ ${name}：${res.total} 家已启动`,
    ]
    // 剩余额度不够整批时 content 会主动收缩，这里要说清楚为什么数量变少了
    if (res.shrunk && res.quota) {
      parts.push(`今日剩余额度只剩 ${res.quota.remaining} 家，本批按剩余量收缩`)
    }
    if (res.appliedSkip) parts.push(`本地记录里已投过 ${res.appliedSkip} 家，已排除`)
    if (res.blocked) parts.push(`不符合筛选 ${res.blocked} 家`)
    // 「全国」岗位没自动投：必须说出来，否则用户以为「怎么才这么几家」
    if (res.pending) parts.push(`${res.pending} 家写「全国」的没自动投（展开「队列」逐条决定）`)
    // 开了自动翻页就说清楚现在是第几页，不然「投完就停了」会以为翻页没生效
    if (res.paging) parts.push(`从第 ${res.paging.page} 页起｜最多看到第 ${res.paging.maxPages} 页`)
    // 排了多个关键词：明确说「后面还有几个词会自动接上」，否则跑完一个词停了会以为轮换坏了
    if (res.keywords > 1) {
      parts.push(
        `本次排了 ${res.keywords} 个关键词：第 ${(res.keywordIndex || 0) + 1} 个跑到底后，自动换下一个（共 ${res.keywords} 个）`
      )
    }
    // 把这次生效的筛选条件摆出来。筛选配错是**静默**的（只会放行不该投的岗位，
    // 不会报错），只有写在启动日志里，才可能一眼看出「城市其实没生效」
    if (res.scope) parts.push(`\n本次范围：${res.scope}`)
    if (res.scopeRisky) parts.push(`⚠️ ${res.scopeRisky}`)
    if (res.filters) parts.push(`本次筛选：${res.filters}`)
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

// 只在当前标签页启动（就在那一页上操作时用）
document.getElementById('batchBtn').addEventListener('click', async () => {
  const limit = batchLimitValue()
  const force = batchForceChecked()
  log(force ? '正在抓取本页岗位链接（本批跳过风控检测）…' : '正在抓取本页岗位链接…')
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, {
      action: 'batchStart',
      limit,
      force,
      pagingConfig: await pagingConfig(),
    })
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

// ===================== 一键投递：前置条件在插件里配，之后一站式跑 =====================
// 为什么不用「记住网站上的那一页」：那只能记住**一个人**的栏目和城市。
// 朋友的搜索条件不一样，还得回网站重新点一遍 —— 前置条件本来就该在插件里配。
// 实习僧的搜索条件全在 URL query 里（keyword / city / type），插件自己拼得出来。
//
// 模板：`取当前页当模板` 会把用户手工筛选好的那一页存下来；
// 一键时只用表单值覆盖 keyword / city / type，其余筛选（薪资、学历、天数…）原样保留。
const ONEKEY_KEY = 'oneKey:sx'
const LEGACY_START_URL_KEY = 'startUrl:sx' // 老版本只存整条 URL，读的时候迁移成模板

// cities 是数组：实习僧的 city 参数只能是一个城市，勾多个 = 跑多轮（见 expandSearchTasks）。
// 老版本存的是字符串 `city`，读的时候迁移过来，不然用户升级后配置会凭空消失。
// type 同理：老版本是单值字符串（intern/school），新版本是数组（勾「实习 + 校招」= 跑两轮）。
const ONEKEY_DEFAULT = { keyword: '', cities: [], types: ['intern', 'school'], templateUrl: '' }

async function readOneKey() {
  const r = await chrome.storage.local.get([ONEKEY_KEY, LEGACY_START_URL_KEY])
  const saved = { ...ONEKEY_DEFAULT, ...(r[ONEKEY_KEY] || {}) }
  if (!saved.templateUrl && r[LEGACY_START_URL_KEY]) saved.templateUrl = String(r[LEGACY_START_URL_KEY])
  if (!Array.isArray(saved.cities)) saved.cities = []
  if (!saved.cities.length && typeof saved.city === 'string' && saved.city.trim()) {
    saved.cities = [saved.city.trim()]
  }
  delete saved.city
  // 迁移：老版本存的是 `type`（单值字符串），新版本是 `types`（数组）
  if (!Array.isArray(saved.types) || !saved.types.length) {
    saved.types = typeof saved.type === 'string' && saved.type ? [saved.type] : ['intern', 'school']
  }
  delete saved.type
  return saved
}

async function saveOneKey(patch) {
  const cur = await readOneKey()
  await chrome.storage.local.set({ [ONEKEY_KEY]: { ...cur, ...patch } })
}

// 剥掉翻页参数：存的是**起点**，不能把上次停在第几页也一起存进去
function stripPageParam(u) {
  try {
    const x = new URL(u)
    for (const k of ['page', 'p', 'pageNum']) x.searchParams.delete(k)
    x.hash = ''
    return x.toString()
  } catch {
    return String(u || '')
  }
}

/**
 * 当前活动标签页属于哪条线 —— **严格版**：只认真正的平台页，猜不出来就返回空。
 *
 * 为什么不复用 currentLine()：那个是「状态栏显示用」的，当前页不是平台页时它会
 * 按批次数据猜一条线。拿去决定「往哪个平台投」就危险了 —— 2026-11-06 真机：
 * 用户在 BOSS 页点「一键」，代码硬编码 findLineTab('sx')，直接把他从 BOSS 拽到实习僧，
 * 并按实习僧的关键词/城市开始投。所以「投哪个平台」这件事必须只看眼前这个页面。
 */
async function activeLine() {
  const tab = await activeTab()
  const u = String((tab && tab.url) || '')
  if (/zhipin\.com/i.test(u)) return { key: 'boss', name: 'BOSS 直聘', tab }
  if (/shixiseng\.com/i.test(u)) return { key: 'sx', name: '实习僧', tab }
  return { key: '', name: '', tab }
}

// BOSS 的搜索页长这样：https://www.zhipin.com/web/geek/job?query=测试&city=101280600
const isBossSearchUrl = (u) => /zhipin\.com\/web\/geek\/jobs?(\?|$)/i.test(String(u || ''))

/**
 * 拼 BOSS 的搜索页。
 *
 * ⚠️ 和实习僧不同，BOSS 的 city 是**数字编码**（实习僧是中文），插件里没有可靠的城市码表，
 * 硬编一张错表会把深圳的岗投成别的城市。所以这里**只换 query，其余参数（city / 经验 / 学历…）
 * 全部沿用模板页**——也就是「你当前页上看到的筛选条件」。换城市请在 BOSS 页面上换。
 */
function buildBossSearchUrl(baseUrl, keyword) {
  let x
  try {
    x = new URL(baseUrl)
  } catch {
    return ''
  }
  if (!/zhipin\.com$/i.test(x.hostname)) return ''
  // 聊天页 / 首页不能当模板：路径不对，拼出来的还是聊天页
  if (!isBossSearchUrl(x.toString())) x.pathname = '/web/geek/job'
  for (const k of ['page', 'p', 'pageNum']) x.searchParams.delete(k)
  x.hash = ''
  if (keyword) x.searchParams.set('query', keyword)
  else x.searchParams.delete('query')
  return x.toString()
}

/**
 * 拼出这次要落的搜索页。
 * 有模板 → 在模板上覆盖三个值（用户额外选的筛选条件全部保留）；
 * 没模板 → 用实习僧的标准参数格式（keyword / city / type）。
 */
function buildSearchUrl(cfg) {
  let x
  try {
    x = new URL(cfg.templateUrl || 'https://www.shixiseng.com/interns')
  } catch {
    x = new URL('https://www.shixiseng.com/interns')
  }
  x.searchParams.delete('page')
  if (cfg.keyword) x.searchParams.set('keyword', cfg.keyword)
  else x.searchParams.delete('keyword')
  if (cfg.city) x.searchParams.set('city', cfg.city)
  else x.searchParams.delete('city')
  x.searchParams.set('type', cfg.type || 'intern')
  return x.toString()
}

// 两个地址是不是同一组搜索条件（忽略 page / 锚点 / 参数顺序）
function sameSearchPage(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    if (x.origin !== y.origin || x.pathname !== y.pathname) return false
    const q = (u) =>
      [...u.searchParams.entries()].filter(([k]) => !/^(page|p|pageNum)$/i.test(k)).sort().join('&')
    return q(x) === q(y)
  } catch {
    return false
  }
}

// 注：这里不再轮询「页面就绪」。跳页后的启动已改由 content 的 bootOneKey() 接手 ——
// popup 一失去焦点就被销毁，轮询必然被打断（原来那个 waitTabReady 就是因此删掉的）。

// ===== 一键投递：搜索城市（多选）=====
// 为什么要多选：朋友投的城市和自己的不一定一样。但实习僧的 `city` 是**单值** query 参数，
// 一个地址只能搜一个城市 —— 所以「勾多个」= **跑多轮**，不是一次搜多个。
// 展开逻辑在 filters-data 的 expandSearchTasks（纯函数、有单测），这里只管界面。
const OK_CITY_FALLBACK = ['深圳']

// 一键投递用的城市列表，和筛选页的 jobFilters.cities 是**两份**：
// 筛选那份是「允许的范围」，可以写很多备选；这份是「这轮真去搜哪几个」，多一个就多跑一轮。
let okCities = []

function renderOkCities() {
  const sel = document.getElementById('okProvSel')
  const box = document.getElementById('okCityList')
  if (!sel || !box) return
  const F = window.JH_FILTERS || {}
  const prov = (F.PROVINCES || []).find((p) => p.name === sel.value)
  box.innerHTML = ''
  if (!prov) return
  prov.cities.forEach((c) => {
    const on = okCities.includes(c)
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
        if (!okCities.includes(c)) okCities.push(c)
      } else {
        okCities = okCities.filter((x) => x !== c)
      }
      label.classList.toggle('on', e.target.checked)
      renderOkPicked()
      saveOneKey({ cities: okCities })
    })
    box.appendChild(label)
  })
}

function renderOkPicked() {
  const picked = document.getElementById('okCityPicked')
  if (!picked) return
  if (!okCities.length) {
    picked.textContent = '已选：—（不选 = 不限城市）'
    return
  }
  // 多选时必须说清「会跑几轮」：用户以为自己只搜一次，实际是每个城市各跑一遍
  picked.textContent =
    okCities.length > 1
      ? `已选 ${okCities.length} 个：${okCities.join('、')}（每城各跑一轮）`
      : `已选：${okCities[0]}`
}

// 表单 ↔ 存储：改一项存一项，重开 popup 还在（不用每次重填城市）
// 「类型」是两个 checkbox（实习 / 校招），勾多个 = 跑多轮（和城市多选同构）
function bindOneKeyForm() {
  const kw = document.getElementById('kwInput')
  const prov = document.getElementById('okProvSel')
  const typeIntern = document.getElementById('typeIntern')
  const typeSchool = document.getElementById('typeSchool')
  if (!kw || !prov || !typeIntern || !typeSchool) return

  const F = window.JH_FILTERS || {}
  prov.innerHTML = (F.PROVINCES || []).map((p) => `<option value="${p.name}">${p.name}</option>`).join('')
  prov.value = F.PROVINCES && F.PROVINCES[0] ? F.PROVINCES[0].name : ''
  prov.addEventListener('change', renderOkCities)

  // 当前勾选的类型（存数组，持久化到 types）
  let okTypes = []

  const typeNames = { intern: '实习', school: '校招' }
  const renderOkTypes = () => {
    typeIntern.checked = okTypes.includes('intern')
    typeSchool.checked = okTypes.includes('school')
    const el = document.getElementById('typePicked')
    if (el) {
      el.textContent = okTypes.length
        ? `已选：${okTypes.map((t) => typeNames[t] || t).join('、')}`
        : '已选：—（类型为空会拦下）'
    }
  }
  const persistTypes = () => {
    okTypes = []
    if (typeIntern.checked) okTypes.push('intern')
    if (typeSchool.checked) okTypes.push('school')
    renderOkTypes()
    saveOneKey({ types: okTypes })
  }
  typeIntern.addEventListener('change', persistTypes)
  typeSchool.addEventListener('change', persistTypes)

  ;(async () => {
    const saved = await readOneKey()
    okCities = saved.cities.slice()
    if (!okCities.length) {
      // 没配过就用「筛选条件」里的城市兜底：那儿本来就写着只投深圳。
      // 只取前 5 个 —— 筛选范围可以很宽，但每个城市都要真跑一轮，全搬过来会跑一整天。
      try {
        const { filters } = await chrome.storage.local.get('filters')
        const list = (filters && Array.isArray(filters.cities) && filters.cities) || []
        okCities = list.slice(0, 5)
      } catch {
        /* 读不到就算了 */
      }
      if (!okCities.length) okCities = OK_CITY_FALLBACK.slice()
    }
    kw.value = saved.keyword || ''
    okTypes = saved.types.slice()
    renderOkTypes()
    // 已选的城市可能在别的省：切到第一个选中城市所在的省，否则 chips 里一个勾都看不到
    const home = (F.PROVINCES || []).find((p) => p.cities.includes(okCities[0]))
    if (home) prov.value = home.name
    renderOkCities()
    renderOkPicked()
  })()

  const persist = () => saveOneKey({ keyword: kw.value.trim() })
  kw.addEventListener('change', persist)

  const clear = document.getElementById('okCityClear')
  if (clear) {
    clear.addEventListener('click', () => {
      okCities = []
      renderOkCities()
      renderOkPicked()
      saveOneKey({ cities: [] })
    })
  }
}

// 翻页开关：单独存（和「一键投递」的搜索条件无关，手动启动批量时也该生效）
function bindPagingForm() {
  const on = document.getElementById('autoPage')
  const num = document.getElementById('maxPages')
  if (!on || !num) return
  ;(async () => {
    const { autoPage, maxPages } = await chrome.storage.local.get(['autoPage', 'maxPages'])
    on.checked = !!autoPage
    if (maxPages) num.value = String(maxPages)
  })()
  on.addEventListener('change', () => chrome.storage.local.set({ autoPage: on.checked }))
  num.addEventListener('change', () => {
    const n = Math.max(1, Math.min(10, Number(num.value) || 3))
    num.value = String(n)
    chrome.storage.local.set({ maxPages: n })
  })
}

// 每次启动都读一次，保证「刚勾上就点启动」也生效
async function pagingConfig() {
  const on = document.getElementById('autoPage')
  const num = document.getElementById('maxPages')
  const saved = await chrome.storage.local.get(['autoPage', 'maxPages'])
  const enabled = on ? on.checked : !!saved.autoPage
  const maxPages = Math.max(1, Math.min(10, Number(num && num.value) || Number(saved.maxPages) || 3))
  return { enabled, maxPages }
}

bindOneKeyForm()
bindPagingForm()

// 跳页启动时弹窗多半已经关了，结果必须回显 —— 否则用户不知道到底开没开起来。
// content 的 bootOneKey() 会把结果写进 lastOneKeyResult。
;(async () => {
  const { lastOneKeyResult } = await chrome.storage.local.get('lastOneKeyResult')
  if (!lastOneKeyResult) return
  const age = Date.now() - new Date(lastOneKeyResult.at || 0).getTime()
  if (!(age >= 0 && age < 5 * 60 * 1000)) return
  log(startLogText(lastOneKeyResult, '实习僧'))
})()

document.getElementById('pickUrlBtn').addEventListener('click', async () => {
  const tab = await activeTab()
  const u = String((tab && tab.url) || '')

  // BOSS 的模板单独存（两家的参数格式完全不同：BOSS 的 city 是数字编码）
  if (/zhipin\.com/i.test(u)) {
    if (!isBossSearchUrl(u)) {
      log(`❌ 这看起来不是 BOSS 的搜索结果页：${shortUrl(u)}\n先在 BOSS 筛好，停在列表页（带 ?query= 的那个）再取。`)
      return
    }
    const bossUrl = stripPageParam(u)
    await chrome.storage.local.set({ oneKeyBossTemplate: bossUrl })
    // 关键词顺手填进表单（BOSS 的参数叫 query，不是 keyword）
    try {
      const kw = new URL(bossUrl).searchParams.get('query') || ''
      const kwEl = document.getElementById('kwInput')
      if (kwEl && kw && !kwEl.value) {
        kwEl.value = kw
        await saveOneKey({ keyword: kw })
      }
    } catch {
      /* 解析失败不影响模板已存下 */
    }
    log(
      `✅ 已把这一页存成 BOSS 模板（城市/经验/学历等筛选会保留）：\n${bossUrl}\n` +
        '之后在 BOSS 任意页面点一键投递，都会按这套条件开投（只换关键词）。'
    )
    return
  }

  if (!/shixiseng\.com/i.test(u)) {
    log('❌ 当前标签页既不是实习僧也不是 BOSS —— 先切到那个搜索结果页，再点「取当前页当模板」')
    return
  }
  if (isDetailUrl(u) || !isListUrl(u)) {
    log(`❌ 这看起来不是搜索结果页：${shortUrl(u)}\n先在实习僧筛选好，停在结果列表页再取。`)
    return
  }
  const url = stripPageParam(tab.url)
  await saveOneKey({ templateUrl: url })

  // 顺手把地址里的 keyword / city / type 填进表单：用户下一步想改的正是这几项
  try {
    const x = new URL(url)
    const kw = x.searchParams.get('keyword') || ''
    const city = x.searchParams.get('city') || ''
    const type = x.searchParams.get('type') || ''
    const kwEl = document.getElementById('kwInput')
    if (kwEl && kw && !kwEl.value) kwEl.value = kw
    // 城市是多选：模板里只有一个城市，只在「一个都没选」时补进去，别覆盖用户已经勾的多个
    if (city && !okCities.length) {
      okCities = [city]
      const prov = document.getElementById('okProvSel')
      const F = window.JH_FILTERS || {}
      const home = (F.PROVINCES || []).find((p) => p.cities.includes(city))
      if (prov && home) prov.value = home.name
      renderOkCities()
      renderOkPicked()
    }
    // 类型：模板里的 type 只在「当前一个都没勾」时补进去，别覆盖用户已经勾的实习+校招
    if (type && ['intern', 'school', 'company'].includes(type)) {
      const cur = await readOneKey()
      if (!cur.types || !cur.types.length) {
        await saveOneKey({ types: [type === 'company' ? 'intern' : type] })
        // 同步界面 checkbox
        const internEl = document.getElementById('typeIntern')
        const schoolEl = document.getElementById('typeSchool')
        if (internEl && schoolEl) {
          internEl.checked = type === 'intern'
          schoolEl.checked = type === 'school'
          internEl.dispatchEvent(new Event('change'))
        }
      }
    }
    await saveOneKey({
      keyword: (kwEl && kwEl.value.trim()) || '',
      cities: okCities.slice(),
    })
  } catch {
    /* 解析失败不影响「模板已存下」这件事 */
  }
  log(`✅ 已把这一页存成模板（你额外选的筛选条件会保留）：\n${url}`)
})

document.getElementById('oneKeyBtn').addEventListener('click', async () => {
  const btn = document.getElementById('oneKeyBtn')
  btn.disabled = true
  try {
    // 以表单当前值为准（用户可能填完立刻点，change 事件还没触发）
    const cfg = await readOneKey()
    const kwEl = document.getElementById('kwInput')
    // 类型：读两个 checkbox 的实时勾选，落到数组（实习 / 校招）
    const typeInternEl = document.getElementById('typeIntern')
    const typeSchoolEl = document.getElementById('typeSchool')
    const types = []
    if (typeInternEl && typeInternEl.checked) types.push('intern')
    if (typeSchoolEl && typeSchoolEl.checked) types.push('school')
    const final = {
      keyword: ((kwEl && kwEl.value) || cfg.keyword || '').trim(),
      cities: okCities.slice(),
      types: types.length ? types : cfg.types || ['intern', 'school'],
      templateUrl: cfg.templateUrl || '',
    }
    const kwAnyEl = document.getElementById('kwAny')
    const allowAnyKw = !!(kwAnyEl && kwAnyEl.checked)
    await saveOneKey(final)

    // 关键词留空 ≠ 投「测试」，而是投**该城市全部岗位**。
    // 2026-11-05 真机：表单只填了城市，一键投递算出的地址是 ?city=深圳&type=intern，
    // 没有 keyword —— 差一步就开始投深圳所有实习岗。所以这里必须硬拦，不能只靠提示。
    if (!final.keyword && !allowAnyKw) {
      log(
        '❌ 关键词是空的，没有开投。\n' +
          '留空时这一跳会落到「' +
          (final.cities.join('/') || '全国') +
          ' · 全部岗位」，不是你要的岗位方向。\n' +
          '① 填上关键词（如「测试」）再点；\n' +
          '② 确实想投该城市全部岗位 → 勾「关键词不限」。'
      )
      return
    }

    // ===== 投哪个平台：只看眼前这个页面 =====
    // 2026-11-06 真机：用户在 BOSS 页点「一键」，旧代码硬编码 findLineTab('sx')，
    // 把他从 BOSS 直接拽到实习僧、并按实习僧的关键词/城市开始投 —— 他根本没想投实习僧。
    // 所以平台判断必须由当前页决定，且**判不出来就不猜、不开投**。
    const plat = await activeLine()
    if (!plat.key) {
      log(
        '❌ 当前标签页既不是实习僧也不是 BOSS，不知道要在哪儿投。\n' +
          '先切到要投的那个平台的页面（搜索/列表页），再点一键投递。'
      )
      return
    }
    const line = plat.key
    const lineName = plat.name
    const isBoss = line === 'boss'

    // BOSS 城市是数字编码（实习僧是中文），插件没有可靠城市码表 → 筛选条件全部沿用当前页。
    // 换城市 = 在 BOSS 页面上换，不在插件里换（硬编错表会把深圳的岗投成别的城市）。
    let bossBase = ''
    if (isBoss) {
      const cur = String(plat.tab.url || '')
      if (isBossSearchUrl(cur)) {
        bossBase = stripPageParam(cur)
      } else {
        const r = await chrome.storage.local.get('oneKeyBossTemplate')
        bossBase = r.oneKeyBossTemplate || ''
      }
      if (!bossBase) {
        log(
          '❌ 当前是 BOSS 的非搜索页（聊天 / 首页 / 职位详情），没有筛选条件可用，所以没开投。\n' +
            '① 切到 BOSS 的搜索结果列表页（网址里带 ?query= 的那个）再点一键投递；或\n' +
            '② 先在那个列表页点一次「取当前页当模板」，之后在 BOSS 任意页点都能按那套条件投。'
        )
        return
      }
    }

    // 关键词可以填多个（逗号 / 顿号 / 换行分隔）：一个词投完自动换下一个。
    // 只填一个时行为和以前完全一样。为什么要多个：一个词在实习僧上、一个城市里
    // 通常只有 20~40 个岗位，投完就没了（2026-11-05：测试+深圳+校招 两页 0 家可投）。
    const kws =
      window.JH_FILTERS && typeof window.JH_FILTERS.parseKeywords === 'function'
        ? window.JH_FILTERS.parseKeywords(final.keyword)
        : final.keyword
          ? [final.keyword]
          : []
    // 城市 × 类型 × 关键词 展开成任务列表。实习僧的 city / type 都是单值参数，
    // 勾多个 = 跑多轮，顺序是「先把深圳·实习的几个词跑完，再跑深圳·校招，最后才轮到广州」。
    // type 放城市内层（换 type 和换词一样只改 query 不换入口），复用现成轮换机制。
    // ⚠️ BOSS 不展开：城市/类型都写在当前页的 URL 参数里，插件只负责换 query。
    const tasks = isBoss
      ? (kws.length ? kws : ['']).map((k) => ({ url: buildBossSearchUrl(bossBase, k) }))
      : window.JH_FILTERS && typeof window.JH_FILTERS.expandSearchTasks === 'function'
        ? window.JH_FILTERS.expandSearchTasks(kws, final.cities, final.types, (p) =>
            buildSearchUrl({ ...final, ...p, type: p.type })
          )
        : (kws.length ? kws : ['']).map((k) => ({
            url: buildSearchUrl({ ...final, keyword: k, city: final.cities[0] || '', type: final.types[0] || 'intern' }),
          }))
    const urls = tasks.map((t) => t.url)
    const startUrl = urls[0]

    // 开投前把「这次到底投什么范围」明文写出来：配错了不报错，只能靠显示出来发现。
    // ⚠️ 这段必须拼进**最后那条**日志里 —— log() 是覆盖写，中途 log 一次会被后面的
    //    「正在跳到起点…」盖掉，用户就永远看不到范围（2026-11-05 就是这么漏掉的）
    const typeName = { intern: '实习', school: '校招', company: '企业' }
    const typeText = final.types.length
      ? final.types.length > 1
        ? `${final.types.map((t) => typeName[t] || t).join(' / ')}（共 ${final.types.length} 类，一类投完自动换下一类）`
        : typeName[final.types[0]] || final.types[0]
      : '⚠️ 未选'
    // BOSS 的城市/类型不来自表单（插件不维护城市码表），直接显示「当前页 URL 里带了什么」，
    // 这样用户一眼能看出「这一跳用的还是我页面上那套筛选」，而不是以为插件按勾选改了城市。
    let bossCityText = ''
    if (isBoss) {
      try {
        const c = new URL(bossBase).searchParams.get('city') || ''
        bossCityText = c ? `沿用当前页参数（city=${c}）` : '沿用当前页参数（未带 city → 按站点默认城市）'
      } catch {
        bossCityText = '沿用当前页参数'
      }
    }
    const scopeText = [
      '本次范围：',
      `  关键词：${
        kws.length > 1
          ? `${kws.join(' / ')}（共 ${kws.length} 个，一个投完自动换下一个）`
          : kws[0] || '⚠️ 不限（该城市全部岗位）'
      }`,
      `  城市：${
        isBoss
          ? bossCityText
          : final.cities.length
            ? final.cities.length > 1
              ? `${final.cities.join(' / ')}（共 ${final.cities.length} 个，一个投完自动换下一个）`
              : final.cities[0]
            : '⚠️ 不限（全国）'
      }`,
      `  类型：${isBoss ? '沿用当前页参数（BOSS 没有实习/校招这个筛选项）' : typeText}`,
    ].join('\n')
    const noTplTip = isBoss
      ? ''
      : final.templateUrl
        ? ''
        : '\n提示：没存过模板，地址是按「关键词 / 城市 / 类型」三个参数拼的。落到页面后如果和你在网站上看到的不一样（栏目没了、实习/校招不对），到目标列表页点一次「取当前页当模板」。'

    // 多关键词必须开翻页：换词挂在「这个词翻到底」这个事件上，
    // 没开翻页就永远触发不了换词（会停在第 1 个词上，白排后面的词）
    const paging = await pagingConfig()
    const forcedPaging = urls.length > 1 && !paging.enabled
    if (forcedPaging) paging.enabled = true
    const nameOf = (u) =>
      (window.JH_FILTERS && typeof window.JH_FILTERS.taskNameOf === 'function'
        ? window.JH_FILTERS.taskNameOf(u)
        : '') || '?'
    // 城市 × 关键词时要说清「一共几轮」：用户勾了 2 个城市以为只搜一次，实际是 8 轮
    const gridText = final.cities.length > 1 && kws.length ? `${final.cities.length} 城 × ${kws.length} 词` : ''
    const pagingTip =
      urls.length > 1
        ? `\n已排 ${urls.length} 个搜索${gridText ? `（${gridText}）` : ''}：先跑「${nameOf(urls[0])}」，它翻到底后自动换「${nameOf(urls[1])}」，依次往下，不用你再点。${
            forcedPaging ? '（为了能跑到头，已自动勾上「投完自动翻页」）' : ''
          }`
        : ''
    // tab 必须和 platform 一致：BOSS 就用当前这个 tab，别再去找实习僧的页
    const tab = isBoss ? plat.tab : await findLineTab('sx')

    // 已经停在目标页：不用跳，直接发（这时页面里的脚本还活着）
    if (tab && sameSearchPage(tab.url, startUrl)) {
      log('已经在起点页，直接开投…')
      const res = await sendToLine(
        tab,
        { name: lineName },
        {
          action: 'batchStart',
          limit: batchLimitValue(),
          force: batchForceChecked(),
          pagingConfig: paging,
          kwUrls: urls,
          kwIndex: 0,
        },
        '启动指令没发出去'
      )
      log(startLogText(res, lineName))
      setTimeout(refreshBatch, 800)
      return
    }

    // 要跳页：先落一个「待启动」标记，页面加载完由 content 自己接手开投。
    // 这样弹窗被关掉也不影响 —— 不依赖 popup 活着等页面就绪。
    await chrome.storage.local.set({
      oneKeyPending: {
        at: new Date().toISOString(),
        line,
        limit: batchLimitValue(),
        force: batchForceChecked(),
        pagingConfig: paging,
        kwUrls: urls,
      },
    })

    if (!tab) {
      log(`${scopeText}\n正在打开${lineName}搜索页…（加载完会自动开始投）${pagingTip}${noTplTip}`)
      await chrome.tabs.create({ url: startUrl, active: true })
    } else {
      log(`${scopeText}\n正在跳到起点：${plainUrl(startUrl)}\n加载完会自动开始投，弹窗可以直接关。${pagingTip}${noTplTip}`)
      await chrome.tabs.update(tab.id, { url: startUrl, active: true })
    }
  } finally {
    btn.disabled = false
  }
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

/**
 * 把本地账本补传后端。
 *
 * 为什么需要这个按钮：投递成功那一刻，消息发出去了、本地账本也记了，
 * 但「回写后端」可能失败（页面 CSP 拦 fetch、后端没起、token 过期）。
 * 那些记录在本地是有的、后端没有 → 漏斗里永远缺这几家，而且没有任何报错。
 * 2026-11-03 BOSS 三家就是这个状况（页面上三家全「已发送招呼语」，后端一条都没有）。
 *
 * ⚠️ 必须走 collect（不是 POST /api/applications）：collect 有 sameApply 去重，
 * 匹配到就更新、匹配不到才新建，重复点是幂等的。直接 POST 会造重复记录。
 */
$('#pushAppliedBtn').addEventListener('click', async () => {
  const btn = $('#pushAppliedBtn')
  const { applied = {} } = await chrome.storage.local.get('applied')
  const keys = Object.keys(applied)
  if (!keys.length) return log('账本是空的，没有可补传的记录')

  // 账本 key = 平台前缀:jobId；item 里存了 platform/title/company/at
  const items = []
  for (const k of keys) {
    const it = applied[k] || {}
    if (!it.company && !it.title) continue
    items.push({
      platform: it.platform || (/^boss:/.test(k) ? 'BOSS直聘' : '实习僧'),
      jobId: it.jobId || k.replace(/^[a-z]+:/, ''),
      company: it.company || '',
      jobTitle: it.title || '',
      // 账本里没有方向，用标题判一个（判不出就留空，交给后端语料兜底）
      direction: directionOfTitle(it.title || ''),
      // 账本只记了「投过」，没有阶段信息 → 用人工 status 兜 submitted，
      // 之后采集器采到真实阶段会按权重覆盖
      stageRaw: '已投递',
      appliedAt: it.at || '',
    })
  }
  if (!items.length) return log('账本里没有可用的公司/岗位信息')

  const { jhBackend, jhToken } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
  const base = (jhBackend || 'http://localhost:3100').replace(/\/+$/, '')
  btn.disabled = true
  log(`补传 ${items.length} 条到后端…`)
  try {
    const r = await fetch(`${base}/api/applications/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(jhToken ? { Authorization: `Bearer ${jhToken}` } : {}),
      },
      // createMissing:true —— 账本里这些投递后端本来就没有，必须允许新建
      body: JSON.stringify({ items, createMissing: true }),
    })
    const data = await r.json().catch(() => ({}))
    if (r.status === 401) return log('❌ 401：先在下面「后端连接」里填 token')
    if (!r.ok) return log(`❌ 后端返回 ${r.status}：${data.error || ''}`)
    log(
      `✅ 补传完成｜新建 ${data.created || 0}｜推进 ${data.advancedCount || 0}` +
        `｜已在库 ${data.unchanged || 0}｜忽略 ${data.ignored || 0}`
    )
    const bad = (data.results || []).filter((x) => x.action === 'ignored')
    if (bad.length) {
      log(`⚠️ ${bad.length} 条没进去（公司/岗位名为空）：` + bad.map((x) => x.company || '(无公司)').join('、'))
    }
  } catch (e) {
    log(`❌ 连不上 ${base}（后端没启动？）：${e.message}`)
  } finally {
    btn.disabled = false
  }
})

// ===================== 投递筛选面板（A 方案配置） =====================
const F = window.JH_FILTERS
const DAY_OPTIONS = [2, 3, 4, 5]
const MONTH_OPTIONS = [1, 2, 3, 4, 6]
const SCORE_OPTIONS = [0, 40, 50, 60, 70]
// 经验要求上限：值是「岗位要求的最低年限」，0=只接受经验不限/在校，99=不筛
const EXP_OPTIONS = [0, 1, 3, 5, 99]
const EXP_LABEL = {
  0: '只投「经验不限/在校」',
  1: '还能接受「1年以内」',
  3: '还能接受「1-3年」',
  5: '还能接受「3-5年」',
  99: '不限（不筛经验）',
}
// 学历要求上限：值是「学历要求的序数」，6=不筛
const EDU_OPTIONS = [3, 4, 5, 6]

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

  // 方向快捷预设。为什么需要：勾着全部方向时，「前端开发 / 数据分析」等也会被放行，
  // 搜索结果里混进来的非目标岗就会被投出去。一个个取消勾选容易漏，所以给一键入口。
  // 2026-11-06：用户主战场转 BOSS，同时投「运营 + 测试」两类，默认预设也带上 ops。
  const TEST_DIRECTIONS = ['qa', 'auto', 'api', 'game', 'ops']
  const onlyBtn = document.getElementById('dirTestOnly')
  if (onlyBtn) {
    onlyBtn.addEventListener('click', async () => {
      jobFilters.directions = [...TEST_DIRECTIONS]
      renderDirList()
      await saveJobFilters()
      log('✅ 方向已设为「测试 + 运营」：测试开发/软件测试、自动化/SDET、接口/性能、游戏测试、内容/达人/新媒体运营')
    })
  }
  const clearBtn = document.getElementById('dirClearAll')
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      jobFilters.directions = []
      renderDirList()
      await saveJobFilters()
      log('✅ 方向已清空 = 不限方向（任何岗位都放行，只靠关键词 + 城市把关）')
    })
  }
  fillSelect($('#daysSel'), DAY_OPTIONS, jobFilters.daysPerWeek || 4, (v) => `${v} 天/周`)
  fillSelect($('#monthsSel'), MONTH_OPTIONS, jobFilters.months || 3, (v) =>
    v === 6 ? '6 个月及以上' : `${v} 个月`
  )
  fillSelect($('#scoreSel'), SCORE_OPTIONS, jobFilters.minScore || 0, (v) =>
    v === 0 ? '不启用' : `≥ ${v} 分`
  )
  // BOSS 专用两项。默认「只投经验不限/在校」+「最高接受本科」——
  // 实习僧卡片上没有这两个词，读不到就不拦，所以对那条线零影响。
  fillSelect($('#expSel'), EXP_OPTIONS, jobFilters.maxExperience != null ? jobFilters.maxExperience : 0, (v) =>
    EXP_LABEL[v] || String(v)
  )
  fillSelect($('#eduSel'), EDU_OPTIONS, jobFilters.maxEduRank != null ? jobFilters.maxEduRank : 4, (v) =>
    v >= 6 ? '不限（不筛学历）' : `最高接受「${(F.EDU_LABELS || [])[v] || '本科'}」`
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
  $('#expSel').addEventListener('change', (e) => {
    // 0 是有效值（只投经验不限），不能用 || 兜底，否则会被当成「没选」
    jobFilters.maxExperience = Number(e.target.value)
    saveJobFilters()
  })
  $('#eduSel').addEventListener('change', (e) => {
    jobFilters.maxEduRank = Number(e.target.value)
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
  // 本地已有话术时**不覆盖**（用户可能自己改过）；要先看后端那句就点「重新取话术」
  fetchGreetingFromBackend({ overwrite: false })
}

/**
 * 从后端取「这个岗位该用什么话术」。
 *
 * 为什么要有：以前话术只能手动粘进弹窗 —— 网页端「AI 定制」为每个岗位生成的那条，
 * 扩展根本拿不到，于是每次投递都要「复制 → 切弹窗 → 粘贴」。
 * 现在后端会按「公司 + 岗位名」找出这条投递自己的话术，找不到才退回设置页的默认话术
 * （默认话术里的 `{{公司}}` / `{{岗位}}` 由后端替换好再返回，扩展不用管）。
 *
 * @param {{overwrite?: boolean}} opts overwrite=true 时无条件覆盖输入框
 */
async function fetchGreetingFromBackend({ overwrite = false } = {}) {
  const st = $('#greetStatus')
  const { jhBackend, jhToken } = await chrome.storage.local.get(['jhBackend', 'jhToken'])
  if (!jhToken) {
    if (st) st.textContent = '未连后端，不会自动取话术'
    return { ok: false }
  }
  const base = (jhBackend || 'http://localhost:3100').replace(/\/+$/, '')

  // 先问当前页面是哪个岗位；问不到就只要默认话术（后端支持不带参数）
  let job = null
  try {
    const tab = await activeTab()
    job = await chrome.tabs.sendMessage(tab.id, { action: 'jobInfo' })
  } catch {
    job = null
  }
  const q = new URLSearchParams()
  if (job && job.company) q.set('company', job.company)
  if (job && job.jobTitle) q.set('jobTitle', job.jobTitle)

  try {
    const r = await fetch(`${base}/api/greeting?${q}`, {
      headers: { Authorization: `Bearer ${jhToken}` },
    })
    if (!r.ok) {
      if (st) st.textContent = `取话术失败（${r.status}）`
      return { ok: false }
    }
    const d = await r.json().catch(() => ({}))
    const text = String(d.text || '').trim()
    const box = $('#greeting')
    if (!text) {
      if (st) st.textContent = '后端没有可用话术（去网页「设置」填默认话术）'
      return { ok: false }
    }
    if (box.value.trim() && !overwrite) {
      if (st) st.textContent = '已从后端取到，但框里已有内容没覆盖'
      return { ok: true, kept: true }
    }
    box.value = text
    // 触发 input 让持久化那条链路把它存进 chrome.storage
    box.dispatchEvent(new Event('input'))
    if (st) {
      st.textContent =
        d.source === 'application'
          ? `✅ 用了「${(d.matched && d.matched.jobTitle) || '这个岗位'}」的定制话术`
          : '✅ 用了默认话术'
    }
    return { ok: true, source: d.source }
  } catch (e) {
    if (st) st.textContent = `取话术失败：${e.message}`
    return { ok: false }
  }
}

$('#fetchGreetingBtn').addEventListener('click', () => fetchGreetingFromBackend({ overwrite: true }))

// ===================== 投递范围调度 =====================
// 「开始 / 停止」是门面按钮：真正的执行入口还是下面那些老按钮（逻辑一行没动），
// 只是按范围把点击转发过去。这样瘦身只改布局，不碰投递逻辑。
const SCOPE_TARGET = {
  single: 'applyBtn',
  page: 'batchBtn',
  onekey: 'oneKeyBtn',
}

function currentScope() {
  const el = document.querySelector('input[name="scope"]:checked')
  return el ? el.value : 'single'
}

$('#goBtn').addEventListener('click', () => {
  const scope = currentScope()
  const btn = document.getElementById(SCOPE_TARGET[scope])
  if (!btn) return log(`❌ 找不到「${scope}」对应的执行入口`)
  if (btn.disabled) return log('正在跑，先点「停止」再启动')
  log(`▶ 开始：${scope === 'single' ? '当前岗位' : scope === 'page' ? '当前列表页' : '一键（翻页/换词）'}`)
  btn.click()
})

$('#stopBtn').addEventListener('click', async () => {
  log('⏹ 请求停止…')
  const btn = document.getElementById('batchStopBtn')
  if (btn) btn.click()
})

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
// 最近一次采集的 debug。预览会被上传汇总覆盖，但「有几行没解析出来」这件事
// 不能跟着预览一起消失 —— 它才是「页面 2 条 / 库里 1 条」的答案。
let lastCollectDbg = null

/**
 * 采集完 → 主流程上出现「确认上传（N 条）」。
 *
 * ⚠️ 这个按钮在 v0.8.0 被收进了「高级 · 预览 / 校准 / 重置」折叠区，但聊天页采集
 *    是「只预览、不自动传」的（实习僧那两条才自动传）。结果：采完 9 条预览，
 *    状态栏写「确认无误再上传」，而主流程上根本没有上传入口 —— 数据一条也没进库，
 *    界面上却一切正常。按钮必须跟预览同屏，这是它存在的唯一意义。
 */
function setUploadReady(n) {
  const btn = $('#collectUploadBtn')
  if (!btn) return
  if (!n) {
    btn.hidden = true
    btn.disabled = true
    btn.textContent = '确认上传'
    return
  }
  btn.hidden = false
  btn.disabled = false
  btn.textContent = `确认上传（${n} 条）`
}

async function collectProgress(probeMode) {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  setUploadReady(0)
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
      // 列表页（BOSS 搜索结果页 / 实习僧列表页）：这里没有「投递记录」，只有岗位卡。
      // 卡片边界锁不准是这个页面最致命的错，所以状态栏直接给结论，不用去 JSON 里翻。
      const L = d.listing
      if (L) {
        st.textContent =
          `列表页：${L.links} 个岗位链接｜锁到 ${L.rowCount} 个容器` +
          (L.sharedRows && L.sharedRows.length ? `｜⚠️ ${L.sharedRows.length} 处边界锁大了` : '｜边界正常')
        return
      }
      const m = d.mirror
      // 一个行都没认出来（BOSS 对话列表常见）：别只报「探测 0 行」，
      // 那是句废话 —— 要说清「下面有结构可看」，否则用户不知道该往哪找。
      // BOSS 会话列表：一眼看出「读没读、有没有回复」，比让用户去翻 JSON 有用
      const cl = d.chatList
      if (cl && cl.count) {
        const rows = cl.rows || []
        const read = rows.filter((r) => r.read === true).length
        const sent = rows.filter((r) => r.read === false).length
        const noIcon = rows.filter((r) => r.read === null).length
        // 右侧有没有打开，决定这次探测能不能回答「点开一条会话能拿到岗位名吗」。
        // 没打开就别让人去 JSON 里找答案 —— 那份 JSON 本来就答不了这个问题。
        const pm = d.chatPanel
        const opened = !!(pm && pm.panel)
        const isEmpty = !!(pm && pm.panel && pm.panel.empty)
        // 没找到对话区不代表没打开会话 —— BOSS 可能把它挂在别处（浮层 / Shadow DOM）。
        // 反过来，找到了对话区也可能是空状态占位（24 字的「都会在左侧列表中显示」）。
        // 这两种「看起来有、其实没数据」的情况必须说出区别，否则用户会以为探测完成了。
        st.textContent =
          `会话 ${cl.count} 条｜已读 ${read} · 送达未读 ${sent} · 无图标 ${noIcon}` +
          (opened
            ? isEmpty
              ? `｜⚠️ 对话区是空的（${pm.panel.textLength} 字占位）—— 点开一条会话再探测`
              : `｜右侧「${pm.panel.el}」消息 ${pm.panel.msgNodes} 个 · 岗位线索 ${pm.panel.hints.length} 条`
            : `｜⚠️ 对话区不在列表旁（岗位链接 ${pm.jobLinks || 0} 条 · Shadow ${
                pm.shadowCount || 0
              } 个）`) +
          ` —— 点上方「复制整段」发我`
        return
      }

      if (d.layout) {
        const g = (d.layout.groups || []).length
        const c = (d.containers && d.containers.list) || []
        const f = d.frames && d.frames.count
        // 某一段在页面结构上炸了不该拖垮整份报告 —— 但要明说哪段没拿到，别让人以为「页面真没有」
        const errs = ['layout', 'containers', 'signals', 'frames'].filter((k) => d[k] && d[k].error)
        st.textContent =
          `没认出投递行｜重复结构 ${g} 组、容器 ${c.length} 个${f ? `、iframe ${f} 个` : ''}` +
          (errs.length ? `｜⚠️ ${errs.join('/')} 出错` : '') +
          ` —— 点上方「复制整段」发我`
        return
      }
      st.textContent = m
        ? `探测 ${d.rows ? d.rows.length : 0} 行｜${m.verdict}`
        : `探测 ${d.rows ? d.rows.length : 0} 行（无分类 tab，走文本兜底）`
      return
    }

    collectPreview = Array.isArray(d.items) ? d.items : []
    const dbg = d.debug || {}
    lastCollectDbg = dbg
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
    setUploadReady(collectPreview.length)
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

  // ⚠️ 这里必须列出**所有** tab，包括 0 条的 —— note（为什么被跳过/为什么没采到）
  // 只挂在 0 条的那个 tab 上，过滤掉就等于把唯一的线索藏了。
  const tabs = dbg.tabs || []
  if (tabs.length) {
    lines.push('各分类 tab：')
    for (const t of tabs) {
      const tag = t.skipped
        ? '未确认切换·已跳过'
        : t.rows
          ? t.mirrored
            ? '镜像·只信行内文案'
            : t.paged
              ? '真分组·已翻页'
              : '仅第 1 页'
          : '未采到'
      const body = t.rows ? `${t.rows} 条 / ${t.pages} 页` : '0 条'
      lines.push(`  ${t.name}（${tag}）→ ${body}` + (t.note ? `｜${t.note}` : ''))
    }
  }
  if (dbg.baseTab) {
    lines.push(`\n基线 tab：${dbg.baseTab}（有「已投递」就用它，否则取行最多的；与它集合相同的 tab 判为镜像）`)
  }
  if (dbg.mirrored) {
    lines.push(`判定：${dbg.mirrored} 个 tab 与基线列表完全相同 → 全量镜像，阶段只信行内文案`)
  } else if (dbg.grouped) {
    lines.push('判定：各 tab 列表互不相同 → 真分组，阶段按 tab 名判定')
  }
  if (dbg.mode === 'single') lines.push('\n未识别到分类 tab（BOSS 列表或平台改版），按单视图翻页采集')
  // 被丢掉的行：页面上看得见、但没进预览（因此也不会入库）。
  // 只说一个数字没用 —— 「初筛 2 条、这里 1 条」时，必须看到那条的原文才知道是
  // 「解析器不认识这种卡片」还是「这一条本来就该跳过」。
  if (dbg.noName) {
    lines.push(`\n⚠️ 有 ${dbg.noName} 行没解析出来（没进预览，也不会入库）：`)
    const ds = dbg.dropped || []
    if (ds.length) {
      for (const d of ds.slice(0, 6)) lines.push(`  · ${d}`)
      if (dbg.noName > ds.length) lines.push(`  … 还有 ${dbg.noName - ds.length} 行（只保留前 6 条原文）`)
    } else {
      lines.push('  · （没留下原文，点「探测（校准用）」看页面结构）')
    }
  }
  if (dbg.notes && dbg.notes.length) lines.push(`\n[提示] ${dbg.notes.join('；')}`)
  return lines.join('\n')
}

// 全阶段采集：content.js 逐一切换分类 tab（已投递/被查看/初筛/…）并翻页，
// 按 jobId 合并取权重最大的阶段。不是 tab 页面时自动退回单视图翻页。
async function collectAllProgress() {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  setUploadReady(0)
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
    lastCollectDbg = dbg
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
    setUploadReady(collectPreview.length)
  } catch (e) {
    st.textContent = '❌ 请先打开实习僧「我的投递 → 投递反馈」页'
  }
}

/**
 * BOSS 聊天页：逐条**点开**会话采集。
 *
 * 和「只采当前视图」的区别：那个只读页面、绝不点击；这个会真的点左侧会话行 ——
 * 岗位名只在点开后的右栏出现，不点开就什么都拿不到（列表 li 上没有任何 id/data-*）。
 * 代价是慢（每条约 1 秒）且有副作用（点开会把对方发来的未读标成已读），
 * 所以一律先出预览，用户确认后才允许上传。
 */
async function collectChatProgress() {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  const btn = $('#collectChatBtn')
  if (btn.disabled) return
  btn.disabled = true
  setUploadReady(0)
  collectPreview = null
  // 逐条点开要按条数累加（9 条约 9 秒），中间完全没有反馈会让人以为卡死 ——
  // 加个呼吸点，至少说明「还在动」。
  let tick = 0
  const timer = setInterval(() => {
    tick = (tick + 1) % 4
    st.textContent = `正在逐条点开会话${'…'.repeat(tick + 1)}（每条约 1 秒，别关弹窗、别切走页面）`
  }, 900)
  st.textContent = '正在逐条点开会话…（每条约 1 秒，别关弹窗、别切走页面）'
  out.textContent = ''
  try {
    const tab = await activeTab()
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'collectChat', scope: 'interactive' })
    if (!res || res.ok === false) {
      st.textContent = `❌ ${(res && res.error) || '采集失败'}`
      return
    }
    const d = res.data || {}
    const items = Array.isArray(d.items) ? d.items : []
    const dbg = d.debug || {}
    if (!items.length) {
      const why = (dbg.notes || []).join('；')
      st.textContent = `没采到会话${why ? `（${why}）` : '（这一页可能不是 BOSS 聊天页）'}`
      out.textContent = JSON.stringify(dbg, null, 2)
      return
    }
    collectPreview = items
    st.textContent =
      `采到 ${items.length} 条会话（点开 ${dbg.opened || 0}/${dbg.picked || 0} 条）` +
      `—— 确认无误再上传`
    out.textContent = renderChatPreview(items, dbg)
    setUploadReady(collectPreview.length)
  } catch (e) {
    st.textContent = '❌ 请先打开 BOSS「消息」页（聊天列表）'
  } finally {
    clearInterval(timer)
    btn.disabled = false
  }
}

function renderChatPreview(items, dbg) {
  const lines = []
  lines.push(`会话 ${dbg.rowsTotal || 0} 条 → 点开 ${dbg.opened || 0} 条 → 采到 ${items.length} 条`)
  if (dbg.notes && dbg.notes.length) lines.push(`[提示] ${dbg.notes.join('；')}`)
  // 点开失败 / 没有岗位卡的必须列出来 —— 它们没进预览，但「为什么没进」是排查漏采的唯一线索
  if (dbg.failed && dbg.failed.length) lines.push(`[点开没反应] ${dbg.failed.join('、')}`)
  if (dbg.noCard && dbg.noCard.length) lines.push(`[没有岗位卡] ${dbg.noCard.join('、')}`)
  lines.push('')
  let noDir = 0
  let noMine = 0
  items.forEach((x, i) => {
    const dir = x.direction || directionOfTitle(x.jobTitle)
    // 没有方向词 ≠ 出错，多半是运营/产品岗 —— 但也可能是测试岗标题写法特殊，标出来自己看
    if (!dir) noDir++
    const tag = dir ? `[${dir}]` : '[无方向词]'
    const meta = [x.city, x.salary].filter(Boolean).join(' · ')
    lines.push(`${i + 1}. ${x.company || '（公司名没拆出来）'} / ${x.jobTitle}  ${tag}`)
    if (meta) lines.push(`   ${meta}`)
    // read 三态分开说。不能用 `x.read ? 已读 : 未读` ——
    // 会话采集只挑「已读 / 无图标」这两类，false 根本不会出现，
    // 于是「无图标」被一律显示成「未读」，读起来像「HR 没看我的消息」，正好说反。
    const flags = []
    if (x.readState === 'read' || x.read === true) flags.push('我方消息已读')
    else if (x.readState === 'delivered') flags.push('只送达未读')
    if (x.replied) flags.push('对方最后发言')
    // 我自己说不合适 = 我放弃，不是被拒。这两件事在后端是两个字段，
    // 预览里必须分开标 —— 否则用户以为这条被人拒了。
    if (x.withdrawn) flags.push('🙋 我放弃（我最后说不合适）')
    // 我一句话都没说过 = 是 HR 主动找我，不是我投的（这类不该计入投递量）
    if (x.myMsgCount === 0) flags.push('⚠️ 我没发过消息')
    else if (x.firstFrom === 'me') flags.push('我先开口')
    if (x.msgCount) flags.push(`${x.msgCount} 条消息`)
    if (x.chatAt) flags.push(`最后 ${x.chatAt}`)
    lines.push(`   ${flags.join(' · ')}`)
    if (x.lastText) lines.push(`   「${x.lastText}」`)
    if (x.companyGuess) lines.push('   ⚠️ 公司名是从文本里拆的，可能不准（对不上账本会被忽略）')
    if (x.myMsgCount === 0) noMine++
  })
  lines.push('')
  if (noDir) {
    lines.push(
      `⚠️ ${noDir} 条标题里没有测试方向词（多为运营 / 产品 / 编导岗）——` +
        `入库后不会计入「测试方向」口径，只是历史记录。`
    )
  }
  if (noMine) {
    lines.push(
      `⚠️ ${noMine} 条你一句话都没发过（是 HR 主动找你）——` +
        `它们不是你的投递，入库会把「投递量」撑大。`
    )
  }
  lines.push('⚠️ 这些会话没有 jobId（BOSS 聊天页拿不到），后端只能按「公司 + 岗位名」匹配账本。')
  lines.push('⚠️ 已读 / 回复时间会记成「本次采集的时间」，不是真实发生的时刻。')
  return lines.join('\n')
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
  const filtered = await filterAlreadySynced(collectPreview)
  collectPreview = filtered.items
  const skipped = before - collectPreview.length
  if (!collectPreview.length) {
    st.textContent = `✅ 无新变化（${before} 条均已同步且阶段未变）`
    // 「无新变化」≠「数据齐了」：解析失败的行根本不在这里面。
    // 不把这句话带出来，用户会以为平台的投递数量已经全对上了。
    const dropTip =
      lastCollectDbg && lastCollectDbg.noName
        ? `\n\n⚠️ 但另有 ${lastCollectDbg.noName} 行没解析出来（没入库）：\n` +
          ((lastCollectDbg.dropped || []).slice(0, 6).map((d) => `  · ${d}`).join('\n') ||
            '  · （没留下原文，点「探测（校准用）」看页面结构）')
        : ''
    out.textContent =
      '平台没往后推进，没有需要更新的。\n\n想确认「全阶段采集」本身抓到了什么，点「全阶段采集（先看预览）」。' + dropTip
    setUploadReady(0)
    return
  }
  const tips = []
  if (filtered.migrated) {
    // 缓存升级后的一次性全量核对 —— 必须说明，否则用户会以为「怎么突然全都要重报」
    tips.push(
      `同步缓存刚升级（开始记录公司名），本次做一轮全量核对：${before} 条都会报一次，没变化的后端回「未变化」——这是把历史「未知公司」补上必须走的一趟。`
    )
  }
  if (skipped > 0) tips.push(`已跳过 ${skipped} 条未变化的，剩余 ${collectPreview.length} 条待上报。`)
  if (tips.length) out.textContent = tips.join('\n') + '\n\n' + out.textContent
  const up = await uploadProgress()
  // ⚠️ 上传没成功就**绝不能记账**：记了就是假同步 —— 这条以后永远被当成「已同步」跳过，
  // 数据静默丢失，而且页面上看起来一切正常。2026-11-03 就是这样丢掉了一条「初筛」。
  if (!up || !up.ok) return
  const results = (up.data && up.data.results) || []
  const ignored = results.filter((r) => r.action === 'ignored')
  const ignoredIds = ignored.map((r) => r.jobId).filter(Boolean)

  // ⚠️ 记账必须用**后端确认落库的阶段**，不能用采集端看到的阶段。
  //    后端可能因为「已经是更高阶段」「匹配到另一条记录」而没有接受这次上报；
  //    此时若按采集端的值记账，缓存就比后端超前 → 以后每次采集都被自己过滤掉 →
  //    那条状态永远传不上去，界面上还一直显示「无新变化」（2026-11-03 初筛卡住就是这么来的）。
  //    results 里：advanced→to、unchanged→current、created→stage。
  const landedStage = new Map()
  for (const r of results) {
    if (r.action === 'ignored') continue
    const st = r.to || r.current || r.stage || null
    if (r.jobId && st) landedStage.set(r.jobId, st)
  }
  const remembered = collectPreview
    .filter((it) => it.jobId && landedStage.has(it.jobId))
    .map((it) => ({ ...it, stage: landedStage.get(it.jobId) }))
  await rememberSynced(remembered)
  // 被忽略的从缓存里删掉，下次还会重新上报（直到它在账本里出现）
  await forgetSynced(ignoredIds)
  if (ignored.length) {
    st.textContent += `｜${ignored.length} 条对不上账本，下次仍会重报`
  }
}

// 「已同步」缓存：记下上次上传时「jobId + 阶段」的组合。
// 下次采集时，jobId 相同且阶段没变的直接跳过（省重复请求），阶段变了的照报（不漏推进）。
// 存 chrome.storage.local，键 jhSyncedJobs = { [jobId]: stageKey }。
/** 缓存里的公司名算不算「没有」：空 / 「未知公司」这类占位都算 */
function isMissingCompany(s) {
  const t = String(s || '').trim()
  // 只认「未知 / 不详」开头，不能写成 /无/ —— 「无锡××科技」是真公司名
  return !t || /^(未知|不详)/.test(t)
}

/**
 * 这条要不要重新上报？
 * - 阶段变了 → 要（原逻辑）
 * - 阶段没变，但上次记的公司名是「未知/空」而这次采到了 → 也要。
 *   ⚠️ 不加这条，后端那条「未知公司」永远修不好：中金财富 2 条 jobId 一直匹配得上、
 *   阶段一直是 viewed，缓存判「未变化」直接跳过 → 后端一次都收不到订正数据。
 *   （2026-11-06 真机：库里 2 条「未知公司」，采集次次拿到真名，却永远补不上）
 *
 * @returns {{items:Array, migrated:boolean}} migrated=旧缓存需要升级（本次会全量核对一轮）
 */
async function filterAlreadySynced(items) {
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  // 旧缓存形状是「jobId → 阶段字符串」，新形状是 {stage, company}。
  // 遇到旧值时**一次全量重报**：旧缓存里没有公司名，无从判断哪条缺，
  // 与其永远修不掉，不如让它核一轮（后端对没变化的会回 unchanged，代价只是慢几秒）。
  const migrated = Object.values(jhSyncedJobs).some((v) => typeof v === 'string')
  const out = items.filter((it) => {
    const id = it.jobId
    if (!id) return true // 没有 jobId 的没法判断，照报
    const prev = jhSyncedJobs[id]
    const prevStage = typeof prev === 'string' ? prev : prev && prev.stage
    if (prevStage !== it.stage) return true
    const prevCompany = typeof prev === 'string' ? '' : (prev && prev.company) || ''
    return isMissingCompany(prevCompany) && !isMissingCompany(it.company)
  })
  return { items: out, migrated }
}

async function rememberSynced(items) {
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  const next = { ...jhSyncedJobs }
  for (const it of items) {
    if (it.jobId && it.stage) next[it.jobId] = { stage: it.stage, company: it.company || '' }
  }
  await chrome.storage.local.set({ jhSyncedJobs: next })
}

/**
 * 把指定的 jobId 从「已同步」缓存里删掉。
 *
 * 用在哪：后端明确返回 ignored 的那些（账本里没有这条投递 / 缺字段 / 不属于当前账号）。
 * 它们没入库，却被记成已同步的话，下次采集会被直接跳过 —— 页面上有这条，库里永远没有。
 */
async function forgetSynced(ids) {
  if (!Array.isArray(ids) || !ids.length) return
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  let changed = false
  for (const id of ids) {
    if (id in jhSyncedJobs) {
      delete jhSyncedJobs[id]
      changed = true
    }
  }
  if (changed) await chrome.storage.local.set({ jhSyncedJobs })
}

/**
 * 上传采集结果。
 * @returns {Promise<{ok:boolean, data?:object}>} 调用方必须看返回值再决定要不要记账 ——
 *   只有后端真的收下了才算「已同步」，否则就是假同步（见 forgetSynced 的注释）。
 */
async function uploadProgress(opts = {}) {
  if (!collectPreview || !collectPreview.length) return { ok: false }
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
      // 采集来的行本身不带方向（平台页面上没这个字段）→ 用标题补一个。
      // 不补的话每次采集都只更新阶段，老记录的空 direction 永远填不上。
      body: JSON.stringify({
        items: collectPreview.map((it) => ({
          ...it,
          direction: it.direction || directionOfTitle(it.jobTitle),
        })),
        // 只有用户点了「补录」才建：默认不建是刻意的（账本里没有的不随便入库），
        // 但页面上明明有这条投递却永远进不来，投递量就永远对不上平台。
        ...(opts.createMissing ? { createMissing: true } : {}),
      }),
    })
    if (r.status === 401) {
      st.textContent = '❌ 401：先在下面「后端连接」里填 token'
      return { ok: false }
    }
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      st.textContent = `❌ 后端返回 ${r.status}：${data.error || ''}`
      return { ok: false }
    }
    // 整体汇总：把上报条数 + 后端处理结果一起呈现，扫一眼就知道干了什么
    const lines = []
    lines.push(`上报 ${collectPreview.length} 条，已提交后端：`)
    lines.push(`  · 匹配 ${data.matched || 0}（本地已有这条投递）`)
    lines.push(`  · 推进 ${data.advancedCount || 0}（阶段往前走了）`)
    lines.push(`  · 新建 ${data.created || 0}（本地账本没有，新入库）`)
    lines.push(`  · 忽略 ${data.ignored || 0}（对不上，未入库）`)

    // 本次上报的阶段分布：判断「是不是某个阶段整档没采到」最快的一眼。
    // 例如页面上有 1 条初筛，这里却只有「已投递/被查看/不合格」，就说明初筛那档漏了。
    // 会话采集（BOSS 聊天页）**没有 stage** —— 「已读」是读没读，不是流程阶段，
    // 硬塞进 stages 分布会显示成 unknown，所以单独统计读/回。
    const dist = {}
    let noStage = 0
    let readN = 0
    let repliedN = 0
    let withdrawnN = 0
    for (const it of collectPreview) {
      if (it.stage) dist[it.stage] = (dist[it.stage] || 0) + 1
      else noStage++
      if (it.read) readN++
      if (it.replied) repliedN++
      if (it.withdrawn) withdrawnN++
    }
    const order = ['submitted', 'viewed', 'screening', 'written', 'interview', 'rejected', 'offer', 'unknown']
    const distTxt = order
      .filter((k) => dist[k])
      .map((k) => `${STAGE_CN[k] || k} ${dist[k]}`)
      .join(' / ')
    if (distTxt) lines.push(`\n本次上报：${distTxt}`)
    if (noStage)
      lines.push(
        `\n会话采集（不推阶段）：已读 ${readN} 条 / 对方回过话 ${repliedN} 条` +
          (withdrawnN ? ` / 我放弃 ${withdrawnN} 条（记入「我放弃」，不算被拒）` : '')
      )

    // 页面上有、但连预览都没进的行（解析失败）。上传只覆盖预览里的那些，
    // 所以必须单独说一句 —— 否则「初筛 2 条、库里只有 1 条」永远查不出原因，
    // 而界面上看着「已同步、一切正常」。
    if (lastCollectDbg && lastCollectDbg.noName) {
      lines.push('')
      lines.push(`⚠️ 另有 ${lastCollectDbg.noName} 行没解析出来（没上传，所以库里没有）：`)
      const ds = lastCollectDbg.dropped || []
      for (const d of ds.slice(0, 6)) lines.push(`  · ${d}`)
      if (!ds.length) lines.push('  · （没留下原文，点「探测（校准用）」看页面结构）')
    }

    // 公司名被后端订正过的 —— 必须说出来。这条记录以前一直显示别人家的名字，
    // 而且正因为它对不上，它的已读/被拒一直传不进来。不报的话用户会以为界面上
    // 那个公司名本来就是这样。
    const fixed = (data.results || []).filter((x) => x.companyFixed)
    if (fixed.length) {
      lines.push('')
      lines.push(`订正 ${fixed.length} 条公司名（账本里记错了，按聊天页的说法改）：`)
      for (const x of fixed.slice(0, 8)) {
        lines.push(`  · ${x.companyFixed.from || '(空)'} → ${x.companyFixed.to}`)
      }
    }

    // 标题被「届别标签」占过的（真机事故：3 条不同岗位标题都是「27届」）。
    // 采集端已修，但写坏的旧值得靠 jobId 精确命中时自愈 —— 不说出来用户不会知道好了。
    const tfix = (data.results || []).filter((x) => x.titleFixed)
    if (tfix.length) {
      lines.push('')
      lines.push(`订正 ${tfix.length} 条岗位名（原来是届别标签，不是标题）：`)
      for (const x of tfix.slice(0, 8)) {
        lines.push(`  · ${x.titleFixed.from} → ${x.titleFixed.to}`)
      }
    }

    // ⚠️ 被忽略的必须列出来：它们没进库，但页面上明明有这条投递 ——
    // 不写清楚用户会以为「已同步 = 数据都在」，实际是静默丢失。
    const ignored = (data.results || []).filter((x) => x.action === 'ignored')
    if (ignored.length) {
      lines.push('')
      lines.push(`下面 ${ignored.length} 条对不上本地账本，没入库：`)
      for (const x of ignored.slice(0, 12)) {
        lines.push(`  · ${x.company || '?'} / ${x.jobTitle || '?'}｜${x.reason || '未匹配'}`)
      }
      if (ignored.length > 12) lines.push(`  … 还有 ${ignored.length - 12} 条`)
      lines.push('')
      lines.push('要收进来：点下面的「补录」，或先在 job-hunter 里手动记一条同名投递。')
    }

    // 「补录」按钮：只对「账本里没有」这一类有用（缺字段 / 不属于本账号的补录也建不出来）。
    // 默认不自动建是刻意的 —— 但入口得给，否则这些投递永远进不了库，投递量永远对不上平台。
    const adoptBtn = $('#collectAdoptBtn')
    if (adoptBtn) {
      const n = ignored.filter((x) => /账本里没有/.test(String(x.reason || ''))).length
      adoptBtn.hidden = !n
      adoptBtn.disabled = false
      adoptBtn.textContent = `补录这 ${n} 条（账本里从来没有的投递）`
    }

    // 采集到的阶段 ≠ 后端落库的阶段 → 后端没接受这次上报。
    // 一定要暴露：否则「页面上是初筛、库里还是已投递」这种偏差只能靠翻数据库才发现，
    // 而界面上一直显示「无新变化」，看起来一切正常。
    const asked = new Map()
    for (const it of collectPreview) if (it.jobId && it.stage) asked.set(it.jobId, it.stage)
    const mismatch = (data.results || []).filter((r) => {
      if (!r.jobId || r.action === 'ignored') return false
      const got = r.to || r.current || r.stage || null
      const want = asked.get(r.jobId)
      return want && got && want !== got
    })
    if (mismatch.length) {
      lines.push('')
      lines.push(`下面 ${mismatch.length} 条后端没接受这次上报的阶段（库里比页面旧）：`)
      for (const r of mismatch.slice(0, 12)) {
        const want = asked.get(r.jobId)
        const got = r.to || r.current || r.stage
        lines.push(
          `  · ${r.company || '?'} / ${r.jobTitle || '?'}｜采集 ${STAGE_CN[want] || want}｜后端 ${STAGE_CN[got] || got}`
        )
      }
      lines.push('这些没有真正入库，下次采集会继续上报。')
    }
    // 会话采集本来就不推阶段（只记已读/回复），对它说「平台还没往后走」是废话
    if (data.matched && !data.advancedCount && !noStage) {
      const hasMoved = Object.keys(dist).some((k) => k !== 'submitted' && k !== 'unknown')
      lines.push('')
      lines.push(
        hasMoved
          ? '阶段没变化 = 后端已经是这些阶段了，正常。'
          : '阶段没变化 = 平台还没往后走，正常。'
      )
    }
    st.textContent =
      `✅ 完成｜匹配 ${data.matched || 0}｜推进 ${data.advancedCount || 0}` +
      `｜新建 ${data.created || 0}｜忽略 ${data.ignored || 0}`
    // ⚠️ 汇总不能把采集明细冲掉：明细里的「各分类 tab」是排查漏采的唯一线索
    // （哪个 tab 被跳过、为什么跳过），一旦盖掉就只剩一句「完成」，出事没法查。
    const detail = out.textContent || ''
    out.textContent =
      lines.join('\n') + (detail ? `\n\n────────── 采集明细 ──────────\n${detail}` : '')
    setUploadReady(0)
    return { ok: true, data }
  } catch (e) {
    st.textContent = `❌ 连不上 ${base}（后端没启动？）`
    return { ok: false }
  }
}

/**
 * 清空「已同步」缓存，让下次采集把所有投递重新上报一遍。
 *
 * 为什么需要这个按钮：缓存一旦被污染（比如假同步把 ignored 的也记进来），
 * 「一键采集」会把它们全部过滤掉 → 根本走不到上传 → 缓存永远清不掉，形成死锁。
 * 重复上报是幂等的：已入库的只算「匹配/未变化」，不会重复新建。
 */
async function resetSynced() {
  const st = $('#collectStatus')
  const out = $('#collectOut')
  const { jhSyncedJobs = {} } = await chrome.storage.local.get('jhSyncedJobs')
  const n = Object.keys(jhSyncedJobs).length
  await chrome.storage.local.remove('jhSyncedJobs')
  st.textContent = `✅ 已清空同步缓存（${n} 条记录）`
  out.textContent =
    '下次「一键采集全阶段并上传」会把全部投递重新上报一遍。\n' +
    '重复上报是幂等的：已经入库的只会算「匹配 / 未变化」，不会重复新建。'
}

document.getElementById('collectBtn').addEventListener('click', () => collectProgress(false))
document.getElementById('collectAllBtn').addEventListener('click', collectAllProgress)
document.getElementById('collectOneClickBtn').addEventListener('click', collectAndUpload)
document.getElementById('collectProbeBtn').addEventListener('click', () => collectProgress(true))
document.getElementById('collectChatBtn').addEventListener('click', collectChatProgress)
document.getElementById('collectUploadBtn').addEventListener('click', uploadProgress)

/**
 * 补录：把「页面上有、账本里从没记过」的投递按 createMissing 再报一次。
 *
 * 为什么要有这个按钮：默认不自动建是刻意的（账本里没有的不随便入库，否则重复投递没人管），
 * 但代价是这批数据永远进不来 —— 投递量跟平台对不上，漏斗分母偏小。
 * 所以给一个显式出口：用户看见「忽略了 5 条」自己决定补不补。
 * ⚠️ HR 主动找你（我一句话没发过）的仍会被后端拦掉，补录也建不出来 —— 那不是我的投递。
 */
document.getElementById('collectAdoptBtn').addEventListener('click', async () => {
  const btn = $('#collectAdoptBtn')
  if (!collectPreview || !collectPreview.length || btn.disabled) return
  // 补录是**唯一会造新记录**的动作，点错一次就得手工清（2026-11-05 真踩过）。
  // 那次的形态极具迷惑性：「确认上传」显示匹配 0 / 忽略全部，看着像「账本里真没有」，
  // 其实后端跑的是没重启的旧代码（少了「按岗位名兜底认人」）。
  // 所以这里必须说清「先判断一下」，而不是只问一句「确定吗」。
  const ok = window.confirm(
    `要把这 ${collectPreview.length} 条都补录成新记录吗？\n\n` +
      `⚠️ 只在你确认「这些投递账本里真的没有」时才点。\n` +
      `如果上一步「确认上传」显示「匹配 0」，但账本里明明有这些投递 ——\n` +
      `多半是后端还在跑旧代码：重启后端（npm run dev）再试，不要补录。`
  )
  if (!ok) return
  btn.disabled = true
  try {
    await uploadProgress({ createMissing: true })
  } finally {
    btn.disabled = false
  }
})
// ⚠️ 这个按钮曾经**没接线**（resetSynced 写了但没人调）—— 而它正是「缓存被污染」时
// 唯一的出口。死按钮不报错、界面照常，等于出口被堵死还不知道。id 对齐检查脚本
// 现在会把这种「有 id 无引用」列出来提示。
document.getElementById('collectResetBtn').addEventListener('click', resetSynced)
// ---------- 输出区一键复制 ----------
// 探测 JSON 动辄几百行，用鼠标拖选几十次是不现实的；点一下拿全量再粘出来。
// 复制的是 pre 的 textContent（= 界面上看到的原文），不重新序列化，
// 这样「界面显示的就是发出去的那段」，排查时不用怀疑两份内容对不上。
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (e) {
    // popup 失焦 / 未授予 clipboard 权限时 API 会抛；退回 textarea + execCommand
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.top = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch (e2) {
      return false
    }
  }
}

function flashCopyBtn(btn, msg, cls) {
  if (btn._copyTimer) clearTimeout(btn._copyTimer)
  if (!btn._copyLabel) btn._copyLabel = btn.textContent
  btn.textContent = msg
  btn.classList.remove('done', 'fail')
  if (cls) btn.classList.add(cls)
  btn._copyTimer = setTimeout(() => {
    btn.textContent = btn._copyLabel
    btn.classList.remove('done', 'fail')
  }, 1800)
}

document.querySelectorAll('.copybtn[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const src = document.getElementById(btn.dataset.copy)
    const text = src ? src.textContent || '' : ''
    if (!text.trim()) {
      flashCopyBtn(btn, '还没内容', 'fail')
      return
    }
    const ok = await copyText(text)
    flashCopyBtn(btn, ok ? `✅ 已复制 ${text.length} 字` : '❌ 复制失败', ok ? 'done' : 'fail')
  })
})

initConnection()
