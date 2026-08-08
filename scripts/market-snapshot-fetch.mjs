// Fetches TWSE + TPEx daily PER/PBR/dividend-yield snapshot for all listed
// stocks and upserts into Supabase `market_daily_valuation`.
// Requires SUPABASE_SERVICE_ROLE_KEY env var (bypasses RLS, write access).
// Usage: node scripts/market-snapshot-fetch.mjs

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

// "1150805" (民國115年08月05日) -> "2026-08-05"
function rocDateToISO(rocDate) {
  const year = Number(rocDate.slice(0, -4)) + 1911;
  const month = rocDate.slice(-4, -2);
  const day = rocDate.slice(-2);
  return `${year}-${month}-${day}`;
}

function toNumberOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchTwse() {
  const res = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL");
  if (!res.ok) throw new Error(`TWSE fetch failed: ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    trade_date: rocDateToISO(r.Date),
    stock_id: r.Code,
    stock_name: r.Name,
    market: "TWSE",
    pe_ratio: toNumberOrNull(r.PEratio),
    dividend_yield: toNumberOrNull(r.DividendYield),
    pb_ratio: toNumberOrNull(r.PBratio),
  }));
}

async function fetchTpex() {
  const res = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis");
  if (!res.ok) throw new Error(`TPEx fetch failed: ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    trade_date: rocDateToISO(r.Date),
    stock_id: r.SecuritiesCompanyCode,
    stock_name: r.CompanyName,
    market: "TPEx",
    pe_ratio: toNumberOrNull(r.PriceEarningRatio),
    dividend_yield: toNumberOrNull(r.YieldRatio),
    pb_ratio: toNumberOrNull(r.PriceBookRatio),
  }));
}

const [twse, tpex] = await Promise.all([fetchTwse(), fetchTpex()]);
const rows = [...twse, ...tpex];
console.log(`Fetched ${twse.length} TWSE + ${tpex.length} TPEx rows`);

if (rows.length === 0) {
  console.error("No rows fetched from either source, aborting upsert");
  process.exit(1);
}

// PostgREST can choke on very large single payloads, so upsert in chunks.
const CHUNK_SIZE = 500;
for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
  const chunk = rows.slice(i, i + CHUNK_SIZE);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/market_daily_valuation?on_conflict=trade_date,stock_id`,
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(chunk),
    }
  );
  if (!res.ok) {
    console.error(`Upsert failed for rows ${i}-${i + chunk.length}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Upserted rows ${i}-${i + chunk.length}`);
}

console.log("Done.");
