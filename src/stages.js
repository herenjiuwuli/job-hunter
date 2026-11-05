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
 * 「该我动了」：平台看了我 / 进了初筛，但我还没回话。
 *
 * 这是求职里最容易漏的一类 —— 对方已经抛球过来，我这边界面还停在「已投递」，
 * 于是错过了最佳回复窗口。判定只看平台事实，不看 status。
 */
export function needsMyAction(app) {
  if (!app?.stage) return false
  // 我主动放弃的不用再回 —— 否则它会永远挂在「待我回复」里，每条都要人工看一眼才删得掉
  if (app?.withdrawnAt) return false
  if (!['viewed', 'screening', 'written', 'interview'].includes(app.stage)) return false
  return !app.repliedAt
}
