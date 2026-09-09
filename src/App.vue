<script setup>
import { useRoute } from 'vue-router'
import { computed } from 'vue'

const route = useRoute()
const active = computed(() => route.path)
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-dot"></span>
        <span>求职助手</span>
      </div>
      <nav class="nav">
        <div class="nav-group">
          <div class="nav-group-title">求职执行</div>
          <router-link to="/applications" class="nav-item" :class="{ active: active === '/applications' }">
            投递追踪
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
          <router-link to="/salary" class="nav-item" :class="{ active: active === '/salary' }">
            薪资谈判
          </router-link>
          <router-link to="/apply" class="nav-item" :class="{ active: active === '/apply' }">
            投递助手
          </router-link>
        </div>
      </nav>
      <div class="sidebar-footer">求职助手 · v0.2</div>
    </aside>
    <main class="content">
      <router-view />
    </main>
  </div>
</template>
