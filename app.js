// ===========================================================
// 設定區
// ===========================================================
const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jHKg1gM4WWf28V0Owv2iQw_v0Gn8oXy";

// 股票分頁維持原本的 Apps Script（不搬進 Supabase）
const STOCKS_API_URL = "https://script.google.com/macros/s/AKfycbxv8lbB_MtE1aOrvzfeyZ5UkwAYukqFrzP5VOIW9Rp4uR94RlD4KAwJ3b4VjS7Ud4EH/exec";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- 顏色（跟 style.css 呼應） ----------
const COLOR_SAGE = "#7C9473";
const COLOR_CLAY = "#C08552";
const COLOR_INK = "#3D4A3F";
const COLOR_MUTED = "#8C8577";
const COLOR_BORDER = "#E8E2D8";
const PIE_COLORS = ["#7C9473", "#C08552", "#B8A088", "#94A897", "#D9B382", "#8C8577", "#A9BFA0", "#CBA37C"];

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return "NT$ " + new Intl.NumberFormat("zh-TW").format(Math.round(n));
}

// ---------- 分頁切換 ----------
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("page-" + btn.dataset.page).classList.remove("hidden");
  });
});

// ===========================================================
// 登入 / 登出
// ===========================================================
function showApp() {
  document.getElementById("page-login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.querySelector(".tabbar").classList.remove("hidden");
  document.getElementById("logoutBtn").classList.remove("hidden");
}

function showLogin() {
  document.getElementById("page-login").classList.remove("hidden");
  document.getElementById("app").classList.add("hidden");
  document.querySelector(".tabbar").classList.add("hidden");
  document.getElementById("logoutBtn").classList.add("hidden");
}

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  const btn = document.getElementById("loginSubmit");
  errEl.classList.add("hidden");
  btn.disabled = true;
  btn.textContent = "登入中...";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  btn.textContent = "登入";
  if (error) {
    errEl.textContent = "登入失敗：" + error.message;
    errEl.classList.remove("hidden");
  }
});

document.getElementById("logoutBtn").addEventListener("click", () => sb.auth.signOut());

sb.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_IN" && session) {
    showApp();
    loadData();
  } else if (event === "SIGNED_OUT") {
    showLogin();
  }
});

async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    showApp();
    loadData();
  } else {
    showLogin();
  }
}

// ===========================================================
// 主要載入流程
// ===========================================================
const charts = {};

function renderChart(key, canvasId, config) {
  if (charts[key]) charts[key].destroy();
  charts[key] = new Chart(document.getElementById(canvasId), config);
}

async function loadData() {
  try {
    const [
      { data: categories, error: catErr },
      { data: snapshots, error: snapErr },
      { data: balances, error: balErr },
      { data: txns, error: txnErr },
      { data: goalsRows, error: goalsErr },
      { data: stockTxns, error: stockTxnErr },
      { data: budgetGroupsRaw, error: bgErr },
      { data: budgetCatsRaw, error: bgcErr },
      { data: budgetAmountsRaw, error: baErr },
      { data: stockPricesRaw, error: spErr },
    ] = await Promise.all([
      sb.from("category_map").select("id,item_name,mid_name,type"),
      sb.from("asset_snapshots").select("year,month,cash_and_deposits,other_investments,stock_market_value").order("year").order("month"),
      sb.from("account_balances").select("account_name,account_type,balance,recorded_at").order("recorded_at"),
      sb.from("transactions").select("id,date,amount,type,category_id,note,is_special,is_pending,pending_group").limit(5000),
      sb.from("goals_assumptions").select("*").limit(1),
      sb.from("stock_transactions").select("ticker,market,stock_name,trade_date,side,shares,amount_twd").limit(5000),
      sb.from("budget_groups").select("id,name,mode"),
      sb.from("budget_group_categories").select("budget_group_id,category_id"),
      sb.from("budget_amounts").select("budget_group_id,year,month,amount"),
      sb.from("stock_prices").select("ticker,price,price_date"),
    ]);
    if (catErr) throw catErr;
    if (snapErr) throw snapErr;
    if (balErr) throw balErr;
    if (txnErr) throw txnErr;
    if (goalsErr) throw goalsErr;
    if (spErr) throw spErr;
    if (stockTxnErr) throw stockTxnErr;
    if (bgErr) throw bgErr;
    if (bgcErr) throw bgcErr;
    if (baErr) throw baErr;

    const groupById = {};
    (budgetGroupsRaw || []).forEach((g) => {
      groupById[g.id] = { id: g.id, name: g.name, mode: g.mode, categoryIds: [], amounts: {} };
    });
    (budgetCatsRaw || []).forEach((bc) => {
      if (groupById[bc.budget_group_id]) groupById[bc.budget_group_id].categoryIds.push(bc.category_id);
    });
    (budgetAmountsRaw || []).forEach((ba) => {
      if (groupById[ba.budget_group_id]) groupById[ba.budget_group_id].amounts[ba.year + "-" + ba.month] = Number(ba.amount);
    });
    budgetGroups = Object.values(groupById);

    allCategories = categories || [];
    const catMap = {};
    (categories || []).forEach((c) => { catMap[c.id] = { item_name: c.item_name, mid_name: c.mid_name || "未分類" }; });

    // 依年/月彙總每個月的收入、支出
    // 待銷帳（is_pending）的收入/支出不算「真正的」收支，一律排除在所有統計之外
    const monthly = {};
    (txns || []).forEach((t) => {
      if (t.is_pending) return;
      const y = parseInt(t.date.slice(0, 4), 10);
      const m = parseInt(t.date.slice(5, 7), 10);
      const key = y + "-" + m;
      if (!monthly[key]) monthly[key] = { income: 0, expense: 0 };
      monthly[key][t.type] += Number(t.amount);
    });

    // trend：舊資料讀 asset_snapshots（cash_and_deposits=活期、other_investments=定存、
    // stock_market_value=股票，2024/2025 目前還沒拆分，全部在活期），
    // 之後有記錄的月份改讀 account_balances（依帳戶 account_type 拆成活期/定存/股票三類）
    const snapshotMonths = new Set();
    const fromSnapshots = (snapshots || []).map((s) => {
      snapshotMonths.add(s.year + "-" + s.month);
      const key = s.year + "-" + s.month;
      const mo = monthly[key] || { income: 0, expense: 0 };
      const activeDeposit = Number(s.cash_and_deposits || 0);
      const timeDeposit = Number(s.other_investments || 0);
      const stockPart = Number(s.stock_market_value || 0);
      return {
        year: s.year,
        month: s.month,
        label: String(s.year).slice(2) + "/" + s.month,
        asset: activeDeposit + timeDeposit + stockPart,
        cashPart: activeDeposit + timeDeposit,
        activeDeposit,
        timeDeposit,
        stockPart,
        income: mo.income,
        expense: mo.expense,
      };
    });

    // 每個帳戶在每個月取「當月最新一筆」餘額
    // account_type：cash=活期存款、investment=定存/基金/儲蓄險等、stock=股票
    latestByAccountMonth = {}; // "y-m" -> { accountName: balanceRow }
    (balances || []).forEach((b) => {
      const d = new Date(b.recorded_at);
      const key = d.getFullYear() + "-" + (d.getMonth() + 1);
      if (!latestByAccountMonth[key]) latestByAccountMonth[key] = {};
      const cur = latestByAccountMonth[key][b.account_name];
      if (!cur || new Date(b.recorded_at) > new Date(cur.recorded_at)) {
        latestByAccountMonth[key][b.account_name] = b;
      }
    });

    const fromBalances = Object.keys(latestByAccountMonth)
      .filter((key) => !snapshotMonths.has(key))
      .map((key) => {
        const [y, m] = key.split("-").map(Number);
        let activeDeposit = 0;
        let timeDeposit = 0;
        let stockPart = 0;
        Object.values(latestByAccountMonth[key]).forEach((b) => {
          if (b.account_type === "stock") stockPart += Number(b.balance);
          else if (b.account_type === "investment") timeDeposit += Number(b.balance);
          else activeDeposit += Number(b.balance);
        });
        const mo = monthly[key] || { income: 0, expense: 0 };
        return {
          year: y,
          month: m,
          label: String(y).slice(2) + "/" + m,
          asset: activeDeposit + timeDeposit + stockPart,
          cashPart: activeDeposit + timeDeposit,
          activeDeposit,
          timeDeposit,
          stockPart,
          income: mo.income,
          expense: mo.expense,
        };
      });

    const trend = fromSnapshots.concat(fromBalances).sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));

    // 每個帳戶「不分月份」的最新一筆餘額，用來當股票市值來源
    // （目前主要用於 GOOGLEFINANCE 抓不到價格的標的，帳戶名稱要記得跟股票代號一致）
    latestBalanceByAccount = {};
    (balances || []).forEach((b) => {
      const cur = latestBalanceByAccount[b.account_name];
      if (!cur || new Date(b.recorded_at) > new Date(cur.recorded_at)) {
        latestBalanceByAccount[b.account_name] = b;
      }
    });

    stockPositions = buildStockPositions(stockTxns || [], txns || [], catMap);

    stockPrices = {};
    (stockPricesRaw || []).forEach((p) => { stockPrices[p.ticker] = p; });

    allStockTxns = stockTxns || [];

    renderOverview(trend);

    allTxns = txns || [];
    allCatMap = catMap;
    earliestTxnKey = null;
    latestTxnKey = null;
    earliestTxnYear = null;
    latestTxnYear = null;
    let latestTxnMonth = null;
    allTxns.forEach((t) => {
      const y = parseInt(t.date.slice(0, 4), 10);
      const m = parseInt(t.date.slice(5, 7), 10);
      const key = y * 12 + m;
      if (earliestTxnKey === null || key < earliestTxnKey) { earliestTxnKey = key; earliestTxnYear = y; }
      if (latestTxnKey === null || key > latestTxnKey) { latestTxnKey = key; latestTxnYear = y; latestTxnMonth = m; }
    });
    if (cashflowYear === null && latestTxnYear !== null) {
      cashflowYear = latestTxnYear;
      cashflowMonth = latestTxnMonth;
    }
    if (cashflowYear !== null) renderCashflowView();

    if (detailYear === null && latestTxnYear !== null) {
      detailYear = latestTxnYear;
      detailMonth = latestTxnMonth;
    }
    if (detailYear !== null) renderDetailView();

    if (trend.length) {
      renderGoals(buildGoals(goalsRows && goalsRows[0], trend));
      renderYearlyReview(trend, allTxns, goalsRows && goalsRows[0]);
    }

    renderStockInvested(stockTxns);

    document.getElementById("updatedAt").textContent =
      "更新於 " + new Date().toLocaleString("zh-TW", { hour12: false });
    document.getElementById("loadError").classList.add("hidden");
  } catch (err) {
    console.error(err);
    showLoadError(err);
  }

  loadStocks();
}

