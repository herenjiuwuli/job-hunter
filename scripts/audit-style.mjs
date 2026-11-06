// 样式审计：行内 style 数量 + 越界字号/间距（临时脚本，可删）
import fs from 'node:fs'
import path from 'node:path'

const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      if (f !== 'node_modules') walk(p)
    } else if (f.endsWith('.vue')) files.push(p)
  }
})('src')

const OK_FS = ['11', '12', '13', '15', '20', '28']
const rows = []
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  const inline = (s.match(/style="/g) || []).length
  const sizes = {}
  for (const m of s.matchAll(/font-size:\s*([\d.]+)px/g)) sizes[m[1]] = (sizes[m[1]] || 0) + 1
  const bad = Object.entries(sizes).filter(([v]) => !OK_FS.includes(v))
  if (inline || bad.length) {
    rows.push({
      f: f.replace(/\\/g, '/'),
      inline,
      all: Object.entries(sizes).map(([v, n]) => `${v}x${n}`).join(' '),
      bad: bad.map(([v, n]) => `${v}x${n}`).join(' '),
    })
  }
}
rows.sort((a, b) => b.inline - a.inline)
for (const r of rows) {
  console.log(r.f.padEnd(34), `inline=${String(r.inline).padStart(2)}`, '| fs:', r.all, r.bad ? `| 越界: ${r.bad}` : '')
}
console.log('文件数', files.length, '合计 inline', rows.reduce((a, b) => a + b.inline, 0))
