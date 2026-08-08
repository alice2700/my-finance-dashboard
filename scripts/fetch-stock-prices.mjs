// Fetches yesterday's closing price for tickers the Apps Script price source
// can't cover (TW bond ETFs, 興櫃, US stocks) and upserts into Supabase.
// Requires SUPABASE_SERVICE_ROLE_KEY env var (bypasses RLS).

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 目前 Apps Script/GOOGLEFINANCE 抓不到報價的標的，之後有新增可以直接加在這裡
const TW_TICKERS = ["00720B", "00937B", "6578"]; // 台股債券 ETF、興櫃
const US_TICKERS = ["VTI", "SPCX"];

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

function rocDateToIso(rocDate) {
  // "1150807" -> 民國115年08月07日 -> "2026-08-07"
  const year = parseInt(rocDate.slice(0, 3), 10) + 1911;
  const month = rocDate.slice(3, 5);
  const day = rocDate.slice(5, 7);
  return `${year}-${month}-${day}`;
}

async function fetchTwseList() {
  const res = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");
  if (!res.ok) throw new Error(`TWSE fetch failed: ${res.status}`);
  return res.json();
}

async function fetchTpexList() {
  const res = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes");
  if (!res.ok) throw new Error(`TPEx fetch failed: ${res.status}`);
  return res.json();
}

function extractTwPrices(tpexRows) {
  const byCode = {};
  tpexRows.forEach((r) => { byCode[r.SecuritiesCompanyCode] = r; });

  const results = [];
  for (const ticker of TW_TICKERS) {
    const row = byCode[ticker];
    if (!row || !row.Close || row.Close.trim() === "---") {
      console.error(`No TPEx data for ${ticker}`);
      continue;
    }
    results.push({ ticker, price: parseFloat(row.Close), price_date: rocDateToIso(row.Date) });
  }
  return results;
}

// 台股對帳單只有中文股名沒有代碼，瀏覽器直接呼叫證交所/櫃買中心會被 CORS 擋掉，
// 所以在這裡先把「股名 -> 代碼」對照表整份存進 Supabase，前端改查 Supabase
function extractTickerNames(twseRows, tpexRows) {
  const map = {};
  twseRows.forEach((r) => { if (r.Name && r.Code) map[r.Name] = r.Code; });
  tpexRows.forEach((r) => { if (r.CompanyName && r.SecuritiesCompanyCode) map[r.CompanyName] = r.SecuritiesCompanyCode; });
  return Object.entries(map).map(([name, ticker]) => ({ name, ticker }));
}

async function fetchUsdTwdRate() {
  const res = await fetch("https://open.er-api.com/v6/latest/USD");
  if (!res.ok) throw new Error(`Rate fetch failed: ${res.status}`);
  const data = await res.json();
  const rate = data.rates && data.rates.TWD;
  if (!rate) throw new Error("No TWD rate in response");
  return rate;
}

// stock_prices.price 全部存台幣等值，跟 app.js 其他地方（成本、帳戶餘額）的單位一致，
// 所以美股價格要先用當天匯率換算，不要直接存美金原始價格
async function fetchUsPrices() {
  const rate = await fetchUsdTwdRate();
  const results = [];
  for (const ticker of US_TICKERS) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) {
      console.error(`Yahoo Finance fetch failed for ${ticker}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    const meta = data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    if (!meta || meta.regularMarketPrice == null) {
      console.error(`No Yahoo Finance price for ${ticker}`);
      continue;
    }
    const priceDate = new Date(meta.regularMarketTime * 1000).toISOString().slice(0, 10);
    results.push({ ticker, price: meta.regularMarketPrice * rate, price_date: priceDate });
  }
  return results;
}

async function upsert(table, rows) {
  if (!rows.length) return;
  // 大批資料分批寫入，避免單次 request body 太大
  const CHUNK = 2000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error(`Upsert to ${table} failed: ${res.status} ${await res.text()}`);
    }
  }
}

const [twseList, tpexList] = await Promise.all([fetchTwseList(), fetchTpexList()]);

const twPrices = extractTwPrices(tpexList);
const usPrices = await fetchUsPrices();
const allPrices = twPrices.concat(usPrices);
console.log("Fetched prices:", allPrices);
await upsert("stock_prices", allPrices);
console.log(`Upserted ${allPrices.length} prices`);

const tickerNames = extractTickerNames(twseList, tpexList);
await upsert("tw_ticker_names", tickerNames);
console.log(`Upserted ${tickerNames.length} ticker names`);
