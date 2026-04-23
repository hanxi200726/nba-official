/**
 * NBA Official 风控守护进程（Node）
 * - 0.5s 轮询官方 injury report 索引
 * - 发现“上一份报告无 Out / 当前报告新增 Out”立即告警
 * - 告警时附带对应球队当前赔率（Polymarket 盘口中间价）
 * - 可选：把告警写入 Worker KV（供网页风险页实时展示）
 */
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const NBA_INDEX_URL = "https://official.nba.com/nba-injury-report-2025-26-season/";
const NBA_PDF_BASE = "https://ak-static.cms.nba.com";
const POLY_GAMMA_BASE = "https://gamma-api.polymarket.com";
const POLY_CLOB_BASE = "https://clob.polymarket.com";

const POLL_MS = Math.max(500, Number(process.env.NBA_OFFICIAL_POLL_MS || 500));
const EVENTS_REFRESH_MS = Math.max(30_000, Number(process.env.NBA_EVENTS_REFRESH_MS || 60_000));
const HTTP_TIMEOUT_MS = Math.max(5_000, Number(process.env.NBA_RISK_HTTP_TIMEOUT_MS || 15_000));

const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
const RISK_FEED_PUSH_URL = String(process.env.RISK_FEED_PUSH_URL || "").trim();
const RISK_FEED_WRITE_KEY = String(process.env.NBA_RISK_FEED_WRITE_KEY || "").trim();
const STATE_PATH = path.resolve(
  process.env.NBA_RISK_STATE_PATH || path.join(__dirname, "data", "nba-official-risk-daemon-state.json"),
);

const PROXY_URL = String(
  process.env.NBA_RISK_PROXY ||
    process.env.PREDICT_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    "",
).trim();

if (PROXY_URL) {
  try {
    const { setGlobalDispatcher, ProxyAgent } = require("undici");
    setGlobalDispatcher(new ProxyAgent(PROXY_URL));
    console.log(`[nba-risk-daemon] outbound proxy enabled: ${PROXY_URL}`);
  } catch (e) {
    console.warn("[nba-risk-daemon] outbound proxy init failed, fallback direct:", e?.message || e);
  }
}

const STATUS_WORDS = "Out|Questionable|Probable|Doubtful|Available|Rest|Not With Team|Personal Reasons";
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

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort("timeout"), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, headers = {}) {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", ...headers },
  });
  if (!res.ok) throw new Error(`fetch_json_failed status=${res.status} url=${url}`);
  return res.json();
}

async function fetchText(url, headers = {}) {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "text/html,application/xhtml+xml,*/*", ...headers },
  });
  if (!res.ok) throw new Error(`fetch_text_failed status=${res.status} url=${url}`);
  return res.text();
}

function fileSortKey(name) {
  const m = String(name || "").match(
    /Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{1,2})_(\d{2})(AM|PM)\.pdf/i,
  );
  if (!m) return -1;
  let h = Number(m[4]);
  const min = Number(m[5]);
  const ap = m[6].toUpperCase();
  if (ap === "AM" && h === 12) h = 0;
  if (ap === "PM" && h !== 12) h += 12;
  return Number(m[1]) * 1e11 + Number(m[2]) * 1e9 + Number(m[3]) * 1e7 + h * 1e4 + min;
}

function reportSecFromPdfPath(pdfPath) {
  const m = String(pdfPath || "").match(
    /Injury-Report_(\d{4})-(\d{2})-(\d{2})_(\d{1,2})_(\d{2})(AM|PM)\.pdf/i,
  );
  if (!m) return 0;
  let h = Number(m[4]);
  const min = Number(m[5]);
  const ap = m[6].toUpperCase();
  if (ap === "AM" && h === 12) h = 0;
  if (ap === "PM" && h !== 12) h += 12;
  // 轻量换算：ET ~ UTC-4（当前赛季窗口足够）
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h + 4, min, 0) / 1000);
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

