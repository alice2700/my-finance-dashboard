// ===========================================================
// 設定區
// ===========================================================
const SUPABASE_URL = "https://xckrpkphbnvqvpkdaewu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jHKg1gM4WWf28V0Owv2iQw_v0Gn8oXy";

// 股票分頁維持原本的 Apps Script（不搬進 Supabase）
const STOCKS_API_URL = "https://script.google.com/macros/s/AKfycbzNzx2T_0aRYMC61SyBRqzQHbFLDvd9TlJnWYrmJAWNd0pp4qE7-zwSIzLQPbBD6vD1/exec";

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
    ] = await Promise.all([
      sb.from("category_map").select("id,item_name,type"),
      sb.from("asset_snapshots").select("year,month,cash_and_deposits,other_investments,stock_market_value").order("year").order("month"),
      sb.from("account_balances").select("account_name,account_type,balance,recorded_at").order("recorded_at"),
      sb.from("transactions").select("date,amount,type,category_id").limit(5000),
      sb.from("goals_assumptions").select("*").limit(1),
    ]);
    if (catErr) throw catErr;
    if (snapErr) throw snapErr;
    if (balErr) throw balErr;
    if (txnErr) throw txnErr;
    if (goalsErr) throw goalsErr;

    const catMap = {};
    (categories || []).forEach((c) => { catMap[c.id] = c.item_name; });

    // 依年/月彙總每個月的收入、支出
    const monthly = {};
    (txns || []).forEach((t) => {
      const y = parseInt(t.date.slice(0, 4), 10);
      const m = parseInt(t.date.slice(5, 7), 10);
      const key = y + "-" + m;
      if (!monthly[key]) monthly[key] = { income: 0, expense: 0 };
      monthly[key][t.type] += Number(t.amount);
    });

    // trend：舊資料讀 asset_snapshots（一整包在 cash，尚未拆分），
    // 之後有記錄的月份改讀 account_balances（依帳戶 account_type 拆成現金/股票兩類）
    const snapshotMonths = new Set();
    const fromSnapshots = (snapshots || []).map((s) => {
      snapshotMonths.add(s.year + "-" + s.month);
      const key = s.year + "-" + s.month;
      const mo = monthly[key] || { income: 0, expense: 0 };
      const cashPart = Number(s.cash_and_deposits || 0) + Number(s.other_investments || 0);
      const stockPart = Number(s.stock_market_value || 0);
      return {
        year: s.year,
        month: s.month,
        label: String(s.year).slice(2) + "/" + s.month,
        asset: cashPart + stockPart,
        cashPart,
        stockPart,
        income: mo.income,
        expense: mo.expense,
      };
    });

    // 每個帳戶在每個月取「當月最新一筆」餘額
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
        let cashPart = 0;
        let stockPart = 0;
        Object.values(latestByAccountMonth[key]).forEach((b) => {
          if (b.account_type === "stock") stockPart += Number(b.balance);
          else cashPart += Number(b.balance);
        });
        const mo = monthly[key] || { income: 0, expense: 0 };
        return {
          year: y,
          month: m,
          label: String(y).slice(2) + "/" + m,
          asset: cashPart + stockPart,
          cashPart,
          stockPart,
          income: mo.income,
          expense: mo.expense,
        };
      });

    const trend = fromSnapshots.concat(fromBalances).sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));

    renderOverview(trend);

    if (trend.length) {
      const latest = trend[trend.length - 1];
      const income = {};
      const expense = {};
      (txns || []).forEach((t) => {
        const y = parseInt(t.date.slice(0, 4), 10);
        const m = parseInt(t.date.slice(5, 7), 10);
        if (y !== latest.year || m !== latest.month) return;
        const name = catMap[t.category_id] || "未分類";
        const bucket = t.type === "income" ? income : expense;
        bucket[name] = (bucket[name] || 0) + Number(t.amount);
      });
      renderCashflow({
        income: Object.keys(income).map((name) => ({ name, value: income[name] })),
        expense: Object.keys(expense).map((name) => ({ name, value: expense[name] })),
      });

      const monthTag = latest.year + "/" + latest.month;
      document.getElementById("labelIncomeFlow").textContent = monthTag + " 收入來源";
      document.getElementById("labelExpenseFlow").textContent = monthTag + " 支出去向";

      renderGoals(buildGoals(goalsRows && goalsRows[0], trend));
    }

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
  const savings = latest.income - latest.expense;
  const marketPart = assetChange - savings;
  const sign = (n) => (n >= 0 ? "+" : "");
  note.innerHTML = `
    <div class="market-note-row market-note-title">${latest.year}/${latest.month} 資產變化 ${sign(assetChange)}${fmt(assetChange)}</div>
    <div class="market-note-row"><span>存下的錢</span><span>${sign(savings)}${fmt(savings)}</span></div>
    <div class="market-note-row"><span>其餘（市場漲跌等）</span><span>${sign(marketPart)}${fmt(marketPart)}</span></div>
  `;
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
function renderFlowList(container, items, kind) {
  container.innerHTML = "";
  if (!items || !items.length) {
    container.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料</span></div>';
    return;
  }
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const max = sorted[0].value;
  sorted.forEach((item) => {
    const row = document.createElement("div");
    row.className = "flow-item";
    row.innerHTML = `
      <div class="flow-item-top">
        <span class="flow-item-name">${item.name}</span>
        <span class="flow-item-value">${fmt(item.value)}</span>
      </div>
      <div class="flow-bar-track">
        <div class="flow-bar-fill ${kind}" style="width:${max ? (item.value / max) * 100 : 0}%"></div>
      </div>`;
    container.appendChild(row);
  });
}

function renderCashflow(breakdown) {
  if (!breakdown) return;
  renderFlowList(document.getElementById("incomeFlow"), breakdown.income, "income");
  renderFlowList(document.getElementById("expenseFlow"), breakdown.expense, "expense");
}

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

function renderStocks(stocks) {
  const listEl = document.getElementById("stockList");
  if (!stocks || !stocks.length) {
    listEl.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料，請確認股票分頁已加入「現價」欄位</span></div>';
    return;
  }
  const withValue = stocks.filter((s) => s.marketValue);
  if (withValue.length) {
    renderChart("stocks", "chartStocks", {
      type: "doughnut",
      data: {
        labels: withValue.map((s) => s.ticker),
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
  const items = stocks.map((s) => ({
    name: `${s.ticker}${s.shares ? " · " + s.shares + "股" : ""}`,
    value: s.marketValue || 0,
  }));
  renderFlowList(listEl, items, "income");
}

initAuth();
