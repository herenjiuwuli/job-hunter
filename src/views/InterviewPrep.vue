<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prepCtx } from '../store.js'
import Ammo from './Ammo.vue'
import Intro from './Intro.vue'
import Prep from './Prep.vue'
import Mistakes from './Mistakes.vue'
import Salary from './Salary.vue'

/**
 * 面试工作台：把「对着面试做准备」的五件事收进一页。
 *
 * 为什么合并（2026-11-06，本人原话「弹药也好、自我介绍也好、模拟面试也好，
 * 我觉得功能都是相同的」）：
 * 它们确实不是同一件事 —— 弹药出素材、自我介绍改稿、清单列待办、错题本记复盘、
 * 薪资练谈钱。但**从使用者角度看**，五件事都要先回答同一个问题：「我拿哪份简历、
 * 投的哪个岗」。原来五页各问一遍，五次里有三次是重复劳动，页面看着就像在重复。
 *
 * 所以这里不合并「功能」，合并「输入」：
 * 一份上下文（岗位 + 简历 + JD）五个模块共用，模块本身保持独立，谁擅长什么还归谁。
 * 模拟面试不在这里 —— 它是有状态的连续对话，塞进 tab 每次切走就断了。
 */
const route = useRoute()
const router = useRouter()

const TABS = [
  {
    key: 'ammo',
    label: '项目弹药',
    comp: Ammo,
    hint: '把项目变成能扛住深挖的答案：技术亮点、我改过的点、关源码复现清单。',
  },
  {
    key: 'intro',
    label: '自我介绍',
    comp: Intro,
    hint: '写完稿子逐句点评，给评分、改进建议和同场景更优示例。',
  },
  {
    key: 'prep',
    label: '准备清单',
    comp: Prep,
    hint: '面这家公司之前要准备的事，按优先级排序，勾选进度自动保存。',
  },
  {
    key: 'mistakes',
    label: '错题本',
    comp: Mistakes,
    hint: '答砸过的题按错误类型归档，下次面试前先过一遍。',
  },
  {
    key: 'salary',
    label: '薪资谈判',
    comp: Salary,
    hint: '模拟 HR 谈薪，练怎么开口要数字，不被第一轮压价带走。',
  },
]

// tab 状态放在 URL 上：刷新、收藏、从别处跳进来都能回到同一个模块
const active = computed(() => {
  const k = String(route.query.tab || '')
  return TABS.some((t) => t.key === k) ? k : 'ammo'
})

const current = computed(() => TABS.find((t) => t.key === active.value))
const currentComp = computed(() => current.value.comp)
const currentHint = computed(() => current.value.hint)

function go(k) {
  if (k === active.value) return
  router.replace({ path: '/interview-prep', query: { tab: k } })
}

// 上下文填全了就自动收起，把屏幕让给结果；没填全就摊开催着填
const collapsed = ref(false)
const ready = computed(() => !!prepCtx.job.trim() && !!prepCtx.resume.trim())

watch(
  ready,
  (ok) => {
    collapsed.value = ok
  },
  { immediate: true }
)