function showLoadError(err) {
  const box = document.getElementById("loadError");
  box.classList.remove("hidden");
  document.getElementById("loadErrorDetail").textContent =
    "錯誤訊息：" + (err && err.message ? err.message : String(err));
}

// ---------- 長期目標試算 ----------
// FIRE 目標 = 近12個月生活支出 × 25（4%法則）
// 退休預估資產 = 目前資產 × (1+期望報酬率)^(退休年齡-目前年齡)（不含後續儲蓄）
// 購屋頭期款 = 房價目標(萬) × 10000 × 頭期款比例
function buildGoals(goalsRow, trend) {
  if (!goalsRow) return null;
  const currentAsset = trend[trend.length - 1].asset;
  const currentYear = new Date().getFullYear();
  const currentAge = goalsRow.birth_year ? currentYear - goalsRow.birth_year : null;
  const retireAge = goalsRow.target_retire_age || null;

  const last12 = trend.slice(-12);
  const last12Expense = last12.reduce((sum, t) => sum + t.expense, 0);
  const fireTarget = last12Expense * 25;

  const rate = Number(goalsRow.expected_return_rate || 0);
  const years = currentAge != null && retireAge != null ? Math.max(0, retireAge - currentAge) : 0;
  const fireProjection = currentAsset * Math.pow(1 + rate, years);

  const houseTarget = goalsRow.house_target_price_wan
    ? Number(goalsRow.house_target_price_wan) * 10000 * Number(goalsRow.down_payment_pct || 0)
    : null;

  return {
    currentAsset,
    fireTarget,
    currentAge,
    retireAge,
    fireProjection,
    houseTarget,
    housePrice: goalsRow.house_target_price_wan,
  };
}

// ---------- 總覽 ----------
let overviewTrend = [];
let assetSeries = "total"; // total | cash | stock
let balanceRange = "12"; // 12 | all

function renderOverview(trend) {
  if (!trend || !trend.length) return;
  overviewTrend = trend;
  const latest = trend[trend.length - 1];
  const first = trend[0];
  const growth = first.asset ? (((latest.asset - first.asset) / first.asset) * 100).toFixed(0) : null;
  const balance = latest.income - latest.expense;

  const monthTag = latest.year + "/" + latest.month;
  document.getElementById("labelAsset").textContent = monthTag + " 資產淨值";
  document.getElementById("labelIncome").textContent = monthTag + " 收入";
  document.getElementById("labelExpense").textContent = monthTag + " 生活支出";
  document.getElementById("labelBalance").textContent = monthTag + " 結餘";

  document.getElementById("statAsset").textContent = fmt(latest.asset);
  document.getElementById("statAssetGrowth").textContent = growth !== null ? `累計成長 ${growth >= 0 ? "+" : ""}${growth}%` : "";
  document.getElementById("statIncome").textContent = fmt(latest.income);
  document.getElementById("statExpense").textContent = fmt(latest.expense);
  document.getElementById("statBalance").textContent = fmt(balance);
  const balanceCard = document.getElementById("balanceCard");
  balanceCard.classList.remove("accent-income", "accent-expense");
  balanceCard.classList.add(balance >= 0 ? "accent-income" : "accent-expense");

  renderMarketNote(trend);
  renderAssetChart();
  renderBalanceChart();
}

// ---------- 資產組成：活存（分帳戶）/ 定存（分帳戶）/ 台股 / 美股 ----------
// 台股、美股市值等股票分頁資料載入後才知道，先用帳戶餘額畫活存/定存，
// 股票分頁載入完成後 renderStocks() 會再呼叫一次補上台股/美股
let assetCompositionStockTotals = { tw: null, us: null };

