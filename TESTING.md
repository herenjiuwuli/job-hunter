# 测试说明（job-hunter）

复用 resume-interview 的测试约定：**pytest（Python）+ mock DeepSeek**，覆盖全部 12 个后端路由的「校验路径 + 正路 + 匹配排序」。

## 环境准备（首次）

```bash
python -m venv .venv
.venv/Scripts/python -m pip install pytest requests
```

## 跑测三步

```bash
# 1. 起 mock DeepSeek（默认 9999，可用 MOCK_PORT 覆盖）
.venv/Scripts/python tests/mock_deepseek.py

# 2. 起后端（指向 mock）
DEEPSEEK_API_KEY=sk-test DEEPSEEK_BASE_URL=http://127.0.0.1:9999 PORT=3100 node server/dev.js

# 3. 跑测试
.venv/Scripts/python -m pytest tests/ -v
```

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

**合计 49 用例**。

> 岗位已全面放开：interview / apply / salary / prep / intro 均不再对「未知岗位」报 400，而是按「自定义岗位 + 可选自定义 JD」生成；analyze 的岗位推荐也不再限定知识库岗位名。

## 数据隔离

`conftest.py` 用 autouse fixture 在每个测试函数前后清空 `server/data/{resumes,applications,records,profile}.json`，**保留 `jobs.json`**（岗位知识库，apply/interview 依赖它）。

## mock 注意事项

- `/api/tailor` 的 mock 分支关键词是「**简历优化专家**」，必须置于「求职顾问」分支之前（tailor 的 system prompt 也含「求职顾问」子串，会误命中 apply 分支导致缺 `tailoredResume` 字段）。
- mock 默认监听 9999；若该端口被占（历史上 intern-report 残留 mock 占用过），用 `MOCK_PORT=9998 python tests/mock_deepseek.py` 换端口，并同步改后端启动命令的 `DEEPSEEK_BASE_URL`。
