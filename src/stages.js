/**
 * 投递阶段（stage）的前端展示层。
 *
 * 为什么需要这个文件：
 *   `Applications.vue` 和 `Dashboard.vue` 一直读的是 `status`（人工标注的 7 档），
 *   而采集器只写 `stage`。结果是平台上明明「被查看 / 不合格 / 初筛」的记录，
 *   在页面上全部显示成「已投递」—— 用户看到的是「进度没同步」，其实是「读错字段」。
 *   2026-11-05 实测：库里 46 条 status 全是「已投递」，stage 却是 39/3/3/1 分布。
 *
 * 两套字段的分工保持不变（见 server/lib/stages.js 顶部注释）：
 *   - stage：平台告诉我到哪一步了，只由采集器写，只读
 *   - status：我的主观标记（想不想去、是不是我拒的），人工写
 *   所以前端**两列都要能看见**，但主列是 stage。
 */

/** 与 server/lib/stages.js 的 STAGES 一一对应（顺序即推进顺序） */
export const STAGES = [
  { key: 'submitted', label: '已投递', tone: 'submitted' },
  { key: 'viewed', label: '被查看', tone: 'viewed' },
  { key: 'screening', label: '初筛', tone: 'screening' },
  { key: 'written', label: '笔试', tone: 'written' },
  { key: 'interview', label: '面试', tone: 'interview' },
  { key: 'rejected', label: '不合格', tone: 'rejected' },
  { key: 'offer', label: '录用', tone: 'offer' },
]

export const STAGE_KEYS = STAGES.map((s) => s.key)

export const STAGE_LABELS = STAGES.reduce((m, s) => {
  m[s.key] = s.label
  return m
}, {})

/** 漏斗正序：不含终态「不合格」（它不在漏斗路径上，是旁路出口） */
export const FUNNEL_ORDER = ['submitted', 'viewed', 'screening', 'written', 'interview', 'offer']

/** 终态：到这里就不再推进，也不该进「进行中」统计 */
export const TERMINAL_STAGES = ['rejected', 'offer']

export function stageLabel(key) {
  return STAGE_LABELS[key] || ''
}

/**
 * 到达轨迹，例如「已投递 → 被查看 → 不合格」。
 *
 * 用 stageHistory 而不是当前 stage：一条判了不合格的记录，它**到过**面试，
 * 只看当前态会把「面试过 3 家」看成「1 家」。
 */
export function stagePath(app) {
  const h = Array.isArray(app?.stageHistory) ? app.stageHistory : []
  const seq = []
  for (const item of h) {
    const key = item?.stage
    if (!key || !STAGE_LABELS[key]) continue
    if (seq[seq.length - 1] === key) continue
    seq.push(key)
  }
  // 历史为空但有 stage（迁移前的旧数据）→ 至少把当前态显示出来
  if (!seq.length && app?.stage && STAGE_LABELS[app.stage]) seq.push(app.stage)
  return seq.map(stageLabel).join(' → ')
}

/** 有 stage 就没到终态，且平台还没给结果 —— 这类才值得我去催/去准备 */
export function isActive(app) {
  // 我自己放弃的已经结束了（哪怕 stage 停在「被查看」）：再算进「进行中」会把待办虚高
  if (app?.withdrawnAt) return false
  if (!app?.stage) return (app?.status || '待投递') === '待投递' || app?.status === '已投递'
  return !TERMINAL_STAGES.includes(app.stage)
}

/**
 * 「该我动了」：**对方在聊天框发了消息，而我还留着没回**。
 *
 * ⭐ 2026-11-06 主人纠正（上一版判错）：
 *   旧实现是 `stage ∈ {viewed, screening, written, interview} && !repliedAt`，
 *   等于把「简历被查看 / 通过初筛」当成了「需要我回复」。实际上这是两件事：
 *     被查看 = 平台点开了我的简历，**不产生任何消息**，没有任何东西等我回；
 *     通过初筛 = 状态推进，对方没开口也不用我开口（BOSS 上尤其如此，很多岗位
 *     只在状态上写「初筛」，聊天框里一条消息都没有）。
 *   只有**聊天框里确实来了消息**（采集端 `lastFrom === 'other'`，后端落成 awaitingReply）
 *   才是真的要回。把状态推进当成待办，等于每天给我一堆不存在的活。
 *
 * 所以判据只有一个：`awaitingReply === true`（对方最后发言）。不看 stage、不看 status。
 */
export function needsMyAction(app) {
  if (!app?.awaitingReply) return false
  // 我主动放弃的不用再回 —— 否则它会永远挂在「待回复」里，每条都要人工看一眼才删得掉
  if (app?.withdrawnAt) return false
  // 已经判不合格的也不提示：那是拒信，不是问话
  if (app?.stage === 'rejected') return false
  return true
}
