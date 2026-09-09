<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'

const loading = ref(false)
const exporting = ref(false)
const importing = ref(false)
const message = ref('')
const messageError = ref(false)
const fileInput = ref(null)

// 通过 export 接口拿全量数据（自用数据量小，用于概览 + 导出同一份）
const backup = ref(null)

const stats = computed(() => {
  const d = backup.value?.data || {}
  return {
    resumes: (d.resumes || []).length,
    applications: (d.applications || []).length,
    records: (d.records || []).length,
    profileFilled: Object.keys(d.profile || {}).length > 0,
  }
})

const exportedAt = computed(() => {
  if (!backup.value?.exportedAt) return ''
  const d = new Date(backup.value.exportedAt)
  return d.toLocaleString('zh-CN')
})

async function load() {
  loading.value = true
  try {
    backup.value = await api.backup.export()
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    loading.value = false
  }
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function doExport() {
  exporting.value = true
  message.value = ''
  try {
    // 重新拉最新数据再导出（避免用进入页面时的旧快照）
    const data = await api.backup.export()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `job-hunter-backup-${timestamp()}.json`
    a.click()
    URL.revokeObjectURL(url)
    backup.value = data
    message.value = '已导出备份文件（请妥善保存，含个人敏感数据）'
    messageError.value = false
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    exporting.value = false
  }
}

function onFileChange(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const data = JSON.parse(String(reader.result))
      if (!data || typeof data !== 'object' || !data.data || typeof data.data !== 'object') {
        throw new Error('不是有效的备份文件（缺少 data 字段）')
      }
      await confirmImport(data)
    } catch (err) {
      message.value = err.message || '文件解析失败'
      messageError.value = true
    } finally {
      e.target.value = ''
    }
  }
  reader.onerror = () => {
    message.value = '文件读取失败'
    messageError.value = true
    e.target.value = ''
  }
  reader.readAsText(file)
}

async function confirmImport(data) {
  const exportedAt = data.exportedAt ? new Date(data.exportedAt).toLocaleString('zh-CN') : '未知时间'
  const ok = confirm(
    `即将用「${exportedAt}」的备份覆盖当前所有数据（简历 / 投递 / 面试记录 / 画像），此操作不可撤销。\n\n确定继续吗？`,
  )
  if (!ok) return

  importing.value = true
  message.value = ''
  try {
    const res = await api.backup.import(data)
    const names = { resumes: '简历库', applications: '投递记录', records: '面试记录', profile: '候选人画像' }
    const imported = (res.imported || []).map((k) => names[k] || k).join('、')
    message.value = `导入完成：${imported}`
    messageError.value = false
    await load()
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    importing.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">数据备份</h1>
        <div class="page-sub">你的简历、投递、面试记录都只存在本机，导出备份防止丢失</div>
      </div>
    </div>

    <!-- 当前数据概览 -->
    <div class="card">
      <div class="card-title">当前数据</div>
      <div v-if="loading" class="muted">加载中…</div>
      <div v-else class="stats-grid">
        <div class="stat">
          <div class="stat-num">{{ stats.resumes }}</div>
          <div class="stat-label">简历</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ stats.applications }}</div>
          <div class="stat-label">投递记录</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ stats.records }}</div>
          <div class="stat-label">面试记录</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ stats.profileFilled ? '已填' : '未填' }}</div>
          <div class="stat-label">候选人画像</div>
        </div>
      </div>
    </div>

    <!-- 导出 -->
    <div class="card">
      <div class="card-title">导出备份</div>
      <p class="muted" style="margin: 4px 0 12px;">
        把全部个人数据打包成一个 JSON 文件下载到本地。建议定期导出，或换电脑前导出。
      </p>
      <button class="btn btn-primary" :disabled="exporting" @click="doExport">
        {{ exporting ? '导出中…' : '导出全部数据' }}
      </button>
    </div>

    <!-- 导入 -->
    <div class="card">
      <div class="card-title">导入恢复</div>
      <p class="muted" style="margin: 4px 0 12px;">
        选择之前导出的备份文件，恢复数据。<strong style="color: #dc2626;">注意：会覆盖当前所有数据，不可撤销。</strong>
      </p>
      <input ref="fileInput" type="file" accept=".json,application/json" class="input" style="max-width: 360px;" @change="onFileChange" />
      <div style="margin-top: 8px;" class="muted">仅支持本工具导出的 .json 备份文件</div>
    </div>

    <div v-if="message" class="msg" :class="{ 'msg-error': messageError }" style="margin-top: 16px;">{{ message }}</div>
  </div>
</template>

<style scoped>
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}
.stat {
  text-align: center;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
}
.stat-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--primary);
}
.stat-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-top: 4px;
}
</style>
