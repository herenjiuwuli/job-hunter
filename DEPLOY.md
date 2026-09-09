# 部署指南（仅自己使用）

> 前置：本地已按 [`ONBOARDING.md`](ONBOARDING.md) 跑通 7 步联调。没跑通先别部署。

---

## ⚠️ 先看这段：安全警告

本项目**没有登录、没有任何鉴权**。一旦把 3100 端口直接暴露到公网，
**任何人打开你的地址都能看到你的简历、投递记录、薪资预期和候选人画像，还能改能删。**

所以"只给自己用"部署时，**至少做其中一条**：

| 防护方式 | 做法 | 推荐度 |
|---|---|---|
| **A. 只听本地 + SSH 隧道** | 服务只监听 `127.0.0.1`，访问时用 `ssh -L 3100:127.0.0.1:3100 user@server` 把端口映射到本机 | ⭐ 最安全 |
| **B. nginx 加 Basic Auth** | 反代层加一层账号密码（下面有配置） | ⭐ 常用 |
| **C. 防火墙只放行你的 IP** | 云服务器安全组只放行你家宽带的公网 IP | 简单，但 IP 会变 |
| ~~D. 什么都不做直接暴露~~ | — | ❌ 等于公开你的简历 |

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
vi .env          # 填 DEEPSEEK_API_KEY=sk-你的key
```

### 4. 构建并启动

```bash
npm run build    # 生成 dist/
npm start        # 单端口运行：前端 + /api 都在 3100
```

验证（服务器上执行）：

```bash
curl http://127.0.0.1:3100/api/health      # 应返回 {"status":"ok"}
curl -I http://127.0.0.1:3100/profile      # 应返回 200（SPA 路由回落正常）
```

### 5. 用 pm2 守护（关掉终端也不停）

```bash
npm i -g pm2
pm2 start server/start.js --name job-hunter
pm2 save
pm2 startup        # 按提示执行它输出的那条命令，实现开机自启
pm2 logs job-hunter
```

### 6. 加 Basic Auth（如果选了防护方式 B）

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

## 部署后必做：改 Chrome 扩展的后端地址

扩展里有两处写死了本地地址，**不改的话扩展连不上新部署的服务**：

| 文件 | 位置 | 改成 |
|---|---|---|
| `extension/content.js` | 第 7 行 `const BACKEND = 'http://localhost:3100'` | 你的实际地址，如 `http://你的IP:3100` |
| `extension/manifest.json` | `host_permissions` 数组 | 对应改成 `"http://你的IP:3100/*"` |

改完在 `chrome://extensions` 点刷新重新加载。

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
