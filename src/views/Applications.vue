<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { COMMON_JOBS } from '../jobs.js'
import { PLATFORMS } from '../options.js'
import { STAGES, STAGE_LABELS, STAGE_KEYS, stagePath, needsMyAction } from '../stages.js'
import { chatStepLabel, chatStepPath, hasChatProgress, chatStepEvidence } from '../chatSteps.js'

// status 是**人工标记**（我想不想去 / 是不是我主动放弃的），采集器从不写它。
// 平台真实进度在 stage 里 —— 所以列表主列是 stage，status 只在编辑弹窗里改。
const STATUSES = ['待投递', '已投递', '已沟通', '已面试', '已offer', '已拒绝', '已淘汰']
const RESULTS = ['待处理', '已确认提交', '跳过', '被拦截', '需用户']

const apps = ref([])
const resumes = ref([])
// '' = 全部；'__action' = 待我回复；其余是 stage key
const filterStage = ref('')
const keyword = ref('')
const showForm = ref(false)
const saving = ref(false)
const message = ref('')
const messageError = ref(false)
const tailoring = ref(false)
const matchPoints = ref([])
// 编辑时把平台进度**只读**地摆出来，否则用户会以为「状态」下拉就是进度
const editingStage = ref('')

const emptyForm = () => ({
  id: '',
  resumeId: '',
  company: '',
  jobTitle: '',
  platform: '实习僧',
  jd: '',
  greeting: '',
  status: '待投递',
  result: '待处理',
  note: '',
  appliedAt: '',
})

const form = reactive(emptyForm())
const isNew = computed(() => !form.id)

/**
 * 统计卡按**平台阶段**分档。
 * 之前按人工 status 分，而采集器只写 stage，于是 46 条全落在「已投递」——
 * 界面上看不到「3 条不合格、3 条被查看、1 条初筛」，这是「进度没同步」的直接原因。
 */
const stageCounts = computed(() => {
  const map = {}
  for (const k of STAGE_KEYS) map[k] = 0
  for (const a of apps.value) if (a.stage && map[a.stage] != null) map[a.stage]++
  return map
})

// 有来信 = 聊天框里对方最后发言、我还没回。
// 注意：**不是**「被查看 / 进初筛」—— 那些只是平台状态，没有消息等我回（2026-11-06 纠正）
const actionCount = computed(() => apps.value.filter((a) => needsMyAction(a)).length)

const filtered = computed(() => {
  return apps.value.filter((a) => {
    const f = filterStage.value
    if (f === '__action') {
      if (!needsMyAction(a)) return false
    } else if (f && a.stage !== f) {
      return false
    }
    if (keyword.value.trim()) {
      const k = keyword.value.trim().toLowerCase()
      const hit = (a.company || '').toLowerCase().includes(k) || (a.jobTitle || '').toLowerCase().includes(k)
      if (!hit) return false
    }
    return true
  })
})

/**
 * 到达轨迹只在「真的走过不止一步」时才显示。
 *
 * stagePath 在只有一层时返回的就是「已投递」——和左边那颗徽章一字不差，
 * 于是每条记录都多出一行灰字。62 条记录 = 62 行纯噪音，而它本该只用来
 * 表达「这条已经走过了几层」（比如「已投递 → 被查看 → 不合格」）。
 */
function hasReachedPath(a) {
  const h = Array.isArray(a.stageHistory) ? a.stageHistory : []
  const seq = []
  for (const it of h) {
    const k = it?.stage
    if (!k) continue
    if (seq[seq.length - 1] === k) continue
    seq.push(k)
  }
  return seq.length > 1
}

/** 人工标记只在「不是默认值」时显示，否则满屏「已投递」等于没有信息 */
function customStatus(a) {
  const s = a.status || ''
  return s && s !== '已投递' && s !== '待投递' ? s : ''
}

/**
 * BOSS 聊天推进那句话。
 *
 * 为什么单独一行而不是并进徽章：platform 徽章显示的是**平台**进度，
 * BOSS 那边永远是「已投递」。真实进展（要了微信 / 约了面试）只在聊天里 ——
 * 不单独说一句，用户看列表只会以为 90 条全在海里。
 * 最低档（已投递）不显示：它和左边那颗徽章一字不差，说出来是噪音。
 */
