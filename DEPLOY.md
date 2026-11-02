# 部署指南（仅自己使用）

> 前置：本地已按 [`ONBOARDING.md`](ONBOARDING.md) 跑通 7 步联调。没跑通先别部署。

---

## 先说结论：现在能直接暴露公网了，但有三件事必须先做

本项目自 2026-11 起**有登录、有数据隔离、有邀请制**（细节见 README §2.2）。所以老版本那句
「任何人打开你的地址都能看到你的简历」已经不再成立 —— 但前提是下面三条都做了：

| # | 必须做 | 不做会怎样 |
|---|---|---|
| 1 | **先在本机注册第一个账号**（它会成为 owner），确认能登录 | 库是空的，谁先在公网访问谁就成为 owner |
| 2 | **设 `JWT_SECRET` 环境变量**（一串长随机串） | 密钥会落在 `server/data/.jwt-secret`；换了机器/拷了数据目录，token 签名密钥跟着走，泄露一处全部失效 |
| 3 | **确认注册要邀请码**：登录后进「账号设置」，能看见邀请码卡片就对了 | 看不见说明你不是 owner，`npm run user:create -- --list` 查一下 |

> 邀请制的第一个口子是「一个新账号都没有时允许直接注册」。所以**顺序很重要**：
> 先在本地把自己注册好、确认账号是 owner，再开放端口 —— 不要先开放再去注册。

如果你还想再加一层，反代 Basic Auth 依然是成本最低的（见第 6 步），但它是「第二道锁」，
不再是唯一一道。**不推荐再把服务只绑 127.0.0.1**：那样扩展（浏览器里跑的）连不上，
除非你愿意每次用 SSH 隧道。

---

## 方案对比

| 方案 | 成本 | 数据持久性 | 适合 |
|---|---|---|---|
| **云服务器**（腾讯云轻量 / 阿里云 ECS 等） | 每月几十元量级（以官网当前价为准） | ✅ 磁盘持久 | ⭐ 推荐，长期用 |
| **自己电脑 + 内网穿透**（cpolar / natapp / frp） | 免费~几十元 | ✅ 本机磁盘 | 想零服务器成本，但电脑得一直开着 |
| Render / Railway 免费层 | 免费 | ❌ **磁盘不持久，重启数据会丢** | ⚠️ 不推荐（除非改成数据库） |

> 为什么免费层不行：项目数据存在 `server/data/*.json`，而免费层容器的磁盘是临时的。
> 你的投递记录、简历库会在某次重启后消失。

---

## 推荐方案：云服务器部署

### 1. 服务器准备

```bash
# 装 Node 22（以 Ubuntu 为例，用 nvm 更省心）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
node -v   # 应为 v22.x
```

### 2. 拉代码装依赖

```bash
git clone https://github.com/herenjiuwuli/job-hunter.git
cd job-hunter
npm install
```

### 3. 配环境变量

```bash
cp .env.example .env
vi .env
```

至少填两项：

```ini
DEEPSEEK_API_KEY=sk-你的key
JWT_SECRET=一串够长的随机串        # 生成：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> `JWT_SECRET` 不设也能跑（会自动生成并写到 `server/data/.jwt-secret`），但设成环境变量的好处是：
> 重建容器 / 换机器时不会因为数据目录没带过来，导致所有人被踢下线。

### 4. 构建并启动

```bash
npm run build    # 生成 dist/
npm start        # 单端口运行：前端 + /api 都在 3100
```

验证（服务器上执行）：

```bash
curl http://127.0.0.1:3100/api/health         # 应返回 {"status":"ok",...}
curl -I http://127.0.0.1:3100/profile         # 应返回 200（SPA 路由回落正常）
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/resumes   # 应返回 401（鉴权生效）
```

最后那条 **401 才是对的**：静态页能开、接口没 token 进不来。如果它返回 200，
说明你跑的是改造前的老版本，别急着开放端口。

### 5. 用 pm2 守护（关掉终端也不停）

```bash
npm i -g pm2
pm2 start server/start.js --name job-hunter
pm2 save
pm2 startup        # 按提示执行它输出的那条命令，实现开机自启
pm2 logs job-hunter
```

### 6. 可选加固：反代再加一层 Basic Auth

应用自己已经有登录了，这一层是「万一哪天出个权限漏子」的第二道锁。不想折腾可以跳过。

```bash
sudo apt install -y nginx apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd 你的用户名
```

nginx 配置 `/etc/nginx/sites-available/job-hunter`：

```nginx
server {
    listen 80;
    server_name 你的域名或IP;

    location / {
        auth_basic "job-hunter";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/job-hunter /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> 有域名的话再用 certbot 配 HTTPS（走 HTTPS 后扩展里的地址也要同步改成 https）。

---

## 部署后必做：改 Chrome 扩展的后端地址 + 填 token

扩展不再写死地址，两样东西都在**扩展弹窗 → 记录 → 后端连接**里配（存在 `chrome.storage.local`）：

| 配什么 | 填什么 |
|---|---|
| 后端地址 | 你的实际地址，如 `http://你的IP:3100`（别带结尾斜杠） |
| 登录 token | 在网页里登录后，`localStorage.jh_token` 的值（F12 → Application → Local Storage） |

改完点「保存并测试」，看到「连接正常」才算通。token 有效期 7 天，过期后回写会 401，
弹窗会提示「token 失效」—— 重新从网页复制一个即可。

> `manifest.json` 的 `host_permissions` 里已有 `http://localhost/*`，**换成公网 IP 或域名时要加一条**，
> 否则扩展的请求会被浏览器拦掉（不是后端 401，是请求根本没发出去）。改完在
> `chrome://extensions` 点刷新重新加载。

---

## 数据备份（别偷懒）

数据全在 `server/data/*.json`，服务器挂了就没了。加一条定时任务：

```bash
mkdir -p ~/job-hunter-backup
crontab -e
# 每天凌晨 3 点备份
0 3 * * * tar czf ~/job-hunter-backup/data-$(date +\%Y\%m\%d).tar.gz -C ~/job-hunter/server data
```

`.gitignore` 已排除 `profile.json`（含薪资等敏感信息），所以备份包里若含它，**别上传到公开地方**。

---

## 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| 打开页面 404 | 没 `npm run build`，或 build 前就启动了 | 先 build 再 `npm start` |
| 页面能开但 AI 功能报错 | `.env` 没配 key，或 key 无效 | 检查 `.env`，改完 `pm2 restart job-hunter` |
| 直接访问 `/profile` 404 | 老版本代码（无 SPA 回落） | 拉最新代码重新 build |
| 端口不通 | 云服务器安全组没放行端口 | 去控制台放行 3100（或只放行你的 IP） |
| pm2 起了但访问不了 | 服务崩了 | `pm2 logs job-hunter` 看报错 |
