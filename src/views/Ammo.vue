<script setup>
import { ref } from 'vue'
import { api } from '../api.js'

const projectName = ref('')
const targetRole = ref('测试开发 / 前端')
const projectContext = ref('')
const resumeText = ref('')
const loading = ref(false)
const message = ref('')
const messageError = ref(false)
const result = ref(null)

async function generate() {
  if (!projectName.value.trim()) {
    message.value = '请填写项目名称'
    messageError.value = true
    return
  }
  if (!projectContext.value.trim()) {
    message.value = '请粘贴项目真实材料（README / 核心代码 / 你定需求与验收标准的记录）'
    messageError.value = true
    return
  }
  loading.value = true
  message.value = ''
  messageError.value = false
  try {
    result.value = await api.ammo({
      projectName: projectName.value.trim(),
      targetRole: targetRole.value.trim(),
      projectContext: projectContext.value,
      resumeText: resumeText.value.trim(),
    })
  } catch (e) {
    message.value = e.message
    messageError.value = true
  } finally {
    loading.value = false
  }
}

const MARK_CLASS = { '✅': 'mk-ok', '⚠️': 'mk-warn' }
const STATUS_CLASS = { '✅': 'mk-ok', '❌': 'mk-bad', '⚠️': 'mk-warn' }
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1 class="page-title">面试弹药自检</h1>
        <div class="page-sub">把「AI 协作生成」的项目，变成你关掉源码也能讲的诚实弹药 + 关源码复现清单</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 18px;">
      <div class="grid-2">
        <div class="field" style="margin: 0;">
          <label class="label">项目名称 <span class="req">*</span></label>
          <input v-model="projectName" class="input" placeholder="如 job-hunter / api-test-platform" />
        </div>
        <div class="field" style="margin: 0;">
          <label class="label">目标岗位</label>
          <input v-model="targetRole" class="input" placeholder="测试开发 / 前端" />
        </div>
      </div>
      <div class="field" style="margin-top: 14px;">
        <label class="label">项目真实材料 <span class="req">*</span></label>
        <textarea v-model="projectContext" class="textarea" style="min-height: 140px;" placeholder="粘贴 README、核心代码、你定需求与验收标准的记录。越真实，弹药越准；材料里出现的规模数字若非实测，会标 ⚠️ 待你自测。"></textarea>
      </div>
      <div class="field">
        <label class="label">简历原文（可选，用于核对经历一致性）</label>
        <textarea v-model="resumeText" class="textarea" style="min-height: 80px;" placeholder="可留空"></textarea>
      </div>
      <button class="btn btn-primary" :disabled="loading" @click="generate">
        {{ loading ? '生成中…' : '生成面试弹药' }}
      </button>
      <div v-if="message" class="msg" :class="{ 'msg-error': messageError }" style="margin-top: 10px;">{{ message }}</div>
    </div>

    <div v-if="result" class="card result-card">
      <div v-if="result.honestyBoundary" class="honesty">
        ⚠️ 诚实边界：{{ result.honestyBoundary }}
      </div>

      <section v-if="result.oneLiner">
        <h3 class="sec-title">一句话定位</h3>
        <p>{{ result.oneLiner }}</p>
      </section>

      <section v-if="result.highlights.length">
        <h3 class="sec-title">技术亮点（✅ 必须自己能答，⚠️ 至少讲清思路）</h3>
        <div v-for="(h, i) in result.highlights" :key="'h' + i" class="item">
          <div class="item-head">
            <span class="tag" :class="MARK_CLASS[h.mark]">{{ h.mark }}</span>
            <span class="item-name">{{ h.name }}</span>
          </div>
          <div class="item-fact">{{ h.fact }}</div>
          <div class="item-why muted">为什么：{{ h.why }}</div>
        </div>
      </section>

      <section v-if="result.myChanges.length">
        <h3 class="sec-title">我改过的点 + 为什么（面试前必填）</h3>
        <table class="tbl">
          <thead>
            <tr><th>我改过的地方 / 拍板的决策</th><th>为什么</th><th>怎么被发现</th><th style="width:60px;">状态</th></tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in result.myChanges" :key="'c' + i">
              <td>{{ c.what }}</td>
              <td>{{ c.why }}</td>
              <td>{{ c.howFound }}</td>
              <td><span class="tag" :class="STATUS_CLASS[c.status]">{{ c.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section v-if="result.deepDive.length">
        <h3 class="sec-title">高频深挖题 + 参考答案（先理解再背）</h3>
        <div v-for="(d, i) in result.deepDive" :key="'d' + i" class="item">
          <div class="item-name">Q{{ i + 1 }}. {{ d.q }}</div>
          <div class="item-fact">{{ d.a }}</div>
        </div>
      </section>

      <section v-if="result.closing">
        <h3 class="sec-title">一句话收尾</h3>
        <p>{{ result.closing }}</p>
      </section>

      <section v-if="result.reproduce.length">
        <h3 class="sec-title">关源码复现清单（关掉源码写，再对照 diff）</h3>
        <div v-for="(r, i) in result.reproduce" :key="'r' + i" class="item">
          <div class="item-head">
            <span class="item-name">{{ i + 1 }}. {{ r.topic }}</span>
          </div>
          <div class="item-fact">动作：{{ r.action }}</div>
          <div class="item-why muted">对照：{{ r.ref }}</div>
        </div>
      </section>

      <section v-if="result.demoRound">
        <h3 class="sec-title">示范轮（标准答案，拿去 diff）</h3>
        <p class="muted">{{ result.demoRound }}</p>
      </section>

      <section v-if="result.scoring">
        <h3 class="sec-title">评分标准</h3>
        <p class="muted">{{ result.scoring }}</p>
      </section>

      <section v-if="result.mistakeBook.length">
        <h3 class="sec-title">错题本模板</h3>
        <table class="tbl">
          <thead>
            <tr><th>题</th><th>容易写错/卡住</th><th>正确做法</th><th>怎么记住</th></tr>
          </thead>
          <tbody>
            <tr v-for="(m, i) in result.mistakeBook" :key="'m' + i">
              <td>{{ m.q }}</td>
              <td>{{ m.wrong }}</td>
              <td>{{ m.right }}</td>
              <td>{{ m.remember }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>
</template>

<style scoped>
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.honesty {
  background: #fff7ed;
  border: 1px solid #fed7aa;
  color: #c2410c;
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  margin-bottom: 18px;
}
.sec-title {
  font-size: 14px;
  font-weight: 700;
  margin: 20px 0 10px;
  padding-left: 9px;
  border-left: 3px solid var(--primary);
}
section:first-of-type .sec-title {
  margin-top: 0;
}
.item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.item-name {
  font-weight: 600;
  font-size: 13.5px;
}
.item-fact {
  font-size: 13px;
  line-height: 1.6;
}
.item-why {
  font-size: 12.5px;
  margin-top: 3px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.tbl th,
.tbl td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.tbl th {
  color: var(--text-dim);
  font-weight: 600;
  background: #fafafa;
}
.muted {
  color: var(--text-secondary);
}
.mk-ok { background: #e8f7ef; color: #18a058; }
.mk-warn { background: #fef4e6; color: #c47d10; }
.mk-bad { background: #fde8e8; color: #dc2626; }
</style>
