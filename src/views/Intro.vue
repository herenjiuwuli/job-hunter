<template>
  <div>
    <div class="card">
      <div class="card-title">自我介绍专项练习</div>
      <p class="tip">写下你的面试自我介绍，AI 从内容相关性、结构、亮点、篇幅四个角度逐句点评，并给出同场景更优示例。</p>
      <div class="form-row">
        <label>目标岗位
          <select v-model="job">
            <option v-for="j in allJobs" :key="j" :value="j">{{ j }}</option>
          </select>
        </label>
        <label>时长
          <select v-model="duration">
            <option :value="60">1 分钟</option>
            <option :value="180">3 分钟</option>
          </select>
        </label>
      </div>
      <label class="resume-label">简历内容
        <textarea v-model="resume" rows="4" placeholder="粘贴你的简历文本"></textarea>
      </label>
      <label class="resume-label">
        自我介绍
        <textarea v-model="intro" rows="7" :placeholder="introTip"></textarea>
      </label>
      <div class="word-count" :class="wordCountClass">当前 {{ intro.length }} 字（建议 {{ wordRange }}）</div>
      <div class="toolbar">
        <button class="btn" :disabled="loading || !intro.trim() || !resume.trim() || !job" @click="submit">
          {{ loading ? '点评中…' : '提交点评' }}
        </button>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">教练正在点评，请稍候…</div>

    <template v-if="result && !loading">
      <div class="card">
        <div class="title-row">
          <div class="card-title">综合评分</div>
          <b class="big-score" :class="result.score >= 80 ? 'high' : result.score >= 60 ? 'mid' : 'low'">
            {{ result.score }}
          </b>
        </div>
      </div>

      <div class="card">
        <div class="card-title">逐句点评</div>
        <div class="comment-list">
          <div v-for="(c, i) in result.comments" :key="i" class="comment-item">
            <p class="sentence">「{{ c.sentence }}」</p>
            <p class="comment">{{ c.comment }}</p>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">改进建议</div>
        <ul class="list">
          <li v-for="(s, i) in result.suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>

      <div class="card">
        <div class="title-row">
          <div class="card-title">更优示例</div>
          <button class="btn btn-ghost btn-sm" @click="copyExample">
            {{ copied ? '已复制' : '复制示例' }}
          </button>
        </div>
        <p class="example">{{ result.exampleIntro }}</p>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { appState } from '../store.js'

const allJobs = ['前端开发', '自动化测试', '后端开发', '产品运营', '数据分析']

const job = ref(appState.selectedJob || '前端开发')
const duration = ref(60)
const resume = ref(appState.resume || '')
const intro = ref('')
const loading = ref(false)
const error = ref('')
const result = ref(null)
const copied = ref(false)

const wordRange = computed(() => (Number(duration.value) === 180 ? '600-800 字' : '200-260 字'))
const introTip = computed(() => `写下你的 ${Number(duration.value) === 180 ? '3 分钟' : '1 分钟'}面试自我介绍`)

const wordCountClass = computed(() => {
  const len = intro.value.length
  const [min, max] = Number(duration.value) === 180 ? [600, 800] : [200, 260]
  if (len === 0) return ''
  return len >= min && len <= max ? 'ok' : len < min ? 'short' : 'long'
})

onMounted(() => {
  if (!job.value || !allJobs.includes(job.value)) job.value = '前端开发'
})

async function submit() {
  loading.value = true
  error.value = ''
  result.value = null
  try {
    const res = await fetch('/api/intro/practice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resume: resume.value.trim(),
        job: job.value,
        duration: Number(duration.value),
        intro: intro.value.trim(),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '点评失败')
    result.value = data
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function copyExample() {
  try {
    await navigator.clipboard.writeText(result.value.exampleIntro)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = result.value.exampleIntro
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
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
.form-row select,
.resume-label textarea {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.resume-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.word-count {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.word-count.ok {
  color: var(--success);
}
.word-count.short {
  color: var(--warning);
}
.word-count.long {
  color: var(--danger);
}
.toolbar {
  margin-top: 4px;
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
.big-score {
  font-size: 36px;
  line-height: 1;
}
.big-score.high {
  color: var(--success);
}
.big-score.mid {
  color: var(--warning);
}
.big-score.low {
  color: var(--danger);
}
.comment-list {
  display: grid;
  gap: 14px;
}
.comment-item {
  border-left: 3px solid var(--primary);
  padding-left: 12px;
}
.sentence {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
}
.comment {
  color: var(--text-secondary);
  font-size: 13px;
}
.list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.example {
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
