# PreLook Rollup：VPS 部署详细教程（服务器上没有 Windows 路径时）

你的本机路径 `d:\Cursor\daimashicao\prelook-rollup-server\` **只在你电脑上存在**。VPS（Linux）上不会有这个盘符。你需要把 **包含 `prelook-rollup-server` 目录的那份代码** 弄到服务器上，再在服务器里进入 **`prelook-rollup-server`** 子目录运行 `server.mjs`。

---

## 一、整体流程（你要达成什么）

1. VPS 上有一份代码，其中包含 **`prelook-rollup-server/server.mjs`**。
2. 安装 **Node.js ≥ 18**，配置环境变量（至少 `PREDICT_API_KEY`）。
3. 运行服务后，本机应能访问：`http://127.0.0.1:4077/prelook/recent-matches-rollup`（若设置了密钥则需带 Header）。
4. 在 **Cloudflare Worker（predict-proxy）** 里设置 **`PRELOOK_ROLLUP_UPSTREAM`** 指向你的 VPS 公网地址（建议 HTTPS），前端 PreLook 请求的 `recent-rollup` 会优先走你的 VPS。

---

## 二、把代码弄到 VPS 上的三种方式

任选其一即可。

### 方式 A：Git 克隆整个「包含 prelook-rollup-server 的仓库」（推荐）

若你的项目托管在 GitHub/GitLab（例如仓库名 `daimashicao`，根目录下有 `prelook-rollup-server/`）：

```bash
cd ~
git clone https://github.com/你的用户名/你的仓库名.git
cd 你的仓库名/prelook-rollup-server
ls
# 应能看到 server.mjs、package.json
```

- **私有仓库**：先在服务器上配置 SSH Key 或使用带 token 的 HTTPS，否则 `git clone` 会失败。
- **没有 Git**：Ubuntu 上可执行：`sudo apt update && sudo apt install -y git`。

### 方式 B：只拷贝 `prelook-rollup-server` 文件夹（在你自己的电脑上操作）

在你 **Windows** 上打开 PowerShell（把 `你的VPS公网IP` 换成真实 IP；若用密钥登录，需加 `-i` 指定私钥）：

```powershell
scp -r "D:\Cursor\daimashicao\prelook-rollup-server" ubuntu@你的VPS公网IP:~/
```

然后在 **VPS** 上：

```bash
cd ~/prelook-rollup-server
ls
```

### 方式 C：打包 zip / tar 再上传

在你电脑上把 `prelook-rollup-server` 打成压缩包，用 **WinSCP、FileZilla、scp** 上传到 `~`，在 VPS 上解压：

```bash
cd ~
unzip prelook-rollup-server.zip   # 或 tar -xzf prelook-rollup-server.tar.gz
cd prelook-rollup-server
```

---

## 三、服务器环境：安装 Node.js

需要 **Node 18 或以上**（与 `package.json` 中 `engines` 一致）。

**使用 NodeSource（Ubuntu 示例）：**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
```

应显示 `v20.x` 或至少 `v18.x`。

---

## 四、安装依赖并确认入口文件

```bash
cd ~/你的路径/prelook-rollup-server
npm install
```

本项目无繁重依赖，`npm install` 很快。入口为：

```bash
node server.mjs
# 或
npm start
```

---

## 五、环境变量说明（必看）

| 变量 | 是否必填 | 说明 |
|------|----------|------|
| `PREDICT_API_KEY` | **必填** | Predict.fun 的 API Key，需与 Worker / 前端代理使用的一致。 |
| `PRELOOK_ROLLUP_PORT` | 可选 | HTTP 监听端口，默认 **4077**。 |
| `PRELOOK_ROLLUP_DATA` | 可选 | 状态文件路径，默认 **`./data/prelook_rollup.json`**。生产建议固定目录并备份，例如 `/var/lib/prelook/prelook_rollup.json`。 |
| `PRELOOK_ROLLUP_TICK_MS` | 可选 | 轮询间隔（毫秒），默认 **60000**（1 分钟）。 |
| `PRELOOK_ROLLUP_BOOTSTRAP` | 可选 | 设为 **`1`** 时，**启动阶段**会多拉一段近 24h 分页，**首次**想把窗口快速填满时很有用；**跑稳后建议改为 0 或删掉**，避免每次重启都打很多页。 |
| `PRELOOK_ROLLUP_SERVE_KEY` | **强烈建议** | 随机长字符串。设置后，访问 rollup 接口必须在 Header 里带 **`x-prelook-rollup-key: 同值`**，防止公网被扫。 |
| `PRELOOK_RECENT_TRADES_CAP` | 可选 | 在 **≥100 USDT** 前提下最多保留条数；默认约 **72000**，程序内硬上限 **100000**。 |
| `PREDICT_API_BASE` | 可选 | 默认 `https://api.predict.fun`，一般不用改。 |

**注意**：rollup 逻辑与 PreLook 展示一致，服务端会先筛 **≥100 USDT** 再写入状态；不是「全市场每一笔记账」，而是「大单展示策略」。

---

## 六、第一次手动试运行（验证）

在 `prelook-rollup-server` 目录下：

```bash
mkdir -p data
export PREDICT_API_KEY="你的_predict_api_key"
# 首次可打开：
export PRELOOK_ROLLUP_BOOTSTRAP=1
# 建议设密钥（与 Worker 里 PRELOOK_ROLLUP_UPSTREAM_KEY 一致）：
export PRELOOK_ROLLUP_SERVE_KEY="你自己生成的长随机串"

node server.mjs
```

