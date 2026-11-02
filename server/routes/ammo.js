import { Router } from 'express'
import { chatJSON } from '../lib/ai.js'

const router = Router()

// POST /api/ammo  { projectName, targetRole, projectContext, resumeText? }
// 把「AI 协作生成」的项目，转化成用户能讲、且诚实的面试弹药 + 关源码复现清单。
// 方法论来自 interview-ammo-docs：逼出诚实边界，防止面试装成全独立手写后一问就露馅。
router.post('/api/ammo', async (req, res) => {
  const { projectName, targetRole, projectContext, resumeText } = req.body || {}

  if (!String(projectName || '').trim()) {
    return res.status(400).json({ error: '请填写项目名称' })
  }
  if (!String(projectContext || '').trim()) {
    return res.status(400).json({ error: '请粘贴项目真实材料（README / 核心代码 / 你定需求与验收标准的记录），越真实弹药越准' })
  }

  const systemPrompt = `你帮一位「需求自己定、AI 协作实现」的候选人，把他做的项目转化成面试能讲、且诚实的材料。
核心目的：把「AI 写的」变成「候选人能讲的」，并逼出诚实边界（防止面试装成全独立手写、一问就露馅）。

铁律：
1. 开头必须给出「诚实边界」段：明确本项目是协作产出，正确讲法是「需求/验收标准/缺陷判定是我定的，技术方案我逐条复现」，并提醒带 ✅ 的必须自己能答、带 ⚠️ 的至少讲清思路。
2. 凡材料里出现规模数字（表数/接口数/用例数/文件数），除非用户明确写「实测」，一律在对应亮点标 ⚠️「待你自测」，不要当作已验证；不要替用户编造数字。
3. 不替用户拍板「能不能答」。亮点标 ✅ 还是 ⚠️ 要基于材料里是否看得到证据，看不出证据的标 ⚠️。
4. 「我改过的点」每条必须写「怎么被发现的」（最能体现测试思维）；状态只能取 ✅（关源码能写出来）/ ❌（写不出）/ ⚠️（待自测）。
5. 不虚构经历、技术栈、数据；只基于用户提供的材料组织表达。

输出严格 JSON（不要输出 JSON 以外的任何内容）：
{
  "honestyBoundary": "诚实边界段（2-3 句，写明协作产出性质与正确讲法）",
  "oneLiner": "一句话定位（技术栈+规模+一句差异化，两行内）",
  "highlights": [
    { "name": "亮点名（优先挑有取舍的点）", "fact": "事实/代码引用（具体函数名/字段/机制）", "why": "为什么这么设计 / 为什么不用更省事的方案", "mark": "✅|⚠️" }
  ],
  "myChanges": [
    { "what": "我改过的地方 / 拍板的决策", "why": "为什么这么改", "howFound": "怎么被发现的（哪一层测试/什么现象）", "status": "✅|❌|⚠️" }
  ],
  "deepDive": [
    { "q": "面试官会问的问题（要有具体机制，不空话）", "a": "两行内参考答案" }
  ],
  "closing": "一句话收尾（被问最大难点/最得意什么时的口语答案，80-150 字，有细节有转折有认知升级）",
  "reproduce": [
    { "topic": "复现主题", "action": "关掉源码能做到的具体动作（如'白纸写出 X 函数每一步'）", "ref": "对照的真实文件路径与函数名" }
  ],
  "demoRound": "用一题做完整示范：标准答案（可直接拿去 diff），并诚实标明这是标准答案不是用户凭记忆写的",
  "scoring": "评分标准（核心函数 ❌ 就别写进简历技术亮点；全 ✅ 才敢投）",
  "mistakeBook": [
    { "q": "题号/主题", "wrong": "容易写错或卡住的点", "right": "正确做法", "remember": "下次怎么记住" }
  ]
}
要求：highlights 4-6 条、myChanges 4-6 条、deepDive 8-12 题（必含一道「你怎么发现某缺陷的」）、reproduce 7-10 题（必须有一题是项目最核心函数并标 ⭐⭐）、mistakeBook 4-6 条。全部简体中文。`

  try {
    const data = await chatJSON([
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `项目名称：${String(projectName).slice(0, 80)}
目标岗位：${String(targetRole || '测试开发 / 前端').slice(0, 80)}

项目真实材料（用户粘贴）：
${String(projectContext).slice(0, 9000)}

${resumeText ? `候选人简历（用于核对经历一致性）：\n${String(resumeText).slice(0, 2000)}\n` : ''}
请生成面试弹药 + 关源码复现清单，严格输出 JSON。`,
      },
    ])

    const arr = (v) => (Array.isArray(v) ? v : [])
    const cleanMark = (m) => (['✅', '⚠️'].includes(m) ? m : '⚠️')
    const cleanStatus = (s) => (['✅', '❌', '⚠️'].includes(s) ? s : '⚠️')

    res.json({
      honestyBoundary: String(data.honestyBoundary || ''),
      oneLiner: String(data.oneLiner || ''),
      highlights: arr(data.highlights).slice(0, 8).map((h) => ({
        name: String(h.name || ''),
        fact: String(h.fact || ''),
        why: String(h.why || ''),
        mark: cleanMark(h.mark),
      })),
      myChanges: arr(data.myChanges).slice(0, 8).map((c) => ({
        what: String(c.what || ''),
        why: String(c.why || ''),
        howFound: String(c.howFound || ''),
        status: cleanStatus(c.status),
      })),
      deepDive: arr(data.deepDive).slice(0, 14).map((d) => ({
        q: String(d.q || ''),
        a: String(d.a || ''),
      })),
      closing: String(data.closing || ''),
      reproduce: arr(data.reproduce).slice(0, 12).map((r) => ({
        topic: String(r.topic || ''),
        action: String(r.action || ''),
        ref: String(r.ref || ''),
      })),
      demoRound: String(data.demoRound || ''),
      scoring: String(data.scoring || ''),
      mistakeBook: arr(data.mistakeBook).slice(0, 8).map((m) => ({
        q: String(m.q || ''),
        wrong: String(m.wrong || ''),
        right: String(m.right || ''),
        remember: String(m.remember || ''),
      })),
    })
  } catch (err) {
    console.error('[ammo] failed:', err.message)
    res.status(500).json({ error: '面试弹药生成失败：' + err.message })
  }
})

export default router
