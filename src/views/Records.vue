<template>
  <div>
    <!-- 统计区（8.4） -->
    <template v-if="records.length">
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-label">总场次</span>
          <b class="stat-value">{{ stats.count }}</b>
        </div>
        <div class="stat-card">
          <span class="stat-label">平均总分</span>
          <b class="stat-value" :class="scoreClass(stats.avg)">{{ stats.avg }}</b>
        </div>
        <div class="stat-card">
          <span class="stat-label">最高分</span>
          <b class="stat-value" :class="scoreClass(stats.max)">{{ stats.max }}</b>
        </div>
        <div class="stat-card">
          <span class="stat-label">最近一次分数</span>
          <b class="stat-value" :class="scoreClass(stats.latest)">{{ stats.latest }}</b>
        </div>
      </div>

      <div class="card">
        <div class="card-title">各维度平均分</div>
        <div class="dim-list">
          <div v-for="d in dimAverages" :key="d.name" class="dim-item">
            <span class="dim-name">{{ d.name }}</span>
            <div class="dim-bar"><i :style="{ width: d.score + '%' }" :class="barClass(d.score)"></i></div>
            <b class="dim-score" :class="scoreClass(d.score)">{{ d.score }}</b>
          </div>
        </div>
      </div>

      <div class="card" v-if="trend.length > 1">
        <div class="card-title">最近 {{ trend.length }} 场总分趋势</div>
        <div class="trend">
          <div v-for="(t, i) in trend" :key="i" class="trend-col">
            <span class="trend-score" :class="scoreClass(t.score)">{{ t.score }}</span>
            <div class="trend-bar-wrap">
              <i class="trend-bar" :class="barClass(t.score)" :style="{ height: Math.max(t.score, 4) + '%' }"></i>
            </div>
            <span class="trend-idx">{{ t.idx }}</span>
          </div>
        </div>
      </div>
    </template>

    <div class="card">
      <div class="card-title">面试记录</div>
      <div v-if="loading" class="loading">加载中…</div>
      <div v-else-if="!records.length" class="empty">还没有面试记录，去首页开始一场模拟面试吧。</div>
      <div v-else class="record-list">
        <div v-for="r in records" :key="r.id" class="record-item">
          <div class="record-info">
            <span class="record-job">{{ r.job }}</span>
            <span class="record-time">{{ formatTime(r.createdAt) }}</span>
            <span class="muted">{{ r.questions }} 题</span>
          </div>
          <div class="record-actions">
            <b :class="scoreClass(r.report?.totalScore)">{{ r.report?.totalScore ?? '-' }} 分</b>
            <button class="btn btn-ghost btn-sm" @click="$router.push(`/records/${r.id}`)">查看</button>
            <button class="btn btn-sm danger" @click="remove(r.id)">删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'

const records = ref([])
const loading = ref(true)

const DIMENSION_NAMES = ['表达清晰度', '技术深度', '逻辑性', '岗位匹配度']

const stats = computed(() => {
  const scores = records.value.map((r) => r.report?.totalScore).filter((s) => typeof s === 'number')
  const count = records.value.length
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
  const max = scores.length ? Math.max(...scores) : 0
  const latest = scores.length ? scores[0] : 0 // 列表按时间倒序，第一条即最近
  return { count, avg, max, latest }
})

const dimAverages = computed(() =>
  DIMENSION_NAMES.map((name) => {
    const list = records.value
      .map((r) => r.report?.dimensions?.find((d) => d.name === name)?.score)
      .filter((s) => typeof s === 'number')
    return { name, score: list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0 }
  })
)

// 最近 10 场，按时间正序排列展示（左旧右新）
const trend = computed(() =>
  records.value
    .slice(0, 10)
    .map((r, i) => ({ score: r.report?.totalScore ?? 0, idx: records.value.length - i }))
    .reverse()
)

function scoreClass(score) {
  if (score >= 80) return 'high'
  if (score >= 60) return 'mid'
  return 'low'
}

function barClass(score) {
  if (score >= 80) return 'b-high'
  if (score >= 60) return 'b-mid'
  return 'b-low'
}

function formatTime(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function load() {
  loading.value = true
  try {
    const res = await fetch('/api/records')
    records.value = await res.json()
  } finally {
    loading.value = false
  }
}

async function remove(id) {
  if (!confirm('确定删除这条记录吗？')) return
  const res = await fetch(`/api/records/${id}`, { method: 'DELETE' })
  if (res.ok) {
    records.value = records.value.filter((r) => r.id !== id)
  } else {
    const data = await res.json().catch(() => ({}))
    alert(data.error || '删除失败')
  }
}

onMounted(load)
</script>

<style scoped>
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
}
.stat-value {
  font-size: 24px;
  line-height: 1.2;
}
.stat-value.high {
  color: var(--success);
}
.stat-value.mid {
  color: var(--warning);
}
.stat-value.low {
  color: var(--danger);
}
.dim-list {
  display: grid;
  gap: 12px;
}
.dim-item {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dim-name {
  width: 84px;
  font-size: 14px;
  flex-shrink: 0;
}
.dim-bar {
  flex: 1;
  height: 10px;
  border-radius: 5px;
  background: #edeff1;
  overflow: hidden;
}
.dim-bar i {
  display: block;
  height: 100%;
  border-radius: 5px;
  transition: width 0.3s;
}
.b-high {
  background: var(--success);
}
.b-mid {
  background: var(--warning);
}
.b-low {
  background: var(--danger);
}
.dim-score {
  width: 32px;
  text-align: right;
}
.dim-score.high {
  color: var(--success);
}
.dim-score.mid {
  color: var(--warning);
}
.dim-score.low {
  color: var(--danger);
}
.trend {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 8px 4px 0;
}
.trend-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.trend-score {
  font-size: 12px;
  font-weight: 600;
}
.trend-score.high {
  color: var(--success);
}
.trend-score.mid {
  color: var(--warning);
}
.trend-score.low {
  color: var(--danger);
}
.trend-bar-wrap {
  width: 100%;
  max-width: 40px;
  height: 120px;
  display: flex;
  align-items: flex-end;
  background: #f7f8fa;
  border-radius: 6px;
  overflow: hidden;
}
.trend-bar {
  display: block;
  width: 100%;
  border-radius: 6px 6px 0 0;
  transition: height 0.3s;
}
.trend-idx {
  font-size: 12px;
  color: var(--text-secondary);
}
.empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 40px 0;
}
.record-list {
  display: grid;
}
.record-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.record-item:last-child {
  border-bottom: none;
}
.record-info {
  display: flex;
  align-items: center;
  gap: 12px;
}
.record-job {
  font-weight: 600;
}
.record-time {
  color: var(--text-secondary);
  font-size: 13px;
}
.record-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.record-actions b.high {
  color: var(--success);
}
.record-actions b.mid {
  color: var(--warning);
}
.record-actions b.low {
  color: var(--danger);
}
.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}
.danger {
  background: #fdebec;
  color: var(--danger);
}
@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
