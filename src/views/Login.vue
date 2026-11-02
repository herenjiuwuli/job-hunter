<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, applyLoginResult } from '../api.js'

const router = useRouter()
const route = useRoute()

const mode = ref('login') // login | register
const username = ref('')
const password = ref('')
const inviteCode = ref('')
const submitting = ref(false)
const error = ref('')

// 邀请码实时状态：'' 未查 | 'checking' | 'ok' | 'bad'
const inviteState = ref('')
let checkTimer = null

const showInvite = computed(() => mode.value === 'register')

// 别人发链接/口述过来时，通常会把码放在 ?invite= 里；也有的直接贴一整串
onMounted(() => {
  const q = route.query.invite
  if (typeof q === 'string' && q.trim()) {
    inviteCode.value = q.trim().toUpperCase()
    mode.value = 'register'
  }
})

function switchMode(next) {
  mode.value = next
  error.value = ''
}

/**
 * 边输边校验邀请码。
 * 延时 400ms 再打接口：码有 12 位，逐字符发请求既吵又没必要。
 * 校验失败只提示、不拦提交 —— 万一这个公开校验接口有问题，注册本身还得能试。
 */
watch(inviteCode, (v) => {
  inviteState.value = ''
  clearTimeout(checkTimer)
  const code = v.trim().replace(/[^A-Za-z0-9]/g, '')
  if (code.length !== 12) return
  inviteState.value = 'checking'
  checkTimer = setTimeout(async () => {
    try {
      const r = await api.auth.checkInvite(code)
      inviteState.value = r.usable ? 'ok' : 'bad'
    } catch {
      inviteState.value = ''
    }
  }, 400)
})

async function submit() {
  if (submitting.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写账号和密码'
    return
  }
  if (mode.value === 'register' && !inviteCode.value.trim()) {
    error.value = '本站为邀请制，请填写邀请码'
    return
  }
  submitting.value = true
  try {
    const res =
      mode.value === 'login'
        ? await api.auth.login(username.value.trim(), password.value)
        : await api.auth.register(username.value.trim(), password.value, inviteCode.value.trim())
    applyLoginResult(res)
    // 登录前想去哪就回哪，直接进来的默认去总览
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    router.replace(redirect)
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-dot"></span>
        <span>求职助手</span>
      </div>
      <p class="login-sub">
        {{
          mode === 'login'
            ? '登录后才能看到自己的简历与投递记录'
            : '本站为邀请制：填上收到的邀请码即可创建自己的账号'
        }}
      </p>

      <div class="login-tabs">
        <button
          class="login-tab"
          :class="{ active: mode === 'login' }"
          type="button"
          @click="switchMode('login')"
        >
          登录
        </button>
        <button
          class="login-tab"
          :class="{ active: mode === 'register' }"
          type="button"
          @click="switchMode('register')"
        >
          注册
        </button>
      </div>

      <form @submit.prevent="submit">
        <div class="field">
          <label>账号</label>
          <input v-model="username" class="input" autocomplete="username" placeholder="例如 chen" />
        </div>
        <div class="field">
          <label>密码</label>
          <input
            v-model="password"
            class="input"
            type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="至少 6 位"
          />
        </div>

        <div v-if="showInvite" class="field">
          <label>邀请码</label>
          <input
            v-model="inviteCode"
            class="input"
            autocomplete="off"
            spellcheck="false"
            placeholder="XXXX-XXXX-XXXX"
            style="letter-spacing: 1px; text-transform: uppercase"
          />
          <p v-if="inviteState === 'checking'" class="field-hint">正在校验…</p>
          <p v-else-if="inviteState === 'ok'" class="field-hint invite-ok">邀请码可用 ✅</p>
          <p v-else-if="inviteState === 'bad'" class="field-hint invite-bad">
            这个邀请码用不了（可能已用过、已过期或输错了）
          </p>
          <p v-else class="field-hint">没有邀请码？找已经用这个工具的人要一个。</p>
        </div>

        <p v-if="error" class="login-error">{{ error }}</p>

        <button class="btn btn-primary login-submit" type="submit" :disabled="submitting">
          {{ submitting ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.invite-ok {
  color: #15803d;
}
.invite-bad {
  color: #b91c1c;
}
</style>