function chatStepLine(a) {
  if (!hasChatProgress(a)) return ''
  const path = chatStepPath(a)
  const cur = chatStepLabel(a.chatStep)
  if (!cur) return ''
  const route = path && path !== cur ? `：${path}` : `：${cur}`
  const ev = chatStepEvidence(a)
  return `BOSS 聊天推进${route}` + (ev ? ` · ${ev}` : '')
}

/**
 * 「不合格」如果是聊天内容判出来的，必须把依据那句话摆出来。
 *
 * 理由和「假待办比没有待办更坏」同源：**误判的拒绝比没有拒绝更坏**。
 * BOSS 不改平台状态，拒绝只发一句消息，所以这一层是机器读出来的结论 ——
 * 用户得能自己核对「系统凭什么说我不合格」，而不是只能信。
 */
function chatVerdictNote(a) {
  const h = Array.isArray(a.stageHistory) ? a.stageHistory : []
  for (let i = h.length - 1; i >= 0; i--) {
    const it = h[i]
    if (it && it.stage === 'rejected' && it.source === 'chat') {
      return it.raw ? `依据：对方说「${it.raw}」` : '依据：聊天里对方明确拒绝'
    }
  }
  return ''
}

// 公司名联想：从已有投递记录去重，越用越省事（仍可自由输入新公司）
const companyOptions = computed(() => {
  return [...new Set(apps.value.map((a) => a.company).filter(Boolean))]
})

function fmtDate(iso) {
  if (!iso) return '—'
  return new Date(iso).toISOString().slice(0, 10)
}

async function load() {
  ;[apps.value, resumes.value] = await Promise.all([api.applications.list(), api.resumes.list()])
}

function openNew() {
  Object.assign(form, emptyForm())
  editingStage.value = ''
  if (resumes.value.length) form.resumeId = resumes.value[0].id
  showForm.value = true
}

function openEdit(a) {
  editingStage.value = a.stage || ''
  Object.assign(form, {
    id: a.id,
    resumeId: a.resumeId,
    company: a.company,
    jobTitle: a.jobTitle,
    platform: a.platform,
    jd: a.jd,
    greeting: a.greeting,
    status: a.status,
    result: a.result || '待处理',
    note: a.note,
    appliedAt: a.appliedAt ? a.appliedAt.slice(0, 10) : '',
  })
  showForm.value = true
}

async function save() {
  if (!form.company.trim() || !form.jobTitle.trim()) {
    message.value = '公司名与岗位名不能为空'
    messageError.value = true
    return
  }
  saving.value = true
  message.value = ''
  try {
    const payload = { ...form, appliedAt: form.appliedAt || new Date().toISOString() }
    if (isNew.value) await api.applications.create(payload)
    else await api.applications.update(form.id, payload)
    showForm.value = false
    await load()
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    saving.value = false
  }
}

async function tailor() {
  if (!form.resumeId) {
    message.value = '请先在「关联简历」选择一份简历'
    messageError.value = true
    return
  }
  if (!form.jd.trim()) {
    message.value = '请先粘贴岗位 JD'
    messageError.value = true
    return
  }
  tailoring.value = true
  message.value = ''
  matchPoints.value = []
  try {
    const data = await api.tailor({
      resumeId: form.resumeId,
      jd: form.jd,
      company: form.company,
      jobTitle: form.jobTitle,
    })
    form.greeting = data.greeting
    form.coverLetter = data.coverLetter
    form.tailoredResume = data.tailoredResume
    matchPoints.value = data.matchPoints || []
    message.value = 'AI 定制完成，已填入下方，可直接编辑'
    messageError.value = false
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    tailoring.value = false
  }
}

async function remove(a) {
  if (!confirm(`确定删除「${a.company} · ${a.jobTitle}」这条投递记录？`)) return
  await api.applications.remove(a.id)
  await load()
}

