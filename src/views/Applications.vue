<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { api } from '../api.js'

const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']
const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']
const RESULT_CLASS = {
  '待处理': 'res-pending',
  '已确认提交': 'res-submitted',
  '跳过': 'res-skipped',
  '被拦截': 'res-blocked',
  '需用户': 'res-needs-user',
}
const PLATFORMS = ['实习僧', 'BOSS直聘', '拉勾', '牛客网', '智联招聘', '前程无忧', '猎聘', '其他']

const apps = ref([])
const resumes = ref([])
const filterStatus = ref('全部')
const keyword = ref('')
const showForm = ref(false)
const saving = ref(false)
const message = ref('')
const messageError = ref(false)
const tailoring = ref(false)
const matchPoints = ref([])

const emptyForm = () => ({
  id: '',
  resumeId: '',
  company: '',
  jobTitle: '',
  platform: '实习僧',
  jd: '',
  greeting: '',
  status: '待投递',
  result: '待处理',
  note: '',
  appliedAt: '',
})

const form = reactive(emptyForm())
const isNew = computed(() => !form.id)

const statusCounts = computed(() => {
  const map = {}
  for (const s of STATUSES) map[s] = 0
  for (const a of apps.value) if (map[a.status] != null) map[a.status]++
  return map
})

const filtered = computed(() => {
  return apps.value.filter((a) => {
    if (filterStatus.value !== '全部' && a.status !== filterStatus.value) return false
    if (keyword.value.trim()) {
      const k = keyword.value.trim().toLowerCase()
      const hit = (a.company || '').toLowerCase().includes(k) || (a.jobTitle || '').toLowerCase().includes(k)
      if (!hit) return false
    }
    return true
  })
})

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toISOString().slice(0, 10)
}

async function load() {
  ;[apps.value, resumes.value] = await Promise.all([api.applications.list(), api.resumes.list()])
}

function openNew() {
  Object.assign(form, emptyForm())
  if (resumes.value.length) form.resumeId = resumes.value[0].id
  showForm.value = true
}

function openEdit(a) {
  Object.assign(form, {
    id: a.id,
    resumeId: a.resumeId,
    company: a.company,
    jobTitle: a.jobTitle,
    platform: a.platform,
    jd: a.jd,
    greeting: a.greeting,
    status: a.status,
    result: a.result || '待处理',
    note: a.note,
    appliedAt: a.appliedAt ? a.appliedAt.slice(0, 10) : '',
  })
  showForm.value = true
}

async function save() {
  if (!form.company.trim() || !form.jobTitle.trim()) {
    message.value = '公司名与岗位名不能为空'
    messageError.value = true
    return
  }
  saving.value = true
  message.value = ''
  try {
    const payload = { ...form, appliedAt: form.appliedAt || new Date().toISOString() }
    if (isNew.value) await api.applications.create(payload)
    else await api.applications.update(form.id, payload)
    showForm.value = false
    await load()
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    saving.value = false
  }
}

async function tailor() {
  if (!form.resumeId) {
    message.value = '请先在「关联简历」选择一份简历'
    messageError.value = true
    return
  }
  if (!form.jd.trim()) {
    message.value = '请先粘贴岗位 JD'
    messageError.value = true
    return
  }
  tailoring.value = true
  message.value = ''
  matchPoints.value = []
  try {
    const data = await api.tailor({
      resumeId: form.resumeId,
      jd: form.jd,
      company: form.company,
      jobTitle: form.jobTitle,
    })
    form.greeting = data.greeting
    form.coverLetter = data.coverLetter
    form.tailoredResume = data.tailoredResume
    matchPoints.value = data.matchPoints || []
    message.value = 'AI 定制完成，已填入下方，可直接编辑'
    messageError.value = false
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    tailoring.value = false
  }
}

async function changeStatus(a, status) {
  await api.applications.update(a.id, { ...a, status })
  await load()
}

async function remove(a) {
  if (!confirm(`确定删除「${a.company} · ${a.jobTitle}」这条投递记录？`)) return
  await api.applications.remove(a.id)
  await load()
}

