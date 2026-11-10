/**
 * BOSS 聊天推进档位（前端展示）。
 *
 * 与 stage 的关系：**并列，不替代**。
 *   - stage = 平台告诉我到哪一步（实习僧七档；BOSS 永远停在「已投递」）；
 *   - chatStep = 从聊天内容里读出来的真实进展（BOSS 专用，六档）。
 * 两列都显示：只看 stage 会以为 90 条 BOSS 投递全在海里，而其中一部分 HR 已经要了微信。
 *
 * 口径与 server/lib/chatSteps.js 一一对应，改一边必须改另一边。
 */
export const CHAT_STEPS = [
  { key: 'submitted', label: '已投递' },
  { key: 'readNoReply', label: '已读不回' },
  { key: 'replied', label: '有进一步交流' },
  { key: 'contact', label: '交换微信 / 要简历' },
  { key: 'interview', label: '面试邀请' },
  { key: 'offer', label: '拿到 Offer' },
]

export const CHAT_STEP_ORDER = CHAT_STEPS.map((s) => s.key)

export const CHAT_STEP_LABELS = CHAT_STEPS.reduce((m, s) => {
  m[s.key] = s.label
  return m
}, {})

/** 权重，前端判「要不要画出轨迹」时用 */
const WEIGHT = CHAT_STEPS.reduce((m, s, i) => {
  m[s.key] = i + 1
  return m
}, {})

export function chatStepLabel(key) {
  return CHAT_STEP_LABELS[key] || ''
}

/**
 * 到达轨迹，例如「已投递 → 有进一步交流 → 交换微信 / 要简历」。
 * 用 chatStepHistory 而不是当前档：反问「这家什么时候约的面试」只能从历史里看。
 */
export function chatStepPath(app) {
  const h = Array.isArray(app?.chatStepHistory) ? app.chatStepHistory : []
  const seq = []
  for (const item of h) {
    const key = item?.step
    if (!key || !CHAT_STEP_LABELS[key]) continue
    if (seq[seq.length - 1] === key) continue
    seq.push(key)
  }
  if (!seq.length && app?.chatStep && CHAT_STEP_LABELS[app.chatStep]) seq.push(app.chatStep)
  return seq.map(chatStepLabel).join(' → ')
}

/** 有没有「值得单独说一句」的进展：最低档不用显示（它和左边徽章一字不差） */
export function hasChatProgress(app) {
  const w = WEIGHT[app?.chatStep] || 0
  return w >= 2
}

/** 依据那句话（HR 原话），用户能自己核对判定对不对 */
export function chatStepEvidence(app) {
  const t = String(app?.chatStepEvidence || '').trim()
  return t ? `依据：「${t}」` : ''
}
