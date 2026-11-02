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
| **test_auth.py** | `/api/auth/*` + 全部接口 | 54 | 表驱动：39 个接口无 token 一律 401；坏 token / 缺 Bearer / 篡改签名 / **过期 token**（用真实密钥在 py 端自签）全 401；重复注册 409、弱密码 400、错口令与未知用户给同一句话（防枚举）、连续失败 5 次锁 10 分钟 |
| **test_tenant_isolation.py** | 全部数据接口 | 20 | A/B 两用户：B 拿 A 的 id 读/改/删 → 404；列表互不可见；dashboard / backup 导出 / match 分析只算自己的；画像每人一份；请求体塞 `ownerId` 无效；备份导入不能污染别人 |

**合计 135 用例**（含老用例 61 条，一条未改 —— 见下方「默认身份注入」）。

> 岗位已全面放开：interview / apply / salary / prep / intro 均不再对「未知岗位」报 400，而是按「自定义岗位 + 可选自定义 JD」生成；analyze 的岗位推荐也不再限定知识库岗位名。

## 数据隔离（三层防护 + 默认身份注入）

0. **默认身份注入**（`conftest.py::_install_default_auth`）：会话开始时注册/登录 `owner_test` 与 `intruder_test`，把 owner 的 token 注入到 `requests.sessions.Session.request`。于是 **61 个老用例一行不改**也能以「已登录的主人」身份跑；越权用例显式传 `headers=` 覆写（注入逻辑只在没有 `Authorization` 头时生效）。
   > 代价要说清楚：老用例因此看不到「未登录」这种状态。所以**另有一整套表驱动用例**（`test_auth.py`）把 39 个接口的无 token / 坏 token 逐个扫一遍 —— 注入省掉的是噪音，不是覆盖。
1. **会话前置检查**（`conftest.py::pytest_sessionstart`）：任何用例执行前，请求后端 `/api/health`，以下任一不满足就**直接拒绝运行**（exit code 1，不执行任何用例）：
   - 后端不可达 → 提示按本文件启动
   - `aiMock` 非 true（连的是真实 AI，会花钱且结果不稳定）
   - `dataDirIsolated` 非 true（后端未设 `JOB_HUNTER_DATA_DIR`，会污染真实数据）
   - pytest 进程自己没设 `JOB_HUNTER_DATA_DIR`（清理逻辑会误删真实数据）
2. **用例级清理**（`conftest.py::clean_runtime_data`）：每个测试函数前后清空**隔离目录**下的运行时数据 `{resumes,applications,records,profile}.json`，保留 `jobs.json` 与 **`users.json`**。清理目标跟随 `JOB_HUNTER_DATA_DIR` 环境变量，与后端数据目录保持一致。
   > `users.json` 不能清：删了 token 就指向一个不存在的用户，所有用例会一起 401。
3. **数据目录隔离**（`server/lib/store.js`）：后端读 `JOB_HUNTER_DATA_DIR` 环境变量决定数据目录，未设置时才用默认 `server/data/`（日常使用不受影响）。

## mock 注意事项

- `/api/tailor` 的 mock 分支关键词是「**简历优化专家**」，必须置于「求职顾问」分支之前（tailor 的 system prompt 也含「求职顾问」子串，会误命中 apply 分支导致缺 `tailoredResume` 字段）。
- `/api/resume/generate` 的 mock 分支关键词是「**简历排版顾问**」，必须置于「简历顾问」分支之前（resume/score 的 prompt 含「简历顾问」子串，特征词更具体的要放前面）。
- mock 默认监听 9999；若该端口被占（历史上 intern-report 残留 mock 占用过），用 `MOCK_PORT=9998 python tests/mock_deepseek.py` 换端口，并同步改后端启动命令的 `DEEPSEEK_BASE_URL`。
