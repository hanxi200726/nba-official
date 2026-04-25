/**
 * Shams Charania 推文监控（Nitter RSS）→ 伤病关键词过滤 → Polymarket 赔率 → Discord
 *
 * Nitter 说明（请阅读，避免在 VPS 上踩坑）：
 * - 公共 Nitter 实例时好时坏；某个实例的「关于页」可能要求浏览器开 JavaScript（如 Anubis 反爬），
 *   与「RSS 直链 /feed」是否可用不是同一件事——以本脚本实际能否拉到 XML 为准，失败时换实例或
 *   设环境变量 SHAMS_RSS_URLS 指向你可用的 /username/rss 地址。
 * - 项目主页：https://github.com/zedeus/nitter — 自架实例需配 Redis、且当前从 Twitter
 *   拉取需按文档配置 session 等，运维成本高于本脚本；多数用户用公共实例 RSS 即可。
 * - 冷启动会标记当前 feed 中条目为已读且不推 Discord；另用「启动后 bootAt 时间 + 条目 pubDate」
 *   再挡一层，避免极个别旧帖换 guid 误报。
 *
 * 环境变量：
 *   DISCORD_WEBHOOK_URL   必填
 *   SHAMS_POLL_MS         默认 5000
 *   SHAMS_RSS_TIMEOUT_MS  默认 3000
 *   SHAMS_BOOT_SKEW_MS    与 bootAt 比较时的容忍时间（早于此的 pubDate 视为旧文），默认 120000
 *   SHAMS_RSS_URLS        逗号或分号分隔的 RSS 列表，覆盖默认的多个 Nitter 源
 *   SHAMS_STATE_PATH      默认 ./data/shams-injury-daemon-state.json
 *   PREDICT_PROXY / NBA_RISK_PROXY / HTTPS_PROXY  可选，与 nba-official-risk-daemon 一致
 */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const axios = require("axios");
const Parser = require("rss-parser");

dotenv.config();

const POLL_MS = Math.max(5000, Number(process.env.SHAMS_POLL_MS || 5000));
const RSS_TIMEOUT_MS = Math.max(1000, Number(process.env.SHAMS_RSS_TIMEOUT_MS || 3000));
const GAMMA_HTTP_MS = Math.max(5000, Number(process.env.SHAMS_GAMMA_HTTP_TIMEOUT_MS || 15_000));
const BOOT_SKEW_MS = Math.max(60_000, Number(process.env.SHAMS_BOOT_SKEW_MS || 120_000));

const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
const STATE_PATH = path.resolve(process.env.SHAMS_STATE_PATH || path.join(__dirname, "data", "shams-injury-daemon-state.json"));

const POLY_GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLY_CLOB_BASE = "https://clob.polymarket.com";

const PROXY_URL = String(
  process.env.NBA_RISK_PROXY || process.env.PREDICT_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "",
).trim();

if (PROXY_URL) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require("undici");
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log(`[shams-injury] outbound proxy: ${PROXY_URL}`);
  } catch (e) {
    console.warn("[shams-injury] proxy init failed:", e?.message || e);
  }
}

const RSS_URLS = (() => {
  const raw = String(process.env.SHAMS_RSS_URLS || "").trim();
  if (raw) {
    const list = raw.split(/[,;]/g).map((s) => s.trim()).filter(Boolean);
    if (list.length) return list;
  }
  return [
    "https://nitter.net/ShamsCharania/rss",
    "https://nitter.catsarch.com/ShamsCharania/rss",
    "https://nitter.tiekoetter.com/ShamsCharania/rss",
  ];
})();

const ABBR_ALIAS = { SA: "SAS", GS: "GSW", NO: "NOP" };
const ABBR_TO_SLUG = { GSW: "gs", NOP: "no", SAS: "sa", WAS: "wsh" };

const TEAM_FULL = {
  ATL: "Atlanta Hawks",
  BOS: "Boston Celtics",
  BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",
  CHI: "Chicago Bulls",
  CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",
  DEN: "Denver Nuggets",
  DET: "Detroit Pistons",
  GSW: "Golden State Warriors",
  HOU: "Houston Rockets",
  IND: "Indiana Pacers",
  LAC: "LA Clippers",
  LAL: "Los Angeles Lakers",
  MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",
  MIL: "Milwaukee Bucks",
  MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans",
  NYK: "New York Knicks",
  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",
  PHI: "Philadelphia 76ers",
  PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers",
  SAC: "Sacramento Kings",
  SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",
  UTA: "Utah Jazz",
  WAS: "Washington Wizards",
};