function resumeTitle(id) {
  const r = resumes.value.find((x) => x.id === id)
  return r ? r.title : '未关联'
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">投递追踪</h1>
        <div class="page-sub">记录每一次投递，跟踪从「待投递」到「offer」的完整状态</div>
      </div>
      <button class="btn btn-primary" @click="openNew">+ 新建投递</button>
    </div>

    <!-- 按平台阶段分档：这是采集器真正写进去的进度。
         做成一行 chip 而不是 9 张卡片 —— 它本质是「筛选器」，不是「仪表盘」：
         9 个 90px 高的卡片占掉半屏首屏空间，只为了显示 9 个数字和一个点击区域。 -->
    <div class="filterbar">
      <div class="stats">
        <button type="button" class="stat-card" :class="{ active: !filterStage }" @click="filterStage = ''">
          <b>{{ apps.length }}</b><span>全部</span>
        </button>
        <button
          v-for="s in STAGES"
          :key="s.key"
          type="button"
          class="stat-card"
          :class="{ active: filterStage === s.key }"
          @click="filterStage = s.key"
        >
          <i class="dot" :class="`d-${s.key}`"></i>
          <b>{{ stageCounts[s.key] }}</b><span>{{ s.label }}</span>
        </button>
        <button
          v-if="actionCount"
          type="button"
          class="stat-card action"
          :class="{ active: filterStage === '__action' }"
          @click="filterStage = '__action'"
        >
          <b>{{ actionCount }}</b><span>有来信待回</span>
        </button>
      </div>
      <input v-model="keyword" class="input searchbox" placeholder="搜索公司 / 岗位…" />
    </div>

    <p class="hint-line">
      进度来自平台（实习僧七档 / BOSS 已读），只由扩展采集写入，网页上改不了；
      「新建 / 编辑」里的「状态」是<b>你自己的标记</b>，和平台进度是两回事。
    </p>

    <!-- 列表 -->
    <div class="card">
      <div v-if="!filtered.length" class="empty">暂无记录，点右上角「新建投递」开始</div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>平台进度</th>
            <th>公司</th>
            <th>岗位</th>
            <th>平台</th>
            <th>投递日期</th>
            <th>简历</th>
            <th class="col-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in filtered" :key="a.id">
            <td>
              <span v-if="a.stage" class="badge" :class="`stage-${a.stage}`">{{ STAGE_LABELS[a.stage] }}</span>
              <span v-else class="badge badge-pending">待投递</span>
              <!-- 我主动放弃 ≠ 被拒：HR 没拒我，是我不去了。单开一个标记，
                   不塞进 stage（塞进去「不合格」那层会凭空多一批，被拒率算高）。 -->
              <span v-if="a.withdrawnAt" class="badge badge-withdrawn" title="我在聊天里主动说不合适">我放弃</span>
              <!-- 到达轨迹：判了不合格的记录也曾经到过面试，只看当前态会把这段抹掉。
                   但只有一步时它就是上面徽章的重影，不必显示。 -->
              <div v-if="hasReachedPath(a)" class="stage-path">{{ stagePath(a) }}</div>
              <!-- 聊天判出来的「不合格」：把依据那句话放出来，用户能自己核对 -->
              <div v-if="chatVerdictNote(a)" class="verdict-note">{{ chatVerdictNote(a) }}</div>
              <!-- BOSS 的进度只能从聊天读（平台永远停在「已投递」）-->
              <div v-if="chatStepLine(a)" class="chat-step">{{ chatStepLine(a) }}</div>
              <div v-if="customStatus(a)" class="my-mark">我的标记：{{ customStatus(a) }}</div>
              <div v-if="a.result && a.result !== '待处理'" class="my-mark">
                投递结果：{{ a.result }}
              </div>
            </td>
            <td class="strong">{{ a.company }}</td>
            <td>{{ a.jobTitle }}</td>
            <td><span class="badge badge-pending">{{ a.platform }}</span></td>
            <td>{{ fmtDate(a.appliedAt) }}</td>
            <td class="muted">{{ resumeTitle(a.resumeId) }}</td>
            <td class="col-right row-actions">
              <button class="btn btn-outline btn-sm" @click="openEdit(a)">编辑</button>
              <button class="btn btn-danger btn-sm" @click="remove(a)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 表单弹窗 -->
    <div v-if="showForm" class="modal-mask" @click.self="showForm = false">
      <div class="modal">
        <div class="modal-head">
          <h2 class="modal-title">{{ isNew ? '新建投递' : '编辑投递' }}</h2>
          <button class="btn btn-outline" @click="showForm = false">关闭</button>
        </div>
        <div class="modal-body">
          <div class="grid-2">
            <div class="field">
              <label class="label">公司<span class="req">*</span></label>
              <input v-model="form.company" class="input" list="ap-company" placeholder="公司名" />
              <datalist id="ap-company">
                <option v-for="c in companyOptions" :key="c" :value="c" />
              </datalist>
            </div>
            <div class="field">
              <label class="label">岗位<span class="req">*</span></label>
              <input v-model="form.jobTitle" class="input" list="ap-job" placeholder="岗位名（任意岗位都可直接输入）" />
              <datalist id="ap-job">
                <option v-for="j in COMMON_JOBS" :key="j" :value="j" />
              </datalist>
            </div>
            <div class="field">
              <label class="label">平台</label>
              <select v-model="form.platform" class="select">
                <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
              </select>
            </div>
            <div class="field">
              <label class="label">我的标记</label>
              <select v-model="form.status" class="select">
                <option v-for="s in STATUSES" :key="s" :value="s">{{ s }}</option>
              </select>
              <div class="field-hint">你自己的想法（想不想去、是不是你放弃了）。它不改平台进度，采集也不会覆盖它</div>
            </div>
            <div v-if="editingStage" class="field">
              <label class="label">平台进度（只读）</label>
              <div>
                <span class="badge" :class="`stage-${editingStage}`">{{ STAGE_LABELS[editingStage] }}</span>
              </div>
              <div class="field-hint">由扩展从实习僧 / BOSS 采集，网页上改不了</div>
            </div>
            <div class="field">
              <label class="label">投递结果</label>
              <select v-model="form.result" class="select">
                <option v-for="r in RESULTS" :key="r" :value="r">{{ r }}</option>
              </select>
              <div class="field-hint">这次「投成没成」——与上面「进行到哪一步」是两个维度</div>
            </div>
            <div class="field">
              <label class="label">关联简历</label>
              <select v-model="form.resumeId" class="select">
                <option value="">不关联</option>
                <option v-for="r in resumes" :key="r.id" :value="r.id">{{ r.title }}</option>
              </select>
            </div>
            <div class="field">
              <label class="label">投递日期</label>
              <input v-model="form.appliedAt" type="date" class="input" />
            </div>
          </div>
          <div class="field">
            <label class="label">岗位 JD（供 AI 定制 / 匹配使用）</label>
            <textarea v-model="form.jd" class="textarea" placeholder="粘贴岗位描述…"></textarea>
            <button
              class="btn btn-outline"
              style="margin-top: 8px;"
              :disabled="tailoring"
              @click="tailor"
            >{{ tailoring ? 'AI 定制中…' : 'AI 定制（生成打招呼语 / 求职信 / 定制简历）' }}</button>
            <div v-if="matchPoints.length" class="match-points">
              <div v-for="(p, i) in matchPoints" :key="i" class="match-point">{{ p }}</div>
            </div>
          </div>
          <div class="field">
            <label class="label">打招呼语</label>
            <textarea v-model="form.greeting" class="textarea" placeholder="投递时发给 HR 的话（后续可由 AI 自动生成）"></textarea>
          </div>
          <div class="field">
            <label class="label">跟进备注</label>
            <textarea v-model="form.note" class="textarea"></textarea>
          </div>
          <div v-if="message" class="msg" :class="{ 'msg-error': messageError }">{{ message }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ===== 筛选条 =====
 * 9 个各自带边框的小 chip = 一排小盒子，噪音很大。
 * 改成「一个容器 + 内部分段」：只有选中项有底色，其余靠文字本身分档。
 * 圆角嵌套：容器 8 → 每段 6。 */
.filterbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-1);
  flex: 1;
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-surface);
  padding: var(--s-1);
}
.stat-card {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  border: 1px solid transparent;
  border-radius: var(--r-nested);
  padding: var(--s-1) var(--s-3);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  line-height: 1.6;
  transition: background 0.12s var(--ease), color 0.12s var(--ease), border-color 0.12s var(--ease);
}
.stat-card b {
  font-size: var(--fs-sm);
  font-weight: 700;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stat-card:hover {
  background: var(--primary-weak);
  color: var(--text);
}
.stat-card.active {
  background: var(--primary-weak);
  border-color: var(--border);
  color: var(--text);
  font-weight: 600;
}
.stat-card.active b {
  color: var(--text);
}

/* 阶段色点：文字改成 chip 后徽章底色没了，用一个小点把语义留在原地。
   用前景色（40% 亮度）而不是浅色底 —— 6px 的点用浅色等于看不见。 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  flex-shrink: 0;
  background: var(--border-strong);
}
.d-submitted { background: var(--c-blue); }
.d-viewed { background: var(--c-teal); }
.d-screening { background: var(--c-amber); }
.d-written { background: var(--c-violet); }
.d-interview { background: var(--c-indigo); }
.d-rejected { background: var(--c-red); }
.d-offer { background: var(--c-green); }

/* 「有来信待回」是动作项不是状态项：推到最右、用暖色文字，不跟 7 个阶段挤在一起 */
.stat-card.action {
  margin-left: auto;
}
.stat-card.action b {
  color: var(--c-amber);
}
.stat-card.action.active {
  background: var(--c-amber-bg);
  border-color: hsl(32 50% 88%);
}
.stat-card.action.active b {
  color: var(--c-amber);
}

.searchbox {
  flex: 0 1 240px;
  min-width: 160px;
}

/* 表格视觉统一走 src/style.css 的全局 .table（表头底色 / 行悬停 / 单元格留白），
   这里不再覆盖 —— 之前每个页面各写一套 padding，同一张表在不同页高度都不一样。 */
.strong {
  font-weight: 600;
}
.status-select {
  width: auto;
  padding: var(--s-1) var(--s-2);
  font-size: var(--fs-xs);
}

/* 到达轨迹：小一号、灰一档，不抢主徽章的注意力 */
.stage-path {
  margin-top: 2px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  line-height: 1.4;
}
.my-mark {
  margin-top: 2px;
  font-size: var(--fs-2xs);
  color: var(--c-amber);
}

/* 聊天判出的「不合格」依据：比轨迹再灰一档，但必须能读清 —— 它是可核对性的入口 */
.verdict-note {
  margin-top: 2px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  line-height: 1.4;
  max-width: 34ch;
}

/* 投递结果徽章（applypilot 五态）—— 与全局状态色同一套 */
.res-pending { background: var(--c-gray-bg); color: var(--c-gray); }
.res-submitted { background: var(--c-green-bg); color: var(--c-green); }
.res-skipped { background: var(--c-blue-bg); color: var(--c-blue); }
.res-blocked { background: var(--c-red-bg); color: var(--c-red); }
.res-needs-user { background: var(--c-amber-bg); color: var(--c-amber); }

.match-points {
  background: var(--c-green-bg);
  border: 1px solid hsl(150 30% 88%);
  border-radius: var(--r-control);
  padding: var(--s-2) var(--s-3);
  margin-top: var(--s-1);
}
.match-point {
  font-size: var(--fs-sm);
  color: var(--c-green);
  line-height: 1.6;
}

/* 表格里的对齐/间距一律走类，不在模板里写 inline style */
.col-right {
  text-align: right;
}
.row-actions {
  white-space: nowrap;
}
.row-actions .btn + .btn {
  margin-left: var(--s-1);
}

.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(24, 24, 27, 0.36);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--r-surface);
  width: 720px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-title {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 650;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border);
}
.modal-body {
  padding: var(--s-4);
  overflow: auto;
}
.modal-foot {
  padding: var(--s-3) var(--s-4);
  border-top: 1px solid var(--border);
  text-align: right;
}
</style>
