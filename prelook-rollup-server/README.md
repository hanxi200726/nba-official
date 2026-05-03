# PreLook 近 24h 成交 rollup（VPS 常驻）

在**你自己的服务器**上持久化「近 24h」成交：每分钟只向 Predict 拉 **最近约 1h** 的分页，与前一轮本地缓冲合并、去重、裁窗口，**不**在 Cloudflare 上疯狂翻页，也不依赖 Worker KV 大流量写入。

**服务器上没有本机 Windows 路径？** 请看 **[DEPLOY-VPS-教程.md](./DEPLOY-VPS-教程.md)**（克隆/上传、`PREDICT_API_KEY`、PM2、Worker 对接一步一步写全）。

## 行为说明

- **持久化文件**（默认 `./data/prelook_rollup.json`）：服务重启后仍延续近 24h 缓冲（需磁盘不丢）。
- **冷启动**：若无数据文件，前几轮可能只有约 1h 量级；持续运行后窗口趋近满 24h。需要**首次尽快补满**时设 `PRELOOK_ROLLUP_BOOTSTRAP=1`（分页较多，建议仅首次或偶发使用）。
- **展示策略**：与 PreLook 一致——仅 **≥100 USDT**，条数由 `PRELOOK_RECENT_TRADES_CAP` 控制（默认约 72000，硬上限 100000）；超出窗口或过旧的记录会被裁掉。合并后使用**按小时分桶的公平裁剪**，减轻「整段小时被挤没」的情况。

## 环境变量

| 变量 | 说明 |
|------|------|
| `PREDICT_API_KEY` | **必填**，与 Worker 相同 Predict API Key |
| `PRELOOK_ROLLUP_PORT` | HTTP 端口，默认 `4077` |
| `PRELOOK_ROLLUP_DATA` | 状态文件路径，默认 `./data/prelook_rollup.json` |
| `PRELOOK_ROLLUP_SERVE_KEY` | 可选；若设置，请求须带 `x-prelook-rollup-key: <同值>` |
| `PRELOOK_ROLLUP_TICK_MS` | 轮询间隔 ms，默认 `60000` |
| `PRELOOK_ROLLUP_BOOTSTRAP` | 设为 `1` 时启动时尝试一次性补足 24h（分页多） |
| `PRELOOK_RECENT_TRADES_CAP` | 可选；≥100U 前提下保留条数上限（默认 72000，最大 100000） |

## Cloudflare Worker

在 Worker 环境变量中设置 `PRELOOK_ROLLUP_UPSTREAM`（例如 `https://rollup.你的域名` 或 `http://你的IP:4077`，**不要**尾斜杠），可选 `PRELOOK_ROLLUP_UPSTREAM_KEY` 与上面 `PRELOOK_ROLLUP_SERVE_KEY` 一致。  
设置后，`GET /api/v1/orders/matches/recent-rollup` 会优先从该 VPS 读取；失败时仍回退 KV（若已绑定）。

## 运行示例

```bash
cd prelook-rollup-server
export PREDICT_API_KEY=你的key
# export PRELOOK_ROLLUP_SERVE_KEY=随机长串   # 建议与 Worker 密钥一致
mkdir -p data
node server.mjs
```

生产可用 `pm2 start server.mjs --name prelook-rollup` 等守护。

建议在 VPS 前加 **Nginx HTTPS**，Worker 填写 `https://rollup.你的域名` 作为 `PRELOOK_ROLLUP_UPSTREAM`。
