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
 * 导航分组（2026-11-06 重排）。
 *
 * 依据是「在求职流程的哪一步」，不是功能模块：
 *   总览（看现状）→ 求职（投出去）→ 面试（打进去）→ 账号（数据与设置）
 *
 * 两个调整值得记住：
 * 1. 「投递助手」原来在「面试准备」组里 —— 它是生成投递话术的，属于投递环节，
 *    放错组会让人找不到（放在面试组里，找话术时不会往那看）。
 * 2. 「求职总览」原来埋在「求职执行」组第一项，等于没有总览层；
 *    独立成「总览」组后，漏斗作为它的下钻，层级才成立。
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
      { to: '/apply', label: '投递助手' },
      { to: '/profile', label: '候选人画像' },
    ],
  },
  {
    title: '面试',
    items: [
      { to: '/home', label: '简历分析' },
      { to: '/interview', label: '模拟面试' },
      { to: '/records', label: '面试记录' },
      { to: '/prep', label: '准备清单' },
      { to: '/intro', label: '自我介绍' },
      { to: '/ammo', label: '面试弹药自检' },
      { to: '/mistakes', label: '错题本' },
      { to: '/salary', label: '薪资谈判' },
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
