// Phase 4 / module 5: 20-week moving average buy/sell signal (from course
// materials): 買進＝周線收盤價站上20周均線；賣出＝日線收盤價跌破20周均線。
//
// Scope is "held + watchlisted" tickers only, same reasoning as the other
// FinMind scripts in this repo (small, well within rate limits).
//
// Requires SUPABASE_SERVICE_ROLE_KEY env var.
// Usage: node scripts/technical-signals.mjs

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEEKS_FOR_MA = 20;
const MIN_WEEKS_REQUIRED = 15; // 資料不夠20週時，至少要有這麼多週才計算（避免均線太不可靠）

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

// 持股 + 觀察股清單（service role 會看到所有使用者的資料，目前單人使用沒問題）
async function fetchTrackedTwTickers() {
  const [txnRes, watchRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/stock_transactions?select=ticker,side,shares&limit=5000`, { headers: sbHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/watchlist?select=ticker`, { headers: sbHeaders }),
  ]);
  if (!txnRes.ok) throw new Error(`stock_transactions fetch failed: ${txnRes.status} ${await txnRes.text()}`);
  if (!watchRes.ok) throw new Error(`watchlist fetch failed: ${watchRes.status} ${await watchRes.text()}`);

  const txns = await txnRes.json();
  const watchRows = await watchRes.json();

  const shares = {};
  txns.forEach((t) => {
    if (!isTwTicker(t.ticker)) return;
    if (t.side !== "buy" && t.side !== "sell") return;
    const delta = t.side === "buy" ? Number(t.shares || 0) : -Number(t.shares || 0);
    shares[t.ticker] = (shares[t.ticker] || 0) + delta;
  });
  const held = Object.keys(shares).filter((t) => shares[t] > 0);
  const watched = watchRows.map((w) => w.ticker).filter(isTwTicker);
  return [...new Set([...held, ...watched])].sort();
}

async function fetchDailyPrices(ticker) {
  const start = new Date();
  start.setDate(start.getDate() - 200); // ~28週，給20週均線留緩衝
  const url = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanStockPrice&data_id=${ticker}&start_date=${start.toISOString().slice(0, 10)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TaiwanStockPrice fetch failed for ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body.status !== 200) throw new Error(`FinMind error for ${ticker}: ${body.msg}`);
  return (body.data || [])
    .filter((r) => r.close != null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// 週一當作該週的分組 key，該週最後一個交易日的收盤價當作週收盤價
function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function computeWeeklyCloses(dailyRows) {
  const byWeek = {};
  dailyRows.forEach((r) => {
    const wk = mondayOfWeek(r.date);
    if (!byWeek[wk] || r.date > byWeek[wk].date) byWeek[wk] = { weekOf: wk, date: r.date, close: r.close };
  });
  return Object.keys(byWeek).sort().map((wk) => byWeek[wk]);
}

function computeSignal(dailyRows) {
  if (dailyRows.length === 0) return null;
  const weeklyCloses = computeWeeklyCloses(dailyRows);
  if (weeklyCloses.length < MIN_WEEKS_REQUIRED) return null;

  const last = weeklyCloses.slice(-WEEKS_FOR_MA);
  const ma20 = last.reduce((s, w) => s + w.close, 0) / last.length;
  const latestWeek = weeklyCloses[weeklyCloses.length - 1];
  const latestDaily = dailyRows[dailyRows.length - 1];

  return {
    week_ma20: ma20,
    week_close: latestWeek.close,
    daily_close: latestDaily.close,
    buy_signal: latestWeek.close >= ma20,
    sell_signal: latestDaily.close < ma20,
    as_of_date: latestDaily.date,
    weeks_used: last.length,
  };
}

async function upsertSignal(stockId, signal) {
  const row = { stock_id: stockId, ...signal, updated_at: new Date().toISOString() };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/stock_technical_signals?on_conflict=stock_id`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) throw new Error(`Upsert failed for ${stockId}: ${res.status} ${await res.text()}`);
}

const tickers = await fetchTrackedTwTickers();
if (tickers.length === 0) {
  console.log("No tracked TW tickers found, nothing to do.");
  process.exit(0);
}
console.log(`Computing 20-week MA signal for ${tickers.length} tickers: ${tickers.join(", ")}`);

for (const ticker of tickers) {
  try {
    const dailyRows = await fetchDailyPrices(ticker);
    const signal = computeSignal(dailyRows);
    if (!signal) {
      console.warn(`${ticker}: not enough weekly history (need >= ${MIN_WEEKS_REQUIRED} weeks), skipped`);
    } else {
      await upsertSignal(ticker, signal);
      console.log(`${ticker}: 週收盤=${signal.week_close} 20週均線=${signal.week_ma20.toFixed(2)} 買訊=${signal.buy_signal} 賣訊=${signal.sell_signal}`);
    }
  } catch (err) {
    console.error(`${ticker}: ${err.message}`);
  }
  await sleep(1500);
}

console.log("Done.");
