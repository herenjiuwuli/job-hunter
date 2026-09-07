<template>
  <div>
    <!-- 顶部进度 -->
    <div class="card head-card">
      <div class="head-info">
        <div class="head-tags">
          <span class="tag">{{ job }}</span>
          <span class="tag tag-type">{{ typeLabel }}</span>
          <span class="tag tag-diff" :class="'diff-' + difficulty">{{ diffLabel }}</span>
        </div>
        <span class="progress-text">{{ finished ? '面试已结束' : `第 ${current} / ${total} 题` }}</span>
      </div>
      <div class="bar">
        <i :style="{ width: progressPercent + '%' }"></i>
      </div>
    </div>

    <div v-if="starting" class="card loading">面试官正在准备问题，请稍候…</div>

    <div v-else-if="startError" class="card">
      <div class="error-tip">{{ startError }}</div>
      <button class="btn btn-ghost" @click="backHome">返回首页</button>
    </div>

    <template v-else>
      <!-- 对话区 -->
      <div class="card chat-card">
        <div ref="chatBox" class="chat-list">
          <div
            v-for="(msg, i) in messages"
            :key="i"
            class="bubble-row"
            :class="msg.role === 'user' ? 'mine' : 'ai'"
          >
            <div class="bubble" :class="msg.kind">
              <template v-if="msg.kind === 'comment'">
                <span class="bubble-head">
                  <span class="bubble-tag">面试官点评</span>
                  <span v-if="msg.score != null" class="score-badge" :class="scoreLevel(msg.score)">
                    本题得分 {{ msg.score }}
                  </span>
                </span>
                {{ msg.content }}
                <div v-if="msg.refPoints && msg.refPoints.length" class="ref-block">
                  <button class="ref-toggle" @click="msg.showRef = !msg.showRef">
                    {{ msg.showRef ? '收起参考要点' : '查看参考要点' }}
                  </button>
                  <span class="ref-hint">答完再看，先自己想想</span>
                  <ul v-if="msg.showRef" class="ref-list">
                    <li v-for="(p, j) in msg.refPoints" :key="j">{{ p }}</li>
                  </ul>
                </div>
                <div v-if="msg.polish" class="ref-block">
                  <button class="ref-toggle" @click="msg.showPolish = !msg.showPolish">
                    {{ msg.showPolish ? '收起润色版本' : '查看润色版本' }}
                  </button>
                  <p v-if="msg.showPolish" class="polish-text">{{ msg.polish }}</p>
                </div>
              </template>
              <template v-else>
                <span v-if="msg.kind === 'question' && msg.followUp" class="followup-tag">追问</span>
                {{ msg.content }}
                <div v-if="msg.kind === 'answer' && msg.secs != null" class="time-meta">
                  <span class="time-tag">本题用时 {{ msg.secs }}s</span>
                  <span v-if="msg.timeTip" class="time-tip">{{ msg.timeTip }}</span>
                </div>
              </template>
            </div>
          </div>
          <div v-if="thinking" class="bubble-row ai">
            <div class="bubble">面试官正在思考…</div>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="card input-card">
        <div v-if="finished" class="finish-area">
          <p>面试结束，你可以查看本次面试报告。</p>
          <button class="btn" @click="viewReport">查看报告</button>
        </div>
        <template v-else>
          <textarea
            v-model="answer"
            rows="4"
            :disabled="thinking"
            placeholder="输入你的回答，尽量结合具体经历和细节…（Enter 发送，Shift + Enter 换行）"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <div class="input-actions">
            <span class="timer-hint" v-if="!finished && elapsed > 0">已用 {{ elapsed }}s</span>
            <button class="btn btn-ghost" @click="backHome">退出面试</button>
            <button class="btn" :disabled="thinking || !answer.trim()" @click="send">
              {{ thinking ? '点评中…' : '发送回答' }}
            </button>
          </div>
        </template>
        <div v-if="error" class="error-tip">{{ error }}</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { appState } from '../store.js'

const router = useRouter()

const LS_KEY = 'interview_progress'

const starting = ref(true)
const startError = ref('')
const thinking = ref(false)
const finished = ref(false)
const error = ref('')

const job = ref('')
const total = ref(5)
const current = ref(1)
const difficulty = ref(appState.difficulty || 'medium')
const interviewerType = ref(appState.interviewerType || 'tech')

// 展示用的消息列表（含点评/问题/回答）
const messages = ref([])
// 发给后端的对话历史（role: user/assistant，保持面试官身份连续性）
const history = ref([])
// 当前题是否已追问过（同一道题最多追问 1 次）
const followUpUsed = ref(false)

const answer = ref('')
const chatBox = ref(null)

// 9.8 回答耗时统计（纯前端）
const elapsed = ref(0) // 当前题实时用时
const durations = ref([]) // 每题累计用时 [{ q, seconds, tip }]，报告页展示
let timerId = null
let qStartAt = 0
let qAccum = 0 // 当前题累计毫秒（含追问前的用时）

const diffLabel = computed(
  () => ({ easy: '简单', medium: '中等', hard: '困难' })[difficulty.value] || '中等'
)

