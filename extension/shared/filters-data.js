// 筛选配置的共用数据（content script 与 popup 共用，避免两处重复维护）
// 注入顺序：manifest 里排在 content.js 之前；popup.html 里也引入一份。
;(function () {
  // ===== 省份 → 城市（重点覆盖实习岗位集中的城市，非全量行政区划）=====
  const PROVINCES = [
    { name: '广东', cities: ['深圳', '广州', '东莞', '佛山', '珠海', '中山', '惠州', '江门', '汕头', '湛江'] },
    { name: '北京', cities: ['北京'] },
    { name: '上海', cities: ['上海'] },
    { name: '天津', cities: ['天津'] },
    { name: '重庆', cities: ['重庆'] },
    { name: '浙江', cities: ['杭州', '宁波', '温州', '嘉兴', '金华', '绍兴', '台州'] },
    { name: '江苏', cities: ['南京', '苏州', '无锡', '常州', '南通', '徐州', '扬州'] },
    { name: '四川', cities: ['成都', '绵阳', '德阳'] },
    { name: '湖北', cities: ['武汉', '宜昌', '襄阳'] },
    { name: '湖南', cities: ['长沙', '株洲', '湘潭'] },
    { name: '陕西', cities: ['西安', '咸阳'] },
    { name: '福建', cities: ['厦门', '福州', '泉州'] },
    { name: '山东', cities: ['青岛', '济南', '烟台', '潍坊'] },
    { name: '安徽', cities: ['合肥', '芜湖'] },
    { name: '河南', cities: ['郑州', '洛阳'] },
    { name: '河北', cities: ['石家庄', '保定', '廊坊'] },
    { name: '辽宁', cities: ['大连', '沈阳'] },
    { name: '吉林', cities: ['长春'] },
    { name: '黑龙江', cities: ['哈尔滨'] },
    { name: '江西', cities: ['南昌', '赣州'] },
    { name: '山西', cities: ['太原'] },
    { name: '云南', cities: ['昆明'] },
    { name: '贵州', cities: ['贵阳'] },
    { name: '广西', cities: ['南宁', '桂林', '柳州'] },
    { name: '海南', cities: ['海口', '三亚'] },
    { name: '甘肃', cities: ['兰州'] },
    { name: '内蒙古', cities: ['呼和浩特', '包头'] },
    { name: '新疆', cities: ['乌鲁木齐'] },
    { name: '宁夏', cities: ['银川'] },
    { name: '青海', cities: ['西宁'] },
    { name: '西藏', cities: ['拉萨'] },
    { name: '中国香港', cities: ['中国香港'] },
    { name: '中国澳门', cities: ['中国澳门'] },
    { name: '中国台湾', cities: ['中国台湾'] },
  ]

  // ===== 方向分组（关键词取自实习僧真实岗位名 + 简历技能）=====
  // 岗位标题或 JD 命中任一关键词 → 认为属于该方向
  const DIRECTIONS = [
    {
      id: 'qa',
      label: '测试开发 / 软件测试',
      keywords: ['测试开发', '测开', '软件测试', '测试实习', '测试工程师', '测试/测试开发', 'QA', '质量保障', '测试'],
    },
    {
      id: 'auto',
      label: '自动化测试 / SDET',
      keywords: ['自动化测试', 'SDET', '自动化', 'selenium', 'playwright', 'pytest', 'vitest'],
    },
    {
      id: 'api',
      label: '接口测试 / 性能测试',
      keywords: ['接口测试', '性能测试', '压测', 'jmeter', 'postman', '抓包'],
    },
    {
      id: 'game',
      label: '游戏测试',
      keywords: ['游戏测试', '手游测试'],
    },
    {
      id: 'fe',
      label: '前端开发',
      keywords: ['前端', 'web前端', 'h5', 'vue', 'react', '小程序', 'javascript', 'typescript'],
    },
    {
      id: 'fullstack',
      label: '全栈 / Node 后端',
      keywords: ['全栈', 'node', '后端开发', '服务端', 'fastify', 'express'],
    },
    {
      id: 'data',
      label: '数据分析 / 数据运营',
      keywords: ['数据分析', '数据运营', 'bi', '数据开发', '数据标注'],
    },
    {
      id: 'ops',
      label: '产品 / 新媒体运营',
      keywords: ['运营', '新媒体', '内容运营', '用户运营', '活动运营', '用户增长', '社群'],
    },
  ]

  // 城市名归一化：页面上的写法五花八门（北京市 / 深圳市 / 北京·朝阳 / 北京市-北京市）
  const CITY_SUFFIX = /(市|地区|特别行政区|省)$/

  function normalizeCity(raw) {
    let s = String(raw || '').trim()
    if (!s) return ''
    // 取第一个城市片段（有的写「北京市-北京市」）
    s = s.split(/[-－—·、,，/|]/)[0].trim()
    s = s.replace(CITY_SUFFIX, '')
    return s
  }

  // 从一段文本里提取城市（在给定城市列表里找命中）
  function detectCity(text, cities) {
    const t = String(text || '')
    const hits = []
    for (const c of cities) {
      const base = normalizeCity(c)
      if (base && t.includes(base)) hits.push(c)
    }
    // 排除包含关系误判：命中了「广州」就不该再算「广东」（本来也不在列表里）
    return hits
  }

  // 从卡片/详情文本里提取「x天/周」与「x个月」
  function detectMeta(text) {
    const t = String(text || '')
    const dayMatch = t.match(/(\d)\s*天\s*\/\s*周/) || t.match(/(\d)\s*天每?周/)
    const monMatch = t.match(/(\d+)\s*个月/) || t.match(/实习\s*(\d+)\s*月/)
    return {
      daysPerWeek: dayMatch ? Number(dayMatch[1]) : null,
      months: monMatch ? Number(monMatch[1]) : null,
    }
  }

  // ===== BOSS 卡片专属：经验 / 学历 / 薪资 =====
  // 为什么要单写一套：BOSS 的岗位卡是「岗位名 / 薪资 / 经验 / 学历 / 公司 / 地址」，
  // **没有**「x天/周」「x个月」—— 实习僧那套门槛在 BOSS 上等于全放行（实测 2026-11-03 探测）。
  // 而经验、学历这两项 BOSS 卡片上写得清清楚楚，是真正能用的筛子。
  //
  // ⚠️ 薪资**读不出数字**：BOSS 用字体混淆渲染数字，innerText 只能拿到 `-K`、`-K·薪`。
  // 所以这里不解析薪资 —— 想按薪资筛只能另做 OCR/字体映射，不值当。

  // 顺序不能换：先窄条件后宽条件。「1年以内」必须排在「1-3年」前面。
  // ⚠️ 这里**绝不能**写「实习」—— 岗位标题里几乎都带「实习」（「测试实习生」「数据分析实习」），
  // 一旦写进去，所有岗位都会被判成「经验不限」，连「1年以内」都抢不到，
  // 门槛等于失效（2026-11-03 单测抓到的就是这个）。
  // 「在校 / 应届」可以留：它们是明确的身份表述，且确实代表不要求经验。
  const EXP_RULES = [
    { re: /经验不限|无经验|无需经验|不要求经验/, years: 0, label: '经验不限' },
    { re: /在校|应届/, years: 0, label: '在校/应届' },
    { re: /1\s*年以内|一年以内/, years: 1, label: '1年以内' },
    { re: /1\s*[-~—]\s*3\s*年/, years: 3, label: '1-3年' },
    { re: /3\s*[-~—]\s*5\s*年/, years: 5, label: '3-5年' },
    { re: /5\s*[-~—]\s*10\s*年/, years: 10, label: '5-10年' },
    { re: /10\s*年以上/, years: 99, label: '10年以上' },
  ]

  // 学历要求 → 序数（越大要求越高）。「学历不限」= 0，任何学历都能投
  const EDU_RULES = [
    { re: /学历不限|不限学历/, rank: 0, label: '学历不限' },
    { re: /初中|小学/, rank: 1, label: '初中' },
    { re: /中专|中技|职高/, rank: 1, label: '中专/中技' },
    { re: /高中/, rank: 2, label: '高中' },
    { re: /大专|专科/, rank: 3, label: '大专' },
    { re: /本科/, rank: 4, label: '本科' },
    { re: /硕士|研究生/, rank: 5, label: '硕士' },
    { re: /博士/, rank: 6, label: '博士' },
  ]

  const EDU_LABELS = ['学历不限', '初中/中专', '高中', '大专', '本科', '硕士', '博士']

  function detectBossMeta(text) {
    const t = String(text || '')
    let experienceYears = null
    let experienceLabel = ''
    for (const r of EXP_RULES) {
      if (r.re.test(t)) {
        experienceYears = r.years
        experienceLabel = r.label
        break
      }
    }
    // 学历取**最严**的那条：卡片上若同时写「本科」和「硕士优先」，按硕士算。
    // 但「学历不限」是门槛为零的显式声明，优先于其他任何词。
    let eduRank = null
    if (/学历不限|不限学历/.test(t)) {
      eduRank = 0
    } else {
      for (const r of EDU_RULES) {
        if (r.rank > 0 && r.re.test(t) && (eduRank === null || r.rank > eduRank)) eduRank = r.rank
      }
    }
    return {
      experienceYears,
      experienceLabel,
      eduRank,
      eduLabel: eduRank === null ? '' : EDU_LABELS[eduRank] || '',
    }
  }

  const DEFAULT_FILTERS = {
    enabled: true,
    cities: ['深圳'],
    daysPerWeek: 4, // 我每周能到岗的天数
    months: 3, // 我能连续实习的月数
    directions: ['qa', 'auto', 'api', 'fe'],
    minScore: 0, // 0 = 不用 B 方案打分门槛
    resumeId: '', // B 方案用哪份简历打分
    strictMeta: false, // true = 城市/天数/月数识别不到时也拦截
    // BOSS 专用（实习僧没有这两项，卡片上读不到就不拦，不会误杀）
    maxExperience: 0, // 可接受的最大经验要求（年）：0 = 只要「经验不限/在校/应届」
    maxEduRank: 4, // 可接受的最高学历要求：4 = 本科（要求硕士/博士的岗位跳过）
  }

  window.JH_FILTERS = {
    PROVINCES,
    DIRECTIONS,
    DEFAULT_FILTERS,
    EDU_LABELS,
    normalizeCity,
    detectCity,
    detectMeta,
    detectBossMeta,
  }
})()
