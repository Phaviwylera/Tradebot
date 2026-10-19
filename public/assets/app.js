/*
 * Opus Agent Desk — dashboard controller.
 *
 * Reads saved runs from the Python runner (/api/latest, /api/reports/<id>) and renders the six
 * stage reports. When served by `python3 main.py --serve`, the Run button executes the same
 * pipeline through POST /api/run. On static hosting it falls back to the committed snapshots in
 * /reports/ and disables the run action.
 *
 * No order, wallet, key or signing code exists in this file.
 */

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const AGENTS = [
  { key: 'scout', num: '01', name: 'Scout', role: 'scan 400+ markets for unusual activity' },
  { key: 'news', num: '02', name: 'News', role: 'dated sources, claims vs speculation' },
  { key: 'charts', num: '03', name: 'Charts', role: 'trend, momentum, support and resistance' },
  { key: 'strategy', num: '04', name: 'Strategy', role: 'one conditional plan, never a guess' },
  { key: 'risk', num: '05', name: 'Risk', role: 'size it, or veto it' },
  { key: 'boss', num: '06', name: 'Boss', role: 'one final decision' },
];

const DECISION_LABEL = {
  APPROVE_FOR_PAPER_TEST: 'APPROVE FOR PAPER TEST',
  WAIT: 'WAIT',
  REJECT: 'REJECT',
};

const STAGE_TEXT = {
  done: 'complete', halt: 'needs data', fail: 'rejected',
  running: 'working', queued: 'queued', skipped: 'not reached',
};

const LS = { journal: 'opus-desk-journal-v1', source: 'opus-desk-source-v1' };

// The scheduled live runner commits its reports to the default branch. Static hosting reads
// them from the raw file host (CORS-enabled), falling back to the copy shipped with the page.
const REMOTE_BASE = 'https://raw.githubusercontent.com/Phaviwylera/Tradebot/main/public/reports';

const state = {
  source: 'fixture',
  apiAvailable: false,
  staticOnly: false,
  remote: false,
  status: 'loading', // loading | idle | running | done | error
  run: null,
  index: [],
  error: null,
  raw: 'boss',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function arr(value) { return Array.isArray(value) ? value : []; }

function num(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function money(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function pct(value, digits = 1, signed = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${signed && n > 0 ? '+' : ''}${(n * 100).toFixed(digits)}%`;
}

function signedMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
}

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}¢` : '—';
}

function short(text, max = 46) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function timeOnly(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(11, 19)}Z` : '—';
}

function dateTime(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : '—';
}

function until(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const hours = (ms - Date.now()) / 3_600_000;
  if (hours < 0) return 'past';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function msText(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n} ms` : '—';
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/* ------------------------------------------------------------------ */
/* journal storage                                                     */
/* ------------------------------------------------------------------ */

function loadJournal() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS.journal) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveJournal(entries) {
  try {
    localStorage.setItem(LS.journal, JSON.stringify(entries));
  } catch {
    toast('Local storage is unavailable; the journal cannot be saved.');
  }
}

/* ------------------------------------------------------------------ */
/* loading                                                             */
/* ------------------------------------------------------------------ */

async function detectApi() {
  try {
    const health = await getJson('/api/health');
    state.apiAvailable = Boolean(health?.ok);
  } catch {
    state.apiAvailable = false;
  }
}

async function loadInitial() {
  state.status = 'loading';
  renderAll();
  await detectApi();

  const savedSource = localStorage.getItem(LS.source);
  if (savedSource === 'live' || savedSource === 'fixture') state.source = savedSource;

  let run = null;
  let index = [];
  if (state.apiAvailable) {
    try { run = (await getJson('/api/latest')).run; } catch { run = null; }
    try { index = arr((await getJson('/api/reports')).runs); } catch { index = []; }
  } else {
    state.staticOnly = true;
    state.remote = !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(location.hostname);
    if (state.remote) {
      const bust = `?v=${Date.now().toString(36)}`;
      try { run = await getJson(`${REMOTE_BASE}/latest.json${bust}`); } catch { run = null; }
      try { index = arr((await getJson(`${REMOTE_BASE}/index.json${bust}`)).runs); } catch { index = []; }
    }
    if (!run) { try { run = await getJson('/reports/latest.json'); } catch { run = null; } }
    if (!index.length) { try { index = arr((await getJson('/reports/index.json')).runs); } catch { index = []; } }
  }

  state.run = run && run.reports ? run : null;
  state.index = index;
  state.status = state.run ? 'done' : 'idle';
  renderAll();
}

async function loadRun(runId) {
  if (!runId) return;
  state.status = 'loading';
  renderAll();
  try {
    let payload;
    if (state.apiAvailable) {
      payload = await getJson(`/api/reports/${encodeURIComponent(runId)}`);
    } else {
      if (state.remote) {
        try { payload = await getJson(`${REMOTE_BASE}/${encodeURIComponent(runId)}.json?v=${Date.now().toString(36)}`); } catch { payload = null; }
      }
      if (!payload) payload = await getJson(`/reports/${encodeURIComponent(runId)}.json`);
    }
    state.run = payload.run || payload;
    state.status = 'done';
    state.error = null;
  } catch (error) {
    state.status = 'error';
    state.error = `Could not load ${runId}: ${error.message}`;
  }
  renderAll();
}

async function runDesk() {
  if (state.status === 'running') return;
  if (!state.apiAvailable) {
    toast('No API in this deployment. Run `python3 main.py --serve` to execute the desk.');
    return;
  }
  state.status = 'running';
  state.error = null;
  renderAll();
  try {
    const response = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: state.source }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    state.run = payload.run;
    state.status = 'done';
    try { state.index = arr((await getJson('/api/reports')).runs); } catch { /* optional */ }
    toast(`${DECISION_LABEL[payload.decision] || payload.decision} · report saved`);
  } catch (error) {
    state.status = 'error';
    state.error = error.message;
  }
  renderAll();
}

/* ------------------------------------------------------------------ */
/* chrome                                                              */
/* ------------------------------------------------------------------ */

function renderChrome() {
  $$('.seg-btn').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.source === state.source ? 'true' : 'false');
    button.disabled = state.status === 'running';
  });

  const button = $('#run');
  const running = state.status === 'running';
  button.disabled = running || !state.apiAvailable;
  button.classList.toggle('running', running);
  button.title = state.apiAvailable ? 'Run the six-stage pipeline' : 'Static deployment: run python3 main.py --serve';
  $('#run-label').textContent = running ? 'Running…' : 'Run desk';

  const run = state.run;
  const cfg = run?.config;
  $('#mode-chip').textContent = cfg?.mode === 'paper' ? 'PAPER' : '—';
  $('#run-chip').textContent = run ? run.run_id : 'no run';
  $('#rail-status').textContent = state.apiAvailable
    ? `paper mode · source ${state.source}`
    : state.remote ? 'live reports · read-only' : 'static snapshot · read-only';
  $('#footer-meta').textContent = run
    ? `${run.source} · ${run.run_id} · ${run.validation?.ok ? 'schema passed' : 'schema unchecked'}`
    : 'no run loaded';
  renderHistory();
}

