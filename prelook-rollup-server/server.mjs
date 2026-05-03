import fs from "fs";
import path from "path";
import http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PREDICT_API_BASE = process.env.PREDICT_API_BASE || "https://api.predict.fun";
const PREDICT_API_KEY = (process.env.PREDICT_API_KEY || "").trim();
const PORT = Number(process.env.PRELOOK_ROLLUP_PORT || 4077);
const DATA_PATH = process.env.PRELOOK_ROLLUP_DATA || path.join(__dirname, "data", "prelook_rollup.json");
const SERVE_KEY = (process.env.PRELOOK_ROLLUP_SERVE_KEY || "").trim();
const TICK_MS = Math.max(15_000, Number(process.env.PRELOOK_ROLLUP_TICK_MS || 60_000));
const BOOTSTRAP = String(process.env.PRELOOK_ROLLUP_BOOTSTRAP || "").trim() === "1";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const POLL_WINDOW_MS = 60 * 60 * 1000;
const RECENT_TRADES_MIN_USDT_WEI = BigInt(100) * 10n ** 18n;
const RECENT_TRADES_SAVE_CAP_DEFAULT = 72_000;
const RECENT_TRADES_SAVE_CAP_MAX = 100_000;
const RECENT_ROLLUP_HOUR_MS = 60 * 60 * 1000;
const RECENT_ROLLUP_HOUR_BUCKETS = 24;

function resolveRecentTradesSaveCap() {
  const raw = process.env.PRELOOK_RECENT_TRADES_CAP;
  if (raw == null || String(raw).trim() === "") return RECENT_TRADES_SAVE_CAP_DEFAULT;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n)) return RECENT_TRADES_SAVE_CAP_DEFAULT;
  return Math.min(RECENT_TRADES_SAVE_CAP_MAX, Math.max(2000, n));
}
/** 单次轮询只覆盖约 1h：分页上限足够但不会拉到 24h 深度 */
const MAX_PAGES_PER_POLL = 55;
/** 启动 bootstrap 时允许更多页（仅当 PRELOOK_ROLLUP_BOOTSTRAP=1） */
const MAX_PAGES_BOOTSTRAP = 220;

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

function mapPredictMatchNodeToEvent(node, idx) {
  const marketId = node.market?.id ?? node.marketId ?? "";
  const marketTitle = node.market?.title ?? node.market?.question ?? undefined;
  const amountFilledWei = BigInt(node.amountFilled ?? "0");
  const priceExecutedWei = BigInt(node.priceExecuted ?? "0");
  const scale = 10n ** 18n;
  const notionalWei =
    amountFilledWei > 0n && priceExecutedWei > 0n ? (amountFilledWei * priceExecutedWei) / scale : 0n;

  const makerObj = Array.isArray(node.makers) && node.makers.length > 0 ? node.makers[0] : undefined;
  const rawMaker =
    makerObj?.signer ??
    makerObj?.address ??
    makerObj?.walletAddress ??
    node.maker?.signer ??
    node.maker?.address ??
    node.maker?.walletAddress ??
    node.maker;
  const rawTaker = node.taker?.signer ?? node.taker?.address ?? node.taker?.walletAddress ?? node.taker;

  const maker =
    typeof rawMaker === "string"
      ? rawMaker
      : rawMaker && typeof rawMaker === "object"
        ? rawMaker.address ?? rawMaker.walletAddress ?? rawMaker.id
        : undefined;
  const taker =
    typeof rawTaker === "string"
      ? rawTaker
      : rawTaker && typeof rawTaker === "object"
        ? rawTaker.address ?? rawTaker.walletAddress ?? rawTaker.id
        : undefined;

  return {
    id: node.id ?? String(idx),
    marketId: String(marketId),
    marketTitle: marketTitle ? String(marketTitle) : undefined,
    maker: maker ? String(maker) : undefined,
    taker: taker ? String(taker) : undefined,
    side: node.taker?.quoteType === "Bid" ? "BUY" : "SELL",
    filledMakerAmount: amountFilledWei.toString(),
    filledTakerAmount: notionalWei.toString(),
    pricePerShareWei: priceExecutedWei.toString(),
    timestamp: node.executedAt ?? "",
  };
}

