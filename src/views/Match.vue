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

// 深度分析：按 applicationId 缓存结果 + 展开状态
const analysis = ref({}) // { [applicationId]: {...} }
const analyzingId = ref('')
const expandedId = ref('')

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

async function analyzeRow(r) {
  if (analyzingId.value) return
  analyzingId.value = r.id
  // 已分析过则直接展开/收起
  if (analysis.value[r.id]) {
    expandedId.value = expandedId.value === r.id ? '' : r.id
    analyzingId.value = ''
    return
  }
  try {
    analysis.value[r.id] = await api.matchAnalyze(resumeId.value, r.id)
    expandedId.value = r.id
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    analyzingId.value = ''
  }
}

function barColor(score) {
  if (score == null) return '#d1d5db'
  if (score >= 60) return '#16a34a'
  if (score >= 30) return '#f59e0b'
  return '#dc2626'
}

const STATUS_CLASS = {
  已匹配: 'st-ok',
  表达缺口: 'st-warn',
  证据不足: 'st-warn',
  真实缺口: 'st-bad',
  待确认: 'st-dim',
}
const GATE_CLASS = {
  已满足: 'st-ok',
  未满足: 'st-bad',
  待确认: 'st-dim',
}
const ADVICE_CLASS = {
  建议投递: 'st-ok',
  补充材料后投递: 'st-warn',
  谨慎投递: 'st-warn',
  暂不建议投递: 'st-bad',
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">匹配排序</h1>
        <div class="page-sub">快速打分用关键词覆盖度粗排；点「深度分析」用证据矩阵判断是否真值得投</div>
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
            <th style="width: 200px;">快速分</th>
            <th>命中关键词</th>
            <th style="width: 96px;">操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="(r, i) in results" :key="r.id">
            <tr>
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
              <td>
                <button class="btn btn-sm btn-outline" :disabled="analyzingId === r.id" @click="analyzeRow(r)">
                  {{ analyzingId === r.id ? '分析中…' : (analysis[r.id] && expandedId === r.id ? '收起' : '深度分析') }}
                </button>
              </td>
            </tr>
            <tr v-if="analysis[r.id] && expandedId === r.id">
              <td colspan="7" class="analysis-cell">
                <div class="analysis">
                  <div class="analysis-head">
                    <span class="tag" :class="ADVICE_CLASS[analysis[r.id].strategy.advice]">{{ analysis[r.id].strategy.advice }}</span>
                    <span class="analysis-conclusion">{{ analysis[r.id].conclusion }}</span>
                  </div>

                  <template v-if="analysis[r.id].hardGates.length">
                    <div class="block-title">硬性门槛</div>
                    <div class="gate-row" v-for="(g, gi) in analysis[r.id].hardGates" :key="'g' + gi">
                      <span class="tag" :class="GATE_CLASS[g.status]">{{ g.status }}</span>
                      <span class="gate-req">{{ g.requirement }}</span>
                      <span class="gate-note muted">{{ g.note }}</span>
                    </div>
                  </template>

                  <div class="block-title">要求—证据矩阵</div>
                  <table class="matrix">
                    <thead>
                      <tr>
                        <th>要求</th>
                        <th style="width: 56px;">重要度</th>
                        <th>简历证据</th>
                        <th style="width: 72px;">状态</th>
                        <th>风险 / 追问</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(m, mi) in analysis[r.id].matrix" :key="'m' + mi">
                        <td>{{ m.requirement }}</td>
                        <td><span class="imp" :class="'imp-' + m.importance">{{ m.importance }}</span></td>
                        <td class="evidence">{{ m.evidence }}</td>
                        <td><span class="tag" :class="STATUS_CLASS[m.status]">{{ m.status }}</span></td>
                        <td class="evidence">{{ m.risk }}</td>
                      </tr>
                    </tbody>
                  </table>

                  <template v-if="analysis[r.id].priorityFix.length">
                    <div class="block-title">优先补强（≤5）</div>
                    <ul class="fix-list">
                      <li v-for="(f, fi) in analysis[r.id].priorityFix" :key="'f' + fi">
                        <span class="tag tag-warning">{{ f.type }}</span> {{ f.action }}
                      </li>
                    </ul>
                  </template>

                  <template v-if="analysis[r.id].strategy.resumeVersion || analysis[r.id].strategy.questions.length">
                    <div class="block-title">投递策略</div>
                    <div class="strategy" v-if="analysis[r.id].strategy.resumeVersion">
                      建议简历版本：{{ analysis[r.id].strategy.resumeVersion }}
                    </div>
                    <ul class="fix-list" v-if="analysis[r.id].strategy.questions.length">
                      <li v-for="(q, qi) in analysis[r.id].strategy.questions" :key="'q' + qi">{{ q }}</li>
                    </ul>
                  </template>
                </div>
              </td>
            </tr>
          </template>
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
.strong {
  font-weight: 600;
}

.score-bar {
  height: 8px;
  background: #f3f4f6;
  border-radius: 2px;
  overflow: hidden;
}
.score-fill {
  height: 100%;
  border-radius: 2px;
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
  border-radius: 2px;
}
.kw-hit {
  background: #eef2ff;
  color: #4f46e5;
}

/* 深度分析展开面板 */
.analysis-cell {
  background: var(--bg);
  padding: 0 !important;
}
.analysis {
  padding: 16px 18px;
}
.analysis-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.analysis-conclusion {
  font-weight: 600;
  font-size: 14px;
}
.block-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
  letter-spacing: 0.04em;
  margin: 14px 0 8px;
  text-transform: uppercase;
}
.gate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}
.gate-req {
  font-weight: 500;
}
.gate-note {
  font-size: 12px;
}
.matrix {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.matrix th,
.matrix td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.matrix th {
  color: var(--text-dim);
  font-weight: 600;
  background: #fff;
}
.matrix tr:nth-child(even) td {
  background: #fafafa;
}
.evidence {
  color: var(--text-secondary);
  line-height: 1.5;
}
.imp {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 2px;
  font-weight: 600;
}
.imp-硬性 { background: #fde8e8; color: #dc2626; }
.imp-核心 { background: #eef2ff; color: #4f46e5; }
.imp-加分 { background: #e8f7ef; color: #18a058; }
.fix-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.8;
}
.fix-list li {
  margin-bottom: 2px;
}
.strategy {
  font-size: 13px;
  margin-bottom: 6px;
}

/* 状态/建议标签配色 */
.st-ok { background: #e8f7ef; color: #18a058; }
.st-warn { background: #fef4e6; color: #c47d10; }
.st-bad { background: #fde8e8; color: #dc2626; }
.st-dim { background: #f3f4f6; color: #6b7280; }
</style>
