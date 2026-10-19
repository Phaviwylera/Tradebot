/*
 * app.js — dashboard for the Opus Agent Desk.
 *
 * Reads saved runs from the Python runner (/api/latest, /api/reports/<id>) and renders the six
 * stage reports. When served by `python main.py --serve`, the Run button executes the same
 * pipeline through POST /api/run. On static hosting it falls back to the committed snapshot in
 * /reports/latest.json and disables the run action.
 *
 * This file contains no order, wallet, key or signing code.
 */

const $ = selector => document.querySelector(selector);

const AGENTS = [
  { key: 'scout', num: '01', name: 'Scout', role: 'unusual price, volume and movement' },
  { key: 'news', num: '02', name: 'News', role: 'dated sources, claims vs speculation' },
  { key: 'charts', num: '03', name: 'Charts', role: 'trend, momentum, support, resistance' },
  { key: 'strategy', num: '04', name: 'Strategy', role: 'one setup with clear rules' },
  { key: 'risk', num: '05', name: 'Risk', role: 'size, veto and hard limits' },
  { key: 'boss', num: '06', name: 'Boss', role: 'one final decision' },
];

const DECISION_LABEL = {
  APPROVE_FOR_PAPER_TEST: 'APPROVE FOR PAPER TEST',
  WAIT: 'WAIT',
  REJECT: 'REJECT',
};

const LS = { journal: 'opus-desk-journal-v1', source: 'opus-desk-source-v1' };

const state = {
  source: 'fixture',
  apiAvailable: false,
  status: 'loading', // loading | idle | running | done | error
  run: null,
  index: [],
  error: null,
  staticOnly: false,
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

function arr(value) {
  return Array.isArray(value) ? value : [];
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

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}¢` : '—';
}

function num(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function timeOnly(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(11, 19) + 'Z';
}

function dateTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
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

function ms(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n} ms` : '—';
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
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

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
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
  renderChrome();
  await detectApi();

  const savedSource = localStorage.getItem(LS.source);
  if (savedSource === 'live' || savedSource === 'fixture') state.source = savedSource;

  let run = null;
  let index = [];
  if (state.apiAvailable) {
    try {
      const payload = await getJson('/api/latest');
      run = payload.run;
    } catch {
      run = null;
    }
    try {
      const payload = await getJson('/api/reports');
      index = arr(payload.runs);
    } catch {
      index = [];
    }
  } else {
    state.staticOnly = true;
    try {
      run = await getJson('/reports/latest.json');
    } catch {
      run = null;
    }
    try {
      const payload = await getJson('/reports/index.json');
      index = arr(payload.runs);
    } catch {
      index = [];
    }
  }

  state.run = run && run.reports ? run : null;
  state.index = index;
  state.status = state.run ? 'done' : 'idle';
  renderAll();
}

async function loadRun(runId) {
  if (!runId) return;
  if (!state.apiAvailable) {
    toast('Static hosting only includes the latest snapshot. Run main.py to browse older runs.');
    return;
  }
  state.status = 'loading';
  renderChrome();
  try {
    const payload = await getJson(`/api/reports/${encodeURIComponent(runId)}`);
    state.run = payload.run;
    state.status = 'done';
    state.error = null;
  } catch (error) {
    state.status = 'error';
    state.error = `Could not load run ${runId}: ${error.message}`;
  }
  renderAll();
}

async function runDesk() {
  if (state.status === 'running') return;
  if (!state.apiAvailable) {
    toast('No API here. Run `python main.py --serve` to execute the desk.');
    return;
  }
  state.status = 'running';
  state.error = null;
  renderChrome();
  renderVerdict();
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
    try {
      const idx = await getJson('/api/reports');
      state.index = arr(idx.runs);
    } catch {
      /* the run itself succeeded; the history list is optional */
    }
    toast(`${DECISION_LABEL[payload.decision] || payload.decision} · run saved`);
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
  document.querySelectorAll('.seg-btn').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.source === state.source ? 'true' : 'false');
    button.disabled = state.status === 'running';
  });
  const button = $('#run');
  const running = state.status === 'running';
  button.disabled = running || !state.apiAvailable;
  button.classList.toggle('running', running);
  button.title = state.apiAvailable ? 'Run the six-stage pipeline' : 'Run python main.py --serve to enable';
  $('#run-label').textContent = running ? 'Running…' : 'Run desk';
  const run = state.run;
  $('#footer-meta').textContent = run
    ? `${run.source} · ${run.run_id} · validation ${run.validation?.ok ? 'passed' : 'unknown'}`
    : 'no run loaded';
}

function renderBanner() {
  const el = $('#banner');
  el.className = 'banner';
  const run = state.run;
  if (state.status === 'error') {
    el.classList.add('error');
    el.innerHTML = `<span><strong>Run failed.</strong> ${esc(state.error || 'unknown error')}
      ${state.apiAvailable ? '' : ' Start the local server with <code>python main.py --serve</code> to execute the desk.'}</span>`;
    return;
  }
  if (state.status === 'loading' && !run) {
    el.innerHTML = '<span>Loading saved reports…</span>';
    return;
  }
  const noData = Boolean(run) && (run.universe?.size ?? 0) === 0;
  const synthetic = run ? Boolean(run.universe?.synthetic) : state.source === 'fixture';
  if (noData) {
    el.classList.add('error');
    el.innerHTML = `<span><strong>No market data loaded.</strong> The pipeline halted at Scout and the Boss returned WAIT.
      A missing feed is a result, not something to paper over. Check the Scout report for the exact error, then re-run.</span>`;
  } else if (synthetic) {
    el.classList.add('test');
    el.innerHTML = `<span><strong>Synthetic fixture board.</strong> The ${run ? run.universe?.size ?? 0 : 520} markets, prices and headlines are generated by the repo's seeded generator and labelled TEST DATA.
      This exercises the workflow; it is not a real market and not a forecast.</span>`;
  } else {
    el.classList.add('live');
    el.innerHTML = `<span><strong>Live public data.</strong> Read-only Polymarket quotes, CLOB price history and Google News RSS headlines. Prices can lag, sources can be thin, and no order can be placed from this page.</span>`;
  }
  if (state.staticOnly) {
    el.insertAdjacentHTML('beforeend',
      '<span class="static-note">Static copy: showing the last committed snapshot. Run <code>python main.py --serve</code> to execute the pipeline.</span>');
  }
}

