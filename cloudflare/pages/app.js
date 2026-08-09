const defaultApiBase = "https://codex-metrics-sync.lunare.workers.dev";
const apiBase = new URLSearchParams(window.location.search).get("api") ?? defaultApiBase;

const status = document.getElementById("status");
const overviewCards = document.getElementById("overview-cards");
const overviewCosts = document.getElementById("overview-costs");
const providers = document.getElementById("providers");
const devices = document.getElementById("devices");
const requests = document.getElementById("requests");

async function main() {
  try {
    const [overview, deviceRows, requestRows] = await Promise.all([
      fetchJson(`${apiBase}/api/overview`),
      fetchJson(`${apiBase}/api/devices`),
      fetchJson(`${apiBase}/api/requests?limit=50`),
    ]);
    renderOverview(overview);
    renderTable(providers, ["提供商", "请求数", "输入 Token", "输出 Token", "总 Token"],
      overview.providers.map((row) => [row.provider ?? "未知", row.request_count, row.input_tokens, row.output_tokens, row.total_tokens]));
    renderTable(devices, ["设备", "首次上报", "最后上报", "请求数", "子代理数"],
      deviceRows.devices.map((row) => [row.device_id, time(row.first_seen_at_ms), time(row.last_seen_at_ms), row.request_count, row.subagent_count]));
    renderTable(requests, ["设备", "时间", "提供商", "模型", "状态", "输入", "缓存", "输出", "费用"],
      requestRows.requests.map((row) => [
        row.device_id,
        time(row.recorded_at_ms),
        row.provider ?? "未知",
        row.model ?? "未知",
        row.status ?? "未知",
        row.input_tokens ?? 0,
        row.cached_input_tokens ?? 0,
        row.output_tokens ?? 0,
        cost(row.total_cost_nanos, row.pricing_currency),
      ]));
  } catch (error) {
    status.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function renderOverview(overview) {
  const totals = overview.totals;
  if (!totals) return;
  const cards = [
    ["设备数", totals.device_count],
    ["请求数", totals.request_count],
    ["子代理数", totals.subagent_count],
    ["总 Token", number(totals.total_tokens)],
    ["输入", number(totals.input_tokens)],
    ["缓存输入", number(totals.cached_input_tokens)],
    ["输出", number(totals.output_tokens)],
    ["推理输出", number(totals.reasoning_output_tokens)],
  ];
  overviewCards.replaceChildren(...cards.map(([label, value]) => {
    const card = document.createElement("div");
    card.className = "card";
    const labelNode = document.createElement("div");
    labelNode.className = "label";
    labelNode.textContent = label;
    const valueNode = document.createElement("div");
    valueNode.className = "value";
    valueNode.textContent = value;
    card.append(labelNode, valueNode);
    return card;
  }));
  if (overview.costsByCurrency.length > 0) {
    renderTable(overviewCosts, ["币种", "已计价请求", "费用"],
      overview.costsByCurrency.map((row) => [row.currency, row.request_count, cost(row.total_cost_nanos, row.currency)]));
  }
}

function renderTable(container, headers, rows) {
  container.replaceChildren();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "暂无数据";
    container.append(empty);
    return;
  }
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const header of headers) {
    const th = document.createElement("th");
    th.textContent = header;
    headRow.append(th);
  }
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const td = document.createElement("td");
      td.textContent = String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  container.append(table);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json();
}

function number(value) {
  return new Intl.NumberFormat().format(Number(value ?? 0));
}

function time(value) {
  if (!value) return "未知";
  return new Date(value).toLocaleString();
}

function cost(nanos, currency) {
  const amount = Number(nanos ?? 0) / 1e9;
  if (currency === "CNY") return `¥${amount.toFixed(4)}`;
  if (currency === "USD") return `$${amount.toFixed(4)}`;
  return `${amount.toFixed(4)} ${currency ?? ""}`.trim();
}

main();
