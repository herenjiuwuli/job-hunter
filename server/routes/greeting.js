import { Router } from 'express'
import { readJSON, updateJSON } from '../lib/store.js'
import { isMine } from '../lib/scope.js'

/**
 * 打招呼语（BOSS 的「投递」＝发出这条消息，所以它是投递的前置条件）。
 *
 * 为什么要放到后端：以前只能把话术粘进扩展的 textarea，粘一次只对当前页面有效；
 * 在网页端「AI 定制」生成的每岗话术，扩展根本拿不到 —— 于是每次投递都要
 * 「复制 → 切弹窗 → 粘贴」，话术越好用越费事。
 *
 * 两级来源，优先级从高到低：
 *   1. 这条投递记录自己的 `greeting`（网页端「AI 定制」生成的，最贴合这个岗位）
 *   2. 用户设的**默认话术**（greeting.json），支持占位符 `{{公司}}` / `{{岗位}}`
 *   3. 空 —— 扩展那边就会提示「先填话术」
 *
 * 存储：greeting.json = { [ownerId]: { text, updatedAt } }
 * 不放 profile.json：画像是「AI 不能瞎编的事实」，话术是「可以随时改的模板」，
 * 混在一起以后想按方向/岗位分模板就没地方放了。
 */
const router = Router()

const KEY = 'greeting'
const MAX_LEN = 2000

function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·、,，。()（）[\]【】/|]/g, '')
}

/** 岗位名归一化：剥掉平台列表页的尾巴，否则「测试实习生实习招聘」跟「测试实习生」对不上 */
function normTitle(s) {
  return normKey(s).replace(/(实习招聘|校园招聘|社会招聘|长期招聘|招聘|急招|热招)$/, '')
}

/**
 * 占位符替换。
 *
 * 为什么要有：默认话术是一段通用的，但 BOSS 上具名岗位的回复率明显高于「你好」。
 * 让用户在网页上写一次 `您好，看到贵司的{{岗位}}…`，扩展执行时自动填成具体岗位。
 * 认不出的占位符原样留着 —— 悄悄删掉会让人以为模板写错了。
 */
function fillTemplate(text, company, jobTitle) {
  return String(text || '')
    .replace(/\{\{\s*公司\s*\}\}/g, company || '贵司')
    .replace(/\{\{\s*岗位\s*\}\}/g, jobTitle || '这个岗位')
}

/**
 * GET /api/greeting?company=正浩创新&jobTitle=数据运营实习生
 *
 * 返回 { text, source: 'application' | 'default' | '', matched }
 * 不带参数时只回默认话术（扩展在没有岗位信息时也能用）。
 */
router.get('/api/greeting', async (req, res) => {
  const company = String(req.query.company || '').trim()
  const jobTitle = String(req.query.jobTitle || '').trim()

  const all = (await readJSON('applications')) || []
  const mine = all.filter((x) => isMine(x, req.userId))

  if (jobTitle) {
    const want = normTitle(jobTitle)
    const sameTitle = mine.filter((x) => normTitle(x.jobTitle) === want && String(x.greeting || '').trim())
    // 公司也对得上的优先；同一条岗位可能投过两次，取最近更新的一条
    const both = company
      ? sameTitle.filter((x) => {
          const lc = normKey(x.company)
          const rc = normKey(company)
          return lc && rc && (lc === rc || lc.includes(rc) || rc.includes(lc))
        })
      : []
    const pick = (both.length ? both : sameTitle).sort(
      (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    )[0]
    if (pick) {
      return res.json({
        text: String(pick.greeting).trim(),
        source: 'application',
        matched: { company: pick.company, jobTitle: pick.jobTitle },
      })
    }
  }

  const map = (await readJSON(KEY)) || {}
  const tpl = String((map[req.userId] && map[req.userId].text) || '').trim()
  if (tpl) {
    return res.json({ text: fillTemplate(tpl, company, jobTitle), source: 'default', matched: null })
  }
  return res.json({ text: '', source: '', matched: null })
})

/** 读默认话术原文（带占位符，给网页端编辑用；不要拿它去投递） */
router.get('/api/greeting/default', async (req, res) => {
  const map = (await readJSON(KEY)) || {}
  const me = map[req.userId] || {}
  res.json({ text: String(me.text || ''), updatedAt: me.updatedAt || '' })
})

/** PUT /api/greeting/default { text } */
router.put('/api/greeting/default', async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, MAX_LEN)
  const now = new Date().toISOString()
  const out = await updateJSON(
    KEY,
    (cur) => {
      const map = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {}
      return { ...map, [req.userId]: { text, updatedAt: now } }
    },
    {}
  )
  res.json({ ok: true, text: out[req.userId].text, updatedAt: now })
})

export default router
