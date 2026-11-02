# 测试说明（job-hunter）

复用 resume-interview 的测试约定：**pytest（Python）+ mock DeepSeek**，覆盖全部 19 个后端路由的「鉴权 + 校验路径 + 正路 + 匹配排序 + 跨用户隔离」。

## 环境准备（首次）

```bash
python -m venv .venv
.venv/Scripts/python -m pip install pytest requests
```

## 跑测三步（安全流程：零花费、零污染）

> 三个安全开关缺一不可：mock AI（不花钱）、隔离数据目录（不污染真实数据）、专用端口（不抢日常 3100）。
> pytest 有会话前置检查：后端不可达 / 连真实 AI / 未隔离数据目录 / pytest 自己没设隔离目录，都会**直接拒绝运行**。

Git Bash / Linux：

```bash
# 1. 起 mock（9999）
.venv/Scripts/python tests/mock_deepseek.py

# 2. 起后端：mock AI + 隔离数据目录 + 专用端口（不抢日常 3100）
JOB_HUNTER_DATA_DIR="$(cygpath -w "$TEMP")/jh_testdata" DEEPSEEK_API_KEY=sk-test \
  DEEPSEEK_BASE_URL=http://127.0.0.1:9999 PORT=3200 node server/dev.js

# 3. 跑测试（指向 3200；pytest 也要带隔离目录，防止清理逻辑误删真实数据）
JH_BASE=http://localhost:3200 JOB_HUNTER_DATA_DIR="$(cygpath -w "$TEMP")/jh_testdata" \
  .venv/Scripts/python -m pytest tests/ -v
```

PowerShell（Trae 终端默认）：

```powershell
# 1. 起 mock（9999）
.venv/Scripts/python tests/mock_deepseek.py

# 2. 起后端（另开一个终端）
$env:JOB_HUNTER_DATA_DIR="$env:TEMP\jh_testdata"; $env:DEEPSEEK_API_KEY="sk-test"; $env:DEEPSEEK_BASE_URL="http://127.0.0.1:9999"; $env:PORT="3200"; node server/dev.js

# 3. 跑测试（另开一个终端；两条命令用同一隔离目录）
$env:JH_BASE="http://localhost:3200"; $env:JOB_HUNTER_DATA_DIR="$env:TEMP\jh_testdata"; .venv/Scripts/python -m pytest tests/ -v
```

> 后端隔离启动时会自动把 `server/data/jobs.json`（岗位知识库，静态资产）播种到隔离目录，无需手动拷贝。
> 跑完确认零污染：`server/data/` 应无任何文件变化；测试数据全部落在隔离目录，可整目录删除。

## 用例清单