const resumeLen = computed(() => prepCtx.resume.trim().length)
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">面试工作台</h1>
        <div class="page-sub">岗位和简历只需填一次，下面五个模块共用。</div>
      </div>
      <div class="page-actions">
        <router-link to="/interview" class="btn btn-ghost">去模拟面试 →</router-link>
      </div>
    </div>

    <!-- 共享上下文：这是整个页面「不再重复」的关键，所以放最上、始终可见 -->
    <section class="ctx" :class="{ 'ctx-ok': ready }">
      <div class="ctx-head">
        <span class="ctx-title">面试上下文</span>
        <span class="ctx-state">
          <template v-if="ready">已填好 · 5 个模块共用</template>
          <template v-else>缺岗位或简历，模块会拒绝生成</template>
        </span>
        <button class="ctx-toggle" type="button" @click="collapsed = !collapsed">
          {{ collapsed ? '展开' : '收起' }}
        </button>
      </div>

      <div v-show="!collapsed" class="ctx-body">
        <div class="ctx-row">
          <label class="ctx-field ctx-field-job">
            <span class="ctx-label">目标岗位</span>
            <input
              v-model="prepCtx.job"
              class="input"
              placeholder="如 软件测试工程师 / 内容运营（校招）"
            />
          </label>
          <label class="ctx-field">
            <span class="ctx-label">目标公司 JD（可选，清单和谈判会更贴合）</span>
            <input v-model="prepCtx.jd" class="input" placeholder="粘贴招聘页的职位描述，或留空" />
          </label>
        </div>
        <label class="ctx-field">
          <span class="ctx-label">
            简历内容
            <em class="ctx-count">{{ resumeLen }} 字</em>
          </span>
          <textarea
            v-model="prepCtx.resume"
            class="textarea ctx-resume"
            placeholder="粘贴简历正文。五个模块都读这一份，改一次全部生效。"
          ></textarea>
        </label>
      </div>
    </section>

    <div class="tabs">
      <button
        v-for="t in TABS"
        :key="t.key"
        class="tab"
        :class="{ active: active === t.key }"
        type="button"
        @click="go(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <p class="tab-hint">{{ currentHint }}</p>

    <!-- keep-alive：切走再切回来别把刚生成的弹药清空（重新生成要花钱和时间） -->
    <div class="prep-module">
      <KeepAlive>
        <component :is="currentComp" :key="active" />
      </KeepAlive>
    </div>
  </div>
</template>

<style scoped>
.ctx {
  border: 1px solid var(--border);
  border-radius: var(--r-surface);
  background: #fafafa;
  margin-bottom: var(--s-5);
}

/* 填全了改成白底，给一个"可以开干了"的视觉信号 */
.ctx-ok {
  background: #fff;
}

.ctx-head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-4);
  border-bottom: 1px solid var(--border);
}

.ctx-title {
  font-size: var(--fs-xs);
  font-weight: 650;
  letter-spacing: -0.01em;
}

.ctx-state {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  flex: 1;
}

/* 缺上下文的提示要显眼 —— 它是「现在点生成会失败」的唯一前置信号 */
.ctx:not(.ctx-ok) .ctx-state {
  color: var(--c-amber);
  font-weight: 550;
}

.ctx-toggle {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  font-family: inherit;
  cursor: pointer;
  padding: var(--s-1);
}

.ctx-toggle:hover {
  color: var(--text);
}

.ctx-body {
  padding: var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.ctx-row {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: var(--s-3);
}

.ctx-field {
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
  min-width: 0;
}

.ctx-label {
  font-size: var(--fs-2xs);
  font-weight: 600;
  color: var(--text-secondary);
  display: flex;
  align-items: baseline;
  gap: var(--s-1);
}

.ctx-count {
  font-style: normal;
  font-weight: 500;
  color: var(--text-faint);
  font-size: var(--fs-2xs);
}

/* 模块说明：左侧一道灰线当「引文」，比灰底块轻，也不抢 tab 的注意力 */
.tab-hint {
  margin: calc(var(--s-2) * -1) 0 var(--s-4);
  padding-left: var(--s-2);
  border-left: 2px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--text-faint);
  line-height: 1.6;
}

/* 简历框比默认高一点：它要贴整份简历，太矮会让人以为只能写两行 */
.ctx-resume {
  min-height: 88px;
}

/* 模块原本是独立页，头部各带一个 h1。嵌进来以后会和 tab 名重复一遍，
   既占高度又让人看两次同样的字，所以整块藏掉。
   ⚠️ 必须挂在 .prep-module 下：写成裸 `:deep(.page-head)` 会编译成
   `[data-v-x] .page-head`，而工作台自己的 page-head 也在同一个根节点里，
   标题会连自己一起被藏掉（2026-11-06 踩过）。 */
.prep-module :deep(.page-head) {
  display: none;
}

/* 同理：模块自己的卡片已经是页面第一块，不要再叠 margin-top */
.prep-module :deep(.card:first-child) {
  margin-top: 0;
}

@media (max-width: 768px) {
  .ctx-row {
    grid-template-columns: 1fr;
  }
}
</style>
