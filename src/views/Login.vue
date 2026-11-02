<script setup>
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, applyLoginResult } from '../api.js'

const router = useRouter()
const route = useRoute()

const mode = ref('login') // login | register
const username = ref('')
const password = ref('')
const submitting = ref(false)
const error = ref('')

function switchMode(next) {
  mode.value = next
  error.value = ''
}

async function submit() {
  if (submitting.value) return
  error.value = ''
  if (!username.value.trim() || !password.value) {
    error.value = '请填写账号和密码'
    return
  }
  submitting.value = true
  try {
    const fn = mode.value === 'login' ? api.auth.login : api.auth.register
    const res = await fn(username.value.trim(), password.value)
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
        {{ mode === 'login' ? '登录后才能看到自己的简历与投递记录' : '第一次用？建一个账号，数据只属于你' }}
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

        <p v-if="error" class="login-error">{{ error }}</p>

        <button class="btn btn-primary login-submit" type="submit" :disabled="submitting">
          {{ submitting ? '处理中…' : mode === 'login' ? '登录' : '注册并登录' }}
        </button>
      </form>
    </div>
  </div>
</template>