// year/month 省略時顯示最新狀態（含股票分頁即時台股/美股拆分）；
// 指定 year/month 時顯示該月的歷史快照（活存/定存來自 account_balances 當月最後一筆，
// 股票沒有逐月拆分資料，改用 asset_snapshots/account_balances 算出的合計 stockPart）
function renderAssetComposition(year, month) {
  const el = document.getElementById("assetComposition");
  const labelEl = document.getElementById("assetCompositionLabel");
  if (!el) return;

  const isLatest = year == null || month == null;
  const key = isLatest ? null : `${year}-${month}`;
  const source = isLatest ? latestBalanceByAccount : latestByAccountMonth[key] || {};

  if (labelEl) labelEl.textContent = isLatest ? "" : `${year}/${month}`;

  const cashAccounts = [];
  const investmentAccounts = [];
  Object.entries(source).forEach(([name, b]) => {
    if (b.account_type === "cash") cashAccounts.push({ name, value: Number(b.balance) });
    else if (b.account_type === "investment") investmentAccounts.push({ name, value: Number(b.balance) });
  });
  cashAccounts.sort((a, b) => b.value - a.value);
  investmentAccounts.sort((a, b) => b.value - a.value);

  const stockRows = [];
  if (isLatest) {
    if (assetCompositionStockTotals.tw != null) stockRows.push({ name: "台股", value: assetCompositionStockTotals.tw });
    if (assetCompositionStockTotals.us != null) stockRows.push({ name: "美股", value: assetCompositionStockTotals.us });
  } else {
    const trendPoint = overviewTrend.find((t) => t.year === year && t.month === month);
    if (trendPoint && trendPoint.stockPart) stockRows.push({ name: "股票（合計，無法拆分台美股）", value: trendPoint.stockPart });
  }

  const groups = [
    { name: "活存", accounts: cashAccounts },
    { name: "定存", accounts: investmentAccounts },
    { name: "股票", accounts: stockRows },
  ].filter((g) => g.accounts.length);

  if (!groups.length) {
    el.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">這個月沒有資產紀錄</span></div>';
    charts.assetComposition && charts.assetComposition.destroy();
    return;
  }

  const flatRows = groups.flatMap((g) => g.accounts.map((a) => ({ group: g.name, label: a.name, value: a.value })));
  const total = flatRows.reduce((sum, r) => sum + r.value, 0);

  renderChart("assetComposition", "chartAssetComposition", {
    type: "doughnut",
    data: {
      labels: flatRows.map((r) => r.label),
      datasets: [{ data: flatRows.map((r) => r.value), backgroundColor: PIE_COLORS, borderWidth: 2, borderColor: "#fff" }],
    },
    options: {
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: COLOR_MUTED } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.raw)}` } },
      },
    },
  });

  el.innerHTML = groups
    .map((g) => {
      const groupTotal = g.accounts.reduce((sum, a) => sum + a.value, 0);
      const itemsHtml = g.accounts
        .map(
          (a) => `<div class="flow-item-top">
            <span class="flow-item-name">${a.name}</span>
            <span class="flow-item-value">${fmt(a.value)}${total ? `（${((a.value / total) * 100).toFixed(1)}%）` : ""}</span>
          </div>`
        )
        .join("");
      return `<div class="flow-group">
        <button class="flow-group-header">
          <span class="flow-group-name"><span class="flow-caret">▸</span>${g.name}</span>
          <span class="flow-group-value">${fmt(groupTotal)}</span>
        </button>
        <div class="flow-group-body">${itemsHtml}</div>
      </div>`;
    })
    .join("");

  el.querySelectorAll(".flow-group-header").forEach((header) => {
    const body = header.nextElementSibling;
    header.addEventListener("click", () => {
      header.classList.toggle("expanded");
      body.classList.toggle("expanded");
    });
  });
}

function seriesValue(t, series) {
  if (series === "cash") return t.cashPart;
  if (series === "stock") return t.stockPart;
  return t.asset;
}

function renderAssetChart() {
  const trend = overviewTrend;
  const labels = trend.map((t) => t.label);
  const canvas = document.getElementById("chartAsset");
  renderChart("asset", "chartAsset", {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: trend.map((t) => seriesValue(t, assetSeries)),
        borderColor: COLOR_SAGE,
        backgroundColor: "rgba(124,148,115,0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHitRadius: 20,
        borderWidth: 2,
      }],
    },
    options: {
      ...baseChartOptions(),
      interaction: { mode: "index", intersect: false },
      onHover: (evt, elements) => {
        if (elements && elements.length) {
          const t = trend[elements[0].index];
          document.getElementById("assetHoverNote").textContent =
            `${t.year}/${t.month}：${fmt(seriesValue(t, assetSeries))}`;
          renderAssetComposition(t.year, t.month);
        }
      },
    },
  });
  const note = document.getElementById("assetHoverNote");
  const resetNote = () => {
    const latest = trend[trend.length - 1];
    note.textContent = `${latest.year}/${latest.month}：${fmt(seriesValue(latest, assetSeries))}`;
    renderAssetComposition();
  };
  resetNote();
  canvas.onmouseleave = resetNote;
  canvas.ontouchend = resetNote;

  document.querySelectorAll("#assetSeriesToggle .segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.series === assetSeries);
  });
}

// 本月資產變化 − 本月結餘（存錢貢獻） = 市場漲跌等其他貢獻
function renderMarketNote(trend) {
  const note = document.getElementById("marketContributionNote");
  if (trend.length < 2) { note.innerHTML = ""; return; }
  const latest = trend[trend.length - 1];
  const prev = trend[trend.length - 2];
  const assetChange = latest.asset - prev.asset;
  const sign = (n) => (n >= 0 ? "+" : "");
  const rows = [
    ["活期存款", latest.activeDeposit - prev.activeDeposit],
    ["定期存款", latest.timeDeposit - prev.timeDeposit],
    ["股票", latest.stockPart - prev.stockPart],
  ];
  note.innerHTML =
    `<div class="market-note-row market-note-title">${latest.year}/${latest.month} 資產變化 ${sign(assetChange)}${fmt(assetChange)}</div>` +
    rows.map(([label, v]) => `<div class="market-note-row"><span>${label}</span><span>${sign(v)}${fmt(v)}</span></div>`).join("");
}

function renderBalanceChart() {
  const trend = balanceRange === "12" ? overviewTrend.slice(-12) : overviewTrend;
  const labels = trend.map((t) => t.label);
  renderChart("incomeExpense", "chartIncomeExpense", {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: trend.map((t) => t.income - t.expense),
        backgroundColor: (ctx) => (ctx.raw >= 0 ? COLOR_SAGE : COLOR_CLAY),
        borderRadius: 3,
      }],
    },
    options: baseChartOptions(false),
  });
  document.querySelectorAll("#rangeToggle .segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === balanceRange);
  });
}

document.getElementById("assetSeriesToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-btn");
  if (!btn) return;
  assetSeries = btn.dataset.series;
  renderAssetChart();
});

document.getElementById("rangeToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-btn");
  if (!btn) return;
  balanceRange = btn.dataset.range;
  renderBalanceChart();
});

function baseChartOptions(showLegend) {
  return {
    responsive: true,
    plugins: {
      legend: { display: !!showLegend, position: "top", labels: { boxWidth: 10, font: { size: 11 }, color: COLOR_MUTED } },
      tooltip: {
        backgroundColor: "#fff", titleColor: COLOR_INK, bodyColor: COLOR_INK,
        borderColor: COLOR_BORDER, borderWidth: 1, padding: 10,
        callbacks: { label: (ctx) => fmt(ctx.raw) },
      },
    },
    scales: {
      x: { ticks: { font: { size: 9 }, color: COLOR_MUTED, maxRotation: 0 }, grid: { display: false } },
      y: { ticks: { font: { size: 9 }, color: COLOR_MUTED, callback: (v) => (v / 10000).toFixed(0) + "萬" }, grid: { color: COLOR_BORDER } },
    },
  };
}

// ---------- 現金流 ----------
// 把一個期間內的交易，依 大類(mid_name) -> 中類(item_name) -> 逐筆 分組，
// 各層都用金額由大到小排序，percent 一律相對於該期間、該收支方向的總額
function buildFlowHierarchy(txnList, catInfo) {
  const groups = {};
  let total = 0;
  txnList.forEach((t) => {
    const info = catInfo[t.category_id] || { item_name: "未分類", mid_name: "未分類" };
    const amt = Number(t.amount);
    total += amt;
    if (!groups[info.mid_name]) groups[info.mid_name] = { value: 0, items: {} };
    const g = groups[info.mid_name];
    g.value += amt;
    if (!g.items[info.item_name]) g.items[info.item_name] = { value: 0, txns: [] };
    const it = g.items[info.item_name];
    it.value += amt;
    it.txns.push({ date: t.date, note: t.note, amount: amt });
  });
  return Object.keys(groups)
    .map((name) => {
      const g = groups[name];
      const items = Object.keys(g.items)
        .map((iname) => {
          const it = g.items[iname];
          it.txns.sort((a, b) => b.amount - a.amount);
          return { name: iname, value: it.value, percent: total ? (it.value / total) * 100 : 0, txns: it.txns };
        })
        .sort((a, b) => b.value - a.value);
      return { name, value: g.value, percent: total ? (g.value / total) * 100 : 0, items };
    })
    .sort((a, b) => b.value - a.value);
}

function renderFlowHierarchy(container, groups, kind) {
  container.innerHTML = "";
  if (!groups.length) {
    container.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料</span></div>';
    return;
  }
  const maxGroup = groups[0].value;
  groups.forEach((g) => {
    const groupEl = document.createElement("div");
    groupEl.className = "flow-group";
    groupEl.innerHTML = `
      <button class="flow-group-header">
        <span class="flow-group-name"><span class="flow-caret">▸</span>${g.name}</span>
        <span class="flow-group-value">${fmt(g.value)}（${g.percent.toFixed(1)}%）</span>
      </button>
      <div class="flow-bar-track"><div class="flow-bar-fill ${kind}" style="width:${maxGroup ? (g.value / maxGroup) * 100 : 0}%"></div></div>
      <div class="flow-group-body"></div>
    `;
    const header = groupEl.querySelector(".flow-group-header");
    const body = groupEl.querySelector(".flow-group-body");
    header.addEventListener("click", () => {
      header.classList.toggle("expanded");
      body.classList.toggle("expanded");
    });

    const maxItem = g.items[0].value;
    g.items.forEach((it) => {
      const itemEl = document.createElement("div");
      itemEl.className = "flow-item-group";
      itemEl.innerHTML = `
        <button class="flow-item-header">
          <span class="flow-item-name-cell"><span class="flow-caret">▸</span>${it.name}</span>
          <span class="flow-item-value-cell">${fmt(it.value)}（${it.percent.toFixed(1)}%）</span>
        </button>
        <div class="flow-bar-track"><div class="flow-bar-fill ${kind}" style="width:${maxItem ? (it.value / maxItem) * 100 : 0}%"></div></div>
        <div class="flow-item-body"></div>
      `;
      const itemHeader = itemEl.querySelector(".flow-item-header");
      const itemBody = itemEl.querySelector(".flow-item-body");
      itemHeader.addEventListener("click", () => {
        itemHeader.classList.toggle("expanded");
        itemBody.classList.toggle("expanded");
      });
      it.txns.forEach((tx) => {
        const row = document.createElement("div");
        row.className = "flow-tx-row";
        row.innerHTML = `<span class="flow-tx-date">${tx.date.slice(5)}</span><span class="flow-tx-note">${tx.note || ""}</span><span class="flow-tx-amount">${fmt(tx.amount)}</span>`;
        itemBody.appendChild(row);
      });
      body.appendChild(itemEl);
    });
    container.appendChild(groupEl);
  });
}

function renderCashflow(breakdown) {
  if (!breakdown) return;
  renderFlowHierarchy(document.getElementById("incomeFlow"), breakdown.income, "income");
  renderFlowHierarchy(document.getElementById("expenseFlow"), breakdown.expense, "expense");
}

// 待銷帳：不列入任何統計，但另外顯示出來，避免看起來像資料憑空消失
const pendingSelectedIds = new Set();

function renderPendingList(pending, catInfo) {
  const el = document.getElementById("pendingFlow");
  if (!el) return;
  pendingSelectedIds.clear();
  if (!pending.length) {
    el.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">這段期間沒有待銷帳項目</span></div>';
    return;
  }

  // 全部待銷帳交易（不限本期）用過的標籤，給 datalist 建議用
  const allTags = [...new Set(allTxns.filter((t) => t.is_pending && t.pending_group).map((t) => t.pending_group))];
  const datalistHtml = `<datalist id="pendingGroupOptions">${allTags.map((t) => `<option value="${t}"></option>`).join("")}</datalist>`;

  const batchBarHtml = `<div class="pending-batch-bar">
    <input type="text" id="pendingBatchTag" list="pendingGroupOptions" placeholder="輸入標籤，套用到勾選項目" />
    <button type="button" id="pendingBatchApply">套用（已選 <span id="pendingSelectedCount">0</span>）</button>
  </div>`;

  // 依人工標籤分組，沒標籤的排最後
  const groups = {};
  pending.forEach((t) => {
    const key = t.pending_group || "";
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });
  const orderedKeys = Object.keys(groups).sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });

  const groupsHtml = orderedKeys
    .map((key) => {
      const rows = [...groups[key]].sort((a, b) => a.date.localeCompare(b.date));
      const groupNet = pendingNetDiff(rows);
      const netLabel = groupNet > 0 ? `多收 ${fmt(groupNet)}` : groupNet < 0 ? `多付 ${fmt(-groupNet)}` : "打平";
      const rowsHtml = rows
        .map((t) => {
          const info = catInfo[t.category_id] || { item_name: "未分類" };
          const sign = t.type === "income" ? "+" : "-";
          return `<div class="pending-row">
            <div class="flow-tx-row">
              <input type="checkbox" class="pending-select" data-id="${t.id}" />
              <span class="flow-tx-date">${t.date.slice(5)}</span>
              <span class="flow-tx-note">${info.item_name}｜${t.note || ""}</span>
              <span class="flow-tx-amount">${sign}${fmt(Math.abs(t.amount))}</span>
            </div>
            <input class="pending-tag-input" list="pendingGroupOptions" data-id="${t.id}" placeholder="分組標籤（自己判斷勾稽用，選填）" value="${t.pending_group || ""}" />
          </div>`;
        })
        .join("");
      return `<div class="pending-group">
        <button class="pending-group-header">
          <span><span class="flow-caret">▸</span>${key || "未分組"}</span>
          <span>${netLabel}</span>
        </button>
        <div class="pending-group-body">${rowsHtml}</div>
      </div>`;
    })
    .join("");

  const net = pendingNetDiff(pending);
  const netLabel = net > 0 ? `多收 ${fmt(net)}（已計入收入）` : net < 0 ? `多付 ${fmt(-net)}（已計入支出）` : "剛好打平";
  el.innerHTML =
    datalistHtml +
    batchBarHtml +
    groupsHtml +
    `<div class="flow-item-top" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);">
      <span class="flow-item-name">整體淨額</span>
      <span class="flow-item-value">${netLabel}</span>
    </div>`;

  el.querySelectorAll(".pending-group-header").forEach((header) => {
    const body = header.nextElementSibling;
    header.addEventListener("click", () => {
      header.classList.toggle("expanded");
      body.classList.toggle("expanded");
    });
  });

  async function saveTag(ids, value) {
    const { error } = await sb.from("transactions").update({ pending_group: value || null }).in("id", ids);
    if (error) {
      alert("標籤儲存失敗：" + error.message);
      return false;
    }
    ids.forEach((id) => {
      const t = allTxns.find((x) => String(x.id) === String(id));
      if (t) t.pending_group = value || null;
    });
    return true;
  }

  el.querySelectorAll(".pending-tag-input").forEach((input) => {
    input.addEventListener("change", async () => {
      input.disabled = true;
      const ok = await saveTag([input.dataset.id], input.value.trim());
      input.disabled = false;
      if (ok) renderCashflowView();
    });
  });

  el.querySelectorAll(".pending-select").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) pendingSelectedIds.add(cb.dataset.id);
      else pendingSelectedIds.delete(cb.dataset.id);
      document.getElementById("pendingSelectedCount").textContent = pendingSelectedIds.size;
    });
  });

  document.getElementById("pendingBatchApply").addEventListener("click", async () => {
    if (!pendingSelectedIds.size) {
      alert("請先勾選要套用標籤的項目");
      return;
    }
    const tagInput = document.getElementById("pendingBatchTag");
    const btn = document.getElementById("pendingBatchApply");
    btn.disabled = true;
    const ok = await saveTag([...pendingSelectedIds], tagInput.value.trim());
    btn.disabled = false;
    if (ok) renderCashflowView();
  });
}

// 待銷帳淨額：多收（收 > 付）算收入、多付（付 > 收）算支出，都反映進統計
function pendingNetDiff(pending) {
  let net = 0;
  pending.forEach((t) => {
    net += t.type === "income" ? Number(t.amount) : -Number(t.amount);
  });
  return net;
}

// ---------- 現金流：月/年 切換 ----------
let allTxns = [];
let allCatMap = {};
let cashflowYear = null;
let cashflowMonth = null;
let cashflowRange = "month"; // month | year
let earliestTxnKey = null;
let latestTxnKey = null;
let budgetGroups = [];
let earliestTxnYear = null;
let latestTxnYear = null;

function renderCashflowView() {
  const income = [];
  const expense = [];
  const pending = [];
  allTxns.forEach((t) => {
    const y = parseInt(t.date.slice(0, 4), 10);
    const m = parseInt(t.date.slice(5, 7), 10);
    if (y !== cashflowYear) return;
    if (cashflowRange === "month" && m !== cashflowMonth) return;
    if (t.is_pending) { pending.push(t); return; }
    (t.type === "income" ? income : expense).push(t);
  });

  // 待銷帳淨額（代墊差額）：多收算收入、多付算支出，一起反映進統計
  // 收入方向沒有對應的「代墊」分類，另外掛一個假 id，顯示用的中類名稱才會正確標成「其他收入」
  const PENDING_NET_EXPENSE_CATEGORY_ID = 41; // 代墊（既有分類，中類：其他支出）
  const PENDING_NET_INCOME_CATEGORY_ID = -1; // 只用於顯示，不對應真的 category_map 資料
  const catInfoWithPendingIncome = { ...allCatMap, [PENDING_NET_INCOME_CATEGORY_ID]: { item_name: "代墊", mid_name: "其他收入" } };
  const net = pendingNetDiff(pending);
  if (net !== 0) {
    const repDate = cashflowRange === "month"
      ? `${cashflowYear}-${String(cashflowMonth).padStart(2, "0")}-01`
      : `${cashflowYear}-01-01`;
    const synthetic = {
      date: repDate,
      amount: Math.abs(net),
      category_id: net > 0 ? PENDING_NET_INCOME_CATEGORY_ID : PENDING_NET_EXPENSE_CATEGORY_ID,
      note: net > 0 ? "待銷帳淨額（多收）" : "待銷帳淨額（多付）",
    };
    (net > 0 ? income : expense).push(synthetic);
  }

  renderCashflow({
    income: buildFlowHierarchy(income, catInfoWithPendingIncome),
    expense: buildFlowHierarchy(expense, allCatMap),
  });
  renderPendingList(pending, allCatMap);

  const periodTag = cashflowRange === "month" ? cashflowYear + "/" + cashflowMonth : cashflowYear + "年";
  document.getElementById("labelIncomeFlow").textContent = periodTag + " 收入來源";
  document.getElementById("labelExpenseFlow").textContent = periodTag + " 支出去向";
  document.getElementById("cashflowMonthLabel").textContent = periodTag;

  if (cashflowRange === "month") {
    const key = cashflowYear * 12 + cashflowMonth;
    document.getElementById("cashflowPrevMonth").disabled = earliestTxnKey !== null && key <= earliestTxnKey;
    document.getElementById("cashflowNextMonth").disabled = latestTxnKey !== null && key >= latestTxnKey;
  } else {
    document.getElementById("cashflowPrevMonth").disabled = earliestTxnYear !== null && cashflowYear <= earliestTxnYear;
    document.getElementById("cashflowNextMonth").disabled = latestTxnYear !== null && cashflowYear >= latestTxnYear;
  }

  document.querySelectorAll("#cashflowRangeToggle .segmented-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.range === cashflowRange);
  });

  renderBudgetStatus();
}

// 月度制群組：實際花費 vs 該期間預算金額，<80%綠、80-100%黃、>100%紅
// 累積制群組（旅遊基金）：不受頁面月/年切換影響，永遠顯示「今年至今」的提撥額度 vs 實際花費（排除 is_special）
function renderBudgetStatus() {
  const container = document.getElementById("budgetGroupsList");
  if (!container) return;
  if (!budgetGroups.length) {
    container.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚未設定預算群組</span></div>';
    return;
  }

  const rows = budgetGroups.map((g) => {
    if (g.mode === "cumulative") {
      const now = new Date();
      const year = now.getFullYear();
      const elapsedMonths = now.getMonth() + 1;
      let accrued = 0;
      for (let m = 1; m <= elapsedMonths; m++) accrued += g.amounts[year + "-" + m] || 0;
      let actual = 0;
      allTxns.forEach((t) => {
        if (t.type !== "expense" || t.is_special || t.is_pending) return;
        if (!g.categoryIds.includes(t.category_id)) return;
        if (parseInt(t.date.slice(0, 4), 10) !== year) return;
        actual += Number(t.amount);
      });
      const remaining = accrued - actual;
      return `<div class="budget-row">
        <span class="budget-dot ${remaining >= 0 ? "green" : "red"}"></span>
        <span class="budget-name">${g.name}</span>
        <span class="budget-value">已提撥 ${fmt(accrued)}，已花 ${fmt(actual)}，${remaining >= 0 ? "剩餘" : "超支"} ${fmt(Math.abs(remaining))}</span>
      </div>`;
    }

    const months = cashflowRange === "year" ? Array.from({ length: 12 }, (_, i) => i + 1) : [cashflowMonth];
    let budget = 0;
    months.forEach((m) => { budget += g.amounts[cashflowYear + "-" + m] || 0; });
    let actual = 0;
    allTxns.forEach((t) => {
      if (t.type !== "expense" || t.is_pending) return;
      if (!g.categoryIds.includes(t.category_id)) return;
      const y = parseInt(t.date.slice(0, 4), 10);
      const m = parseInt(t.date.slice(5, 7), 10);
      if (y !== cashflowYear) return;
      if (cashflowRange === "month" && m !== cashflowMonth) return;
      actual += Number(t.amount);
    });
    const pct = budget ? (actual / budget) * 100 : 0;
    const status = pct < 80 ? "green" : pct <= 100 ? "yellow" : "red";
    return `<div class="budget-row">
      <span class="budget-dot ${status}"></span>
      <span class="budget-name">${g.name}</span>
      <span class="budget-value">${fmt(actual)} / ${fmt(budget)}（${pct.toFixed(0)}%）</span>
    </div>`;
  });
  container.innerHTML = rows.join("");
}

document.getElementById("cashflowPrevMonth").addEventListener("click", () => {
  if (cashflowRange === "year") {
    cashflowYear -= 1;
  } else {
    cashflowMonth -= 1;
    if (cashflowMonth < 1) { cashflowMonth = 12; cashflowYear -= 1; }
  }
  renderCashflowView();
});

document.getElementById("cashflowNextMonth").addEventListener("click", () => {
  if (cashflowRange === "year") {
    cashflowYear += 1;
  } else {
    cashflowMonth += 1;
    if (cashflowMonth > 12) { cashflowMonth = 1; cashflowYear += 1; }
  }
  renderCashflowView();
});

// ---------- 明細：月曆花費熱點（中分類自選） ----------
let detailYear = null;
let detailMonth = null;
let detailSelectedDay = null;
let detailSelectedMidNames = new Set(["生活支出(變動)"]); // 預設：非固定生活支出
let detailFilterButtonsBound = false;
let detailEditingId = null;

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function heatColor(ratio) {
  if (ratio <= 0) return "var(--bg)";
  // 從淡橘到深橘，跟 --clay 呼應
  const alpha = 0.12 + ratio * 0.68;
  return `rgba(192, 133, 82, ${alpha.toFixed(2)})`;
}

// chip 每次都整個重畫（元素不多，成本低），「全選」「清除」按鈕的事件只綁一次避免重複綁定
function renderDetailFilters() {
  const el = document.getElementById("detailMidNameFilters");
  if (!el) return;
  const midNames = [...new Set(Object.values(allCatMap).map((c) => c.mid_name).filter(Boolean))];

  el.innerHTML = midNames
    .map(
      (name) => `<label class="filter-chip${detailSelectedMidNames.has(name) ? " active" : ""}" data-mid="${name}">
        <input type="checkbox" ${detailSelectedMidNames.has(name) ? "checked" : ""} />${name}
      </label>`
    )
    .join("");
  el.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const name = chip.dataset.mid;
      if (detailSelectedMidNames.has(name)) detailSelectedMidNames.delete(name);
      else detailSelectedMidNames.add(name);
      renderDetailView();
    });
  });

  if (!detailFilterButtonsBound) {
    document.getElementById("detailFilterAll").addEventListener("click", () => {
      const all = [...new Set(Object.values(allCatMap).map((c) => c.mid_name).filter(Boolean))];
      detailSelectedMidNames = new Set(all);
      renderDetailView();
    });
    document.getElementById("detailFilterNone").addEventListener("click", () => {
      detailSelectedMidNames = new Set();
      renderDetailView();
    });
    detailFilterButtonsBound = true;
  }
}

function renderDetailDayList(day) {
  const label = document.getElementById("detailDayLabel");
  const listEl = document.getElementById("detailDayList");
  if (day == null) {
    label.textContent = "選一天看逐筆明細";
    listEl.innerHTML = "";
    return;
  }
  const dateStr = `${detailYear}-${String(detailMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  label.textContent = `${detailYear}/${detailMonth}/${day} 逐筆明細`;
  const dayTxns = allTxns
    .filter((t) => {
      if (t.date !== dateStr) return false;
      const info = allCatMap[t.category_id];
      return info && detailSelectedMidNames.has(info.mid_name);
    })
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  if (!dayTxns.length) {
    listEl.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">這天沒有符合勾選分類的紀錄</span></div>';
    return;
  }
  listEl.innerHTML = dayTxns
    .map((t) => {
      const info = allCatMap[t.category_id] || { item_name: "未分類" };
      const sign = t.type === "income" ? "+" : "-";
      const pendingTag = t.is_pending ? "（待銷帳）" : "";
      const rowHtml = `<button type="button" class="detail-tx-row" data-id="${t.id}">
        <span class="flow-tx-note">${info.item_name}${pendingTag}｜${t.note || ""}</span>
        <span class="flow-tx-amount">${sign}${fmt(Math.abs(t.amount))}</span>
      </button>`;
      return rowHtml + (String(t.id) === String(detailEditingId) ? renderDetailEditForm(t) : "");
    })
    .join("");

  listEl.querySelectorAll(".detail-tx-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      detailEditingId = String(detailEditingId) === btn.dataset.id ? null : btn.dataset.id;
      renderDetailDayList(day);
    });
  });

  if (detailEditingId) wireDetailEditForm(day);
}

