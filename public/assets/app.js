/*
 * app.js — the dashboard.
 *
 * Renders the six agent reports, keeps the run configuration, and stores a manual
 * paper journal in localStorage. It can download a full JSON audit of any run.
 * It contains no wallet, signing or order-placing code.
 */

import { MODE, createDataLayer } from './data.js';
import { BOSS_DECISIONS, DEFAULT_CONFIG, runDesk, validateReport } from './agents.js';

const $ = sel => document.querySelector(sel);

const LS = {
  config: 'opus-desk-config-v1',
  mode: 'opus-desk-mode-v1',
  seed: 'opus-desk-seed-v1',
  journal: 'opus-desk-journal-v1',
};

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

const EDITABLE = [
  { key: 'bankroll', label: 'Paper bankroll', suffix: 'USD', min: 10, max: 1_000_000, step: 100 },
  { key: 'maxPositionRiskPct', label: 'Risk per trade', suffix: '% bankroll', min: 0.1, max: 10, step: 0.1 },
  { key: 'maxTotalExposurePct', label: 'Max total exposure', suffix: '% bankroll', min: 1, max: 100, step: 1 },
  { key: 'maxPositions', label: 'Max open positions', suffix: 'count', min: 1, max: 20, step: 1 },
  { key: 'shortlistSize', label: 'Watchlist size', suffix: 'markets', min: 1, max: 15, step: 1 },
  { key: 'minLiquidity', label: 'Min liquidity', suffix: 'USD', min: 0, max: 500_000, step: 500 },
  { key: 'minNetRR', label: 'Min net R:R', suffix: 'ratio', min: 0.5, max: 5, step: 0.1 },
  { key: 'maxSpread', label: 'Max spread', suffix: 'price', min: 0.001, max: 0.25, step: 0.001 },
];

