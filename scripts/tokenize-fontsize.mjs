/**
 * font-size 字面值 → CSS 变量（一次性脚本，2026-11-06）
 * 只映射 7 个合法档位，其余（如移动端 input 的 16px）原样保留。
 */
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = {
  11: 'var(--fs-2xs)',
  12: 'var(--fs-xs)',
  13: 'var(--fs-sm)',
  15: 'var(--fs-md)',
  20: 'var(--fs-lg)',
  28: 'var(--fs-xl)',
  40: 'var(--fs-2xl)',
}

const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.vue')) files.push(p)
  }
})('src')

let total = 0
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  let n = 0
  const out = s.replace(/font-size:\s*(\d+)px/g, (m, px) => {
    const t = TOKEN[px]
    if (!t) return m
    n++
    return `font-size: ${t}`
  })
  if (n) {
    fs.writeFileSync(f, out, 'utf8')
    total += n
    console.log(f.replace(/\\/g, '/'), n)
  }
}
console.log('合计', total)
