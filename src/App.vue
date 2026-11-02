<script setup>
import { useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { isLoggedIn, user, clearSession } from './auth.js'

const route = useRoute()
const router = useRouter()
const active = computed(() => route.path)

function logout() {
  clearSession()
  router.replace('/login')
}
</script>

<template>
  <!-- 未登录时只渲染页面本身（也就是登录页），不要套一层空的侧边栏 -->
  <router-view v-if="!isLoggedIn" />
  <div v-else class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>求职助手</span>
      </div>
      <nav class="nav">
        <div class="nav-group">
          <div class="nav-group-title">求职执行</div>
          <router-link to="/dashboard" class="nav-item" :class="{ active: active === '/dashboard' }">
            求职总览
          </router-link>
          <router-link to="/applications" class="nav-item" :class="{ active: active === '/applications' }">
            投递追踪
          </router-link>
          <router-link to="/funnel" class="nav-item" :class="{ active: active === '/funnel' }">
            投递漏斗
          </router-link>
          <router-link to="/profile" class="nav-item" :class="{ active: active === '/profile' }">
            候选人画像
          </router-link>
          <router-link to="/match" class="nav-item" :class="{ active: active === '/match' }">
            匹配排序
          </router-link>
          <router-link to="/resumes" class="nav-item" :class="{ active: active === '/resumes' }">
            简历库
          </router-link>
        </div>
        <div class="nav-group">
          <div class="nav-group-title">面试准备</div>
          <router-link to="/home" class="nav-item" :class="{ active: active === '/home' }">
            简历分析
          </router-link>
          <router-link to="/interview" class="nav-item" :class="{ active: active === '/interview' }">
            模拟面试
          </router-link>
          <router-link to="/records" class="nav-item" :class="{ active: active.startsWith('/records') }">
            面试记录
          </router-link>
          <router-link to="/intro" class="nav-item" :class="{ active: active === '/intro' }">
            自我介绍
          </router-link>
          <router-link to="/prep" class="nav-item" :class="{ active: active === '/prep' }">
            准备清单
          </router-link>
          <router-link to="/mistakes" class="nav-item" :class="{ active: active === '/mistakes' }">
            错题本
          </router-link>
          <router-link to="/ammo" class="nav-item" :class="{ active: active === '/ammo' }">
            面试弹药自检
          </router-link>
          <router-link to="/salary" class="nav-item" :class="{ active: active === '/salary' }">
            薪资谈判
          </router-link>
          <router-link to="/apply" class="nav-item" :class="{ active: active === '/apply' }">
            投递助手
          </router-link>
        </div>
        <div class="nav-group">
          <div class="nav-group-title">数据管理</div>
          <router-link to="/backup" class="nav-item" :class="{ active: active === '/backup' }">
            数据备份
          </router-link>
          <router-link to="/settings" class="nav-item" :class="{ active: active === '/settings' }">
            账号设置
          </router-link>
        </div>
      </nav>
      <div class="sidebar-footer">
        <span class="sidebar-user" :title="user?.username || ''">{{ user?.username || '未登录' }}</span>
        <button class="sidebar-logout" type="button" @click="logout">退出</button>
      </div>
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>
