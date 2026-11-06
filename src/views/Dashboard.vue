<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { STAGE_LABELS } from '../stages.js'

/**
 * 求职总览（2026-11-06 改版为「行动导向」）
 *
 * 改版原因：原来的总览是一屏数字（KPI 4 个 + 进度条 7 根 + 结果徽章 5 个 + 表格），
 * 看完知道"投了多少"，但不知道"现在该干什么"。而它和「投递漏斗」页又各画一套进度图，
 * 两页讲同一件事、口径还不一样（总览按当前 stage 分布，漏斗按到达过）。
 *
 * 现在的分工：
 *   总览 = 我现在该做什么（行动）+ 关键数字（4 个）+ 漏斗缩略（口径与漏斗页一致）
 *   漏斗页 = 漏在哪一层（转化率、按方向/平台/简历分组对比）
 * 所以这里刻意**不画**转化率、不画分组，避免又一次重复。
 */

// 平台阶段（stage）是进度的真实来源，人工 status 采集器不写
const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']

// 漏斗缩略只画这几层；rejected 不在主链上（它是终止态，由漏斗页单独说明）
const FUNNEL_LAYERS = ['submitted', 'viewed', 'screening', 'written', 'interview', 'offer']

const RESULT_CLASS = {
  '待处理': 'res-pending',
  '已确认提交': 'res-submitted',
  '跳过': 'res-skipped',
  '被拦截': 'res-blocked',
  '需用户': 'res-needs-user',
}

const summary = ref(null)
const funnel = ref(null)
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    // 漏斗单独失败不该把整个总览打红：它是"锦上添花"的那块
    const [d, f] = await Promise.all([
      api.dashboard(),
      api.funnel().catch(() => null),
    ])
    summary.value = d
    funnel.value = f
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/**
 * 「下一步该做什么」——按紧急程度排，最多给 3 条。
 *
 * 排序逻辑：平台已经抛球过来但没回话 > 结构性缺失（没简历/没画像）> 长期改进项。
 * 结构性缺失排在后面是因为它不紧急，但也不能不提示 —— 没有简历时
 * 匹配打分和 AI 定制全都用不了，而界面上不会报错，只会静默降级。
 */
const actions = computed(() => {
  const s = summary.value
  if (!s) return []
  const list = []

  if (s.applications.needActionCount > 0) {
    list.push({
      tone: 'warn',
      title: `${s.applications.needActionCount} 家 HR 发消息了，等你回`,
      desc: '聊天框里有对方发来的消息，你还没回。简历被查看、状态进初筛都不算 —— 那些没有消息等着你。',
      to: '/applications',
      cta: '去回',
    })
  }

  if (!s.counts.resumes) {
    list.push({
      tone: 'danger',
      title: '还没有简历',
      desc: '简历库是匹配打分和「AI 定制话术」的输入源，空着这两项都用不了。',
      to: '/resumes',
      cta: '去建简历',
    })
  }

  if (!s.counts.profileFilled) {
    list.push({
      tone: 'info',
      title: '候选人画像未填',
      desc: '身份、薪资底线、目标岗位都在这里，是 AI 不瞎编的事实来源。',
      to: '/profile',
      cta: '去填写',
    })
  }

  if (!s.counts.applications) {
    list.push({
      tone: 'info',
      title: '还没有投递记录',
      desc: '用浏览器扩展在实习僧 / BOSS 投递后，点「同步投递进度」把结果抓回来。',
      to: '/applications',
      cta: '看投递追踪',
    })
  }

  // 面试练过但分不高：这时该复盘错题，而不是继续刷场次
  if (s.counts.records && s.interview.avgScore && s.interview.avgScore < 60) {
    list.push({
      tone: 'warn',
      title: `模拟面试平均 ${s.interview.avgScore} 分，先复盘再练`,
      desc: '低分集中在同一类问题上时，继续加场次不如先把错题过一遍。',
      to: '/interview-prep?tab=mistakes',
      cta: '看错题本',
    })
  }

  if (!list.length) {
    list.push({
      tone: 'ok',
      title: '当前没有待处理的事',
      desc: '投递都在等对方动作。可以去「投递漏斗」看看转化率，或者练一场模拟面试。',
      to: '/funnel',
      cta: '看漏斗',
    })
  }
  return list.slice(0, 3)
})

