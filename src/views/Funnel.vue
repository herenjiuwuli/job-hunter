<script setup>
/**
 * 投递漏斗
 *
 * 只画「到达过」的层数，不画「此刻停在这」—— 两者差得很多：
 * 一条已经判不合格的记录，现在停在「不合格」，但它到过面试。
 * 按当前状态画，面试层会凭空少人，看起来像转化崩了。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../api.js'

const GROUPS = [
  { key: '', label: '总览' },
  { key: 'direction', label: '按方向' },
  { key: 'platform', label: '按平台' },
  { key: 'resume', label: '按简历' },
]

const STAGE_LABELS = {
  submitted: '已投递',
  viewed: '被查看',
  screening: '初筛',
  written: '笔试',
  interview: '面试',
  offer: '录用',
  rejected: '不合格',
}
const FUNNEL_ORDER = ['submitted', 'viewed', 'screening', 'written', 'interview', 'offer']

const groupBy = ref('')
const data = ref(null)
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await api.funnel(groupBy.value || undefined)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(groupBy, load)

const overall = computed(() => data.value?.overall || null)
const total = computed(() => overall.value?.total || 0)

const bars = computed(() => {
  const ov = overall.value
  if (!ov) return []
  const base = ov.reached.submitted || 0
  return FUNNEL_ORDER.map((key, i) => {
    const n = ov.reached[key] || 0
    const prevKey = i > 0 ? FUNNEL_ORDER[i - 1] : null
    const prev = prevKey ? ov.reached[prevKey] || 0 : null
    return {
      key,
      label: STAGE_LABELS[key],
      n,
      pct: base ? Math.round((n / base) * 1000) / 10 : 0,
      step: prev === null ? null : prev > 0 ? Math.round((n / prev) * 1000) / 10 : null,
    }
  })
})

const rejectedCount = computed(() => overall.value?.current?.rejected || 0)

const cards = computed(() => {
  const ov = overall.value
  if (!ov) return []
  const fmt = (v) => (v === null || v === undefined ? '—' : `${v}%`)
  return [
    { label: '已投递（进漏斗）', value: ov.total, hint: '只算平台确认过的' },
    { label: '被查看率', value: fmt(ov.rateView) },
    { label: '回复率', value: fmt(ov.rateReply), hint: `${ov.replied} 家有回话` },
    { label: '面试率', value: fmt(ov.rateInterview) },
    { label: '录用率', value: fmt(ov.rateOffer) },
    {
      label: '平均首次被查看',
      value: ov.avgFirstViewHours === null ? '—' : `${ov.avgFirstViewHours} 小时`,
    },
  ]
})

const groups = computed(() => data.value?.groups || [])
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">投递漏斗</h1>
        <p class="page-sub">
          同一批投递从「投出去」到「约面」漏在哪一层。层数是<b>到达过</b>，不是此刻停在这。
        </p>
      </div>
      <div class="tabs">
        <button
          v-for="g in GROUPS"
          :key="g.key"
          class="tab"
          :class="{ active: groupBy === g.key }"
          @click="groupBy = g.key"
        >
          {{ g.label }}
        </button>
      </div>
    </div>

    <div v-if="error" class="card err">{{ error }}</div>

    <div v-else-if="loading && !data" class="card muted">加载中…</div>

    <div v-else-if="!total" class="card empty-state">
      <p><b>还没有可统计的投递。</b></p>
      <p class="muted">
        漏斗只统计「平台确认过的投递」（有阶段的记录）。草稿不进分母。<br />
        去扩展里点「同步投递进度」，把实习僧 / BOSS 上的状态抓回来。
      </p>
    </div>

    <template v-else>
      <div class="stat-grid">
        <div v-for="c in cards" :key="c.label" class="card stat">
          <div class="stat-num">{{ c.value }}</div>
          <div class="stat-label">{{ c.label }}</div>
          <div v-if="c.hint" class="stat-hint">{{ c.hint }}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">漏斗</div>
        <div class="funnel">
          <div v-for="b in bars" :key="b.key" class="funnel-row">
            <div class="funnel-label">{{ b.label }}</div>
            <div class="funnel-track">
              <div
                class="funnel-fill"
                :class="`f-${b.key}`"
                :style="{ width: b.n ? Math.max(b.pct, 1.5) + '%' : '0%' }"
              />
            </div>
            <div class="funnel-num">{{ b.n }}</div>
            <div class="funnel-step">
              <span v-if="b.step !== null" :class="{ weak: b.step < 30 }">{{ b.step }}%</span>
              <span v-else class="muted">—</span>
            </div>
          </div>
        </div>
        <p class="note">
          右侧百分比是<b>相对上一层</b>的转化。当前停在「不合格」的有 {{ rejectedCount }} 家 ——
          它们已经计入各自到达过的层，不会从漏斗里消失。
        </p>
      </div>

      <div v-if="groups.length" class="card">
        <div class="card-title">分组对比</div>
        <table class="tbl">
          <thead>
            <tr>
              <th>{{ GROUPS.find((g) => g.key === groupBy)?.label.replace('按', '') }}</th>
              <th>投递</th>
              <th>被查看</th>
              <th>回复</th>
              <th>面试</th>
              <th>录用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in groups" :key="g.key">
              <td class="td-name">{{ g.label }}</td>
              <td>{{ g.total }}</td>
              <td>{{ g.rateView === null ? '—' : g.rateView + '%' }}</td>
              <td>{{ g.rateReply === null ? '—' : g.rateReply + '%' }}</td>
              <td>{{ g.rateInterview === null ? '—' : g.rateInterview + '%' }}</td>
              <td>{{ g.rateOffer === null ? '—' : g.rateOffer + '%' }}</td>
            </tr>
          </tbody>
        </table>
        <p class="note">
          少于 5 条的分组别当结论 —— 样本太小时百分比抖得厉害，一条命中就能翻一倍。
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 4px;
}
.tab {
  padding: 5px 12px;
  border: 1px solid var(--border);
  background: var(--card);
  border-radius: 3px;
  font-size: var(--fs-sm);
  color: var(--text-dim);
  cursor: pointer;
}
.tab.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}
.stat-num {
  font-size: var(--fs-xl);
  font-weight: 700;
  color: var(--text);
}
.stat-label {
  font-size: var(--fs-xs);
  color: var(--text-dim);
  margin-top: 2px;
}
.stat-hint {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  margin-top: 4px;
}
.funnel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 6px;
}
.funnel-row {
  display: grid;
  grid-template-columns: 64px 1fr 48px 52px;
  align-items: center;
  gap: 10px;
}
.funnel-label {
  font-size: var(--fs-sm);
  color: var(--text-dim);
  text-align: right;
}
.funnel-track {
  height: 22px;
  background: var(--bg);
  border-radius: 3px;
  overflow: hidden;
}
.funnel-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.25s ease;
}
.f-submitted { background: #93b4d8; }
.f-viewed { background: #6f9ec9; }
.f-screening { background: #4f86b8; }
.f-written { background: #3a6f9e; }
.f-interview { background: #2f5b85; }
.f-offer { background: #1f7a4d; }
.funnel-num {
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.funnel-step {
  font-size: var(--fs-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.funnel-step .weak {
  color: #b45309;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-sm);
}
.tbl th {
  text-align: left;
  font-weight: 500;
  color: var(--text-faint);
  font-size: var(--fs-xs);
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.tbl td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
.td-name {
  color: var(--text);
}
.note {
  margin: 10px 0 0;
  font-size: var(--fs-xs);
  color: var(--text-faint);
  line-height: 1.6;
}
.empty-state {
  padding: 22px 20px;
  line-height: 1.7;
}
.empty-state p {
  margin: 0 0 8px;
}
.err {
  color: #b91c1c;
}
</style>
