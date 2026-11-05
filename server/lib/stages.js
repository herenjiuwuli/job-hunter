/**
 * 投递阶段（funnel 口径）—— 从「平台告诉我到哪一步了」出发，而不是从「我觉得」出发。
 *
 * 为什么不复用 applications.status：
 *   status 是**人工标注**的粗档（待投递/已投递/已沟通/已面试/已offer/已拒绝/已淘汰），
 *   里面「已沟通」这种档在漏斗上没有位置 —— 硬映射到「被查看」会让第一层虚高。
 *   两套字段各管一件事：status 给人看，stage 给统计用，互不同步、互不覆盖。
 *
 * 采集来源：
 *   - 实习僧「我的投递 → 投递反馈」页：七档一一对应（已投递/被查看/初筛/笔试/面试/录用/不合格）
 *   - BOSS 对话列表：只有「已读/未读」→ 映射到 viewed；HR 回过话另记 repliedAt（不推进 stage）
 *
 * 为什么 BOSS 的「已回复」不推进 stage：
 *   HR 回一句「方便发简历吗」不等于进初筛。把它算成 screening 会让漏斗第二层虚高，
 *   而这正是「看起来转化不错其实没有」的典型自欺。回复率单独作为一个指标算。
 */

/**
 * 权重即优先级，一条规则解决全部情况：**权重更大才允许覆盖**。
 *
 *   submitted 1 < viewed 2 < screening 3 < written 4 < interview 5 < rejected 8 < offer 9
 *
 * 这样：
 *   - 正常推进（viewed → interview）✅ 权重递增
 *   - 面试后不合格（interview → rejected）✅ 8 > 5
 *   - 判了不合格又给 offer（rejected → offer）✅ 9 > 8（少见但真实存在）
 *   - 已给 offer 又读到「不合格」这种脏数据 ❌ 9 不会退到 8，挡住
 *   - 任何回退（interview → viewed）❌ 5 不小于 5，挡住
 *
 * 不用「只准 step+1」的写法：平台状态是**当前态**不是事件流，中间可能跳过（直接初筛→面试）。
 */
export const STAGES = {
  submitted: { key: 'submitted', label: '已投递', weight: 1, order: 1 },
  viewed: { key: 'viewed', label: '被查看', weight: 2, order: 2 },
  screening: { key: 'screening', label: '初筛', weight: 3, order: 3 },
  written: { key: 'written', label: '笔试', weight: 4, order: 4 },
  interview: { key: 'interview', label: '面试', weight: 5, order: 5 },
  rejected: { key: 'rejected', label: '不合格', weight: 8, order: 6, terminal: true },
  offer: { key: 'offer', label: '录用', weight: 9, order: 7, terminal: true },
}

/** 漏斗正序（不含终态「不合格」） */
export const FUNNEL_ORDER = ['submitted', 'viewed', 'screening', 'written', 'interview', 'offer']

export const STAGE_KEYS = Object.keys(STAGES)

export function stageLabel(key) {
  return STAGES[key]?.label || ''
}

/**
 * 平台原始文案 → stage。
 *
 * 全部按**归一化后的整串或包含**匹配：平台文案经常带前后缀
 * （「简历被查看」「HR 已查看」「不合适」），精确等号会漏掉一半。
 * 顺序有讲究 —— 长词在前，否则「未通过」会被「通过」先吃掉。
 */
