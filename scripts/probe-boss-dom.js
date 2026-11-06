/**
 * BOSS 页面结构取证脚本（**在浏览器 Console 里跑，不是 node 脚本**）
 *
 * 用途：2026-11-06 一键投递产生的 6 条记录全是「未知公司」，且岗位名掉回
 * document.title（标题里带着「3-5K / 200-250元/天」就是证据）——
 * 说明 extractJobInfo() 里那套 jobEl 选择器在 BOSS 当前版面上**一个都没命中**。
 *
 * 用法：
 *   1. 在 BOSS 打开一个**岗位详情页 / 列表页（左列表右详情）**
 *   2. F12 → Console → 整段粘贴 → 回车
 *   3. 输出会自动复制到剪贴板，直接粘回对话即可
 *
 * 只读：不点击、不发请求、不改页面。
 */
;(() => {
  const q = (s) => {
    try {
      return [...document.querySelectorAll(s)]
    } catch (_) {
      return []
    }
  }
  const T = (e) => (String(e.innerText || '').replace(/\s+/g, ' ').trim()).slice(0, 44)
  const C = (e) => (String(e.className || '').match(/[\w-]+/g) || []).slice(0, 3).join('.')
  const L = []

  L.push('URL   ' + location.href.slice(0, 130))
  L.push('TITLE ' + String(document.title).slice(0, 90))
  L.push('H1    x' + q('h1').length + (q('h1')[0] ? '  「' + T(q('h1')[0]) + '」 .' + C(q('h1')[0]) : ''))

  L.push('')
  L.push('[岗位名选择器命中]')
  ;[
    '.job-banner .name',
    '.job-primary .name',
    '.job-detail-box .name',
    '.job-name',
    '.job-title',
    '.position-name',
    'h1',
  ].forEach((s) => {
    const n = q(s)
    L.push('  ' + s + '  x' + n.length + (n[0] ? '  「' + T(n[0]) + '」 .' + C(n[0]) : ''))
  })

  L.push('')
  L.push('[公司主页链接 a[href*=gongsi] x' + q('a[href*="/gongsi/"]').length + ']')
  q('a[href*="/gongsi/"]').slice(0, 10).forEach((a) => {
    const box = a.closest('[class*="job-banner"],[class*="job-detail"],[class*="job-card"],[class*="sider"]')
    L.push('  「' + T(a) + '」 .' + C(a) + '  box=' + (box ? C(box) : '无'))
  })

  L.push('')
  L.push('[company-name 候选 x' + q('[class*="company-name"]').length + ']')
  q('[class*="company-name"]').slice(0, 10).forEach((e) => L.push('  「' + T(e) + '」 .' + C(e)))

  L.push('')
  L.push('[company-info 块 x' + q('[class*="company-info"]').length + ']')
  q('[class*="company-info"]').slice(0, 8).forEach((e) => {
    L.push('  .' + C(e) + '  「' + T(e) + '」')
    ;[...e.children].slice(0, 4).forEach((c) => L.push('      > ' + c.tagName.toLowerCase() + '.' + C(c) + ' 「' + T(c) + '」'))
  })

  const btn = q('a,button').filter((b) => /立即沟通|继续沟通|已投递/.test(b.innerText || ''))
  L.push('')
  L.push('[沟通按钮 x' + btn.length + ']')
  btn.slice(0, 3).forEach((b) => L.push('  「' + T(b) + '」 ' + b.tagName.toLowerCase() + '.' + C(b)))

  const out = L.join('\n')
  console.log(out)
  try {
    copy(out)
    return '✅ 已复制到剪贴板，直接粘回对话'
  } catch (_) {
    return '（copy 不可用，请手动复制上面的输出）'
  }
})()
