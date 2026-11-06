<script setup>
import { useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { isLoggedIn, user, clearSession } from './auth.js'

const route = useRoute()
const router = useRouter()
const active = computed(() => route.path)

// 侧边栏首字母头像：用户名可能很长，取首字符比整串塞进小方块里清楚
const initial = computed(() => (user.value?.username || '?').trim().slice(0, 1))

/**
 * 导航分组（2026-11-06 第二轮）。
 *
 * 依据是「在求职流程的哪一步」，不是功能模块：
 *   总览（看现状）→ 求职（投出去）→ 面试（打进去）→ 账号（数据与设置）
 *
 * 这一轮最大的改动：面试组从 8 项收到 3 项。
 * 「弹药自检 / 自我介绍 / 准备清单 / 错题本 / 薪资谈判」五页合并进「面试工作台」——
 * 它们不是同一件事（一个出素材、一个改稿、一个列待办、一个记复盘、一个练谈钱），
 * 但**都要先填同一份岗位+简历**。五页各填一遍，看到的就只是「五个重复的页面」。
 * 合的是输入，不是功能；五个模块内部逻辑一行没动。
 *
 * 「简历分析」挪去求职组：它读简历、产出投递前的准备，放面试组会让人
 * 以为它只服务于面试。
 */
const NAV_GROUPS = [
  {
    title: '总览',
    items: [
      { to: '/dashboard', label: '求职总览' },
      { to: '/funnel', label: '投递漏斗' },
    ],
  },
  {
    title: '求职',
    items: [
      { to: '/applications', label: '投递追踪' },
      { to: '/match', label: '匹配排序' },
      { to: '/resumes', label: '简历库' },
      { to: '/home', label: '简历分析' },
      { to: '/apply', label: '投递助手' },
      { to: '/profile', label: '候选人画像' },
    ],
  },
  {
    title: '面试',
    items: [
      { to: '/interview', label: '模拟面试' },
      { to: '/interview-prep', label: '面试工作台' },
      { to: '/records', label: '面试记录' },
    ],
  },
  {
    title: '账号',
    items: [
      { to: '/backup', label: '数据备份' },
      { to: '/settings', label: '账号设置' },
    ],
  },
]

// /records/:id 这种子页也要让「面试记录」保持高亮
function isActive(to) {
  return active.value === to || (to !== '/' && active.value.startsWith(to + '/'))
}

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
        <span class="brand-text">
          <b>求职助手</b>
          <small>job-hunter</small>
        </span>
      </div>
      <nav class="nav">
        <div v-for="g in NAV_GROUPS" :key="g.title" class="nav-group">
          <div class="nav-group-title">{{ g.title }}</div>
          <router-link
            v-for="it in g.items"
            :key="it.to"
            :to="it.to"
            class="nav-item"
            :class="{ active: isActive(it.to) }"
          >
            {{ it.label }}
          </router-link>
        </div>
      </nav>
      <div class="sidebar-footer">
        <span class="sidebar-user" :title="user?.username || ''">
          <i class="sidebar-avatar">{{ initial }}</i>
          <span>{{ user?.username || '未登录' }}</span>
        </span>
        <button class="sidebar-logout" type="button" @click="logout">退出</button>
      </div>
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>
