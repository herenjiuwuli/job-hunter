<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api.js'

const resumes = ref([])
const resumeId = ref('')
const results = ref([])
const loading = ref(false)
const scored = ref(false)
const message = ref('')
const messageError = ref(false)

async function load() {
  resumes.value = await api.resumes.list()
  if (resumes.value.length) resumeId.value = resumes.value[0].id
}

async function run() {
  if (!resumeId.value) {
    message.value = '请先选择一份简历'
    messageError.value = true
    return
  }
  loading.value = true
  scored.value = true
  message.value = ''
  messageError.value = false
  try {
    results.value = await api.match(resumeId.value)
    if (!results.value.length) {
      message.value = '没有带 JD 的投递记录可打分。先到「投递追踪」添加岗位并粘贴 JD。'
    }
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    loading.value = false
  }
}

function barColor(score) {
  if (score == null) return '#d1d5db'
  if (score >= 60) return '#16a34a'
  if (score >= 30) return '#f59e0b'
  return '#dc2626'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">匹配排序</h1>
        <div class="page-sub">用关键词权重法给所有 JD 打分，优先投匹配度高的岗位</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 18px;">
      <div style="display: flex; gap: 12px; align-items: flex-end;">
        <div class="field" style="margin: 0; flex: 1; max-width: 360px;">
          <label class="label">选择简历</label>
          <select v-model="resumeId" class="select">
            <option v-for="r in resumes" :key="r.id" :value="r.id">{{ r.title || '未命名简历' }}（{{ r.target || '未设方向' }}）</option>
          </select>
        </div>
        <button class="btn btn-primary" :disabled="loading" @click="run">
          {{ loading ? '打分中…' : '开始打分' }}
        </button>
      </div>
      <div v-if="message" class="msg" :class="{ 'msg-error': messageError }" style="margin-top: 10px;">{{ message }}</div>
    </div>

    <div class="card">
      <div v-if="!scored" class="empty">选择简历后点「开始打分」</div>
      <div v-else-if="!results.length" class="empty">暂无可打分的 JD</div>
      <table v-else class="table">
        <thead>
          <tr>
            <th style="width: 50px;">#</th>
            <th>公司</th>
            <th>岗位</th>
            <th>平台</th>
            <th style="width: 200px;">匹配分</th>
            <th>命中关键词</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in results" :key="r.id">
            <td class="muted">{{ i + 1 }}</td>
            <td class="strong">{{ r.company }}</td>
            <td>{{ r.jobTitle }}</td>
            <td><span class="badge badge-pending">{{ r.platform }}</span></td>
            <td>
              <div class="score-bar">
                <div
                  class="score-fill"
                  :style="{ width: (r.score ?? 0) + '%', background: barColor(r.score) }"
                ></div>
              </div>
              <div class="score-text">
                <span v-if="r.score != null" :style="{ color: barColor(r.score), fontWeight: 700 }">{{ r.score }}%</span>
                <span v-else class="muted">无关键词</span>
              </div>
            </td>
            <td>
              <span v-if="r.matched.length" class="kw-tags">
                <span v-for="k in r.matched" :key="k" class="kw-tag kw-hit">{{ k }}</span>
              </span>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
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
  vertical-align: middle;
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

.score-bar {
  height: 8px;
  background: #f3f4f6;
  border-radius: 999px;
  overflow: hidden;
}
.score-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s;
}
.score-text {
  font-size: 12px;
  margin-top: 3px;
}

.kw-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.kw-tag {
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 999px;
}
.kw-hit {
  background: #eef2ff;
  color: #4f46e5;
}
</style>