function renderDetailEditForm(t) {
  const catOptions = allCategories
    .filter((c) => c.type === t.type)
    .map((c) => `<option value="${c.id}"${c.id === t.category_id ? " selected" : ""}>${c.mid_name}｜${c.item_name}</option>`)
    .join("");
  const noteVal = (t.note || "").replace(/"/g, "&quot;");
  return `<div class="detail-edit-form entry-form">
    <label>日期<input type="date" class="edit-date" value="${t.date}" /></label>
    <label>金額<input type="number" class="edit-amount" value="${t.amount}" step="1" inputmode="decimal" /></label>
    <label>類型
      <select class="edit-type">
        <option value="expense"${t.type === "expense" ? " selected" : ""}>支出</option>
        <option value="income"${t.type === "income" ? " selected" : ""}>收入</option>
      </select>
    </label>
    <label>分類<select class="edit-category">${catOptions}</select></label>
    <label>備註<input type="text" class="edit-note" value="${noteVal}" /></label>
    <label class="checkbox-label"><input type="checkbox" class="edit-pending"${t.is_pending ? " checked" : ""} />待銷帳</label>
    <div style="display:flex;gap:8px;">
      <button type="button" class="edit-save" data-id="${t.id}" style="flex:1;">儲存</button>
      <button type="button" class="edit-cancel" style="flex:1;background:var(--card);color:var(--ink);border:1px solid var(--border);">取消</button>
    </div>
    <p class="edit-status entry-message hidden"></p>
  </div>`;
}

function wireDetailEditForm(day) {
  const form = document.querySelector(".detail-edit-form");
  if (!form) return;
  const typeSelect = form.querySelector(".edit-type");
  const catSelect = form.querySelector(".edit-category");

  typeSelect.addEventListener("change", () => {
    catSelect.innerHTML = allCategories
      .filter((c) => c.type === typeSelect.value)
      .map((c) => `<option value="${c.id}">${c.mid_name}｜${c.item_name}</option>`)
      .join("");
  });

  form.querySelector(".edit-cancel").addEventListener("click", () => {
    detailEditingId = null;
    renderDetailDayList(day);
  });

  form.querySelector(".edit-save").addEventListener("click", async () => {
    const saveBtn = form.querySelector(".edit-save");
    const id = saveBtn.dataset.id;
    const statusEl = form.querySelector(".edit-status");
    const updates = {
      date: form.querySelector(".edit-date").value,
      amount: Number(form.querySelector(".edit-amount").value),
      type: typeSelect.value,
      category_id: Number(catSelect.value),
      note: form.querySelector(".edit-note").value.trim() || null,
      is_pending: form.querySelector(".edit-pending").checked,
    };
    saveBtn.disabled = true;
    statusEl.classList.remove("hidden");
    statusEl.className = "edit-status entry-message";
    statusEl.textContent = "儲存中...";
    const { error } = await sb.from("transactions").update(updates).eq("id", id);
    saveBtn.disabled = false;
    if (error) {
      statusEl.textContent = "儲存失敗：" + error.message;
      statusEl.className = "edit-status entry-message error";
      return;
    }
    const t = allTxns.find((x) => String(x.id) === String(id));
    if (t) Object.assign(t, updates);
    detailEditingId = null;
    renderDetailView();
  });
}

function renderDetailView() {
  const monthLabel = document.getElementById("detailMonthLabel");
  const weekdaysEl = document.getElementById("calendarWeekdays");
  const gridEl = document.getElementById("calendarGrid");
  const legendEl = document.getElementById("detailHeatLegend");
  if (!gridEl) return;

  renderDetailFilters();

  monthLabel.textContent = `${detailYear}/${detailMonth}`;
  weekdaysEl.innerHTML = WEEKDAY_LABELS.map((w) => `<div class="calendar-weekday">${w}</div>`).join("");

  const daysInMonth = new Date(detailYear, detailMonth, 0).getDate();
  const firstWeekday = new Date(detailYear, detailMonth - 1, 1).getDay();

  const dayHeat = {}; // day -> 勾選中分類的金額合計
  const dayHasTxn = new Set();
  allTxns.forEach((t) => {
    if (t.is_pending) return;
    const y = parseInt(t.date.slice(0, 4), 10);
    const m = parseInt(t.date.slice(5, 7), 10);
    const d = parseInt(t.date.slice(8, 10), 10);
    if (y !== detailYear || m !== detailMonth) return;
    const info = allCatMap[t.category_id];
    if (info && detailSelectedMidNames.has(info.mid_name)) {
      dayHasTxn.add(d);
      dayHeat[d] = (dayHeat[d] || 0) + Math.abs(Number(t.amount));
    }
  });
  const maxHeat = Math.max(0, ...Object.values(dayHeat));
  legendEl.textContent = maxHeat ? `本月單日最高 ${fmt(maxHeat)}` : "";

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push('<div class="calendar-day empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const heat = dayHeat[d] || 0;
    const ratio = maxHeat ? heat / maxHeat : 0;
    const classes = ["calendar-day"];
    if (dayHasTxn.has(d)) classes.push("has-txn");
    if (d === detailSelectedDay) classes.push("selected");
    cells.push(
      `<div class="${classes.join(" ")}" data-day="${d}" style="background:${heatColor(ratio)};">${d}</div>`
    );
  }
  gridEl.innerHTML = cells.join("");

  gridEl.querySelectorAll(".calendar-day[data-day]").forEach((cell) => {
    cell.addEventListener("click", () => {
      const day = Number(cell.dataset.day);
      detailSelectedDay = detailSelectedDay === day ? null : day;
      renderDetailView();
    });
  });

  renderDetailDayList(detailSelectedDay);
}

document.getElementById("detailPrevMonth").addEventListener("click", () => {
  detailMonth -= 1;
  if (detailMonth < 1) { detailMonth = 12; detailYear -= 1; }
  detailSelectedDay = null;
  renderDetailView();
});

document.getElementById("detailNextMonth").addEventListener("click", () => {
  detailMonth += 1;
  if (detailMonth > 12) { detailMonth = 1; detailYear += 1; }
  detailSelectedDay = null;
  renderDetailView();
});

document.getElementById("cashflowRangeToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented-btn");
  if (!btn || !allTxns.length) return;
  cashflowRange = btn.dataset.range;
  renderCashflowView();
});

