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
    ]);
    if (catErr) throw catErr;
    if (snapErr) throw snapErr;
    if (balErr) throw balErr;
    if (txnErr) throw txnErr;
    if (goalsErr) throw goalsErr;
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
        <div class="pending-group-header"><span>${key || "未分組"}</span><span>${netLabel}</span></div>
        ${rowsHtml}
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
  const PENDING_NET_CATEGORY_ID = 41; // 代墊
  const net = pendingNetDiff(pending);
  if (net !== 0) {
    const repDate = cashflowRange === "month"
      ? `${cashflowYear}-${String(cashflowMonth).padStart(2, "0")}-01`
      : `${cashflowYear}-01-01`;
    const synthetic = {
      date: repDate,
      amount: Math.abs(net),
      category_id: PENDING_NET_CATEGORY_ID,
      note: net > 0 ? "待銷帳淨額（多收）" : "待銷帳淨額（多付）",
    };
    (net > 0 ? income : expense).push(synthetic);
  }

  renderCashflow({
    income: buildFlowHierarchy(income, allCatMap),
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
  const marketValue = stock.marketValue != null
    ? stock.marketValue
    : (latestBalanceByAccount[stock.code] ? Number(latestBalanceByAccount[stock.code].balance) : null);
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
      const marketValue = latestBalanceByAccount[ticker] ? Number(latestBalanceByAccount[ticker].balance) : null;
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

initAuth();
