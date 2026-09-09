<template>
  <div>
    <!-- 顶栏：返回 + 正在编辑哪份简历 -->
    <div class="page-head">
      <button class="btn btn-outline back-btn" @click="backToLibrary">← 返回简历库</button>
      <h1 class="page-title">
        AI 重写版 <span v-if="sourceResume" class="muted"> · {{ sourceResume.title || '未命名简历' }}</span>
      </h1>
      <div class="page-sub">基于简历库数据生成新版本，生成后可一键保存回原简历的 <code>content</code> 字段。</div>
    </div>

    <!-- 简历库只读概览（基本信息/技能/项目计数） -->
    <div class="card library-card">
      <div class="card-title">简历库摘要（只读）</div>
      <p class="tip">基本信息请到 <router-link to="/resumes">简历库</router-link> 维护，本页面仅在此副本上 AI 重写。</p>
      <div v-if="sourceResume" class="meta-grid">
        <div class="meta-row"><span class="meta-label">姓名</span><span>{{ sourceResume.basic?.name || '—' }}</span></div>
        <div class="meta-row"><span class="meta-label">电话</span><span>{{ sourceResume.basic?.phone || '—' }}</span></div>
        <div class="meta-row"><span class="meta-label">邮箱</span><span>{{ sourceResume.basic?.email || '—' }}</span></div>
        <div class="meta-row"><span class="meta-label">城市</span><span>{{ sourceResume.basic?.city || '—' }}</span></div>
        <div class="meta-row"><span class="meta-label">学校</span><span>{{ sourceResume.basic?.school || '—' }}</span></div>
        <div class="meta-row"><span class="meta-label">学历</span><span>{{ sourceResume.basic?.education || '—' }}</span></div>
        <div class="meta-row meta-row-wide"><span class="meta-label">技能 ({{ (sourceResume.skills || []).length }})</span><span>{{ (sourceResume.skills || []).join(' · ') || '—' }}</span></div>
        <div class="meta-row meta-row-wide"><span class="meta-label">经历/项目</span><span>{{ (sourceResume.experiences || []).length }} 段经历 · {{ (sourceResume.projects || []).length }} 个项目</span></div>
      </div>
      <div v-if="libraryMessage" class="msg" style="margin-top: 8px;">{{ libraryMessage }}</div>
    </div>

    <!-- AI 输入：项目经历 + 目标岗位 -->
    <div class="card form-card">
      <div class="card-title">AI 输入</div>
      <p class="tip">下方内容将作为 AI 生成依据，会自动从简历库抓取你可改写。AI 绝不虚构经历或数据，确认无误后再保存。</p>
      <div class="form-grid">
        <label class="span2">技能要点（自由编辑，AI 参考）<input v-model="form.skills" type="text" placeholder="Vue3, JavaScript, Node.js, MySQL…" /></label>
        <label class="span2">项目经历要点（一行一段，AI 参考）<textarea v-model="form.projects" rows="6" placeholder="例如：&#10;电商后台管理系统：负责订单模块和权限模块开发，使用 Vue3 + Element Plus&#10;校园二手交易平台：独立完成前后端开发"></textarea></label>
      </div>
      <div class="jobs-select">
        <span class="qlabel">目标岗位（任意岗位都可输入，AI 针对每个岗位出一版）</span>
        <div class="job-checks">
          <label v-for="j in COMMON_JOBS" :key="j" class="check-item" :class="{ checked: form.targetJobs.includes(j) }">
            <input type="checkbox" :value="j" v-model="form.targetJobs" />{{ j }}
          </label>
        </div>
        <div class="job-add">
          <input v-model="customJob" type="text" placeholder="自定义岗位，如「UI 设计师」，回车添加" @keydown.enter.prevent="addCustomJob" />
          <button class="btn btn-ghost btn-sm" :disabled="!customJob.trim()" @click="addCustomJob">添加</button>
        </div>
      </div>
      <div class="tpl-select">
        <span class="qlabel">简历版式（生成时套用，生成后也可随时切换）</span>
        <div class="job-checks">
          <label v-for="t in TEMPLATE_LIST" :key="t.id" class="check-item" :class="{ checked: templateId === t.id }" :title="t.desc">
            <input type="radio" :value="t.id" v-model="templateId" />{{ t.name }}
          </label>
        </div>
      </div>
      <div class="toolbar">
        <button class="btn" :disabled="loading" @click="generate">
          {{ loading ? '生成中…' : '生成简历' }}
        </button>
        <button class="btn btn-ghost" :disabled="!result || savingToLibrary" @click="saveToLibrary">
          {{ savingToLibrary ? '保存中…' : '保存为当前简历' }}
        </button>
      </div>
      <div v-if="error" class="error-tip">{{ error }}</div>
    </div>

    <div v-if="loading" class="card loading">AI 正在生成简历，请稍候…</div>

    <!-- 结果 -->
    <template v-if="result && !loading">
      <div class="card result-card">
        <!-- 顶部：版本切换 + 操作 -->
        <div class="resume-toolbar">
          <div class="tabs">
            <button
              v-for="(v, i) in tabs"
              :key="i"
              class="tab"
              :class="{ active: current === i }"
              @click="current = i"
            >
              {{ v.label }}
            </button>
          </div>
          <div class="resume-tools">
            <label v-if="avatar" class="size-control" title="调整头像大小（像素）">
              头像
              <input type="number" min="48" max="160" v-model.number="avatarSize" />
              <span>px</span>
            </label>
            <button class="btn btn-ghost btn-sm" @click="editing = !editing">
              {{ editing ? '完成编辑' : '编辑文本' }}
            </button>
            <button class="btn btn-ghost btn-sm" @click="copyCurrent">{{ copied ? '已复制' : '复制' }}</button>
            <button class="btn btn-ghost btn-sm" :disabled="scoring" @click="scoreResume">
              {{ scoring ? '评分中…' : '简历评分' }}
            </button>
            <button class="btn btn-sm" :disabled="exportingPdf" @click="exportPdf">
              {{ exportingPdf ? '导出中…' : '导出 PDF' }}
            </button>
          </div>
        </div>

        <!-- 版式切换 -->
        <div class="tpl-switch">
          <span class="qlabel">版式：</span>
          <button
            v-for="t in TEMPLATE_LIST"
            :key="t.id"
            class="tab"
            :class="{ active: templateId === t.id }"
            :title="t.desc"
            @click="templateId = t.id"
          >{{ t.name }}</button>
        </div>

        <!-- 文字格式化工具条（仅编辑模式显示） -->
        <div v-if="editing" class="fmt-toolbar">
          <button type="button" @mousedown.prevent="fmt('bold')">加粗</button>
          <button type="button" @mousedown.prevent="fmt('hiliteColor')">高亮</button>
          <button type="button" @mousedown.prevent="fmt('italic')">斜体</button>
          <button type="button" @mousedown.prevent="fmt('underline')">下划线</button>
          <button type="button" @mousedown.prevent="fmt('removeFormat')">清除格式</button>
        </div>

        <!-- 简历纸：头部（基本信息+头像同一栏）+ 可编辑正文（套用所选版式模板）；导出 PDF 一并包含 -->
        <div class="resume-sheet" ref="sheetEl">
          <!-- 头部栏：左=基本信息，右=头像，二者在同一栏目 -->
          <div v-if="headerHtml || avatar" class="resume-header">
            <div class="resume-header-info" v-html="headerHtml"></div>
            <div v-if="avatar" class="avatar-row">
              <img class="resume-avatar" :src="avatar" alt="头像" :style="{ width: avatarSize + 'px', height: avatarSize + 'px' }" />
              <button class="avatar-remove" @click="avatar = ''">移除</button>
            </div>
            <div v-else class="avatar-empty">
              <label class="avatar-add">+ 添加头像
                <input type="file" accept="image/*" @change="onAvatar" hidden />
              </label>
            </div>
          </div>

          <div
            class="resume-view"
            :class="['tpl-' + templateId, { editing }]"
            ref="resumeEl"
            :contenteditable="editing"
            @input="onEdit"
          ></div>
        </div>
      </div>

      <!-- 9.6 简历评分结果 -->
      <div v-if="scoreError" class="error-tip">{{ scoreError }}</div>
      <div v-if="scoreResult" class="card score-card">
        <div class="title-row">
          <div class="card-title">简历评分</div>
          <button class="btn btn-ghost btn-sm" @click="scoreResult = null">关闭</button>
        </div>
        <div class="score-head">
          <b class="big-score" :class="scoreResult.totalScore >= 80 ? 'high' : scoreResult.totalScore >= 60 ? 'mid' : 'low'">
            {{ scoreResult.totalScore }}
          </b>
          <span class="score-hint">当前版本综合评分（重新生成或编辑后可再次评分）</span>
        </div>
        <div class="dim-bars">
          <div v-for="d in scoreResult.dimensions" :key="d.name" class="dim-item">
            <div class="dim-top"><span>{{ d.name }}</span><b>{{ d.score }}</b></div>
            <div class="dim-track"><div class="dim-fill" :style="{ width: d.score + '%' }"></div></div>
          </div>
        </div>
        <div class="card-title">优化建议</div>
        <ul class="sugg-list">
          <li v-for="(s, i) in scoreResult.suggestions" :key="i">{{ s }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api.js'
import { COMMON_JOBS } from '../jobs.js'

// 可选的简历版式
const TEMPLATE_LIST = [
  { id: 'classic', name: '经典单栏', desc: '商务稳重、ATS 友好，校招社招都稳' },
  { id: 'minimal', name: '极简留白', desc: '无边框大留白，清爽，适合内容少的实习/校招' },
  { id: 'twocol', name: '现代双栏', desc: '左技能右经历，信息密度高、一页装得多' },
  { id: 'sidebar', name: '侧栏色块', desc: '左侧彩色信息栏，视觉冲击强，适合作品集' },
]

// AI 输入表单：本页面只接收简历库传来的 skills/projects/targetJobs 这三类 AI 输入。
// 基本信息（姓名/电话/学校/学历等）由简历库维护，本页只展示「简历库摘要」只读视图。
const form = reactive({
  skills: '',
  projects: '',
  targetJobs: [],
})

// 自定义目标岗位：任意岗位名都支持，回车/点击加入 targetJobs
const customJob = ref('')
function addCustomJob() {
  const v = customJob.value.trim()
  if (!v) return
  if (!form.targetJobs.includes(v)) form.targetJobs.push(v)
  customJob.value = ''
}

/* ---------- 数据源：简历库（强制 ?resumeId= 必传） ---------- */
const route = useRoute()
const router = useRouter()
const sourceResume = ref(null)    // 当前正在编辑的简历数据（只读）
const savingToLibrary = ref(false)
const libraryMessage = ref('')

// 强制 resumeId：没传就直接跳回简历库
onMounted(async () => {
  const id = route.query.resumeId
  if (!id) {
    libraryMessage.value = '缺少 resumeId 参数，正在跳转回简历库…'
    setTimeout(() => router.replace('/resumes'), 600)
    return
  }
  try {
    const r = await api.resumes.get(String(id))
    sourceResume.value = r
    linkedResumeId.value = String(id)
    // 把简历库的 skills/experiences/projects 转写成 textarea/inputs 默认值，用户可在此基础上自由改写
    form.skills = (r.skills || []).join(', ')
    const lines = []
    for (const e of r.experiences || []) {
      const range = e.start || e.end ? `（${e.start || ''} - ${e.end || ''}）` : ''
      lines.push(`${e.company} ${e.role}${range}`.trim())
      for (const p of e.points || []) lines.push(`- ${p}`)
    }
    for (const p of r.projects || []) {
      lines.push(`${p.name}${p.role ? `（${p.role}）` : ''}`)
      if (p.desc) lines.push(`- ${p.desc}`)
      for (const h of p.highlights || []) lines.push(`- ${h}`)
    }
    form.projects = lines.join('\n')
    form.targetJobs = []
    libraryMessage.value = `已加载「${r.title}」，可编辑下方 AI 输入并生成`
  } catch (e) {
    libraryMessage.value = e.message || '简历加载失败'
  }
})

// linkedResumeId 保留（saveToLibrary 还要用它），与 sourceResume 同步
const linkedResumeId = ref('')
watch(sourceResume, (r) => {
  if (r) linkedResumeId.value = r.id
}, { immediate: true })

function backToLibrary() {
  router.push('/resumes')
}

// 保存 AI 生成结果 → 当前简历库的 content 字段（仅更新 AI 文本，不动简历库其他字段）
async function saveToLibrary() {
  if (!sourceResume.value) {
    libraryMessage.value = '简历数据未加载，无法保存'
    return
  }
  if (!result.value) {
    libraryMessage.value = '请先生成简历再保存'
    return
  }
  savingToLibrary.value = true
  libraryMessage.value = ''
  try {
    const updated = {
      ...sourceResume.value,
      content: result.value.resumeText || '',
    }
    await api.resumes.update(linkedResumeId.value, updated)
    // 让 sourceResume 也带上 content，避免下次保存时覆盖用户已保存的
    sourceResume.value = { ...sourceResume.value, content: updated.content }
    libraryMessage.value = `已保存到「${sourceResume.value.title || '当前简历'}」 ✓`
  } catch (e) {
    libraryMessage.value = e.message || '保存失败'
  } finally {
    savingToLibrary.value = false
  }
}

const loading = ref(false)
const error = ref('')
const result = ref(null)
const current = ref(0)
const copied = ref(false)
const editing = ref(false)
const avatar = ref('') // base64 dataURL
const avatarSize = ref(96) // px，默认 96，工具条可调（48-160）
const resumeEl = ref(null)
const sheetEl = ref(null)
const exportingPdf = ref(false)
const templateId = ref('classic')
// 每个版本被用户手动编辑后的 HTML（index -> html），未编辑则为 undefined
const editedHtml = reactive({})

const tabs = computed(() => {
  if (!result.value) return []
  return [
    { label: '通用版', text: result.value.resumeText },
    ...result.value.versions.map((v) => ({ label: `${v.job}版`, text: v.text })),
  ]
})

/* ---------- 解析与渲染 ---------- */
// 行内强调：==高亮== → <mark>，**加粗** → <b>
function inline(s) {
  let t = s
  t = t.replace(/==([^=]+)==/g, '<mark>$1</mark>')
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  return t
}

// 把 AI 的 Markdown 按 # / ## 分块成章节数组
function parseSections(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = esc(md).split('\n')
  const sections = []
  const top = []
  let cur = null
  for (const raw of lines) {
    const line = raw.trim()
    const m = line.match(/^#{1,2}\s+(.*)$/)
    if (m) {
      cur = { title: m[1], body: [] }
      sections.push(cur)
    } else if (cur) {
      cur.body.push(line)
    } else {
      top.push(line)
    }
  }
  if (top.length) sections.unshift({ title: '', body: top })
  return sections.filter((s) => s.title !== '' || s.body.some((b) => b.trim()))
}

// 列表标记（圆点 / 数字 / 顿号序号）
const MARKER = /^([-*]|\d+[.、])\s+/
function stripMarker(line) {
  return line.replace(MARKER, '')
}
// 只有「项目经验/项目经历」章节用序列符号，其余章节（含基本信息/技能/教育等）去符号按段落显示
const LIST_KEYWORDS = ['项目经验', '项目经历', '项目']
function isListSection(s) {
  return LIST_KEYWORDS.some((k) => (s.title || '').includes(k))
}

// 行尾日期范围（如 "XX大学 数字媒体技术  2021.09 - 2025.06"、"新媒体运营实习生  2023.07 - 至今"）
// → 渲染成「左名称 / 右日期」两栏，日期右对齐，参考用户 PDF 简历排版
const DATE_RANGE = /^(.*?)\s+((?:19|20)\d{2}(?:[.\-/年]\d{1,2}?月?)?)\s*[-—~至]\s*(?:(?:19|20)\d{2}(?:[.\-/年]\d{1,2}?月?)?|至今|现在|present|current)$/i
function renderEntry(line) {
  const m = line.match(DATE_RANGE)
  if (!m || !m[1].trim()) return null
  return `<div class="r-entry"><span class="r-entry-name">${inline(m[1].trim())}</span><span class="r-entry-date">${inline(m[2].trim())}</span></div>`
}

// 章节正文：asList=true（项目经验）才用 ul/li；其余章节的标记行当普通段落（去符号）
// 非列表行的「名称 + 行尾日期」自动渲染成右对齐两栏条目
function renderBody(lines, asList = false) {
  let html = ''
  let inList = false
  for (const line of lines) {
    if (asList && MARKER.test(line)) {
      if (!inList) { html += '<ul>'; inList = true }
      html += `<li>${inline(stripMarker(line))}</li>`
    } else if (line) {
      if (inList) { html += '</ul>'; inList = false }
      const entry = renderEntry(line)
      if (entry) {
        html += entry
      } else {
        const txt = asList ? line : stripMarker(line)
        html += `<p>${inline(txt)}</p>`
      }
    }
  }
  if (inList) html += '</ul>'
  return html
}

function sectionBlock(s) {
  const title = s.title ? `<h3 class="r-h">${inline(s.title)}</h3>` : ''
  return title + renderBody(s.body, isListSection(s))
}

// 双栏/侧栏：把"基本信息/技能/证书"等放左栏，其余放右栏
const SIDE_KEYWORDS = ['基本信息', '联系方式', '技能', '证书', '资格', '自我评价', '亮点', '荣誉', '语言', '个人']
function classify(sections) {
  const side = []
  const main = []
  for (const s of sections) {
    if (SIDE_KEYWORDS.some((k) => (s.title || '').includes(k))) side.push(s)
    else main.push(s)
  }
  if (side.length === 0 && main.length) side.push(main.shift())
  return { side, main }
}

// 四套版式：各自决定章节如何排布
const TEMPLATES = {
  classic: {
    render(sections) {
      return sections.map(sectionBlock).join('')
    },
  },
  minimal: {
    render(sections) {
      return sections
        .map((s) => `<div class="r-min-sec"><div class="r-min-label">${inline(s.title || '')}</div>${renderBody(s.body, isListSection(s))}</div>`)
        .join('')
    },
  },
  twocol: {
    render(sections) {
      const { side, main } = classify(sections)
      return `<div class="r-grid"><div class="r-side">${side.map(sectionBlock).join('')}</div><div class="r-main">${main.map(sectionBlock).join('')}</div></div>`
    },
  },
  sidebar: {
    render(sections) {
      const { side, main } = classify(sections)
      return `<div class="r-sidebar-grid"><aside class="r-side-bar">${side.map(sectionBlock).join('')}</aside><div class="r-main">${main.map(sectionBlock).join('')}</div></div>`
    },
  },
}

function renderResume(md, tpl) {
  const sections = parseSections(md)
  const t = TEMPLATES[tpl] || TEMPLATES.classic
  return { bodyHtml: t.render(sections) }
}

// 头部基本信息：直接由表单字段驱动（结构化、受控、全面），不再依赖 AI 自由发挥
// 仅放"个人识别/联系方式"类字段；学校/专业/学历/毕业时间交给 AI 正文「教育背景」，避免重复
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
// 头部信息：来自简历库的 basic 字段（只展示用户在简历库里维护好的联系方式）
const HEADER_FIELDS = [
  { key: 'phone', label: '电话' },
  { key: 'email', label: '邮箱' },
  { key: 'gender', label: '性别' },
  { key: 'age', label: '年龄' },
  { key: 'city', label: '城市' },
  { key: 'political', label: '政治面貌' },
  { key: 'jobTitle', label: '求职岗位' },
]
const headerHtml = computed(() => {
  const basic = sourceResume.value?.basic || {}
  const target = sourceResume.value?.target || ''
  const name = (basic.name || '').trim()
  const lookup = { ...basic, jobTitle: basic.jobTitle || target }
  const items = HEADER_FIELDS
    .map((f) => ({ label: f.label, val: (lookup[f.key] || '').trim() }))
    .filter((x) => x.val)
  let html = ''
  if (name) html += `<p class="r-name">${escapeHtml(name)}</p>`
  if (items.length) {
    html += '<div class="r-contact">'
    for (const it of items) {
      html += `<span class="r-ci"><b>${escapeHtml(it.label)}</b>：${escapeHtml(it.val)}</span>`
    }
    html += '</div>'
  }
  return html
})
// 正文 HTML：优先用用户编辑过的，否则由 markdown + 模板现渲染
const currentHtml = computed(() => {
  const i = current.value
  if (editedHtml[i] != null) return editedHtml[i]
  const tab = tabs.value[i]
  return tab ? renderResume(tab.text, templateId.value).bodyHtml : ''
})

// 切版本或重新生成后，把 HTML 写进 DOM（用 v-html 会在编辑时覆盖光标，故改为命令式）
function renderCurrent() {
  if (resumeEl.value) resumeEl.value.innerHTML = currentHtml.value
}
watch(current, () => nextTick(renderCurrent))
// 切换版式 = 从 AI 源重新渲染，丢弃该版本的手动编辑
watch(templateId, () => {
  if (editedHtml[current.value] != null) delete editedHtml[current.value]
  nextTick(renderCurrent)
})

function onEdit() {
  if (resumeEl.value) editedHtml[current.value] = resumeEl.value.innerHTML
}

/* ---------- 9.6 简历评分 ---------- */
const scoring = ref(false)
const scoreResult = ref(null)
const scoreError = ref('')

async function scoreResume() {
  // 取当前版本的实际内容（编辑后取 innerText，否则取 AI 源文本）
  const text = (resumeEl.value?.innerText || tabs.value[current.value]?.text || '').trim()
  if (!text) return
  scoring.value = true
  scoreError.value = ''
  scoreResult.value = null
  try {
    const res = await fetch('/api/resume/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resumeText: text, job: (sourceResume.value?.target || '').trim() }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '评分失败')
    scoreResult.value = data
    nextTick(() => scoreResult.value && window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }))
  } catch (e) {
    scoreError.value = e.message || '网络错误，请稍后重试'
  } finally {
    scoring.value = false
  }
}

async function generate() {
  // 基本信息直接取自简历库（只读），AI 输入只用页面的 skills/projects/targetJobs
  const basic = sourceResume.value?.basic || {}
  loading.value = true
  error.value = ''
  result.value = null
  // 清空编辑缓存，重新渲染
  Object.keys(editedHtml).forEach((k) => delete editedHtml[k])
  try {
    const res = await fetch('/api/resume/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        basicInfo: {
          name: basic.name || '',
          phone: basic.phone || '',
          email: basic.email || '',
          city: basic.city || '',
          school: basic.school || '',
          major: basic.major || '',
          education: basic.education || '',
          graduationYear: basic.graduationYear || '',
          skills: form.skills.trim(),
          projects: form.projects.trim(),
          targetJobs: form.targetJobs,
        },
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || '生成失败')
    result.value = data
    current.value = 0
    editing.value = false
  } catch (e) {
    error.value = e.message || '网络错误，请稍后重试'
  } finally {
    loading.value = false
  }
  // loading 置否后卡片才渲染出 .resume-view，等 DOM 更新再写入内容（否则 resumeEl 为 null 写不进）
  await nextTick()
  renderCurrent()
}

