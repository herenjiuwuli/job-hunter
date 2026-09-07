<template>
  <div>
    <!-- 设置区 -->
    <div class="card">
      <div class="card-title">薪资谈判模拟</div>
      <p class="tip">AI 扮演 HR 与你进行一轮真实的薪资谈判（最多 6 轮），每轮点评你的回应策略，结束后给出复盘报告。谈判素材不会用于任何真实沟通。</p>
      <div class="form-row">
        <label>目标岗位
          <select v-model="job">
            <option v-for="j in allJobs" :key="j" :value="j">{{ j }}</option>
          </select>
        </label>
        <label>城市（可选）
          <input v-model="city" type="text" placeholder="如：上海" />
        </label>
        <label class="grow">期望薪资（可选）
          <input v-model="expectSalary" type="text" placeholder="如：15k-18k" />
        </label>
      </div>
      <label class="resume-label">简历内容
        <textarea v-model="resume" rows="5" placeholder="粘贴你的简历文本"></textarea>
      </label>
      <div class="toolbar">
        <button class="btn" :disabled="loading || !resume.trim() || !job" @click="start">
          {{ loading ? '准备中…' : '开始谈判' }}
        </button>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">HR 正在准备，请稍候…</div>

    <!-- 对话区 -->
    <template v-if="started && !loading">
      <div class="card">
        <div class="title-row">
          <div class="card-title">谈判对话<span class="muted-tag">第 {{ round }} / {{ maxRounds }} 轮</span></div>
          <button class="btn btn-ghost btn-sm" @click="backHome">退出</button>
        </div>
        <div ref="chatBox" class="chat-list">
          <div
            v-for="(msg, i) in messages"
            :key="i"
            class="bubble-row"
            :class="msg.role === 'user' ? 'mine' : 'ai'"
          >
            <div class="bubble" :class="msg.kind">
              <template v-if="msg.kind === 'comment'">
                <span class="bubble-tag">策略点评</span>
                {{ msg.content }}
              </template>
              <template v-else>{{ msg.content }}</template>
            </div>
          </div>
          <div v-if="thinking" class="bubble-row ai">
            <div class="bubble">HR 正在思考…</div>
          </div>
        </div>
      </div>

      <div class="card input-card">
        <div v-if="finished" class="finish-area">
          <p>谈判结束，查看你的复盘报告。</p>
          <button class="btn" :disabled="reportLoading" @click="loadReport">
            {{ reportLoading ? '生成中…' : '查看复盘报告' }}
          </button>
        </div>
        <template v-else>
          <textarea
            v-model="reply"
            rows="3"
            :disabled="thinking"
            placeholder="你的回应：报价、坚守、让步或反问福利…（Ctrl + Enter 发送）"
            @keydown.ctrl.enter.prevent="send"
          ></textarea>
          <div class="input-actions">
            <span class="hint">技巧：先让对方报价 / 谈总包不谈月薪 / 用市场行情支撑</span>
            <button class="btn" :disabled="thinking || !reply.trim()" @click="send">
              {{ thinking ? 'HR 回应中…' : '发送回应' }}
            </button>
          </div>
        </template>
        <div v-if="sendError" class="error-tip">{{ sendError }}</div>
      </div>
    </template>

    <!-- 复盘报告 -->
    <template v-if="report">
      <div class="card">
        <div class="card-title">谈判复盘</div>
        <div class="report-head">
          <b class="big-score" :class="report.totalScore >= 70 ? 'high' : report.totalScore >= 50 ? 'mid' : 'low'">
            {{ report.totalScore }}
          </b>
          <p class="report-comment">{{ report.comment }}</p>
        </div>
      </div>
      <div class="card">
        <div class="card-title">策略建议</div>
        <ul class="list">
          <li v-for="(s, i) in report.strategies" :key="i">{{ s }}</li>
        </ul>
      </div>
      <div class="card">
        <div class="card-title">话术建议</div>
        <ul class="list">
          <li v-for="(s, i) in report.scripts" :key="i">{{ s }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted } from 'vue'
import { appState } from '../store.js'

const allJobs = ['前端开发', '自动化测试', '后端开发', '产品运营', '数据分析']

