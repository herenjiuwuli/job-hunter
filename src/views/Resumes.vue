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
const message = ref('')
const messageError = ref(false)

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

function formatTime(t) {
  if (!t) return ''
  return String(t).slice(0, 10).replace('T', ' ')
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
        <button class="btn btn-primary" @click="openNew">+ 新建简历</button>
      </div>

      <div v-if="!resumes.length" class="card empty-state">
        <div class="empty-title">还没有简历</div>
        <div class="empty-desc">点右上角「+ 新建简历」，填好标题、姓名、电话、邮箱即可创建第一份。</div>
        <button class="btn btn-primary" @click="openNew">+ 新建简历</button>
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
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}
.sub-block .grid-2 {
  margin-bottom: 8px;
}
</style>