// 头像：读为 base64，仅前端使用（不进后端、不入库）
function onAvatar(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    error.value = '请上传图片文件'
    return
  }
  error.value = ''
  const reader = new FileReader()
  reader.onload = () => { avatar.value = reader.result }
  reader.readAsDataURL(file)
  e.target.value = '' // 允许重复选同一文件
}

// 文字格式化（保持选区，按钮用 @mousedown.prevent 防止失焦）
function fmt(cmd) {
  if (!editing.value || !resumeEl.value) return
  resumeEl.value.focus()
  if (cmd === 'hiliteColor') {
    document.execCommand('styleWithCSS', false, true)
    document.execCommand('hiliteColor', false, '#fff3a0')
  } else {
    document.execCommand('styleWithCSS', false, false)
    document.execCommand(cmd, false, null)
  }
  onEdit()
}

// 一键导出 PDF：用 html2canvas 截图当前版本（含头像 + 编辑后的加粗/高亮）→ jsPDF 生成 .pdf 下载
// 中文不会乱码（截图位图）；临时克隆整张简历纸并解除高度/滚动限制，确保截全、不截编辑虚线框
async function exportPdf() {
  const sheet = sheetEl.value
  if (!sheet || exportingPdf.value) return
  exportingPdf.value = true
  const tab = tabs.value[current.value]
  const name = (sourceResume.value?.basic?.name || '').trim() || '简历'
  const label = tab ? tab.label : '简历'
  const filename = `${name}_${label}.pdf`
  let wrap = null
  try {
    // html2pdf 体积较大，按需动态加载，避免拖慢首屏
    const html2pdf = (await import('html2pdf.js')).default
    const clone = sheet.cloneNode(true)
    const rv = clone.querySelector('.resume-view')
    if (rv) {
      rv.style.maxHeight = 'none'
      rv.style.overflow = 'visible'
      rv.style.outline = 'none'
      rv.classList.remove('editing')
    }
    // PDF 只保留头像图片：去掉"移除头像"按钮和"添加头像"占位，避免按钮进 PDF
    const rmBtn = clone.querySelector('.avatar-remove')
    if (rmBtn) rmBtn.remove()
    const emptyAdd = clone.querySelector('.avatar-empty')
    if (emptyAdd) emptyAdd.remove()
    wrap = document.createElement('div')
    wrap.style.cssText =
      'position:fixed;left:-99999px;top:0;width:794px;background:#fff;padding:24px;box-sizing:border-box;'
    wrap.appendChild(clone)
    document.body.appendChild(wrap)

    await html2pdf()
      .set({
        margin: 10,
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] },
      })
      .from(clone)
      .save()
  } catch (e) {
    error.value = 'PDF 导出失败，可改用「复制」后粘贴到文档再导出'
  } finally {
    if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap)
    exportingPdf.value = false
  }
}

