<template>
  <div>
    <div class="card">
      <div class="card-title">错题本</div>
      <p class="tip">自动收集面试中得分低于 70 分的题目，可单独重新练习；重练达到 70 分即标记「已掌握」。</p>
    </div>

    <div v-if="loading" class="card loading">加载中…</div>
    <div v-else-if="!records.length" class="card">
      <div class="empty">还没有面试记录，先去完成一场模拟面试吧。</div>
    </div>
    <div v-else-if="!mistakes.length" class="card">
      <div class="empty">太棒了，目前没有错题（所有题目得分均 ≥ 70）。</div>
    </div>

    <div v-for="m in visibleMistakes" :key="m.key" class="card mistake-card" :class="{ mastered: m.mastered }">
      <div class="m-head">
        <div class="m-meta">
          <span class="tag">{{ m.job }}</span>
          <span class="time">{{ m.time }}</span>
          <b class="m-score" :class="m.newScore != null ? (m.newScore >= 70 ? 'high' : 'low') : 'low'">
            {{ m.newScore != null ? `重练 ${m.newScore} 分` : `原 ${m.score} 分` }}
          </b>
          <span v-if="m.mastered" class="mastered-tag">已掌握</span>
        </div>
      </div>
      <p class="m-question">{{ m.q }}</p>
      <p v-if="m.answer" class="m-answer">当时的回答：{{ m.answer }}</p>
      <p class="m-comment">{{ m.comment }}</p>

      <!-- 重练 -->
      <div v-if="m.practicing" class="re-answer">
        <textarea v-model="m.draft" rows="3" placeholder="重新回答这道题…"></textarea>
        <div class="re-actions">
          <button class="btn btn-ghost btn-sm" @click="m.practicing = false">取消</button>
          <button class="btn btn-sm" :disabled="!m.draft.trim() || m.retrying" @click="retry(m)">
            {{ m.retrying ? '点评中…' : '提交重练' }}
          </button>
        </div>
        <div v-if="m.result">
          <div class="m-result">
            <b :class="m.result.score >= 70 ? 'high' : 'low'">本次得分 {{ m.result.score }}</b>
            <p>{{ m.result.comment }}</p>
          </div>
          <div v-if="m.result.referencePoints && m.result.referencePoints.length" class="ref-block">
            <button class="ref-toggle" @click="m.showRef = !m.showRef">
              {{ m.showRef ? '收起参考要点' : '查看参考要点' }}
            </button>
            <ul v-if="m.showRef" class="ref-list">
              <li v-for="(p, j) in m.result.referencePoints" :key="j">{{ p }}</li>
            </ul>
          </div>
        </div>
        <div v-if="m.error" class="error-tip">{{ m.error }}</div>
      </div>
      <div v-else class="m-actions">
        <button v-if="!m.mastered" class="btn btn-ghost btn-sm" @click="m.practicing = true">重新练习</button>
        <button v-else class="btn btn-ghost btn-sm" @click="unmaster(m)">取消掌握标记</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { appState } from '../store.js'

const records = ref([])
const loading = ref(true)
const MASTER_KEY = 'mistakes_mastered'

let masteredSet = new Set()
try {
  masteredSet = new Set(JSON.parse(localStorage.getItem(MASTER_KEY) || '[]'))
} catch {
  masteredSet = new Set()
}

function saveMastered() {
  try {
    localStorage.setItem(MASTER_KEY, JSON.stringify([...masteredSet]))
  } catch {
    /* ignore */
  }
}

const mistakes = computed(() => {
  const list = []
  for (const r of records.value) {
    const per = r.report?.perQuestion || []
    per.forEach((q, idx) => {
      // 9.5：新记录有 wrong 标记；旧记录按 score < 70 兜底
      const isWrong = q.wrong === true || (q.wrong === undefined && Number(q.score) < 70)
      if (!isWrong) return
      const key = `${r.id}:${idx}`
      list.push(
        reactive({
          key,
          recordId: r.id,
          job: r.job,
          time: formatTime(r.createdAt),
          q: String(q.q || ''),
          answer: String(q.answer || ''),
          score: Number(q.score) || 0,
          comment: String(q.comment || ''),
          mastered: masteredSet.has(key),
          practicing: false,
          draft: '',
          retrying: false,
          result: null,
          newScore: null,
          showRef: false,
          error: '',
        })
      )
    })
  }
  return list
})

// 已掌握的排到后面并置灰
const visibleMistakes = computed(() =>
  [...mistakes.value].sort((a, b) => Number(a.mastered) - Number(b.mastered))
)

function formatTime(iso) {
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function retry(m) {
  const text = m.draft.trim()
  if (!text || m.retrying) return
  m.retrying = true
  m.error = ''
  try {
    const res = await fetch('/api/interview/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: [{ role: 'assistant', content: m.q }],
        answer: text,
        resume: appState.resume,
        job: m.job,
        total: 1,
        difficulty: 'medium',
        current: 1,
        followUpUsed: true, // 重练不追问，一轮出结果
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '处理失败')
    const score = Number.isFinite(Number(data.score)) ? Math.round(Number(data.score)) : null
    m.result = { score, comment: data.comment || '', referencePoints: data.referencePoints || [] }
    m.newScore = score
    if (score != null && score >= 70) {
      m.mastered = true
      masteredSet.add(m.key)
      saveMastered()
    }
  } catch (e) {
    m.error = e.message || '网络错误，请稍后重试'
  } finally {
    m.retrying = false
  }
}

function unmaster(m) {
  m.mastered = false
  masteredSet.delete(m.key)
  saveMastered()
}

onMounted(async () => {
  try {
    const res = await fetch('/api/records')
    records.value = await res.json()
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.tip {
  color: var(--text-secondary);
  font-size: 13px;
}
.empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 32px 0;
}
.mistake-card.mastered {
  opacity: 0.6;
}
.m-head {
  margin-bottom: 8px;
}
.m-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.time {
  font-size: 13px;
  color: var(--text-secondary);
}
.m-score.low {
  color: var(--danger);
}
.m-score.high {
  color: var(--success);
}
.mastered-tag {
  font-size: 12px;
  background: #e8f7ee;
  color: var(--success);
  border-radius: 4px;
  padding: 2px 8px;
}
.m-question {
  font-weight: 600;
  margin-bottom: 6px;
}
.m-answer {
  font-size: 13px;
  color: var(--text-secondary);
  background: #fafbfc;
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 6px;
}
.m-comment {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}
.re-answer textarea {
  margin-bottom: 8px;
}
.re-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 10px;
}
.m-result {
  background: #fafbfc;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 6px;
}
.m-result b.high {
  color: var(--success);
}
.m-result b.low {
  color: var(--danger);
}
.m-result p {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}
.ref-toggle {
  background: none;
  border: none;
  color: var(--primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}
.ref-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  display: grid;
  gap: 4px;
}
.m-actions {
  display: flex;
  justify-content: flex-end;
}
.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}
</style>
