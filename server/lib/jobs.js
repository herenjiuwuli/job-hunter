import { readJSON } from './store.js'

/**
 * 岗位知识库（server/data/jobs.json）的唯一读取入口。
 *
 * 之前的问题：jobs.json 写好了但没人读，岗位名散落在 analyze.js 里硬编码，
 * 阶段 2 的模拟面试若要「读 JD 和题目池」，就会绕过知识库自己编题。
 * 所以统一从这里取，analyze / interview / apply 全部走这一层。
 */

const CACHE_KEY = 'jobs'
let cache = null

/** 加载全部岗位；结果在进程内缓存（jobs.json 是静态资产，不会运行时变） */
export async function loadJobs() {
  if (cache) return cache

  const jobs = await readJSON(CACHE_KEY)
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new Error(
      '岗位知识库加载失败：server/data/jobs.json 缺失或内容为空。请确认该文件已随代码部署。'
    )
  }
  cache = jobs
  return cache
}

/** 全部岗位（含 jd / questions / skills） */
export async function listJobs() {
  return loadJobs()
}

/** 岗位名列表，用于校验 AI 返回的岗位名是否合法 */
export async function getJobNames() {
  return (await loadJobs()).map((j) => j.name)
}

/** 按名字取单个岗位，找不到返回 null（AI 可能返回错别字，调用方要判空） */
export async function getJob(name) {
  if (!name || typeof name !== 'string') return null
  const target = name.trim()
  return (await loadJobs()).find((j) => j.name === target) || null
}

/**
 * 把岗位信息压成一段给 LLM 看的上下文。
 * 阶段 2 的面试官系统提示词、阶段 6 的投递助手都用它，避免各写一遍。
 */
export function describeJob(job, { withQuestions = true, withSkills = true } = {}) {
  if (!job) return ''
  const parts = [`岗位名称：${job.name}`]
  if (job.jd) parts.push(`岗位职责与要求：\n${job.jd}`)
  if (withSkills && Array.isArray(job.skills) && job.skills.length) {
    parts.push(`核心考察技能：${job.skills.join('、')}`)
  }
  if (withQuestions && Array.isArray(job.questions) && job.questions.length) {
    parts.push(`该岗位常见面试题：\n${job.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/** 测试用：清掉进程内缓存，让下一次读取重新走磁盘 */
export function clearJobsCache() {
  cache = null
}
