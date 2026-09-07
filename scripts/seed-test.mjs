// 测试用：灌一份简历 + 10 条带 JD 的投递记录，验证匹配排序
const BASE = 'http://localhost:3100'

const jobs = [
  ['公司A', '前端开发实习生', '实习僧', '负责 Vue3 + Node.js 全栈开发，前端技术栈'],
  ['公司B', '前端工程师', 'BOSS直聘', 'React + TypeScript，组件库开发'],
  ['公司C', '数据实习生', '拉勾', 'Python 爬虫、数据分析、pandas'],
  ['公司D', '达人运营', '实习僧', '二次元达人运营，小红书抖音内容，数据回收，coser'],
  ['公司E', 'Java开发', '智联招聘', 'Java Spring 后端开发'],
  ['公司F', '前端小程序', 'BOSS直聘', 'Vue3 小程序开发，echarts 数据可视化'],
  ['公司G', '测试实习生', '牛客网', '自动化测试，Playwright，接口测试'],
  ['公司H', '运维实习生', '拉勾', 'Docker Linux 运维监控'],
  ['公司I', 'AI 实习生', 'BOSS直聘', '大模型 RAG embedding 检索增强'],
  ['公司J', '新媒体运营', '实习僧', '新媒体内容运营，微博，选题，爆款'],
]

const resume = await (await fetch(`${BASE}/api/resumes`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    title: '全栈开发主线', target: '全栈开发', basic: { name: '晨' },
    skills: ['Vue3', 'Node.js', 'Express'],
    experiences: [{ company: 'MCN机构', role: '达人运营实习', points: ['数据回收', 'coser执行', '小红书抖音内容'] }],
    projects: [], selfEvaluation: '',
  }),
})).json()
console.log('resumeId =', resume.id)

for (const [company, jobTitle, platform, jd] of jobs) {
  await fetch(`${BASE}/api/applications`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company, jobTitle, platform, jd }),
  })
}
console.log('seeded', jobs.length, 'applications')
