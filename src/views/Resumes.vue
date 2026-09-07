<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.js'
import { COMMON_JOBS } from '../jobs.js'

const router = useRouter()
const resumes = ref([])
const selectedId = ref('')
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
  if (!selectedId.value && resumes.value.length) select(resumes.value[0].id)
}

function select(id) {
  selectedId.value = id
  const r = resumes.value.find((x) => x.id === id)
  if (!r) return
  Object.assign(form, {
    id: r.id,
    title: r.title,
    target: r.target,
    basic: { ...r.basic },
    skillsText: (r.skills || []).join('\n'),
    experiences: (r.experiences || []).map((e) => ({ ...e, pointsText: (e.points || []).join('\n') })),
    projects: (r.projects || []).map((p) => ({ ...p, highlightsText: (p.highlights || []).join('\n') })),
    selfEvaluation: r.selfEvaluation,
  })
}

function createNew() {
  selectedId.value = ''
  Object.assign(form, emptyForm())
  message.value = ''
}

function addExperience() {
  form.experiences.push({ company: '', role: '', start: '', end: '', pointsText: '' })
}
function removeExperience(i) { form.experiences.splice(i, 1) }
function addProject() { form.projects.push({ name: '', role: '', desc: '', highlightsText: '' }) }
function removeProject(i) { form.projects.splice(i, 1) }

async function save() {
  if (!form.title.trim()) {
    message.value = '请先填写简历标题'
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
    if (isNew.value) {
      const created = await api.resumes.create(payload)
      await load()
      select(created.id)
    } else {
      const updated = await api.resumes.update(form.id, payload)
      await load()
      select(updated.id)
    }
    message.value = '已保存 ✓'
    messageError.value = false
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    saving.value = false
  }
}

async function remove() {
  if (!form.id) return
  if (!confirm('确定删除这份简历？此操作不可撤销。')) return
  await api.resumes.remove(form.id)
  await load()
  if (resumes.value.length) select(resumes.value[0].id)
  else createNew()
}

function beautify(id) {
  router.push(`/resume-builder?resumeId=${id}`)
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">简历库</h1>
        <div class="page-sub">维护结构化母版简历，供 AI 定制与匹配打分使用</div>
      </div>
      <button class="btn btn-primary" @click="createNew">+ 新建简历</button>
    </div>

    <div style="display: flex; gap: 18px; align-items: flex-start;">
      <!-- 左侧列表 -->
      <div class="card" style="width: 240px; flex-shrink: 0;">
        <div v-if="!resumes.length" class="muted">还没有简历，点右上角新建</div>
        <div
          v-for="r in resumes"
          :key="r.id"
          class="resume-item"
          :class="{ selected: r.id === selectedId }"
          @click="select(r.id)"
        >
          <div class="resume-item-title">{{ r.title || '未命名简历' }}</div>
          <div class="resume-item-target">{{ r.target || '未设方向' }}</div>
        </div>
      </div>

      <!-- 右侧编辑器 -->
      <div class="card" style="flex: 1;">
        <div v-if="!resumes.length && isNew" class="muted" style="margin-bottom: 16px;">
          填好标题后点「保存」即可创建第一份简历
        </div>

        <div class="field">
          <label class="label">简历标题 *</label>
          <input v-model="form.title" class="input" placeholder="如：全栈开发主线 / 二次元运营主线" />
        </div>

        <div class="field">
          <label class="label">求职方向（任意岗位，可直接输入）</label>
          <input v-model="form.target" class="input" list="target-options" placeholder="如：前端开发 / 新媒体运营 / 任意岗位" />
          <datalist id="target-options">
            <option v-for="t in COMMON_JOBS" :key="t" :value="t" />
          </datalist>
        </div>

        <div class="field">
          <label class="label">基本信息</label>
          <div class="grid-2">
            <input v-model="form.basic.name" class="input" placeholder="姓名" />
            <input v-model="form.basic.phone" class="input" placeholder="电话" />
            <input v-model="form.basic.email" class="input" placeholder="邮箱" />
            <input v-model="form.basic.city" class="input" placeholder="城市" />
            <input v-model="form.basic.school" class="input" placeholder="学校" />
            <input v-model="form.basic.major" class="input" placeholder="专业" />
            <input v-model="form.basic.education" class="input" placeholder="学历（如 本科）" />
            <input v-model="form.basic.graduationYear" class="input" placeholder="毕业年份" />
          </div>
        </div>

        <div class="field">
          <label class="label">技能（每行一条）</label>
          <textarea v-model="form.skillsText" class="textarea" placeholder="Vue3&#10;Node.js&#10;Express&#10;..."></textarea>
        </div>

        <div class="field">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
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
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
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

        <div style="display: flex; align-items: center; gap: 12px;">
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存简历' }}</button>
          <button v-if="!isNew" class="btn btn-danger" @click="remove">删除</button>
          <span v-if="message" class="msg" :class="{ 'msg-error': messageError }">{{ message }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.resume-item {
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 4px;
}
.resume-item:hover {
  background: var(--bg);
}
.resume-item.selected {
  background: #eef2ff;
}
.resume-item-title {
  font-weight: 600;
  font-size: 13px;
}
.resume-item-target {
  font-size: 12px;
  color: var(--text-faint);
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
