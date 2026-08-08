// Phase 2 / module 4: "PEG改良式選股法" (Taiwan-adapted Peter Lynch PEG screen),
// run against the whole market.
//
// Rule (from course materials):
//   (1) trailing 3 individual months' revenue YoY growth each > 30%
//   (2) trailing-4-quarter P/E <= 15
//   (3) exclude loss-making companies
//   (4) exclude "-KY" (offshore-registered) stocks
//
// Cost-saving design: condition (2)/(3)/(4) can all be checked from data we
// already have in `market_daily_valuation` (PE ratio blank/high already
// implies loss or too-expensive; TWSE leaves PE blank for loss-makers, which
// we treat as a reasonable proxy for "excluded"). Only stocks that pass that
// first cheap filter get a FinMind revenue-history lookup, which keeps this
// well within FinMind's anonymous rate limit instead of hitting all ~1700+
// listed tickers.
//
// Requires SUPABASE_SERVICE_ROLE_KEY env var.
// Usage: node scripts/screener-peg.mjs

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PE_MAX = 15;
const REVENUE_YOY_MIN = 0.30;
const MONTHS_TO_CHECK = 3;

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

const sbHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchLatestMarketSnapshot() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/market_daily_valuation?select=stock_id,stock_name,pe_ratio,trade_date&trade_date=gte.${daysAgoISO(14)}&order=trade_date.desc`,
    { headers: sbHeaders }
  );
  if (!res.ok) throw new Error(`market_daily_valuation fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const latest = {};
  rows.forEach((r) => { if (!latest[r.stock_id]) latest[r.stock_id] = r; });
  return Object.values(latest);
}

// 第一層篩選：用現有的市場快照資料，零成本篩掉大部分股票
// PE存在且<=15（TWSE對虧損公司留空PE，這裡當作排除虧損的替代判斷）、排除KY股
function cheapFilter(rows) {
  return rows.filter((r) => {
    if (r.pe_ratio == null || r.pe_ratio <= 0 || r.pe_ratio > PE_MAX) return false;
    if ((r.stock_name || "").includes("-KY")) return false;
    return true;
  });
}

async function fetchMonthlyRevenue(ticker) {
  const start = new Date();
  start.setMonth(start.getMonth() - 20); // 抓20個月，確保近3個月都能找到去年同期比較基準
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockMonthRevenue&data_id=${ticker}&start_date=${start.toISOString().slice(0, 10)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FinMind revenue fetch failed for ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind error for ${ticker}: ${body.msg}`);
  return body.data || [];
}

// 檢查近N個「個別月份」的營收年增率是否都超過門檻（不是累計年增率）
function recentMonthlyYoY(revenueRows, monthsToCheck) {
  const byKey = {};
  revenueRows.forEach((r) => { byKey[`${r.revenue_year}-${r.revenue_month}`] = r.revenue; });
  const sorted = [...revenueRows].sort(
    (a, b) => b.revenue_year - a.revenue_year || b.revenue_month - a.revenue_month
  );

  const results = [];
  for (let i = 0; i < monthsToCheck && i < sorted.length; i++) {
    const cur = sorted[i];
    const prevRevenue = byKey[`${cur.revenue_year - 1}-${cur.revenue_month}`];
    if (prevRevenue == null || prevRevenue === 0) { results.push(null); continue; }
    results.push({
      year: cur.revenue_year,
      month: cur.revenue_month,
      yoy: (cur.revenue - prevRevenue) / prevRevenue,
    });
  }
  return results;
}

async function saveResults(candidates) {
  const runDate = new Date().toISOString().slice(0, 10);
  // 先清掉今天已經跑過的舊結果，避免同一天重跑造成重複
  const delRes = await fetch(
    `${SUPABASE_URL}/rest/v1/screener_results?strategy=eq.peg_improved&run_date=eq.${runDate}`,
    { method: "DELETE", headers: sbHeaders }
  );
  if (!delRes.ok) throw new Error(`Failed clearing old results: ${delRes.status} ${await delRes.text()}`);

  if (candidates.length === 0) return;

  const rows = candidates.map((c) => ({
    strategy: "peg_improved",
    run_date: runDate,
    stock_id: c.stock_id,
    stock_name: c.stock_name,
    detail: { pe_ratio: c.pe_ratio, monthly_yoy: c.monthlyYoy },
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/screener_results`, {
    method: "POST",
    headers: sbHeaders,
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Failed saving results: ${res.status} ${await res.text()}`);
}

const snapshot = await fetchLatestMarketSnapshot();
console.log(`Latest market snapshot: ${snapshot.length} tickers`);

const candidates1 = cheapFilter(snapshot);
console.log(`After PE<=${PE_MAX} + exclude KY filter: ${candidates1.length} tickers to check revenue for`);

const passed = [];
for (const stock of candidates1) {
  try {
    const revenueRows = await fetchMonthlyRevenue(stock.stock_id);
    const recent = recentMonthlyYoY(revenueRows, MONTHS_TO_CHECK);
    const ok = recent.length === MONTHS_TO_CHECK && recent.every((r) => r && r.yoy > REVENUE_YOY_MIN);
    if (ok) {
      passed.push({ ...stock, monthlyYoy: recent });
      console.log(`PASS ${stock.stock_id} ${stock.stock_name}: ${recent.map((r) => (r.yoy * 100).toFixed(1) + "%").join(", ")}`);
    }
  } catch (err) {
    console.error(`${stock.stock_id}: ${err.message}`);
  }
  await sleep(6500); // FinMind匿名額度600次/小時 = 平均6秒一次，這裡留餘裕抓6.5秒
}

console.log(`Final candidates: ${passed.length}`);
await saveResults(passed);
console.log("Done.");
