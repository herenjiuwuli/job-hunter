<template>
  <div>
    <div class="card">
      <div class="card-title">面试准备清单</div>
      <p class="tip">根据上方上下文里的简历与 JD，生成这家公司的面试前准备清单（技术复习 / 公司调研 / 材料准备 / 问题预演），按优先级排序可勾选。换公司就改上面的 JD 再点一次，勾选进度按清单独立保存。</p>
      <div class="toolbar">
        <button class="btn" :disabled="loading || !resume.trim() || !job" @click="generate">
          {{ loading ? '生成中…' : '生成准备清单' }}
        </button>
        <span v-if="!job.trim() || !resume.trim()" class="muted" style="margin-left: 10px; font-size: 12px">先在上面填好岗位和简历</span>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">教练正在整理清单，请稍候…</div>

    <template v-if="checklist && !loading">
      <div class="card">
        <div class="title-row">
          <div class="card-title">准备清单<span class="muted-tag">{{ doneCount }} / {{ checklist.items.length }} 已完成</span></div>
          <button class="btn btn-ghost btn-sm" @click="resetChecks">重置勾选</button>
        </div>
        <div class="progress-track"><div class="progress-fill" :style="{ width: progressPercent + '%' }"></div></div>
        <ul class="prep-list">
          <li
            v-for="(it, i) in checklist.items"
            :key="i"
            class="prep-item"
            :class="{ done: isChecked(i), low: it.priority === 'low' }"
          >
            <label class="prep-check">
              <input type="checkbox" :checked="isChecked(i)" @change="toggleCheck(i)" />
              <span class="box"></span>
            </label>
            <div class="prep-body">
              <p class="prep-title">{{ it.title }}</p>
              <div class="prep-meta">
                <span class="chip" :class="'type-' + typeClass(it.type)">{{ it.type }}</span>
                <span class="chip" :class="'pri-' + it.priority">
                  {{ { high: '必须', medium: '建议', low: '可选' }[it.priority] }}
                </span>
              </div>
            </div>
          </li>
        </ul>
      </div>
      <div class="card">
        <div class="card-title">通用提醒</div>
        <ul class="list">
          <li v-for="(t, i) in checklist.tips" :key="i">{{ t }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, toRefs } from 'vue'
import { prepCtx } from '../store.js'

// 岗位 / 简历 / JD 全部来自工作台共享上下文，本页没有自己的输入项
const { job, resume, jd } = toRefs(prepCtx)

const loading = ref(false)
const error = ref('')
const checklist = ref(null)

const CHECK_KEY = 'prep_checklist_done'
const CHECK_JOB_KEY = 'prep_checklist_job'

let doneSet = new Set()
try {
  doneSet = new Set(JSON.parse(localStorage.getItem(CHECK_KEY) || '[]'))
} catch {
  doneSet = new Set()
}

const doneCount = computed(() => (checklist.value ? checklist.value.items.filter((_, i) => doneSet.has(i)).length : 0))
const progressPercent = computed(() =>
  checklist.value && checklist.value.items.length ? Math.round((doneCount.value / checklist.value.items.length) * 100) : 0
)

function isChecked(i) {
  return doneSet.has(i)
}

function toggleCheck(i) {
  if (doneSet.has(i)) doneSet.delete(i)
  else doneSet.add(i)
  saveChecks()
}

function saveChecks() {
  try {
    localStorage.setItem(CHECK_KEY, JSON.stringify([...doneSet]))
    localStorage.setItem(CHECK_JOB_KEY, `${job.value}:${checklist.value?.items.length || 0}`)
  } catch {
    /* ignore */
  }
}

function resetChecks() {
  doneSet = new Set()
  saveChecks()
}

// 勾选状态跟随「岗位 + 条目数」，换清单后自动失效
function loadChecksIfSameJob() {
  let savedJob = ''
  try {
    savedJob = localStorage.getItem(CHECK_JOB_KEY) || ''
  } catch {
    savedJob = ''
  }
  if (savedJob !== `${job.value}:${checklist.value?.items.length || 0}`) {
    doneSet = new Set()
  }
}

function typeClass(t) {
  return ({ 技术复习: 'tech', 公司调研: 'company', 材料准备: 'material', 问题预演: 'qa' })[t] || 'qa'
}

async function generate() {
  loading.value = true
  error.value = ''
  checklist.value = null
  try {
    const res = await fetch('/api/prep/checklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume: resume.value.trim(), job: job.value, jd: jd.value.trim() }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '生成失败')
    checklist.value = data
    loadChecksIfSameJob()
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
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
.resume-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}
.resume-label textarea,
.form-row select {
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.title-row .card-title {
  margin-bottom: 0;
}
.muted-tag {
  font-size: 13px;
  color: var(--text-secondary);
  margin-left: 10px;
  font-weight: 400;
}
.progress-track {
  height: 8px;
  background: #eef1f4;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 14px;
}
.progress-fill {
  height: 100%;
  background: var(--success);
  border-radius: 4px;
  transition: width 0.3s;
}
.prep-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
}
.prep-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 12px;
}
.prep-item.done {
  background: #f6fbf7;
}
.prep-item.done .prep-title {
  text-decoration: line-through;
  color: var(--text-secondary);
}
.prep-item.low {
  opacity: 0.75;
}
.prep-check {
  position: relative;
  display: inline-flex;
  margin-top: 2px;
  cursor: pointer;
}
.prep-check input {
  position: absolute;
  opacity: 0;
  width: 18px;
  height: 18px;
  cursor: pointer;
}
.prep-check .box {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 3px;
  display: inline-block;
  background: #fff;
  transition: all 0.15s;
}
.prep-check input:checked + .box {
  background: var(--success);
  border-color: var(--success);
}
.prep-check input:checked + .box::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 1px;
  width: 5px;
  height: 10px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.prep-body {
  flex: 1;
}
.prep-title {
  font-size: 14px;
  margin-bottom: 6px;
}
.prep-meta {
  display: flex;
  gap: 8px;
}
.chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
}
.type-tech {
  background: #e8f0fe;
  color: #2563eb;
}
.type-company {
  background: #fef3e2;
  color: #c47d10;
}
.type-material {
  background: #f3eafd;
  color: #7c3aed;
}
.type-qa {
  background: #e8f7ee;
  color: #16a34a;
}
.pri-high {
  background: #fdecec;
  color: #dc2626;
}
.pri-medium {
  background: #fff8ec;
  color: #d97706;
}
.pri-low {
  background: #f1f3f5;
  color: #6b7280;
}
.list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
@media (max-width: 640px) {
  .form-row {
    flex-direction: column;
  }
}
</style>