const ALIASES = [
  // ⚠️ 「待查看」必须排在「查看」前面：它语义是**还没被看**，要算已投递。
  //    放后面会被「查看」先吃掉，把没看过的算成看过 —— 查看率直接虚高。
  ['待查看', 'submitted'],
  // 不合格（终态）：各种说法都收，宁多勿漏
  ['不合格', 'rejected'], ['不合适', 'rejected'], ['不匹配', 'rejected'],
  ['未通过', 'rejected'], ['未录用', 'rejected'], ['已拒绝', 'rejected'],
  ['淘汰', 'rejected'], ['已结束', 'rejected'], ['rejected', 'rejected'],
  // 录用
  ['已录用', 'offer'], ['录用', 'offer'], ['offer', 'offer'], ['通过面试', 'offer'],
  // 面试
  ['面试中', 'interview'], ['已面试', 'interview'], ['面试', 'interview'],
  ['interview', 'interview'],
  // 笔试
  ['笔试中', 'written'], ['已笔试', 'written'], ['笔试', 'written'], ['测评', 'written'],
  // 初筛
  ['初筛', 'screening'], ['筛选中', 'screening'], ['筛选', 'screening'], ['复筛', 'screening'],
  // 被查看
  ['简历被查看', 'viewed'], ['被查看', 'viewed'], ['已查看', 'viewed'],
  ['已读', 'viewed'], ['查看', 'viewed'],
  // 已投递
  ['已投递', 'submitted'], ['未读', 'submitted'],
  ['已送达', 'submitted'], ['投递成功', 'submitted'],
]

/**
 * @param {string} raw 平台上的原文
 * @returns {string|null} stage key；认不出来返回 null（**不猜**，宁可漏一条）
 */
export function parseStage(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!s) return null
  // ⭐ 先认「key 本体」：扩展上报的就是这几个 key（submitted/viewed/screening/written）。
  // 只认中文别名的话，采集端算好、行内却没有阶段词的那些（只靠分类 tab 判的）会全被丢掉 ——
  // 「切到初筛 tab 但那行文案还是旧的」是平台常态，丢掉等于这一档永远推不上去。
  // 2026-11-05 回放真账本时暴露：9 条里 stage 一个都没推进，全因为这条。
  if (STAGES[s]) return s
  for (const [word, key] of ALIASES) {
    if (s.includes(word)) return key
  }
  return null
}

/**
 * 该不该写入新阶段。
 * @param {string|null} current 当前 stage
 * @param {string|null} incoming 采到的 stage
 * @returns {boolean} true = 需要更新
 */
export function shouldAdvance(current, incoming) {
  if (!incoming) return false            // 没采到有效阶段：不动
  if (!current) return true              // 首次：直接写
  const cur = STAGES[current]
  const inc = STAGES[incoming]
  if (!cur || !inc) return false         // 未知 key：不动（防御脏数据）
  return inc.weight > cur.weight
}

/**
 * 从人工 status 反推一个初始 stage —— **只给老数据迁移用**。
 *
 * 注意：这是「尽力而为」的猜测，所以迁移时把 source 标成 'migrated'。
 * 之后采集器采到真实阶段时，只要权重更高就会覆盖它。
 * 反推不出来的（待投递）返回 null，不硬塞。
 */
export function stageFromStatus(status) {
  const map = {
    待投递: null,
    已投递: 'submitted',
    已沟通: 'viewed',      // 「沟通过」至少等于被看到过；不能再往高猜
    已面试: 'interview',
    已offer: 'offer',
    已拒绝: 'rejected',
    已淘汰: 'rejected',
  }
  return Object.prototype.hasOwnProperty.call(map, status) ? map[status] : null
}

/** 已到达过的最高「正常阶段」（不含不合格）—— 漏斗累计数用它算 */
export function highestNormalStage(history = []) {
  let best = null
  for (const h of history) {
    const key = typeof h === 'string' ? h : h?.stage
    if (!key || key === 'rejected') continue
    if (!best || (STAGES[key]?.order || 0) > (STAGES[best]?.order || 0)) best = key
  }
  return best
}

/** 写一条阶段历史（去重：同一阶段连续重复不记） */
export function pushHistory(history, stage, { source = 'collect', raw = '', at = new Date().toISOString() } = {}) {
  const list = Array.isArray(history) ? history : []
  const last = list[list.length - 1]
  if (last && last.stage === stage) return list
  return [...list, { stage, source, raw: String(raw || '').slice(0, 40), at }]
}
