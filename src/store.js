import { reactive, watch } from 'vue'

// 全局共享状态：简历分析结果 + 选中的岗位（阶段1 用前端变量保存）
export const appState = reactive({
  resume: '',
  questionCount: 5,
  difficulty: 'medium',
  interviewerType: 'tech',
  analysis: null,
  selectedJob: '',
  selectedJobJd: '', // 自定义岗位的 JD（知识库岗位为空，面试时带上）
  // 阶段2/3：面试对话与报告
  interviewHistory: [],
  interviewTotal: 5,
  interviewDurations: [], // 9.8 每题累计用时 [{ q, seconds, tip }]
  report: null,
})

export function selectJob(name, jd = '') {
  appState.selectedJob = name
  appState.selectedJobJd = jd || ''
}

/**
 * 面试工作台的共享上下文：岗位 + 简历 + JD（可选）。
 *
 * 为什么要有这一层：弹药自检 / 自我介绍 / 准备清单 / 错题本 / 薪资谈判，
 * 五个模块要的其实是同一份东西 —— 「我是谁」+「投的什么岗」。
 * 原来每个页面各贴一遍简历、各填一次岗位，于是同一件事看起来像五件事，
 * 而且贴第二遍时人是会偷懒的（贴半份、干脆不贴），产出质量跟着掉。
 *
 * 上收到这里以后：一次填、五个模块共用、刷新不丢。
 * 注意用 toRefs 解构再往下传，直接解构 reactive 会丢响应性。
 */
const PREP_CTX_KEY = 'prep_ctx'

function loadPrepCtx() {
  try {
    const raw = localStorage.getItem(PREP_CTX_KEY)
    if (!raw) return null
    const j = JSON.parse(raw)
    return { job: j.job || '', resume: j.resume || '', jd: j.jd || '' }
  } catch {
    return null
  }
}

const saved = loadPrepCtx()

export const prepCtx = reactive({
  job: saved?.job || appState.selectedJob || '',
  resume: saved?.resume || appState.resume || '',
  jd: saved?.jd || appState.selectedJobJd || '',
})

// 边输边存。只存这三项，不碰其它状态（避免把面试对话也写进 localStorage）。
watch(
  prepCtx,
  (v) => {
    try {
      localStorage.setItem(PREP_CTX_KEY, JSON.stringify({ job: v.job, resume: v.resume, jd: v.jd }))
    } catch {
      /* 隐私模式 / 配额满：静默失败，功能照用，只是刷新后要重填 */
    }
  },
  { deep: true }
)

/** 上下文是否够用：三个模块里，只有「薪资谈判」不强依赖简历 */
export function ctxReady() {
  return !!prepCtx.job.trim() && !!prepCtx.resume.trim()
}

/** 把上下文同步给模拟面试（它还读 appState） */
export function syncCtxToInterview() {
  if (prepCtx.job.trim()) selectJob(prepCtx.job.trim(), prepCtx.jd.trim())
  if (prepCtx.resume.trim()) appState.resume = prepCtx.resume.trim()
}