const state = {
  mode: 'test',
  seed: 3,
  config: { ...DEFAULT_CONFIG },
  status: 'idle', // idle | running | done | error
  report: null,
  stageReports: {},
  activeStage: null,
  progress: '',
  error: null,
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

function fmtMoney(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(value, digits = 1, signed = false) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function fmtCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}¢`;
}

function fmtNum(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtTime(isoString) {
  if (!isoString) return '—';
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().slice(11, 19) + 'Z';
}

function fmtDateTime(isoString) {
  if (!isoString) return '—';
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function untilText(isoString) {
  if (!isoString) return '—';
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return '—';
  const diff = ms - Date.now();
  const hours = diff / 3_600_000;
  if (hours < 0) return 'past';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cls(...names) {
  return names.filter(Boolean).join(' ');
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be blocked; the app still works for this session */
  }
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
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

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

function loadState() {
  const savedMode = localStorage.getItem(LS.mode);
  state.mode = savedMode === MODE.LIVE ? MODE.LIVE : MODE.TEST;
  const savedSeed = Number(localStorage.getItem(LS.seed));
  state.seed = Number.isFinite(savedSeed) && savedSeed >= 1 ? savedSeed : 3;
  const savedConfig = loadJson(LS.config, {});
  for (const field of EDITABLE) {
    const value = Number(savedConfig?.[field.key]);
    if (Number.isFinite(value)) state.config[field.key] = value;
  }
  state.config.mode = 'paper';
  state.config.allowLiveOrders = false;
}

function saveConfig() {
  const payload = {};
  for (const field of EDITABLE) payload[field.key] = state.config[field.key];
  saveJson(LS.config, payload);
}

function loadJournal() {
  const entries = loadJson(LS.journal, []);
  return Array.isArray(entries) ? entries : [];
}

function saveJournal(entries) {
  saveJson(LS.journal, entries);
}

function openPositions() {
  return loadJournal()
    .filter(entry => entry.outcome === 'pending')
    .map(entry => ({
      market_id: entry.market_id,
      event_id: entry.event_id,
      category: entry.category,
      question: entry.question,
      notional: Number(entry.notional) || 0,
      risk_dollars: Number(entry.risk_dollars) || 0,
    }));
}

/* ------------------------------------------------------------------ */
/* stage state                                                         */
/* ------------------------------------------------------------------ */

function reportFor(stage) {
  return state.stageReports[stage] || state.report?.reports?.[stage] || null;
}

function stageState(key) {
  const report = reportFor(key);
  if (report) {
    if (report.status === 'complete') return 'done';
    if (report.status === 'rejected') return 'fail';
    return 'halt';
  }
  if (state.status === 'running') {
    if (state.activeStage === key) return 'running';
    return 'queued';
  }
  if (state.status === 'done' || state.status === 'error') return 'skipped';
  return 'queued';
}

const STAGE_TEXT = {
  done: 'complete',
  halt: 'needs data',
  fail: 'rejected',
  running: 'working',
  queued: 'queued',
  skipped: 'not reached',
};

const EMPTY_MARKUP = `
  <div class="empty" id="empty-state">
    <p class="eyebrow">Ready</p>
    <h2>Scan the board. Let risk say no.</h2>
    <p class="lead">The desk pulls the most active Polymarket contracts, finds unusual moves,
      checks dated headlines and price structure, writes one rule-based plan per candidate,
      and refuses anything that breaks a limit. There is no order button, and never will be.</p>
    <div class="empty-grid">
      <div><strong>1 · Scout</strong><span>unusual price, volume and movement</span></div>
      <div><strong>2 · News</strong><span>dated sources, facts vs speculation</span></div>
      <div><strong>3 · Charts</strong><span>trend, momentum, support, resistance</span></div>
      <div><strong>4 · Strategy</strong><span>entry, invalidation, target, time limit</span></div>
      <div><strong>5 · Risk</strong><span>veto power over every plan</span></div>
      <div><strong>6 · Boss</strong><span>approve, wait or reject</span></div>
    </div>
    <button type="button" class="btn btn-primary" data-action="run">Run the desk</button>
  </div>`;

function pillFor(status) {
  const map = { complete: 'done', needs_data: 'halt', rejected: 'fail' };
  const label = { complete: 'complete', needs_data: 'needs data', rejected: 'rejected' }[status] || status;
  return `<span class="pill ${map[status] || 'neutral'}">${esc(label)}</span>`;
}

/* ------------------------------------------------------------------ */
/* header, banner, stats, pipeline                                     */
/* ------------------------------------------------------------------ */

function renderChrome() {
  document.querySelectorAll('.seg-btn').forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const runButton = $('#run');
  const running = state.status === 'running';
  runButton.disabled = running;
  runButton.classList.toggle('running', running);
  $('#run-label').textContent = running ? 'Running…' : 'Run desk';
  $('#footer-mode').textContent = state.mode === MODE.TEST
    ? 'mode: test · synthetic data generated in-browser'
    : 'mode: live · read-only public feeds';
}

function renderBanner() {
  const el = $('#banner');
  el.className = 'banner';
  if (state.status === 'error') {
    el.classList.add('error');
    el.innerHTML = `<span><strong>Run failed.</strong> ${esc(state.error || 'Unknown error')}</span>`;
    return;
  }
  if (state.mode === MODE.TEST) {
    el.classList.add('test');
    el.innerHTML = `<span><strong>Synthetic test data.</strong> Every market, price and headline in this mode is generated in your browser from a fixed seed. It exercises the workflow; it is not a real market and not a forecast.</span>`;
  } else {
    el.classList.add('live');
    el.innerHTML = `<span><strong>Live public data.</strong> Read-only Polymarket quotes, CLOB price history and Google News RSS headlines. Prices can lag, sources can be thin, and no order can be placed from this page.</span>`;
  }
}

function renderStats() {
  const report = state.report;
  const scout = reportFor('scout');
  const news = reportFor('news');
  const strategy = reportFor('strategy');
  const risk = reportFor('risk');
  const boss = reportFor('boss');

  const universe = report?.universe?.size ?? scout?.meta?.universe_size ?? null;
  const watch = scout?.evidence?.length ?? null;
  const plans = strategy ? safeArray(strategy.evidence).filter(p => p.status === 'plan').length : null;
  const waits = strategy ? safeArray(strategy.evidence).filter(p => p.status === 'WAIT').length : null;
  const cleared = risk ? safeArray(risk.evidence).filter(d => d.verdict === 'PASSED' || d.verdict === 'REDUCED').length : null;
  const rejected = risk ? safeArray(risk.evidence).filter(d => d.verdict === 'REJECTED').length : null;
  const decision = boss?.meta?.decision || null;

  const decisionWord = decision === BOSS_DECISIONS.APPROVE ? 'APPROVE'
    : decision === BOSS_DECISIONS.WAIT ? 'WAIT'
      : decision === BOSS_DECISIONS.REJECT ? 'REJECT'
        : state.status === 'running' ? 'RUNNING' : '—';
  const decisionClass = decision === BOSS_DECISIONS.APPROVE ? 'approve'
    : decision === BOSS_DECISIONS.WAIT ? 'wait'
      : decision === BOSS_DECISIONS.REJECT ? 'reject'
        : state.status === 'running' ? 'live' : '';

  const tiles = [
    {
      k: 'Universe scanned',
      v: universe == null ? '—' : Number(universe).toLocaleString('en-US'),
      s: report ? (report.source_detail || '').slice(0, 46) : 'markets pulled from the feed',
      accent: 'live',
    },
    {
      k: 'Watchlist',
      v: watch == null ? '—' : watch,
      s: watch == null ? 'after quality filters' : `top ${watch} by activity score`,
    },
    {
      k: 'Plans written',
      v: plans == null ? '—' : plans,
      s: waits == null ? 'strategy is the 4th stage' : `${waits} returned WAIT`,
    },
    {
      k: 'Risk cleared',
      v: cleared == null ? '—' : cleared,
      s: rejected == null ? 'risk can veto every plan' : `${rejected} rejected at the gate`,
    },
    {
      k: 'Final decision',
      v: decisionWord,
      s: decision ? 'paper test only' : 'the Boss has the last word',
      accent: decisionClass,
    },
  ];

  $('#statbar').innerHTML = tiles.map(tile => `
    <div class="stat ${tile.accent || ''}">
      <div class="k"><span>${esc(tile.k)}</span></div>
      <div class="v">${esc(tile.v)}</div>
      <div class="s">${esc(tile.s)}</div>
    </div>`).join('');

  if (news) {
    const frame = document.querySelector('.stat:nth-child(2) .s');
    const newsCount = safeArray(news.evidence).reduce((sum, item) => sum + (item.fresh_count || 0), 0);
    if (frame) frame.textContent = `${safeArray(news.evidence).length} checked · ${newsCount} fresh headlines`;
  }
}

function renderPipeline() {
  $('#pipeline').innerHTML = AGENTS.map(agent => {
    const status = stageState(agent.key);
    return `<button type="button" class="pipe-node ${status}" data-scroll="${agent.key}">
      <span class="pipe-num">${agent.num}</span>
      <span class="pipe-meta">
        <span class="pipe-name">${esc(agent.name)}</span>
        <span class="pipe-status">${esc(STAGE_TEXT[status] || status)}</span>
      </span>
    </button>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* verdict                                                             */
/* ------------------------------------------------------------------ */

function renderVerdict() {
  const el = $('#verdict');
  const boss = reportFor('boss');
  const decision = boss?.meta?.decision;
  const running = state.status === 'running';

  if (state.status === 'idle') {
    el.innerHTML = `
      <div class="verdict-head">
        <span class="k">Boss · final decision</span>
        <span class="pill neutral">idle</span>
      </div>
      <div class="verdict-body">
        <div class="decision idle"><span class="dot"></span>Desk not run</div>
        <p class="explain">Pick a data source, set the paper limits, then run. Risk can veto every plan; the Boss cannot approve without a complete pipeline.</p>
        <div class="verdict-actions">
          <button class="btn btn-primary btn-small" data-action="run">Run desk</button>
        </div>
      </div>`;
    return;
  }

  if (running && !boss) {
    el.innerHTML = `
      <div class="verdict-head">
        <span class="k">Boss · final decision</span>
        <span class="pill running">running</span>
      </div>
      <div class="verdict-body">
        <div class="decision running"><span class="dot"></span>Working the desk…</div>
        <p class="explain">${esc(state.progress || 'Starting the data pull.')}</p>
        <div class="verdict-meta"><span>source: ${state.mode === MODE.TEST ? 'synthetic test data' : 'live public feeds'}</span></div>
      </div>`;
    return;
  }

  if (state.status === 'error') {
    el.innerHTML = `
      <div class="verdict-head">
        <span class="k">Boss · final decision</span>
        <span class="pill fail">no decision</span>
      </div>
      <div class="verdict-body">
        <div class="decision reject"><span class="dot"></span>Run failed</div>
        <p class="explain">${esc(state.error || 'Unknown error')}</p>
        ${state.mode === MODE.LIVE ? '<p class="config-note">Live mode needs a network path to Polymarket. If the relay returns 502, this environment cannot reach the feed. Test data runs fully offline.</p>' : ''}
        <div class="verdict-actions">
          <button class="btn btn-small" data-action="run">Try again</button>
          ${state.mode === MODE.LIVE ? '<button class="btn btn-small" data-action="switch-test">Use test data</button>' : ''}
        </div>
      </div>`;
    return;
  }

  if (!boss) {
    el.innerHTML = '<div class="verdict-body"><p class="explain">Run in progress. The Boss waits for all five reports.</p></div>';
    return;
  }

  const meta = boss.meta || {};
  const approved = safeArray(meta.approved);
  const counts = meta.counts || {};
  const decisionClass = decision === BOSS_DECISIONS.APPROVE ? 'approve'
    : decision === BOSS_DECISIONS.WAIT ? 'wait' : 'reject';
  const pillClass = decision === BOSS_DECISIONS.APPROVE ? 'approve'
    : decision === BOSS_DECISIONS.WAIT ? 'wait' : 'reject';

  el.classList.add('verdict-card');
  el.innerHTML = `
    <div class="verdict-head">
      <span class="k">Boss · final decision</span>
      <span class="pill ${pillClass}">${esc(DECISION_LABEL[decision] || decision)}</span>
    </div>
    <div class="verdict-body">
      <div class="decision ${decisionClass}"><span class="dot"></span>${esc(DECISION_LABEL[decision] || decision)}</div>
      <p class="explain">${esc(boss.summary)}</p>

      <div class="verdict-counts">
        <div><div class="k">plans</div><div class="v">${counts.plans ?? 0}</div></div>
        <div><div class="k">risk passed</div><div class="v">${counts.risk_passed ?? 0}</div></div>
        <div><div class="k">rejected</div><div class="v">${counts.risk_rejected ?? 0}</div></div>
      </div>

      <div class="integrity">
        ${safeArray(meta.integrity).map(check => `
          <div class="check ${check.pass ? '' : 'bad'}">
            <span class="mark">${check.pass ? '✓' : '✕'}</span>
            <span class="name">${esc(check.name)}</span>
            <span>${esc(check.detail)}</span>
          </div>`).join('')}
      </div>

      ${approved.length ? `
        <div class="approved-list">
          ${approved.map((trade, index) => `
            <div class="approved">
              <div class="q">${esc(trade.question)}</div>
              <div class="row">
                <span>side <b>${esc(trade.side)}</b></span>
                <span>entry <b>${esc(fmtCents(trade.entry))}</b></span>
                <span>stop <b>${esc(fmtCents(trade.invalidation))}</b></span>
                <span>target <b>${esc(fmtCents(trade.target))}</b></span>
              </div>
              <div class="row">
                <span>${esc(trade.shares)} shares · ${esc(fmtMoney(trade.notional, 2))}</span>
                <span>risk <b>${esc(fmtMoney(trade.risk_dollars, 2))}</b></span>
                <span>net R:R <b>${esc(fmtNum(trade.net_rr))}</b></span>
                <span>by ${esc(fmtDateTime(trade.time_limit_utc))}</span>
              </div>
              <div class="verdict-actions">
                <button class="btn btn-small" data-action="log-trade" data-index="${index}">Log to paper journal</button>
              </div>
            </div>`).join('')}
        </div>` : ''}

      ${safeArray(meta.disagreements).length ? `
        <div class="details">
          <details>
            <summary>${meta.disagreements.length} unresolved disagreement(s)</summary>
            <ul class="reason-list">${meta.disagreements.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
          </details>
        </div>` : ''}

      <div class="verdict-meta">
        <span>run ${esc(state.report?.run_id || '—')}</span>
        <span>${esc(state.report?.started_utc || '')} → ${esc(state.report?.finished_utc || '')} · ${esc(((state.report?.duration_ms || 0) / 1000).toFixed(1))}s</span>
        <span>source: ${esc(state.report?.source || '—')}${state.report?.universe?.synthetic ? ' · synthetic' : ''}</span>
      </div>

      <div class="verdict-actions">
        ${approved.length ? `<button class="btn btn-small btn-ghost" data-action="log-all">Log all approved</button>` : ''}
        <button class="btn btn-small btn-ghost" data-action="copy-report">Copy report</button>
        <button class="btn btn-small btn-ghost" data-action="download-report">Download JSON</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* agent cards                                                         */
/* ------------------------------------------------------------------ */

function renderAgents() {
  const host = $('#agents');
  if (state.status === 'idle') {
    host.innerHTML = EMPTY_MARKUP;
    return;
  }

  host.innerHTML = AGENTS.map(agent => {
    const report = reportFor(agent.key);
    const status = stageState(agent.key);

    if (!report) {
      if (status === 'running' || status === 'queued') {
        return `
          <article class="card agent" id="agent-${agent.key}">
            <div class="agent-head">
              <span class="agent-num">${agent.num}</span>
              <div class="agent-title">
                <h3>${esc(agent.name)}</h3>
                <div class="agent-role">${esc(agent.role)}</div>
              </div>
              <div class="agent-head-right"><span class="pill ${status === 'running' ? 'running' : 'neutral'}">${status === 'running' ? 'working' : 'queued'}</span></div>
            </div>
            <div class="agent-body"><p class="agent-summary dim">${status === 'running' ? 'Reading the inputs for this stage…' : 'Waiting for the previous stage.'}</p></div>
          </article>`;
      }
      return `
        <article class="card agent" id="agent-${agent.key}">
          <div class="agent-head">
            <span class="agent-num">${agent.num}</span>
            <div class="agent-title">
              <h3>${esc(agent.name)}</h3>
              <div class="agent-role">${esc(agent.role)}</div>
            </div>
            <div class="agent-head-right"><span class="pill neutral">not reached</span></div>
          </div>
          <div class="agent-body"><p class="agent-summary dim">The pipeline stopped before this stage. Per the desk rules, no report means no decision.</p></div>
        </article>`;
    }

    const body = renderAgentBody(agent.key, report);
    const bossDecision = agent.key === 'boss' ? report.meta?.decision : null;
    const bossPill = bossDecision === BOSS_DECISIONS.APPROVE ? 'approve'
      : bossDecision === BOSS_DECISIONS.WAIT ? 'wait'
        : bossDecision === BOSS_DECISIONS.REJECT ? 'reject' : null;
    const statusPill = bossPill
      ? `<span class="pill ${bossPill}">${esc(DECISION_LABEL[bossDecision] || bossDecision)}</span>`
      : `<span class="pill ${status === 'done' ? 'done' : status === 'halt' ? 'halt' : 'fail'}">${esc(STAGE_TEXT[status])}</span>`;
    return `
      <article class="card agent" id="agent-${agent.key}">
        <div class="agent-head">
          <span class="agent-num">${agent.num}</span>
          <div class="agent-title">
            <h3>${esc(agent.name)}</h3>
            <div class="agent-role">${esc(agent.role)}</div>
          </div>
          <div class="agent-head-right">
            ${statusPill}
            <span class="agent-meta">${esc(fmtTime(report.timestamp_utc))}</span>
          </div>
        </div>
        <div class="agent-body">
          <p class="agent-summary">${esc(report.summary)}</p>
          ${body}
          <div class="details">
            <details>
              <summary>Raw ${esc(agent.name)} report (JSON)</summary>
              <pre>${esc(JSON.stringify(report, null, 2))}</pre>
            </details>
          </div>
        </div>
      </article>`;
  }).join('');
}

function renderAgentBody(key, report) {
  if (key === 'scout') return scoutBody(report);
  if (key === 'news') return newsBody(report);
  if (key === 'charts') return chartsBody(report);
  if (key === 'strategy') return strategyBody(report);
  if (key === 'risk') return riskBody(report);
  if (key === 'boss') return bossBody(report);
  return '';
}

function riskNotes(report) {
  if (!safeArray(report.risks).length) return '';
  return `<div class="halt-note"><strong>Flags</strong><ul class="reason-list">${report.risks.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
}

function scoutBody(report) {
  const meta = report.meta || {};
  const rows = safeArray(report.evidence);
  return `
    ${meta.universe_size != null ? `
      <div class="meta-grid">
        <div class="meta-box"><div class="k">universe</div><div class="v">${Number(meta.universe_size).toLocaleString('en-US')}</div><div class="s">${esc(meta.universe_source || '')}</div></div>
        <div class="meta-box"><div class="k">passed filters</div><div class="v">${meta.scored_count ?? '—'}</div><div class="s">${meta.excluded?.quality || 0} failed quality</div></div>
        <div class="meta-box"><div class="k">watchlist</div><div class="v">${rows.length}</div><div class="s">top activity scores</div></div>
        <div class="meta-box"><div class="k">low signal</div><div class="v">${meta.excluded?.low_signal ?? '—'}</div><div class="s">below 8-point floor</div></div>
      </div>` : ''}
    ${rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>Market</th><th class="right">Score</th><th class="right">1h</th>
            <th class="right">24h</th><th class="right">Volume</th><th class="right">Liquidity</th>
            <th class="right">Spread</th><th class="right">Ends</th>
          </tr></thead>
          <tbody>
            ${rows.map((item, index) => `
              <tr>
                <td class="num dim">${index + 1}</td>
                <td class="qcell">
                  <span class="q">${esc(item.question)}</span>
                  <div class="plan-foot">
                    <span class="chip ghost">${esc(item.category || 'other')}</span>
                    <span class="chip ghost">${esc(fmtCents(item.price))}</span>
                    ${item.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
                  </div>
                  ${safeArray(item.reasons).length ? `
                    <div class="small muted" style="margin-top:3px">${esc(item.reasons[0])}</div>
                    <details>
                      <summary>All ${item.reasons.length} reason(s)</summary>
                      <ul class="reason-list">${item.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>
                    </details>` : ''}
                </td>
                <td class="num right">
                  <div>${item.score ?? '—'}</div>
                  <div class="bar"><i style="width:${Math.min(100, Number(item.score) || 0)}%"></i></div>
                </td>
                <td class="num right ${Number(item.metrics?.move_1h) >= 0 ? 'pos' : 'neg'}">${esc(fmtPct(item.metrics?.move_1h, 1, true))}</td>
                <td class="num right ${Number(item.metrics?.move_24h) >= 0 ? 'pos' : 'neg'}">${esc(fmtPct(item.metrics?.move_24h, 1, true))}</td>
                <td class="num right">${esc(fmtCompact(item.metrics?.volume_24h))}</td>
                <td class="num right">${esc(fmtCompact(item.metrics?.liquidity))}</td>
                <td class="num right">${esc(fmtCents(item.metrics?.spread))}</td>
                <td class="num right">${esc(untilText(item.ends_at))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div class="halt-note">No market cleared the activity floor. The desk will not invent one.</div>'}
    ${riskNotes(report)}
    ${meta.methodology ? `<p class="config-note">${esc(meta.methodology)}</p>` : ''}`;
}

function newsBody(report) {
  const meta = report.meta || {};
  const rows = safeArray(report.evidence);
  if (!rows.length) {
    return `<div class="halt-note">No watchlist reached the news stage, so there are no sources to show.</div>${riskNotes(report)}`;
  }
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
            ${safeArray(item.flags).filter(flag => flag !== 'SYNTHETIC_HEADLINES').map(flag => `<span class="chip warn">${esc(flag)}</span>`).join('')}
          </div>
          ${safeArray(item.items).length ? `
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
            <div class="details">
              <details>
                <summary>All ${item.items.length} headline(s) · query “${esc(item.query || '—')}”</summary>
                <div class="plan-list" style="margin-top:8px">
                  ${item.items.slice(2).map(headline => `
                    <div class="headline">
                      <a class="title" href="${esc(headline.link || '#')}" target="_blank" rel="noopener noreferrer">${esc(headline.title)}</a>
                      <div class="plan-foot">
                        <span class="chip ghost">${esc(headline.source || 'unattributed')}</span>
                        <span class="chip ${headline.stale ? 'warn' : 'ghost'}">${headline.age_hours == null ? 'no date' : `${esc(headline.age_hours)}h old`}</span>
                        <span class="chip ${headline.relevance === 'direct' ? 'good' : 'ghost'}">${esc(headline.relevance)}</span>
                        <span class="chip ${headline.speculative ? 'warn' : 'ghost'}">${headline.speculative ? 'speculative' : 'reported'}</span>
                        ${headline.synthetic ? '<span class="chip warn">synthetic</span>' : ''}
                      </div>
                    </div>`).join('') || '<p class="config-note">No further headlines.</p>'}
                </div>
              </details>
            </div>` : `<p class="config-note">No usable dated headline. This market cannot receive a plan while news is required.</p>`}
        </div>`).join('')}
    </div>
    ${riskNotes(report)}
    ${meta.headline_policy ? `<p class="config-note">${esc(meta.headline_policy)}</p>` : ''}`;
}

function sparkline(points, levels = []) {
  const data = safeArray(points).map(Number).filter(Number.isFinite);
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
  const guides = levels
    .map(Number)
    .filter(level => Number.isFinite(level) && level >= min && level <= max)
    .slice(0, 2)
    .map(level => `<line x1="${pad}" x2="${width - pad}" y1="${y(level).toFixed(2)}" y2="${y(level).toFixed(2)}" />`)
    .join('');
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="fill" d="${area}" fill="rgba(61,219,198,0.08)"></path>
    <path class="line" d="${line}"></path>
    ${guides}
  </svg>`;
}

function trendPill(trend) {
  if (trend === 'up') return '<span class="pill approve">uptrend</span>';
  if (trend === 'down') return '<span class="pill reject">downtrend</span>';
  return '<span class="pill neutral">range</span>';
}

function chartsBody(report) {
  const rows = safeArray(report.evidence).filter(item => item.status === 'complete');
  const meta = report.meta || {};
  if (!rows.length) {
    return `<div class="halt-note">No usable price series. The desk will not describe a chart it cannot see.</div>${riskNotes(report)}`;
  }
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
        const levels = [...safeArray(view.levels?.support), ...safeArray(view.levels?.resistance)];
        return `
          <div class="chart-card">
            <div class="top">
              <div class="q">${esc(item.question)}</div>
              ${trendPill(view.trend)}
            </div>
            ${sparkline(item.sparkline, levels)}
            <div class="chart-stats">
              <div><div class="k">last</div><div class="v">${esc(fmtCents(view.last))}</div></div>
              <div><div class="k">1h mom</div><div class="v ${Number(view.momentum_1h) >= 0 ? 'pos' : 'neg'}">${esc(fmtCents(view.momentum_1h))}</div></div>
              <div><div class="k">bar range</div><div class="v">${esc(fmtPct(view.atr_pct, 1))}</div></div>
            </div>
            <div class="levels">
              ${safeArray(view.levels?.support).map(level => `<span class="chip good">S ${esc(fmtCents(level))}</span>`).join('')}
              ${safeArray(view.levels?.resistance).map(level => `<span class="chip bad">R ${esc(fmtCents(level))}</span>`).join('')}
              ${view.structure_break ? `<span class="chip warn">break ${esc(view.structure_break)}</span>` : ''}
              <span class="chip ghost">${esc(item.primary_outcome || 'primary')}</span>
            </div>
            ${safeArray(item.conflicts).length ? `<ul class="reason-list conflicts">${item.conflicts.map(conflict => `<li>${esc(conflict)}</li>`).join('')}</ul>` : ''}
            ${safeArray(item.warnings).length ? `<div class="warnings">${item.warnings.map(w => esc(w)).join(' · ')}</div>` : ''}
            <p class="config-note">${esc(item.timeframe)} · ${esc(item.series_source || '')} · ${item.data_quality?.points ?? '—'} bars</p>
          </div>`;
      }).join('')}
    </div>
    ${riskNotes(report)}
    ${meta.methodology ? `<p class="config-note">${esc(meta.methodology)}</p>` : ''}`;
}

function strategyBody(report) {
  const rows = safeArray(report.evidence);
  const plans = rows.filter(item => item.status === 'plan');
  const waits = rows.filter(item => item.status !== 'plan');
  const meta = report.meta || {};
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">reviewed</div><div class="v">${meta.reviewed ?? rows.length}</div><div class="s">markets with charts</div></div>
      <div class="meta-box"><div class="k">plans</div><div class="v">${plans.length}</div><div class="s">clear rules only</div></div>
      <div class="meta-box"><div class="k">waits</div><div class="v">${waits.length}</div><div class="s">no forced setups</div></div>
    </div>
    ${plans.length ? `
      <div class="plan-list">
        ${plans.map(plan => `
          <div class="plan ready">
            <div class="plan-top">
              <div class="q">${esc(plan.question)}</div>
              <span class="side-badge">${esc(plan.side)}</span>
            </div>
            <div class="plan-grid">
              <div><div class="k">entry</div><div class="v">${esc(fmtCents(plan.entry))}</div></div>
              <div><div class="k">invalidation</div><div class="v" style="color:var(--red)">${esc(fmtCents(plan.invalidation))}</div></div>
              <div><div class="k">target</div><div class="v" style="color:var(--green)">${esc(fmtCents(plan.target))}</div></div>
              <div><div class="k">gross R:R</div><div class="v">${esc(fmtNum(plan.gross_rr))}</div></div>
            </div>
            <div class="plan-trigger"><strong>Entry trigger:</strong> ${esc(plan.entry_trigger)}</div>
            <div class="plan-trigger"><strong>Time limit:</strong> ${esc(fmtDateTime(plan.time_limit_utc))} · <strong>type:</strong> ${esc(plan.entry_type)}</div>
            <div class="plan-foot">
              <span class="chip">zone ${esc(fmtCents(plan.entry_zone?.[0]))} – ${esc(fmtCents(plan.entry_zone?.[1]))}</span>
              <span class="chip ghost">${esc(plan.evidence_used?.chart_trend || 'n/a')}</span>
              <span class="chip ghost">${plan.evidence_used?.news_count ?? 0} fresh source(s)</span>
              <span class="confidence">confidence ${plan.confidence ?? '—'}<span class="bar"><i style="width:${Math.min(100, Number(plan.confidence) || 0)}%"></i></span></span>
            </div>
            ${safeArray(plan.disagreements).length ? `<div class="conflicts">⚠ ${plan.disagreements.map(d => esc(d)).join(' · ')}</div>` : ''}
          </div>`).join('')}
      </div>` : '<div class="halt-note">No plan was forced. Every reviewed market returned WAIT.</div>'}
    ${waits.length ? `
      <div class="details">
        <details>
          <summary>${waits.length} market(s) returned WAIT — reasons</summary>
          <div class="table-wrap" style="margin-top:8px">
            <table><thead><tr><th>Market</th><th>Why it is not a plan</th></tr></thead><tbody>
              ${waits.map(item => `<tr><td class="qcell">${esc(item.question)}</td><td class="muted small">${esc(item.reason || 'no setup')}</td></tr>`).join('')}
            </tbody></table>
          </div>
        </details>
      </div>` : ''}
    ${riskNotes(report)}
    ${meta.policy ? `<p class="config-note">${esc(meta.policy)}</p>` : ''}`;
}