function normalizePdfRawText(s) {
  return String(s || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0|\u2007|\u202F/g, " ")
    .replace(/\uFF20/g, "@");
}

function collapseAtSpacing(s) {
  const t = normalizePdfRawText(s);
  return t.replace(/\b([A-Z]{2,3})\s*@\s*([A-Z]{2,3})\b/g, "$1@$2");
}

function extractMatchupSection(full, teamA, teamB) {
  const p1 = `${canonicalAbbr(teamA)}@${canonicalAbbr(teamB)}`;
  const p2 = `${canonicalAbbr(teamB)}@${canonicalAbbr(teamA)}`;
  let idx = full.indexOf(p1);
  if (idx < 0) idx = full.indexOf(p2);
  if (idx < 0) return null;
  const head = full.slice(idx, idx + 12).match(/^([A-Z]{2,3})@([A-Z]{2,3})/);
  if (!head) return null;
  const away = head[1];
  const home = head[2];
  const rest = full.slice(idx);
  const re = /\b([A-Z]{2,3})@([A-Z]{2,3})\b/g;
  let m;
  let n = 0;
  let cut = rest.length;
  while ((m = re.exec(rest)) !== null) {
    n += 1;
    if (n === 2) {
      cut = m.index;
      break;
    }
  }
  if (n < 2) {
    const endRe = /\d{1,2}:\d{2}\s+\(ET\)\s+[A-Z]{2,3}@[A-Z]{2,3}/;
    const em = endRe.exec(rest);
    if (em && em.index > 0) cut = Math.min(cut, em.index);
  }
  return { away, home, section: rest.slice(0, cut).replace(/\s+/g, " ").trim() };
}

function splitTeamBlocks(section, away, home) {
  const awayFull = TEAM_FULL[canonicalAbbr(away)];
  const homeFull = TEAM_FULL[canonicalAbbr(home)];
  if (!awayFull || !homeFull) return null;
  let s = String(section || "").replace(/\s+/g, " ").trim();
  const token = s.match(/[A-Z]{2,3}@[A-Z]{2,3}/);
  if (!token || token.index == null) return null;
  s = s.slice(token.index + token[0].length).trim();
  const ia = s.indexOf(awayFull);
  if (ia < 0) return null;
  const afterAway = s.slice(ia + awayFull.length).trim();
  const ih = afterAway.indexOf(homeFull);
  if (ih < 0) return null;
  return {
    awayText: afterAway.slice(0, ih).trim(),
    homeText: afterAway.slice(ih + homeFull.length).trim(),
  };
}

/**
 * 上一条「原因」尾部词会黏到下一条「姓, 名」前；不清洗会在相邻 PDF 间姓名抖动，diff 误报新 Out。
 */
function stripGluedReasonTailFromPlayerName(raw) {
  let name = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  const phrase =
    /^(?:Injury\/Illness|Injury\s*\/\s*Illness|G\s+League|League\s*-\s*Two\s*-\s*Way|League\s*-\s*Two-\s*Way|Two-\s*Way|Not\s+With\s+Team)\s+/i;
  const word =
    /^(?:Soreness|Surgery|Rest|Contusion|Contusions|Sprain|Strain|Tightness|Tightening|Management|Recovery|Repair|Post|Bursitis|Fracture|Tear|Tendon|Tendinitis|Tendonopathy|Impingement|Spasm|Spasms|Illness|Questionable|Probable|Doubtful|Available|Internal|External|Bilateral|Maintenance|Mask|Splint)\s+/i;
  for (let i = 0; i < 14; i += 1) {
    const before = name;
    name = name.replace(phrase, "").trim();
    name = name.replace(word, "").trim();
    name = name.replace(/^Two-\s+/i, "").trim();
    name = name.replace(/^Way\s+/i, "").trim();
    if (name === before) break;
  }
  return name;
}

