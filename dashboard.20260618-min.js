const CHECK_IN_END = 9 * 60 + 30;

const refreshButton = document.querySelector("#refresh-button");
const dashSummary = document.querySelector("#dash-summary");
const dashStatus = document.querySelector("#dash-status");
const dashEmpty = document.querySelector("#dash-empty");
const dashContent = document.querySelector("#dash-content");
const statsBody = document.querySelector("#stats-body");
const heatmap = document.querySelector("#heatmap");
const trendCanvas = document.querySelector("#trend-chart");
const rankingCanvas = document.querySelector("#ranking-chart");

const PALETTE = ["#007aff", "#ff9500", "#ff2d55", "#34c759", "#5856d6", "#af52de", "#32ade6", "#ff3b30"];
const ARRIVAL_STOPS = [
  { m: 8 * 60, c: [52, 199, 89] },         // 08:00 green (early)
  { m: 8 * 60 + 30, c: [52, 199, 89] },    // 08:30 green
  { m: 9 * 60, c: [0, 122, 255] },         // 09:00 blue (in window)
  { m: 9 * 60 + 30, c: [255, 149, 0] },    // 09:30 orange (late edge)
  { m: 10 * 60, c: [255, 59, 48] },        // 10:00+ red (very late)
];

let trendChart = null;
let rankingChart = null;

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const chartAnimation = prefersReducedMotion ? false : { duration: 700, easing: "easeOutQuart" };

if (typeof Chart !== "undefined") {
  Chart.defaults.font.family = '"Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
  Chart.defaults.font.weight = 600;
  Chart.defaults.color = "#5d6478";
  Chart.defaults.plugins.tooltip.backgroundColor = "rgba(23, 26, 43, 0.88)";
  Chart.defaults.plugins.tooltip.padding = 12;
  Chart.defaults.plugins.tooltip.cornerRadius = 12;
  Chart.defaults.plugins.tooltip.titleFont = { weight: 700 };
  Chart.defaults.plugins.tooltip.boxPadding = 4;
}

function formatTime(totalMinutes) {
  const minutesInDay = 24 * 60;
  const normalized = ((totalMinutes % minutesInDay) + minutesInDay) % minutesInDay;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]
  ));
}

function lerpColor(minutes) {
  const last = ARRIVAL_STOPS[ARRIVAL_STOPS.length - 1];
  if (minutes === null || minutes === undefined) return "var(--soft)";
  if (minutes <= ARRIVAL_STOPS[0].m) return `rgb(${ARRIVAL_STOPS[0].c.join(", ")})`;
  if (minutes >= last.m) return `rgb(${last.c.join(", ")})`;

  for (let index = 1; index < ARRIVAL_STOPS.length; index += 1) {
    const upper = ARRIVAL_STOPS[index];
    if (minutes <= upper.m) {
      const lower = ARRIVAL_STOPS[index - 1];
      const ratio = (minutes - lower.m) / (upper.m - lower.m);
      const channels = lower.c.map((value, channel) => Math.round(value + (upper.c[channel] - value) * ratio));
      return `rgb(${channels.join(", ")})`;
    }
  }
  return `rgb(${last.c.join(", ")})`;
}

function setStatus(message, isError = false) {
  dashStatus.textContent = message || "";
  dashStatus.classList.toggle("is-error", Boolean(isError) && Boolean(message));
}

function renderSummary(payload, peopleWithData) {
  const dayCount = payload.dates.length;
  const todayText = payload.today ? ` Today is ${payload.today}.` : "";
  dashSummary.textContent =
    `${peopleWithData} ${peopleWithData === 1 ? "person" : "people"} tracked across ` +
    `${dayCount} ${dayCount === 1 ? "day" : "days"}.${todayText}`;
}

