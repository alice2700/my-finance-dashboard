// Pulls industry classification + annual EPS growth (5yr CAGR) from FinMind
// for currently-held TW stocks, to auto-suggest answers in the stock-valuation-tool
// classification wizard (Q1: cyclical industry? / Q4: earnings growth rate?).
//
// Scope is "your current holdings" only, same reasoning as finmind-backfill.mjs
// (keeps this well within FinMind's anonymous rate limit).
//
// Requires SUPABASE_SERVICE_ROLE_KEY env var.
// Usage: node scripts/finmind-fundamentals.mjs

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

const sbHeaders = {
  apikey: SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

function isTwTicker(ticker) {
  return /^\d/.test(ticker || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHeldTwTickers() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/stock_transactions?select=ticker,side,shares&limit=5000`,
    { headers: sbHeaders }
  );
  if (!res.ok) throw new Error(`stock_transactions fetch failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();

  const shares = {};
  rows.forEach((t) => {
    if (!isTwTicker(t.ticker)) return;
    if (t.side !== "buy" && t.side !== "sell") return;
    const delta = t.side === "buy" ? Number(t.shares || 0) : -Number(t.shares || 0);
    shares[t.ticker] = (shares[t.ticker] || 0) + delta;
  });
  return Object.keys(shares).filter((ticker) => shares[ticker] > 0).sort();
}

async function fetchIndustryCategory(ticker) {
  const res = await fetch(`https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockInfo&data_id=${ticker}`);
  if (!res.ok) throw new Error(`TaiwanStockInfo fetch failed for ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind error for ${ticker}: ${body.msg}`);
  const categories = [...new Set((body.data || []).map((r) => r.industry_category).filter(Boolean))];
  return categories.join("、") || null;
}

async function fetchAnnualEpsSeries(ticker) {
  const start = new Date();
  start.setFullYear(start.getFullYear() - 7);
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockFinancialStatements&data_id=${ticker}&start_date=${start.toISOString().slice(0, 10)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TaiwanStockFinancialStatements fetch failed for ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind error for ${ticker}: ${body.msg}`);

  const epsRows = (body.data || []).filter((r) => r.type === "EPS");
  const yearData = {};
  epsRows.forEach((r) => {
    const year = Number(r.date.slice(0, 4));
    const quarter = r.date.slice(5); // "MM-DD", used just to count distinct quarters seen
    if (!yearData[year]) yearData[year] = { quarters: new Set(), sum: 0 };
    yearData[year].quarters.add(quarter);
    yearData[year].sum += Number(r.value) || 0;
  });

  // 只用「四季都有資料」的完整年度，避免今年還沒公布完的季度把EPS算少
  return Object.keys(yearData)
    .map(Number)
    .filter((y) => yearData[y].quarters.size === 4)
    .sort((a, b) => b - a)
    .map((y) => ({ year: y, eps: yearData[y].sum }));
}

// 近5年（或現有資料涵蓋的年數，最多5年）複合成長率
function computeCagr(annualEpsDesc) {
  if (annualEpsDesc.length < 2) return null;
  const latest = annualEpsDesc[0];
  const yearsBack = Math.min(5, annualEpsDesc.length - 1);
  const past = annualEpsDesc[yearsBack];
  const n = latest.year - past.year;
  if (n <= 0 || past.eps <= 0 || latest.eps <= 0) return null; // 虧損或基期為負時，複合成長率沒有意義
  return { rate: Math.pow(latest.eps / past.eps, 1 / n) - 1, years: n };
}

async function upsertFundamentals(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_fundamentals?on_conflict=stock_id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`Upsert failed for ${row.stock_id}: ${res.status} ${await res.text()}`);
}

const tickers = await fetchHeldTwTickers();
if (tickers.length === 0) {
  console.log("No TW holdings found, nothing to do.");
  process.exit(0);
}
console.log(`Fetching fundamentals for ${tickers.length} tickers: ${tickers.join(", ")}`);

for (const ticker of tickers) {
  try {
    const [industryCategory, annualEps] = await Promise.all([
      fetchIndustryCategory(ticker),
      fetchAnnualEpsSeries(ticker),
    ]);
    const cagr = computeCagr(annualEps);

    await upsertFundamentals({
      stock_id: ticker,
      industry_category: industryCategory,
      eps_growth_5y: cagr ? cagr.rate : null,
      eps_growth_years: cagr ? cagr.years : null,
      updated_at: new Date().toISOString(),
    });
    console.log(`${ticker}: 產業=${industryCategory ?? "—"} 成長率=${cagr ? (cagr.rate * 100).toFixed(1) + "% (" + cagr.years + "年)" : "—"}`);
  } catch (err) {
    console.error(`${ticker}: ${err.message}`);
  }
  await sleep(1500); // 兩個資料集各一次呼叫，抓寬鬆一點的間隔
}

console.log("Done.");
