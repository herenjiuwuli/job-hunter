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
import Salary from './views/Salary.vue'
import Intro from './views/Intro.vue'
import Mistakes from './views/Mistakes.vue'
import Prep from './views/Prep.vue'
import Ammo from './views/Ammo.vue'
import Backup from './views/Backup.vue'
import Dashboard from './views/Dashboard.vue'
import Settings from './views/Settings.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: Login, meta: { public: true } },
    { path: '/', redirect: '/dashboard' },
    // 总览
    { path: '/dashboard', component: Dashboard },
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
    { path: '/apply', component: Apply },
    { path: '/salary', component: Salary },
    { path: '/intro', component: Intro },
    { path: '/mistakes', component: Mistakes },
    { path: '/prep', component: Prep },
    { path: '/ammo', component: Ammo },
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
