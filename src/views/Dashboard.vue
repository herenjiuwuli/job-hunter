<script setup>
import { ref, onMounted } from 'vue'
import { api } from '../api.js'

const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']
const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']

const summary = ref(null)
const loading = ref(true)
const error = ref('')

const STATUS_CLASS = {
  '待投递': 'st-gray',
  '已投递': 'st-blue',
  '已沟通': 'st-cyan',
  '已面试': 'st-amber',
  '已offer': 'st-green',
  '已拒绝': 'st-red',
  '已淘汰': 'st-dark',
}

const RESULT_CLASS = {
  '待处理': 'res-pending',
  '已确认提交': 'res-submitted',
  '跳过': 'res-skipped',
  '被拦截': 'res-blocked',
  '需用户': 'res-needs-user',
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    summary.value = await api.dashboard()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function statusPct(s) {
  const byStatus = summary.value?.applications?.byStatus || {}
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0)
  if (!total) return 0
  return Math.round(((byStatus[s] || 0) / total) * 100)
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function scoreClass(s) {
  if (s >= 80) return 'high'
  if (s >= 60) return 'mid'
  return 'low'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">求职总览</h1>
        <div class="page-sub">一眼看清求职进度：投了多少、进行到哪、面了几场、错了几题</div>
      </div>
      <button class="btn btn-outline" @click="load">刷新</button>
    </div>

    <div v-if="loading" class="card"><div class="muted">加载中…</div></div>
    <div v-else-if="error" class="card"><div class="msg msg-error">{{ error }}</div></div>

    <template v-else>
      <!-- KPI -->
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-num">{{ summary.counts.applications }}</div>
          <div class="kpi-label">累计投递</div>
          <div class="kpi-sub">进行中 {{ summary.applications.activeCount }} 个</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">{{ summary.counts.records }}</div>
          <div class="kpi-label">模拟面试</div>
          <div class="kpi-sub">平均 {{ summary.interview.avgScore || '—' }} 分</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">{{ summary.counts.resumes }}</div>
          <div class="kpi-label">简历库</div>
          <div class="kpi-sub">{{ summary.counts.profileFilled ? '画像已填' : '画像未填' }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-num">{{ summary.interview.wrongCount }}</div>
          <div class="kpi-label">错题积累</div>
          <div class="kpi-sub">去「错题本」复习</div>
        </div>
      </div>

      <!-- 投递 + 面试 双栏 -->
      <div class="two-col">
        <div class="card">
          <div class="card-title">投递进度</div>
          <div v-if="!summary.counts.applications" class="empty">还没有投递记录，去「投递追踪」添加吧</div>
          <div v-else class="bar-list">
            <div v-for="s in STATUSES" :key="s" class="bar-item">
              <span class="bar-label">{{ s }}</span>
              <div class="bar-track"><i :style="{ width: statusPct(s) + '%' }" :class="STATUS_CLASS[s]"></i></div>
              <b class="bar-num">{{ summary.applications.byStatus[s] }}</b>
            </div>
          </div>

          <div class="card-title" style="margin-top: 20px;">投递结果（这次成没成）</div>
          <div class="result-row">
            <span v-for="r in RESULTS" :key="r" class="badge" :class="RESULT_CLASS[r]">
              {{ r }} {{ summary.applications.byResult[r] }}
            </span>
          </div>
        </div>

        <div class="card">
          <div class="card-title">面试表现</div>
          <div v-if="!summary.counts.records" class="empty">还没有面试记录，去「模拟面试」练一场</div>
          <template v-else>
            <div class="score-row">
              <div class="score-box">
                <div class="score-num" :class="scoreClass(summary.interview.avgScore)">{{ summary.interview.avgScore }}</div>
                <div class="score-label">平均分</div>
              </div>
              <div class="score-box">
                <div class="score-num" :class="scoreClass(summary.interview.latestScore)">{{ summary.interview.latestScore }}</div>
                <div class="score-label">最近一场</div>
              </div>
              <div class="score-box">
                <div class="score-num">{{ summary.interview.wrongCount }}</div>
                <div class="score-label">错题数</div>
              </div>
            </div>
            <div class="rec-list">
              <div v-for="r in summary.interview.recent" :key="r.id" class="rec-item">
                <span class="rec-job">{{ r.job }}</span>
                <span class="muted">{{ fmtDate(r.createdAt) }}</span>
                <b :class="scoreClass(r.totalScore)">{{ r.totalScore ?? '—' }} 分</b>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 最近投递 -->
      <div class="card">
        <div class="card-title">最近投递</div>
        <div v-if="!summary.applications.recent.length" class="empty">暂无投递记录</div>
        <table v-else class="table">
          <thead>
            <tr><th>公司</th><th>岗位</th><th>状态</th><th>结果</th><th>日期</th></tr>
          </thead>
          <tbody>
            <tr v-for="(a, i) in summary.applications.recent" :key="i">
              <td class="strong">{{ a.company }}</td>
              <td>{{ a.jobTitle }}</td>
              <td>{{ a.status }}</td>
              <td><span class="badge" :class="RESULT_CLASS[a.result] || 'res-pending'">{{ a.result || '待处理' }}</span></td>
              <td class="muted">{{ fmtDate(a.appliedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 目标岗位 -->
      <div class="card" v-if="summary.targets.length">
        <div class="card-title">目标岗位</div>
        <div class="tag-row">
          <span v-for="t in summary.targets" :key="t" class="tag">{{ t }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.kpi {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
}
.kpi-num {
  font-size: 28px;
  font-weight: 700;
  color: var(--primary);
  line-height: 1.2;
}
.kpi-label {
  font-size: 13px;
  color: var(--text-dim);
  margin-top: 4px;
}
.kpi-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 12px;
}

.bar-list {
  display: grid;
  gap: 10px;
}
.bar-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar-label {
  width: 52px;
  font-size: 13px;
  flex-shrink: 0;
}
.bar-track {
  flex: 1;
  height: 12px;
  background: #f0f1f3;
  border-radius: 6px;
  overflow: hidden;
}
.bar-track i {
  display: block;
  height: 100%;
  border-radius: 6px;
  transition: width 0.3s;
}
.bar-num {
  width: 26px;
  text-align: right;
  font-size: 13px;
  font-weight: 600;
}

.st-gray { background: #cbd5e1; }
.st-blue { background: #3b82f6; }
.st-cyan { background: #06b6d4; }
.st-amber { background: #f59e0b; }
.st-green { background: #22c55e; }
.st-red { background: #ef4444; }
.st-dark { background: #64748b; }

.result-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.res-pending { background: #f3f4f6; color: #6b7280; }
.res-submitted { background: #f0fdf4; color: #16a34a; }
.res-skipped { background: #eff6ff; color: #2563eb; }
.res-blocked { background: #fef2f2; color: #dc2626; }
.res-needs-user { background: #fef4e6; color: #c47d10; }

.score-row {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}
.score-box {
  flex: 1;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.score-num {
  font-size: 26px;
  font-weight: 700;
}
.score-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 2px;
}

.high { color: var(--success); }
.mid { color: var(--warning); }
.low { color: var(--danger); }

.rec-list {
  display: grid;
}
.rec-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.rec-item:last-child {
  border-bottom: none;
}
.rec-job {
  font-weight: 600;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tag {
  background: #eef2ff;
  color: var(--primary);
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
}

@media (max-width: 900px) {
  .kpi-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .two-col {
    grid-template-columns: 1fr;
  }
}
</style>