function renderStats() {
  const run = state.run;
  const reports = run?.reports || {};
  const scout = reports.scout;
  const strategy = reports.strategy;
  const risk = reports.risk;
  const boss = reports.boss;
  const counts = boss?.meta?.counts || {};
  const decision = boss?.meta?.decision;

  const decisionWord = decision === 'APPROVE_FOR_PAPER_TEST' ? 'APPROVE'
    : decision === 'WAIT' ? 'WAIT'
      : decision === 'REJECT' ? 'REJECT'
        : state.status === 'running' ? 'RUNNING' : '—';
  const decisionClass = decision === 'APPROVE_FOR_PAPER_TEST' ? 'approve'
    : decision === 'WAIT' ? 'wait'
      : decision === 'REJECT' ? 'reject'
        : state.status === 'running' ? 'live' : '';

  const tiles = [
    { k: 'Universe scanned', v: run?.universe?.size?.toLocaleString?.('en-US') ?? '—',
      s: run ? (run.source_detail || '').slice(0, 48) : 'waiting for a run', accent: 'live' },
    { k: 'Watchlist', v: scout ? arr(scout.evidence).length : '—',
      s: scout ? `${scout.meta?.scored_count ?? '—'} passed quality filters` : 'stage 1' },
    { k: 'Plans written', v: strategy ? counts.plans ?? 0 : '—',
      s: strategy ? `${counts.waits ?? 0} returned WAIT` : 'stage 4' },
    { k: 'Risk cleared', v: risk ? counts.risk_passed ?? 0 : '—',
      s: risk ? `${counts.risk_rejected ?? 0} rejected at the gate` : 'stage 5' },
    { k: 'Final decision', v: decisionWord, s: decision ? 'paper test only' : 'the Boss has the last word', accent: decisionClass },
  ];

  $('#statbar').innerHTML = tiles.map(tile => `
    <div class="stat ${tile.accent || ''}">
      <div class="k"><span>${esc(tile.k)}</span></div>
      <div class="v">${esc(tile.v)}</div>
      <div class="s">${esc(tile.s)}</div>
    </div>`).join('');
}

function stageStatus(key) {
  const run = state.run;
  if (!run) return state.status === 'running' ? 'running' : 'queued';
  const report = run.reports?.[key];
  if (!report) return 'skipped';
  if (report.status === 'complete') return 'done';
  if (report.status === 'rejected') return 'fail';
  return 'halt';
}

const STAGE_TEXT = {
  done: 'complete', halt: 'needs data', fail: 'rejected',
  running: 'working', queued: 'queued', skipped: 'not reached',
};