function resumeTitle(id) {
  const r = resumes.value.find((x) => x.id === id)
  return r ? r.title : '未关联'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">投递追踪</h1>
        <div class="page-sub">记录每一次投递，跟踪从「待投递」到「offer」的完整状态</div>
      </div>
      <button class="btn btn-primary" @click="openNew">+ 新建投递</button>
    </div>

    <!-- 状态统计 -->
    <div class="stats">
      <div
        class="stat-card"
        :class="{ active: filterStatus === '全部' }"
        @click="filterStatus = '全部'"
      >
        <div class="stat-num">{{ apps.length }}</div>
        <div class="stat-label">全部</div>
      </div>
      <div
        v-for="s in STATUSES"
        :key="s"
        class="stat-card"
        :class="{ active: filterStatus === s }"
        @click="filterStatus = s"
      >
        <div class="stat-num">{{ statusCounts[s] }}</div>
        <div class="stat-label">
          <span class="badge" :class="`badge-class-${s}`">{{ s }}</span>
        </div>
      </div>
    </div>

    <!-- 搜索 -->
    <div style="margin: 16px 0;">
      <input v-model="keyword" class="input" style="max-width: 320px;" placeholder="搜索公司 / 岗位…" />
    </div>

    <!-- 列表 -->
    <div class="card">
      <div v-if="!filtered.length" class="empty">暂无记录，点右上角「新建投递」开始</div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>状态</th>
            <th>投递结果</th>
            <th>公司</th>
            <th>岗位</th>
            <th>平台</th>
            <th>投递日期</th>
            <th>简历</th>
            <th style="text-align: right;">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in filtered" :key="a.id">
            <td>
              <select class="select status-select" :value="a.status" @change="changeStatus(a, $event.target.value)">
                <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
              </select>
            </td>
            <td class="strong">{{ a.company }}</td>
            <td>{{ a.jobTitle }}</td>
            <td><span class="badge badge-pending">{{ a.platform }}</span></td>
            <td>{{ fmtDate(a.appliedAt) }}</td>
            <td class="muted">{{ resumeTitle(a.resumeId) }}</td>
            <td style="text-align: right; white-space: nowrap;">
              <button class="btn" @click="openEdit(a)">编辑</button>
              <button class="btn btn-danger" style="margin-left: 6px;" @click="remove(a)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 表单弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <div class="modal-head">
          <h2 style="margin: 0;">{{ isNew ? '新建投递' : '编辑投递' }}</h2>
          <button class="btn btn-outline" @click="showForm = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="grid-2">
            <div class="field">
              <label class="label">公司 *</label>
              <input v-model="form.company" class="input" placeholder="公司名" />
            </div>
            <div class="field">
              <label class="label">岗位 *</label>
              <input v-model="form.jobTitle" class="input" placeholder="岗位名" />
            </div>
            <div class="field">
              <label class="label">平台</label>
              <select v-model="form.platform" class="select">
                <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <div class="field">
              <label class="label">状态</label>
              <select v-model="form.status" class="select">
                <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="field">
              <label class="label">关联简历</label>
              <select v-model="form.resumeId" class="select">
                <option value="">不关联</option>
                <option v-for="r in resumes" :key="r.id" :value="r.id">{{ r.title }}</option>
              </select>
            </div>
            <div class="field">
              <label class="label">投递日期</label>
              <input v-model="form.appliedAt" type="date" class="input" />
            </div>
          </div>
          <div class="field">
            <label class="label">岗位 JD（供 AI 定制 / 匹配使用）</label>
            <textarea v-model="form.jd" class="textarea" placeholder="粘贴岗位描述…"></textarea>
            <button
              class="btn btn-outline"
              style="margin-top: 8px;"
              :disabled="tailoring"
              @click="tailor"
            >{{ tailoring ? 'AI 定制中…' : 'AI 定制（生成打招呼语 / 求职信 / 定制简历）' }}</button>
            <div v-if="matchPoints.length" class="match-points">
              <div v-for="(p, i) in matchPoints" :key="i" class="match-point">{{ p }}</div>
            </div>
          </div>
          <div class="field">
            <label class="label">打招呼语</label>
            <textarea v-model="form.greeting" class="textarea" placeholder="投递时发给 HR 的话（后续可由 AI 自动生成）"></textarea>
          </div>
          <div class="field">
            <label class="label">跟进备注</label>
            <textarea v-model="form.note" class="textarea"></textarea>
          </div>
          <div v-if="message" class="msg" :class="{ 'msg-error': messageError }">{{ message }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 10px;
}
.stat-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  text-align: center;
  cursor: pointer;
}
.stat-card:hover {
  border-color: var(--primary);
}
.stat-card.active {
  border-color: var(--primary);
  background: #eef2ff;
}
.stat-num {
  font-size: 22px;
  font-weight: 700;
}
.stat-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}

.table {
  width: 100%;
  border-collapse: collapse;
}
.table th,
.table td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.table th {
  color: var(--text-dim);
  font-weight: 600;
}
.table tr:last-child td {
  border-bottom: none;
}
.strong {
  font-weight: 600;
}
.status-select {
  width: auto;
  padding: 4px 6px;
  font-size: 12px;
}

/* 投递结果徽章（applypilot 五态） */
.res-pending { background: #f3f4f6; color: #6b7280; }
.res-submitted { background: #f0fdf4; color: #16a34a; }
.res-skipped { background: #eff6ff; color: #2563eb; }
.res-blocked { background: #fef2f2; color: #dc2626; }
.res-needs-user { background: #fef4e6; color: #c47d10; }

.match-points {
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 8px;
  padding: 8px 12px;
  margin-top: 6px;
}
.match-point {
  font-size: 13px;
  color: #15803d;
  line-height: 1.7;
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--panel);
  border-radius: 12px;
  width: 720px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-body {
  padding: 20px;
  overflow: auto;
}
.modal-foot {
  padding: 14px 20px;
  border-top: 1px solid var(--border);
  text-align: right;
}
</style>
