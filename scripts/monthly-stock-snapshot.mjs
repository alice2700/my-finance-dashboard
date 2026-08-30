// Monthly snapshot: computes each owner's current total stock market value from
// stock_transactions (net shares per ticker) x current price, and inserts one
// account_balances row per owner (account_type='stock', account_name='股票' -
// the same account name convention already used for manual entries, so this
// doesn't create a second competing "account" - it's just this month's update
// to the same one). This gives 資產淨值走勢 a real persisted history instead of
// only ever reflecting "right now" via app.js's live-value display patch.
// Requires SUPABASE_SERVICE_ROLE_KEY env var (bypasses RLS).

const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STOCKS_API_URL = "https://script.google.com/macros/s/AKfycbxv8lbB_MtE1aOrvzfeyZ5UkwAYukqFrzP5VOIW9Rp4uR94RlD4KAwJ3b4VjS7Ud4EH/exec";

if (!SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_SERVICE_ROLE_KEY env var");
  process.exit(1);
}

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`Fetch ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbInsert(table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Insert ${table} failed: ${res.status} ${await res.text()}`);
}

// 淨股數 = 買進 - 賣出，跟 app.js 的 buildStockPositions 同一套算法（這裡不用算成本/損益，只要股數）
function computeNetShares(stockTxns) {
  const shares = {}; // "owner||ticker" -> 股數
  stockTxns
    .filter((t) => t.side === "buy" || t.side === "sell")
    .forEach((t) => {
      const key = `${t.owner}||${t.ticker}`;
      const n = Number(t.shares || 0);
      shares[key] = (shares[key] || 0) + (t.side === "buy" ? n : -n);
    });
  return shares;
}

const [stockTxns, stockPricesRaw, liveStocksRaw] = await Promise.all([
  sbFetch("stock_transactions?select=owner,ticker,side,shares"),
  sbFetch("stock_prices?select=ticker,price"),
  fetch(STOCKS_API_URL).then((r) => r.json()),
]);

const closingPrices = {};
stockPricesRaw.forEach((p) => { closingPrices[p.ticker] = Number(p.price); });

// Apps Script 即時價優先，"#N/A"（債券ETF/興櫃常見）或整檔沒回傳時退回 stock_prices 昨日收盤價，
// 跟 app.js 的 enrichWithPosition 同一個順序
const livePrices = {};
(liveStocksRaw.stocks || []).forEach((s) => {
  if (s.price != null && s.price !== "#N/A") livePrices[s.ticker] = Number(s.price);
});

const netShares = computeNetShares(stockTxns);

const totalsByOwner = {};
const skipped = [];
Object.entries(netShares).forEach(([key, shares]) => {
  if (shares <= 0.0001) return; // 已經全部賣出的部位不計入
  const [owner, ticker] = key.split("||");
  const price = livePrices[ticker] != null ? livePrices[ticker] : closingPrices[ticker];
  if (price == null) {
    skipped.push(`${owner}/${ticker}`);
    return;
  }
  totalsByOwner[owner] = (totalsByOwner[owner] || 0) + shares * price;
});

if (skipped.length) console.error("找不到價格，這些部位沒算進快照：", skipped);

const today = new Date().toISOString().slice(0, 10);
const rows = Object.entries(totalsByOwner).map(([owner, balance]) => ({
  account_name: "股票",
  account_type: "stock",
  balance: Math.round(balance),
  recorded_at: today,
  note: "GitHub Actions 每月自動快照（逐筆交易 × 當時股價計算）",
  owner,
}));

console.log("Snapshot rows:", rows);
await sbInsert("account_balances", rows);
console.log(`Inserted ${rows.length} monthly stock snapshot rows`);
