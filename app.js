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
    ] = await Promise.all([
      sb.from("category_map").select("id,item_name,mid_name,type"),
      sb.from("asset_snapshots").select("year,month,cash_and_deposits,other_investments,stock_market_value").order("year").order("month"),
      sb.from("account_balances").select("account_name,account_type,balance,recorded_at").order("recorded_at"),
      sb.from("transactions").select("date,amount,type,category_id,note").limit(5000),
      sb.from("goals_assumptions").select("*").limit(1),
      sb.from("stock_transactions").select("trade_date,side,amount_twd").eq("side", "buy").limit(5000),
    ]);
    if (catErr) throw catErr;
    if (snapErr) throw snapErr;
    if (balErr) throw balErr;
    if (txnErr) throw txnErr;
    if (goalsErr) throw goalsErr;
    if (stockTxnErr) throw stockTxnErr;

    const catMap = {};
    (categories || []).forEach((c) => { catMap[c.id] = { item_name: c.item_name, mid_name: c.mid_name || "未分類" }; });

    // 依年/月彙總每個月的收入、支出
    const monthly = {};
    (txns || []).forEach((t) => {
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
    const latestByAccountMonth = {}; // "y-m" -> { accountName: balanceRow }
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

    if (trend.length) {
      renderGoals(buildGoals(goalsRows && goalsRows[0], trend));
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
        }
      },
    },
  });
  const note = document.getElementById("assetHoverNote");
  const resetNote = () => {
    const latest = trend[trend.length - 1];
    note.textContent = `${latest.year}/${latest.month}：${fmt(seriesValue(latest, assetSeries))}`;
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

// ---------- 現金流：月/年 切換 ----------
let allTxns = [];
let allCatMap = {};
let cashflowYear = null;
let cashflowMonth = null;
let cashflowRange = "month"; // month | year
let earliestTxnKey = null;
let latestTxnKey = null;
let earliestTxnYear = null;
let latestTxnYear = null;

function renderCashflowView() {
  const income = [];
  const expense = [];
  allTxns.forEach((t) => {
    const y = parseInt(t.date.slice(0, 4), 10);
    const m = parseInt(t.date.slice(5, 7), 10);
    if (y !== cashflowYear) return;
    if (cashflowRange === "month" && m !== cashflowMonth) return;
    (t.type === "income" ? income : expense).push(t);
  });
  renderCashflow({
    income: buildFlowHierarchy(income, allCatMap),
    expense: buildFlowHierarchy(expense, allCatMap),
  });

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
  (stockTxns || []).forEach((t) => {
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

// ---------- 股票（維持原本的 Apps Script） ----------
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

function renderStockTable(container, stocks, total) {
  container.innerHTML = "";
  if (!stocks.length) {
    container.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料</span></div>';
    return;
  }
  const sorted = [...stocks].sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));
  sorted.forEach((s) => {
    const pct = total && s.marketValue ? (s.marketValue / total) * 100 : 0;
    const row = document.createElement("div");
    row.className = "stock-row";
    row.innerHTML = `
      <div class="stock-row-top">
        <span class="stock-code">${s.code}</span>
        <span class="stock-name">${s.name}</span>
        <span class="stock-value">${s.marketValue != null ? fmt(s.marketValue) : "價格無法取得"}</span>
      </div>
      <div class="stock-row-meta">
        <span>${s.shares ? s.shares.toLocaleString("zh-TW") + " 股" : ""}${s.price && typeof s.price === "number" ? " · 現價 " + s.price : ""}</span>
        <span>${s.marketValue != null ? pct.toFixed(1) + "%" : ""}</span>
      </div>
      <div class="flow-bar-track"><div class="flow-bar-fill income" style="width:${pct}%"></div></div>
    `;
    container.appendChild(row);
  });
}

function renderStocks(stocks) {
  const twEl = document.getElementById("stockTableTW");
  const usEl = document.getElementById("stockTableUS");
  const summaryEl = document.getElementById("stocksSummary");
  if (!stocks || !stocks.length) {
    twEl.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料，請確認股票分頁已加入「現價」欄位</span></div>';
    usEl.innerHTML = "";
    summaryEl.textContent = "";
    return;
  }
  const parsed = stocks.map(parseStock);
  const withValue = parsed.filter((s) => s.marketValue != null);
  const total = withValue.reduce((sum, s) => sum + s.marketValue, 0);

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
  summaryEl.textContent = "總市值 " + fmt(total);

  renderStockTable(twEl, parsed.filter((s) => s.isTW), total);
  renderStockTable(usEl, parsed.filter((s) => !s.isTW), total);
}

initAuth();
