<script setup>
import { ref, reactive, onMounted } from 'vue'
import { api } from '../api.js'
import { CITIES, COUNTRIES, CURRENT_ROLE, SALARY_STRATEGY, WORK_AUTH } from '../options.js'

const REMOTE_OPTIONS = ['', '远程', '混合', '现场', '不限']
const SELF_ID_OPTIONS = [
  { value: 'prefer_not_to_say', label: '不愿透露（Prefer not to say）' },
  { value: 'decline', label: '拒绝回答（Decline）' },
  { value: 'leave_blank', label: '留空（Leave blank）' },
]

const form = reactive({
  basic: { name: '', email: '', phone: '', location: '', linkedin: '', portfolio: '', github: '' },
  currentStatus: { currentRole: '', employmentStatus: '', availableStart: '' },
  workAuthorization: { country: '中国', currentAuthorization: '', requiresSponsorship: '' },
  targets: { primaryRoles: [], rolesToAvoid: [], targetLocations: [], remotePreference: '' },
  compensation: { baseRange: '', totalRange: '', answerStrategy: '优先延后回答；无法延后时给出区间' },
  selfIdentification: { strategy: 'prefer_not_to_say', notes: '' },
})

// 标签输入用逗号分隔字符串，落库前转数组
const primaryRolesText = ref('')
const rolesToAvoidText = ref('')
const targetLocationsText = ref('')

const saving = ref(false)
const message = ref('')
const messageError = ref(false)

function splitTags(s) {
  return String(s || '').split(/[,，、\n]/).map((x) => x.trim()).filter(Boolean)
}

async function load() {
  try {
    // 只拉画像本身：此前并行拉简历列表（页面上并未使用），一旦简历接口异常会连带整个画像页打不开
    const p = await api.profile.get()
    Object.assign(form.basic, p.basic || {})
    Object.assign(form.currentStatus, p.currentStatus || {})
    Object.assign(form.workAuthorization, p.workAuthorization || {})
    Object.assign(form.targets, p.targets || {})
    Object.assign(form.compensation, p.compensation || {})
    Object.assign(form.selfIdentification, p.selfIdentification || {})
    primaryRolesText.value = (p.targets?.primaryRoles || []).join('，')
    rolesToAvoidText.value = (p.targets?.rolesToAvoid || []).join('，')
    targetLocationsText.value = (p.targets?.targetLocations || []).join('，')
  } catch (e) {
    message.value = e.message
    messageError.value = true
  }
}