async function copyCurrent() {
  const tab = tabs.value[current.value]
  if (!tab) return
  try {
    await navigator.clipboard.writeText(tab.text)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = tab.text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    copied.value = true
    setTimeout(() => (copied.value = false), 2000)
  }
}
</script>

<style scoped>
.tip {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 14px;
}
.tip b {
  color: var(--primary);
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}
.form-grid .span2 {
  grid-column: span 2;
}
.form-grid input,
.form-grid textarea {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.form-grid input:focus,
.form-grid textarea:focus {
  border-color: var(--primary);
}
.jobs-select,
.tpl-select {
  margin-top: 14px;
}
.qlabel {
  font-size: 13px;
  color: var(--text-secondary);
}
.job-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 8px;
}
.job-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.job-add input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.job-add input:focus {
  border-color: var(--primary);
}
.check-item {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
}
.check-item input {
  display: none;
}
.check-item.checked {
  border-color: var(--primary);
  background: var(--primary-weak);
  color: var(--primary);
}
.page-head {
  margin-bottom: 16px;
}
.back-btn {
  margin-bottom: 8px;
}
.muted {
  color: var(--text-secondary);
  font-weight: 400;
}
.page-sub code {
  background: var(--bg);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
}
.meta-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 18px;
  margin-top: 8px;
}
.meta-row {
  display: flex;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.meta-row-wide {
  grid-column: span 2;
}
.meta-label {
  color: var(--text-secondary);
  min-width: 72px;
}
.toolbar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.resume-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.resume-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}
.size-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.size-control input {
  width: 56px;
  padding: 5px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  text-align: center;
  font-family: inherit;
  color: var(--text);
  outline: none;
}
.size-control input:focus {
  border-color: var(--primary);
}
.btn-sm {
  padding: 7px 14px;
  font-size: 13px;
}
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tab {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary);
}
.tab.active {
  border-color: var(--primary);
  background: var(--primary-weak);
  color: var(--primary);
  font-weight: 500;
}
.tpl-switch {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.fmt-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
  padding: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.fmt-toolbar button {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text);
}
.fmt-toolbar button:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.resume-sheet {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 24px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
/* 头部栏：基本信息（左） + 头像（右）同栏 */
.resume-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 4px;
}
.resume-header-info {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}
.resume-header-info :deep(.r-name) {
  font-size: 20px;
  font-weight: 700;
  margin: 0 0 6px;
}
.resume-header-info :deep(.r-contact) {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-secondary);
}
.resume-header-info :deep(.r-ci) {
  white-space: nowrap;
}
.resume-header-info :deep(.r-ci b) {
  color: var(--text);
  font-weight: 600;
  margin-right: 2px;
}
.resume-header-info :deep(mark) {
  background: #fff3a0;
  padding: 0 2px;
  border-radius: 2px;
}
.avatar-row {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}
.resume-avatar {
  width: 96px;              /* 兜底尺寸，实际由 inline style (avatarSize) 控制 */
  height: 96px;
  border-radius: 4px;       /* 方形小圆角（参考用户简历） */
  object-fit: cover;
  border: 1px solid var(--border);
  background: #fff;
}
.avatar-remove {
  border: 1px solid var(--border);
  background: #fff;
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-secondary);
}
.avatar-empty {
  flex-shrink: 0;
}
.avatar-add {
  display: inline-block;
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 10px 18px;
  font-size: 13px;
  cursor: pointer;
  color: var(--text-secondary);
}
.avatar-add:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.resume-view {
  min-height: 300px;
  max-height: 60vh;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.65;
  color: var(--text);
}
.resume-view.editing {
  outline: 2px dashed var(--primary);
  outline-offset: 4px;
  cursor: text;
}
/* 通用排版（注入内容，用 :deep） */
.resume-view :deep(p) {
  margin: 5px 0;
}
.resume-view :deep(ul) {
  padding-left: 18px;
  margin: 5px 0;
}
.resume-view :deep(li) {
  margin: 3px 0;
}
.resume-view :deep(b) {
  font-weight: 700;
}
.resume-view :deep(mark) {
  background: #fff3a0;
  padding: 0 2px;
  border-radius: 2px;
}
.resume-view :deep(.r-h) {
  font-size: 15px;
  margin: 16px 0 8px;
  clear: both;              /* 章节标题从右侧浮动头像下方开始，避免被压缩 */
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);   /* 统一：章节标题带下边框线，参考用户 PDF */
}