async function fetchPredictMatchesPage(cursor) {
  const params = new URLSearchParams({ first: "200" });
  if (cursor) params.set("after", cursor);
  const r = await fetch(`${PREDICT_API_BASE}/v1/orders/matches?${params}`, {
    headers: { "x-api-key": PREDICT_API_KEY, Accept: "application/json" },
  });
  if (!r.ok) return { ok: false, nodes: [], nextCursor: null, lastTs: Number.NaN };
  const data = await r.json();
  const nodes = data?.data ?? data?.nodes ?? [];
  if (!Array.isArray(nodes) || !nodes.length) {
    return { ok: true, nodes: [], nextCursor: null, lastTs: Number.NaN };
  }
  const last = nodes[nodes.length - 1];
  const lastTs = last?.executedAt ? Date.parse(last.executedAt) : Number.POSITIVE_INFINITY;
  const nextCursor = data?.cursor ?? data?.pageInfo?.endCursor ?? null;
  return { ok: true, nodes, nextCursor, lastTs };
}

async function fetchMatchEventsSince(sinceMs, maxPages) {
  const allNodes = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const { ok, nodes, nextCursor, lastTs } = await fetchPredictMatchesPage(cursor);
    if (!ok || !nodes.length) break;
    allNodes.push(...nodes);
    cursor = nextCursor;
    if (Number.isFinite(lastTs) && lastTs < sinceMs) break;
    if (!cursor) break;
  }
  const events = allNodes.map((node, i) => mapPredictMatchNodeToEvent(node, i));
  return events.filter((e) => {
    if (!e.timestamp) return false;
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= sinceMs;
  });
}

function prelookEventNotionalWei(e) {
  try {
    let amount = BigInt(e?.filledTakerAmount || "0");
    if (amount === 0n) {
      const shares = BigInt(e?.filledMakerAmount || "0");
      const price = BigInt(e?.pricePerShareWei || "0");
      if (shares > 0n && price > 0n) {
        amount = (shares * price) / 10n ** 18n;
      }
    }
    return amount;
  } catch {
    return 0n;
  }
}

function filterPrelookMinNotional(events) {
  return (events || []).filter((e) => prelookEventNotionalWei(e) >= RECENT_TRADES_MIN_USDT_WEI);
}

function filterPrelookEventsToWindow(events, fromMs, toMs) {
  return events.filter((e) => {
    if (!e || !e.timestamp) return false;
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= fromMs && t <= toMs;
  });
}

function dedupePrelookMatchEvents(events) {
  const m = new Map();
  for (const e of events) {
    if (e && e.id) m.set(e.id, e);
  }
  return [...m.values()];
}

function mergePrelookRecentRollup(previous, fresh, windowStartMs, nowMs) {
  const byId = new Map();
  for (const e of previous) {
    if (e && e.id) byId.set(e.id, e);
  }
  const pollStart = nowMs - POLL_WINDOW_MS;
  for (const e of fresh) {
    if (!e || !e.id) continue;
    const t = Date.parse(e.timestamp ?? "");
    if (Number.isNaN(t) || t < pollStart - 5000 || t > nowMs + 5000) continue;
    byId.set(e.id, e);
  }
  return filterPrelookEventsToWindow([...byId.values()], windowStartMs, nowMs);
}

