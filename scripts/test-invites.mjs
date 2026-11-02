/**
 * 邀请码纯函数回归测试。
 *
 * 为什么不全靠 pytest：pytest 走 HTTP，只能验证「这个码注册成不成」这种黑盒行为；
 * 而这里要定住的是几个精确边界 —— 字符集（不能出现 I/O/0/1 这类手抄会看错的字）、
 * 归一化（小写/多余分隔符也得认）、过期判定的临界点（刚好到期算不算过期）。
 * 这些在 HTTP 层要么测不到，要么要靠改文件造数据才勉强能测。
 *
 * 用法：node scripts/test-invites.mjs
 */
import { generateCode, normalizeCode, formatCode, looksLikeCode, statusOf } from '../server/lib/invites.js'

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    console.log(`  ❌ ${name}\n     期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

// 与 invites.js 里保持一致的字母表（无 I O 0 1）
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

console.log('\n一、生成')
{
  const codes = Array.from({ length: 1000 }, () => generateCode())
  check('长度都是 12', [...new Set(codes.map((c) => c.length))], [12])
  check('字符全部在无歧义字母表内', codes.every((c) => [...c].every((ch) => ALPHABET.includes(ch))), true)
  check('不含 I / O / 0 / 1', codes.every((c) => !/[IO01]/.test(c)), true)
  check('1000 个里没有重复', new Set(codes).size, 1000)
}

console.log('\n二、归一化（手抄容错）')
{
  check('小写转大写', normalizeCode('abcd'), 'ABCD')
  check('去掉横线', normalizeCode('ABCD-EFGH-JKLM'), 'ABCDEFGHJKLM')
  check('去掉空格和别的分隔符', normalizeCode(' ABCD EFGH_JKLM '), 'ABCDEFGHJKLM')
  check('null / undefined 不炸', [normalizeCode(null), normalizeCode(undefined)], ['', ''])
  check('非字母数字被丢掉', normalizeCode('AB!@#CD'), 'ABCD')
}

console.log('\n三、展示格式')
{
  check('12 位按 4 位分组', formatCode('ABCDEFGHJKLM'), 'ABCD-EFGH-JKLM')
  check('已经是分组形式时幂等', formatCode('ABCD-EFGH-JKLM'), 'ABCD-EFGH-JKLM')
  check('小写进来也正确分组', formatCode('abcdefghjklm'), 'ABCD-EFGH-JKLM')
  // 归一化 + 格式化 往返一致：这是「存库用归一化形式、展示用分组形式」不打架的保证
  check('往返一致', normalizeCode(formatCode('ABCDEFGHJKLM')), 'ABCDEFGHJKLM')
}

console.log('\n四、形状粗筛')
{
  check('合法码', looksLikeCode('ABCD-EFGH-JKLM'), true)
  check('11 位', looksLikeCode('ABCD-EFGH-JKL'), false)
  check('13 位', looksLikeCode('ABCD-EFGH-JKLMN'), false)
  check('含 0（不在字母表）', looksLikeCode('ABCD-EFGH-JKL0'), false)
  check('含 I（不在字母表）', looksLikeCode('ABCD-EFGH-JKLI'), false)
  check('含 O（不在字母表）', looksLikeCode('ABCD-EFGH-JKLO'), false)
  check('乱写', looksLikeCode('test'), false)
  check('空串', looksLikeCode(''), false)
  check('null', looksLikeCode(null), false)
}

console.log('\n五、状态判定')
{
  const now = Date.parse('2026-11-02T12:00:00.000Z')
  const future = '2026-11-09T12:00:00.000Z'
  const past = '2026-10-26T12:00:00.000Z'

  check('未用未过期 → unused', statusOf({ expiresAt: future, usedBy: null }, now), 'unused')
  check('已使用 → used', statusOf({ expiresAt: future, usedBy: 'u_1' }, now), 'used')
  check('过期 → expired', statusOf({ expiresAt: past, usedBy: null }, now), 'expired')
  check('已使用且已过期 → 仍报 used（它确实被用掉了）', statusOf({ expiresAt: past, usedBy: 'u_1' }, now), 'used')
  check('不存在 → invalid', statusOf(null, now), 'invalid')
  // 临界点：到期时刻本身算过期（代码用 <=）。写死这个语义，避免以后改成 < 而悄悄多放行一秒
  check('刚好到期 → expired', statusOf({ expiresAt: '2026-11-02T12:00:00.000Z', usedBy: null }, now), 'expired')
  check('没有 expiresAt 字段 → 当过期处理，不放行', statusOf({ usedBy: null }, now), 'expired')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)
