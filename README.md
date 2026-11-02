# 求职助手（job-hunter）

> 求职全流程的一站式 AI 工具：**简历库 → 按 JD 定制 → 匹配排序 → 半自动投递 → 面试准备**。
> 把「做简历、投简历、面面试」三件事串成一条可追踪的流水线。

- **仓库**：https://github.com/herenjiuwuli/job-hunter
- **测试**：135 个 pytest 接口用例（`tests/`）+ 95 个 node 单测（`scripts/test-*.mjs`），详见 [`TESTING.md`](TESTING.md)
- **登录**：多用户隔离已落地 —— 每个接口都要带 token，数据按 `ownerId` 分开（见 §2.2）

## 一、它解决什么

求职时最痛的四个点，本工具各有一个对应模块：

| 痛点 | 模块 | 怎么做 |
|---|---|---|
| 一份简历海投，命中率低 | **简历库 + AI 定制** | 结构化维护母版简历，一键按 JD 生成针对性简历 / 打招呼语 / 求职信 |
| 海投没重点，不知道先投谁 | **匹配排序** | 关键词权重给所有 JD 打分，优先投匹配度高的 |
| 投了没下文，进度全忘 | **投递追踪** | 7 状态流转（待投递→已投递→已沟通→已面试→offer/拒绝/淘汰）+ 5 结果机（确认提交/跳过/被拦截/需用户/待处理） |
| 工作授权 / 期望薪资 AI 瞎编 | **候选人画像** | 存「不可猜事实」（工作授权/签证/薪资/自助ID），投递前自动套用 |
| 面试心里没底 | **面试准备** | 简历分析、AI 模拟面试（技术/HR/行为面）、报告复盘、错题本、薪资谈判 |

## 二、功能总览（三大板块）

```
求职助手
├── 求职执行
│   ├── 投递追踪     —— 记录每次投递，7 状态 + 5 结果机；定向下拉 + 必填校验
│   ├── 匹配排序     —— 快速打分（关键词覆盖度粗排）+ 深度分析（AI 证据矩阵，见下）
│   ├── 简历库       —— **唯一入口**：列表/编辑双视图 + 「AI 重写版」按钮 + 「导入简历」（PDF/Word → 解析→AI 结构化→预填表单）；新建/编辑都在此
│   └── 候选人画像   —— 工作授权/薪资/目标岗位/自助ID 等「AI 不能瞎编」的事实
├── 简历工作台
│   └── AI 重写版   —— 「写简历」改名：**必须从简历库经 `?resumeId=` 进入**，基本信息由简历库只读展示，仅 AI 输入可改（技能/项目/目标岗位），可保存回简历库 content 字段
├── 面试准备
│   ├── 简历分析     —— AI 评匹配度 / 亮点 / 短板 / 预测问题 / 推荐岗位
│   ├── 模拟面试     —— 技术面 / HR 面 / 行为面，三档难度，追问 + 逐题评分；**新增 Claim 契约**：提问锁定 Ownership/Metric/Technical/Architecture/Result 五类主张，带动态追问停止条件
│   ├── 面试记录     —— 历史面试存档 + 报告回看
│   ├── 自我介绍     —— 逐句点评 + 更优示例
│   ├── 准备清单     —— 面试前检查清单（按优先级排序）
│   ├── 错题本       —— 低分题自动归档，反复练
│   ├── 薪资谈判     —— HR 模拟谈判 + 策略复盘
│   ├── 投递助手     —— AI 生成投递方向 + 打招呼语 + 求职信
│   └── 面试弹药自检 —— 新增：把「AI 协作生成」的项目转成诚实弹药 + 关源码复现清单（见下）
├── 简历导出
│   └── 导出 PDF     —— 新增：简历库每页「导出 PDF」，生成自包含 A4 HTML 文档，浏览器打印 / 另存为 PDF（零依赖）
└── 浏览器扩展（Chrome MV3）
    └── 半自动投递   —— 复用已登录浏览器，自动填话术 + 可选自动点投递 + 记录回写
```

### 2.1 从简历/求职 Skill 提炼进来的方法论（2026-10-28）

把一批简历/求职类方法论 Skill 的**精华**提炼进本项目的 AI 流程，而非复制文件：