// ---------- 長期目標 ----------
function renderGoals(goals) {
  if (!goals) return;
  document.getElementById("goalCurrentAsset").textContent = fmt(goals.currentAsset);
  document.getElementById("goalFireTarget").textContent = "目標 " + fmt(goals.fireTarget);
  const pct = goals.fireTarget ? Math.min(100, (goals.currentAsset / goals.fireTarget) * 100) : 0;
  document.getElementById("fireProgressBar").style.width = pct.toFixed(1) + "%";
  document.getElementById("fireProgressNote").textContent =
    (goals.currentAge != null && goals.retireAge != null
      ? `目前進度 ${pct.toFixed(1)}%（${goals.currentAge}歲 → ${goals.retireAge}歲）`
      : `目前進度 ${pct.toFixed(1)}%`) +
    (goals.fireProjection ? `，預估退休時可達 ${fmt(goals.fireProjection)}` : "");

  document.getElementById("goalHouseTarget").textContent = fmt(goals.houseTarget);
  document.getElementById("goalHouseNote").textContent =
    goals.housePrice ? `房價目標約 ${goals.housePrice}萬` : "";

  document.querySelectorAll("#fireMilestones .milestone-badge").forEach((b) => {
    b.classList.toggle("achieved", pct >= Number(b.dataset.milestone));
  });
}

