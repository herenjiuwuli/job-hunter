<template>
  <div>
    <!-- 上下文输入 -->
    <div class="card">
      <div class="card-title">投递助手</div>
      <p class="tip">根据简历与岗位生成投递清单、打招呼语和求职信，复制后自行投递（不做任何自动投递操作）。</p>
      <div class="form-row">
        <label>目标岗位
          <select v-model="job">
            <option v-for="j in allJobs" :key="j" :value="j">{{ j }}</option>
          </select>
        </label>
        <label class="grow">粘贴真实 JD（可选，命中后素材更贴合）
          <input v-model="jd" type="text" placeholder="从招聘网站复制 JD 原文粘贴到这里" />
        </label>
      </div>
      <label class="resume-label">简历内容
        <textarea v-model="resume" rows="6" placeholder="粘贴你的简历文本"></textarea>
      </label>
      <div class="toolbar">
        <button class="btn" :disabled="loading || !resume.trim() || !job" @click="generate">
          {{ loading ? '生成中…' : '生成投递素材' }}
        </button>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">AI 正在生成投递素材，请稍候…</div>

    <template v-if="result && !loading">
      <!-- 投递清单 -->
      <div class="card">
        <div class="card-title">推荐投递方向</div>
        <div class="apply-grid">
          <div v-for="(a, i) in result.applyList" :key="i" class="apply-card">
            <div class="apply-name">{{ a.company }}</div>
            <p class="muted">{{ a.reason }}</p>
          </div>
        </div>
      </div>

      <!-- 打招呼语 -->
      <div class="card">
        <div class="title-row">
          <div class="card-title">打招呼语</div>
          <button class="btn btn-ghost btn-sm" @click="copy(result.greeting, 'g')">
            {{ copied.g ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="material">{{ result.greeting }}</p>
      </div>

      <!-- 求职信 -->
      <div class="card">
        <div class="title-row">
          <div class="card-title">求职信</div>
          <button class="btn btn-ghost btn-sm" @click="copy(result.coverLetter, 'c')">
            {{ copied.c ? '已复制' : '复制' }}
          </button>
        </div>
        <p class="material">{{ result.coverLetter }}</p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { appState } from '../store.js'

const allJobs = ['前端开发', '自动化测试', '后端开发', '产品运营', '数据分析']

const job = ref(appState.selectedJob || '前端开发')
const jd = ref('')
const resume = ref(appState.resume || '')
const loading = ref(false)
const error = ref('')
const result = ref(null)
const copied = reactive({ g: false, c: false })

onMounted(() => {
  if (!job.value || !allJobs.includes(job.value)) job.value = '前端开发'
})

async function generate() {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const res = await fetch('/api/apply/assist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: resume.value.trim(), job: job.value, jd: jd.value.trim() }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '生成失败')
    result.value = data
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function copy(text, key) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied[key] = true
  setTimeout(() => (copied[key] = false), 2000)
}
</script>

<style scoped>
.tip {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 14px;
}
.form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.form-row label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
.form-row .grow {
  flex: 1;
}
.form-row select,
.form-row input,
.resume-label textarea {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.form-row select:focus,
.form-row input:focus,
.resume-label textarea:focus {
  border-color: var(--primary);
}
.resume-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
.toolbar {
  margin-top: 12px;
}
.apply-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.apply-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
}
.apply-name {
  font-weight: 600;
  margin-bottom: 4px;
}
.muted {
  color: var(--text-secondary);
  font-size: 13px;
}
.title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.title-row .card-title {
  margin-bottom: 0;
}
.material {
  white-space: pre-wrap;
  line-height: 1.8;
  background: #fafbfc;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
}
.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}
@media (max-width: 640px) {
  .form-row {
    flex-direction: column;
  }
}
</style>
