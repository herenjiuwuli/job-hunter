<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { user } from '../auth.js'

/**
 * 账号设置：改密码 + 邀请码管理。
 *
 * 为什么邀请码放在这一页而不是单独一个「用户管理」模块：
 *   个人工具，账号相关的操作就这么几件（我是谁、改密码、拉人进来），
 *   拆成多个页面只会增加导航负担。侧栏「数据管理」下面一个入口足够。
 */

const currentUser = computed(() => user.value || null)
const isOwner = computed(() => (currentUser.value?.role || 'member') === 'owner')

// ---------- 改密码 ----------
const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const pwSaving = ref(false)
const pwMessage = ref('')
const pwFailed = ref(false)

async function changePassword() {
  if (pwSaving.value) return
  pwMessage.value = ''
  pwFailed.value = false
  if (!oldPassword.value || !newPassword.value) {
    pwMessage.value = '请填写原密码和新密码'
    pwFailed.value = true
    return
  }
  if (newPassword.value.length < 6) {
    pwMessage.value = '新密码至少 6 位'
    pwFailed.value = true
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    pwMessage.value = '两次输入的新密码不一致'
    pwFailed.value = true
    return
  }
  pwSaving.value = true
  try {
    await api.auth.changePassword(oldPassword.value, newPassword.value)
    pwMessage.value = '密码已更新。其他设备上的登录状态仍然有效，直到 token 过期。'
    pwFailed.value = false
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } catch (e) {
    pwMessage.value = e.message || '修改失败'
    pwFailed.value = true
  } finally {
    pwSaving.value = false
  }
}

// ---------- 邀请码 ----------
const invites = ref([])
const listLoading = ref(false)
const note = ref('')
const ttlDays = ref(7)
const creating = ref(false)
const justCreated = ref('')
const listMessage = ref('')
const listFailed = ref(false)

const usableCount = computed(() => invites.value.filter((i) => i.status === 'unused').length)

const STATUS_LABEL = { unused: '可用', used: '已使用', expired: '已过期' }
const STATUS_CLASS = { unused: 'tag tag-success', used: 'tag', expired: 'tag tag-warning' }

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}

async function loadInvites() {
  listLoading.value = true
  try {
    invites.value = await api.auth.invites.list()
  } catch (e) {
    listMessage.value = e.message
    listFailed.value = true
  } finally {
    listLoading.value = false
  }
}

async function createInvite() {
  if (creating.value) return
  creating.value = true
  listMessage.value = ''
  listFailed.value = false
  try {
    const inv = await api.auth.invites.create({ note: note.value.trim(), ttlDays: ttlDays.value })
    justCreated.value = inv.code
    note.value = ''
    await loadInvites()
  } catch (e) {
    listMessage.value = e.message || '生成失败'
    listFailed.value = true
  } finally {
    creating.value = false
  }
}

async function revokeInvite(code) {
  if (!window.confirm(`确定撤销邀请码 ${code}？对方将无法用它注册。`)) return
  listMessage.value = ''
  listFailed.value = false
  try {
    await api.auth.invites.revoke(code)
    if (justCreated.value === code) justCreated.value = ''
    await loadInvites()
  } catch (e) {
    listMessage.value = e.message || '撤销失败'
    listFailed.value = true
  }
}

const copied = ref('')
async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code)
    copied.value = code
    setTimeout(() => {
      if (copied.value === code) copied.value = ''
    }, 1500)
  } catch {
    // 剪贴板被拒（非安全上下文 / 权限），不报错，码本来就显示在页面上
    copied.value = ''
    listMessage.value = '浏览器不允许自动复制，请手动选中复制'
    listFailed.value = true
  }
}

// ---------- 默认打招呼语 ----------
// 存后端（greeting.json）而不是浏览器本地：扩展是另一个进程，只能从后端拿。
const greetingText = ref('')
const greetingLoading = ref(false)
const greetingSaving = ref(false)
const greetingMessage = ref('')
const greetingFailed = ref(false)

async function loadGreeting() {
  if (greetingLoading.value) return
  greetingLoading.value = true
  greetingMessage.value = ''
  try {
    const d = await api.greeting.getDefault()
    greetingText.value = d.text || ''
  } catch (e) {
    greetingMessage.value = e.message || '读取失败'
    greetingFailed.value = true
  } finally {
    greetingLoading.value = false
  }
}

