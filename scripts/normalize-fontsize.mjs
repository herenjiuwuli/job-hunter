/**
 * 字号归一（一次性脚本，2026-11-06）：把半像素/越界字号收进 7 档。
 * 用「文件 + 行号 + 旧值」精确替换，避免误伤同名数值。
 */
import fs from 'node:fs'

const MAP = [
  ['src/views/Ammo.vue', 187, '14', '15'],
  ['src/views/Ammo.vue', 210, '13.5', '13'],
  ['src/views/Ammo.vue', 217, '12.5', '12'],
  ['src/views/Ammo.vue', 223, '12.5', '12'],
  ['src/views/Apply.vue', 163, '14', '13'],
  ['src/views/Backup.vue', 198, '24', '28'],
  ['src/views/Funnel.vue', 219, '22', '28'],
  ['src/views/Home.vue', 322, '14', '13'],
  ['src/views/Home.vue', 346, '14', '13'],
  ['src/views/Home.vue', 426, '12.5', '12'],
  ['src/views/Home.vue', 456, '13.5', '13'],
  ['src/views/Interview.vue', 506, '14', '13'],
  ['src/views/InterviewPrep.vue', 191, '12.5', '12'],
  ['src/views/InterviewPrep.vue', 197, '11.5', '11'],
  ['src/views/InterviewPrep.vue', 212, '11.5', '11'],
  ['src/views/InterviewPrep.vue', 243, '11.5', '11'],
  ['src/views/Intro.vue', 157, '14', '13'],
  ['src/views/Intro.vue', 197, '36', '40'],
  ['src/views/Match.vue', 300, '14', '13'],
  ['src/views/Match.vue', 326, '12.5', '12'],
  ['src/views/Prep.vue', 177, '14', '13'],
  ['src/views/Prep.vue', 276, '14', '15'],
  ['src/views/RecordDetail.vue', 184, '14', '13'],
  ['src/views/Records.vue', 178, '24', '28'],
  ['src/views/Records.vue', 201, '14', '13'],
  ['src/views/Report.vue', 288, '56', '40'],
  ['src/views/Report.vue', 307, '16', '15'],
  ['src/views/ResumeBuilder.vue', 849, '14', '13'],
  ['src/views/ResumeBuilder.vue', 1336, '38', '40'],
  ['src/views/ResumeBuilder.vue', 1379, '14', '13'],
  ['src/views/Resumes.vue', 437, '16', '15'],
  ['src/views/Resumes.vue', 487, '16', '15'],
  ['src/views/Salary.vue', 274, '14', '13'],
  ['src/views/Salary.vue', 323, '14', '13'],
  ['src/views/Settings.vue', 372, '18', '15'],
]

let ok = 0
let miss = []
const byFile = new Map()
for (const m of MAP) {
  if (!byFile.has(m[0])) byFile.set(m[0], [])
  byFile.get(m[0]).push(m)
}
for (const [file, list] of byFile) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  for (const [, lineNo, from, to] of list) {
    const idx = lineNo - 1
    const before = lines[idx]
    if (!before || !/font-size/.test(before) || !before.includes(`${from}px`)) {
      miss.push(`${file}:${lineNo} 期望 ${from}px，实际「${(before || '').trim()}」`)
      continue
    }
    lines[idx] = before.replace(`font-size: ${from}px`, `font-size: ${to}px`)
    ok++
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
}
console.log(`已替换 ${ok} 处`)
if (miss.length) {
  console.log('未命中：')
  for (const m of miss) console.log('  ' + m)
  process.exitCode = 1
}
