<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.js'
import { COMMON_JOBS } from '../jobs.js'
import { CITIES, EDUCATION, GRAD_YEARS } from '../options.js'

const router = useRouter()
const resumes = ref([])
const mode = ref('list') // 'list' | 'edit'
const saving = ref(false)
const exporting = ref('')
const message = ref('')
const messageError = ref(false)

// 导入简历（PDF / Word）
const showImport = ref(false)
const importFile = ref(null)
const importing = ref(false)
const importError = ref('')

const emptyForm = () => ({
  id: '',
  title: '',
  target: '',
  basic: { name: '', phone: '', email: '', city: '', school: '', major: '', education: '', graduationYear: '' },
  skillsText: '',
  experiences: [],
  projects: [],
  selfEvaluation: '',
})

const form = reactive(emptyForm())
const isNew = computed(() => !form.id)

async function load() {
  resumes.value = await api.resumes.list()
}

function openNew() {
  Object.assign(form, emptyForm())
  message.value = ''
  mode.value = 'edit'
}

function openEdit(r) {
  Object.assign(form, {
    id: r.id,
    title: r.title || '',
    target: r.target || '',
    basic: { ...(r.basic || {}) },
    skillsText: (r.skills || []).join('\n'),
    experiences: (r.experiences || []).map((e) => ({ ...e, pointsText: (e.points || []).join('\n') })),
    projects: (r.projects || []).map((p) => ({ ...p, highlightsText: (p.highlights || []).join('\n') })),
    selfEvaluation: r.selfEvaluation || '',
  })
  message.value = ''
  mode.value = 'edit'
}

function backToList() {
  mode.value = 'list'
  message.value = ''
}

function addExperience() {
  form.experiences.push({ company: '', role: '', start: '', end: '', pointsText: '' })
}
function removeExperience(i) { form.experiences.splice(i, 1) }
function addProject() { form.projects.push({ name: '', role: '', desc: '', highlightsText: '' }) }
function removeProject(i) { form.projects.splice(i, 1) }

function validate() {
  const missing = []
  if (!form.title.trim()) missing.push('简历标题')
  if (!form.basic.name.trim()) missing.push('姓名')
  if (!form.basic.phone.trim()) missing.push('电话')
  if (!form.basic.email.trim()) missing.push('邮箱')
  return missing
}

