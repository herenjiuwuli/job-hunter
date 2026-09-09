# 上线联调清单（job-hunter）

上线前用真实 DeepSeek key 完整走一遍，确认所有功能真机可用。下面按顺序执行，每步都有验证点。

## 0. 前置

- Node 20+（本项目实测 22.22.2）
- 一个可用的 DeepSeek API key

## 1. 装依赖

```bash
cd D:\Projects\job-hunter
npm install --cache /c/Users/29322/.workbuddy/binaries/node/workspace/.npm-cache
```

> `--cache` 是为了绕开 Windows 上 npm 的 EPERM 坑；源已配 npmmirror。

## 2. 配 key

```bash
cp .env.example .env
```

编辑 `.env`：

```
PORT=3100
DEEPSEEK_API_KEY=sk-你的真实key
DEEPSEEK_BASE_URL=https://api.deepseek.com
```

> 纯 CRUD（简历库/投递追踪/候选人画像）不依赖 key；AI 功能（定制/匹配/面试）必须有 key。

## 3. 启动

```bash
npm run dev
```

- 前端：http://localhost:5173
- 后端：http://localhost:3100（`curl http://localhost:3100/api/health` 应返回 `{"status":"ok"}`）

## 4. 联调验证点（按顺序走）

| # | 页面 | 操作 | 验证什么 |
|---|---|---|---|
| 1 | 候选人画像 | 填基本/工作授权/目标岗位 → 保存 → 刷新页面 | 画像持久化、增量合并（改一项不动其他） |
| 2 | 简历库 | 新建一份简历 | CRUD 正常 |
| 3 | 写简历 | 「从简历库加载」→ 选目标岗位 → AI 生成 | 简历↔简历库双向联动 |
| 4 | 投递追踪 | 新建投递 → 关联简历 → AI 定制 → 看「投递结果」下拉 | **5 态结果机**（待处理/已确认提交/跳过/被拦截/需用户） |
| 5 | 匹配排序 | 选简历 → 看打分排序 | 关键词权重打分 |
| 6 | 简历分析 | 输入**知识库外的岗位**（如「游戏策划」「UI 设计师」） | 岗位不限、AI 自由推荐 |
| 7 | 模拟面试 | 用第 6 步的自定义岗位 + 自定义 JD 开一场 | 任意岗位都能出题 |

**重点验证 #4 和 #6**：这是本轮「岗位不限 + applypilot 结果机」两个新能力，是上线适配大众需求的关键。

## 5. 常见坑

| 现象 | 处理 |
|---|---|
| 3100 被占 | `netstat -ano \| findstr :3100` 查 PID → `taskkill //F //PID <pid>` |
| `build` 清 dist 被 safe-delete 拦 | 用绝对路径 `Remove-Item -LiteralPath 'D:\Projects\job-hunter\dist' -Recurse -Force` |
| AI 返回「不是合法 JSON」 | 多为 key 欠费/限流，换 key 或稍后重试 |
| 面试出题跑偏 | 确认面试前在「简历分析」页填了自定义 JD |

## 6. 上线部署（可选）

**跑通上面 7 步后**，如果要把服务放到服务器上让自己随时访问，见 [`DEPLOY.md`](DEPLOY.md)。

本地也可以先体验「生产模式」（单端口同时提供前端 + API）：

```bash
npm run build
npm start          # 打开 http://localhost:3100
```

> ⚠️ 部署到公网前**务必先看 DEPLOY.md 的安全警告**：本项目没有登录鉴权，端口直接暴露等于公开你的简历和投递记录。