function isPlausibleOfficialPlayerName(name) {
  const n = String(name || "")
    .replace(/\s+/g, " ")
    .trim();
  if (n.length < 4 || !/,/.test(n)) return false;
  const lower = n.toLowerCase();
  if (/page|injury\s*report|of\s+\d+/.test(lower)) return false;
  if (/\d{1,2}:\d{2}/.test(n)) return false;
  return true;
}

function isPlausibleOfficialReason(reason) {
  const r = String(reason || "")
    .replace(/\s+/g, " ")
    .trim();
  if (/page\s+\d+\s+of\s+\d+/i.test(r)) return false;
  if (/injury\s*report\s*:/i.test(r)) return false;
  return r.length > 0;
}

function canonicalPlayerKey(playerName) {
  const cleaned = stripGluedReasonTailFromPlayerName(playerName);
  const m = cleaned.match(/^([^,]+),\s*(.+)$/i);
  if (m) {
    const last = m[1].trim();
    const first = m[2].trim();
    return normalizeText(`${last}|${first}`);
  }
  return normalizeText(cleaned);
}

function parsePlayers(blob) {
  const text = String(blob || "").replace(/\s+/g, " ").trim();
  const re = new RegExp(
    `([A-Za-z][A-Za-z0-9'\\.\\-\\s]*,\\s+[A-Za-z][A-Za-z0-9'\\.\\-\\s]*)\\s+(${STATUS_WORDS})\\s+(.+?)(?=\\s+[A-Za-z][A-Za-z0-9'\\.\\-\\s]*,\\s+[A-Za-z]|$)`,
    "g",
  );
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const playerName = stripGluedReasonTailFromPlayerName(String(m[1] || "").replace(/\s+/g, " ").trim());
    const status = String(m[2] || "").replace(/\s+/g, " ").trim();
    const reason = String(m[3] || "").replace(/\s+/g, " ").trim();
    if (!isPlausibleOfficialPlayerName(playerName) || !isPlausibleOfficialReason(reason)) continue;
    out.push({ playerName, status, reason });
  }
  return out;
}

function parseBundleFromPdfText(pdfText, pdfPath, teamA, teamB) {
  const block = extractMatchupSection(pdfText, teamA, teamB);
  if (!block) return null;
  const pair = splitTeamBlocks(block.section, block.away, block.home);
  if (!pair) return null;
  const aIsAway = canonicalAbbr(teamA) === canonicalAbbr(block.away);
  return {
    reportTimeSec: reportSecFromPdfPath(pdfPath),
    teamAInjuries: aIsAway ? parsePlayers(pair.awayText) : parsePlayers(pair.homeText),
    teamBInjuries: aIsAway ? parsePlayers(pair.homeText) : parsePlayers(pair.awayText),
  };
}

function diffNewOut(prev, next, teamA, teamB) {
  if (!prev || !next) return [];
  if (next.reportTimeSec <= prev.reportTimeSec) return [];
  const checks = [
    { abbr: canonicalAbbr(teamA), prevRows: prev.teamAInjuries, nextRows: next.teamAInjuries },
    { abbr: canonicalAbbr(teamB), prevRows: prev.teamBInjuries, nextRows: next.teamBInjuries },
  ];
  const out = [];
  for (const c of checks) {
    const prevMap = new Map();
    for (const r of c.prevRows || []) {
      const pk = canonicalPlayerKey(r.playerName);
      if (!pk) continue;
      prevMap.set(pk, normalizeText(r.status));
    }
    for (const r of c.nextRows || []) {
      if (normalizeText(r.status) !== "out") continue;
      const k = canonicalPlayerKey(r.playerName);
      if (!k) continue;
      if (prevMap.get(k) === "out") continue;
      out.push({
        reportTimeSec: next.reportTimeSec,
        teamAbbr: c.abbr,
        playerName: r.playerName,
        reason: r.reason || "—",
      });
    }
  }
  return out;
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
    const children = m.markets || m.children || m.items || m.leaves;
    if (Array.isArray(children) && children.length > 0) return children.forEach(walk);
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
      // try next
    }
  }
  return null;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastPdfPath: String(parsed?.lastPdfPath || ""),
      alerted: new Set(Array.isArray(parsed?.alerted) ? parsed.alerted : []),
    };
  } catch {
    return { lastPdfPath: "", alerted: new Set() };
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ lastPdfPath: state.lastPdfPath, alerted: [...state.alerted].slice(-5000) }, null, 2),
    "utf8",
  );
}