// 漏斗缩略：口径是「到达过」（与漏斗页一致），不是「此刻停在这」
const miniFunnel = computed(() => {
  const reached = funnel.value?.overall?.reached
  if (!reached) return []
  const base = reached.submitted || 0
  return FUNNEL_LAYERS.map((k) => ({
    key: k,
    label: STAGE_LABELS[k] || k,
    n: reached[k] || 0,
    pct: base ? Math.round(((reached[k] || 0) / base) * 100) : 0,
  }))
})

const funnelTotal = computed(() => funnel.value?.overall?.total || 0)

function stagePct(key) {
  const byStage = summary.value?.applications?.byStage || {}
  const total = Object.values(byStage).reduce((a, b) => a + b, 0)
  if (!total) return 0
  return Math.round(((byStage[key] || 0) / total) * 100)
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function scoreClass(s) {
  if (s >= 80) return 'high'
  if (s >= 60) return 'mid'
  return 'low'
}

onMounted(load)
</script>

<template>
  <div class="dash">
    <div class="page-head">
      <div>
        <h1 class="page-title">求职总览</h1>
        <div class="page-sub">投了多少、走到哪、下一步该动哪一件</div>
      </div>
      <button class="btn btn-outline btn-sm" @click="load">刷新</button>
    </div>

    <div v-if="loading" class="card"><div class="muted">加载中…</div></div>
    <div v-else-if="error" class="card"><div class="msg msg-error">{{ error }}</div></div>

    <template v-else>
      <!-- ===== 下一步（整页最该看的一块，放最上面） ===== -->
      <section class="next">
        <div class="next-head">
          <span class="next-kicker">下一步</span>
          <span class="next-hint">按紧急程度排的，最多 3 条</span>
        </div>
        <div class="next-list">
          <router-link
            v-for="(a, i) in actions"
            :key="i"
            :to="a.to"
            class="next-item"
            :class="`tone-${a.tone}`"
          >
            <span class="next-mark"></span>
            <span class="next-body">
              <b>{{ a.title }}</b>
              <small>{{ a.desc }}</small>
            </span>
            <span class="next-cta">{{ a.cta }} →</span>
          </router-link>
        </div>
      </section>

      <!-- ===== 关键数字 ===== -->
      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">累计投递</div>
          <div class="kpi-num">{{ summary.counts.applications }}</div>
          <div class="kpi-sub">进行中 {{ summary.applications.activeCount }} 个</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">待我回复</div>
          <div class="kpi-num" :class="{ hot: summary.applications.needActionCount > 0 }">
            {{ summary.applications.needActionCount }}
          </div>
          <div class="kpi-sub">平台已推进、我没回话</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">面试均分</div>
          <div class="kpi-num">{{ summary.interview.avgScore || '—' }}</div>
          <div class="kpi-sub">{{ summary.counts.records }} 场模拟 · 最近 {{ summary.interview.latestScore || '—' }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">简历 / 错题</div>
          <div class="kpi-num">{{ summary.counts.resumes }}<span class="kpi-sep">/</span>{{ summary.interview.wrongCount }}</div>
          <div class="kpi-sub">{{ summary.counts.profileFilled ? '画像已填' : '画像未填' }}</div>
        </div>
      </div>

      <!-- ===== 漏斗缩略 + 面试表现 ===== -->
      <div class="two-col">
        <div class="card">
          <div class="card-head">
            <div class="card-title">漏斗缩略</div>
            <router-link to="/funnel" class="card-more">看转化率与分组 →</router-link>
          </div>

          <div v-if="!funnelTotal" class="empty">
            还没有可统计的投递。漏斗只算平台确认过的记录，草稿不进分母。
          </div>
          <template v-else>
            <div class="mini">
              <div v-for="b in miniFunnel" :key="b.key" class="mini-row">
                <span class="mini-label">{{ b.label }}</span>
                <span class="mini-track"><i :style="{ width: Math.max(b.pct, b.n ? 2 : 0) + '%' }"></i></span>
                <b class="mini-num">{{ b.n }}</b>
              </div>
            </div>
            <p class="hint-line">
              层数是<b>到达过</b>，不是此刻停在这 —— 已经判不合格的记录仍计入它走过的层。
            </p>
          </template>

          <div class="card-title" style="margin-top: 22px">当前分布</div>
          <div v-if="!summary.counts.applications" class="empty">暂无记录</div>
          <div v-else class="dist">
            <div v-for="(v, k) in summary.applications.byStage" :key="k" v-show="v" class="dist-item">
              <span class="badge" :class="`stage-${k}`">{{ STAGE_LABELS[k] }}</span>
              <b>{{ v }}</b>
              <span class="dist-pct">{{ stagePct(k) }}%</span>
            </div>
          </div>

          <div class="card-title" style="margin-top: 22px">投递结果</div>
          <div class="result-row">
            <span v-for="r in RESULTS" :key="r" class="badge" :class="RESULT_CLASS[r]">
              {{ r }} {{ summary.applications.byResult[r] }}
            </span>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div class="card-title">面试表现</div>
            <router-link to="/records" class="card-more">全部记录 →</router-link>
          </div>
          <div v-if="!summary.counts.records" class="blank">
            <b>还没有面试记录</b>
            <p>模拟面试会记录每题得分，错题自动进错题本 —— 面到真公司之前至少先跑一场。</p>
            <router-link to="/interview" class="btn btn-ghost btn-sm">去练一场</router-link>
          </div>
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
              <router-link v-for="r in summary.interview.recent" :key="r.id" :to="`/records/${r.id}`" class="rec-item">
                <span class="rec-job">{{ r.job }}</span>
                <span class="muted">{{ fmtDate(r.createdAt) }}</span>
                <b :class="scoreClass(r.totalScore)">{{ r.totalScore ?? '—' }} 分</b>
              </router-link>
            </div>
          </template>

          <div v-if="summary.targets.length" class="targets">
            <div class="targets-label">目标岗位</div>
            <div class="tag-row">
              <span v-for="t in summary.targets" :key="t" class="tag">{{ t }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 最近投递 ===== -->
      <div class="card">
        <div class="card-head">
          <div class="card-title">最近投递</div>
          <router-link to="/applications" class="card-more">全部 {{ summary.counts.applications }} 条 →</router-link>
        </div>
        <div v-if="!summary.applications.recent.length" class="empty">暂无投递记录</div>
        <table v-else class="table">
          <thead>
            <tr><th>公司</th><th>岗位</th><th>平台进度</th><th>我的标记</th><th>结果</th><th>日期</th></tr>
          </thead>
          <tbody>
            <tr v-for="(a, i) in summary.applications.recent" :key="i">
              <td class="strong">{{ a.company }}</td>
              <td>{{ a.jobTitle }}</td>
              <td>
                <span v-if="a.stage" class="badge" :class="`stage-${a.stage}`">{{ STAGE_LABELS[a.stage] || a.stage }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted">{{ a.status }}</td>
              <td><span class="badge" :class="RESULT_CLASS[a.result] || 'res-pending'">{{ a.result || '待处理' }}</span></td>
              <td class="muted">{{ fmtDate(a.appliedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ===== 下一步 ===== */
.next {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: none;
  padding: 16px 18px 8px;
  margin-bottom: 16px;
}
.next-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.next-kicker {
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.1em;
  color: var(--primary);
  text-transform: uppercase;
}
.next-hint {
  font-size: 11.5px;
  color: var(--text-faint);
}
.next-list {
  display: grid;
  gap: 6px;
}
.next-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 4px;
  text-decoration: none;
  color: inherit;
  background: #fafafa;
  border: 1px solid transparent;
  transition: background 0.15s var(--ease), border-color 0.15s var(--ease);
  margin-bottom: 6px;
}
.next-item:hover {
  background: #f4f4f5;
  border-color: #d4d4d8;
}
.next-mark {
  width: 4px;
  align-self: stretch;
  min-height: 30px;
  border-radius: 3px;
  flex-shrink: 0;
  background: #cbd5e1;
}
.tone-warn .next-mark { background: #d97706; }
.tone-danger .next-mark { background: #ef4444; }
.tone-info .next-mark { background: #52525b; }
.tone-ok .next-mark { background: #22c55e; }

.next-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.next-body b {
  font-size: 13.5px;
  font-weight: 600;
}
.next-body small {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.55;
}
.next-cta {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--primary);
  white-space: nowrap;
  flex-shrink: 0;
}

/* ===== KPI ===== */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.kpi {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 15px 16px;
  box-shadow: none;
}
.kpi-label {
  font-size: 12px;
  color: var(--text-dim);
  font-weight: 500;
}
.kpi-num {
  font-size: 27px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.25;
  letter-spacing: -0.02em;
  margin-top: 2px;
}
.kpi-num.hot {
  color: #b45309;
}
.kpi-sep {
  color: var(--text-faint);
  font-weight: 400;
  margin: 0 2px;
}
.kpi-sub {
  font-size: 11.5px;
  color: var(--text-faint);
  margin-top: 2px;
}

/* ===== 双栏 ===== */
.two-col {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  gap: 16px;
}
.two-col > .card {
  margin-top: 0;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-head .card-title {
  margin-bottom: 14px;
}
.card-more {
  font-size: 12px;
  color: var(--primary);
  text-decoration: none;
  white-space: nowrap;
  margin-bottom: 14px;
}
.card-more:hover {
  text-decoration: underline;
}

/* ===== 漏斗缩略（刻意比漏斗页轻：只画条的相对长度，不算转化率） ===== */
.mini {
  display: grid;
  gap: 7px;
}
.mini-row {
  display: grid;
  grid-template-columns: 48px 1fr 30px;
  align-items: center;
  gap: 9px;
}
.mini-label {
  font-size: 12px;
  color: var(--text-dim);
  text-align: right;
}
.mini-track {
  height: 9px;
  background: #f1f1f3;
  border-radius: 99px;
  overflow: hidden;
}
.mini-track i {
  display: block;
  height: 100%;
  border-radius: 99px;
  background: var(--primary);
  transition: width 0.35s var(--ease);
}
.mini-num {
  font-size: 12.5px;
  text-align: right;
}

/* ===== 当前分布 ===== */
.dist {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 空态：光一行小字加上被 grid 拉高的卡片，会留出半屏空白。
   给出「这里本该有什么」+ 一个直接入口，卡片才有存在感。 */
/* 空状态：不用虚线框。虚线在直角风格里读起来像「这里还没做好」，
   而它其实是个正常的空状态 —— 换成浅灰底，安静一点 */
.blank {
  border: none;
  border-radius: 3px;
  padding: 30px 20px;
  text-align: center;
  background: #fafafa;
}
.blank b {
  font-size: 13.5px;
  color: var(--text);
  display: block;
  margin-bottom: 6px;
}
.blank p {
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.65;
  max-width: 40ch;
  margin: 0 auto 12px;
}
.dist-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #fafafa;
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 4px 9px 4px 4px;
  font-size: 12px;
}
.dist-item b {
  font-size: 12.5px;
}
.dist-pct {
  color: var(--text-faint);
  font-size: 11px;
}

.result-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.res-pending { background: #f3f4f6; color: #6b7280; }
.res-submitted { background: #f0fdf4; color: #15803d; }
.res-skipped { background: #eff6ff; color: #1d4ed8; }
.res-blocked { background: #fef2f2; color: #b91c1c; }
.res-needs-user { background: #fef4e6; color: #b45309; }

/* ===== 面试 ===== */
.score-row {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.score-box {
  flex: 1;
  text-align: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px 8px;
  background: #fafafa;
}
.score-num {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.score-label {
  font-size: 11.5px;
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
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid #f1f2f6;
  text-decoration: none;
  color: inherit;
}
.rec-item:last-child {
  border-bottom: none;
}
.rec-item:hover .rec-job {
  color: var(--primary);
}
.rec-job {
  font-weight: 500;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.targets {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.targets-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-faint);
  margin-bottom: 7px;
  letter-spacing: 0.04em;
}
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

@media (max-width: 1080px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 900px) {
  .kpi-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 600px) {
  .next-item {
    flex-wrap: wrap;
  }
  .next-cta {
    margin-left: 16px;
  }
}
</style>