const typeLabel = computed(
  () => ({ tech: '技术面', hr: 'HR面', star: '行为面' })[interviewerType.value] || '技术面'
)

const progressPercent = computed(() => {
  if (finished.value) return 100
  return Math.round(((current.value - 1) / total.value) * 100)
})

function scoreLevel(score) {
  if (score >= 85) return 'score-g'
  if (score >= 60) return 'score-b'
  return 'score-o'
}

function startTimer() {
  stopTimer()
  qStartAt = Date.now()
  elapsed.value = 0
  timerId = setInterval(() => {
    elapsed.value = Math.round((Date.now() - qStartAt) / 1000)
  }, 1000)
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId)
    timerId = null
  }
}

function timeTip(seconds) {
  if (seconds < 15) return '回答偏短，可以更展开'
  if (seconds > 180) return '思考过久，面试中注意节奏'
  return ''
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight
  })
}

// 面试进度本地保存（8.3 刷新恢复）
function saveProgress() {
  if (finished.value) return
  try {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        resume: appState.resume,
        job: appState.selectedJob || job.value,
        jd: appState.selectedJobJd,
        difficulty: difficulty.value,
        interviewerType: interviewerType.value,
        total: total.value,
        current: current.value,
        followUpUsed: followUpUsed.value,
        history: history.value,
        messages: messages.value,
        durations: durations.value,
        qAccum,
      })
    )
  } catch {
    /* 存储不可用时忽略 */
  }
}

function clearProgress() {
  try {
    localStorage.removeItem(LS_KEY)
  } catch {
    /* ignore */
  }
}

function restoreProgress(saved) {
  appState.resume = saved.resume
  appState.selectedJob = saved.job
  appState.selectedJobJd = saved.jd || ''
  appState.difficulty = saved.difficulty || 'medium'
  appState.interviewerType = saved.interviewerType || 'tech'
  appState.interviewTotal = saved.total
  job.value = saved.job
  difficulty.value = saved.difficulty || 'medium'
  interviewerType.value = saved.interviewerType || 'tech'
  total.value = saved.total
  current.value = saved.current
  followUpUsed.value = saved.followUpUsed
  history.value = saved.history || []
  messages.value = (saved.messages || []).map((m) => ({ ...m }))
  durations.value = saved.durations || []
  qAccum = Number(saved.qAccum) || 0
  starting.value = false
  // 恢复后继续当前题计时
  startTimer()
  scrollToBottom()
}

async function startInterview() {
  starting.value = true
  startError.value = ''
  try {
    const res = await fetch('/api/interview/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resume: appState.resume,
        job: appState.selectedJob,
        jd: appState.selectedJobJd,
        questions: appState.questionCount,
        difficulty: difficulty.value,
        interviewerType: interviewerType.value,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '面试启动失败')
    job.value = data.job
    total.value = data.total
    current.value = 1
    followUpUsed.value = false
    difficulty.value = data.difficulty || difficulty.value
    appState.interviewTotal = data.total
    messages.value = [{ role: 'assistant', kind: 'question', content: data.firstQuestion }]
    history.value = [{ role: 'assistant', content: data.firstQuestion }]
    // 9.8 第一题开始计时
    durations.value = []
    qAccum = 0
    startTimer()
    saveProgress()
  } catch (e) {
    startError.value = e.message || '网络错误，请稍后重试'
  } finally {
    starting.value = false
  }
}

async function send() {
  const text = answer.value.trim()
  if (!text || thinking.value || finished.value) return

  error.value = ''
  answer.value = ''
  // 9.8 记录本次回答用时
  const now = Date.now()
  const secs = qStartAt ? Math.round((now - qStartAt) / 1000) : null
  qAccum += now - qStartAt
  stopTimer()
  const tip = secs != null ? timeTip(secs) : ''
  messages.value.push({ role: 'user', kind: 'answer', content: text, secs, timeTip: tip })
  history.value.push({ role: 'user', content: text })
  scrollToBottom()

  thinking.value = true
  try {
    const res = await fetch('/api/interview/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: history.value,
        answer: text,
        resume: appState.resume,
        job: appState.selectedJob,
        jd: appState.selectedJobJd,
        total: total.value,
        difficulty: difficulty.value,
        interviewerType: interviewerType.value,
        current: current.value,
        followUpUsed: followUpUsed.value,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '处理失败')

    messages.value.push({
      role: 'assistant',
      kind: 'comment',
      content: data.comment,
      score: data.score,
      refPoints: data.referencePoints || [],
      polish: data.polish || '',
      showRef: false,
      showPolish: false,
    })
    history.value.push({ role: 'assistant', content: data.comment })

    if (data.isFollowUp) {
      // 追问：不计入题数，同一道题最多追问一次；继续本题计时
      followUpUsed.value = true
      qStartAt = Date.now()
      elapsed.value = 0
      timerId = setInterval(() => {
        elapsed.value = Math.round((Date.now() - qStartAt) / 1000)
      }, 1000)
      messages.value.push({ role: 'assistant', kind: 'question', content: data.nextQuestion, followUp: true })
      history.value.push({ role: 'assistant', content: data.nextQuestion })
    } else if (data.isLast) {
      finished.value = true
      clearProgress()
      // 本题计时收尾
      const totalSecs = Math.round(qAccum / 1000)
      durations.value.push({ q: currentQuestionText(), seconds: totalSecs, tip: timeTip(totalSecs) })
      stopTimer()
      messages.value.push({
        role: 'assistant',
        kind: 'question',
        content: '以上就是全部问题，感谢你的参与！',
      })
    } else {
      // 本题结束：按题累计（含追问）写入 durations，开启下一题计时
      const totalSecs = Math.round(qAccum / 1000)
      durations.value.push({ q: currentQuestionText(), seconds: totalSecs, tip: timeTip(totalSecs) })
      qAccum = 0
      current.value += 1
      followUpUsed.value = false
      messages.value.push({ role: 'assistant', kind: 'question', content: data.nextQuestion })
      history.value.push({ role: 'assistant', content: data.nextQuestion })
      startTimer()
    }
    saveProgress()
    scrollToBottom()
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    thinking.value = false
    scrollToBottom()
  }
}

