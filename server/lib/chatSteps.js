/**
 * BOSS 聊天推进档位（2026-11-10 主人定的口径）
 *
 *   已投递 → 已读不回 → 有进一步交流 → 交换微信 / 要简历 → 面试邀请 → 拿到 Offer
 *
 * 为什么不塞进 STAGES：
 *   STAGES 是「**平台**告诉我到哪一步」，漏斗转化率按它算。BOSS 压根不推进平台状态 ——
 *   HR 拒绝你都不会把状态改成「不合格」，只会发一句「不太合适」。所以 BOSS 的进度
 *   只能从聊天内容里读。两件事混进一个字段，漏斗层数就不可比了
 *   （实习僧七档 vs BOSS 聊天六档，各有各的分母）。
 *
 * 保守原则（与 chatVerdictOf 同源）：
 *   - 只认**对方**说的话，不认我自己说「我加你微信吧」；
 *   - 只升不降（权重比较）—— 聊到面试又回头说「再等等」不该掉回「有交流」；
 *   - 判不出来就是 null，宁可停在低档，也不给一个假的进展。
 */

export const CHAT_STEPS = {
  submitted: { key: 'submitted', label: '已投递', weight: 1 },
  readNoReply: { key: 'readNoReply', label: '已读不回', weight: 2 },
  replied: { key: 'replied', label: '有进一步交流', weight: 3 },
  contact: { key: 'contact', label: '交换微信 / 要简历', weight: 4 },
  interview: { key: 'interview', label: '面试邀请', weight: 5 },
  offer: { key: 'offer', label: '拿到 Offer', weight: 6 },
}

export const CHAT_STEP_KEYS = Object.keys(CHAT_STEPS)

/** 正序，给前端画轨迹用 */
export const CHAT_STEP_ORDER = ['submitted', 'readNoReply', 'replied', 'contact', 'interview', 'offer']

export function chatStepLabel(key) {
  return CHAT_STEPS[key]?.label || ''
}

/**
 * 该不该写入新档位。规则与 shouldAdvance 一致：**权重更大才覆盖**。
 * 首个非空值直接写（老记录迁移过来的 chatStep 为空）。
 */
export function shouldAdvanceChat(current, incoming) {
  if (!incoming) return false
  if (!CHAT_STEPS[incoming]) return false // 未知 key：防御脏数据
  if (!current) return true
  const cur = CHAT_STEPS[current]
  if (!cur) return true
  return CHAT_STEPS[incoming].weight > cur.weight
}

/**
 * 写一条聊天推进历史（同一档连续重复不记）。
 * 历史单独存：chatStep 只说明「现在到哪」，轨迹要说明「什么时候到的」——
 * 「上周就约了面试」和「今天刚约」在复盘里是两回事。
 */
export function pushChatHistory(history, step, { raw = '', at = new Date().toISOString() } = {}) {
  const list = Array.isArray(history) ? history : []
  const last = list[list.length - 1]
  if (last && last.step === step) return list
  return [...list.slice(-59), { step, raw: String(raw || '').slice(0, 60), at }]
}

/** 已到达过的最高档位（画轨迹 / 统计用） */
export function highestChatStep(history = []) {
  let best = null
  for (const h of history) {
    const key = typeof h === 'string' ? h : h?.step
    if (!key) continue
    if (!best || (CHAT_STEPS[key]?.weight || 0) > (CHAT_STEPS[best]?.weight || 0)) best = key
  }
  return best
}
