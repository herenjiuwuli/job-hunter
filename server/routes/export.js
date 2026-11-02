import { Router } from 'express'
import { readJSON } from '../lib/store.js'

const router = Router()

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把结构化简历序列化为「自包含 A4 HTML 文档」（含内联打印样式），
 * 前端直接开新窗口打印 / 另存为 PDF。零依赖，不引入任何模板资源。
 * 思路来自 make-resume 的「可编辑 HTML + print-preview QA + 浏览器打印导出 PDF」。
 */
function buildResumeHtml(r) {
  const b = r.basic || {}
  const basicLine = [
    b.phone && `电话：${b.phone}`,
    b.email && `邮箱：${b.email}`,
    b.city && `城市：${b.city}`,
    b.school && `学校：${b.school}`,
    b.major && `专业：${b.major}`,
    b.education && `学历：${b.education}`,
    b.graduationYear && `毕业：${b.graduationYear}`,
  ].filter(Boolean)

  const skills = (r.skills || []).map(esc)
  const experiences = (r.experiences || []).map((e) => ({
    company: esc(e.company),
    role: esc(e.role),
    range: esc([e.start, e.end].filter(Boolean).join(' - ')),
    points: (e.points || []).map(esc),
  }))
  const projects = (r.projects || []).map((p) => ({
    name: esc(p.name),
    role: esc(p.role),
    desc: esc(p.desc),
    highlights: (p.highlights || []).map(esc),
  }))

  const expHtml = experiences
    .map(
      (e) => `<div class="entry">
        <div class="entry-head"><span class="entry-title">${e.company}${e.role ? ' · ' + e.role : ''}</span><span class="entry-range">${e.range}</span></div>
        ${e.points.map((p) => `<div class="li">${p}</div>`).join('')}
      </div>`
    )
    .join('')

  const projHtml = projects
    .map(
      (p) => `<div class="entry">
        <div class="entry-head"><span class="entry-title">${p.name}${p.role ? ' · ' + p.role : ''}</span></div>
        ${p.desc ? `<div class="desc">${p.desc}</div>` : ''}
        ${p.highlights.map((h) => `<div class="li">${h}</div>`).join('')}
      </div>`
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>${esc(r.title || '简历')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    color: #1f2937; font-size: 13px; line-height: 1.6; background: #fff;
  }
  .sheet { max-width: 800px; margin: 0 auto; padding: 28px 32px; }
  .name { font-size: 24px; font-weight: 700; }
  .target { color: #4f46e5; font-size: 13px; margin: 2px 0 8px; }
  .contact { color: #6b7280; font-size: 12.5px; margin-bottom: 14px; }
  .contact span { margin-right: 12px; }
  h2 { font-size: 14px; font-weight: 700; color: #4f46e5; border-bottom: 2px solid #4f46e5; padding-bottom: 3px; margin: 16px 0 8px; }
  .skills { display: flex; flex-wrap: wrap; gap: 6px; }
  .skills span { background: #eef2ff; color: #4f46e5; padding: 2px 10px; border-radius: 999px; font-size: 12px; }
  .entry { margin-bottom: 10px; }
  .entry-head { display: flex; justify-content: space-between; font-weight: 600; }
  .entry-range { color: #6b7280; font-weight: 400; font-size: 12px; }
  .desc { color: #374151; margin: 2px 0; }
  .li { position: relative; padding-left: 14px; }
  .li::before { content: '•'; position: absolute; left: 2px; color: #4f46e5; }
  .self { color: #374151; }
  @media print {
    @page { margin: 14mm; }
    body { background: #fff; }
    .sheet { padding: 0; max-width: none; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <div class="name">${esc(b.name || r.title || '未命名')}</div>
    ${r.target ? `<div class="target">求职意向：${esc(r.target)}</div>` : ''}
    ${basicLine.length ? `<div class="contact">${basicLine.map((x) => `<span>${x}</span>`).join('')}</div>` : ''}
    ${skills.length ? `<h2>技能</h2><div class="skills">${skills.map((s) => `<span>${s}</span>`).join('')}</div>` : ''}
    ${experiences.length ? `<h2>工作 / 实习经历</h2>${expHtml}` : ''}
    ${projects.length ? `<h2>项目经历</h2>${projHtml}` : ''}
    ${r.selfEvaluation ? `<h2>自我评价</h2><div class="self">${esc(r.selfEvaluation)}</div>` : ''}
  </div>
</body>
</html>`
}

// POST /api/resume/export { resumeId }
// 返回自包含简历 HTML 文档字符串，前端开新窗口打印 / 另存 PDF。
router.post('/api/resume/export', async (req, res) => {
  const { resumeId } = req.body || {}
  if (!resumeId) return res.status(400).json({ error: '请指定简历' })

  const resumes = (await readJSON('resumes')) || []
  const resume = resumes.find((r) => r.id === resumeId)
  if (!resume) return res.status(404).json({ error: '简历不存在' })

  try {
    res.json({ html: buildResumeHtml(resume) })
  } catch (err) {
    console.error('[resume/export] failed:', err.message)
    res.status(500).json({ error: '简历导出失败：' + err.message })
  }
})

export default router