async function saveGreeting() {
  if (greetingSaving.value) return
  greetingSaving.value = true
  greetingMessage.value = ''
  greetingFailed.value = false
  try {
    const d = await api.greeting.saveDefault(greetingText.value)
    greetingText.value = d.text || ''
    greetingMessage.value = greetingText.value
      ? '已保存。扩展投递时会自动带出这段话。'
      : '已清空。扩展那边会提示「先填话术」。'
  } catch (e) {
    greetingMessage.value = e.message || '保存失败'
    greetingFailed.value = true
  } finally {
    greetingSaving.value = false
  }
}

onMounted(() => {
  loadGreeting()
  if (isOwner.value) loadInvites()
})
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">账号设置</h1>
        <div class="page-sub">当前账号、口令，以及（如果你是这个工具的主人）邀请谁进来</div>
      </div>
    </div>

    <!-- 当前账号 -->
    <div class="card">
      <div class="card-title">当前账号</div>
      <div class="who">
        <div class="who-avatar">{{ (currentUser?.username || '?').slice(0, 1).toUpperCase() }}</div>
        <div>
          <div class="who-name">{{ currentUser?.username || '未登录' }}</div>
          <div class="muted who-role">
            {{ isOwner ? '管理员（可以发邀请码）' : '普通成员' }}
            <span class="who-id">{{ currentUser?.id || '' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 改密码 -->
    <div class="card">
      <div class="card-title">修改密码</div>
      <p class="muted" style="margin: 4px 0 12px">
        迁移脚本自动生成过一次性口令的话，在这里换成自己记得住的。
      </p>
      <form class="pw-form" @submit.prevent="changePassword">
        <div class="field">
          <label>原密码</label>
          <input v-model="oldPassword" class="input" type="password" autocomplete="current-password" />
        </div>
        <div class="field">
          <label>新密码</label>
          <input v-model="newPassword" class="input" type="password" autocomplete="new-password" placeholder="至少 6 位" />
        </div>
        <div class="field">
          <label>确认新密码</label>
          <input v-model="confirmPassword" class="input" type="password" autocomplete="new-password" />
        </div>
        <div class="pw-actions">
          <button class="btn btn-primary" type="submit" :disabled="pwSaving">
            {{ pwSaving ? '保存中…' : '保存新密码' }}
          </button>
        </div>
      </form>
      <p v-if="pwMessage" class="msg-inline" :class="{ bad: pwFailed }">{{ pwMessage }}</p>
    </div>

    <!-- 打招呼语（扩展投递时自动取用） -->
    <div class="card">
      <div class="card-title">默认打招呼语</div>
      <p class="muted" style="margin: 4px 0 12px">
        浏览器扩展投递时会自动取这段话，不用每次复制粘贴。BOSS 的「投递」就是发出这条消息，所以它是投递的前置条件。
      </p>
      <textarea
        v-model="greetingText"
        class="input"
        rows="6"
        placeholder="您好，我是计算机应用工程专业大四在读，看到贵司的{{岗位}}……"
      ></textarea>
      <p class="muted" style="margin: 8px 0 0; font-size: var(--fs-sm)">
        可用占位符：<code>&#123;&#123;公司&#125;&#125;</code> <code>&#123;&#123;岗位&#125;&#125;</code>，扩展执行时会替换成当前岗位的真实名字。
        <br />
        优先级：<b>单条投递生成过的话术</b>（如「AI 定制」产出的）＞ 这里的默认话术。
      </p>
      <div class="pw-actions">
        <button class="btn btn-primary" type="button" :disabled="greetingSaving" @click="saveGreeting">
          {{ greetingSaving ? '保存中…' : '保存默认话术' }}
        </button>
        <button class="btn" type="button" :disabled="greetingLoading" @click="loadGreeting">
          重新读取
        </button>
      </div>
      <p v-if="greetingMessage" class="msg-inline" :class="{ bad: greetingFailed }">{{ greetingMessage }}</p>
    </div>

    <!-- 邀请码（仅管理员） -->
    <div v-if="isOwner" class="card">
      <div class="card-title">
        邀请码
        <span class="muted" style="font-weight: 400; font-size: var(--fs-sm); margin-left: 8px">
          当前还有 {{ usableCount }} 个可用
        </span>
      </div>
      <p class="muted" style="margin: 4px 0 12px">
        本站是邀请制：没有邀请码就注册不了。发一个给要用的人，让他在登录页「注册」里填。
        每个码只能用一次，过期作废。
      </p>

      <div class="gen-row">
        <input v-model="note" class="input" maxlength="60" placeholder="备注（给谁的，自己看的）" />
        <select v-model.number="ttlDays" class="input ttl-select">
          <option :value="7">7 天有效</option>
          <option :value="30">30 天有效</option>
          <option :value="90">90 天有效</option>
        </select>
        <button class="btn btn-primary" :disabled="creating" @click="createInvite">
          {{ creating ? '生成中…' : '生成邀请码' }}
        </button>
      </div>

      <div v-if="justCreated" class="fresh">
        <div class="fresh-label">刚生成的邀请码（只显示这一次，记得现在复制发给对方）</div>
        <div class="fresh-code">{{ justCreated }}</div>
        <button class="btn btn-sm btn-outline" @click="copyCode(justCreated)">
          {{ copied === justCreated ? '已复制 ✅' : '复制' }}
        </button>
      </div>

      <p v-if="listMessage" class="msg-inline" :class="{ bad: listFailed }">{{ listMessage }}</p>

      <div v-if="listLoading" class="muted" style="margin-top: 12px">加载中…</div>
      <div v-else-if="!invites.length" class="empty" style="margin-top: 12px">
        还没有发出过邀请码。
      </div>
      <table v-else class="inv-table">
        <thead>
          <tr>
            <th>邀请码</th>
            <th>备注</th>
            <th>状态</th>
            <th>到期</th>
            <th>使用者</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="inv in invites" :key="inv.code">
            <td>
              <span class="code-cell">{{ inv.code }}</span>
              <button
                v-if="inv.status === 'unused'"
                class="link-btn"
                type="button"
                @click="copyCode(inv.code)"
              >
                {{ copied === inv.code ? '已复制' : '复制' }}
              </button>
            </td>
            <td class="muted">{{ inv.note || '—' }}</td>
            <td>
              <span :class="STATUS_CLASS[inv.status] || 'tag'">{{ STATUS_LABEL[inv.status] || inv.status }}</span>
            </td>
            <td class="muted">{{ fmtTime(inv.expiresAt) }}</td>
            <td class="muted">{{ inv.usedBy || '—' }}</td>
            <td>
              <button
                v-if="inv.status === 'unused'"
                class="link-btn danger"
                type="button"
                @click="revokeInvite(inv.code)"
              >
                撤销
              </button>
              <span v-else class="muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.who {
  display: flex;
  align-items: center;
  gap: 12px;
}
.who-avatar {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  background: var(--primary);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: var(--fs-md);
}
.who-name {
  font-weight: 600;
  font-size: var(--fs-md);
}
.who-role {
  font-size: var(--fs-sm);
  margin-top: 2px;
}
.who-id {
  margin-left: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-xs);
  opacity: 0.6;
}