| 文件 | 路由 | 用例数 | 覆盖点 |
|---|---|---|---|
| test_analyze.py | /api/analyze | 4 | 空/缺简历 400，正路 4 维度 + 岗位推荐（推荐不限知识库） |
| test_apply.py | /api/apply/assist | 4 | 缺简历/缺岗位 400，正路三件套 + 自定义岗位 200 |
| test_interview.py | /api/interview/* | 13 | start/answer/report 校验 + 正路 + 自定义岗位 + 追问 + 评分 |
| test_resume.py | /api/resume/generate | 3 | 缺姓名/空技能项目 400，正路多版本 |
| test_resumes.py | /api/resumes | 6 | 简历库 CRUD + content 字段 + 404 |
| test_applications.py | /api/applications | 7 | 投递 CRUD + 状态流转 + 非法状态兜底 |
| test_profile.py | /api/profile | 3 | 默认模板 + 保存读回 + 增量合并（未传字段保留旧值） |
| test_tailor.py | /api/tailor | 4 | 缺参数校验 + 正路四件套 |
| test_match.py | /api/match | 5 | 缺参数/404 + 排序 + 技能×2 权重 + 过滤 |
| test_backup.py | /api/backup/export、import | 5 | 空数据导出兜底 + 含数据导出 + 导入校验（缺数据/错类型 400）+ 导入恢复 |
| test_dashboard.py | /api/dashboard | 4 | 空默认结构 + 投递分布 + 面试指标 + 画像目标岗位聚合 |
| test_resume_flow.py | 简历库 → /api/resume/generate 链路 | 3 | 跨接口流程：创建 → 生成 → 保存 content → 拉回验证 |
| **test_auth.py** | `/api/auth/*` + 全部接口 | 57 | 表驱动：42 个接口无 token 一律 401；坏 token / 缺 Bearer / 篡改签名 / **过期 token**（用真实密钥在 py 端自签）全 401；重复注册 409、弱密码 400、错口令与未知用户给同一句话（防枚举）、连续失败 5 次锁 10 分钟 |
| **test_tenant_isolation.py** | 全部数据接口 | 20 | A/B 两用户：B 拿 A 的 id 读/改/删 → 404；列表互不可见；dashboard / backup 导出 / match 分析只算自己的；画像每人一份；请求体塞 `ownerId` 无效；备份导入不能污染别人 |
| **test_invite.py** | `/api/auth/invites*` + `/api/auth/register` | 21 | 邀请制：无码 403；有效码可注册且 token 可用、角色是 member；同码二次 403；过期 / 已撤销 / 伪造 / 差一位全 403；**并发 5 个抢同一码只成功 1 个**；非 owner 发码/看码/撤销全 403；列表能看出状态与「谁用掉的」；注册失败（重名 / 短密码）会把码退回 |

**合计 159 用例**（含老用例 61 条，一条未改 —— 见下方「默认身份注入」）。

> 岗位已全面放开：interview / apply / salary / prep / intro 均不再对「未知岗位」报 400，而是按「自定义岗位 + 可选自定义 JD」生成；analyze 的岗位推荐也不再限定知识库岗位名。

## 数据隔离（三层防护 + 默认身份注入）

0. **默认身份注入**（`conftest.py::_install_default_auth`）：会话开始时准备 `owner_test`（角色 owner）与 `intruder_test`（member），把 owner 的 token 注入到 `requests.sessions.Session.request`。于是 **61 个老用例一行不改**也能以「已登录的主人」身份跑；越权用例显式传 `headers=` 覆写（注入逻辑只在没有 `Authorization` 头时生效）。
   > 账号**不走注册接口**建：邀请制之后注册必须带邀请码，而「准备测试账号」是跑用例的前提，不能反过来依赖被测功能。改用 `scripts/create-user.mjs`（`--reset --role`），也就不需要在注册接口里开「测试模式」后门 —— 那种后门忘了关就是真漏洞。
   > 代价要说清楚：老用例因此看不到「未登录」这种状态。所以**另有一整套表驱动用例**（`test_auth.py`）把 42 个接口的无 token / 坏 token 逐个扫一遍 —— 注入省掉的是噪音，不是覆盖。
1. **会话前置检查**（`conftest.py::pytest_sessionstart`）：任何用例执行前，请求后端 `/api/health`，以下任一不满足就**直接拒绝运行**（exit code 1，不执行任何用例）：
   - 后端不可达 → 提示按本文件启动
   - `aiMock` 非 true（连的是真实 AI，会花钱且结果不稳定）
   - `dataDirIsolated` 非 true（后端未设 `JOB_HUNTER_DATA_DIR`，会污染真实数据）
   - pytest 进程自己没设 `JOB_HUNTER_DATA_DIR`（清理逻辑会误删真实数据）
2. **用例级清理**（`conftest.py::clean_runtime_data`）：每个测试函数前后清空**隔离目录**下的运行时数据 `{resumes,applications,records,profile,invites}.json`，保留 `jobs.json` 与 **`users.json`**。清理目标跟随 `JOB_HUNTER_DATA_DIR` 环境变量，与后端数据目录保持一致。
   > `invites.json` 也清：每个邀请制用例都从「一个码都没有」开始，用例之间不会看到彼此发的码。`users.json` 不能清 —— 删了 token 就指向一个不存在的用户，全部用例会一起 401。
3. **数据目录隔离**（`server/lib/store.js`）：后端读 `JOB_HUNTER_DATA_DIR` 环境变量决定数据目录，未设置时才用默认 `server/data/`（日常使用不受影响）。

## node 单测与真机验收（pytest 之外的两层）

pytest 只能证明「接口对不对」。另外两层各自补一个盲区：

| 命令 | 覆盖 | 补的盲区 |
|---|---|---|
| `npm run test:node` | 124 条（store 并发 13 / 邀请码纯函数 29 / 投递账本 17 / jobId 8 / 批量行解析 21 / 额度 36） | 纯函数边界（字符集、过期临界点）和并发行为 —— 这些在 HTTP 层要么测不到，要么得改文件造数据 |
| `npm run check:ui:login` | 真机 14 项（CDP 驱动本机 Chrome） | 「build 通过 ≠ 浏览器能用」。踩过的真 bug：`app.use(requireAuth)` 少写 `/api`，静态资源一起 401 白屏，**接口测试一条都不会红** |

真机验收怎么跑（需要一个 owner 账号来发码）：

```bash
# 起服务后，任选一种给邀请码来源
JH_OWNER_USER=chen JH_OWNER_PASS=xxx npm run check:ui:login      # 脚本自己登录 owner 现生成一个码
JH_INVITE_CODE=ABCD-EFGH-JKLM npm run check:ui:login             # 用现成的码

# 想顺便留一张设置页截图（样式问题只能靠看）
JH_OWNER_USER=chen JH_OWNER_PASS=xxx JH_SHOT=/tmp/settings.png npm run check:ui:login
```

## mock 注意事项

- `/api/tailor` 的 mock 分支关键词是「**简历优化专家**」，必须置于「求职顾问」分支之前（tailor 的 system prompt 也含「求职顾问」子串，会误命中 apply 分支导致缺 `tailoredResume` 字段）。
- `/api/resume/generate` 的 mock 分支关键词是「**简历排版顾问**」，必须置于「简历顾问」分支之前（resume/score 的 prompt 含「简历顾问」子串，特征词更具体的要放前面）。
- mock 默认监听 9999；若该端口被占（历史上 intern-report 残留 mock 占用过），用 `MOCK_PORT=9998 python tests/mock_deepseek.py` 换端口，并同步改后端启动命令的 `DEEPSEEK_BASE_URL`。
