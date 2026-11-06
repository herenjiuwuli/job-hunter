// 列出越界字号所在的选择器（临时脚本，可删）
import fs from 'node:fs'
import path from 'node:path'

const OK = ['11', '12', '13', '15', '20', '28', '40']
const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f)
    if (fs.statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.vue')) files.push(p)
  }
})('src')

for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  lines.forEach((ln, i) => {
    const m = ln.match(/font-size:\s*([\d.]+)px/)
    if (!m || OK.includes(m[1])) return
    // 往上找最近的选择器
    let sel = ''
    for (let k = i; k >= 0 && k > i - 12; k--) {
      const s = lines[k].match(/^\s*([.#][\w-]+[^{]*)\{\s*$/)
      if (s) {
        sel = s[1].trim()
        break
      }
    }
    console.log(`${f.replace(/\\/g, '/')}:${i + 1}  ${m[1]}px   ${sel}`)
  })
}
