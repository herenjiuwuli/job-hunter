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
  //
  // ⚠️ 英文词必须写进来，而且按**词边界**匹配（见下面的 hitKeyword）。
  //    2026-11-05 真机：搜「SDET」搜出来的几条是英文岗名（Quality Assurance / Test Engineer），
  //    词表里全是中文 + 几个工具名 → 3 家全被判「没有方向词」，一个都没投。
  //    英文岗在深圳的外企/外包里不算少见，中文词表等于对它们全盲。
  //    词边界是为了避免 `test` 命中 `latest`/`contest` —— 所以可以用宽词。
  const DIRECTIONS = [
    {
      id: 'qa',
      label: '测试开发 / 软件测试',
      keywords: [
        '测试开发', '测开', '软件测试', '测试实习', '测试工程师', '测试/测试开发', 'QA', '质量保障', '测试',
        'test engineer', 'qa engineer', 'quality assurance', 'software engineer in test', 'testing', 'test',
      ],
    },
    {
      id: 'auto',
      label: '自动化测试 / SDET',
      keywords: [
        '自动化测试', 'SDET', '自动化', 'selenium', 'playwright', 'pytest', 'vitest',
        'sdet', 'test automation', 'automation engineer', 'automation',
      ],
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

  // ===== 其他方向词（标题命中 = 明确不是测试/开发方向）=====
  // 为什么需要：方向判断「标题优先、标题无词才退回 JD」时，会遇到一类坑 ——
  // 标题本身语义很明确，只是它属于一个**不在 DIRECTIONS 里**的方向（如「量化交易」），
  // 于是被当成「无方向词」，退回 JD 全文找。JD 里但凡提一嘴「配合测试」「自动化回测」，
  // 就被误判成测试岗放行（2026-11-06 真机：量化交易分析师被自动投了话术）。
  //
  // 所以：标题命中下面任一词 = 这个岗位**明确不是**我要投的方向，直接拦，别再退回 JD。
  // ⚠️ 词要保守：只放「标题一出现就铁定不是测试/开发岗」的词，宁缺勿滥。
  //    太宽会误杀（比如「测试」岗 JD 标题常带「测试工程师」，绝不能放进「其他方向」）。
  const OTHER_DIRECTION_KEYWORDS = [
    '量化', '交易', '投资', '风控', '投研', '金融',
    '销售', '市场', '商务', '渠道', '客户',
    '算法', '机器学习', '深度学习', '大模型', 'NLP', 'CV',
    '运营', '产品经理', '项目助理', '行政', '人事', '人力', 'HR', '财务', '会计', '审计',
    '客服', '文案', '编辑', '设计', 'UI', 'UE', '视觉', '插画',
    '运维', 'SRE', '网络工程', '硬件', '嵌入式', '芯片', 'FPGA',
  ]

  // 城市名归一化：页面上的写法五花八门（北京市 / 深圳市 / 北京·朝阳 / 北京市-北京市）
  const CITY_SUFFIX = /(市|地区|特别行政区|省)$/

  /**
   * 关键词命中判断（纯函数）。
   *
   * 中文用**包含**，英文用**词边界**——这两个口径不能统一：
   *   - 中文不分词，「测试工程师」里包含「测试」是对的，用边界反而全漏；
   *   - 英文若也包含判断，`test` 会命中 `latest` / `contest`，`qa` 会命中 `qax`，
   *     标题里只要出现这类词就把岗位放行 = 方向筛选形同虚设。
   *
   * 2026-11-05 真机背景：搜「SDET」出来的几条是英文岗名（Quality Assurance / Test Engineer），
   * 词表当时只有中文 + 几个工具名 → 3 家全被判「没有方向词」。英文岗不能靠中文词表兜。
   *
   * @param {string} text 已经 toLowerCase 过的文本（调用方统一小写，避免两处各转一遍）
   * @param {string} kw 词表里的词（大小写都行，这里自己转小写）
   */
  function hitKeyword(text, kw) {
    const k = String(kw || '').toLowerCase()
    if (!k) return false
    const t = String(text || '').toLowerCase()
    // 纯 ASCII（英文/数字/技术符号）→ 词边界；含中文 → 包含
    if (!/[^\x00-\x7f]/.test(k)) {
      const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(t)
    }
    return t.includes(k)
  }

  /**
   * 标题命中了哪些「其他方向词」（明确不是测试/开发方向）。
   *
   * 用途：方向判断「标题优先、标题无词才退回 JD」里，先拿这个判断标题是不是
   * 已经**明确属于别的方向**（如「量化交易分析师」里的「量化」「交易」）。
   * 命中 = 这个岗位铁定不是目标方向，直接拦，别再退回 JD 全文去找词
   * （否则 JD 里提一嘴「测试」就被误放行，2026-11-06 真机：量化交易分析师被投了）。
   *
   * 匹配口径跟 hitKeyword 完全一致（中文包含、英文词边界），
   * 所以「量化交易」命中「量化」也命中「交易」，返回多个词也无妨——调用方只看「有没有」。
   *
   * @param {string} text 标题原文（大小写无所谓）
   * @returns {string[]} 命中的其他方向词（可能多个；空数组 = 标题没命中任何其他方向词）
   */
  function otherDirectionOf(text) {
    const hits = []
    for (const k of OTHER_DIRECTION_KEYWORDS) {
      if (hitKeyword(text, k)) hits.push(k)
    }
    return hits
  }

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

  /**
   * 取**最先出现**的那个城市（按字符位置），而不是「文本里只要有就算命中」。
   *
   * 为什么必须换：岗位城市紧跟在标题/公司后面，而「你选的城市」会以别的方式出现在同一页 ——
   * 站点城市切换器、面包屑、右侧「相似岗位」、页脚「热门城市」。
   * 用「包含即命中」，只要页面上出现过一次「深圳」，西安的岗位也会被判为城市相符，
   * 于是整条城市门槛形同虚设（2026-11-05 用户实测：实习僧上连西安的岗位都被投了）。
   *
   * 两层判定，顺序不能换：
   *   ① **括号里的城市优先**：岗位名常自带标注「硬件测试工程师（西安）」——
   *      这是平台明确告诉你岗位在哪，比任何位置推断都可靠。
   *      真实反例：`深圳市正浩创新科技股份有限公司 / 硬件测试工程师（西安）`，
   *      公司名里的「深圳」是注册地，把它当成岗位城市就投错城市了。
   *   ② 否则取**位置最靠前**的城市（岗位城市总在标题/公司附近，推荐位在后）。
   *
   * @param {string} text 尽量是**岗位头部**那段文本（越窄越准）
   * @returns {string} 城市名；一个都认不出返回空串
   */
  function firstCity(text) {
    const t = String(text || '')
    if (!t) return ''
    // ① 括号里的城市（中英文括号都要）
    for (const m of t.matchAll(/[（(]([^）)]{1,10})[）)]/g)) {
      const c = earliestCity(m[1])
      if (c) return c
    }
    // ② 位置最靠前的城市
    return earliestCity(t)
  }

  /** 在这段文本里，找出**出现位置最靠前**的城市名 */
  function earliestCity(text) {
    const t = String(text || '')
    if (!t) return ''
    let best = null
    for (const p of PROVINCES) {
      for (const c of p.cities) {
        const base = normalizeCity(c)
        if (!base) continue
        const at = t.indexOf(base)
        if (at === -1) continue
        if (!best || at < best.at) best = { city: c, at }
      }
    }
    // 「全国」也是一格城市位：实习僧在深圳的搜索结果里会掺「全国」岗位，
    // 卡片上的城市位直接写「全国」。同位置时优先认具体城市（条件用 <，不是 <=）。
    //
    // ⚠️ 只认「全国」，**不能**把「不限」也算进来：BOSS 卡片上「学历不限」到处都是，
    //    那会把一堆正常岗位误判成「全国」全塞进待定。
    const atN = t.indexOf('全国')
    if (atN !== -1 && (!best || atN < best.at)) best = { city: '全国', at: atN }
    return best ? best.city : ''
  }

  /**
   * 城市门槛判定（纯函数，可单测）。
   *
   * 语义：**先找出岗位城市，再比是不是你要的**。顺序反了就会退化成
   * 「文本里出现过我选的城市就算过」—— 而页面上永远有你的城市（站点切换器/推荐/页脚）。
   *
   * 三态而不是两态：
   *   - blocked=false          城市对 → 正常投
   *   - nationwide=true        写的是「全国/不限」→ **既不是异地也不是本地**，交给上层列成「待定」
   *   - blocked=true           明确在别的城市 → 直接拦
   *
   * 为什么「全国」要单独一态：实习僧在「深圳」的搜索结果里会掺「全国」岗位
   * （2026-11-05 实测：20 条里 2 条是全国，其中东方金信那条详情页写着北京）。
   * 当异地丢掉会漏掉真在深圳的，直接投又可能投到外地，所以只能让人来决定。
   *
   * @param {string} metaText 岗位头部那段文本（越窄越准，别喂整页）
   * @param {string[]} cities 只投这些城市
   * @returns {{blocked:boolean, city:string, nationwide:boolean}} city 为空 = 认不出，交由 strictMeta 决定
   */
  function checkCity(metaText, cities) {
    const mine = (cities || []).map(normalizeCity).filter(Boolean)
    if (!mine.length) return { blocked: false, city: '', nationwide: false }
    const city = firstCity(metaText)
    if (!city) return { blocked: false, city: '', nationwide: false }
    const norm = normalizeCity(city)
    if (norm === '全国' || norm === '不限') return { blocked: true, city, nationwide: true }
    return { blocked: !mine.includes(norm), city, nationwide: false }
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

  /**
   * 关键词输入 → 关键词数组。
   *
   * 为什么要有：一个搜索词在实习僧上、一个城市里通常只对应 20~40 个岗位，投完就没了
   * （2026-11-05：「测试 + 深圳 + 校招」翻两页共 0 家可投）。想要量就得排几个词轮着跑，
   * 所以输入框允许一行写多个词，这里统一切分。
   *
   * 分隔符：英文逗号 / 中文逗号 / 顿号 / 分号 / 换行。去空、去重（保留首次出现顺序）、最多 10 个。
   * 刻意**不按空格切**：像「测试 开发」这种带空格的写法是一个词，切了会搜出两个不相干的结果。
   *
   * @param {string} input
   * @returns {string[]}
   */
  function parseKeywords(input) {
    const out = []
    const seen = new Set()
    for (const raw of String(input || '').split(/[,，、;；\n\r]+/)) {
      const k = raw.trim()
      if (!k || seen.has(k)) continue
      seen.add(k)
      out.push(k)
      if (out.length >= 10) break
    }
    return out
  }

  /**
   * 一个搜索任务叫什么。城市和关键词都可能为空：
   * - 都有 → 「深圳·软件测试」
   * - 只有词 → 「软件测试」（老的单城市模式）
   * - 只有城市 → 「深圳」
   * 从 URL 现读，不另存一份，避免两处不一致。
   * @param {string} url
   * @returns {string}
   */
  function taskNameOf(url) {
    try {
      const u = new URL(String(url || ''))
      const k = u.searchParams.get('keyword') || ''
      const c = u.searchParams.get('city') || ''
      const t = u.searchParams.get('type') || ''
      const typeShort = { intern: '实习', school: '校招', company: '企业' }[t] || ''
      const parts = [c, typeShort, k].filter(Boolean)
      return parts.join('·') || k || c || ''
    } catch (_) {
      return ''
    }
  }

  /**
   * 把「城市 × 类型 × 关键词」展开成一串搜索任务。
   *
   * 为什么必须展开：实习僧的 `city` 和 `type` 都是**单值** query 参数，一个地址只能搜一个城市、一种类型。
   * 界面上勾了 2 个城市、2 种类型，不是「一次全搜到」，而是「跑 2×2 轮」。
   * 展开后交给现有的关键词轮换机制（batch.kwUrls / kwIndex）串行跑完，
   * 不需要另写一套城市/类型轮换 —— 城市在外层、类型在次外层、关键词在内层：
   * 先把「深圳·实习」的几个词跑完，再跑「深圳·校招」，最后才轮到「广州·实习」。
   *
   * @param {string[]} kws 关键词列表（空 = 不带 keyword，即该城市全部岗位）
   * @param {string[]} cities 城市列表（空 = 不限城市）
   * @param {string[]} types 类型列表（空 = 不限类型；元素如 intern/school/company）
   * @param {(p:{city:string,type:string,keyword:string})=>string} urlOf 拼地址的回调（模板逻辑在 popup 里）
   * @returns {{city:string,type:string,keyword:string,url:string}[]}
   */
  function expandSearchTasks(kws, cities, types, urlOf) {
    if (typeof urlOf !== 'function') return []
    const K = (Array.isArray(kws) ? kws : []).filter(Boolean)
    const C = (Array.isArray(cities) ? cities : []).filter(Boolean)
    const T = (Array.isArray(types) ? types : []).filter(Boolean)
    const ks = K.length ? K : ['']
    const cs = C.length ? C : ['']
    const ts = T.length ? T : ['']
    const out = []
    for (const c of cs) {
      for (const t of ts) {
        for (const k of ks) out.push({ city: c, type: t, keyword: k, url: urlOf({ city: c, type: t, keyword: k }) })
      }
    }
    return out
  }

  const DEFAULT_FILTERS = {
    enabled: true,
    cities: ['深圳'],
    daysPerWeek: 4, // 我每周能到岗的天数
    months: 3, // 我能连续实习的月数
    // 只留测试类：前端 / 产品 / 新媒体运营 / 数据分析这些也在总表里，
    // 一旦勾上，搜索里混进来的非测试岗就会被放行（2026-11-05 用户 7 个方向全勾，自己没意识到）
    directions: ['qa', 'auto', 'api', 'game'],
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
    firstCity,
    checkCity,
    hitKeyword,
    otherDirectionOf,
    detectMeta,
    detectBossMeta,
    parseKeywords,
    taskNameOf,
    expandSearchTasks,
  }
})()