async function save() {
  const missing = validate()
  if (missing.length) {
    message.value = `请先填写必填项：${missing.join('、')}`
    messageError.value = true
    return
  }
  saving.value = true
  message.value = ''
  try {
    const payload = {
      title: form.title.trim(),
      target: form.target,
      basic: { ...form.basic },
      skills: form.skillsText.split('\n').map((s) => s.trim()).filter(Boolean),
      experiences: form.experiences.map((e) => ({
        company: e.company, role: e.role, start: e.start, end: e.end,
        points: (e.pointsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
      })),
      projects: form.projects.map((p) => ({
        name: p.name, role: p.role, desc: p.desc,
        highlights: (p.highlightsText || '').split('\n').map((s) => s.trim()).filter(Boolean),
      })),
      selfEvaluation: form.selfEvaluation,
    }
    if (isNew.value) await api.resumes.create(payload)
    else await api.resumes.update(form.id, payload)
    await load()
    mode.value = 'list' // 保存完成回到列表，避免列表与表单同屏
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    saving.value = false
  }
}

async function remove(r) {
  if (!confirm(`确定删除「${r.title || '未命名简历'}」？此操作不可撤销。`)) return
  try {
    await api.resumes.remove(r.id)
    await load()
  } catch (e) {
    alert(e.message)
  }
}

function beautify(id) {
  // 跳到 AI 重写版：传入 resumeId，ResumeBuilder 必须基于库中已有简历工作
  router.push(`/resume-builder?resumeId=${id}`)
}

async function exportPdf(r) {
  if (exporting.value) return
  exporting.value = r.id
  try {
    const { html } = await api.resumeExport(r.id)
    const w = window.open('', '_blank')
    if (!w) {
      alert('浏览器拦截了新窗口，请允许弹窗后重试')
      return
    }
    w.document.write(html)
    w.document.close()
    w.focus()
    // 等样式与字体就绪再弹打印框（用户可在此「另存为 PDF」）
    setTimeout(() => w.print(), 300)
  } catch (e) {
    alert(e.message || '导出失败')
  } finally {
    exporting.value = ''
  }
}

function formatTime(t) {
  if (!t) return ''
  return String(t).slice(0, 10).replace('T', ' ')
}

// ===== 导入简历：选文件 → base64 → 后端解析 → 预填表单 =====
function onImportFile(evt) {
  const file = evt.target.files?.[0]
  if (!file) return
  importFile.value = file
  importError.value = ''
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

async function doImport() {
  const file = importFile.value
  if (!file) {
    importError.value = '请先选择文件'
    return
  }
  const lower = file.name.toLowerCase()
  if (!lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
    importError.value = '仅支持 PDF 和 Word(.docx)，旧版 .doc 请另存为 .docx 或 PDF'
    return
  }
  importing.value = true
  importError.value = ''
  try {
    const data = await fileToBase64(file)
    const { resume } = await api.resumeImport({ filename: file.name, data })
    applyImported(resume, file.name)
  } catch (e) {
    importError.value = e.message || '导入失败'
  } finally {
    importing.value = false
  }
}

// 把 AI 解析出的结构化简历映射成编辑表单（作为新简历，用户核对后保存）
function applyImported(raw, filename) {
  const e = emptyForm()
  e.title = raw.title || `导入-${new Date().toISOString().slice(0, 10)}`
  e.target = raw.target || ''
  e.basic = { ...e.basic, ...(raw.basic || {}) }
  e.skillsText = (raw.skills || []).join('\n')
  e.experiences = (raw.experiences || []).map((x) => ({
    company: x.company || '',
    role: x.role || '',
    start: x.start || '',
    end: x.end || '',
    pointsText: (x.points || []).join('\n'),
  }))
  e.projects = (raw.projects || []).map((x) => ({
    name: x.name || '',
    role: x.role || '',
    desc: x.desc || '',
    highlightsText: (x.highlights || []).join('\n'),
  }))
  e.selfEvaluation = raw.selfEvaluation || ''
  Object.assign(form, e)
  message.value = `已从「${filename}」导入并解析，请核对字段后点「保存」入库。`
  messageError.value = false
  mode.value = 'edit'
  showImport.value = false
}

onMounted(load)
</script>

<template>
  <div>
    <!-- ===== 列表视图 ===== -->
    <template v-if="mode === 'list'">
      <div class="page-head">
        <div>
          <h1 class="page-title">简历库</h1>
          <div class="page-sub">维护结构化母版简历，供 AI 定制与匹配打分使用</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" @click="openNew">+ 新建简历</button>
          <button class="btn btn-outline" @click="showImport = true">导入简历</button>
        </div>
      </div>

      <div v-if="!resumes.length" class="card empty-state">
        <div class="empty-title">还没有简历</div>
        <div class="empty-desc">点右上角「+ 新建简历」，填好标题、姓名、电话、邮箱即可创建第一份。</div>
      </div>

      <div v-else class="resume-grid">
        <div v-for="r in resumes" :key="r.id" class="card resume-card">
          <div class="resume-card-title">{{ r.title || '未命名简历' }}</div>
          <div class="resume-card-target">{{ r.target || '未设求职方向' }}</div>
          <div class="resume-card-meta">
            <span v-if="r.basic?.name">{{ r.basic.name }}</span>
            <span v-if="r.basic?.city">· {{ r.basic.city }}</span>
            <span v-if="r.basic?.education">· {{ r.basic.education }}</span>
          </div>
          <div class="resume-card-meta faint">
            技能 {{ (r.skills || []).length }} · 经历 {{ (r.experiences || []).length }} · 项目 {{ (r.projects || []).length }}
            <span v-if="r.updatedAt"> · {{ formatTime(r.updatedAt) }}</span>
          </div>
          <div class="resume-card-actions">
            <button class="btn btn-outline" @click="openEdit(r)">编辑</button>
            <button class="btn btn-outline" @click="beautify(r.id)">AI 重写版</button>
            <button class="btn btn-outline" :disabled="exporting === r.id" @click="exportPdf(r)">
              {{ exporting === r.id ? '导出中…' : '导出 PDF' }}
            </button>
            <button class="btn btn-danger" @click="remove(r)">删除</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ===== 编辑视图 ===== -->
    <template v-else>
      <div class="page-head">
        <div>
          <button class="btn btn-outline back-btn" @click="backToList">← 返回列表</button>
          <h1 class="page-title" style="margin-top: 10px;">{{ isNew ? '新建简历' : '编辑简历' }}</h1>
          <div class="page-sub">带 <span class="req">*</span> 为必填项</div>
        </div>
      </div>

      <div class="card">
        <div class="field">
          <label class="label">简历标题 <span class="req">*</span></label>
          <input v-model="form.title" class="input" placeholder="如：全栈开发主线 / 二次元运营主线" />
        </div>

        <div class="field">
          <label class="label">求职方向（任意岗位，可直接输入）</label>
          <input v-model="form.target" class="input" list="rs-target" placeholder="如：前端开发 / 新媒体运营 / 游戏策划" />
          <datalist id="rs-target">
            <option v-for="t in COMMON_JOBS" :key="t" :value="t" />
          </datalist>
        </div>

        <div class="field">
          <label class="label">基本信息</label>
          <div class="grid-2">
            <input v-model="form.basic.name" class="input" placeholder="姓名 *" />
            <input v-model="form.basic.phone" class="input" placeholder="电话 *" />
            <input v-model="form.basic.email" class="input" placeholder="邮箱 *" />
            <input v-model="form.basic.city" class="input" list="rs-city" placeholder="城市" />
            <input v-model="form.basic.school" class="input" placeholder="学校" />
            <input v-model="form.basic.major" class="input" placeholder="专业" />
            <input v-model="form.basic.education" class="input" list="rs-edu" placeholder="学历（可从预设选）" />
            <input v-model="form.basic.graduationYear" class="input" list="rs-year" placeholder="毕业年份" />
          </div>
          <datalist id="rs-city">
            <option v-for="c in CITIES" :key="c" :value="c" />
          </datalist>
          <datalist id="rs-edu">
            <option v-for="e in EDUCATION" :key="e" :value="e" />
          </datalist>
          <datalist id="rs-year">
            <option v-for="y in GRAD_YEARS" :key="y" :value="y" />
          </datalist>
        </div>

        <div class="field">
          <label class="label">技能（每行一条）</label>
          <textarea v-model="form.skillsText" class="textarea" placeholder="Vue3&#10;Node.js&#10;Express&#10;..."></textarea>
        </div>

        <div class="field">
          <div class="block-head">
            <label class="label" style="margin: 0;">工作/实习经历</label>
            <button class="btn btn-outline" @click="addExperience">+ 添加经历</button>
          </div>
          <div v-for="(e, i) in form.experiences" :key="i" class="sub-block">
            <div class="grid-2">
              <input v-model="e.company" class="input" placeholder="公司" />
              <input v-model="e.role" class="input" placeholder="职位" />
              <input v-model="e.start" class="input" placeholder="开始（如 2025.07）" />
              <input v-model="e.end" class="input" placeholder="结束（如 至今）" />
            </div>
            <textarea v-model="e.pointsText" class="textarea" placeholder="工作成果（每行一条）"></textarea>
            <button class="btn btn-danger" @click="removeExperience(i)">删除此经历</button>
          </div>
          <div v-if="!form.experiences.length" class="muted">暂无经历</div>
        </div>

        <div class="field">
          <div class="block-head">
            <label class="label" style="margin: 0;">项目经历</label>
            <button class="btn btn-outline" @click="addProject">+ 添加项目</button>
          </div>
          <div v-for="(p, i) in form.projects" :key="i" class="sub-block">
            <div class="grid-2">
              <input v-model="p.name" class="input" placeholder="项目名" />
              <input v-model="p.role" class="input" placeholder="担任角色" />
            </div>
            <input v-model="p.desc" class="input" placeholder="项目简介" style="margin-top: 8px;" />
            <textarea v-model="p.highlightsText" class="textarea" placeholder="项目亮点（每行一条）"></textarea>
            <button class="btn btn-danger" @click="removeProject(i)">删除此项目</button>
          </div>
          <div v-if="!form.projects.length" class="muted">暂无项目</div>
        </div>

        <div class="field">
          <label class="label">自我评价</label>
          <textarea v-model="form.selfEvaluation" class="textarea"></textarea>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          <button class="btn btn-outline" @click="backToList">取消</button>
          <span v-if="message" class="msg" :class="{ 'msg-error': messageError }">{{ message }}</span>
        </div>
      </div>
    </template>

    <!-- ===== 导入简历弹窗 ===== -->
    <div v-if="showImport" class="modal-mask" @click.self="showImport = false">
      <div class="modal">
        <div class="modal-title">导入简历（PDF / Word）</div>
        <div class="modal-desc">
          上传你的 PDF 或 Word(.docx) 简历，系统解析文字后用 AI 整理成结构化字段，你核对后即可保存入库。扫描版图片 PDF 暂不支持（需先 OCR 成可复制文本）。
        </div>
        <input type="file" accept=".pdf,.docx" @change="onImportFile" />
        <div v-if="importFile" class="muted" style="margin-top: 8px;">已选：{{ importFile.name }}</div>
        <div v-if="importError" class="msg msg-error" style="margin-top: 8px;">{{ importError }}</div>
        <div class="form-actions" style="margin-top: 14px;">
          <button class="btn btn-primary" :disabled="importing" @click="doImport">
            {{ importing ? '解析中…' : '解析并导入' }}
          </button>
          <button class="btn btn-outline" @click="showImport = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resume-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.resume-card-title {
  font-weight: 600;
  font-size: 15px;
  margin-bottom: 4px;
}
.resume-card-target {
  font-size: 12px;
  color: var(--primary);
  margin-bottom: 8px;
}
.resume-card-meta {
  font-size: 12px;
  color: var(--text-secondary, #666);
  margin-bottom: 2px;
}
.resume-card-meta span {
  margin-right: 2px;
}
.resume-card-meta.faint {
  color: var(--text-faint, #999);
}
.resume-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
.empty-state {
  text-align: center;
  padding: 48px 20px;
}
.empty-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 6px;
}
.empty-desc {
  color: var(--text-faint, #999);
  font-size: 13px;
  margin-bottom: 16px;
}
.back-btn {
  padding: 4px 10px;
  font-size: 12px;
}
.block-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.form-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.sub-block {
  border: 1px dashed var(--border);
  border-radius: 3px;
  padding: 12px;
  margin-bottom: 10px;
}
.sub-block .grid-2 {
  margin-bottom: 8px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: var(--surface, #fff);
  border-radius: 4px;
  padding: 24px;
  width: min(440px, 92vw);
  box-shadow: none;
}
.modal-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}
.modal-desc {
  font-size: 13px;
  color: var(--text-secondary, #666);
  line-height: 1.6;
  margin-bottom: 14px;
}
.modal input[type='file'] {
  width: 100%;
  font-size: 13px;
}
</style>
