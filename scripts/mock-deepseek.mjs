// 本地 Mock DeepSeek 服务（测试用，绕过真实 key）
// 用法：node scripts/mock-deepseek.mjs   → 监听 127.0.0.1:9998
// 后端以 DEEPSEEK_API_KEY=sk-test DEEPSEEK_BASE_URL=http://127.0.0.1:9998 启动即可命中
// 注意：不用 9999 —— 那端口常被 intern-report 残留的 mock_deepseek.py 占用
import http from 'node:http'

const PORT = process.env.MOCK_PORT || 9998

const content = JSON.stringify({
  greeting: '你好，我是晨，看到贵司的前端开发实习岗位很感兴趣。我有 Vue3 + Node 全栈项目经验，也独立做过 MCN 数据工具，能快速上手。期待进一步沟通！',
  coverLetter: '（这是模拟求职信正文，用于测试链路）我对贵司岗位非常感兴趣，我的全栈项目经历与该岗位高度匹配，期待有机会面聊。',
  tailoredResume: '# 定制简历（模拟）\n\n## 技能\nVue3、Node.js、Express\n\n## 项目\n- MCN 数据工具：Vue3 + Chrome 扩展\n\n## 自我评价\n踏实、能快速上手。',
  matchPoints: ['匹配点1：Vue3 项目经验对口', '匹配点2：全栈开发能力', '匹配点3：具备测试意识'],
})

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content } }] }))
    })
    return
  }
  res.writeHead(404)
  res.end('{}')
})

server.listen(PORT, () => console.log(`[mock-deepseek] listening on ${PORT}`))