const job = ref(appState.selectedJob || '前端开发')
const city = ref('')
const expectSalary = ref('')
const resume = ref(appState.resume || '')

const loading = ref(false)
const thinking = ref(false)
const finished = ref(false)
const reportLoading = ref(false)
const started = ref(false)
const error = ref('')
const sendError = ref('')

const maxRounds = ref(6)
const round = ref(1)
const messages = ref([])
const history = ref([])
const report = ref(null)
const reply = ref('')
const chatBox = ref(null)

onMounted(() => {
  if (!job.value || !allJobs.includes(job.value)) job.value = '前端开发'
})

function scrollToBottom() {
  nextTick(() => {
    if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight
  })
}

async function start() {
  loading.value = true
  error.value = ''
  report.value = null
  round.value = 1
  try {
    const res = await fetch('/api/salary/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resume: resume.value.trim(),
        job: job.value,
        city: city.value.trim(),
        expectSalary: expectSalary.value.trim(),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '启动失败')
    started.value = true
    maxRounds.value = data.maxRounds || 6
    messages.value = [{ role: 'assistant', kind: 'message', content: data.firstMessage }]
    history.value = [{ role: 'assistant', content: data.firstMessage }]
    scrollToBottom()
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
}

async function send() {
  const text = reply.value.trim()
  if (!text || thinking.value || finished.value) return

  sendError.value = ''
  reply.value = ''
  messages.value.push({ role: 'user', kind: 'message', content: text })
  history.value.push({ role: 'user', content: text })
  scrollToBottom()

  thinking.value = true
  try {
    const res = await fetch('/api/salary/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        history: history.value,
        answer: text,
        resume: resume.value.trim(),
        job: job.value,
        round: round.value,
        city: city.value.trim(),
        expectSalary: expectSalary.value.trim(),
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '处理失败')

    if (data.comment) {
      messages.value.push({ role: 'assistant', kind: 'comment', content: data.comment })
      history.value.push({ role: 'assistant', content: data.comment })
    }
    if (data.isLast) {
      finished.value = true
      if (data.nextMessage) {
        messages.value.push({ role: 'assistant', kind: 'message', content: data.nextMessage })
        history.value.push({ role: 'assistant', content: data.nextMessage })
      }
    } else {
      round.value += 1
      messages.value.push({ role: 'assistant', kind: 'message', content: data.nextMessage })
      history.value.push({ role: 'assistant', content: data.nextMessage })
    }
    scrollToBottom()
  } catch (e) {
    sendError.value = e.message || '网络错误，请稍后重试'
  } finally {
    thinking.value = false
    scrollToBottom()
  }
}

async function loadReport() {
  reportLoading.value = true
  try {
    const res = await fetch('/api/salary/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: history.value, job: job.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '生成失败')
    report.value = data
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    reportLoading.value = false
  }
}

function backHome() {
  started.value = false
  finished.value = false
  messages.value = []
  history.value = []
  round.value = 1
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
.form-row .grow {
  flex: 1;
}
.form-row select,
.form-row input,
.resume-label textarea {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.resume-label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
.toolbar {
  margin-top: 12px;
}
.title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
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
.chat-list {
  max-height: 45vh;
  min-height: 240px;
  overflow-y: auto;
  padding: 6px 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.bubble-tag {
  display: block;
  font-size: 12px;
  color: #c47d10;
  margin-bottom: 2px;
}
.input-card textarea {
  margin-bottom: 12px;
}
.input-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hint {
  font-size: 12px;
  color: var(--text-secondary);
}
.finish-area {
  text-align: center;
  padding: 12px 0;
}
.finish-area p {
  margin-bottom: 12px;
  color: var(--text-secondary);
}
.report-head {
  display: flex;
  align-items: center;
  gap: 16px;
}
.big-score {
  font-size: 40px;
  line-height: 1;
}
.big-score.high {
  color: var(--success);
}
.big-score.mid {
  color: var(--warning);
}
.big-score.low {
  color: var(--danger);
}
.report-comment {
  color: var(--text-secondary);
}
.list {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
}
@media (max-width: 640px) {
  .form-row {
    flex-direction: column;
  }
}
</style>
