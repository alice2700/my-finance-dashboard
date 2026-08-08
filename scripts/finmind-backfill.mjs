// One-off/on-demand backfill: pulls ~5 years of daily PER/PBR history from
// FinMind for currently-held TW stocks and upserts into Supabase
// `market_daily_valuation`, so the valuation tool can auto-compute fixed-style
// min/max bands instead of requiring manual entry.
//
// Scope is deliberately just "your current holdings", not the whole market —
// FinMind's PER dataset is one HTTP call per stock, so this keeps it fast and
// well within the anonymous rate limit. The full-market backfill (for the
// Phase 2 screener) is a separate, heavier job for later.
//
// Requires SUPABASE_SERVICE_ROLE_KEY env var.
// Usage: node scripts/finmind-backfill.mjs

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

// service role bypasses RLS, so this sees every user's transactions —
// fine for now since it's a single-user app; will need a user_id filter
// if this ever becomes multi-user.
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

// need to know TWSE vs TPEx per ticker (market_daily_valuation.market is NOT NULL);
// the daily snapshot script already recorded this for anything with today's data.
async function fetchKnownMarkets(tickers) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/market_daily_valuation?select=stock_id,market&stock_id=in.(${tickers.join(",")})&order=trade_date.desc`,
    { headers: sbHeaders }
  );
  if (!res.ok) throw new Error(`market lookup failed: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  const marketByTicker = {};
  rows.forEach((r) => { if (!marketByTicker[r.stock_id]) marketByTicker[r.stock_id] = r.market; });
  return marketByTicker;
}

async function fetchFinMindPer(ticker, startDate, endDate) {
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPER&data_id=${ticker}&start_date=${startDate}&end_date=${endDate}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FinMind fetch failed for ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind error for ${ticker}: ${body.msg}`);
  return body.data || [];
}

async function upsertRows(rows) {
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/market_daily_valuation?on_conflict=trade_date,stock_id`,
      {
        method: "POST",
        headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify(chunk),
      }
    );
    if (!res.ok) {
      throw new Error(`Upsert failed for rows ${i}-${i + chunk.length}: ${res.status} ${await res.text()}`);
    }
  }
}

const tickers = await fetchHeldTwTickers();
if (tickers.length === 0) {
  console.log("No TW holdings found, nothing to backfill.");
  process.exit(0);
}
console.log(`Backfilling ${tickers.length} TW tickers: ${tickers.join(", ")}`);

const marketByTicker = await fetchKnownMarkets(tickers);

const today = new Date();
const startDate = new Date(today);
startDate.setFullYear(startDate.getFullYear() - 5);
const fmt = (d) => d.toISOString().slice(0, 10);

for (const ticker of tickers) {
  const market = marketByTicker[ticker];
  if (!market) {
    console.warn(`Skipping ${ticker}: no known market (likely an ETF without PE/PB data, or daily snapshot hasn't run yet)`);
    continue;
  }

  try {
    const data = await fetchFinMindPer(ticker, fmt(startDate), fmt(today));
    if (data.length === 0) {
      console.warn(`No FinMind PER history for ${ticker}`);
      continue;
    }
    const rows = data.map((r) => ({
      trade_date: r.date,
      stock_id: r.stock_id,
      market,
      pe_ratio: r.PER ?? null,
      dividend_yield: r.dividend_yield ?? null,
      pb_ratio: r.PBR ?? null,
    }));
    await upsertRows(rows);
    console.log(`${ticker}: upserted ${rows.length} historical rows`);
  } catch (err) {
    console.error(`${ticker}: ${err.message}`);
  }

  await sleep(400); // be polite to the anonymous rate limit
}

console.log("Done.");
