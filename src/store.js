import { reactive } from 'vue'

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
