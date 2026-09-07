// 关键词权重匹配：把简历与 JD 都扫一遍技能词库，按 JD 关键词覆盖率打分。
// MVP 用等权关键词命中率；后续可升级为智谱 embedding 余弦相似度（复用 ai-hot-topic RAG）。

const KEYWORDS = [
  // 前端
  'vue', 'vue3', 'vue2', 'react', 'angular', 'javascript', 'typescript', 'html', 'css',
  'vite', 'webpack', 'pinia', 'vuex', 'vue-router', 'uni-app', '小程序', 'echarts', '前端',
  // 后端
  'node', 'node.js', 'express', 'fastify', 'nestjs', 'koa', 'python', 'java', 'golang', 'php',
  'mysql', 'postgresql', 'mongodb', 'redis', 'sqlite', 'sql', '后端', '服务端', 'restful', 'graphql', 'websocket',
  // 工程 / 部署
  'git', 'docker', 'linux', 'nginx', '全栈', 'api', 'http', '部署', '架构',
  // 测试 / 运维
  '测试', '自动化测试', '单元测试', '集成测试', 'pytest', 'jest', 'vitest', 'playwright', 'selenium',
  'e2e', 'ci/cd', '运维', '监控', '性能测试', '接口测试',
  // 数据 / 爬虫
  '爬虫', '数据采集', '数据分析', 'pandas', '数据可视化', '数据回收',
  // AI / LLM
  'ai', 'llm', '大模型', 'rag', '检索增强', 'prompt', 'embedding', '向量', 'deepseek', '智谱',
  'agent', '智能体', '机器学习', '深度学习',
  // 二次元 / 达人运营
  '二次元', 'acg', 'acgn', '动画', '漫画', '游戏', 'vtuber', '手办', '同人', 'coser',
  '达人运营', '内容运营', '新媒体', '小红书', '抖音', 'b站', 'bilibili', '微博', '快手',
  '涨粉', '选题', '爆款', '粉丝', '直播',
]

const CJK_RE = /[\u4e00-\u9fff]/

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从文本中抽取命中词库的关键词（中文子串匹配，英文词边界匹配，避免 ai/go/api 误命中） */
export function extractKeywords(text, list = KEYWORDS) {
  const t = String(text || '').toLowerCase()
  const found = new Set()
  for (const kw of list) {
    const k = kw.toLowerCase()
    if (CJK_RE.test(kw)) {
      if (t.includes(k)) found.add(kw)
    } else {
      const re = new RegExp(`\\b${escapeRegex(k)}\\b`)
      if (re.test(t)) found.add(kw)
    }
  }
  return [...found]
}

function resumeText(resume) {
  const parts = [resume?.title || '', resume?.target || '', (resume?.skills || []).join(' ')]
  ;(resume?.experiences || []).forEach((e) => {
    parts.push(e.role || '', (e.points || []).join(' '))
  })
  ;(resume?.projects || []).forEach((p) => {
    parts.push(p.name || '', p.role || '', p.desc || '', (p.highlights || []).join(' '))
  })
  parts.push(resume?.selfEvaluation || '')
  return parts.join(' ')
}

/** 简历关键词集合（用于判断 JD 关键词是否被简历覆盖） */
export function resumeKeywordSet(resume) {
  return new Set(extractKeywords(resumeText(resume)))
}

/**
 * 对一份 JD 打分：返回 { score, matched, jdKeywords }
 * - 关键词在「技能」字段命中 → 权重 2（显式技能是强信号）
 * - 关键词只在经历/项目/评价等文本命中 → 权重 1
 * - score = 加权命中 / (JD 关键词数 × 2) × 100；JD 无关键词时为 null（无法评估）
 */
export function scoreResumeVsJd(resume, jdText) {
  const skillsSet = new Set(extractKeywords((resume?.skills || []).join(' ')))
  const fullSet = resumeKeywordSet(resume)
  const jdKeywords = extractKeywords(jdText)

  let weighted = 0
  const matched = []
  for (const k of jdKeywords) {
    if (skillsSet.has(k)) {
      weighted += 2
      matched.push(k)
    } else if (fullSet.has(k)) {
      weighted += 1
      matched.push(k)
    }
  }

  const potential = jdKeywords.length * 2
  const score = jdKeywords.length ? Math.round((weighted / potential) * 100) : null
  return { score, matched, jdKeywords }
}
