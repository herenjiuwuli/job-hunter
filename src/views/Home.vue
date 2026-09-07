<template>
  <div>
    <!-- 输入区 -->
    <div class="card">
      <div class="card-title">简历分析</div>
      <textarea
        v-model="resume"
        rows="10"
        placeholder="请粘贴你的简历文本（支持从 Word/PDF 复制出的纯文本），例如：姓名、教育经历、项目经验、技能清单……"
      ></textarea>
      <div class="toolbar">
        <label class="qlabel">面试题数</label>
        <select v-model.number="questionCount">
          <option v-for="n in 6" :key="n" :value="n + 2">{{ n + 2 }}</option>
        </select>
        <label class="qlabel">面试难度</label>
        <select v-model="difficulty">
          <option value="easy">简单</option>
          <option value="medium">中等</option>
          <option value="hard">困难</option>
        </select>
        <label class="qlabel">面试类型</label>
        <select v-model="interviewerType">
          <option value="tech">技术面</option>
          <option value="hr">HR面</option>
          <option value="star">行为面</option>
        </select>
        <button class="btn" :disabled="loading || !resume.trim()" @click="analyze">
          {{ loading ? '分析中…' : '开始分析' }}
        </button>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">AI 正在分析你的简历，请稍候…</div>

    <template v-if="result && !loading">
      <!-- 匹配度 -->
      <div class="card">
        <div class="card-title">匹配度评分</div>
        <div class="score-list">
          <div v-for="m in result.matchScores" :key="m.name" class="score-item">
            <div class="score-head">
              <span>{{ m.name }}</span>
              <b :class="scoreClass(m.score)">{{ m.score }}</b>
            </div>
            <div class="bar"><i :style="{ width: m.score + '%' }" :class="scoreClass(m.score)"></i></div>
            <p class="muted">{{ m.comment }}</p>
          </div>
        </div>
      </div>

      <!-- 亮点 / 短板 -->
      <div class="cols">
        <div class="card">
          <div class="card-title"><span class="tag tag-success">亮点</span></div>
          <ul class="plain-list">
            <li v-for="(h, i) in result.highlights" :key="i">{{ h }}</li>
          </ul>
        </div>
        <div class="card">
          <div class="card-title"><span class="tag tag-warning">短板</span></div>
          <ul class="plain-list">
            <li v-for="(w, i) in result.weaknesses" :key="i">{{ w }}</li>
          </ul>
        </div>
      </div>

      <!-- 预测问题 -->
      <div class="card">
        <div class="card-title">面试官可能会问</div>
        <ol class="plain-list">
          <li v-for="(q, i) in result.predictedQuestions" :key="i">{{ q }}</li>
        </ol>
      </div>

      <!-- 岗位推荐 -->
      <div class="card">
        <div class="card-title">岗位推荐（点击选中，进入模拟面试）</div>
        <div class="job-grid">
          <div
            v-for="job in result.recommendJobs"
            :key="job.name"
            class="job-card"
            :class="{ active: selectedJob === job.name }"
            @click="selectJob(job.name)"
          >
            <div class="job-head">
              <span class="job-name">{{ job.name }}</span>
              <span class="job-score" :class="scoreClass(job.score)">{{ job.score }} 分</span>
            </div>
            <p class="muted">{{ job.reason }}</p>
          </div>
        </div>
        <div v-if="selectedJob" class="selected-tip">
          已选中岗位：<b>{{ selectedJob }}</b>
          <button class="btn" @click="goInterview">进入模拟面试</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { appState, selectJob } from '../store.js'

const router = useRouter()
const resume = ref(appState.resume)
const questionCount = ref(appState.questionCount)
const difficulty = ref(appState.difficulty || 'medium')
const interviewerType = ref(appState.interviewerType || 'tech')
const loading = ref(false)
const error = ref('')
const result = computed(() => appState.analysis)
const selectedJob = computed(() => appState.selectedJob)

function scoreClass(score) {
  if (score >= 80) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

function goInterview() {
  router.push('/interview')
}

async function analyze() {
  loading.value = true
  error.value = ''
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: resume.value, questions: questionCount.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '分析失败')
    appState.analysis = data
    appState.resume = resume.value
    appState.questionCount = questionCount.value
    appState.difficulty = difficulty.value
    appState.interviewerType = interviewerType.value
    selectJob('') // 新分析重置选中岗位
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.qlabel {
  color: var(--text-secondary);
}
.toolbar select {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}
.toolbar .btn {
  margin-left: auto;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.cols .card + .card {
  margin-top: 0;
}
.score-list {
  display: grid;
  gap: 14px;
}
.score-head {
  display: flex;
  justify-content: space-between;
  font-weight: 500;
}
.score-head b.high {
  color: var(--success);
}
.score-head b.mid {
  color: var(--warning);
}
.score-head b.low {
  color: var(--danger);
}
.bar {
  height: 8px;
  border-radius: 4px;
  background: #edeff1;
  overflow: hidden;
  margin: 6px 0;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 4px;
}
.bar i.high {
  background: var(--success);
}
.bar i.mid {
  background: var(--warning);
}
.bar i.low {
  background: var(--danger);
}
.muted {
  color: var(--text-secondary);
  font-size: 13px;
}
.plain-list {
  padding-left: 20px;
  display: grid;
  gap: 6px;
}
.job-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.job-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.job-card:hover {
  border-color: var(--primary);
}
.job-card.active {
  border-color: var(--primary);
  background: var(--primary-weak);
  box-shadow: 0 0 0 1px var(--primary) inset;
}
.job-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.job-name {
  font-weight: 600;
}
.job-score {
  font-weight: 600;
}
.job-score.high {
  color: var(--success);
}
.job-score.mid {
  color: var(--warning);
}
.job-score.low {
  color: var(--danger);
}
.selected-tip {
  margin-top: 14px;
  color: var(--primary);
  display: flex;
  align-items: center;
  gap: 12px;
}
@media (max-width: 640px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
