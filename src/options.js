// 表单通用预设选项：给自由输入框提供 datalist 联想，减少手打、统一取值
// 用法：<input list="opt-edu"> + <datalist id="opt-edu"><option v-for="x in EDUCATION" :value="x" /></datalist>

/** 学历 */
export const EDUCATION = ['高中/中专', '大专', '本科', '硕士', '博士', '其他']

/** 性别 */
export const GENDERS = ['男', '女', '不愿透露']

/** 政治面貌 */
export const POLITICAL = ['中共党员', '中共预备党员', '共青团员', '群众', '其他']

/** 常见工作城市（datalist 不宜过长，取一线 + 新一线热门） */
export const CITIES = [
  '北京', '上海', '广州', '深圳',
  '杭州', '南京', '武汉', '成都', '西安', '重庆',
  '苏州', '长沙', '天津', '郑州', '东莞', '青岛',
  '沈阳', '合肥', '厦门', '福州', '济南', '昆明',
  '大连', '无锡', '宁波', '珠海',
]

/** 毕业年份：前 2 年到后 6 年，动态生成避免逐年手工维护 */
export const GRAD_YEARS = (() => {
  const now = new Date().getFullYear()
  return Array.from({ length: 9 }, (_, i) => String(now - 2 + i))
})()

/** 国家 / 地区（香港、澳门、台湾均为中国的一部分） */
export const COUNTRIES = ['中国', '中国香港', '中国澳门', '中国台湾', '其他']

/** 工作授权常见描述 */
export const WORK_AUTH = [
  '中国公民，无需额外授权',
  '中国永久居留',
  '需要工作签证',
  '需要雇主担保（sponsorship）',
]

/** 当前身份 / 求职状态 */
export const CURRENT_ROLE = [
  '大四在读', '大三在读', '研二在读', '应届毕业生',
  '在职，考虑机会', '离职，可随时到岗', '自由职业',
]

/** 薪资回答策略 */
export const SALARY_STRATEGY = [
  '优先延后回答；无法延后时给出区间',
  '直接给出期望区间',
  '先反问对方预算区间',
  '按对方薪资结构谈，不先报价',
]

/** 招聘平台（投递追踪用） */
export const PLATFORMS = [
  '实习僧', 'BOSS直聘', '拉勾', '牛客网',
  '智联招聘', '前程无忧', '猎聘', '脉脉', '其他',
]

/** 常见实习/校招岗位类型，用于投递记录备注联想 */
export const JOB_TYPES = ['实习', '校招', '社招', '兼职', '远程']