| 来源 Skill | 提炼进 JobHunter 的能力 | 说明 |
|---|---|---|
| `job-match` | **匹配排序·深度分析** | 原快速打分只给单一 0–100 分；新增「深度分析」按 JD 拆要求→证据矩阵（5 状态：已匹配/表达缺口/证据不足/真实缺口/待确认）+ 硬性门槛 + 优先补强 + 投递建议，**明确不出伪精确百分比** |
| `interview-ammo-docs` | **面试弹药自检（新页面）** | 针对一个项目生成诚实边界 + 一句话定位 + 亮点(✅/⚠️) + 「我改过的点+为什么」+ 深挖题 + 关源码复现清单 + 错题本模板；逼出诚实边界，防止面试装成全独立手写 |
| `interview` | **模拟面试·Claim 契约 + Predict 模式** | 模拟面试提问锁定五类 Claim 并带动态追问停止条件；首页新增「Claim 深度预测」按能力—证据—缺口矩阵预测高概率/补充/压力题 |
| `make-resume` | **简历导出 PDF** | 从简历库 JSON 生成自包含 A4 HTML 文档，浏览器打印另存为 PDF |

> 未搬的：`job-apply`（与本项目 Chrome 半自动投递扩展重叠）、`offer`（与投递追踪 7 状态重叠）、`great-resume` 改写模式（与 AI 重写版重叠，仅取其「主张—证据」思路）。

### 2.2 多用户与数据隔离（2026-11）

从「单人自用」升级为「多账号 + 严格隔离」。不是加个登录框就完事，四件事一起做才算数：

| 层次 | 做法 | 为什么必须这样 |
|---|---|---|
| **认证** | 自写 HS256 token（`node:crypto`，零依赖）+ scrypt 存口令 | token 必须校验**签名**和**过期时间**；口令不能用 sha256（太快，撞库几秒几十亿次） |
| **鉴权** | `app.use('/api', requireAuth)` 一条闸门管住**全部** `/api` | 逐个路由加必然漏；实测漏掉 `/api/backup/export` 就等于全量泄露 |
| **归属** | 每条记录带 `ownerId`，读走 `lib/scope.js`（`listMine` / `getMine`） | 过滤逻辑写散 = 一定有一处漏；跨用户访问一律 **404 不是 403**（403 等于确认「这 id 真的存在」） |
| **迁移** | `npm run migrate:owner -- --username <账号>` | 老数据没有 `ownerId`，不显式划给主人就等于丢失；脚本幂等、先备份再写 |

**三个容易被忽略的越权面**（都有测试守着）：

1. **聚合读**：`/api/dashboard` 只过滤 CRUD 不够 —— 别人的数据会以「统计数字」的形式泄露。
2. **批量赋值**：请求体里塞 `ownerId` 想写进别人名下 → 后端一律覆盖为登录身份。
3. **备份导入**：老实现是整文件覆盖，多用户下等于「B 恢复一次备份，A 的数据全没了」；现在只替换「属于我的那部分」，且 `ownerId` 强制重写。

> 前端守卫只是体验层（没 token 就跳登录页）；**真正的权限在后端** —— 改掉 localStorage 绕过守卫，每个接口照样 401。

## 三、技术栈

- **前端**：Vue 3.5 + Vite 8 + Vue Router 4（history 路由，单仓 `src/`）
- **后端**：Express 5 + Node 20+（单仓 `server/`，端口 3100，已开 CORS）
- **鉴权**：自写 HS256 token + scrypt 口令（零依赖，`server/lib/auth.js`）；数据按 `ownerId` 隔离
- **AI**：DeepSeek（`deepseek-chat`，JSON 模式），所有 prompt 硬约束「绝不虚构经历」
- **存储**：JSON 文件（`server/data/`，零数据库依赖，自用够用）
- **浏览器扩展**：Chrome Manifest V3（content script + service worker + popup）

## 四、快速开始

```bash
# 1. 装依赖
npm install

# 2. 配 AI key（AI 功能需要；纯 CRUD 可不配）
cp .env.example .env
# 编辑 .env，填入 DEEPSEEK_API_KEY

# 3. 启动（前端 5173 + 后端 3100 一起起）
npm run dev
```

打开 `http://localhost:5173`，**第一次先注册一个账号**（注册即登录）。老数据用 `npm run migrate:owner -- --username <你的账号>` 划到自己名下。

## 四·五、账号相关命令

```bash
npm run migrate:owner -- --username chen          # 把老数据（无 ownerId）划给 chen；自动建账号+改密码
npm run migrate:owner -- --username chen --dry-run # 只看要改什么，不落盘
npm run check:ui:login                            # 真机验登录链路（需先起服务；默认打 3100）
```

- 密码忘了 / 要改：`PUT /api/auth/password`（前端未做页面，暂用 curl），或重新跑迁移脚本另建账号。
- token 有效期 7 天，签名密钥落在 `server/data/.jwt-secret`（已 gitignore），删掉它等于让所有 token 立刻失效。

## 五、浏览器扩展（半自动投递，可选）