function renderHistory() {
  const select = $('#run-select');
  const runs = state.index;
  if (!runs.length) {
    select.innerHTML = '<option value="">no runs</option>';
    select.disabled = true;
    $('#history-note').textContent = state.staticOnly ? 'static snapshot' : 'no saved runs';
    return;
  }
  select.disabled = false;
  select.innerHTML = runs.map(entry => `<option value="${esc(entry.run_id)}" ${entry.run_id === state.run?.run_id ? 'selected' : ''}>
    ${esc(entry.decision === 'APPROVE_FOR_PAPER_TEST' ? 'APPROVE' : entry.decision || '—')} · ${esc(String(entry.finished_utc || '').slice(11, 19))}Z · ${esc(entry.plans ?? 0)}p
  </option>`).join('');
  $('#history-note').textContent = state.apiAvailable ? `${runs.length} run(s) saved` : `${runs.length} published snapshot(s)`;
}

function renderBanner() {
  const el = $('#banner');
  el.className = 'banner';
  const run = state.run;

  if (state.status === 'error') {
    el.classList.add('error');
    el.innerHTML = `<span><strong>Run failed.</strong> ${esc(state.error || 'unknown error')}
      ${state.apiAvailable ? '' : ' Start the local server with <code>python3 main.py --serve</code> to execute the desk.'}</span>`;
    return;
  }
  if (!run) return;

  const noData = (run.universe?.size ?? 0) === 0;
  const synthetic = Boolean(run.universe?.synthetic);
  if (noData) {
    el.classList.add('error');
    el.innerHTML = '<span><strong>No market data loaded.</strong> The pipeline halted at Scout and the Boss returned WAIT. Check the Scout report for the exact feed error, then re-run.</span>';
  } else if (synthetic) {
    el.classList.add('test');
    el.innerHTML = `<span><strong>Synthetic fixture board.</strong> ${run.universe?.size ?? 0} generated markets, prices and headlines — labelled TEST DATA.
      This exercises the workflow; it is not a real market and not a forecast.</span>`;
  } else {
    el.classList.add('live');
    el.innerHTML = '<span><strong>Live public data.</strong> Read-only quotes and headlines. Prices can lag, sources can be thin, no order can be placed.</span>';
  }
  if (state.staticOnly) {
    el.insertAdjacentHTML('beforeend', state.remote
      ? '<span class="static-note">Read-only hosting: the newest committed run is loaded from the repository. The six agents execute on a 15-minute GitHub Actions schedule; the Run button needs the local server.</span>'
      : '<span class="static-note">Static deployment: showing a saved run. Execute the pipeline locally with <code>python3 main.py --serve</code>.</span>');
  }
}

function renderTicker() {
  const host = $('#ticker');
  const rows = arr(state.run?.reports?.scout?.evidence);
  if (!rows.length) {
    host.innerHTML = '<span class="tape-item tape-empty">awaiting run · no market data</span>';
    return;
  }
  const items = rows.slice(0, 9).map(item => {
    const move = Number(item.metrics?.move_1h) || 0;
    const klass = move > 0 ? 'up' : move < 0 ? 'down' : '';
    return `<span class="tape-item">
      <span class="sym">${esc(short(item.question, 30))}</span>
      <span class="px">${esc(cents(item.price))}</span>
      <span class="${klass}">${move > 0 ? '▲' : move < 0 ? '▼' : '·'} ${esc(pct(move, 1, true))}</span>
    </span>`;
  }).join('');
  host.innerHTML = `${items}<span aria-hidden="true" style="display:contents">${items}</span>`;
}

function renderHero() {
  const host = $('#hero-decision');
  const chip = $('#decision-run');
  const run = state.run;

  if (chip) chip.textContent = run ? short(run.run_id, 26) : 'no run';

  if (state.status === 'running') {
    host.innerHTML = `
      <div class="decision-hero">
        <div class="decision-glyph">···</div>
        <div class="decision-copy">
          <div class="decision-label idle">RUNNING THE DESK</div>
          <div class="decision-sub">Scout → News → Charts → Strategy → Risk → Boss. The decision appears when all six stages finish.</div>
        </div>
      </div>
      <div class="decision-counts">
        <div><div class="k">stage</div><div class="v">6</div></div>
        <div><div class="k">orders</div><div class="v">0</div></div>
        <div><div class="k">mode</div><div class="v">paper</div></div>
        <div><div class="k">live</div><div class="v">off</div></div>
      </div>`;
    return;
  }

  if (!run) {
    host.innerHTML = `
      <div class="empty-block">
        <div class="eyebrow">research terminal · ready</div>
        <h2>Six stages. One decision. No orders.</h2>
        <p>Scout ranks unusual activity, News attaches dated sources, Charts reads structure, Strategy writes one
        conditional plan, Risk can veto it, and the Boss returns APPROVE FOR PAPER TEST, WAIT or REJECT.</p>
        <button type="button" class="btn btn-primary" data-action="run">Run the desk</button>
        <div class="rail-note" style="margin-top:9px">${state.apiAvailable ? 'No saved runs yet.' : 'Static deployment: run <code>python3 main.py --serve</code> locally to generate a report.'}</div>
      </div>`;
    return;
  }

  const boss = run.reports?.boss || {};
  const meta = boss.meta || {};
  const decision = meta.decision || 'WAIT';
  const kind = decision === 'APPROVE_FOR_PAPER_TEST' ? 'approve' : decision === 'WAIT' ? 'wait' : 'reject';
  const glyph = kind === 'approve' ? '✓' : kind === 'wait' ? 'Ⅱ' : '✕';
  const counts = meta.counts || {};
  const approved = arr(meta.approved);

  host.innerHTML = `
    <div class="decision-hero">
      <div class="decision-glyph ${kind}">${glyph}</div>
      <div class="decision-copy">
        <div class="decision-label ${kind}">${esc(DECISION_LABEL[decision] || decision)}</div>
        <div class="decision-sub">${esc(boss.summary || '')}</div>
      </div>
    </div>
    <div class="decision-counts">
      <div><div class="k">plans</div><div class="v">${counts.plans ?? 0}</div></div>
      <div><div class="k">cleared</div><div class="v" style="color:var(--green)">${counts.risk_passed ?? 0}</div></div>
      <div><div class="k">rejected</div><div class="v" style="color:var(--red)">${counts.risk_rejected ?? 0}</div></div>
      <div><div class="k">waits</div><div class="v" style="color:var(--amber)">${counts.waits ?? 0}</div></div>
    </div>
    ${approved.slice(0, 2).map((trade, index) => `
      <div class="approved-strip">
        <div class="q">${esc(short(trade.question, 64))}</div>
        <div class="ladder">
          <span>${esc(trade.side)}</span>
          <span>entry <b>${esc(cents(trade.entry))}</b></span>
          <span class="stop">stop <b>${esc(cents(trade.invalidation))}</b></span>
          <span class="target">target <b>${esc(cents(trade.target))}</b></span>
          <span><b>${esc(trade.shares)}</b> sh</span>
          <span>risk <b>${esc(money(trade.risk_dollars, 2))}</b></span>
          <span>net R:R <b>${esc(num(trade.net_rr))}</b></span>
          <span>by <b>${esc(dateTime(trade.time_limit_utc))}</b></span>
        </div>
        <div class="decision-actions">
          <button class="btn btn-small" data-action="log-trade" data-index="${index}">Log to journal</button>
        </div>
      </div>`).join('')}
    <div class="integrity">
      ${arr(meta.integrity).slice(0, 5).map(check => `
        <div class="check ${check.pass ? '' : 'bad'}">
          <span class="mark">${check.pass ? '✓' : '✕'}</span>
          <span class="name">${esc(check.name)}</span>
          <span>${esc(check.detail)}</span>
        </div>`).join('')}
    </div>
    ${arr(meta.disagreements).length ? `<div class="chip warn">${meta.disagreements.length} unresolved disagreement(s) · held, never averaged</div>` : ''}
    <div class="decision-actions">
      ${approved.length ? '<button class="btn btn-small btn-ghost" data-action="log-all">Log all cleared</button>' : ''}
      <button class="btn btn-small btn-ghost" data-action="copy-report">Copy JSON</button>
    </div>`;
}