function renderPipeline() {
  const run = state.run;
  $('#pipeline').innerHTML = AGENTS.map(agent => {
    const status = stageStatus(agent.key);
    const duration = run?.stage_ms?.[agent.key];
    return `<button type="button" class="pipe-node ${status}" data-scroll="${agent.key}" title="${esc(agent.role)}">
      <span class="pipe-num">${agent.num}</span>
      <span class="pipe-meta">
        <span class="pipe-name">${esc(agent.name)}</span>
        <span class="pipe-status">${esc(STAGE_TEXT[status] || status)}${duration != null ? ` · ${esc(ms(duration))}` : ''}</span>
      </span>
    </button>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  const el = $('#verdict');
  const run = state.run;
  if (state.status === 'running') {
    el.innerHTML = `
      <div class="verdict-head"><span class="k">Boss · final decision</span><span class="pill running">running</span></div>
      <div class="verdict-body">
        <div class="decision running"><span class="dot"></span>Working the desk…</div>
        <p class="explain">Scout → News → Charts → Strategy → Risk → Boss. The report appears when all six stages finish.</p>
      </div>`;
    return;
  }
  if (!run) {
    el.innerHTML = `
      <div class="verdict-head"><span class="k">Boss · final decision</span><span class="pill neutral">no run</span></div>
      <div class="verdict-body">
        <div class="decision idle"><span class="dot"></span>Nothing loaded</div>
        <p class="explain">Run the desk to produce a decision, or start the server with <code>python main.py --serve</code>.</p>
        <div class="verdict-actions"><button class="btn btn-primary btn-small" data-action="run">Run desk</button></div>
      </div>`;
    return;
  }

  const boss = run.reports.boss || {};
  const meta = boss.meta || {};
  const decision = meta.decision;
  const className = decision === 'APPROVE_FOR_PAPER_TEST' ? 'approve'
    : decision === 'WAIT' ? 'wait' : 'reject';
  const approved = arr(meta.approved);

  el.innerHTML = `
    <div class="verdict-head">
      <span class="k">Boss · final decision</span>
      <span class="pill ${className}">${esc(DECISION_LABEL[decision] || decision)}</span>
    </div>
    <div class="verdict-body">
      <div class="decision ${className}"><span class="dot"></span>${esc(DECISION_LABEL[decision] || decision)}</div>
      <p class="explain">${esc(boss.summary)}</p>
      <div class="verdict-counts">
        <div><div class="k">plans</div><div class="v">${meta.counts?.plans ?? 0}</div></div>
        <div><div class="k">risk passed</div><div class="v">${meta.counts?.risk_passed ?? 0}</div></div>
        <div><div class="k">rejected</div><div class="v">${meta.counts?.risk_rejected ?? 0}</div></div>
      </div>
      <div class="integrity">
        ${arr(meta.integrity).map(check => `
          <div class="check ${check.pass ? '' : 'bad'}">
            <span class="mark">${check.pass ? '✓' : '✕'}</span>
            <span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span>
          </div>`).join('')}
      </div>
      ${approved.length ? `<div class="approved-list">
        ${approved.map((trade, index) => `
          <div class="approved">
            <div class="q">${esc(trade.question)}</div>
            <div class="row">
              <span>side <b>${esc(trade.side)}</b></span>
              <span>entry <b>${esc(cents(trade.entry))}</b></span>
              <span>stop <b>${esc(cents(trade.invalidation))}</b></span>
              <span>target <b>${esc(cents(trade.target))}</b></span>
            </div>
            <div class="row">
              <span>${esc(trade.shares)} shares · ${esc(money(trade.notional, 2))}</span>
              <span>risk <b>${esc(money(trade.risk_dollars, 2))}</b></span>
              <span>net R:R <b>${esc(num(trade.net_rr))}</b></span>
              <span>by ${esc(dateTime(trade.time_limit_utc))}</span>
            </div>
            <div class="verdict-actions">
              <button class="btn btn-small" data-action="log-trade" data-index="${index}">Log to paper journal</button>
            </div>
          </div>`).join('')}
      </div>` : ''}
      ${arr(meta.disagreements).length ? `<div class="details"><details>
        <summary>${meta.disagreements.length} unresolved disagreement(s)</summary>
        <ul class="reason-list">${meta.disagreements.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
      </details></div>` : ''}
      <div class="verdict-meta">
        <span>run ${esc(run.run_id)} · ${esc(timeOnly(run.started_utc))} → ${esc(timeOnly(run.finished_utc))} · ${esc(ms(run.duration_ms))}</span>
        <span>source: ${esc(run.source)}${run.universe?.synthetic ? ' · synthetic' : ''} · validation ${run.validation?.ok ? 'passed' : '—'}</span>
        <span>contracts: ${esc(Object.keys(run.contracts || {}).length)} loaded</span>
      </div>
      <div class="verdict-actions">
        ${approved.length ? '<button class="btn btn-small btn-ghost" data-action="log-all">Log all approved</button>' : ''}
        <button class="btn btn-small btn-ghost" data-action="copy-report">Copy report</button>
        <button class="btn btn-small btn-ghost" data-action="download-report">Download JSON</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* report bodies                                                       */
/* ------------------------------------------------------------------ */

function flagList(report) {
  return arr(report?.risks).length
    ? `<div class="halt-note"><strong>Flags</strong><ul class="reason-list">${report.risks.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>`
    : '';
}

function scoutBody(report) {
  const meta = report.meta || {};
  const rows = arr(report.evidence);
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">universe</div><div class="v">${Number(meta.universe_size || 0).toLocaleString('en-US')}</div><div class="s">${esc(meta.universe_source || '')}</div></div>
      <div class="meta-box"><div class="k">passed filters</div><div class="v">${meta.scored_count ?? '—'}</div><div class="s">${meta.excluded?.quality ?? 0} failed quality</div></div>
      <div class="meta-box"><div class="k">watchlist</div><div class="v">${rows.length}</div><div class="s">top activity scores</div></div>
      <div class="meta-box"><div class="k">low signal</div><div class="v">${meta.excluded?.low_signal ?? '—'}</div><div class="s">below activity floor</div></div>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Market</th><th class="right">Score</th><th class="right">1h</th><th class="right">24h</th><th class="right">Volume</th><th class="right">Liquidity</th><th class="right">Spread</th><th class="right">Ends</th></tr></thead>
      <tbody>${rows.map((item, index) => {
        const metrics = item.metrics || {};
        return `<tr>
          <td class="num dim">${index + 1}</td>
          <td class="qcell">
            <span class="q">${esc(item.question)}</span>
            <div class="plan-foot">
              <span class="chip ghost">${esc(item.category || 'other')}</span>
              <span class="chip ghost">${esc(cents(item.price))}</span>
              ${item.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
            </div>
            ${arr(item.reasons).length ? `<div class="small muted" style="margin-top:3px">${esc(item.reasons[0])}</div>
              <details><summary>All ${item.reasons.length} reason(s)</summary>
                <ul class="reason-list">${item.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>
              </details>` : ''}
          </td>
          <td class="num right">${item.score ?? '—'}<div class="bar"><i style="width:${Math.min(100, Number(item.score) || 0)}%"></i></div></td>
          <td class="num right ${Number(metrics.move_1h) >= 0 ? 'pos' : 'neg'}">${esc(pct(metrics.move_1h, 1, true))}</td>
          <td class="num right ${Number(metrics.move_24h) >= 0 ? 'pos' : 'neg'}">${esc(pct(metrics.move_24h, 1, true))}</td>
          <td class="num right">${esc(compact(metrics.volume_24h))}</td>
          <td class="num right">${esc(compact(metrics.liquidity))}</td>
          <td class="num right">${esc(cents(metrics.spread))}</td>
          <td class="num right">${esc(until(item.ends_at))}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>` : '<div class="halt-note">No market cleared the activity floor. The desk will not invent one.</div>'}
    ${flagList(report)}
    ${meta.methodology ? `<p class="config-note">${esc(meta.methodology)}</p>` : ''}`;
}

function newsBody(report) {
  const meta = report.meta || {};
  const rows = arr(report.evidence);
  if (!rows.length) return `<div class="halt-note">No watchlist reached the news stage.</div>${flagList(report)}`;
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">markets checked</div><div class="v">${meta.fetched ?? rows.length}</div><div class="s">${meta.failed || 0} fetch failures</div></div>
      <div class="meta-box"><div class="k">with sources</div><div class="v">${meta.markets_with_sources ?? '—'}</div><div class="s">at least one usable headline</div></div>
      <div class="meta-box"><div class="k">rule</div><div class="v">${meta.require_news ? 'required' : 'optional'}</div><div class="s">fresh dated source needed</div></div>
    </div>
    <div class="plan-list">
      ${rows.map(item => `
        <div class="plan">
          <div class="plan-top">
            <div class="q">${esc(item.question)}</div>
            <span class="pill ${item.fresh_count > 0 ? 'done' : 'halt'}">${item.fresh_count > 0 ? 'sourced' : 'no source'}</span>
          </div>
          <div class="plan-foot">
            <span class="chip ${item.fresh_count > 0 ? 'good' : 'bad'}">${item.fresh_count ?? 0} fresh</span>
            <span class="chip">${item.source_count ?? 0} source(s)</span>
            <span class="chip">${item.direct_count ?? 0} direct</span>
            <span class="chip ghost">tone: ${esc(item.tone || 'unknown')}</span>
            <span class="chip ${item.event_risk === 'high' ? 'bad' : item.event_risk === 'medium' ? 'warn' : 'ghost'}">event risk: ${esc(item.event_risk || 'unknown')}</span>
            ${arr(item.flags).filter(flag => flag !== 'SYNTHETIC_HEADLINES').map(flag => `<span class="chip warn">${esc(flag)}</span>`).join('')}
          </div>
          ${arr(item.items).length ? `
            <div class="headlines">
              ${item.items.slice(0, 2).map(headline => `
                <div class="headline">
                  <a class="title" href="${esc(headline.link || '#')}" target="_blank" rel="noopener noreferrer">${esc(headline.title)}</a>
                  <div class="plan-foot">
                    <span class="chip ghost">${esc(headline.source || 'unattributed')}</span>
                    <span class="chip ${headline.stale ? 'warn' : 'ghost'}">${headline.age_hours == null ? 'no date' : `${esc(headline.age_hours)}h old`}</span>
                    <span class="chip ${headline.relevance === 'direct' ? 'good' : 'ghost'}">${esc(headline.relevance)}</span>
                    <span class="chip ${headline.speculative ? 'warn' : 'ghost'}">${headline.speculative ? 'speculative' : 'reported'}</span>
                    ${headline.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
                  </div>
                </div>`).join('')}
            </div>
            <div class="details"><details>
              <summary>All ${item.items.length} headline(s) · query “${esc(item.query || '—')}”</summary>
              <div class="plan-list" style="margin-top:8px">
                ${item.items.slice(2).map(headline => `
                  <div class="headline">
                    <a class="title" href="${esc(headline.link || '#')}" target="_blank" rel="noopener noreferrer">${esc(headline.title)}</a>
                    <div class="plan-foot">
                      <span class="chip ghost">${esc(headline.source || 'unattributed')}</span>
                      <span class="chip ${headline.stale ? 'warn' : 'ghost'}">${headline.age_hours == null ? 'no date' : `${esc(headline.age_hours)}h old`}</span>
                      <span class="chip ${headline.relevance === 'direct' ? 'good' : 'ghost'}">${esc(headline.relevance)}</span>
                    </div>
                  </div>`).join('') || '<p class="config-note">No further headlines.</p>'}
              </div>
            </details></div>` : '<p class="config-note">No usable dated headline. This market cannot receive a plan while news is required.</p>'}
        </div>`).join('')}
    </div>
    ${flagList(report)}
    ${meta.headline_policy ? `<p class="config-note">${esc(meta.headline_policy)}</p>` : ''}`;
}

function sparkline(points, levels = []) {
  const data = arr(points).map(Number).filter(Number.isFinite);
  if (data.length < 2) return '';
  const width = 100;
  const height = 44;
  const pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 0.01;
  const x = index => pad + (index / (data.length - 1)) * (width - pad * 2);
  const y = value => pad + (1 - (value - min) / span) * (height - pad * 2);
  const line = data.map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(2)},${height - pad} L${x(0).toFixed(2)},${height - pad} Z`;
  const guides = levels.map(Number).filter(level => Number.isFinite(level) && level >= min && level <= max)
    .slice(0, 2)
    .map(level => `<line x1="${pad}" x2="${width - pad}" y1="${y(level).toFixed(2)}" y2="${y(level).toFixed(2)}" />`)
    .join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="fill" d="${area}" fill="rgba(61,219,198,0.08)"></path>
    <path class="line" d="${line}"></path>${guides}
  </svg>`;
}

function trendPill(trend) {
  if (trend === 'up') return '<span class="pill approve">uptrend</span>';
  if (trend === 'down') return '<span class="pill reject">downtrend</span>';
  return '<span class="pill neutral">range</span>';
}

function chartsBody(report) {
  const meta = report.meta || {};
  const rows = arr(report.evidence).filter(item => item.status === 'complete');
  if (!rows.length) return `<div class="halt-note">No usable price series. The desk will not describe a chart it cannot see.</div>${flagList(report)}`;
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">series reviewed</div><div class="v">${meta.reviewed ?? rows.length}</div><div class="s">${meta.needs_data || 0} short of data</div></div>
      <div class="meta-box"><div class="k">conflicts</div><div class="v">${meta.conflicts_total ?? 0}</div><div class="s">blocking signals</div></div>
      <div class="meta-box"><div class="k">warnings</div><div class="v">${meta.warnings_total ?? 0}</div><div class="s">noise, extension</div></div>
    </div>
    <div class="chart-grid">
      ${rows.map(item => {
        const view = item.views?.primary;
        if (!view) return '';
        const levels = [...arr(view.levels?.support), ...arr(view.levels?.resistance)];
        return `<div class="chart-card">
          <div class="top"><div class="q">${esc(item.question)}</div>${trendPill(view.trend)}</div>
          ${sparkline(item.sparkline, levels)}
          <div class="chart-stats">
            <div><div class="k">last</div><div class="v">${esc(cents(view.last))}</div></div>
            <div><div class="k">1h mom</div><div class="v ${Number(view.momentum_1h) >= 0 ? 'pos' : 'neg'}">${esc(cents(view.momentum_1h))}</div></div>
            <div><div class="k">bar range</div><div class="v">${esc(pct(view.atr_pct, 1))}</div></div>
          </div>
          <div class="levels">
            ${arr(view.levels?.support).map(level => `<span class="chip good">S ${esc(cents(level))}</span>`).join('')}
            ${arr(view.levels?.resistance).map(level => `<span class="chip bad">R ${esc(cents(level))}</span>`).join('')}
            ${view.structure_break ? `<span class="chip warn">break ${esc(view.structure_break)}</span>` : ''}
            <span class="chip ghost">${esc(item.primary_outcome || 'primary')}</span>
          </div>
          ${arr(item.conflicts).length ? `<ul class="reason-list conflicts">${item.conflicts.map(conflict => `<li>${esc(conflict)}</li>`).join('')}</ul>` : ''}
          ${arr(item.warnings).length ? `<div class="warnings">${item.warnings.map(warning => esc(warning)).join(' · ')}</div>` : ''}
          <p class="config-note">${esc(item.timeframe)} · ${esc(item.series_source || '')} · ${item.data_quality?.points ?? '—'} bars</p>
        </div>`;
      }).join('')}
    </div>
    ${flagList(report)}
    ${meta.methodology ? `<p class="config-note">${esc(meta.methodology)}</p>` : ''}`;
}

function strategyBody(report) {
  const meta = report.meta || {};
  const rows = arr(report.evidence);
  const plans = rows.filter(item => item.status === 'plan');
  const waits = rows.filter(item => item.status !== 'plan');
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">reviewed</div><div class="v">${meta.reviewed ?? rows.length}</div><div class="s">markets with charts</div></div>
      <div class="meta-box"><div class="k">plans</div><div class="v">${plans.length}</div><div class="s">clear rules only</div></div>
      <div class="meta-box"><div class="k">waits</div><div class="v">${waits.length}</div><div class="s">no forced setups</div></div>
    </div>
    ${plans.length ? `<div class="plan-list">
      ${plans.map(plan => `
        <div class="plan ready">
          <div class="plan-top"><div class="q">${esc(plan.question)}</div><span class="side-badge">${esc(plan.side)}</span></div>
          <div class="plan-grid">
            <div><div class="k">entry</div><div class="v">${esc(cents(plan.entry))}</div></div>
            <div><div class="k">invalidation</div><div class="v" style="color:var(--red)">${esc(cents(plan.invalidation))}</div></div>
            <div><div class="k">target</div><div class="v" style="color:var(--green)">${esc(cents(plan.target))}</div></div>
            <div><div class="k">gross R:R</div><div class="v">${esc(num(plan.gross_rr))}</div></div>
          </div>
          <div class="plan-trigger"><strong>Entry trigger:</strong> ${esc(plan.entry_trigger)}</div>
          <div class="plan-trigger"><strong>Time limit:</strong> ${esc(dateTime(plan.time_limit_utc))} · <strong>type:</strong> ${esc(plan.entry_type)}</div>
          <div class="plan-foot">
            <span class="chip">zone ${esc(cents(plan.entry_zone?.[0]))} – ${esc(cents(plan.entry_zone?.[1]))}</span>
            <span class="chip ghost">${esc(plan.evidence_used?.chart_trend || 'n/a')}</span>
            <span class="chip ghost">${plan.evidence_used?.news_count ?? 0} fresh source(s)</span>
            <span class="confidence">confidence ${plan.confidence ?? '—'}<span class="bar"><i style="width:${Math.min(100, Number(plan.confidence) || 0)}%"></i></span></span>
          </div>
          ${arr(plan.disagreements).length ? `<div class="conflicts">⚠ ${plan.disagreements.map(item => esc(item)).join(' · ')}</div>` : ''}
        </div>`).join('')}
    </div>` : '<div class="halt-note">No plan was forced. Every reviewed market returned WAIT.</div>'}
    ${waits.length ? `<div class="details"><details>
      <summary>${waits.length} market(s) returned WAIT — reasons</summary>
      <div class="table-wrap" style="margin-top:8px"><table>
        <thead><tr><th>Market</th><th>Why it is not a plan</th></tr></thead>
        <tbody>${waits.map(item => `<tr><td class="qcell">${esc(item.question)}</td><td class="muted small">${esc(item.reason || 'no setup')}</td></tr>`).join('')}</tbody>
      </table></div>
    </details></div>` : ''}
    ${flagList(report)}
    ${meta.policy ? `<p class="config-note">${esc(meta.policy)}</p>` : ''}`;
}

function riskBody(report) {
  const meta = report.meta || {};
  const rows = arr(report.evidence);
  const reviewed = rows.filter(item => item.verdict !== 'NOT_REVIEWED');
  const skipped = rows.filter(item => item.verdict === 'NOT_REVIEWED');
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">cleared</div><div class="v" style="color:var(--green)">${meta.passed ?? 0}</div><div class="s">passed or reduced</div></div>
      <div class="meta-box"><div class="k">rejected</div><div class="v" style="color:var(--red)">${meta.rejected ?? 0}</div><div class="s">failed a hard check</div></div>
      <div class="meta-box"><div class="k">exposure</div><div class="v">${esc(money(meta.exposure_used, 2))}</div><div class="s">of ${esc(money(meta.exposure_limit, 0))} cap</div></div>
      <div class="meta-box"><div class="k">risk committed</div><div class="v">${esc(money(meta.risk_committed, 2))}</div><div class="s">this run</div></div>
    </div>
    ${reviewed.length ? `<div class="plan-list">
      ${reviewed.map(item => {
        const failed = arr(item.checks).filter(check => !check.pass);
        const verdictClass = item.verdict === 'REJECTED' ? 'reject' : item.verdict === 'REDUCED' ? 'wait' : 'approve';
        return `<div class="plan ${item.verdict === 'REJECTED' ? '' : 'ready'}">
          <div class="plan-top"><div class="q">${esc(item.question)}</div><span class="pill ${verdictClass}">${esc(item.verdict)}</span></div>
          ${item.side ? `<div class="plan-foot"><span class="side-badge">${esc(item.side)}</span>${item.size ? `<span class="chip ghost">${esc(item.size.shares)} shares</span>` : ''}</div>` : ''}
          ${failed.length ? `<div class="checks">${failed.map(check => `<div class="check bad"><span class="mark">✕</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}</div>`
            : '<div class="checks"><div class="check"><span class="mark">✓</span><span>every check passed</span></div></div>'}
          ${item.size ? `<div class="size-grid">
            <div><div class="k">shares</div><div class="v">${esc(item.size.shares)}</div></div>
            <div><div class="k">notional</div><div class="v">${esc(money(item.size.notional, 2))}</div></div>
            <div><div class="k">risk</div><div class="v">${esc(money(item.size.risk_dollars, 2))}</div></div>
            <div><div class="k">net R:R</div><div class="v">${esc(num(item.size.net_rr))}</div></div>
          </div>` : ''}
          <div class="details"><details>
            <summary>All ${arr(item.checks).length} check(s) and cost model</summary>
            <div class="checks" style="margin-top:8px">
              ${arr(item.checks).map(check => `<div class="check ${check.pass ? '' : 'bad'}"><span class="mark">${check.pass ? '✓' : '✕'}</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}
            </div>
            ${item.size ? `<p class="config-note">cost ${esc(num(item.size.cost_per_share, 4))}/share · max loss ${esc(item.size.max_loss_pct_of_bankroll)}% of bankroll · exposure after ${esc(money(item.size.exposure_after, 2))}</p>` : ''}
          </details></div>
        </div>`;
      }).join('')}
    </div>` : '<div class="halt-note">No plan reached the risk gate in this run.</div>'}
    ${skipped.length ? `<div class="details"><details>
      <summary>${skipped.length} plan(s) never reached the gate</summary>
      <ul class="reason-list">${skipped.map(item => `<li>${esc(item.question)} — ${esc(arr(item.reasons)[0] || 'no plan')}</li>`).join('')}</ul>
    </details></div>` : ''}
    ${flagList(report)}
    ${meta.policy ? `<p class="config-note">${esc(meta.policy)}</p>` : ''}`;
}

function bossBody(report) {
  const meta = report.meta || {};
  const decision = meta.decision;
  const className = decision === 'APPROVE_FOR_PAPER_TEST' ? 'approve' : decision === 'WAIT' ? 'wait' : 'reject';
  return `
    <div class="decision-banner ${className}">
      <div class="k">final status</div>
      <div class="d">${esc(DECISION_LABEL[decision] || decision)}</div>
      <p>${esc(report.summary)}</p>
    </div>
    <div class="meta-grid">
      <div class="meta-box"><div class="k">approved</div><div class="v">${arr(meta.approved).length}</div><div class="s">paper plans</div></div>
      <div class="meta-box"><div class="k">risk passed</div><div class="v">${meta.counts?.risk_passed ?? 0}</div><div class="s">of ${meta.counts?.plans ?? 0} plans</div></div>
      <div class="meta-box"><div class="k">waits</div><div class="v">${meta.counts?.waits ?? 0}</div><div class="s">no forced setups</div></div>
      <div class="meta-box"><div class="k">disagreements</div><div class="v">${arr(meta.disagreements).length}</div><div class="s">sent here, not averaged</div></div>
    </div>
    <div class="integrity">
      ${arr(meta.integrity).map(check => `<div class="check ${check.pass ? '' : 'bad'}"><span class="mark">${check.pass ? '✓' : '✕'}</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}
    </div>
    ${arr(meta.approved).length ? `<div class="approved-list">
      ${meta.approved.map((trade, index) => `
        <div class="approved">
          <div class="q">${esc(trade.question)}</div>
          <div class="row">
            <span><b>${esc(trade.side)}</b></span>
            <span>entry ${esc(cents(trade.entry))}</span>
            <span>stop ${esc(cents(trade.invalidation))}</span>
            <span>target ${esc(cents(trade.target))}</span>
            <span>${esc(trade.shares)} shares</span>
            <span>net R:R ${esc(num(trade.net_rr))}</span>
          </div>
          <div class="verdict-actions"><button class="btn btn-small" data-action="log-trade" data-index="${index}">Log to paper journal</button></div>
        </div>`).join('')}
    </div>` : ''}
    <p class="config-note">${esc(meta.final_word || '')}</p>`;
}

function agentBody(key, report) {
  if (key === 'scout') return scoutBody(report);
  if (key === 'news') return newsBody(report);
  if (key === 'charts') return chartsBody(report);
  if (key === 'strategy') return strategyBody(report);
  if (key === 'risk') return riskBody(report);
  if (key === 'boss') return bossBody(report);
  return '';
}

function renderAgents() {
  const host = $('#agents');
  const run = state.run;
  if (!run) {
    host.innerHTML = EMPTY_MARKUP;
    $('#empty-hint').textContent = state.apiAvailable
      ? 'No saved runs yet. Run the desk to produce six timestamped reports.'
      : 'No saved runs, and no API in this deployment. Start the local server with python main.py --serve.';
    return;
  }

  host.innerHTML = AGENTS.map(agent => {
    const report = run.reports?.[agent.key];
    const status = stageStatus(agent.key);
    if (!report) {
      return `<article class="card agent" id="agent-${agent.key}">
        <div class="agent-head">
          <span class="agent-num">${agent.num}</span>
          <div class="agent-title"><h3>${esc(agent.name)}</h3><div class="agent-role">${esc(agent.role)}</div></div>
          <div class="agent-head-right"><span class="pill neutral">not reached</span></div>
        </div>
        <div class="agent-body"><p class="agent-summary dim">The pipeline stopped before this stage. No report means no decision.</p></div>
      </article>`;
    }
    const decision = agent.key === 'boss' ? report.meta?.decision : null;
    const statusPill = decision
      ? `<span class="pill ${decision === 'APPROVE_FOR_PAPER_TEST' ? 'approve' : decision === 'WAIT' ? 'wait' : 'reject'}">${esc(DECISION_LABEL[decision] || decision)}</span>`
      : `<span class="pill ${status === 'done' ? 'done' : status === 'halt' ? 'halt' : 'fail'}">${esc(STAGE_TEXT[status] || status)}</span>`;
    return `<article class="card agent" id="agent-${agent.key}">
      <div class="agent-head">
        <span class="agent-num">${agent.num}</span>
        <div class="agent-title"><h3>${esc(agent.name)}</h3><div class="agent-role">${esc(agent.role)}</div></div>
        <div class="agent-head-right">
          ${statusPill}
          <span class="agent-meta">${esc(timeOnly(report.timestamp_utc))}${run.stage_ms?.[agent.key] != null ? ` · ${esc(ms(run.stage_ms[agent.key]))}` : ''}</span>
        </div>
      </div>
      <div class="agent-body">
        <p class="agent-summary">${esc(report.summary)}</p>
        ${agentBody(agent.key, report)}
        <div class="details"><details>
          <summary>Raw ${esc(agent.name)} report (JSON)</summary>
          <pre>${esc(JSON.stringify(report, null, 2))}</pre>
        </details></div>
      </div>
    </article>`;
  }).join('');
}

const EMPTY_MARKUP = `
  <div class="empty" id="empty-state">
    <p class="eyebrow">Ready</p>
    <h2>Scan the board. Let risk say no.</h2>
    <p class="lead">Scout ranks unusual activity across the market universe. News attaches dated sources.
      Charts describes trend and structure. Strategy writes one conditional plan per candidate. Risk can veto
      any plan. Boss returns one status: approve for paper test, wait, or reject.</p>
    <div class="empty-grid">
      <div><strong>1 · Scout</strong><span>unusual price, volume and movement</span></div>
      <div><strong>2 · News</strong><span>dated sources, claims vs speculation</span></div>
      <div><strong>3 · Charts</strong><span>trend, momentum, support, resistance</span></div>
      <div><strong>4 · Strategy</strong><span>entry, invalidation, target, time limit</span></div>
      <div><strong>5 · Risk</strong><span>sizing and veto power</span></div>
      <div><strong>6 · Boss</strong><span>approve, wait or reject</span></div>
    </div>
    <button type="button" class="btn btn-primary" data-action="run">Run the desk</button>
    <p class="fine" id="empty-hint">No saved runs yet. Run the desk to produce six timestamped reports.</p>
  </div>`;

/* ------------------------------------------------------------------ */
/* limits, history, journal                                            */
/* ------------------------------------------------------------------ */

function renderLimits() {
  const host = $('#limits-card');
  const run = state.run;
  const cfg = run?.config;
  if (!cfg) {
    host.innerHTML = '<h3>Desk limits</h3><p class="config-note">Loaded from <code>config.yaml</code> when a run exists.</p>';
    return;
  }
  host.innerHTML = `
    <h3>Desk limits · config.yaml</h3>
    <div class="limits-grid">
      <div><span class="k">mode</span><span class="v">${esc(cfg.mode)}</span></div>
      <div><span class="k">live orders</span><span class="v">${cfg.allow_live_orders ? 'ON' : 'off'}</span></div>
      <div><span class="k">bankroll</span><span class="v">${esc(money(cfg.bankroll))}</span></div>
      <div><span class="k">risk / trade</span><span class="v">${esc(cfg.max_position_risk_pct)}%</span></div>
      <div><span class="k">max exposure</span><span class="v">${esc(cfg.max_total_exposure_pct)}%</span></div>
      <div><span class="k">max positions</span><span class="v">${esc(cfg.max_positions)}</span></div>
      <div><span class="k">min liquidity</span><span class="v">${esc(money(cfg.min_liquidity))}</span></div>
      <div><span class="k">max spread</span><span class="v">${esc(cfg.max_spread)}</span></div>
      <div><span class="k">min net R:R</span><span class="v">${esc(cfg.min_net_rr)}</span></div>
      <div><span class="k">stop cap</span><span class="v">${esc(cfg.max_stop_distance)}</span></div>
      <div><span class="k">cost buffer</span><span class="v">${esc(cfg.cost_buffer_pct)}%</span></div>
      <div><span class="k">news</span><span class="v">${cfg.require_news ? 'required' : 'optional'}</span></div>
    </div>
    <p class="config-note">These are read from the saved run. Edit <code>config.yaml</code> and run again to change them.</p>`;
}

function renderHistory() {
  const host = $('#history-card');
  const runs = state.index;
  if (!runs.length) {
    host.innerHTML = '<h3>Report history</h3><p class="config-note">Saved runs appear here after the first run.</p>';
    return;
  }
  host.innerHTML = `
    <h3>Report history</h3>
    <div class="field">
      <label for="run-select">Saved run <span>${runs.length} kept</span></label>
      <select id="run-select">
        ${runs.map(entry => `<option value="${esc(entry.run_id)}" ${entry.run_id === state.run?.run_id ? 'selected' : ''}>
          ${esc(entry.run_id)} · ${esc(DECISION_LABEL[entry.decision] || entry.decision || '—')} · ${esc(entry.plans ?? 0)} plan(s)
        </option>`).join('')}
      </select>
    </div>
    <div class="config-note">${state.apiAvailable ? 'Select a run to load its six reports.' : 'Static hosting keeps the latest snapshot only.'}</div>`;
}

function journalOutcomeOptions(current) {
  return ['pending', 'win', 'loss', 'scratch', 'void']
    .map(value => `<option value="${value}" ${current === value ? 'selected' : ''}>${value}</option>`)
    .join('');
}

function renderJournal() {
  const host = $('#journal-card');
  const entries = loadJournal();
  const open = entries.filter(entry => entry.outcome === 'pending').length;
  host.innerHTML = `
    <div class="journal-head"><h3>Paper journal</h3><span class="chip ${open ? 'good' : 'ghost'}">${open} pending</span></div>
    ${entries.length ? `<div class="journal-list">
      ${entries.slice(0, 30).map(entry => `
        <div class="journal-entry">
          <div class="q">${esc(entry.question)}</div>
          <div class="meta">
            <span>${esc(entry.side)}</span>
            <span>entry ${esc(cents(entry.entry))}</span>
            <span>stop ${esc(cents(entry.invalidation))}</span>
            <span>target ${esc(cents(entry.target))}</span>
            <span>${esc(entry.shares)} sh</span>
            <span>${esc(entry.source || '')}</span>
          </div>
          <div class="meta">
            <select data-outcome="${esc(entry.id)}" aria-label="Outcome for ${esc(entry.question)}">${journalOutcomeOptions(entry.outcome)}</select>
            <span>${esc(dateTime(entry.logged_utc))}</span>
            ${entry.url ? `<a href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">market ↗</a>` : ''}
            <button class="btn btn-ghost btn-small" data-action="delete-entry" data-id="${esc(entry.id)}">remove</button>
          </div>
        </div>`).join('')}
    </div>` : '<p class="journal-empty">Approved paper plans you log appear here. Outcomes are entered by hand — the desk does not claim to know a result it cannot see.</p>'}
    ${entries.length ? `<div class="journal-actions">
      <button class="btn btn-ghost btn-small" data-action="download-journal">Export JSON</button>
      <button class="btn btn-ghost btn-small" data-action="download-journal-csv">CSV</button>
      <button class="btn btn-ghost btn-small" data-action="clear-journal">Clear all</button>
    </div>` : ''}`;
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
  toast('Logged to the paper journal. Record the outcome by hand, after the fact.');
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
  const escapeCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return [columns.join(','), ...entries.map(entry => columns.map(column => escapeCell(entry[column])).join(','))].join('\n');
}

/* ------------------------------------------------------------------ */
/* events + boot                                                       */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderChrome();
  renderBanner();
  renderStats();
  renderPipeline();
  renderVerdict();
  renderLimits();
  renderHistory();
  renderAgents();
  renderJournal();
}

function bindEvents() {
  document.addEventListener('click', event => {
    const sourceButton = event.target.closest('.seg-btn');
    if (sourceButton) {
      if (state.status === 'running') {
        toast('Wait for the current run to finish.');
        return;
      }
      state.source = sourceButton.dataset.source;
      localStorage.setItem(LS.source, state.source);
      renderChrome();
      renderBanner();
      return;
    }

    const scrollTarget = event.target.closest('[data-scroll]');
    if (scrollTarget) {
      document.getElementById(`agent-${scrollTarget.dataset.scroll}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        .catch(() => toast('Copy blocked by the browser. Use Download JSON.'));
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
    if (event.target.matches('[data-outcome]')) setOutcome(event.target.dataset.outcome, event.target.value);
  });

  $('#run').addEventListener('click', runDesk);
}

async function boot() {
  bindEvents();
  renderAll();
  await loadInitial();
}

boot();