function capPrelookRollupTradesTimeFair(events, cap, windowStartMs) {
  if (!events || events.length <= cap) return events;
  const buckets = Array.from({ length: RECENT_ROLLUP_HOUR_BUCKETS }, () => []);
  for (const e of events) {
    if (!e) continue;
    const t = Date.parse(e.timestamp ?? "");
    let idx = 0;
    if (!Number.isNaN(t)) {
      idx = Math.floor((t - windowStartMs) / RECENT_ROLLUP_HOUR_MS);
      if (idx < 0) idx = 0;
      if (idx >= RECENT_ROLLUP_HOUR_BUCKETS) idx = RECENT_ROLLUP_HOUR_BUCKETS - 1;
    }
    buckets[idx].push(e);
  }
  const base = Math.floor(cap / RECENT_ROLLUP_HOUR_BUCKETS);
  const picked = new Set();
  const leftover = [];
  const sortAscNotional = (a, b) => {
    const na = prelookEventNotionalWei(a);
    const nb = prelookEventNotionalWei(b);
    if (na !== nb) return na < nb ? -1 : na > nb ? 1 : 0;
    const ta = Date.parse(a.timestamp ?? "");
    const tb = Date.parse(b.timestamp ?? "");
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  };
  for (const arr of buckets) {
    if (!arr.length) continue;
    arr.sort(sortAscNotional);
    const take = Math.min(base, arr.length);
    for (let j = arr.length - take; j < arr.length; j += 1) {
      picked.add(arr[j]);
    }
    for (let j = 0; j < arr.length - take; j += 1) {
      leftover.push(arr[j]);
    }
  }
  const remaining = cap - picked.size;
  if (remaining > 0 && leftover.length) {
    leftover.sort(sortAscNotional);
    const add = leftover.slice(Math.max(0, leftover.length - remaining));
    for (const e of add) picked.add(e);
  }
  const out = [...picked];
  out.sort((a, b) => {
    const ta = Date.parse(a.timestamp ?? "");
    const tb = Date.parse(b.timestamp ?? "");
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
  return out;
}

async function fetchPredictMarketImageUrl(marketId) {
  const id = String(marketId || "").trim();
  if (!id) return null;
  try {
    const r = await fetch(`${PREDICT_API_BASE}/v1/markets/${encodeURIComponent(id)}`, {
      headers: { "x-api-key": PREDICT_API_KEY, Accept: "application/json" },
    });
    if (!r.ok) return null;
    const body = await r.json();
    const data = body?.data ?? body?.market ?? body;
    const raw = data?.imageUrl ?? data?.image_url ?? data?.icon;
    if (typeof raw !== "string" || !raw.trim()) return null;
    let u = raw.trim();
    if (u.startsWith("//")) u = `https:${u}`;
    return u;
  } catch {
    return null;
  }
}

async function extendMarketImagesForTrades(trades, prevMap) {
  const prev = prevMap && typeof prevMap === "object" ? { ...prevMap } : {};
  const ids = [...new Set(trades.map((t) => t.marketId).filter(Boolean))];
  const need = ids.filter((id) => !prev[id]).slice(0, 12);
  const rows = await Promise.all(
    need.map(async (mid) => {
      const u = await fetchPredictMarketImageUrl(mid);
      return { mid, u };
    }),
  );
  for (const { mid, u } of rows) {
    if (u) prev[mid] = u;
  }
  const keep = new Set(ids);
  for (const k of Object.keys(prev)) {
    if (!keep.has(k)) delete prev[k];
  }
  return prev;
}

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_PATH, "utf8");
    const p = JSON.parse(raw);
    if (p && typeof p === "object" && Array.isArray(p.trades)) {
      return {
        trades: p.trades,
        marketImages: p.marketImages && typeof p.marketImages === "object" ? p.marketImages : {},
        lastSuccessPollMs: typeof p.lastSuccessPollMs === "number" ? p.lastSuccessPollMs : 0,
      };
    }
  } catch {
    /* missing or corrupt */
  }
  return { trades: [], marketImages: {}, lastSuccessPollMs: 0 };
}

function atomicWriteJson(obj) {
  const dir = path.dirname(DATA_PATH);
  ensureDirSync(dir);
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
  fs.renameSync(tmp, DATA_PATH);
}

