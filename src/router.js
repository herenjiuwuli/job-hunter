import { createRouter, createWebHistory } from 'vue-router'
import Resumes from './views/Resumes.vue'
import Applications from './views/Applications.vue'
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

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/applications' },
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
  ],
})