.pw-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.pw-form .field {
  margin: 0;
  min-width: 180px;
}
/* 按钮独占一行：跟三个输入框挤在一行时，视觉上像第四个字段，容易看错 */
.pw-actions {
  flex-basis: 100%;
}

.gen-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.gen-row .input {
  flex: 1;
  min-width: 180px;
}
.ttl-select {
  flex: 0 0 auto;
  min-width: 120px;
  max-width: 140px;
}

.fresh {
  margin-top: 14px;
  padding: 14px;
  border: 1px dashed var(--primary);
  border-radius: var(--radius);
  background: var(--bg);
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.fresh-label {
  width: 100%;
  font-size: var(--fs-sm);
  color: var(--text-faint);
}
.fresh-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--fs-lg);
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--primary);
}

.inv-table {
  width: 100%;
  border-collapse: collapse;
  margin-top: 14px;
  font-size: var(--fs-sm);
}
.inv-table th {
  text-align: left;
  font-weight: 500;
  color: var(--text-faint);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.inv-table td {
  padding: 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.code-cell {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 1px;
  font-weight: 600;
}
.link-btn {
  background: none;
  border: none;
  color: var(--primary);
  cursor: pointer;
  font-size: var(--fs-xs);
  padding: 2px 6px;
}
.link-btn.danger {
  color: #dc2626;
}
.link-btn:hover {
  text-decoration: underline;
}

.msg-inline {
  margin-top: 12px;
  font-size: var(--fs-sm);
  color: #15803d;
}
.msg-inline.bad {
  color: #b91c1c;
}
</style>