let state = loadState();
let tickRunning = false;

async function runOneRollupTick() {
  if (!PREDICT_API_KEY) {
    console.error("[prelook-rollup] missing PREDICT_API_KEY");
    return;
  }
  if (tickRunning) return;
  tickRunning = true;
  const nowMs = Date.now();
  const windowStart = nowMs - WINDOW_MS;
  try {
    const pollFrom = nowMs - POLL_WINDOW_MS;
    const fresh = await fetchMatchEventsSince(pollFrom, MAX_PAGES_PER_POLL);
    let merged = mergePrelookRecentRollup(state.trades, fresh, windowStart, nowMs);
    merged = filterPrelookMinNotional(merged);
    const saveCap = resolveRecentTradesSaveCap();
    let capped = capPrelookRollupTradesTimeFair(merged, saveCap, windowStart);
    const marketImages = await extendMarketImagesForTrades(capped, state.marketImages);
    state = {
      trades: capped,
      marketImages,
      lastSuccessPollMs: nowMs,
    };
    atomicWriteJson({
      trades: capped,
      marketImages,
      lastSuccessPollMs: nowMs,
      updatedAt: nowMs,
      hasFullBase: true,
    });
  } catch (e) {
    console.error("[prelook-rollup] tick error", e);
  } finally {
    tickRunning = false;
  }
}

async function runBootstrapIfRequested() {
  if (!BOOTSTRAP || !PREDICT_API_KEY) return;
  console.log("[prelook-rollup] bootstrap: fetching up to 24h window (many pages)…");
  const nowMs = Date.now();
  const windowStart = nowMs - WINDOW_MS;
  try {
    const events = await fetchMatchEventsSince(windowStart, MAX_PAGES_BOOTSTRAP);
    let merged = dedupePrelookMatchEvents(filterPrelookEventsToWindow(events, windowStart, nowMs));
    merged = filterPrelookMinNotional(merged);
    const saveCap = resolveRecentTradesSaveCap();
    let capped = capPrelookRollupTradesTimeFair(merged, saveCap, windowStart);
    const marketImages = await extendMarketImagesForTrades(capped, state.marketImages);
    state = { trades: capped, marketImages, lastSuccessPollMs: nowMs };
    atomicWriteJson({
      trades: capped,
      marketImages,
      lastSuccessPollMs: nowMs,
      updatedAt: nowMs,
      hasFullBase: true,
    });
    console.log("[prelook-rollup] bootstrap done, trades:", capped.length);
  } catch (e) {
    console.error("[prelook-rollup] bootstrap failed", e);
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, trades: state.trades.length, updatedAt: state.lastSuccessPollMs }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/prelook/recent-matches-rollup") {
    if (SERVE_KEY) {
      const got = (req.headers["x-prelook-rollup-key"] || "").toString().trim();
      if (got !== SERVE_KEY) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
    }
    const trades = filterPrelookMinNotional(state.trades);
    const nowMs = Date.now();
    const body = JSON.stringify({
      ok: true,
      trades,
      marketImages: state.marketImages && typeof state.marketImages === "object" ? state.marketImages : {},
      updatedAt: state.lastSuccessPollMs || nowMs,
      source: "vps_rollup_poll",
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}

if (!PREDICT_API_KEY) {
  console.error("[prelook-rollup] 请设置环境变量 PREDICT_API_KEY");
  process.exit(1);
}

ensureDirSync(path.dirname(DATA_PATH));

await runBootstrapIfRequested();
await runOneRollupTick();

setInterval(() => {
  void runOneRollupTick();
}, TICK_MS);

http.createServer(handleRequest).listen(PORT, () => {
  console.log(
    `[prelook-rollup] listening :${PORT} data=${DATA_PATH} tick=${TICK_MS}ms poll≈1h merge→24h`,
  );
});