// ---------- 連續正結餘 / 年度儲蓄達成率 ----------
function renderYearlyReview(trend, txns, goalsRow) {
  let streak = 0;
  for (let i = trend.length - 1; i >= 0; i--) {
    if (trend[i].income - trend[i].expense >= 0) streak++;
    else break;
  }
  document.getElementById("positiveStreakValue").textContent = streak + " 個月";
  document.getElementById("positiveStreakNote").textContent = streak > 0
    ? `最近連續 ${streak} 個月收入大於支出（含本月）`
    : "最近一個月是負結餘，還沒開始累積";

  const year = new Date().getFullYear();
  let income = 0;
  let expense = 0;
  txns.forEach((t) => {
    if (t.is_pending) return;
    if (parseInt(t.date.slice(0, 4), 10) !== year) return;
    if (t.type === "income") income += Number(t.amount);
    else expense += Number(t.amount);
  });
  const actualRatio = income ? ((income - expense) / income) * 100 : 0;
  const targetRatio = goalsRow && goalsRow.savings_invest_pct_target != null
    ? Number(goalsRow.savings_invest_pct_target) * 100
    : null;
  document.getElementById("savingsRateActual").textContent = actualRatio.toFixed(1) + "%";
  document.getElementById("savingsRateTarget").textContent =
    targetRatio != null ? "目標 " + targetRatio.toFixed(0) + "%" : "尚未設定目標";
  const pct = targetRatio ? Math.max(0, Math.min(100, (actualRatio / targetRatio) * 100)) : 0;
  document.getElementById("savingsRateBar").style.width = pct.toFixed(1) + "%";
  document.getElementById("savingsRateNote").textContent =
    `${year}年至今，收入 ${fmt(income)}，支出 ${fmt(expense)}`;
}

// ---------- 股票投入金額（stock_transactions，只算買進，不含賣出/除息） ----------
function renderStockInvested(stockTxns) {
  const el = document.getElementById("stockMonthInvested");
  const note = document.getElementById("stockYearInvestedNote");
  if (!el) return;
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  let monthTotal = 0;
  let yearTotal = 0;
  (stockTxns || []).filter((t) => t.side === "buy").forEach((t) => {
    const y = parseInt(t.trade_date.slice(0, 4), 10);
    const m = parseInt(t.trade_date.slice(5, 7), 10);
    const amount = Number(t.amount_twd || 0);
    if (y === year) {
      yearTotal += amount;
      if (m === month) monthTotal += amount;
    }
  });
  el.textContent = fmt(monthTotal);
  note.textContent = `${year}年累計投入 ${fmt(yearTotal)}`;
}

// ---------- 股票均價/損益（加權平均成本法，現金股利不影響成本，另外算總報酬） ----------
let stockPositions = {};
let latestBalanceByAccount = {};
let latestByAccountMonth = {}; // "y-m" -> { accountName: balanceRow }
let allStockTxns = [];
let allCategories = [];
let stockPrices = {}; // ticker -> { price, price_date }，抓不到 Apps Script 即時報價時的收盤價備援

// 股票市值備援順序：Apps Script 即時價 -> account_balances 手動記錄 -> stock_prices 昨日收盤價 × 股數
function fallbackMarketValue(code, shares) {
  if (latestBalanceByAccount[code]) return Number(latestBalanceByAccount[code].balance);
  const p = stockPrices[code];
  if (p && shares > 0) return Number(p.price) * shares;
  return null;
}
const DIVIDEND_CATEGORY_ID = 3; // category_map 裡「現金股利」固定是 id=3

function buildStockPositions(stockTxns, txns, catMap) {
  const positions = {};
  [...stockTxns]
    .filter((t) => t.side === "buy" || t.side === "sell")
    .sort((a, b) => (a.trade_date < b.trade_date ? -1 : a.trade_date > b.trade_date ? 1 : 0))
    .forEach((t) => {
      if (!positions[t.ticker]) {
        positions[t.ticker] = { market: t.market, name: t.stock_name, shares: 0, costBasis: 0, realizedGain: 0 };
      }
      const p = positions[t.ticker];
      const amt = Number(t.amount_twd || 0);
      const shares = Number(t.shares || 0);
      if (t.side === "buy") {
        p.shares += shares;
        p.costBasis += amt;
      } else {
        const avgCost = p.shares > 0 ? p.costBasis / p.shares : 0;
        const soldCost = avgCost * shares;
        p.realizedGain += amt - soldCost;
        p.shares -= shares;
        p.costBasis -= soldCost;
      }
    });

  // 累計現金股利：transactions 表「現金股利」分類，備註對到股票代號（不影響成本，只用來算含股利總報酬）
  const dividends = {};
  (txns || []).forEach((t) => {
    if (t.category_id !== DIVIDEND_CATEGORY_ID) return;
    const key = (t.note || "").trim().toUpperCase();
    if (!key) return;
    dividends[key] = (dividends[key] || 0) + Number(t.amount);
  });

  Object.keys(positions).forEach((ticker) => {
    positions[ticker].dividends = dividends[ticker.toUpperCase()] || 0;
  });

  return positions;
}

// ---------- 股票（現價維持原本的 Apps Script） ----------
async function loadStocks() {
  try {
    const res = await fetch(STOCKS_API_URL);
    const data = await res.json();
    renderStocks(data.stocks);
  } catch (err) {
    console.error("股票資料載入失敗", err);
  }
}

function parseStock(s) {
  const code = String(s.ticker || "");
  const name = String(s.name || "").replace(code, "").trim();
  return { ...s, code, name, isTW: /^\d/.test(code) };
}

// 把 Apps Script 抓到的現價資料，跟 stock_transactions 算出來的均價/成本/損益合併
function enrichWithPosition(stock) {
  const pos = stockPositions[stock.code];
  if (!pos) return stock;
  const avgCost = pos.shares > 0 ? pos.costBasis / pos.shares : null;
  const marketValue = stock.marketValue != null ? stock.marketValue : fallbackMarketValue(stock.code, pos.shares);
  const unrealizedGain = marketValue != null && pos.shares > 0 ? marketValue - pos.costBasis : null;
  const totalReturn = unrealizedGain != null ? unrealizedGain + pos.realizedGain + pos.dividends : null;
  return {
    ...stock,
    marketValue,
    avgCost,
    costBasis: pos.costBasis,
    realizedGain: pos.realizedGain,
    dividends: pos.dividends,
    unrealizedGain,
    totalReturn,
  };
}

function renderStockTable(container, stocks, total) {
  container.innerHTML = "";
  if (!stocks.length) {
    container.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料</span></div>';
    return;
  }
  const sorted = [...stocks].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  sorted.forEach((s) => {
    const pct = total && s.marketValue ? (s.marketValue / total) * 100 : 0;
    const sign = (n) => (n >= 0 ? "+" : "");
    let gainHtml = "";
    if (s.unrealizedGain != null) {
      const gainPct = s.costBasis ? (s.unrealizedGain / s.costBasis) * 100 : 0;
      const cls = s.unrealizedGain >= 0 ? "gain-pos" : "gain-neg";
      gainHtml = `<div class="stock-gain-row">
        <span class="${cls}">資本利得 ${sign(s.unrealizedGain)}${fmt(s.unrealizedGain)}（${sign(gainPct)}${gainPct.toFixed(1)}%）</span>
        ${s.dividends || s.realizedGain ? `<span class="gain-muted">含股利/已實現總報酬 ${sign(s.totalReturn)}${fmt(s.totalReturn)}</span>` : ""}
      </div>`;
    } else if (s.costBasis) {
      gainHtml = `<div class="stock-gain-row"><span class="gain-muted">成本 ${fmt(s.costBasis)} · 尚無市值資料</span></div>`;
    }
    const row = document.createElement("div");
    row.className = "stock-row";
    row.innerHTML = `
      <div class="stock-row-top">
        <span class="stock-code">${s.code}</span>
        <span class="stock-name">${s.name}</span>
        <span class="stock-value">${s.marketValue != null ? fmt(s.marketValue) : "尚無市值資料"}</span>
      </div>
      <div class="stock-row-meta">
        <span>${s.shares ? Number(s.shares).toLocaleString("zh-TW") + " 股" : ""}${s.avgCost != null ? " · 均價 " + s.avgCost.toFixed(2) : ""}</span>
        <span>${s.marketValue != null ? pct.toFixed(1) + "%" : ""}</span>
      </div>
      <div class="flow-bar-track"><div class="flow-bar-fill income" style="width:${pct}%"></div></div>
      ${gainHtml}
    `;
    container.appendChild(row);
  });
}

