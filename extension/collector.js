/**
 * 平台投递进度采集器（实习僧「我的投递」/ BOSS 对话列表）
 *
 * 设计取向：**文本驱动，不猜 class 名**。
 *
 * 平台的 DOM 类名三天两头改（`.job-card` → `.job-card-v2`），但「初筛」「不合格」
 * 这些**业务文案**不会随便改 —— 它们是用户看得见的产品语言。所以定位靠文案，
 * 定位到之后再向上找「行容器」，从容器里取公司/岗位/链接。
 *
 * 三条纪律：
 *  1. **认不出就不猜**：文案例外、结构异常 → 这条不上报，宁可漏。上报错的进度比漏一条坏得多。
 *  2. **只读当前页**：不翻页、不点按钮、不发任何请求。用户看到哪一页就同步哪一页。
 *  3. **结果可预览**：返回的每条都带 lines/raw，弹窗里能一眼看出抓歪没有。
 */

/* eslint-disable no-unused-vars */

// 实习僧「投递反馈」的七档 + BOSS 的已读文案
const STAGE_WORDS = [
  '已投递', '被查看', '初筛', '笔试', '面试', '录用', '不合格',
  '不合适', '未通过', '待查看',
  '已读', '未读',
]

// 明显不是公司/岗位的行（日期、薪资、城市、按钮文案）
const NOISE = /^\s*(查看|立即沟通|继续沟通|投递简历|已投递简历|撤回|删除|聊天|详情|更多|展开|收起)\s*$/
const DATE_LIKE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}|今天|昨天|\d+\s*(分钟|小时|天|周|月)前|\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})$/
const MONEY_LIKE = /^(\d+[-~]\d+\s*元?\/?天|\d+\s*[kK]|\d+[-~]\d+\s*[kK]|\d+\s*元\/天|面议)/

function isStageWord(t) {
  return STAGE_WORDS.includes(t)
}

/** 叶子级文案节点：自己就是阶段词，且没有子元素干扰 */
function stageNodes(root = document) {
  const out = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  let n
  while ((n = walker.nextNode())) {
    const t = String(n.nodeValue || '').trim()
    if (!t || !isStageWord(t)) continue
    const el = n.parentElement
    if (!el) continue
    // 整块文本必须就是这个词（避免「面试经验丰富」这类正文误命中）
    if (String(el.textContent || '').trim() !== t) continue
    out.push({ el, text: t })
  }
  return out
}

/**
 * 从阶段词节点向上找「这一行的容器」。
 * 判据：容器里出现了链接或图片，且文本行数 ≥ 2 —— 单个阶段词自己不算一行。
 */
function rowOf(el, maxUp = 8) {
  let cur = el
  for (let i = 0; i < maxUp; i++) {
    cur = cur.parentElement
    if (!cur || cur === document.body) break
    const hasLink = cur.querySelector('a[href]')
    const lines = String(cur.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (hasLink && lines.length >= 2) return cur
  }
  return null
}

function jobIdFrom(row) {
  const links = [...row.querySelectorAll('a[href]')]
  for (const a of links) {
    const m = a.getAttribute('href').match(/(?:intern|job|jobdetail|detail)\/([A-Za-z0-9_-]{6,})/i)
    if (m) return m[1]
    const q = a.getAttribute('href').match(/[?&](?:jobId|jobid|positionId)=([A-Za-z0-9_-]{6,})/i)
    if (q) return q[1]
  }
  // BOSS 常用 data-* 挂 jobId
  const holder = row.querySelector('[data-jobid], [data-job-id]')
  if (holder) return holder.getAttribute('data-jobid') || holder.getAttribute('data-job-id')
  return ''
}

/**
 * 从行文本里挑出「岗位」和「公司」。
 *
 * 没有可靠的结构信息，所以用排除法：去掉阶段词、日期、薪资、按钮文案之后，
 * 第一行当岗位名、第二行当公司名 —— 这是两个平台列表页的常见排布。
 * 抓错了会在弹窗预览里露出来（岗位/公司明显不对），比静默入库好。
 */
function pickTitleCompany(lines, stageText) {
  const cleaned = lines
    .map((s) => s.trim())
    .filter((s) => s && s !== stageText && !isStageWord(s))
    .filter((s) => !NOISE.test(s) && !DATE_LIKE.test(s) && !MONEY_LIKE.test(s))
    .filter((s) => s.length <= 60)
  if (cleaned.length < 2) return null
  return { jobTitle: cleaned[0], company: cleaned[1] }
}

function detectPlatform() {
  const h = location.hostname
  if (h.includes('shixiseng')) return '实习僧'
  if (h.includes('zhipin')) return 'BOSS直聘'
  return h
}

/**
 * 扫当前页，返回 { items, debug }。
 * items 里的字段刻意保持和后端 /api/applications/collect 对齐。
 */
function collectFromPage() {
  const platform = detectPlatform()
  const hits = stageNodes()
  const seen = new Set()
  const items = []
  const rowsDebug = []
  let dup = 0
  let noRow = 0
  let noName = 0

  for (const hit of hits) {
    const row = rowOf(hit.el)
    if (!row) {
      noRow++
      continue
    }
    // 同一个容器里可能同时有「已读」和「初筛」两个词：只取最高阶段那条，
    // 否则同一条投递会上报两次，一次推高一次不动，白忙
    if (seen.has(row)) {
      dup++
      continue
    }
    seen.add(row)

    const lines = String(row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)
    const named = pickTitleCompany(lines, hit.text)
    if (!named) {
      noName++
      if (rowsDebug.length < 8) rowsDebug.push({ stage: hit.text, lines, skipped: '取不到岗位/公司' })
      continue
    }

    const jobId = jobIdFrom(row)
    const item = {
      platform,
      company: named.company,
      jobTitle: named.jobTitle,
      jobId,
      stageRaw: hit.text,
    }
    // BOSS：已读/未读是「读没读」，不是流程阶段 —— 分开报
    if (hit.text === '已读') {
      item.read = true
      delete item.stageRaw
    }
    if (hit.text === '未读') {
      delete item.stageRaw
    }
    items.push(item)
    if (rowsDebug.length < 8) rowsDebug.push({ stage: hit.text, lines, item })
  }

  return {
    items,
    debug: {
      url: location.href,
      platform,
      hits: hits.length,
      noRow,
      noName,
      duplicate: dup,
      rows: rowsDebug,
    },
  }
}

/** 探测模式：不作任何解析，把候选行的结构和文本原样吐出来，用来人工校准 */
function probePage() {
  const hits = stageNodes()
  const out = []
  for (const hit of hits.slice(0, 12)) {
    const row = rowOf(hit.el)
    out.push({
      stage: hit.text,
      found: Boolean(row),
      tag: row ? row.tagName + (row.className ? '.' + String(row.className).split(/\s+/).slice(0, 3).join('.') : '') : '',
      lines: row ? String(row.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean) : [],
      jobId: row ? jobIdFrom(row) : '',
    })
  }
  return { url: location.href, platform: detectPlatform(), hits: hits.length, rows: out }
}

// content.js 通过 window.__jhCollector 调用
window.__jhCollector = { collectFromPage, probePage, STAGE_WORDS }
