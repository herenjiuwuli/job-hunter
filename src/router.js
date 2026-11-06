import { createRouter, createWebHistory } from 'vue-router'
import { isLoggedIn } from './auth.js'
import Login from './views/Login.vue'
import Resumes from './views/Resumes.vue'
import Applications from './views/Applications.vue'
import Profile from './views/Profile.vue'
import Match from './views/Match.vue'
import ResumeBuilder from './views/ResumeBuilder.vue'
import Home from './views/Home.vue'
import Interview from './views/Interview.vue'
import Report from './views/Report.vue'
import Records from './views/Records.vue'
import RecordDetail from './views/RecordDetail.vue'
import Apply from './views/Apply.vue'
// Salary / Intro / Mistakes / Prep / Ammo 不再单独挂路由，
// 它们作为模块被 InterviewPrep 直接 import（动态路由跳转也就没有了首屏成本）
import InterviewPrep from './views/InterviewPrep.vue'
import Backup from './views/Backup.vue'
import Dashboard from './views/Dashboard.vue'
import Funnel from './views/Funnel.vue'
import Settings from './views/Settings.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login, meta: { public: true } },
    { path: '/', redirect: '/dashboard' },
    // 总览
    { path: '/dashboard', component: Dashboard },
    { path: '/funnel', component: Funnel },
    // 求职执行
    { path: '/applications', component: Applications },
    { path: '/profile', component: Profile },
    { path: '/match', component: Match },
    { path: '/resumes', component: Resumes },
    // 简历工作台
    { path: '/resume-builder', component: ResumeBuilder },
    // 面试准备
    { path: '/home', component: Home },
    { path: '/interview', component: Interview },
    { path: '/report', component: Report },
    { path: '/records', component: Records },
    { path: '/records/:id', component: RecordDetail },
    // 面试工作台：弹药 / 自我介绍 / 准备清单 / 错题本 / 薪资谈判 五个模块共用一份上下文
    // （2026-11-06 合并：这五件事的输入是同一份「岗位+简历」，散成五页就是五次重复粘贴）
    { path: '/interview-prep', component: InterviewPrep },
    // 旧地址保留为跳转：书签、浏览器历史、之前发给自己的链接都不会断
    { path: '/ammo', redirect: { path: '/interview-prep', query: { tab: 'ammo' } } },
    { path: '/intro', redirect: { path: '/interview-prep', query: { tab: 'intro' } } },
    { path: '/prep', redirect: { path: '/interview-prep', query: { tab: 'prep' } } },
    { path: '/mistakes', redirect: { path: '/interview-prep', query: { tab: 'mistakes' } } },
    { path: '/salary', redirect: { path: '/interview-prep', query: { tab: 'salary' } } },
    { path: '/apply', component: Apply },
    // 数据管理
    { path: '/backup', component: Backup },
    { path: '/settings', component: Settings },
  ],
})

/**
 * 前端守卫只负责「没 token 就别进来」这种体验层的事。
 * 真正的权限在后端：即使改掉 localStorage 绕过这里，每个接口照样 401。
 */
router.beforeEach((to) => {
  if (to.meta.public) {
    // 已登录还去登录页 → 回总览
    return isLoggedIn.value && to.path === '/login' ? '/dashboard' : true
  }
  if (!isLoggedIn.value) {
    return { path: '/login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  return true
})

export default router