function renderKpis() {
  const host = $('#kpis');
  const foot = $('#kpi-foot');
  const run = state.run;
  if (!run) {
    host.innerHTML = ['Universe', 'Watchlist', 'Plans', 'Cleared']
      .map(label => `<div class="kpi"><div class="k">${label}</div><div class="v">—</div><div class="s">waiting</div></div>`).join('');
    foot.innerHTML = '<span>no run loaded</span><span>0 ms</span>';
    return;
  }
  const reports = run.reports || {};
  const scout = reports.scout;
  const counts = reports.boss?.meta?.counts || {};
  const tiles = [
    { k: 'Universe scanned', v: (run.universe?.size ?? 0).toLocaleString('en-US'), s: run.universe?.synthetic ? 'synthetic board' : 'live public data', c: 'teal' },
    { k: 'Watchlist', v: arr(scout?.evidence).length || '—', s: `${scout?.meta?.scored_count ?? '—'} passed quality`, c: '' },
    { k: 'Plans written', v: counts.plans ?? 0, s: `${counts.waits ?? 0} returned WAIT`, c: (counts.plans ?? 0) ? '' : 'warn' },
    { k: 'Risk cleared', v: counts.risk_passed ?? 0, s: `${counts.risk_rejected ?? 0} rejected`, c: (counts.risk_passed ?? 0) ? 'good' : 'bad' },
  ];
  host.innerHTML = tiles.map(tile => `
    <div class="kpi ${tile.c}">
      <div class="k">${esc(tile.k)}</div>
      <div class="v">${esc(tile.v)}</div>
      <div class="s">${esc(tile.s)}</div>
    </div>`).join('');
  const stageTotal = Object.values(run.stage_ms || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  foot.innerHTML = `<span>${esc(run.source)} · ${esc(short(run.run_id, 22))}</span><span>${esc(msText(stageTotal))} pipeline</span>`;
}

function renderExposure() {
  const host = $('#exposure');
  const chip = $('#exposure-chip');
  const run = state.run;
  const risk = run?.reports?.risk;
  const meta = risk?.meta;
  if (!meta) {
    chip.textContent = '—';
    host.innerHTML = '<div class="skeleton">Exposure and position limits appear after a run.</div>';
    return;
  }
  const used = Number(meta.exposure_used) || 0;
  const limit = Number(meta.exposure_limit) || 0;
  const utilization = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const bankroll = Number(meta.bankroll) || 0;
  const dailyCap = bankroll * (Number(run?.config?.max_daily_risk_pct) || 6) / 100;
  const dailyUsed = Number(meta.risk_committed) || 0;
  const dailyPct = dailyCap > 0 ? Math.min(100, (dailyUsed / dailyCap) * 100) : 0;
  const slots = Number(run?.config?.max_positions) || 0;
  const open = Number(meta.open_positions) || 0;
  chip.textContent = `${utilization.toFixed(0)}% of cap`;
  chip.className = `chip ${utilization > 80 ? 'bad' : utilization > 40 ? 'warn' : 'good'}`;

  host.innerHTML = `
    <div class="gauge-row">
      <div class="gauge" style="--value:${utilization.toFixed(1)}">
        <div class="gauge-inner">
          <div class="pct">${utilization.toFixed(0)}%</div>
          <div class="cap">exposure</div>
        </div>
      </div>
      <div class="gauge-legend">
        <div class="line"><span>used</span><b>${esc(money(used, 2))}</b></div>
        <div class="line"><span>cap</span><b>${esc(money(limit))}</b></div>
        <div class="line"><span>risk committed</span><b>${esc(money(dailyUsed, 2))}</b></div>
        <div class="line"><span>bankroll</span><b>${esc(money(bankroll))}</b></div>
      </div>
    </div>
    <div class="meter">
      <div class="top"><span>Exposure</span><b>${used.toFixed(2)} / ${limit.toFixed(0)} USD</b></div>
      <div class="track"><div class="fill ${utilization > 80 ? 'bad' : utilization > 40 ? 'warn' : ''}" style="width:${utilization.toFixed(1)}%"></div></div>
    </div>
    <div class="meter">
      <div class="top"><span>Daily risk</span><b>${dailyUsed.toFixed(2)} / ${dailyCap.toFixed(0)} USD</b></div>
      <div class="track"><div class="fill ${dailyPct > 80 ? 'bad' : dailyPct > 40 ? 'warn' : ''}" style="width:${dailyPct.toFixed(1)}%"></div></div>
    </div>
    <div class="meter">
      <div class="top"><span>Position slots</span><b>${open} / ${slots}</b></div>
      <div class="track"><div class="fill" style="width:${slots ? ((open / slots) * 100).toFixed(1) : 0}%"></div></div>
    </div>`;
}


function renderBook() {
  const run = state.run;
  const paper = run?.paper;
  const chip = $('#book-chip');
  const source = $('#book-source');
  const summary = $('#book-summary');
  const body = $('#book-body');
  const chart = $('#equity-chart');
  const stats = $('#book-stats');
  const closed = $('#book-closed');
  if (!chip || !summary) return;

  if (!paper) {
    chip.className = 'chip ghost';
    chip.textContent = run?.source === 'live' ? 'waiting for first fill' : 'no live book';
    source.textContent = run?.universe?.synthetic ? 'SYNTHETIC' : (run?.source || '—').toUpperCase();
    summary.innerHTML = '';
    chart.innerHTML = '';
    stats.innerHTML = '';
    closed.innerHTML = '';
    body.innerHTML = `<div class="book-empty">
      <div class="eyebrow">${run?.source === 'live' ? 'live book pending' : 'fixtures never trade'}</div>
      <p>${run?.source === 'live'
        ? 'The desk is reading real Polymarket markets, but no plan has cleared the risk gate yet. The $100 book opens its first position on the next APPROVE FOR PAPER TEST.'
        : 'The paper book only trades live Polymarket data. This snapshot is synthetic, so the $100 balance is untouched and no fill is simulated.'}</p>
    </div>`;
    return;
  }

  const live = run?.source === 'live' && run?.universe?.synthetic === false;
  chip.className = `chip ${live ? 'good' : 'ghost'}`;
  chip.textContent = live ? 'LIVE · POLYMARKET' : 'SIMULATED BOOK';
  source.textContent = `${paper.open_count} open · ${paper.closed_count} closed`;

  const pnlUp = Number(paper.total_pnl) >= 0;
  summary.innerHTML = `
    <div class="book-kpi"><div class="k">equity</div><div class="v">${money(paper.equity, 2)}</div><div class="s">from ${money(paper.starting_cash, 2)}</div></div>
    <div class="book-kpi"><div class="k">cash</div><div class="v">${money(paper.cash, 2)}</div><div class="s">never topped up</div></div>
    <div class="book-kpi"><div class="k">total P&amp;L</div><div class="v ${pnlUp ? 'up' : 'down'}">${signedMoney(paper.total_pnl)}</div><div class="s">${paper.return_pct >= 0 ? '+' : ''}${num(paper.return_pct, 2)}%</div></div>
    <div class="book-kpi"><div class="k">realized</div><div class="v ${Number(paper.realized_pnl) >= 0 ? 'up' : 'down'}">${signedMoney(paper.realized_pnl)}</div><div class="s">${paper.closed_count} closed</div></div>
    <div class="book-kpi"><div class="k">open</div><div class="v">${paper.open_count}</div><div class="s">${paper.win_rate}% win rate</div></div>`;

  const positions = arr(paper.open_positions);
  body.innerHTML = positions.length ? `
    <table class="book-table">
      <thead><tr><th>position</th><th>entry → mark</th><th>shares</th><th>P&amp;L</th><th>stop / target</th><th>expires</th></tr></thead>
      <tbody>${positions.map(position => `
        <tr>
          <td>
            <div class="bq">${position.url
              ? `<a href="${esc(position.url)}" target="_blank" rel="noreferrer">${esc(short(position.question, 54))}</a>`
              : esc(short(position.question, 54))}</div>
            <div class="bsub">${esc(position.side || '')} · ${esc(position.category || '')} · ${esc(position.trade_id || '')}</div>
          </td>
          <td class="mono">${cents(position.entry)} → ${cents(position.last_price)}</td>
          <td class="mono">${esc(position.shares)}</td>
          <td class="mono ${Number(position.unrealized_pnl) >= 0 ? 'up' : 'down'}">${signedMoney(position.unrealized_pnl)}<span class="pct">${Number(position.unrealized_pct) >= 0 ? '+' : ''}${num(position.unrealized_pct, 1)}%</span></td>
          <td class="mono dim">${cents(position.stop)} / ${cents(position.target)}</td>
          <td class="mono dim">${until(position.time_limit_utc)}</td>
        </tr>`).join('')}</tbody>
    </table>
    <div class="book-note">Fills are simulated at the quoted price. No order, wallet or broker exists; the $100 starting balance is never topped up.</div>`
    : `<div class="book-empty"><div class="eyebrow">flat</div>
        <p>No open paper positions. The gate is waiting for a plan it can size inside 2% risk and 25% exposure.</p></div>`;

  const curve = arr(paper.equity_curve).map(point => Number(point.equity)).filter(Number.isFinite);
  const curveUp = curve.length > 1 && curve[curve.length - 1] >= curve[0];
  chart.innerHTML = curve.length > 1
    ? `<div class="equity-head"><span class="equity-value">${money(curve[curve.length - 1], 2)}</span>
         <span class="equity-delta ${curveUp ? 'up' : 'down'}">${signedMoney(curve[curve.length - 1] - curve[0])}</span></div>
       <div class="equity-spark ${curveUp ? 'up' : 'down'}">${sparkline(curve)}</div>`
    : '<div class="book-note">Equity curve starts after the second live run.</div>';

  stats.innerHTML = `
    <div><span>max drawdown</span><b>${num(paper.max_drawdown_pct, 2)}%</b></div>
    <div><span>win rate</span><b>${paper.win_rate}%</b></div>
    <div><span>best trade</span><b class="up">${signedMoney(paper.best_trade)}</b></div>
    <div><span>worst trade</span><b class="down">${signedMoney(paper.worst_trade)}</b></div>
    <div><span>gross win / loss</span><b>${signedMoney(paper.gross_win)} / ${signedMoney(paper.gross_loss)}</b></div>
    <div><span>marks</span><b>${paper.updated_utc ? dateTime(paper.updated_utc) : '—'}</b></div>`;

  const trades = arr(paper.closed_trades);
  closed.innerHTML = trades.length ? `
    <div class="closed-title">CLOSED TRADES</div>
    ${trades.slice(0, 5).map(trade => `
      <div class="closed-row">
        <div class="bq">${esc(short(trade.question, 44))}<span class="bsub">${esc(trade.exit_reason || '')} · ${cents(trade.entry)} → ${cents(trade.exit)}</span></div>
        <div class="mono ${Number(trade.pnl) >= 0 ? 'up' : 'down'}">${signedMoney(trade.pnl)}</div>
      </div>`).join('')}`
    : '<div class="book-note">No closed trades yet. Positions exit at the stop, target, resolution or the plan time limit.</div>';
}

function renderPipeline() {
  const host = $('#pipeline');
  const chip = $('#pipeline-chip');
  const run = state.run;
  const nodes = AGENTS.map(agent => {
    let status = 'queued';
    let duration = null;
    if (run) {
      const report = run.reports?.[agent.key];
      const rawStatus = report?.status;
      status = !report ? 'skipped' : rawStatus === 'complete' ? 'done' : rawStatus === 'rejected' ? 'fail' : 'halt';
      duration = run.stage_ms?.[agent.key];
    } else if (state.status === 'running') {
      status = 'running';
    }
    return `<button type="button" class="pipe ${status}" data-scroll="${agent.key}" title="${esc(agent.role)}">
      <div class="pipe-top"><span class="pipe-num">${agent.num}</span><span class="pipe-dot"></span></div>
      <div class="pipe-name">${esc(agent.name)}</div>
      <div class="pipe-status">${esc(STAGE_TEXT[status] || status)}</div>
      ${duration != null ? `<span class="pipe-ms">${esc(msText(duration))}</span>` : ''}
    </button>`;
  }).join('');
  host.innerHTML = nodes;

  if (!run) {
    chip.textContent = state.status === 'running' ? 'working' : 'queued';
    return;
  }
  const done = Object.values(run.reports || {}).filter(report => report.status === 'complete').length;
  const total = 6;
  chip.textContent = run.halted_at ? `halted at ${run.halted_at}` : `${done}/${total} complete`;
  chip.className = `chip ${run.halted_at ? 'warn' : done === total ? 'good' : 'warn'}`;
}

function renderCategories() {
  const host = $('#categories');
  const chip = $('#mix-chip');
  const meta = state.run?.reports?.scout?.meta;
  if (!meta) {
    chip.textContent = '—';
    host.innerHTML = '<div class="skeleton">Category mix appears after a scan.</div>';
    return;
  }
  const categories = Object.entries(meta.categories || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...categories.map(([, count]) => Number(count) || 0));
  chip.textContent = `${meta.universe_size ?? 0} markets`;
  host.innerHTML = categories.length
    ? categories.map(([name, count]) => `
      <div class="cat-row">
        <span class="label">${esc(name)}</span>
        <span class="track"><span class="fill" style="width:${((Number(count) || 0) / max * 100).toFixed(1)}%"></span></span>
        <span class="count">${esc(count)}</span>
      </div>`).join('')
    : '<div class="skeleton">No categories reported.</div>';
}

function renderScout() {
  const host = $('#scout-table');
  const run = state.run;
  const report = run?.reports?.scout;
  const rows = arr(report?.evidence);
  $('#scout-count').textContent = report ? `${rows.length} watchlist` : '—';
  $('#scout-source').textContent = run ? short(run.source_label || run.source, 22) : '—';
  $('#scout-sub').textContent = report
    ? `${report.meta?.universe_size ?? 0} scanned · ${report.meta?.scored_count ?? 0} passed quality · score normalised inside each category`
    : 'Unusual movement normalised inside each category.';

  if (!report) {
    host.innerHTML = '<div class="skeleton">Run the desk to populate the scanner.</div>';
    return;
  }
  if (!rows.length) {
    host.innerHTML = '<div class="skeleton">No market cleared the activity floor. The desk does not invent one.</div>';
    return;
  }
  host.innerHTML = `<table>
    <thead><tr><th>#</th><th>Market</th><th class="right">Score</th><th class="right">1h</th><th class="right">24h</th><th class="right">Volume</th><th class="right">Liquidity</th><th class="right">Spread</th><th class="right">Ends</th></tr></thead>
    <tbody>${rows.map((item, index) => {
      const metrics = item.metrics || {};
      const move1 = Number(metrics.move_1h);
      const move24 = Number(metrics.move_24h);
      return `<tr>
        <td class="num dim">${index + 1}</td>
        <td class="qcell">
          <div class="q">${esc(item.question)}</div>
          <div class="cell-tags">
            <span class="chip ghost">${esc(item.category || 'other')}</span>
            <span class="chip ghost">${esc(cents(item.price))}</span>
            ${item.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
          </div>
          ${arr(item.reasons).length ? `<div class="reason-line">${esc(item.reasons[0])}</div>` : ''}
        </td>
        <td class="num right">
          <div class="score-wrap"><span>${item.score ?? '—'}</span><span class="score-bar"><i style="width:${Math.min(100, Number(item.score) || 0)}%"></i></span></div>
        </td>
        <td class="num right ${move1 >= 0 ? 'pos' : 'neg'}">${esc(pct(metrics.move_1h, 1, true))}</td>
        <td class="num right ${move24 >= 0 ? 'pos' : 'neg'}">${esc(pct(metrics.move_24h, 1, true))}</td>
        <td class="num right">${esc(compact(metrics.volume_24h))}</td>
        <td class="num right">${esc(compact(metrics.liquidity))}</td>
        <td class="num right">${esc(cents(metrics.spread))}</td>
        <td class="num right">${esc(until(item.ends_at))}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderNews() {
  const host = $('#news-feed');
  const report = state.run?.reports?.news;
  if (!report) {
    $('#news-chip').textContent = '—';
    host.innerHTML = '<div class="skeleton">Headlines appear after the news pass.</div>';
    return;
  }
  const rows = arr(report.evidence);
  const sourced = rows.filter(item => (item.fresh_count || 0) > 0).length;
  $('#news-chip').textContent = `${sourced}/${rows.length} sourced`;
  $('#news-sub').textContent = report.meta?.headline_policy
    ? short(report.meta.headline_policy, 120)
    : 'Claims, not facts. Every item carries a source and a timestamp.';

  const blocks = [];
  rows.forEach(item => {
    const items = arr(item.items).filter(headline => !headline.duplicate);
    if (!items.length) {
      blocks.push(`<div class="news-item">
        <div class="market">${esc(short(item.question, 58))}</div>
        <div class="headline" style="color:var(--amber)">No usable dated source — flagged ${esc((item.flags || ['NO_SOURCES'])[0])}</div>
      </div>`);
      return;
    }
    items.slice(0, 2).forEach(headline => {
      blocks.push(`<div class="news-item">
        <div class="market">${esc(short(item.question, 58))}</div>
        <div class="headline"><a href="${esc(headline.link || '#')}" target="_blank" rel="noopener noreferrer">${esc(headline.title)}</a></div>
        <div class="meta">
          <span class="chip ghost">${esc(headline.source || 'unattributed')}</span>
          <span class="chip ${headline.stale ? 'warn' : ''}">${headline.age_hours == null ? 'no date' : `${esc(headline.age_hours)}h`}</span>
          <span class="chip ${headline.relevance === 'direct' ? 'good' : 'ghost'}">${esc(headline.relevance)}</span>
          ${headline.speculative ? '<span class="chip warn">speculative</span>' : ''}
          ${headline.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
        </div>
      </div>`);
    });
  });
  host.innerHTML = blocks.slice(0, 14).join('') || '<div class="news-empty">No headline reached the feed.</div>';
}

/* sparkline: drawn from the report's own points, never synthesised here */
function sparkline(points, levels = []) {
  const data = arr(points).map(Number).filter(Number.isFinite);
  if (data.length < 2) return '';
  const width = 130;
  const height = 52;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 0.01;
  const x = index => pad + (index / (data.length - 1)) * (width - pad * 2);
  const y = value => pad + (1 - (value - min) / span) * (height - pad * 2);
  const line = data.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(2)},${height - pad} L${x(0).toFixed(2)},${height - pad} Z`;
  const grid = [0.25, 0.5, 0.75].map(fraction => {
    const gy = (pad + fraction * (height - pad * 2)).toFixed(2);
    return `<line class="gridline" x1="${pad}" x2="${width - pad}" y1="${gy}" y2="${gy}"></line>`;
  }).join('');
  const guides = levels.map(Number)
    .filter(level => Number.isFinite(level) && level >= min && level <= max)
    .slice(0, 2)
    .map(level => `<line class="level" x1="${pad}" x2="${width - pad}" y1="${y(level).toFixed(2)}" y2="${y(level).toFixed(2)}"></line>`)
    .join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="price series">
    ${grid}<path class="area" d="${area}"></path><path class="line" d="${line}"></path>${guides}
  </svg>`;
}

function renderCharts() {
  const host = $('#charts-grid');
  const report = state.run?.reports?.charts;
  if (!report) {
    $('#charts-count').textContent = '—';
    $('#charts-conflicts').textContent = '—';
    host.innerHTML = '<div class="skeleton" style="grid-column:1/-1">Price structure appears after the charts pass.</div>';
    return;
  }
  const rows = arr(report.evidence);
  const complete = rows.filter(item => item.status === 'complete');
  const conflicts = complete.reduce((sum, item) => sum + arr(item.conflicts).length, 0);
  $('#charts-count').textContent = `${complete.length} series`;
  $('#charts-conflicts').textContent = `${conflicts} conflict(s)`;
  $('#charts-conflicts').className = `chip ${conflicts ? 'warn' : 'ghost'}`;

  host.innerHTML = rows.map(item => {
    if (item.status !== 'complete') {
      return `<div class="chart-cell">
        <div class="top"><div class="q">${esc(short(item.question, 54))}</div><span class="trend range">no data</span></div>
        <div class="no-data">${esc(item.reason || 'price history unavailable')}</div>
      </div>`;
    }
    const view = item.views?.primary || {};
    const trendClass = view.trend === 'up' ? 'up' : view.trend === 'down' ? 'down' : 'range';
    const levels = [...arr(view.levels?.support), ...arr(view.levels?.resistance)];
    return `<div class="chart-cell">
      <div class="top">
        <div class="q">${esc(short(item.question, 54))}</div>
        <span class="trend ${trendClass}">${esc(view.trend || 'n/a')}</span>
      </div>
      ${sparkline(item.sparkline, levels)}
      <div class="figures">
        <span>last <b>${esc(cents(view.last))}</b></span>
        <span>1h <b class="${Number(view.momentum_1h) >= 0 ? 'pos' : 'neg'}">${esc(cents(view.momentum_1h))}</b></span>
        <span>range <b>${esc(pct(view.atr_pct, 1))}</b></span>
      </div>
      <div class="levels">
        ${arr(view.levels?.support).map(level => `<span class="chip good">S ${esc(cents(level))}</span>`).join('')}
        ${arr(view.levels?.resistance).map(level => `<span class="chip bad">R ${esc(cents(level))}</span>`).join('')}
        ${view.structure_break ? `<span class="chip warn">break ${esc(view.structure_break)}</span>` : ''}
      </div>
      ${arr(item.conflicts).length ? `<div class="conflict">⚠ ${esc(item.conflicts[0])}</div>` : ''}
    </div>`;
  }).join('');
}

function renderStrategy() {
  const host = $('#strategy-list');
  const report = state.run?.reports?.strategy;
  if (!report) {
    $('#strategy-chip').textContent = '—';
    host.innerHTML = '<div class="skeleton">Plans appear after the strategy pass.</div>';
    return;
  }
  const rows = arr(report.evidence);
  const plans = rows.filter(item => item.status === 'plan');
  const waits = rows.filter(item => item.status !== 'plan');
  $('#strategy-chip').textContent = `${plans.length} plan(s) · ${waits.length} wait`;
  $('#strategy-chip').className = `chip ${plans.length ? 'good' : 'warn'}`;
  $('#strategy-sub').textContent = report.meta?.policy
    ? short(report.meta.policy, 130)
    : 'One conditional plan per market, or WAIT with the reason.';

  const tickets = plans.map(plan => `
    <div class="ticket ready">
      <div class="ticket-top">
        <div class="q">${esc(plan.question)}</div>
        <span class="side">${esc(plan.side)}</span>
      </div>
      <div class="ticket-grid">
        <div><div class="k">entry</div><div class="v">${esc(cents(plan.entry))}</div></div>
        <div><div class="k">stop</div><div class="v" style="color:var(--red)">${esc(cents(plan.invalidation))}</div></div>
        <div><div class="k">target</div><div class="v" style="color:var(--green)">${esc(cents(plan.target))}</div></div>
        <div><div class="k">gross R:R</div><div class="v">${esc(num(plan.gross_rr))}</div></div>
      </div>
      <div class="trigger"><strong>Trigger:</strong> ${esc(plan.entry_trigger)}</div>
      <div class="trigger"><strong>Expires:</strong> ${esc(dateTime(plan.time_limit_utc))} · zone ${esc(cents(plan.entry_zone?.[0]))}–${esc(cents(plan.entry_zone?.[1]))}</div>
      <div class="foot">
        <span class="chip ghost">${esc(plan.entry_type)}</span>
        <span class="chip ghost">${esc(plan.evidence_used?.chart_trend || 'n/a')}</span>
        <span class="chip ghost">${plan.evidence_used?.news_count ?? 0} source(s)</span>
        <span class="chip teal">confidence ${plan.confidence ?? '—'}</span>
        ${arr(plan.disagreements).length ? `<span class="chip warn">${plan.disagreements.length} conflict(s)</span>` : ''}
      </div>
    </div>`).join('');

  const waitList = waits.length ? `<div class="waits"><details>
      <summary>${waits.length} market(s) returned WAIT — show reasons</summary>
      <ul>${waits.map(item => `<li><strong style="color:var(--muted)">${esc(short(item.question, 52))}</strong> — ${esc(item.reason || 'no setup')}</li>`).join('')}</ul>
    </details></div>` : '';

  host.innerHTML = (tickets || '<div class="skeleton" style="padding:6px 0">No plan was forced. Every reviewed market returned WAIT.</div>') + waitList;
}

function renderRisk() {
  const host = $('#risk-list');
  const report = state.run?.reports?.risk;
  if (!report) {
    $('#risk-chip').textContent = '—';
    host.innerHTML = '<div class="skeleton">The gate runs after strategy.</div>';
    return;
  }
  const rows = arr(report.evidence);
  const reviewed = rows.filter(item => item.verdict !== 'NOT_REVIEWED');
  const skipped = rows.length - reviewed.length;
  const passed = reviewed.filter(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED').length;
  const rejected = reviewed.filter(item => item.verdict === 'REJECTED').length;
  $('#risk-chip').textContent = `${passed} cleared · ${rejected} rejected`;
  $('#risk-chip').className = `chip ${passed ? 'good' : 'bad'}`;

  const items = reviewed.map(item => {
    const failed = arr(item.checks).filter(check => !check.pass);
    const kind = item.verdict === 'REJECTED' ? 'rejected' : item.verdict === 'REDUCED' ? 'reduced' : 'passed';
    const shown = failed.length ? failed : arr(item.checks).slice(0, 2);
    return `<div class="risk-item ${kind}">
      <div class="risk-top">
        <div class="q">${esc(short(item.question, 56))}</div>
        <span class="verdict ${kind}">${esc(item.verdict)}</span>
      </div>
      <div class="checks">
        ${shown.map(check => `<div class="check ${check.pass ? '' : 'bad'}">
          <span class="mark">${check.pass ? '✓' : '✕'}</span>
          <span class="name">${esc(check.name)}</span>
          <span>${esc(short(check.detail, 96))}</span>
        </div>`).join('')}
      </div>
      ${item.size ? `<div class="size-line">
        <span><b>${esc(item.size.shares)}</b> shares</span>
        <span>notional <b>${esc(money(item.size.notional, 2))}</b></span>
        <span>risk <b>${esc(money(item.size.risk_dollars, 2))}</b></span>
        <span>net R:R <b>${esc(num(item.size.net_rr))}</b></span>
      </div>` : ''}
      <details>
        <summary>${arr(item.checks).length} checks</summary>
        <div class="checks" style="margin-top:4px">
          ${arr(item.checks).map(check => `<div class="check ${check.pass ? '' : 'bad'}">
            <span class="mark">${check.pass ? '✓' : '✕'}</span>
            <span class="name">${esc(check.name)}</span>
            <span>${esc(check.detail)}</span>
          </div>`).join('')}
        </div>
      </details>
    </div>`;
  }).join('');

  const skippedNote = skipped
    ? `<div class="chip ghost">${skipped} plan(s) never reached the gate</div>`
    : '';
  host.innerHTML = (items || '<div class="risk-empty">No plan reached the risk gate in this run.</div>') + skippedNote;
}

function renderJournal() {
  const host = $('#journal-list');
  const entries = loadJournal();
  const open = entries.filter(entry => entry.outcome === 'pending').length;
  $('#journal-chip').textContent = `${open} pending`;
  $('#journal-chip').className = `chip ${open ? 'good' : 'ghost'}`;

  if (!entries.length) {
    host.innerHTML = '<div class="journal-empty">No paper entries yet. Approved plans can be logged from the decision panel. Outcomes are entered by hand after the fact — the desk does not claim to know a result it cannot see.</div>';
    return;
  }
  host.innerHTML = entries.slice(0, 20).map(entry => `
    <div class="journal-row">
      <div>
        <div class="q">${esc(short(entry.question, 62))}</div>
        <div class="meta">${esc(entry.side)} · ${esc(cents(entry.entry))} → ${esc(cents(entry.target))} · stop ${esc(cents(entry.invalidation))} · ${esc(entry.shares)} sh · ${esc(entry.source)}</div>
      </div>
      <select data-outcome="${esc(entry.id)}" aria-label="Outcome for ${esc(entry.question)}">
        ${['pending', 'win', 'loss', 'scratch', 'void'].map(value => `<option value="${value}" ${entry.outcome === value ? 'selected' : ''}>${value}</option>`).join('')}
      </select>
      <button class="btn btn-small btn-ghost" data-action="delete-entry" data-id="${esc(entry.id)}">remove</button>
    </div>`).join('') + `
    <div class="journal-actions">
      <button class="btn btn-small btn-ghost" data-action="download-journal-csv">CSV</button>
      <button class="btn btn-small btn-ghost" data-action="clear-journal">Clear all</button>
    </div>`;
}

function renderTerminal() {
  const log = $('#terminal-log');
  const select = $('#raw-select');
  const raw = $('#raw-json');
  const run = state.run;
  if (!run) {
    log.innerHTML = '<div class="log-empty">no run loaded · reports appear here after the first run</div>';
    raw.textContent = '';
    select.innerHTML = '<option>boss.json</option>';
    return;
  }
  const reports = run.reports || {};
  const lines = AGENTS.map(agent => {
    const report = reports[agent.key];
    if (!report) {
      return `<div class="log-line"><span class="ts">--:--:--</span><span class="stage">${agent.name.toUpperCase()}</span><span class="msg bad">not reached</span></div>`;
    }
    const bad = report.status !== 'complete';
    return `<div class="log-line">
      <span class="ts">${esc(timeOnly(report.timestamp_utc))}</span>
      <span class="stage">${agent.name.toUpperCase()}</span>
      <span class="msg ${bad ? 'bad' : ''}">${esc(report.status)} · ${esc(msText(run.stage_ms?.[agent.key]))} · ${esc(short(report.summary, 96))}</span>
    </div>`;
  }).join('');
  log.innerHTML = lines;

  const options = AGENTS.filter(agent => reports[agent.key]).map(agent => agent.key);
  if (!options.includes(state.raw)) state.raw = options.includes('boss') ? 'boss' : options[options.length - 1];
  select.innerHTML = options.map(key => `<option value="${key}" ${key === state.raw ? 'selected' : ''}>${key}.json</option>`).join('');
  raw.textContent = JSON.stringify(reports[state.raw] || {}, null, 2);
}

function renderLimits() {
  const host = $('#limits');
  const cfg = state.run?.config;
  if (!cfg) {
    host.innerHTML = '<div class="skeleton" style="grid-column:1/-1">Limits are read from the saved run config.</div>';
    return;
  }
  const cells = [
    ['mode', cfg.mode],
    ['live orders', cfg.allow_live_orders ? 'ENABLED' : 'off'],
    ['bankroll', money(cfg.bankroll)],
    ['risk / trade', `${cfg.max_position_risk_pct}%`],
    ['max exposure', `${cfg.max_total_exposure_pct}%`],
    ['max positions', cfg.max_positions],
    ['min liquidity', money(cfg.min_liquidity)],
    ['max spread', cfg.max_spread],
    ['min net R:R', cfg.min_net_rr],
    ['stop cap', cfg.max_stop_distance],
    ['cost buffer', `${cfg.cost_buffer_pct}%`],
    ['news', cfg.require_news ? 'required' : 'optional'],
  ];
  host.innerHTML = cells.map(([key, value]) => `
    <div class="limit-cell"><div class="k">${esc(key)}</div><div class="v ${key === 'live orders' && cfg.allow_live_orders ? 'warn' : ''}">${esc(value)}</div></div>`).join('');
}

/* ------------------------------------------------------------------ */
/* journal actions                                                     */
/* ------------------------------------------------------------------ */

function logTrade(index) {
  const run = state.run;
  const trade = run?.reports?.boss?.meta?.approved?.[index];
  if (!trade) return;
  const entries = loadJournal();
  const key = `${run.run_id}:${trade.market_id}:${trade.side}`;
  if (entries.some(entry => entry.key === key)) {
    toast('That plan is already in the journal.');
    return;
  }
  entries.unshift({
    key,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    run_id: run.run_id,
    source: run.source,
    logged_utc: new Date().toISOString(),
    market_id: trade.market_id,
    question: trade.question,
    url: trade.url || '',
    side: trade.side,
    entry: trade.entry,
    invalidation: trade.invalidation,
    target: trade.target,
    time_limit_utc: trade.time_limit_utc,
    shares: trade.shares,
    notional: trade.notional,
    risk_dollars: trade.risk_dollars,
    net_rr: trade.net_rr,
    confidence: trade.confidence,
    outcome: 'pending',
  });
  saveJournal(entries);
  renderJournal();
  toast('Logged to the paper journal. The outcome is entered by hand, later.');
}

function setOutcome(id, outcome) {
  saveJournal(loadJournal().map(entry => (
    entry.id === id ? { ...entry, outcome, closed_utc: new Date().toISOString() } : entry
  )));
  renderJournal();
}

function deleteEntry(id) {
  saveJournal(loadJournal().filter(entry => entry.id !== id));
  renderJournal();
  toast('Entry removed.');
}

function journalCsv(entries) {
  const columns = ['logged_utc', 'source', 'run_id', 'market_id', 'question', 'side', 'entry', 'invalidation',
    'target', 'shares', 'notional', 'risk_dollars', 'net_rr', 'confidence', 'outcome', 'time_limit_utc', 'url'];
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...entries.map(entry => columns.map(column => cell(entry[column])).join(','))].join('\n');
}

/* ------------------------------------------------------------------ */
/* render + events                                                     */
/* ------------------------------------------------------------------ */

function renderHeroStats() {
  const run = state.run;
  const paper = run?.paper || {};
  const meta = run?.reports?.boss?.meta || {};
  const counts = meta.counts || {};
  const decision = meta.decision || '';
  const kind = decision === 'APPROVE_FOR_PAPER_TEST' ? 'good'
    : decision === 'REJECT' ? 'bad' : decision === 'WAIT' ? 'wait' : '';
  const label = decision === 'APPROVE_FOR_PAPER_TEST' ? 'APPROVE' : decision || '—';

  const put = (id, text, className) => {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = text;
    if (className !== undefined) node.className = className;
  };

  put('stat-decision', label, `hero-stat-v ${kind}`.trim());
  put('stat-decision-meta', run
    ? `${arr(meta.approved).length} approved · ${num(counts.waits ?? 0, 0)} on wait`
    : 'six stages · one gate');

  const equity = Number(paper.equity);
  const bankroll = Number(run?.config?.bankroll ?? 100);
  put('stat-equity', money(Number.isFinite(equity) ? equity : bankroll, 2), 'hero-stat-v yellow');
  put('stat-equity-meta', run
    ? `${signedMoney(paper.total_pnl)} total P&L · ${Number(paper.return_pct) >= 0 ? '+' : ''}${num(paper.return_pct ?? 0, 2)}%`
    : 'simulated · never topped up');

  put('stat-universe', run?.universe?.size != null ? String(run.universe.size) : '—');
  put('stat-universe-meta', !run ? 'Gamma · 24h volume'
    : run.universe?.synthetic ? 'synthetic fixtures · labeled'
    : run.source === 'live' ? 'live Polymarket · 24h volume' : 'fixtures · read-only');

  put('stat-positions', run ? String(paper.open_count ?? 0) : '0');
  put('stat-positions-meta', run
    ? `${paper.closed_count ?? 0} closed · ${num(paper.win_rate ?? 0, 0)}% win rate`
    : 'one per market');

  const live = document.getElementById('mast-live');
  if (live) {
    live.textContent = !run ? 'PAPER RESEARCH TERMINAL'
      : run.source === 'live' ? 'LIVE · POLYMARKET' : 'FIXTURE BOARD · TEST DATA';
    live.className = `mast-live${run ? (run.source === 'live' ? ' is-live' : ' is-fixture') : ''}`;
  }
  put('hero-updated', run
    ? `last run ${String(run.run_id).slice(9, 15)}Z · ${run.source}`
    : 'awaiting the next live run');

  put('wall-equity-value', Number.isFinite(equity) ? money(equity, 2) : money(bankroll, 2));
  put('wall-pnl-value', run ? signedMoney(paper.total_pnl) : '$0.00');
}

function renderAll() {
  renderChrome();
  renderBanner();
  renderTicker();
  renderHero();
  renderHeroStats();
  renderKpis();
  renderExposure();
  renderBook();
  renderPipeline();
  renderCategories();
  renderScout();
  renderNews();
  renderCharts();
  renderStrategy();
  renderRisk();
  renderJournal();
  renderTerminal();
  renderLimits();
}

function bindEvents() {
  document.addEventListener('click', event => {
    const sourceButton = event.target.closest('.seg-btn');
    if (sourceButton) {
      if (state.status === 'running') { toast('Wait for the current run to finish.'); return; }
      state.source = sourceButton.dataset.source;
      localStorage.setItem(LS.source, state.source);
      renderChrome();
      renderBanner();
      return;
    }

    const scrollTarget = event.target.closest('[data-scroll]');
    if (scrollTarget) {
      const targets = { scout: 'scanner', news: 'newswire', charts: 'charts',
                        strategy: 'strategy', risk: 'risk', boss: 'overview' };
      document.getElementById(targets[scrollTarget.dataset.scroll])?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    if (action === 'run') runDesk();
    if (action === 'log-trade') logTrade(Number(actionEl.dataset.index));
    if (action === 'log-all') arr(state.run?.reports?.boss?.meta?.approved).forEach((_, index) => logTrade(index));
    if (action === 'copy-report') {
      if (!state.run) return;
      navigator.clipboard.writeText(JSON.stringify(state.run, null, 2))
        .then(() => toast('Full run copied as JSON.'))
        .catch(() => toast('Copy blocked by the browser. Use Download.'));
    }
    if (action === 'download-report') {
      if (!state.run) return;
      download(`opus-desk-${state.run.run_id}.json`, JSON.stringify(state.run, null, 2));
      toast('Run downloaded.');
    }
    if (action === 'download-journal') {
      download(`opus-desk-journal-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(loadJournal(), null, 2));
      toast('Journal downloaded.');
    }
    if (action === 'download-journal-csv') {
      download(`opus-desk-journal-${new Date().toISOString().slice(0, 10)}.csv`, journalCsv(loadJournal()), 'text/csv');
      toast('CSV downloaded.');
    }
    if (action === 'clear-journal') {
      if (window.confirm('Clear every journal entry? This cannot be undone.')) {
        saveJournal([]);
        renderJournal();
        toast('Journal cleared.');
      }
    }
    if (action === 'delete-entry') deleteEntry(actionEl.dataset.id);
  });

  document.addEventListener('change', event => {
    if (event.target.id === 'run-select') loadRun(event.target.value);
    if (event.target.id === 'raw-select') {
      state.raw = event.target.value;
      const report = state.run?.reports?.[state.raw];
      if (report) $('#raw-json').textContent = JSON.stringify(report, null, 2);
    }
    if (event.target.matches('[data-outcome]')) setOutcome(event.target.dataset.outcome, event.target.value);
  });

  $('#run').addEventListener('click', runDesk);
}

function startClock() {
  const tick = () => {
    $('#clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`;
  };
  tick();
  setInterval(tick, 1000);
}

function watchSections() {
  const links = $$('.rail-nav a');
  const sections = links
    .map(link => ({ link, section: document.querySelector(link.getAttribute('href')) }))
    .filter(entry => entry.section);
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const match = sections.find(item => item.section === entry.target);
      if (!match) return;
      links.forEach(link => link.classList.remove('active'));
      match.link.classList.add('active');
      $('#crumb').textContent = match.link.textContent.trim().toUpperCase();
    });
  }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 });
  sections.forEach(entry => observer.observe(entry.section));
}

async function boot() {
  bindEvents();
  startClock();
  watchSections();
  renderAll();
  await loadInitial();
}

boot();