async function save() {
  const missing = []
  if (!form.basic.name.trim()) missing.push('姓名')
  if (!form.basic.email.trim()) missing.push('邮箱')
  if (!form.workAuthorization.country.trim()) missing.push('国家/地区')
  if (missing.length) {
    message.value = `请先填写必填项：${missing.join('、')}`
    messageError.value = true
    return
  }
  saving.value = true
  message.value = ''
  try {
    const payload = {
      basic: { ...form.basic },
      currentStatus: { ...form.currentStatus },
      workAuthorization: { ...form.workAuthorization },
      targets: {
        ...form.targets,
        primaryRoles: splitTags(primaryRolesText.value),
        rolesToAvoid: splitTags(rolesToAvoidText.value),
        targetLocations: splitTags(targetLocationsText.value),
      },
      compensation: { ...form.compensation },
      selfIdentification: { ...form.selfIdentification },
    }
    await api.profile.save(payload)
    message.value = '已保存'
    messageError.value = false
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">候选人画像</h1>
        <div class="page-sub">求职过程中「AI 不能瞎编」的事实真相源：身份、工作授权、薪资、目标岗位</div>
      </div>
      <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存画像' }}</button>
    </div>

    <div class="card">
      <div class="card-title">基本信息</div>
      <div class="grid-2">
        <div class="field"><label class="label">姓名<span class="req">*</span></label><input v-model="form.basic.name" class="input" /></div>
        <div class="field"><label class="label">邮箱<span class="req">*</span></label><input v-model="form.basic.email" class="input" /></div>
        <div class="field"><label class="label">电话</label><input v-model="form.basic.phone" class="input" /></div>
        <div class="field">
          <label class="label">所在地</label>
          <input v-model="form.basic.location" class="input" list="pf-city" placeholder="可直接输入，或从预设选" />
        </div>
        <div class="field"><label class="label">作品集链接</label><input v-model="form.basic.portfolio" class="input" /></div>
        <div class="field"><label class="label">GitHub</label><input v-model="form.basic.github" class="input" /></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">当前状态</div>
      <div class="grid-2">
        <div class="field"><label class="label">当前身份（如「大四在读 / 应届」）</label><input v-model="form.currentStatus.currentRole" class="input" list="pf-role" /></div>
        <div class="field"><label class="label">求职状态</label><input v-model="form.currentStatus.employmentStatus" class="input" list="pf-role" /></div>
        <div class="field"><label class="label">可入职时间</label><input v-model="form.currentStatus.availableStart" class="input" placeholder="如 2026-07" /></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">工作授权（投递前必填，不可猜测）</div>
      <div class="grid-2">
        <div class="field"><label class="label">国家/地区<span class="req">*</span></label><input v-model="form.workAuthorization.country" class="input" list="pf-country" /></div>
        <div class="field">
          <label class="label">当前工作授权</label>
          <input v-model="form.workAuthorization.currentAuthorization" class="input" list="pf-auth" placeholder="如 中国公民，无需额外授权" />
        </div>
        <div class="field">
          <label class="label">是否需要签证/担保（sponsorship）</label>
          <input v-model="form.workAuthorization.requiresSponsorship" class="input" list="pf-auth" placeholder="如 否 / 是（需担保）" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">目标岗位与地点</div>
      <div class="grid-2">
        <div class="field">
          <label class="label">想投的岗位（逗号分隔）</label>
          <input v-model="primaryRolesText" class="input" placeholder="如 前端开发，全栈开发" />
        </div>
        <div class="field">
          <label class="label">不想投的岗位（逗号分隔）</label>
          <input v-model="rolesToAvoidText" class="input" placeholder="如 销售，客服" />
        </div>
        <div class="field">
          <label class="label">目标城市（逗号分隔）</label>
          <input v-model="targetLocationsText" class="input" placeholder="如 广州，深圳" />
        </div>
        <div class="field">
          <label class="label">远程偏好</label>
          <select v-model="form.targets.remotePreference" class="select">
            <option v-for="o in REMOTE_OPTIONS" :key="o" :value="o">{{ o || '未设置' }}</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">薪资预期（只在被问到时使用）</div>
      <div class="grid-2">
        <div class="field"><label class="label">底薪区间</label><input v-model="form.compensation.baseRange" class="input" placeholder="如 8k-12k / 月" /></div>
        <div class="field"><label class="label">总包区间</label><input v-model="form.compensation.totalRange" class="input" placeholder="如 10w-15w / 年" /></div>
        <div class="field" style="grid-column: 1 / -1;">
          <label class="label">回答策略</label>
          <input v-model="form.compensation.answerStrategy" class="input" list="pf-salary" />
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">自愿自我认同（自助 ID）</div>
      <div class="field">
        <label class="label">默认策略</label>
        <select v-model="form.selfIdentification.strategy" class="select">
          <option v-for="o in SELF_ID_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </div>
      <div class="field">
        <label class="label">备注</label>
        <input v-model="form.selfIdentification.notes" class="input" placeholder="未明确要求时默认「不愿透露 / 留空」，不主动填性别、族裔、退伍、残障等" />
      </div>
    </div>

    <div v-if="message" class="msg" :class="{ 'msg-error': messageError }">{{ message }}</div>

    <!-- 输入框预设：只是联想建议，仍可自由输入任意值 -->
    <datalist id="pf-city"><option v-for="o in CITIES" :key="o" :value="o" /></datalist>
    <datalist id="pf-role"><option v-for="o in CURRENT_ROLE" :key="o" :value="o" /></datalist>
    <datalist id="pf-country"><option v-for="o in COUNTRIES" :key="o" :value="o" /></datalist>
    <datalist id="pf-auth"><option v-for="o in WORK_AUTH" :key="o" :value="o" /></datalist>
    <datalist id="pf-salary"><option v-for="o in SALARY_STRATEGY" :key="o" :value="o" /></datalist>
  </div>
</template>