/** 顺序：更具体的别称在前（如 Clippers 在 “LA” 前） */
const TEAM_NICK_PATTERNS = [
  { abbr: "LAC", re: /\b(LA\s+)?Clippers\b/i },
  { abbr: "LAL", re: /\b(LA\s+)?Lakers\b/i },
  { abbr: "PHI", re: /\b(76ers|Sixers|Philadelphia)\b/i },
  { abbr: "POR", re: /\b(Trail\s+Blazers|Blazers)\b/i },
  { abbr: "GSW", re: /\b(Warriors|Golden\s+State)\b/i },
  { abbr: "NOP", re: /\b(Pelicans|New\s+Orleans)\b/i },
  { abbr: "NYK", re: /\bKnicks\b/i },
  { abbr: "BKN", re: /\b(Nets|Brooklyn)\b/i },
  { abbr: "OKC", re: /\b(Thunder|Oklahoma\s+City)\b/i },
  { abbr: "SAS", re: /\b(Spurs|San\s+Antonio)\b/i },
  { abbr: "MIN", re: /\b(Timberwolves|Minnesota)\b/i },
  { abbr: "DEN", re: /\b(Nuggets|Denver)\b/i },
  { abbr: "MIA", re: /\b(Heat|Miami)\b/i },
  { abbr: "MIL", re: /\b(Bucks|Milwaukee)\b/i },
  { abbr: "BOS", re: /\b(Celtics|Boston)\b/i },
  { abbr: "PHX", re: /\b(Suns|Phoenix)\b/i },
  { abbr: "DAL", re: /\b(Mavericks|Mavs|Dallas)\b/i },
  { abbr: "MEM", re: /\b(Grizzlies|Memphis)\b/i },
  { abbr: "CLE", re: /\b(Cavaliers|Cavs|Cleveland)\b/i },
  { abbr: "ATL", re: /\b(Hawks|Atlanta)\b/i },
  { abbr: "CHI", re: /\b(Bulls|Chicago)\b/i },
  { abbr: "DET", re: /\b(Pistons|Detroit)\b/i },
  { abbr: "HOU", re: /\b(Rockets|Houston)\b/i },
  { abbr: "IND", re: /\b(Pacers|Indiana)\b/i },
  { abbr: "ORL", re: /\b(Magic|Orlando)\b/i },
  { abbr: "TOR", re: /\b(Raptors|Toronto)\b/i },
  { abbr: "CHA", re: /\b(Hornets|Charlotte)\b/i },
  { abbr: "SAC", re: /\b(Kings|Sacramento)\b/i },
  { abbr: "UTA", re: /\b(Jazz|Utah)\b/i },
  { abbr: "WAS", re: /\b(Wizards|Washington)\b/i },
];

const rssParser = new Parser({ timeout: RSS_TIMEOUT_MS });

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalAbbr(raw) {
  const u = String(raw || "").trim().toUpperCase();
  return ABBR_ALIAS[u] || u;
}

function slugCodeToAbbr(code) {
  const c = String(code || "").trim().toLowerCase();
  for (const [abbr, slugCode] of Object.entries(ABBR_TO_SLUG)) {
    if (slugCode === c) return abbr;
  }
  return canonicalAbbr(c);
}

function hasInjuryKeyword(text) {
  const t = String(text);
  if (/WILL NOT PLAY/i.test(t)) return true;
  if (/\bWILL PLAY\b/i.test(t)) return true;
  if (/\bOUT\b/i.test(t)) return true;
  if (/\bDOUBTFUL\b/i.test(t)) return true;
  if (/\bQUESTIONABLE\b/i.test(t)) return true;
  if (/\bSCRATCH(ED)?\b/i.test(t)) return true;
  if (/INJURY|INJURIES/i.test(t)) return true;
  return false;
}

/** 在文本中按出现顺序取最多 2 个不同 abbr（每种别称取首次匹配位置） */
function findTeamAbbrsInOrder(text) {
  const hits = [];
  for (const { abbr, re } of TEAM_NICK_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.push({ idx: m.index, abbr: canonicalAbbr(abbr) });
  }
  hits.sort((a, b) => a.idx - b.idx);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.abbr)) continue;
    seen.add(h.abbr);
    out.push(h.abbr);
    if (out.length >= 2) break;
  }
  return out;
}

