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

  const DEFAULT_FILTERS = {
    enabled: true,
    cities: ['深圳'],
    daysPerWeek: 4, // 我每周能到岗的天数
    months: 3, // 我能连续实习的月数
    directions: ['qa', 'auto', 'api', 'fe'],
    minScore: 0, // 0 = 不用 B 方案打分门槛
    resumeId: '', // B 方案用哪份简历打分
    strictMeta: false, // true = 城市/天数/月数识别不到时也拦截
  }

  window.JH_FILTERS = {
    PROVINCES,
    DIRECTIONS,
    DEFAULT_FILTERS,
    normalizeCity,
    detectCity,
    detectMeta,
  }
})()