/**
 * 去重键不含 market slug：同一份报告下多日期市场会各解析到同一伤退，避免重复推 DC/风控。
 * 与 diff 的 canonicalPlayerKey 一致。
 */
function markerId(_slug, marker) {
  return [
    String(marker.reportTimeSec || 0),
    canonicalAbbr(marker.teamAbbr),
    canonicalPlayerKey(marker.playerName),
  ].join("|");
}

function fmtBj(tsSec) {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return "—";
  return new Date(tsSec * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

async function sendDiscord(content) {
  const res = await fetchWithTimeout(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`discord_post_failed status=${res.status}`);
}

async function pushRiskFeedItemRemote(item) {
  if (!RISK_FEED_PUSH_URL) return;
  const headers = { "Content-Type": "application/json" };
  if (RISK_FEED_WRITE_KEY) headers["x-prelook-risk-key"] = RISK_FEED_WRITE_KEY;
  const res = await fetchWithTimeout(RISK_FEED_PUSH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ item }),
  });
  if (!res.ok) throw new Error(`risk_feed_push_failed status=${res.status}`);
}

let pdfjsPromise = null;
async function extractPdfText(pdfBytes) {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBytes), disableWorker: true });
  const doc = await task.promise;
  let full = "";
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    for (const it of tc.items || []) {
      if (it && typeof it.str === "string") full += `${it.str} `;
    }
    full += "\n";
  }
  await doc.destroy();
  return collapseAtSpacing(full);
}

async function fetchLatestPdfPath() {
  const html = await fetchText(NBA_INDEX_URL, {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });
  const paths = [];
  const re = /\/referee\/injury\/(Injury-Report_\d{4}-\d{2}-\d{2}_\d{1,2}_\d{2}(?:AM|PM)\.pdf)/gi;
  let m;
  while ((m = re.exec(html)) !== null) paths.push(`/referee/injury/${m[1]}`);
  if (paths.length === 0) return null;
  const uniq = [...new Set(paths)];
  uniq.sort((a, b) => fileSortKey(a.split("/").pop()) - fileSortKey(b.split("/").pop()));
  return uniq[uniq.length - 1];
}