function extractPlayerName(text) {
  const t = String(text)
    .replace(/https?:\/\/[^\s]+/gi, " ")
    .replace(/@\w+/g, " ")
    .replace(/pic\.twitter\.com\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const re = /\b([A-Z][a-z]+(?:'[A-Z][a-z]+)?(?:\s+[A-Z][a-z]+){0,2}(?:\s+(?:Jr\.?|Sr\.?|II|III|IV))?)\b/g;
  const bad = /^(The|This|That|With|For|And|Out|Injury|Status|Source|BREAKING)\b/i;
  const matches = [...t.matchAll(re)];
  for (const m of matches) {
    const n = m[1].trim();
    if (n.length < 5) continue;
    if (bad.test(n)) continue;
    if (TEAM_NICK_PATTERNS.some((p) => p.re.test(n))) continue;
    return n;
  }
  return "—";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, init = {}, ms = GAMMA_HTTP_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json", ...headers } });
  if (!res.ok) throw new Error(`fetch_json ${res.status} ${url}`);
  return res.json();
}

function parseArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  return [];
}

function flattenLeafMarkets(markets) {
  const out = [];
  const walk = (m) => {
    if (!m) return;
    if (Array.isArray(m)) return m.forEach(walk);
    const ch = m.markets || m.children || m.items || m.leaves;
    if (Array.isArray(ch) && ch.length > 0) return ch.forEach(walk);
    out.push(m);
  };
  walk(markets);
  return out;
}

function teamAliases(teamAbbr) {
  const abbr = canonicalAbbr(teamAbbr);
  const full = TEAM_FULL[abbr] || "";
  const aliases = new Set([normalizeText(abbr), normalizeText(ABBR_TO_SLUG[abbr] || abbr), normalizeText(full)]);
  const words = normalizeText(full).split(" ").filter(Boolean);
  for (const w of words) aliases.add(w);
  if (words.length > 0) aliases.add(words[words.length - 1]);
  return [...aliases].filter(Boolean);
}

function outcomeMatchesTeam(outcomeName, teamAbbr) {
  const n = normalizeText(outcomeName);
  if (!n) return false;
  const aliases = teamAliases(teamAbbr);
  return aliases.some((a) => n === a || n.includes(a) || a.includes(n));
}

function normalizePriceUnit(p) {
  if (!Number.isFinite(p)) return NaN;
  return p > 1 && p <= 100 ? p / 100 : p;
}

function midFromBook(book) {
  const asks = Array.isArray(book?.asks) ? [...book.asks].sort((a, b) => Number(a.price) - Number(b.price)) : [];
  const bids = Array.isArray(book?.bids) ? [...book.bids].sort((a, b) => Number(b.price) - Number(a.price)) : [];
  const bestAsk = asks[0] ? normalizePriceUnit(Number(asks[0].price)) : NaN;
  const bestBid = bids[0] ? normalizePriceUnit(Number(bids[0].price)) : NaN;
  if (Number.isFinite(bestAsk) && Number.isFinite(bestBid)) return (bestAsk + bestBid) / 2;
  if (Number.isFinite(bestAsk)) return bestAsk;
  if (Number.isFinite(bestBid)) return bestBid;
  const lp = normalizePriceUnit(Number(book?.last_trade_price ?? book?.lastTradePrice));
  return Number.isFinite(lp) ? lp : NaN;
}

async function fetchOddsCentsForTeam(slug, teamAbbr) {
  const rows = await fetchJson(`${POLY_GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
  const ev = Array.isArray(rows) ? rows[0] : rows;
  if (!ev) return null;
  const leaves = flattenLeafMarkets(ev.markets || []);
  for (const m of leaves) {
    const outcomes = parseArray(m.outcomes || m.outcome_names || m.outcomeNames).map(String);
    const clobIds = parseArray(m.clobTokenIds || m.clob_token_ids).map(String);
    if (outcomes.length < 2 || clobIds.length < outcomes.length) continue;
    const title = normalizeText(m.groupItemTitle || m.group_title || m.title || "");
    if (/spread|handicap|total|over|under/.test(title)) continue;
    const idx = outcomes.findIndex((x) => outcomeMatchesTeam(x, teamAbbr));
    if (idx < 0 || !clobIds[idx]) continue;
    try {
      const book = await fetchJson(`${POLY_CLOB_BASE}/book?token_id=${encodeURIComponent(clobIds[idx])}`);
      const mid = midFromBook(book);
      if (Number.isFinite(mid)) return Math.round(mid * 100);
    } catch {
      // continue
    }
  }
  return null;
}

function parseSlugTeams(slug) {
  const m = String(slug || "").match(/^([a-z0-9]+)-(.+)-(\d{4}-\d{2}-\d{2})$/i);
  if (!m) return null;
  const league = m[1].toLowerCase();
  const parts = m[2].split("-").filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length === 2) return { league, a: parts[0].toLowerCase(), b: parts[1].toLowerCase() };
  const mid = Math.floor(parts.length / 2);
  return {
    league,
    a: parts.slice(0, mid).join("-").toLowerCase(),
    b: parts.slice(mid).join("-").toLowerCase(),
  };
}

async function fetchNbaEvents() {
  const sportsRaw = await fetchJson(`${POLY_GAMMA_BASE}/sports`);
  const sports = Array.isArray(sportsRaw) ? sportsRaw : Array.isArray(sportsRaw?.data) ? sportsRaw.data : [];
  const nbaSeries = sports
    .filter((x) => String(x?.sport || "").trim().toLowerCase() === "nba")
    .map((x) => String(x?.series || x?.series_id || "").trim())
    .filter(Boolean);
  if (nbaSeries.length === 0) return [];
  const batches = await Promise.all(
    nbaSeries.slice(0, 8).map(async (sid) => {
      try {
        const rows = await fetchJson(
          `${POLY_GAMMA_BASE}/events?series_id=${encodeURIComponent(sid)}&active=true&closed=false&limit=100&order=volume&ascending=false`,
        );
        return Array.isArray(rows) ? rows : Array.isArray(rows?.data) ? rows.data : [];
      } catch {
        return [];
      }
    }),
  );
  const out = [];
  const seen = new Set();
  for (const arr of batches) {
    for (const ev of arr) {
      const slug = String(ev?.slug || "").trim().toLowerCase();
      if (!slug.startsWith("nba-")) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const parsed = parseSlugTeams(slug);
      if (!parsed || parsed.league !== "nba") continue;
      const teamA = slugCodeToAbbr(parsed.a);
      const teamB = slugCodeToAbbr(parsed.b);
      if (!teamA || !teamB) continue;
      out.push({
        slug,
        title: String(ev?.title || slug),
        teamA,
        teamB,
      });
    }
  }
  return out;
}

function pickEventForTeams(events, abbrs) {
  if (abbrs.length === 0) return null;
  if (abbrs.length >= 2) {
    const A = canonicalAbbr(abbrs[0]);
    const B = canonicalAbbr(abbrs[1]);
    for (const ev of events) {
      const s = new Set([canonicalAbbr(ev.teamA), canonicalAbbr(ev.teamB)]);
      if (s.has(A) && s.has(B)) return ev;
    }
  }
  const T = canonicalAbbr(abbrs[0]);
  for (const ev of events) {
    if (canonicalAbbr(ev.teamA) === T || canonicalAbbr(ev.teamB) === T) return ev;
  }
  return null;
}

async function fetchRssXml() {
  for (const url of RSS_URLS) {
    try {
      const { data, status } = await axios.get(url, {
        timeout: RSS_TIMEOUT_MS,
        responseType: "text",
        validateStatus: (s) => s >= 200 && s < 300,
        headers: { Accept: "application/rss+xml, application/xml, text/xml, */*", "User-Agent": "shams-injury-daemon/1" },
        transitional: { forcedJSONParsing: false },
      });
      if (typeof data === "string" && data.length > 20) {
        return { xml: data, from: url };
      }
    } catch (e) {
      console.warn(`[shams-injury] rss fail ${url}:`, e?.message || e);
    }
  }
  return null;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const p = JSON.parse(raw);
    const seen = new Set(Array.isArray(p?.seen) ? p.seen : []);
    let coldDone = p?.coldDone === true;
    let bootAt = typeof p?.bootAt === "number" && Number.isFinite(p.bootAt) && p.bootAt > 0 ? p.bootAt : null;
    if (p && !("coldDone" in p) && seen.size > 0) {
      coldDone = true;
      if (bootAt == null) bootAt = Date.now();
    }
    return { seen, coldDone, bootAt };
  } catch {
    return { seen: new Set(), coldDone: false, bootAt: null };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify(
      {
        seen: [...state.seen].slice(-3000),
        coldDone: state.coldDone,
        bootAt: state.bootAt,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function itemId(item) {
  return String(item.guid || item.id || item.link || "").trim() || "";
}

/** rss-parser 通常提供 isoDate；否则用 pubDate */
function parseItemDateMs(item) {
  const s = item.isoDate || item.pubDate || item.date;
  if (!s) return null;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t) || t <= 0) return null;
  return t;
}

function itemText(item) {
  const title = String(item.title || "");
  const content = String(
    item.contentSnippet || item.content || item["content:encoded"] || item.description || item.summary || "",
  );
  return `${title}\n${content}`.replace(/\s+/g, " ").trim();
}

async function sendDiscord(text) {
  const res = await fetchWithTimeout(
    DISCORD_WEBHOOK_URL,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text }) },
    12_000,
  );
  if (!res.ok) throw new Error(`discord ${res.status}`);
}

async function processLoop() {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("missing DISCORD_WEBHOOK_URL");
  }
  const state = loadState();
  const events = await fetchNbaEvents();
  if (events.length === 0) {
    console.warn("[shams-injury] no nba events from gamma");
  }

  const fetched = await fetchRssXml();
  if (!fetched) {
    console.warn("[shams-injury] all rss failed");
    return;
  }
  const feed = await rssParser.parseString(fetched.xml);
  const items = (feed.items || []).slice(0, 30);

  if (!state.coldDone) {
    if (state.seen.size === 0) {
      for (const item of items) {
        const id = itemId(item);
        if (id) state.seen.add(id);
      }
      state.coldDone = true;
      state.bootAt = Date.now();
      saveState(state);
      console.log(
        `[shams-injury] cold start: marked ${items.length} items as seen, bootAt=${state.bootAt} (no alerts)`,
      );
      return;
    }
    state.coldDone = true;
    if (state.bootAt == null) state.bootAt = Date.now();
    saveState(state);
    console.log(`[shams-injury] state migration: coldDone + bootAt=${state.bootAt}`);
  }

  for (const item of items) {
    const id = itemId(item);
    if (!id) continue;
    if (state.seen.has(id)) continue;
    if (state.bootAt != null) {
      const t = parseItemDateMs(item);
      if (t != null && t < state.bootAt - BOOT_SKEW_MS) {
        state.seen.add(id);
        continue;
      }
    }
    const text = itemText(item);
    if (!text || !hasInjuryKeyword(text)) {
      state.seen.add(id);
      continue;
    }
    const abbrs = findTeamAbbrsInOrder(text);
    if (abbrs.length === 0) {
      state.seen.add(id);
      continue;
    }
    const player = extractPlayerName(text);
    const ev = pickEventForTeams(events, abbrs);
    if (!ev) {
      const teamLine = abbrs.map((a) => `${a}（${TEAM_FULL[a] || a}）`).join(" / ");
      const body = [
        "🚨 **NBA 伤病速报（Shams / Nitter）**",
        "",
        `**内容：**`,
        String(item.title || "").slice(0, 400),
        "",
        `**球队（推断）：** ${teamLine}`,
        `**球员（推断）：** ${player}`,
        `**未匹配到 Polymarket 场次**（可稍后手动查）`,
        String(item.link || "").trim() ? `**推文：** ${String(item.link).trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      try {
        await sendDiscord(body);
      } catch (e) {
        console.error("[shams-injury] discord failed:", e?.message);
      }
      state.seen.add(id);
      continue;
    }

    const focusTeam = canonicalAbbr(abbrs[0]);
    let oddsCents = null;
    try {
      oddsCents = await fetchOddsCentsForTeam(ev.slug, focusTeam);
    } catch (e) {
      console.warn("[shams-injury] odds err:", e?.message);
    }
    const url = `https://polymarket.com/sports/nba/${encodeURIComponent(ev.slug)}`;
    const oddsText = oddsCents == null ? "—" : `${oddsCents}¢（${focusTeam}）`;
    const body = [
      "🚨 **NBA 伤病速报**",
      "",
      `**内容：**`,
      text.slice(0, 500),
      "",
      `**球队：** ${abbrs.map((a) => `${a}（${TEAM_FULL[a] || a}）`).join(" vs ")}`,
      `**球员：** ${player}`,
      `**比赛：** ${ev.title}`,
      `**通知时赔率（${focusTeam}）：** ${oddsText}`,
      `**市场：** ${url}`,
      String(item.link || "").trim() ? `**推文：** ${String(item.link).trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await sendDiscord(body);
    } catch (e) {
      console.error("[shams-injury] discord failed:", e?.message);
    }
    state.seen.add(id);
  }

  saveState(state);
}

async function main() {
  console.log(`[shams-injury] started, poll=${POLL_MS}ms rssTimeout=${RSS_TIMEOUT_MS}ms`);
  for (;;) {
    const t0 = Date.now();
    try {
      await processLoop();
    } catch (e) {
      console.error("[shams-injury] loop error:", e?.message || e);
    }
    const d = Date.now() - t0;
    const wait = Math.max(0, POLL_MS - d);
    await sleep(wait);
  }
}

if (require.main === module) {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("missing DISCORD_WEBHOOK_URL");
    process.exit(1);
  }
  main();
}

module.exports = { hasInjuryKeyword, findTeamAbbrsInOrder, pickEventForTeams };