看到类似日志：

- `[prelook-rollup] listening :4077 ...`
- bootstrap 时可能有 `fetching up to 24h window`

**本机测接口**（另开一个 SSH 窗口）：

```bash
# 若未设置 PRELOOK_ROLLUP_SERVE_KEY：
curl -sS "http://127.0.0.1:4077/prelook/recent-matches-rollup" | head -c 400

# 若已设置密钥：
curl -sS -H "x-prelook-rollup-key: 你的随机串" "http://127.0.0.1:4077/prelook/recent-matches-rollup" | head -c 400
```

能返回 JSON（含 `trades`、`updatedAt` 等）即说明服务正常。前台测试完成后用 **Ctrl+C** 停掉，下一节用 PM2 常驻。

---

## 七、生产常驻：PM2（推荐）

```bash
sudo npm install -g pm2
cd ~/你的路径/prelook-rollup-server

# 用环境变量启动（不要把 key 写进命令历史可考虑用 ecosystem 文件或 export + pm2）
export PREDICT_API_KEY="你的key"
export PRELOOK_ROLLUP_SERVE_KEY="你的长随机串"
# 首次跑稳后建议不要再长期开着 BOOTSTRAP：
# export PRELOOK_ROLLUP_BOOTSTRAP=1

pm2 start server.mjs --name prelook-rollup
pm2 save
pm2 startup
# 按提示执行一条 sudo 命令，保证重启后 PM2 自启
```

查看日志：

```bash
pm2 logs prelook-rollup
```

---

## 八、防火墙与安全组

- **云厂商安全组 / 本机 ufw**：若只让 **Cloudflare Worker** 访问，可 **不** 对公网开放 `4077`，改为 only Nginx 443；或限制来源 IP。
- 若临时公网直连测试：放行 **`PRELOOK_ROLLUP_PORT`**（默认 4077），并 **务必** 配置 **`PRELOOK_ROLLUP_SERVE_KEY`**。

---

## 九、（可选）Nginx 反向代理 + HTTPS

Worker 侧 `PRELOOK_ROLLUP_UPSTREAM` 建议使用 **`https://rollup.你的域名`**（无尾斜杠）。

示例思路（需自行申请证书，如 Let’s Encrypt）：

- 对外：`https://rollup.你的域名` → `proxy_pass http://127.0.0.1:4077;`
- 可选：在 Nginx 层再加 IP 白名单或 mTLS（进阶）。

---

## 十、Cloudflare Worker（predict-proxy）对接

在 Worker **环境变量**中设置：

1. **`PRELOOK_ROLLUP_UPSTREAM`**  
   - 例：`https://rollup.你的域名` 临时调试也可 `http://你的VPS公网IP:4077`（不推荐长期裸 HTTP）。

2. **`PRELOOK_ROLLUP_UPSTREAM_KEY`**（若 VPS 设置了 `PRELOOK_ROLLUP_SERVE_KEY`）  
   - 与 VPS 上的值 **完全一致**。

效果：

- 浏览器请求 **`GET .../api/v1/orders/matches/recent-rollup`** 时，Worker **优先转发到你的 VPS**。
- 配置了 `PRELOOK_ROLLUP_UPSTREAM` 后，Worker **不再**为这份 rollup **写 KV 大翻页**（由 VPS 专职维护）；KV 仍可用于你项目里其它功能。

部署 Worker：`wrangler deploy` 或在 Cloudflare 控制台保存变量后发布。

---

## 十一、常见错误排查

| 现象 | 可能原因 |
|------|----------|
| `cd .../prelook-rollup-server: No such file` | 你克隆/上传的是别的仓库或路径错了；用 `find ~ -name server.mjs 2>/dev/null` 找文件位置。 |
| `missing PREDICT_API_KEY` | 未 export 或未在 PM2 ecosystem 里写环境变量。 |
| Worker 401 / VPS 无数据 | `x-prelook-rollup-key` 与 `PRELOOK_ROLLUP_SERVE_KEY` / `PRELOOK_ROLLUP_UPSTREAM_KEY` 不一致。 |
| 启动后只有近 1h 量级 | 未开 bootstrap 且刚启动：等多轮轮询，或**一次性**设 `PRELOOK_ROLLUP_BOOTSTRAP=1` 重启。 |
| 磁盘文件越来越大 | 正常；状态文件含近 24h 聚合；注意磁盘与备份策略。 |

---

## 十二、与你本机路径的对应关系

| 你电脑 (Windows) | VPS (Linux) |
|------------------|------------|
| `d:\Cursor\daimashicao\prelook-rollup-server\` | 例如 `/home/ubuntu/daimashicao/prelook-rollup-server/`（取决于你 clone/解压到哪） |

**没有「盘符 d:」** 是正常的；只要在 Linux 上 **`cd` 到含有 `server.mjs` 的目录** 即可。

---

## 十三、最小检查清单

- [ ] VPS 上 `prelook-rollup-server/server.mjs` 存在  
- [ ] `node -v` ≥ 18  
- [ ] `npm install` 已执行  
- [ ] `PREDICT_API_KEY` 已配置  
- [ ] `curl` 本机或 HTTPS 域名能拉到 JSON  
- [ ] Worker 已设置 `PRELOOK_ROLLUP_UPSTREAM`（及密钥若启用）  
- [ ] `pm2` 或 systemd 已配置常驻  

完成以上步骤后，PreLook 网页即可优先使用你在 VPS 上维护的近 24h 成交 rollup。