function renderTrend(payload) {
  if (trendChart) trendChart.destroy();

  const datasets = payload.people
    .filter((person) => person.stats.days > 0)
    .map((person, index) => {
      const byDate = new Map(person.records.map((record) => [record.date, record.arrivalMinutes]));
      const color = PALETTE[index % PALETTE.length];
      return {
        label: person.name,
        data: payload.dates.map((date) => (byDate.has(date) ? byDate.get(date) : null)),
        borderColor: color,
        backgroundColor: color,
        spanGaps: true,
        tension: 0.38,
        borderWidth: 2.5,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBorderColor: "rgba(255, 255, 255, 0.9)",
        pointBorderWidth: 1.5,
      };
    });

  trendChart = new Chart(trendCanvas, {
    type: "line",
    data: { labels: payload.dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: chartAnimation,
      interaction: { mode: "nearest", intersect: false },
      layout: { padding: { top: 4, right: 8 } },
      elements: { point: { hitRadius: 8 } },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            autoSkip: true,
            maxRotation: 0,
            autoSkipPadding: 16,
            font: { size: 11 },
            // Labels are ISO dates (YYYY-MM-DD); show MM-DD to stay compact on mobile.
            callback(value) {
              const label = this.getLabelForValue(value);
              return typeof label === "string" ? label.slice(5) : label;
            },
          },
        },
        y: {
          suggestedMin: 8 * 60,
          suggestedMax: 10 * 60,
          grid: { color: "rgba(23, 26, 43, 0.07)" },
          ticks: { callback: (value) => formatTime(value), font: { size: 11 } },
          title: { display: true, text: "Come-in time" },
        },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            boxHeight: 8,
            padding: 14,
            font: { size: 12 },
          },
        },
        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${context.parsed.y === null ? "-" : formatTime(context.parsed.y)}`,
          },
        },
      },
    },
  });
}

function renderRanking(payload) {
  if (rankingChart) rankingChart.destroy();

  const ranked = payload.people
    .filter((person) => person.stats.avgArrivalMinutes !== null)
    .sort((a, b) => a.stats.avgArrivalMinutes - b.stats.avgArrivalMinutes);

  rankingChart = new Chart(rankingCanvas, {
    type: "bar",
    data: {
      labels: ranked.map((person) => person.name),
      datasets: [
        {
          label: "Average come-in",
          data: ranked.map((person) => person.stats.avgArrivalMinutes),
          backgroundColor: ranked.map((person) => lerpColor(person.stats.avgArrivalMinutes)),
          borderRadius: 10,
          borderSkipped: false,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: chartAnimation,
      layout: { padding: { right: 8 } },
      scales: {
        x: {
          // Bar charts anchor at 0 by default, which pushed every bar from 00:00 and made
          // them look identical. Pin the axis to a realistic arrival window instead.
          min: 7 * 60,
          suggestedMax: 10 * 60,
          grid: { color: "rgba(23, 26, 43, 0.07)" },
          ticks: { callback: (value) => formatTime(value), font: { size: 11 } },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 12 }, autoSkip: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => formatTime(context.parsed.x) } },
      },
    },
  });
}

function renderStatsTable(payload) {
  const rows = [...payload.people]
    .filter((person) => person.stats.days > 0)
    .sort((a, b) => a.stats.avgArrivalMinutes - b.stats.avgArrivalMinutes);

  statsBody.innerHTML = rows
    .map((person) => {
      const stats = person.stats;
      const onTime = stats.onTimeRate === null ? "-" : `${Math.round(stats.onTimeRate * 100)}%`;
      return `
        <tr>
          <td class="cell-name">${escapeHtml(person.name)}</td>
          <td>${stats.days}</td>
          <td>${escapeHtml(stats.avgArrival || "-")}</td>
          <td>${escapeHtml(stats.earliest || "-")}</td>
          <td>${escapeHtml(stats.latest || "-")}</td>
          <td>${onTime}</td>
        </tr>
      `;
    })
    .join("");
}

function renderHeatmap(payload) {
  const people = payload.people.filter((person) => person.stats.days > 0);
  const dates = payload.dates;
  heatmap.style.gridTemplateColumns = `minmax(120px, max-content) repeat(${dates.length}, 56px)`;

  const header = [`<div class="hm-cell hm-corner">Name</div>`]
    .concat(dates.map((date) => `<div class="hm-cell hm-date">${escapeHtml(date.slice(5))}</div>`))
    .join("");

  const body = people
    .map((person) => {
      const byDate = new Map(person.records.map((record) => [record.date, record]));
      const cells = dates
        .map((date) => {
          const record = byDate.get(date);
          if (!record || record.arrivalMinutes === null) {
            return `<div class="hm-cell hm-value hm-empty" title="${escapeHtml(person.name)} ${escapeHtml(date)}: no record"></div>`;
          }
          const color = lerpColor(record.arrivalMinutes);
          const title = `${person.name} ${date}: ${record.arrival}`;
          return `<div class="hm-cell hm-value" style="background:${color}" title="${escapeHtml(title)}">${escapeHtml(record.arrival)}</div>`;
        })
        .join("");
      return `<div class="hm-cell hm-name">${escapeHtml(person.name)}</div>${cells}`;
    })
    .join("");

  heatmap.innerHTML = header + body;
}

function showEmpty() {
  dashContent.hidden = true;
  dashEmpty.hidden = false;
  dashSummary.textContent = "Nothing tracked yet.";
}

function showContent() {
  dashEmpty.hidden = true;
  dashContent.hidden = false;
}

// Fetch the stats once, retrying a couple of times on a transient failure
// (e.g. a brief network blip over the tunnel) before surfacing an error, so the
// dashboard recovers on its own instead of showing a red error that needs a click.
async function fetchStats(attempt = 0) {
  try {
    const response = await fetch("/api/stats", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load dashboard.");
    return payload;
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      return fetchStats(attempt + 1);
    }
    throw error;
  }
}

async function loadDashboard() {
  setStatus("Loading dashboard...");
  if (typeof Chart === "undefined") {
    setStatus("Chart library failed to load.", true);
    return;
  }

  refreshButton.classList.add("is-loading");
  refreshButton.disabled = true;

  try {
    const payload = await fetchStats();

    const peopleWithData = payload.people.filter((person) => person.stats.days > 0).length;
    renderSummary(payload, peopleWithData);

    if (!peopleWithData) {
      showEmpty();
      setStatus("");
      return;
    }

    showContent();
    renderTrend(payload);
    renderRanking(payload);
    renderStatsTable(payload);
    renderHeatmap(payload);
    setStatus("");
  } catch (error) {
    setStatus(error.message || "Could not load dashboard.", true);
  } finally {
    refreshButton.classList.remove("is-loading");
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", loadDashboard);
loadDashboard();