见 [`extension/README.md`](extension/README.md)。核心安全策略：每日额度（默认 50 / 硬上限 150）、随机 4–10s 间隔、验证码/风控即停、关键词黑名单、BOSS 活跃度过滤，**默认半自动**（只填话术、人工确认投递）。

## 六、安全与合规声明

- **本项目为个人求职工具**，浏览器扩展复用使用者已登录的浏览器会话，**不绕过验证码、不破解风控**，命中验证码/风控提示立即停止。
- 投递节奏内置多重限速，避免对招聘平台造成压力。
- 使用请遵守目标招聘平台的服务条款。

## 七、简历 / 面试话术（脱敏，可直接改写进作品集）

**简历项目条目**（可放入「项目经历」，占 2–3 行）：

> **求职助手（全栈个人项目）** —— Vue3 + Express + DeepSeek + Chrome MV3 扩展
> - 独立设计「简历库 → JD 定制 → 匹配排序 → 投递追踪」的求职数据闭环，一份母版简历可按岗位自动生成针对性版本与打招呼语；
> - 用关键词权重算法对 JD 做匹配打分排序，优先投递高匹配岗位；
> - 开发 Chrome 半自动投递扩展，内置每日额度、随机间隔、关键词黑名单等防封策略，投递记录自动回写；
> - 集成 AI 模拟面试（技术/HR/行为三面）、报告复盘、错题本，形成「投递—面试」完整链路。
> - 「简历库」做唯一入口，「AI 重写版」改为依赖简历库副本的 AI 工具视图（强制 `?resumeId=`），避免一份数据两个表单造成同步错乱。

**面试口述要点**（30 秒版）：

> 我做了一个求职全流程的助手，把「做简历、投简历、面面试」串成一条线。技术上用 Vue3 + Express + DeepSeek，还写了一个 Chrome 扩展做半自动投递。最有意思的是防封这块——我没有去绕过验证码，而是反过来做限速：每日投递上限、随机间隔、关键词黑名单、只投活跃 HR，命中风控就自动停。这让我意识到「自动化」不是越快越好，而是要跟平台规则共存。

## 八、目录结构

```
job-hunter/
├── src/                    # Vue3 前端（19 视图，含登录页）
│   ├── views/              # 登录/投递追踪/匹配排序/简历库/写简历/面试准备…
│   ├── router.js           # history 路由 + 登录守卫
│   ├── auth.js             # token 与登录态（localStorage + 响应式）
│   ├── api.js              # 后端 API 封装（自动带 token，401 统一跳登录）
│   ├── store.js            # 面试全局状态
│   └── style.css           # 统一设计变量 + 组件样式
├── server/                 # Express 后端（19 个路由模块 / 44 条接口）
│   ├── routes/             # auth/resumes/applications/profile/tailor/match/interview/…
│   ├── lib/                # auth.js（token/口令）/ scope.js（归属过滤）
│   │                       # ai.js / store.js / jobs.js / matcher.js
│   └── data/jobs.json      # 岗位知识库（进 Git；运行时数据全部 gitignore）
├── extension/              # Chrome MV3 半自动投递扩展
├── scripts/                # 推送脚本：push-main.sh / retry-push.sh（直连+后台轮询）
│                           # 静态扫描：check-vue-{undef,tpl,refvalue}.mjs（npm run check:frontend）
│                           # 测试：tests/mock_deepseek.py + tests/*.py（pytest）
└── .env.example
```

## 三点五、前端静态扫描（避免「点了才炸」）

`vite build` 对「引用了未声明的标识符」只 warning 不 error，编译照过、真机一点就 `ReferenceError`。本项目踩过 3 次（`router.js` 漏 Profile import、`Applications.vue` 漏 `tailoring`/`matchPoints`、旧 `resume/interview` 缺路由）。所以固化了一套**零依赖**的纯 Node 静态扫描脚本（不依赖 ESLint）：

```bash
npm run check:frontend           # 一键跑三遍，0 警告才算干净
npm run check:frontend:undef     # script 部分大写未声明标识符
npm run check:frontend:tpl       # template 组件/事件未声明
npm run check:frontend:refvalue  # Vue ref 漏声明（用了 .value 但未 const ref()）
```

**适用范围**：任何 Vue 3 `<script setup>` 项目。三个脚本互相补充，覆盖 95% 的「build OK、运行时崩」类错误。建议挂到 CI：有任何可疑就拒绝合入。

## 九、免责声明

本项目仅供个人求职使用，AI 生成的简历/话术需使用者本人核对，确保真实、不虚构。作者不对任何因使用本工具导致的账号风险或求职结果负责。