function riskBody(report) {
  const rows = safeArray(report.evidence);
  const reviewed = rows.filter(item => item.verdict !== 'NOT_REVIEWED');
  const skipped = rows.filter(item => item.verdict === 'NOT_REVIEWED');
  const meta = report.meta || {};
  return `
    <div class="meta-grid">
      <div class="meta-box"><div class="k">cleared</div><div class="v" style="color:var(--green)">${meta.passed ?? 0}</div><div class="s">passed or reduced</div></div>
      <div class="meta-box"><div class="k">rejected</div><div class="v" style="color:var(--red)">${meta.rejected ?? 0}</div><div class="s">failed a hard check</div></div>
      <div class="meta-box"><div class="k">exposure</div><div class="v">${esc(fmtMoney(meta.exposure_used, 2))}</div><div class="s">of ${esc(fmtMoney(meta.exposure_limit, 0))} cap</div></div>
      <div class="meta-box"><div class="k">risk committed</div><div class="v">${esc(fmtMoney(meta.risk_committed, 2))}</div><div class="s">this run</div></div>
    </div>
    ${reviewed.length ? `<div class="plan-list">
      ${reviewed.map(item => {
        const failed = safeArray(item.checks).filter(check => !check.pass);
        const verdictClass = item.verdict === 'REJECTED' ? 'reject' : item.verdict === 'REDUCED' ? 'wait' : 'approve';
        return `
          <div class="plan ${item.verdict === 'REJECTED' ? '' : 'ready'}">
            <div class="plan-top">
              <div class="q">${esc(item.question)}</div>
              <span class="pill ${verdictClass}">${esc(item.verdict)}</span>
            </div>
            ${item.side ? `<div class="plan-foot"><span class="side-badge">${esc(item.side)}</span>${item.size ? `<span class="chip ghost">${esc(item.size.shares)} shares</span>` : ''}</div>` : ''}
            ${failed.length ? `
              <div class="checks">
                ${failed.map(check => `<div class="check bad"><span class="mark">✕</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}
              </div>` : '<div class="checks"><div class="check"><span class="mark">✓</span><span>every check passed</span></div></div>'}
            ${item.size ? `
              <div class="size-grid">
                <div><div class="k">shares</div><div class="v">${esc(item.size.shares)}</div></div>
                <div><div class="k">notional</div><div class="v">${esc(fmtMoney(item.size.notional, 2))}</div></div>
                <div><div class="k">risk</div><div class="v">${esc(fmtMoney(item.size.risk_dollars, 2))}</div></div>
                <div><div class="k">net R:R</div><div class="v">${esc(fmtNum(item.size.net_rr))}</div></div>
              </div>` : ''}
            <div class="details">
              <details>
                <summary>All ${safeArray(item.checks).length} check(s) and cost model</summary>
                <div class="checks" style="margin-top:8px">
                  ${safeArray(item.checks).map(check => `<div class="check ${check.pass ? '' : 'bad'}"><span class="mark">${check.pass ? '✓' : '✕'}</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}
                </div>
                ${item.size ? `<p class="config-note">cost ${esc(fmtNum(item.size.cost_per_share, 4))}/share · max loss ${esc(item.size.max_loss_pct_of_bankroll)}% of bankroll · exposure after ${esc(fmtMoney(item.size.exposure_after, 2))}</p>` : ''}
              </details>
            </div>
          </div>`;
      }).join('')}
    </div>` : '<div class="halt-note">No plan reached the risk gate in this run.</div>'}
    ${skipped.length ? `
      <div class="details">
        <details>
          <summary>${skipped.length} plan(s) never reached the gate</summary>
          <ul class="reason-list">${skipped.map(item => `<li>${esc(item.question)} — ${esc(safeArray(item.reasons)[0] || 'no plan')}</li>`).join('')}</ul>
        </details>
      </div>` : ''}
    ${riskNotes(report)}
    <p class="config-note">${esc(meta.policy || '')}</p>`;
}

function bossBody(report) {
  const meta = report.meta || {};
  const decision = meta.decision;
  const decisionClass = decision === BOSS_DECISIONS.APPROVE ? 'approve'
    : decision === BOSS_DECISIONS.WAIT ? 'wait' : 'reject';
  return `
    <div class="decision-banner ${decisionClass}">
      <div class="k">final status</div>
      <div class="d">${esc(DECISION_LABEL[decision] || decision)}</div>
      <p>${esc(report.summary)}</p>
    </div>
    <div class="meta-grid">
      <div class="meta-box"><div class="k">approved</div><div class="v">${meta.counts?.plans ? safeArray(meta.approved).length : 0}</div><div class="s">paper plans</div></div>
      <div class="meta-box"><div class="k">risk passed</div><div class="v">${meta.counts?.risk_passed ?? 0}</div><div class="s">of ${meta.counts?.plans ?? 0} plans</div></div>
      <div class="meta-box"><div class="k">waits</div><div class="v">${meta.counts?.waits ?? 0}</div><div class="s">no forced setups</div></div>
      <div class="meta-box"><div class="k">disagreements</div><div class="v">${safeArray(meta.disagreements).length}</div><div class="s">sent here, not averaged</div></div>
    </div>
    <div class="integrity">
      ${safeArray(meta.integrity).map(check => `<div class="check ${check.pass ? '' : 'bad'}"><span class="mark">${check.pass ? '✓' : '✕'}</span><span class="name">${esc(check.name)}</span><span>${esc(check.detail)}</span></div>`).join('')}
    </div>
    ${safeArray(meta.approved).length ? `
      <div class="approved-list">
        ${meta.approved.map((trade, index) => `
          <div class="approved">
            <div class="q">${esc(trade.question)}</div>
            <div class="row">
              <span><b>${esc(trade.side)}</b></span>
              <span>entry ${esc(fmtCents(trade.entry))}</span>
              <span>stop ${esc(fmtCents(trade.invalidation))}</span>
              <span>target ${esc(fmtCents(trade.target))}</span>
              <span>${esc(trade.shares)} shares</span>
              <span>net R:R ${esc(fmtNum(trade.net_rr))}</span>
            </div>
            <div class="verdict-actions"><button class="btn btn-small" data-action="log-trade" data-index="${index}">Log to paper journal</button></div>
          </div>`).join('')}
      </div>` : ''}
    ${safeArray(meta.disagreements).length ? `
      <div class="details">
        <details>
          <summary>Unresolved disagreements</summary>
          <ul class="reason-list">${meta.disagreements.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
        </details>
      </div>` : ''}
    <p class="config-note">${esc(meta.final_word || '')}</p>`;
}

/* ------------------------------------------------------------------ */
/* config + journal                                                    */
/* ------------------------------------------------------------------ */

function renderConfig() {
  const host = $('#config-card');
  host.innerHTML = `
    <h3>Paper limits</h3>
    <div class="grid-2">
      ${EDITABLE.map(field => `
        <div class="field">
          <label for="cfg-${field.key}">${esc(field.label)} <span>${esc(field.suffix)}</span></label>
          <input id="cfg-${field.key}" type="number" data-config="${field.key}"
            value="${esc(state.config[field.key])}" min="${field.min}" max="${field.max}" step="${field.step}">
        </div>`).join('')}
    </div>
    <div class="field ${state.mode === MODE.TEST ? '' : 'hidden'}" id="seed-field">
      <label for="cfg-seed">Synthetic day <span>test data only</span></label>
      <div style="display:flex;gap:6px">
        <input id="cfg-seed" type="number" min="1" step="1" value="${esc(state.seed)}" data-seed>
        <button class="btn btn-small" data-action="reroll" title="Generate a new synthetic day and rerun">New day</button>
      </div>
    </div>
    <div class="safety"><span><b>Hard-coded:</b> MODE=paper · ALLOW_LIVE_ORDERS=false · no order endpoint. These cannot be changed from the page.</span></div>
    <p class="config-note">Changing a limit does not rewrite the last report. Run again to apply it.</p>
    <div class="journal-actions">
      <button class="btn btn-ghost btn-small" data-action="reset-config">Reset defaults</button>
    </div>`;
}

function journalOutcomeOptions(current) {
  return ['pending', 'win', 'loss', 'scratch', 'void']
    .map(value => `<option value="${value}" ${current === value ? 'selected' : ''}>${value}</option>`)
    .join('');
}

function renderJournal() {
  const entries = loadJournal();
  const host = $('#journal-card');
  const open = entries.filter(entry => entry.outcome === 'pending').length;
  host.innerHTML = `
    <div class="journal-head">
      <h3>Paper journal</h3>
      <span class="chip ${open ? 'good' : 'ghost'}">${open} pending</span>
    </div>
    ${entries.length ? `
      <div class="journal-list">
        ${entries.slice(0, 30).map(entry => `
          <div class="journal-entry">
            <div class="q">${esc(entry.question)}</div>
            <div class="meta">
              <span>${esc(entry.side)}</span>
              <span>entry ${esc(fmtCents(entry.entry))}</span>
              <span>stop ${esc(fmtCents(entry.invalidation))}</span>
              <span>target ${esc(fmtCents(entry.target))}</span>
              <span>${esc(entry.shares)} sh</span>
              <span>${esc(entry.mode)}</span>
            </div>
            <div class="meta">
              <select data-outcome="${esc(entry.id)}" aria-label="Outcome for ${esc(entry.question)}">${journalOutcomeOptions(entry.outcome)}</select>
              <span>${esc(fmtDateTime(entry.logged_utc))}</span>
              <a href="${esc(entry.url || '#')}" target="_blank" rel="noopener noreferrer">market ↗</a>
              <button class="btn btn-ghost btn-small" data-action="delete-entry" data-id="${esc(entry.id)}">remove</button>
            </div>
          </div>`).join('')}
      </div>` : '<p class="journal-empty">Approved paper plans you log appear here. Outcomes are entered by hand — the desk does not claim to know a result it cannot see.</p>'}
    ${entries.length ? `
      <div class="journal-actions">
        <button class="btn btn-ghost btn-small" data-action="download-journal">Export JSON</button>
        <button class="btn btn-ghost btn-small" data-action="download-journal-csv">CSV</button>
        <button class="btn btn-ghost btn-small" data-action="clear-journal">Clear all</button>
      </div>` : ''}`;
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function progressLabel(info) {
  if (!info) return 'Working…';
  if (info.stage === 'universe') return `Scanning the board: ${info.loaded ?? 0} of ${info.target ?? '…'} markets loaded.`;
  if (info.stage === 'news') return `Reading dated sources: ${info.marketId || ''}`;
  if (info.stage === 'charts') return `Pulling price history: ${info.marketId || ''}`;
  return info.stage ? `Running ${info.stage}…` : 'Working…';
}

async function run() {
  if (state.status === 'running') return;

  state.status = 'running';
  state.report = null;
  state.stageReports = {};
  state.activeStage = 'scout';
  state.progress = state.mode === MODE.TEST ? 'Generating the synthetic board…' : 'Loading markets from the feed…';
  state.error = null;
  renderChrome();
  renderBanner();
  renderStats();
  renderPipeline();
  renderAgents();
  renderVerdict();

  const config = {
    ...DEFAULT_CONFIG,
    ...state.config,
    mode: 'paper',
    allowLiveOrders: false,
  };

  const dataLayer = createDataLayer({ mode: state.mode, seed: state.seed });
  const context = {
    bankroll: Number(config.bankroll) || 1000,
    openPositions: openPositions(),
  };

  try {
    const report = await runDesk({
      dataLayer,
      config,
      historyLimit: Math.max(1, Math.min(15, Number(config.shortlistSize) || 10)),
      context,
      onStage: ({ stage, report: stageReport }) => {
        state.stageReports[stage] = stageReport;
        const index = AGENTS.findIndex(agent => agent.key === stage);
        state.activeStage = AGENTS[Math.min(index + 1, AGENTS.length - 1)].key;
        state.progress = `${stageReport.label} finished: ${stageReport.summary}`;
        renderStats();
        renderPipeline();
        renderAgents();
        renderVerdict();
      },
      onProgress: info => {
        if (info?.stage) {
          state.activeStage = info.stage;
          state.progress = progressLabel(info);
          renderPipeline();
        }
      },
    });

    const validation = Object.entries(report.reports).map(([name, stageReport]) => ({
      name,
      ...validateReport(stageReport),
    }));
    const invalid = validation.filter(item => !item.ok);
    if (invalid.length) {
      throw new Error(`Report validation failed: ${invalid.map(item => `${item.name} (${item.errors.join(', ')})`).join('; ')}`);
    }

    state.report = report;
    state.status = 'done';
    state.activeStage = null;
    state.progress = '';
  } catch (error) {
    state.status = 'error';
    state.error = error?.message || String(error);
    state.report = null;
  }

  renderChrome();
  renderStats();
  renderPipeline();
  renderAgents();
  renderVerdict();
  renderJournal();
}

/* ------------------------------------------------------------------ */
/* journal actions                                                     */
/* ------------------------------------------------------------------ */

function logTrade(index) {
  const report = state.report;
  const trade = report?.boss?.meta?.approved?.[index];
  if (!trade) return;
  const entries = loadJournal();
  const key = `${report.run_id}:${trade.market_id}:${trade.side}`;
  if (entries.some(entry => entry.key === key)) {
    toast('That plan is already in the journal.');
    return;
  }
  entries.unshift({
    key,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    run_id: report.run_id,
    mode: report.mode,
    source: report.source,
    logged_utc: new Date().toISOString(),
    market_id: trade.market_id,
    question: trade.question,
    url: trade.url || '',
    side: trade.side,
    category: trade.category || 'other',
    event_id: trade.event_id || trade.market_id,
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
  const entries = loadJournal().map(entry => (entry.id === id ? { ...entry, outcome, closed_utc: new Date().toISOString() } : entry));
  saveJournal(entries);
  renderJournal();
}

function deleteEntry(id) {
  saveJournal(loadJournal().filter(entry => entry.id !== id));
  renderJournal();
  toast('Entry removed.');
}

function journalCsv(entries) {
  const columns = ['logged_utc', 'mode', 'run_id', 'market_id', 'question', 'side', 'category', 'entry', 'invalidation', 'target', 'shares', 'notional', 'risk_dollars', 'net_rr', 'confidence', 'outcome', 'time_limit_utc', 'url'];
  const escapeCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns.join(',')];
  for (const entry of entries) {
    lines.push(columns.map(column => escapeCell(entry[column])).join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  document.addEventListener('click', event => {
    const modeButton = event.target.closest('.seg-btn');
    if (modeButton) {
      const mode = modeButton.dataset.mode;
      if (mode === state.mode) return;
      if (state.status === 'running') {
        toast('Wait for the current run to finish.');
        return;
      }
      state.mode = mode;
      localStorage.setItem(LS.mode, mode);
      state.status = 'idle';
      state.report = null;
      state.stageReports = {};
      state.error = null;
      renderConfig();
      renderChrome();
      renderBanner();
      renderStats();
      renderPipeline();
      renderAgents();
      renderVerdict();
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

    if (action === 'run') run();
    if (action === 'switch-test') {
      state.mode = MODE.TEST;
      localStorage.setItem(LS.mode, MODE.TEST);
      state.status = 'idle';
      state.report = null;
      state.stageReports = {};
      state.error = null;
      renderConfig();
      renderChrome();
      renderBanner();
      renderStats();
      renderPipeline();
      renderAgents();
      renderVerdict();
    }
    if (action === 'reroll') {
      state.seed += 1;
      localStorage.setItem(LS.seed, String(state.seed));
      const input = document.querySelector('[data-seed]');
      if (input) input.value = state.seed;
      if (state.mode !== MODE.TEST) {
        toast('Synthetic days only apply to test data.');
        return;
      }
      run();
    }
    if (action === 'reset-config') {
      for (const field of EDITABLE) state.config[field.key] = DEFAULT_CONFIG[field.key];
      saveConfig();
      renderConfig();
      toast('Limits reset to desk defaults. Run again to apply.');
    }
    if (action === 'log-trade') logTrade(Number(actionEl.dataset.index));
    if (action === 'log-all') {
      const approved = state.report?.boss?.meta?.approved || [];
      approved.forEach((_, index) => logTrade(index));
    }
    if (action === 'copy-report') {
      if (!state.report) return;
      copyText(JSON.stringify(state.report, null, 2)).then(ok => toast(ok ? 'Full report copied as JSON.' : 'Copy blocked by the browser. Use Download JSON.'));
    }
    if (action === 'download-report') {
      if (!state.report) return;
      download(`opus-desk-${state.report.run_id}.json`, JSON.stringify(state.report, null, 2));
      toast('Report downloaded.');
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
    const configField = event.target.closest('[data-config]');
    if (configField) {
      const key = configField.dataset.config;
      const field = EDITABLE.find(item => item.key === key);
      let value = Number(configField.value);
      if (!Number.isFinite(value)) return;
      value = Math.min(field.max, Math.max(field.min, value));
      configField.value = value;
      state.config[key] = value;
      saveConfig();
      toast('Limit saved. Run again to apply it.');
      return;
    }

    if (event.target.matches('[data-seed]')) {
      let value = Math.floor(Number(event.target.value));
      if (!Number.isFinite(value) || value < 1) value = 1;
      state.seed = value;
      localStorage.setItem(LS.seed, String(value));
      event.target.value = value;
      toast('Seed saved. The next test run uses this synthetic day.');
      return;
    }

    if (event.target.matches('[data-outcome]')) {
      setOutcome(event.target.dataset.outcome, event.target.value);
    }
  });

  $('#run').addEventListener('click', run);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  loadState();
  bindEvents();
  renderConfig();
  renderChrome();
  renderBanner();
  renderStats();
  renderPipeline();
  renderAgents();
  renderVerdict();
  renderJournal();

  if (state.mode === MODE.TEST) {
    // A first-run preview so the desk is never a blank page.
    run();
  }
}

boot();
