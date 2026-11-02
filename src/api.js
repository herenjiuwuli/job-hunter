import { authHeaders, clearSession, setSession } from './auth.js'

const BASE = '/api'

/**
 * 401 的统一处理：清掉本地登录态并跳登录页。
 * 用回调注册而不是在这里 import router —— router 会 import 各个视图，
 * 视图又会 import 这个文件，直接互相 import 会成环。
 */
let onUnauthorized = () => {}
export function setOnUnauthorized(fn) {
  onUnauthorized = fn
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  })

  // token 过期 / 被清掉：统一踢回登录页，不要每个页面各写一遍
  if (res.status === 401) {
    clearSession()
    onUnauthorized()
    const data = await res.json().catch(() => ({}))
    throw new ApiError(data.error || '未登录或登录已过期', 401)
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(data.error || `请求失败 (${res.status})`, res.status)
  }
  return res.json()
}

export const api = {
  auth: {
    login: (username, password) =>
      request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    register: (username, password) =>
      request('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
    me: () => request('/auth/me'),
    changePassword: (oldPassword, newPassword) =>
      request('/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ oldPassword, newPassword }),
      }),
  },
  resumes: {
    list: () => request('/resumes'),
    get: (id) => request(`/resumes/${id}`),
    create: (data) => request('/resumes', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/resumes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/resumes/${id}`, { method: 'DELETE' }),
  },
  applications: {
    list: () => request('/applications'),
    create: (data) => request('/applications', { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => request(`/applications/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    remove: (id) => request(`/applications/${id}`, { method: 'DELETE' }),
  },
  profile: {
    get: () => request('/profile'),
    save: (data) => request('/profile', { method: 'PUT', body: JSON.stringify(data) }),
  },
  tailor: (data) => request('/tailor', { method: 'POST', body: JSON.stringify(data) }),
  match: (resumeId) => request(`/match?resumeId=${encodeURIComponent(resumeId)}`),
  matchAnalyze: (resumeId, applicationId) =>
    request('/match/analyze', {
      method: 'POST',
      body: JSON.stringify({ resumeId, applicationId }),
    }),
  backup: {
    export: () => request('/backup/export'),
    import: (data) => request('/backup/import', { method: 'POST', body: JSON.stringify(data) }),
  },
  dashboard: () => request('/dashboard'),
  ammo: (data) => request('/ammo', { method: 'POST', body: JSON.stringify(data) }),
  interviewPredict: (data) =>
    request('/interview/predict', { method: 'POST', body: JSON.stringify(data) }),
  resumeExport: (resumeId) =>
    request('/resume/export', { method: 'POST', body: JSON.stringify({ resumeId }) }),
  resumeImport: (data) =>
    request('/resume/import', { method: 'POST', body: JSON.stringify(data) }),
}

// 登录/注册成功后写入会话（Login.vue 只关心表单，不关心存哪）
export function applyLoginResult(result) {
  setSession(result.token, result.user)
  return result
}
