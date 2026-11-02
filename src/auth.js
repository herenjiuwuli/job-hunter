import { computed, ref } from 'vue'

/**
 * 登录状态：token + 当前用户。
 *
 * 存 localStorage 而不是内存：刷新页面不该被踢回登录页。
 * 代价是 token 能被同源的 XSS 读到 —— 个人工具、无第三方脚本，风险可控；
 * 真要更严就换 HttpOnly Cookie（但会把前端改成「依赖后端设 cookie」，
 * 且扩展那边就不好带凭证了，本阶段不做）。
 */

const TOKEN_KEY = 'jh_token'
const USER_KEY = 'jh_user'

function readUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null')
  } catch {
    return null
  }
}

export const token = ref(localStorage.getItem(TOKEN_KEY) || '')
export const user = ref(readUser())
export const isLoggedIn = computed(() => Boolean(token.value))

export function setSession(t, u) {
  token.value = t || ''
  user.value = u || null
  if (t) localStorage.setItem(TOKEN_KEY, t)
  else localStorage.removeItem(TOKEN_KEY)
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u))
  else localStorage.removeItem(USER_KEY)
}

export function clearSession() {
  setSession('', null)
}

/** 拼请求头：有 token 才带，没登录时不要发一个空的 Authorization */
export function authHeaders(extra = {}) {
  const h = { ...extra }
  if (token.value) h.Authorization = `Bearer ${token.value}`
  return h
}
