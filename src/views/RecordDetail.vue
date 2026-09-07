<template>
  <div>
    <div v-if="loading" class="card loading">加载中…</div>

    <div v-else-if="loadError" class="card">
      <div class="error-tip">{{ loadError }}</div>
      <button class="btn btn-ghost" @click="$router.push('/records')">返回记录列表</button>
    </div>

    <template v-else-if="record">
      <div class="card head-card">
        <div class="head-line">
          <span class="tag">{{ record.job }}</span>
          <span class="muted">{{ record.questions }} 题 · {{ formatTime(record.createdAt) }}</span>
        </div>
        <div class="head-score">
          <b :class="scoreClass(record.report?.totalScore)">{{ record.report?.totalScore ?? '-' }}</b>
          <span>综合得分</span>
        </div>
      </div>

      <!-- 完整对话 -->
      <div class="card chat-card">
        <div class="card-title">完整对话</div>
        <div class="chat-list">
          <div
            v-for="(msg, i) in record.history"
            :key="i"
            class="bubble-row"
            :class="msg.role === 'user' ? 'mine' : 'ai'"
          >
            <div class="bubble">{{ msg.content }}</div>
          </div>
        </div>
      </div>

      <!-- 报告 -->
      <div class="card" v-if="record.report">
        <div class="card-title">评分维度</div>
        <div class="dim-list">
          <div v-for="d in record.report.dimensions" :key="d.name" class="dim-item">
            <div class="dim-head">
              <span>{{ d.name }}</span>
              <b :class="scoreClass(d.score)">{{ d.score }}</b>
            </div>
            <div class="bar"><i :style="{ width: d.score + '%' }" :class="scoreClass(d.score)"></i></div>
          </div>
        </div>
      </div>

      <div class="card" v-if="record.report">
        <div class="card-title">每题回顾</div>
        <div v-for="(item, i) in record.report.perQuestion" :key="i" class="q-item">
          <div class="q-head">
            <span class="q-index">第 {{ i + 1 }} 题</span>
            <span class="q-meta">
              <span v-if="record.durations && record.durations[i]" class="muted time-chip">
                用时 {{ record.durations[i].seconds }}s
              </span>
              <b :class="scoreClass(item.score)">{{ item.score }} 分</b>
            </span>
          </div>
          <p class="q-text">{{ item.q }}</p>
          <p class="muted">{{ item.comment }}</p>
        </div>
      </div>

      <div class="cols" v-if="record.report">
        <div class="card">
          <div class="card-title"><span class="tag">改进建议</span></div>
          <ul class="plain-list">
            <li v-for="(s, i) in record.report.suggestions" :key="i">{{ s }}</li>
          </ul>
        </div>
        <div class="card">
          <div class="card-title"><span class="tag tag-success">复盘要点</span></div>
          <ul class="plain-list">
            <li v-for="(k, i) in record.report.keyPoints" :key="i">{{ k }}</li>
          </ul>
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-ghost" @click="$router.push('/records')">返回记录列表</button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const record = ref(null)
const loading = ref(true)
const loadError = ref('')

function scoreClass(score) {
  if (score >= 80) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

function formatTime(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

onMounted(async () => {
  try {
    const res = await fetch(`/api/records/${route.params.id}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '加载失败')
    record.value = data
  } catch (e) {
    loadError.value = e.message || '网络错误'
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.head-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.head-line {
  display: flex;
  align-items: center;
  gap: 12px;
}
.head-score {
  text-align: right;
}
.head-score b {
  font-size: 28px;
  margin-right: 6px;
}
.head-score b.high {
  color: var(--success);
}
.head-score b.mid {
  color: var(--warning);
}
.head-score b.low {
  color: var(--danger);
}
.head-score span {
  font-size: 12px;
  color: var(--text-secondary);
}
.chat-list {
  max-height: 45vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.bubble-row {
  display: flex;
}
.bubble-row.mine {
  justify-content: flex-end;
}
.bubble {
  max-width: 78%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-row.ai .bubble {
  background: #f1f3f5;
  border-top-left-radius: 4px;
}
.bubble-row.mine .bubble {
  background: var(--primary);
  color: #fff;
  border-top-right-radius: 4px;
}
.dim-list {
  display: grid;
  gap: 14px;
}
.dim-head {
  display: flex;
  justify-content: space-between;
  font-weight: 500;
  margin-bottom: 6px;
}
.dim-head b.high,
.q-head b.high {
  color: var(--success);
}
.dim-head b.mid,
.q-head b.mid {
  color: var(--warning);
}
.dim-head b.low,
.q-head b.low {
  color: var(--danger);
}
.bar {
  height: 8px;
  border-radius: 4px;
  background: #edeff1;
  overflow: hidden;
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
.q-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.q-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
  margin-bottom: 4px;
}
.q-head {
  display: flex;
  justify-content: space-between;
}
.q-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}
.time-chip {
  background: #f1f3f5;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.q-index {
  font-weight: 600;
}
.q-text {
  font-weight: 500;
  margin-bottom: 4px;
}
.muted {
  color: var(--text-secondary);
  font-size: 13px;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.cols .card + .card {
  margin-top: 0;
}
.plain-list {
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
@media (max-width: 640px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