// 当前题的问题文本（durations 记录用）：最后一条 question 气泡
function currentQuestionText() {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m.role === 'assistant' && m.kind === 'question' && !m.content.includes('感谢你的参与')) {
      return m.content
    }
  }
  return ''
}

function backHome() {
  // 用户主动退出，视为放弃本次面试
  stopTimer()
  clearProgress()
  router.push('/home')
}

function viewReport() {
  appState.interviewHistory = history.value
  appState.interviewDurations = durations.value
  appState.report = null
  stopTimer()
  clearProgress()
  router.push('/report')
}

onMounted(() => {
  // 检测本地是否有未完成的面试进度
  let saved = null
  try {
    saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
  } catch {
    saved = null
  }
  if (saved && Array.isArray(saved.history) && saved.history.length) {
    if (confirm('检测到未完成面试，是否继续？')) {
      restoreProgress(saved)
      return
    }
    clearProgress()
  }

  if (!appState.resume || !appState.selectedJob) {
    startError.value = '请先在首页完成简历分析并选择岗位'
    starting.value = false
    return
  }
  startInterview()
})

onUnmounted(() => {
  stopTimer()
})
</script>

<style scoped>
.head-card {
  padding: 16px 20px;
}
.head-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
.head-tags {
  display: flex;
  gap: 8px;
}
.tag-diff {
  font-weight: 500;
}
.tag-type {
  font-weight: 500;
  background: #efeafd;
  color: #7c3aed;
}
.diff-easy {
  background: #e8f7ee;
  color: var(--success);
}
.diff-medium {
  background: #e8f1fd;
  color: #2563eb;
}
.diff-hard {
  background: #fef3e8;
  color: #d97706;
}
.progress-text {
  color: var(--text-secondary);
  font-size: 13px;
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
  background: var(--primary);
  border-radius: 4px;
  transition: width 0.3s;
}
.chat-card {
  padding: 0;
  overflow: hidden;
}
.chat-list {
  max-height: 55vh;
  min-height: 320px;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
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
  color: var(--text);
  border-top-left-radius: 4px;
}
.bubble-row.mine .bubble {
  background: var(--primary);
  color: #fff;
  border-top-right-radius: 4px;
}
.bubble.comment {
  background: #fff8ec;
  color: var(--text);
  border: 1px solid #f3e3c3;
}
.bubble-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 4px;
}
.bubble-tag {
  display: block;
  font-size: 12px;
  color: #c47d10;
}
.score-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.score-g {
  background: #e8f7ee;
  color: var(--success);
}
.score-b {
  background: #e8f1fd;
  color: #2563eb;
}
.score-o {
  background: #fef3e8;
  color: #d97706;
}
.followup-tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  color: #7c3aed;
  background: #f1e9fe;
  border-radius: 4px;
  padding: 1px 8px;
  margin-bottom: 6px;
  margin-right: 6px;
}
.ref-block {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #f3e3c3;
}
.ref-toggle {
  background: none;
  border: none;
  color: var(--primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}
.ref-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: 8px;
}
.ref-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  display: grid;
  gap: 4px;
}
.polish-text {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.7;
  background: #f6f2ff;
  border-radius: 8px;
  padding: 10px 12px;
  white-space: pre-wrap;
}
.input-card textarea {
  margin-bottom: 12px;
}
.input-actions {
  display: flex;
  justify-content: space-between;
}
.finish-area {
  text-align: center;
  padding: 16px 0;
}
.finish-area p {
  margin-bottom: 12px;
  color: var(--text-secondary);
}
.time-meta {
  margin-top: 6px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.time-tag {
  font-size: 12px;
  color: var(--text-secondary);
  opacity: 0.9;
}
.time-tip {
  font-size: 12px;
  color: #d97706;
}
.timer-hint {
  font-size: 13px;
  color: var(--text-secondary);
}
</style>
