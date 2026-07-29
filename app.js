// ===========================================================
// 設定區：把下面這行換成你自己的 Apps Script 網頁應用程式網址
// （部署教學裡的「步驟5」會教你怎麼拿到這個網址）
// ===========================================================
const API_URL = "https://script.google.com/macros/s/AKfycbzNzx2T_0aRYMC61SyBRqzQHbFLDvd9TlJnWYrmJAWNd0pp4qE7-zwSIzLQPbBD6vD1/exec";

// ---------- 顏色（跟 style.css 呼應） ----------
const COLOR_SAGE = "#7C9473";
const COLOR_CLAY = "#C08552";
const COLOR_INK = "#3D4A3F";
const COLOR_MUTED = "#8C8577";
const COLOR_BORDER = "#E8E2D8";
const PIE_COLORS = ["#7C9473", "#C08552", "#B8A088", "#94A897", "#D9B382", "#8C8577", "#A9BFA0", "#CBA37C"];

function fmt(n) {
  if (n === null || n === undefined) return "—";
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

// ---------- 主要載入流程 ----------
async function loadData() {
  if (API_URL.indexOf("PASTE_YOUR") >= 0) {
    document.getElementById("loadError").classList.remove("hidden");
    return;
  }
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    renderOverview(data.trend);
    renderCashflow(data.breakdown);
    renderGoals(data.goals);
    renderStocks(data.stocks);

    document.getElementById("updatedAt").textContent =
      "更新於 " + new Date(data.updatedAt).toLocaleString("zh-TW", { hour12: false });
  } catch (err) {
    console.error(err);
    const box = document.getElementById("loadError");
    box.classList.remove("hidden");
    let detail = document.getElementById("loadErrorDetail");
    if (!detail) {
      detail = document.createElement("p");
      detail.id = "loadErrorDetail";
      detail.style.cssText = "font-size:12px;color:#C08552;word-break:break-all;margin-top:8px;";
      box.appendChild(detail);
    }
    detail.textContent = "錯誤訊息：" + (err && err.message ? err.message : String(err));
  }
}

// ---------- 總覽 ----------
function renderOverview(trend) {
  if (!trend || !trend.length) return;
  const latest = trend[trend.length - 1];
  const first = trend[0];
  const growth = (((latest.asset - first.asset) / first.asset) * 100).toFixed(0);

  document.getElementById("statAsset").textContent = fmt(latest.asset);
  document.getElementById("statAssetGrowth").textContent = `累計成長 +${growth}%`;
  document.getElementById("statIncome").textContent = fmt(latest.income);
  document.getElementById("statExpense").textContent = fmt(latest.expense);

  const labels = trend.map((t) => t.label);

  new Chart(document.getElementById("chartAsset"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: trend.map((t) => t.asset),
        borderColor: COLOR_SAGE,
        backgroundColor: "rgba(124,148,115,0.12)",
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: baseChartOptions(),
  });

  new Chart(document.getElementById("chartIncomeExpense"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "收入", data: trend.map((t) => t.income), backgroundColor: COLOR_SAGE, borderRadius: 3 },
        { label: "支出", data: trend.map((t) => t.expense), backgroundColor: COLOR_CLAY, borderRadius: 3 },
      ],
    },
    options: baseChartOptions(true),
  });
}

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
        <div class="flow-bar-fill ${kind}" style="width:${(item.value / max) * 100}%"></div>
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
  const pct = Math.min(100, (goals.currentAsset / goals.fireTarget) * 100);
  document.getElementById("fireProgressBar").style.width = pct.toFixed(1) + "%";
  document.getElementById("fireProgressNote").textContent =
    `目前進度 ${pct.toFixed(1)}%（${goals.currentAge}歲 → ${goals.retireAge}歲）` +
    (goals.fireProjection ? `，預估退休時可達 ${fmt(goals.fireProjection)}` : "");

  document.getElementById("goalHouseTarget").textContent = fmt(goals.houseTarget);
  document.getElementById("goalHouseNote").textContent =
    goals.housePrice ? `房價目標約 ${goals.housePrice}萬` : "";
}

// ---------- 股票 ----------
function renderStocks(stocks) {
  const listEl = document.getElementById("stockList");
  if (!stocks || !stocks.length) {
    listEl.innerHTML = '<div class="flow-item-top"><span class="flow-item-name">尚無資料，請確認股票分頁已加入「現價」欄位</span></div>';
    return;
  }
  const withValue = stocks.filter((s) => s.marketValue);
  if (withValue.length) {
    new Chart(document.getElementById("chartStocks"), {
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

loadData();