function renderStocks(stocks) {
  const twEl = document.getElementById("stockTableTW");
  const usEl = document.getElementById("stockTableUS");
  const summaryEl = document.getElementById("stocksSummary");

  const fromApi = (stocks || []).map(parseStock);
  const apiCodes = new Set(fromApi.map((s) => s.code));

  // stockPositions 裡有、但 Apps Script 沒回傳現價的（目前主要是美股），另外補一列進來
  const extra = Object.keys(stockPositions)
    .filter((ticker) => !apiCodes.has(ticker) && stockPositions[ticker].shares > 0.0001)
    .map((ticker) => {
      const pos = stockPositions[ticker];
      const marketValue = fallbackMarketValue(ticker, pos.shares);
      return {
        ticker, code: ticker, name: pos.name || "", shares: pos.shares, price: null,
        marketValue, isTW: pos.market === "TW",
      };
    });

  const merged = fromApi.concat(extra).map(enrichWithPosition);

  if (!merged.length) {
    twEl.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料，請確認股票分頁已加入「現價」欄位</span></div>';
    usEl.innerHTML = "";
    summaryEl.textContent = "";
    return;
  }

  const withValue = merged.filter((s) => s.marketValue != null);
  const total = withValue.reduce((sum, s) => sum + s.marketValue, 0);
  const totalUnrealized = merged.reduce((sum, s) => sum + (s.unrealizedGain || 0), 0);
  const totalRealized = merged.reduce((sum, s) => sum + (s.realizedGain || 0), 0);

  assetCompositionStockTotals = {
    tw: withValue.filter((s) => s.isTW).reduce((sum, s) => sum + s.marketValue, 0),
    us: withValue.filter((s) => !s.isTW).reduce((sum, s) => sum + s.marketValue, 0),
  };
  renderAssetComposition();

  if (withValue.length) {
    renderChart("stocks", "chartStocks", {
      type: "doughnut",
      data: {
        labels: withValue.map((s) => s.code),
        datasets: [{ data: withValue.map((s) => s.marketValue), backgroundColor: PIE_COLORS, borderWidth: 2, borderColor: "#fff" }],
      },
      options: {
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: COLOR_MUTED } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.raw)}` } },
        },
      },
    });
  }
  const sign = (n) => (n >= 0 ? "+" : "");
  summaryEl.textContent =
    `總市值 ${fmt(total)} ｜ 未實現損益 ${sign(totalUnrealized)}${fmt(totalUnrealized)}` +
    (totalRealized ? ` ｜ 已實現損益 ${sign(totalRealized)}${fmt(totalRealized)}` : "");

  renderStockTable(twEl, merged.filter((s) => s.isTW), total);
  renderStockTable(usEl, merged.filter((s) => !s.isTW), total);
}

// ===========================================================
// 輸入：新增資產快照（account_balances）
// ===========================================================
const balanceDateInput = document.getElementById("balDate");
if (balanceDateInput) balanceDateInput.value = new Date().toISOString().slice(0, 10);

const recentBalances = [];
function renderRecentBalances() {
  const el = document.getElementById("balanceRecent");
  if (!recentBalances.length) {
    el.innerHTML = `<div class="flow-item-top"><span class="flow-item-name">尚未新增任何紀錄</span></div>`;
    return;
  }
  el.innerHTML = recentBalances
    .map(
      (b) => `<div class="flow-item">
        <div class="flow-item-top">
          <span class="flow-item-name">${b.account_name}（${b.date}）</span>
          <span class="flow-item-value">${fmt(b.balance)}</span>
        </div>
      </div>`
    )
    .join("");
}

// ---------- 外幣帳戶：即時匯率換算 ----------
let lastUsdRate = null;

function recomputeForeignAmount() {
  const usd = Number(document.getElementById("balUsdAmount").value);
  if (lastUsdRate && usd) {
    document.getElementById("balAmount").value = Math.round(usd * lastUsdRate);
  }
}

const balIsForeign = document.getElementById("balIsForeign");
if (balIsForeign) {
  balIsForeign.addEventListener("change", () => {
    const on = balIsForeign.checked;
    document.getElementById("foreignFields").classList.toggle("hidden", !on);
    const amountInput = document.getElementById("balAmount");
    const amountLabel = document.getElementById("balAmountLabel");
    amountInput.readOnly = on;
    amountLabel.firstChild.textContent = on ? "台幣等值（自動計算）" : "餘額";
    if (!on) {
      lastUsdRate = null;
      document.getElementById("rateDisplay").textContent = "";
      document.getElementById("balUsdAmount").value = "";
    }
  });

  document.getElementById("balUsdAmount").addEventListener("input", recomputeForeignAmount);

  document.getElementById("fetchRateBtn").addEventListener("click", async () => {
    const btn = document.getElementById("fetchRateBtn");
    const display = document.getElementById("rateDisplay");
    btn.disabled = true;
    btn.textContent = "抓取中...";
    try {
      const res = await fetch("https://open.er-api.com/v6/latest/USD");
      const data = await res.json();
      lastUsdRate = data.rates && data.rates.TWD;
      if (lastUsdRate) {
        display.textContent = `1 美金 ≈ ${lastUsdRate.toFixed(3)} 台幣`;
        recomputeForeignAmount();
      } else {
        display.textContent = "抓取失敗，請手動輸入台幣等值";
      }
    } catch (err) {
      display.textContent = "抓取失敗，請手動輸入台幣等值";
    }
    btn.disabled = false;
    btn.textContent = "抓即時匯率";
  });
}

const balanceForm = document.getElementById("balanceForm");
if (balanceForm) {
  balanceForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const accountName = document.getElementById("balAccountName").value.trim();
    const accountType = document.getElementById("balAccountType").value;
    const amount = document.getElementById("balAmount").value;
    const date = document.getElementById("balDate").value;
    const isForeign = balIsForeign && balIsForeign.checked;
    const usdAmount = document.getElementById("balUsdAmount").value;
    let note = document.getElementById("balNote").value.trim();
    if (isForeign && usdAmount) {
      const rateNote = `美金 ${usdAmount} × 匯率 ${lastUsdRate ? lastUsdRate.toFixed(3) : "?"}`;
      note = note ? `${rateNote}；${note}` : rateNote;
    }
    const btn = document.getElementById("balSubmit");
    const msgEl = document.getElementById("balMessage");

    btn.disabled = true;
    btn.textContent = "新增中...";
    msgEl.classList.add("hidden");

    const { error } = await sb.from("account_balances").insert({
      account_name: accountName,
      account_type: accountType,
      balance: Number(amount),
      recorded_at: date,
      note: note || null,
    });

    btn.disabled = false;
    btn.textContent = "新增";

    if (error) {
      msgEl.textContent = "新增失敗：" + error.message;
      msgEl.className = "entry-message error";
    } else {
      msgEl.textContent = "已新增";
      msgEl.className = "entry-message success";
      recentBalances.unshift({ account_name: accountName, balance: Number(amount), date });
      renderRecentBalances();
      document.getElementById("balAmount").value = "";
      document.getElementById("balNote").value = "";
      document.getElementById("balUsdAmount").value = "";
    }
    msgEl.classList.remove("hidden");
  });
  renderRecentBalances();
}

// ===========================================================
// 輸入：證券對帳單 CSV 匯入（國泰證券格式，台股/美股皆支援）
// ===========================================================
// 台股對帳單只有中文股名，沒有代碼；證交所/櫃買中心的 API 沒開放瀏覽器跨網域存取，
// 所以改查 Supabase 的 tw_ticker_names（GitHub Actions 每天從證交所/櫃買中心同步一次）
async function resolveTickerNames(names) {
  const uniqueNames = [...new Set(names)];
  if (!uniqueNames.length) return {};
  const { data, error } = await sb.from("tw_ticker_names").select("name,ticker").in("name", uniqueNames);
  if (error) {
    console.error("股票代碼對照表查詢失敗", error);
    return {};
  }
  const map = {};
  (data || []).forEach((r) => { map[r.name] = r.ticker; });
  return map;
}

async function fetchUsdTwdRateForImport() {
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD");
    const data = await res.json();
    return data.rates && data.rates.TWD;
  } catch (err) {
    return null;
  }
}

// 簡易 CSV parser：處理帶引號、引號內有逗號的欄位（例如 "-3,988"）
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseNum(s) {
  if (s == null) return 0;
  return parseFloat(String(s).replace(/,/g, "")) || 0;
}

function slashDateToIso(s) {
  const parts = String(s).trim().split("/");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

async function parseStatementCsv(text) {
  const rows = parseCsvRows(text).filter((r) => r.some((c) => c.trim() !== ""));
  const headerIdx = rows.findIndex((r) => r[0] === "股名" || r[0] === "代號");
  if (headerIdx === -1) return { format: null, results: [] };
  const isTW = rows[headerIdx][0] === "股名";
  const dataRows = rows.slice(headerIdx + 1);
  const results = [];

  if (isTW) {
    // 股名,日期,成交股數,淨收付金額,買賣別,成交價,成本,手續費,交易稅,...,委託書號
    const names = dataRows.map((r) => r[0] && r[0].trim()).filter(Boolean);
    const nameMap = await resolveTickerNames(names);
    dataRows.forEach((r) => {
      const [stockName, dateStr, sharesStr, netAmountStr, sideStr, priceStr, costStr, feeStr, taxStr, , , , , , orderNo] = r;
      if (!stockName) return;
      const ticker = nameMap[stockName.trim()] || null;
      const side = sideStr === "現買" ? "buy" : sideStr === "現賣" ? "sell" : null;
      results.push({
        ticker, stock_name: stockName.trim(), market: "TW", currency: "TWD",
        trade_date: slashDateToIso(dateStr), side,
        shares: parseNum(sharesStr), price: parseNum(priceStr),
        amount_original: parseNum(costStr), amount_twd: Math.abs(parseNum(netAmountStr)),
        fee: parseNum(feeStr), tax: parseNum(taxStr),
        note: orderNo ? orderNo.trim() : null,
        _rawSide: sideStr,
        _skipReason: !ticker ? "找不到股票代碼" : !side ? `無法辨識買賣別：${sideStr}` : null,
      });
    });
  } else {
    // 代號,股票名稱,交易日期,買賣別,股數,交割日期,市場,幣別,成交價,成交金額,手續費,其他費用,原幣應收付
    const rate = await fetchUsdTwdRateForImport();
    dataRows.forEach((r) => {
      const [ticker, stockName, dateStr, sideStr, sharesStr, , , currency, priceStr, amountOriginalStr, feeStr, otherFeeStr, netAmountStr] = r;
      if (!ticker) return;
      const side = sideStr === "買進" ? "buy" : sideStr === "賣出" ? "sell" : null;
      results.push({
        ticker: ticker.trim(), stock_name: (stockName || "").trim(), market: "US", currency: currency || "USD",
        trade_date: slashDateToIso(dateStr), side,
        shares: parseNum(sharesStr), price: parseNum(priceStr),
        amount_original: parseNum(amountOriginalStr),
        amount_twd: rate ? Math.round(Math.abs(parseNum(netAmountStr)) * rate) : null,
        fee: parseNum(feeStr) + parseNum(otherFeeStr), tax: 0,
        note: null,
        _rawSide: sideStr,
        _skipReason: !side ? `非交易事件，略過：${sideStr}` : !rate ? "匯率抓取失敗" : null,
      });
    });
  }

  // 重複偵測：跟目前已存在的 stock_transactions 比對代碼+日期+股數+買賣別
  results.forEach((r) => {
    if (r._skipReason) return;
    const dup = allStockTxns.some(
      (t) => t.ticker === r.ticker && t.trade_date === r.trade_date &&
        Math.abs(Number(t.shares) - r.shares) < 0.0001 && t.side === r.side
    );
    if (dup) r._skipReason = "已存在，略過";
  });

  return { format: isTW ? "TW" : "US", results };
}

let stockCsvParsedRows = [];

const stockCsvFileInput = document.getElementById("stockCsvFile");
if (stockCsvFileInput) {
  stockCsvFileInput.addEventListener("change", async () => {
    const file = stockCsvFileInput.files[0];
    if (!file) return;
    const statusEl = document.getElementById("stockCsvStatus");
    const previewEl = document.getElementById("stockCsvPreview");
    const confirmBtn = document.getElementById("stockCsvConfirm");
    statusEl.textContent = "解析中...";
    confirmBtn.classList.add("hidden");
    previewEl.innerHTML = "";

    const text = await file.text();
    const { format, results } = await parseStatementCsv(text);
    stockCsvParsedRows = results;

    if (!format) {
      statusEl.textContent = "無法辨識檔案格式（找不到「股名」或「代號」欄位）";
      return;
    }

    const okCount = results.filter((r) => !r._skipReason).length;
    statusEl.textContent = `${format === "TW" ? "台股" : "美股"}對帳單，共 ${results.length} 筆，可匯入 ${okCount} 筆`;

    previewEl.innerHTML = results
      .map((r) => {
        const label = r._skipReason ? `⚠️ ${r._skipReason}` : `${r.ticker} ${r.stock_name}`;
        return `<div class="flow-tx-row"${r._skipReason ? ' style="opacity:0.55;"' : ""}>
          <span class="flow-tx-date">${r.trade_date ? r.trade_date.slice(5) : "?"}</span>
          <span class="flow-tx-note">${label}｜${r._rawSide || ""}｜${r.shares}股</span>
          <span class="flow-tx-amount">${r.amount_twd != null ? fmt(r.amount_twd) : "-"}</span>
        </div>`;
      })
      .join("");

    if (okCount > 0) confirmBtn.classList.remove("hidden");
    else confirmBtn.classList.add("hidden");
  });
}

const stockCsvConfirmBtn = document.getElementById("stockCsvConfirm");
if (stockCsvConfirmBtn) {
  stockCsvConfirmBtn.addEventListener("click", async () => {
    const statusEl = document.getElementById("stockCsvStatus");
    const toInsert = stockCsvParsedRows
      .filter((r) => !r._skipReason)
      .map((r) => ({
        ticker: r.ticker, stock_name: r.stock_name, market: r.market, trade_date: r.trade_date,
        side: r.side, shares: r.shares, price: r.price, currency: r.currency,
        amount_original: r.amount_original, amount_twd: r.amount_twd, fee: r.fee, tax: r.tax, note: r.note,
      }));
    stockCsvConfirmBtn.disabled = true;
    stockCsvConfirmBtn.textContent = "匯入中...";
    const { error } = await sb.from("stock_transactions").insert(toInsert);
    stockCsvConfirmBtn.disabled = false;
    stockCsvConfirmBtn.textContent = "確認匯入";
    if (error) {
      statusEl.textContent = "匯入失敗：" + error.message;
      return;
    }
    statusEl.textContent = `已匯入 ${toInsert.length} 筆`;
    stockCsvConfirmBtn.classList.add("hidden");
    allStockTxns = allStockTxns.concat(toInsert);
    document.getElementById("stockCsvPreview").innerHTML = "";
    document.getElementById("stockCsvFile").value = "";
  });
}

// ===========================================================
// 輸入：信用卡/銀行明細比對
// ===========================================================
const RECONCILE_DATE_TOLERANCE_DAYS = 3;

function rocDateToIsoLocal(rocDate) {
  // "115/08/12" -> "2026-08-12"
  const parts = String(rocDate).trim().split("/");
  if (parts.length !== 3) return null;
  const year = parseInt(parts[0], 10) + 1911;
  return `${year}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
}

function dateDiffDays(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00");
  const b = new Date(isoB + "T00:00:00");
  return Math.round((a - b) / 86400000);
}

// 聯邦銀行信用卡對帳單：前幾列是帳單摘要，接著是逐筆消費明細，
// 中間穿插「上期金額」「卡片名稱」這類非交易列（這些列的入帳日/消費日都是空的，用來排除）
function parseUnionBankStatement(rows) {
  // 找「帳單結帳日」摘要列，抓年份基準（消費日只有 MM/DD，沒有年份）
  let statementYear = null;
  let statementMonth = null;
  for (let i = 0; i < rows.length - 1; i++) {
    const col = rows[i].findIndex((c) => String(c).trim() === "帳單結帳日");
    if (col !== -1) {
      const iso = rocDateToIsoLocal(rows[i + 1][col]);
      if (iso) { statementYear = parseInt(iso.slice(0, 4), 10); statementMonth = parseInt(iso.slice(5, 7), 10); }
      break;
    }
  }
  if (!statementYear) return { format: null, results: [] };

  const headerIdx = rows.findIndex((r) => r.includes("入帳日") && r.includes("消費日") && r.includes("消費明細"));
  if (headerIdx === -1) return { format: null, results: [] };
  const header = rows[headerIdx];
  const postedCol = header.indexOf("入帳日");
  const spendCol = header.indexOf("消費日");
  const noteCol = header.indexOf("消費明細");
  const twdCol = header.indexOf("新臺幣金額");

  const results = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const posted = r[postedCol];
    const spend = r[spendCol];
    if (!posted || !spend) continue; // 非交易列（摘要/卡片標題），跳過
    const [mm, dd] = String(spend).trim().split("/");
    if (!mm || !dd) continue;
    let year = statementYear;
    if (parseInt(mm, 10) > statementMonth) year -= 1; // 跨年時，帳單月之後的月份代表是去年
    const date = `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const amount = parseNum(r[twdCol]);
    if (!amount) continue;
    results.push({ date, amount, note: (r[noteCol] || "").toString().trim() });
  }
  return { format: "聯邦銀行", results };
}

function matchReconcileRow(row) {
  const candidates = allTxns.filter((t) => {
    if (Math.abs(Math.abs(Number(t.amount)) - Math.abs(row.amount)) > 0.5) return false;
    return Math.abs(dateDiffDays(t.date, row.date)) <= RECONCILE_DATE_TOLERANCE_DAYS;
  });
  return candidates;
}

const reconcileFileInput = document.getElementById("reconcileFile");
if (reconcileFileInput) {
  reconcileFileInput.addEventListener("change", async () => {
    const file = reconcileFileInput.files[0];
    if (!file) return;
    const statusEl = document.getElementById("reconcileStatus");
    const resultEl = document.getElementById("reconcileResult");
    statusEl.textContent = "解析中...";
    resultEl.innerHTML = "";

    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    const { format, results } = parseUnionBankStatement(rows);
    if (!format) {
      statusEl.textContent = "無法辨識這份對帳單的格式（目前只支援聯邦銀行），麻煩提供這張卡的範例讓我加解析規則";
      return;
    }

    const missing = [];
    const ambiguous = [];
    let matchedCount = 0;
    results.forEach((row) => {
      const candidates = matchReconcileRow(row);
      if (candidates.length === 0) missing.push(row);
      else if (candidates.length > 1) ambiguous.push(row);
      else matchedCount++;
    });

    statusEl.textContent = `${format}，共 ${results.length} 筆：已比對到 ${matchedCount} 筆，可能漏記 ${missing.length} 筆，不確定 ${ambiguous.length} 筆`;

    const renderRow = (row) => `<div class="flow-tx-row">
      <span class="flow-tx-date">${row.date.slice(5)}</span>
      <span class="flow-tx-note">${row.note}</span>
      <span class="flow-tx-amount">${fmt(Math.abs(row.amount))}</span>
    </div>`;

    let html = "";
    if (missing.length) {
      html += `<div class="card-title" style="margin-top:14px;">⚠️ 明細有、可能沒記到（${missing.length}）</div>` + missing.map(renderRow).join("");
    }
    if (ambiguous.length) {
      html += `<div class="card-title" style="margin-top:14px;">❓ 不確定，麻煩自己確認（${ambiguous.length}）</div>` + ambiguous.map(renderRow).join("");
    }
    if (!missing.length && !ambiguous.length) {
      html += '<div class="flow-item-top" style="margin-top:14px;"><span class="flow-item-name">全部都比對到了</span></div>';
    }
    resultEl.innerHTML = html;
  });
}

initAuth();