async function fetchWatchedEvents() {
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

function buildRiskFeedItem({ marker, ev, opponentAbbr, oddsCents }) {
  const reason = (marker.reason || "").replace(/\s+/g, " ").trim();
  const statusText = reason && reason !== "—" ? `Out · ${reason}` : "Out";
  return {
    id: markerId(ev.slug, marker),
    createdAtMs: Date.now(),
    reportTimeSec: marker.reportTimeSec,
    playerName: marker.playerName,
    statusText,
    teamAbbr: canonicalAbbr(marker.teamAbbr),
    opponentAbbr: canonicalAbbr(opponentAbbr),
    slug: ev.slug,
    eventTitle: ev.title,
    polySportsUrl: `https://polymarket.com/sports/nba/${encodeURIComponent(ev.slug)}`,
    oddsCents: Number.isFinite(oddsCents) ? oddsCents : null,
  };
}

function formatDiscordBody(item) {
  const odds = item.oddsCents == null ? "—" : `${item.oddsCents}¢`;
  return [
    "🚨 NBA Official 风控提醒（新 Out）",
    `比赛：${item.eventTitle || item.slug}`,
    `球员：${item.playerName}`,
    `状态：${item.statusText}`,
    `队伍：${item.teamAbbr} vs ${item.opponentAbbr}`,
    `报告时间：${fmtBj(item.reportTimeSec)}（北京）`,
    `通知时赔率（该队）：${odds}`,
    `链接：${item.polySportsUrl}`,
  ].join("\n");
}

async function main() {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("missing DISCORD_WEBHOOK_URL");
  }
  console.log(`[nba-risk-daemon] started, poll=${POLL_MS}ms`);
  const state = loadState();
  const prevBySlug = new Map();
  let watched = [];
  let lastEventsAt = 0;
  let lastPdfPath = state.lastPdfPath || "";

  for (;;) {
    const started = Date.now();
    try {
      if (Date.now() - lastEventsAt >= EVENTS_REFRESH_MS || watched.length === 0) {
        watched = await fetchWatchedEvents();
        lastEventsAt = Date.now();
        console.log(`[nba-risk-daemon] watching ${watched.length} nba events`);
      }
      if (watched.length === 0) {
        await sleep(1200);
        continue;
      }

      const latestPdfPath = await fetchLatestPdfPath();
      if (!latestPdfPath) {
        await sleep(Math.max(100, POLL_MS));
        continue;
      }
      if (latestPdfPath === lastPdfPath) {
        await sleep(Math.max(50, POLL_MS - (Date.now() - started)));
        continue;
      }

      console.log(`[nba-risk-daemon] new report: ${latestPdfPath}`);
      const pdfRes = await fetchWithTimeout(`${NBA_PDF_BASE}${latestPdfPath}`, {
        headers: { Accept: "application/pdf,*/*" },
      });
      if (!pdfRes.ok) throw new Error(`pdf_fetch_failed status=${pdfRes.status}`);
      const pdfText = await extractPdfText(await pdfRes.arrayBuffer());

      for (const ev of watched) {
        const next = parseBundleFromPdfText(pdfText, latestPdfPath, ev.teamA, ev.teamB);
        if (!next) continue;
        const prev = prevBySlug.get(ev.slug) || null;
        const newOuts = diffNewOut(prev, next, ev.teamA, ev.teamB);
        for (const marker of newOuts) {
          const id = markerId(ev.slug, marker);
          if (state.alerted.has(id)) continue;
          state.alerted.add(id);
          const opponentAbbr =
            canonicalAbbr(marker.teamAbbr) === canonicalAbbr(ev.teamA)
              ? canonicalAbbr(ev.teamB)
              : canonicalAbbr(ev.teamA);
          let oddsCents = null;
          try {
            oddsCents = await fetchOddsCentsForTeam(ev.slug, marker.teamAbbr);
          } catch {
            // keep null
          }
          const item = buildRiskFeedItem({ marker, ev, opponentAbbr, oddsCents });
          try {
            await sendDiscord(formatDiscordBody(item));
          } catch (e) {
            console.error("[nba-risk-daemon] discord send failed:", e?.message || e);
          }
          try {
            await pushRiskFeedItemRemote(item);
          } catch (e) {
            console.error("[nba-risk-daemon] remote feed push failed:", e?.message || e);
          }
          console.log(
            `[nba-risk-daemon] alert: ${item.slug} ${item.playerName} ${item.statusText} odds=${item.oddsCents ?? "-"}`,
          );
        }
        prevBySlug.set(ev.slug, next);
      }

      lastPdfPath = latestPdfPath;
      state.lastPdfPath = latestPdfPath;
      saveState(state);
    } catch (e) {
      console.error("[nba-risk-daemon] loop error:", e?.message || e);
    }
    await sleep(Math.max(50, POLL_MS - (Date.now() - started)));
  }
}

main().catch((e) => {
  console.error("[nba-risk-daemon] fatal:", e?.message || e);
  process.exit(1);
});

