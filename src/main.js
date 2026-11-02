import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import { setOnUnauthorized } from './api.js'
import './style.css'

// 任何接口返回 401（token 过期/被清）都统一回登录页，不再由各视图各自处理
setOnUnauthorized(() => {
  if (router.currentRoute.value.path !== '/login') router.push('/login')
})

createApp(App).use(router).mount('#app')