/* 名称 + 行尾日期 → 左右两栏，日期右对齐（参考用户 PDF 简历） */
.resume-view :deep(.r-entry) {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  margin: 7px 0 2px;
}
.resume-view :deep(.r-entry-name) {
  font-weight: 600;
}
.resume-view :deep(.r-entry-date) {
  color: var(--text-secondary);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* 经典单栏 */
.resume-view.tpl-classic :deep(.r-h) {
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.resume-view.tpl-classic :deep(.r-h:first-child) {
  margin-top: 0;
}

/* 极简留白 */
.resume-view.tpl-minimal :deep(.r-min-sec) {
  margin: 18px 0;
}
.resume-view.tpl-minimal :deep(.r-min-label) {
  font-size: 12px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: #9aa0a6;
  font-weight: 600;
  margin-bottom: 6px;
  padding-bottom: 5px;
  border-bottom: 1px solid var(--border);   /* 极简也统一带下边框线，对齐 PDF */
}
.resume-view.tpl-minimal :deep(mark) {
  background: transparent;
  color: var(--primary);
  padding: 0;
}

/* 现代双栏 */
.resume-view.tpl-twocol :deep(.r-grid) {
  display: grid;
  grid-template-columns: 32% 1fr;
  gap: 22px;
}
.resume-view.tpl-twocol :deep(.r-side) {
  background: var(--bg);
  padding: 14px;
  border-radius: 8px;
}
.resume-view.tpl-twocol :deep(.r-side .r-h) {
  color: var(--primary);
  border-bottom: 2px solid var(--primary);
  padding-bottom: 4px;
}
.resume-view.tpl-twocol :deep(.r-side .r-h:first-child) {
  margin-top: 0;
}

/* 侧栏色块 */
.resume-view.tpl-sidebar :deep(.r-sidebar-grid) {
  display: grid;
  grid-template-columns: 30% 1fr;
  gap: 0;
}
.resume-view.tpl-sidebar :deep(.r-side-bar) {
  background: var(--primary);
  color: #fff;
  padding: 20px 16px;
  border-radius: 8px;
}
.resume-view.tpl-sidebar :deep(.r-side-bar .r-h) {
  color: #fff;
  font-size: 13px;
  margin: 14px 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.35);
}
.resume-view.tpl-sidebar :deep(.r-side-bar .r-h:first-child) {
  margin-top: 0;
}
.resume-view.tpl-sidebar :deep(.r-side-bar p),
.resume-view.tpl-sidebar :deep(.r-side-bar li) {
  color: rgba(255, 255, 255, 0.92);
}
.resume-view.tpl-sidebar :deep(.r-side-bar mark) {
  background: rgba(255, 255, 255, 0.28);
  color: #fff;
}
.resume-view.tpl-sidebar :deep(.r-side-bar .r-entry-date) {
  color: rgba(255, 255, 255, 0.85);
}
.resume-view.tpl-sidebar :deep(.r-main) {
  padding-left: 20px;
}
.resume-view.tpl-sidebar :deep(.r-main .r-h) {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .form-grid .span2 {
    grid-column: span 1;
  }
  .resume-view.tpl-twocol :deep(.r-grid),
  .resume-view.tpl-sidebar :deep(.r-sidebar-grid) {
    grid-template-columns: 1fr;
  }
  .resume-view.tpl-sidebar :deep(.r-main) {
    padding-left: 0;
    margin-top: 14px;
  }
}
/* ---------- 9.6 简历评分卡 ---------- */
.score-card {
  margin-top: 16px;
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
.score-head {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}
.big-score {
  font-size: 38px;
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
.score-hint {
  font-size: 13px;
  color: var(--text-secondary);
}
.dim-bars {
  display: grid;
  gap: 10px;
  margin-bottom: 16px;
}
.dim-item .dim-top {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  margin-bottom: 4px;
}
.dim-track {
  height: 8px;
  background: #eef1f4;
  border-radius: 4px;
  overflow: hidden;
}
.dim-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 4px;
}
.sugg-list {
  margin: 8px 0 0;
  padding-left: 20px;
  display: grid;
  gap: 8px;
  font-size: 14px;
}
</style>
