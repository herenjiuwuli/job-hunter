const BASE = '/api'

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `请求失败 (${res.status})`)
  }
  return res.json()
}

export const api = {
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
  backup: {
    export: () => request('/backup/export'),
    import: (data) => request('/backup/import', { method: 'POST', body: JSON.stringify(data) }),
  },
  dashboard: () => request('/dashboard'),
}
