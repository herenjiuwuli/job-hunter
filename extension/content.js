// 投递执行层（content script）：平台检测 → 填打招呼语 → 投递 → 回写
// 安全策略：随机间隔、每日额度、验证码/风控即停；默认「半自动」（只填不点，人工确认投递）
//
// ⚠️ 选择器是启发式的，实习僧/BOSS 真实 DOM 结构需真机校准：
//    在投递页点弹窗里的「探测页面结构」，把结果贴给 AI 即可锁定精确选择器。

const BACKEND = 'http://localhost:3100'

function platform() {
  const h = location.hostname
  if (h.includes('shixiseng')) return '实习僧'
  if (h.includes('zhipin')) return 'BOSS直聘'
  return '其他'
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function rand(min, max) { return min + Math.random() * (max - min) }

// —— DOM 启发式探测（待校准点） ——
function findGreetingBox() {
  return (
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]') ||
    null
  )
}

function findApplyButton() {
  const texts = ['立即投递', '立即申请', '投递简历', '申请职位', '立即沟通', '立即打招呼', '发消息', '发送', '投递', '沟通']
  const els = [...document.querySelectorAll('button, a, [role="button"], .btn')]
  for (const t of texts) {
    const hit = els.find((b) => (b.innerText || '').trim() === t)
    if (hit) return hit
  }
  for (const t of texts) {
    const hit = els.find((b) => (b.innerText || '').trim().includes(t))
    if (hit) return hit
  }
  return null
}

function detectRisk() {
  const body = (document.body && document.body.innerText) || ''
  const riskTexts = ['安全验证', '完成验证', '拖动滑块', '滑块验证', '沟通上限', '今日沟通', '操作频繁', '账号异常', '重新登录']
  const hasRiskText = riskTexts.some((t) => body.includes(t))
  const captchaEl = document.querySelector('iframe[src*="captcha"], [class*="captcha"], [class*="geetest"], [id*="captcha"]')
  return hasRiskText || !!captchaEl
}

function extractJobInfo() {
  const title = document.title || ''
  const jobEl = document.querySelector('.job-name, .job-title, .position-name, .name, h1')
  const companyEl = document.querySelector('.company-name, .company, .cname, .com-name')
  return {
    company: ((companyEl && companyEl.innerText) || '').trim() || '未知公司',
    jobTitle: ((jobEl && jobEl.innerText) || '').trim() || title.split(/[-_—|｜]/)[0].trim() || '未知岗位',
  }
}

// BOSS 直聘活跃度检测：返回 'active' | 'inactive' | 'unknown'
// BOSS 会在 HR 头像/卡片上标注活跃状态，投「活跃」的回复率与账号安全都更好。
// ⚠️ 具体文字因版本而异，属启发式，真机校准后可按需增删关键词。
function detectBossActivity() {
  const body = (document.body && document.body.innerText) || ''
  const activeMarks = ['今日活跃', '刚刚活跃', '3日内活跃', '3天内活跃', '本周活跃', '近日活跃', '今日回复', '刚刚在线', '在线']
  const inactiveMarks = ['半年前活跃', '3个月前活跃', '一个月前活跃', '月内活跃', '本月活跃', '长期未活跃', '很久未活跃', '年前活跃', '不活跃']
  for (const m of activeMarks) if (body.includes(m)) return 'active'
  for (const m of inactiveMarks) if (body.includes(m)) return 'inactive'
  return 'unknown'
}

// 投递前过滤：关键词黑名单 + BOSS 活跃度过滤（命中即跳过，不消耗额度）
async function applyFilters() {
  const { filterKeywords = '', bossActiveOnly = false } = await chrome.storage.local.get(['filterKeywords', 'bossActiveOnly'])
  const info = extractJobInfo()
  const haystack = `${info.company} ${info.jobTitle}`.toLowerCase()

  // 1. 关键词黑名单（逗号/换行分隔）
  const kws = String(filterKeywords).split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
  for (const k of kws) {
    if (k && haystack.includes(k.toLowerCase())) {
      return { blocked: true, reason: `命中黑名单关键词「${k}」，已跳过（不消耗额度）` }
    }
  }

  // 2. BOSS 活跃度过滤（仅 BOSS 平台生效）
  if (bossActiveOnly && platform() === 'BOSS直聘') {
    const act = detectBossActivity()
    if (act === 'inactive') {
      return { blocked: true, reason: '该岗位 HR 近期不活跃，已按「仅投活跃岗位」跳过（不消耗额度）' }
    }
  }

  return { blocked: false }
}

function fillGreeting(el, text) {
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    el.textContent = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

async function writeback(info, greeting) {
  try {
    await fetch(`${BACKEND}/api/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: info.company,
        jobTitle: info.jobTitle,
        platform: platform(),
        greeting,
        status: '已投递',
        appliedAt: new Date().toISOString(),
      }),
    })
  } catch (e) {
    console.warn('[job-hunter] 回写失败：', e.message)
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'inspect') {
    const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"]')].map((el, i) => ({
      i,
      tag: el.tagName,
      cls: String(el.className).slice(0, 60),
      placeholder: el.placeholder || '',
      editable: el.getAttribute('contenteditable'),
    }))
    const buttons = [...document.querySelectorAll('button, a, [role="button"]')].slice(0, 40).map((el, i) => ({
      i,
      text: (el.innerText || '').trim().slice(0, 24),
      cls: String(el.className).slice(0, 60),
    }))
    sendResponse({ url: location.href, platform: platform(), boxes, buttons })
    return false
  }
  if (msg.action === 'apply') {
    runApply(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }))
    return true
  }
  return false
})

async function runApply(msg) {
  const greeting = (msg.greeting || '').trim()
  if (!greeting) return { ok: false, error: '请先在弹窗填入打招呼语' }

  // 1. 风控/验证码检测（命中即停，不消耗额度）
  if (detectRisk()) return { ok: false, error: '检测到验证码或风控提示，已停止。请人工完成验证后再试。', risk: true }

  // 2. 关键词黑名单 + BOSS 活跃度过滤（命中即跳过，不消耗额度）
  const filter = await applyFilters()
  if (filter.blocked) return { ok: false, error: filter.reason, filtered: true }

  // 3. 每日额度检查（真正要投才消耗）
  const quota = await chrome.runtime.sendMessage({ action: 'checkAndIncrement' })
  if (quota.blocked) return { ok: false, error: `已达今日投递上限（${quota.limit} 份），已自动停止` }

  // 4. 找到沟通输入框并填入
  const box = findGreetingBox()
  if (!box) return { ok: false, error: '未找到沟通输入框。请确认当前在投递页，或用「探测页面结构」校准选择器。' }

  fillGreeting(box, greeting)
  await sleep(300)

  const info = extractJobInfo()

  // 5. 半自动：默认只填不点；自动模式才在随机间隔后点击
  let autoClicked = false
  if (msg.autoClick) {
    const btn = findApplyButton()
    if (!btn) return { ok: false, error: '已填入打招呼语，但未找到投递按钮（请手动点击投递）。' }
    await sleep(rand(4000, 10000))
    btn.click()
    autoClicked = true
  }

  // 6. 回写投递记录
  await writeback(info, greeting)

  return {
    ok: true,
    autoClicked,
    company: info.company,
    jobTitle: info.jobTitle,
    used: quota.used,
    limit: quota.limit,
  }
}
