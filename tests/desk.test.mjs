import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createDataLayer,
  normalizeMarket,
  synthesizeUniverse,
} from '../public/assets/data.js';
import {
  BOSS_DECISIONS,
  DEFAULT_CONFIG,
  validateReport,
  runBoss,
  runDesk,
  runNews,
  runRisk,
} from '../public/assets/agents.js';

const NOW = Date.parse('2026-10-19T03:30:00Z');
const now = () => NOW;
const config = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });

async function makeRun(seed = 3, overrides = {}) {
  const dataLayer = createDataLayer({ mode: 'test', now, seed });
  const report = await runDesk({
    dataLayer,
    config: config(overrides),
    now,
    historyLimit: 10,
    context: { bankroll: 1000 },
  });
  return { report, dataLayer };
}

const base = await makeRun(3);

let vetoRun = null;
for (const seed of [3, 5, 9, 11, 12, 13, 6, 7, 8, 10]) {
  const candidate = seed === 3 ? base : await makeRun(seed);
  const passed = (candidate.report.reports.risk?.evidence || [])
    .filter(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED');
  if (passed.length) {
    vetoRun = candidate;
    break;
  }
}

/* ------------------------------------------------------------------ */
/* data layer                                                          */
/* ------------------------------------------------------------------ */

test('synthetic universe covers 400+ markets and every record is labelled', () => {
  const universe = synthesizeUniverse({ nowMs: NOW, seed: 7 });
  assert.ok(universe.markets.length >= 400, 'expected at least 400 synthetic markets');
  assert.equal(universe.source, 'test');
  for (const market of universe.markets) {
    assert.equal(market.synthetic, true);
    assert.equal(market.tokens.length, 2);
    assert.ok(Number.isFinite(market.price));
    assert.ok(market.price > 0 && market.price < 1);
    assert.ok(Number.isFinite(market.liquidity));
    assert.ok(Number.isFinite(market.volume24h));
    assert.ok(Number.isFinite(market.endMs));
  }
});

test('normalizeMarket survives missing optional fields without inventing quotes', () => {
  const market = normalizeMarket({
    id: 'x1',
    question: 'Will the test pass?',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["a","b"]',
    outcomePrices: '["0.4","0.6"]',
  });
  assert.ok(market);
  assert.equal(market.yes.label, 'Yes');
  assert.equal(market.no.label, 'No');
  assert.ok(Number.isFinite(market.price));
  // No bid, ask or spread in the payload: the desk must flag this instead of inventing a book.
  assert.equal(market.hasQuote, false);
  assert.equal(market.bestBid, null);
  assert.equal(market.bestAsk, null);
  assert.equal(normalizeMarket({ id: 'broken' }), null);
  const quoted = normalizeMarket({
    id: 'x2',
    question: 'Will the test pass?',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["a","b"]',
    lastTradePrice: 0.4,
    spread: 0.02,
  });
  assert.equal(quoted.hasQuote, true);
  assert.ok(quoted.bestBid < quoted.bestAsk);
});

/* ------------------------------------------------------------------ */
/* pipeline + schema                                                   */
/* ------------------------------------------------------------------ */

test('full test-mode run produces six valid reports and one allowed decision', () => {
  const { report } = base;
  const names = ['scout', 'news', 'charts', 'strategy', 'risk', 'boss'];
  for (const name of names) {
    assert.ok(report.reports[name], `missing ${name} report`);
    const result = validateReport(report.reports[name]);
    assert.deepEqual(result, { ok: true, errors: [] }, `${name}: ${result.errors.join(', ')}`);
  }
  assert.ok(Object.values(BOSS_DECISIONS).includes(report.boss.meta.decision));
  assert.ok(report.reports.scout.meta.universe_size >= 400);
  assert.equal(report.reports.scout.meta.universe_source, 'test');
  assert.equal(report.reports.scout.status, 'complete');
  assert.equal(report.mode, 'test');
});

test('each stage report carries an ISO timestamp, evidence array and next step', () => {
  for (const [name, stage] of Object.entries(base.report.reports)) {
    assert.ok(Number.isFinite(Date.parse(stage.timestamp_utc)), `${name} timestamp`);
    assert.ok(Array.isArray(stage.evidence), `${name} evidence`);
    assert.ok(Array.isArray(stage.risks), `${name} risks`);
    assert.equal(typeof stage.next_step, 'string', `${name} next step`);
  }
});

test('validateReport rejects malformed, untimestamped and unapproved Boss reports', () => {
  assert.equal(validateReport(null).ok, false);
  const noTimestamp = { ...base.report.reports.scout, timestamp_utc: null };
  assert.equal(validateReport(noTimestamp).ok, false);
  const badStatus = { ...base.report.reports.scout, status: 'finished' };
  assert.equal(validateReport(badStatus).ok, false);
  const badBoss = {
    ...base.report.reports.boss,
    meta: { ...base.report.reports.boss.meta, decision: 'MAYBE' },
  };
  const result = validateReport(badBoss);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /boss decision/);
});

/* ------------------------------------------------------------------ */
/* news failures                                                       */
/* ------------------------------------------------------------------ */

test('news returns needs_data when no source can be reached', async () => {
  const fakeLayer = {
    mode: 'test',
    getMarketById: id => base.dataLayer.getMarketById(id),
    getNews: async () => [],
  };
  const news = await runNews(base.report.reports.scout, fakeLayer, { config: config(), nowMs: NOW });
  assert.equal(news.status, 'needs_data');
  assert.ok(news.evidence.every(item => item.flags.includes('NO_SOURCES')));
  assert.match(news.summary, /0 have at least one usable headline/);
});

test('a missing report blocks Boss approval', () => {
  const boss = runBoss(
    { scout: base.report.reports.scout, news: base.report.reports.news },
    { config: config(), nowMs: NOW },
  );
  assert.equal(boss.meta.decision, BOSS_DECISIONS.REJECT);
  assert.match(boss.summary, /incomplete/);
  assert.ok(boss.meta.integrity.some(check => check.name === 'pipeline_present' && !check.pass));
});

test('a halted stage can only produce WAIT, never an approval', () => {
  const boss = runBoss(base.report.reports, { config: config(), nowMs: NOW, haltedAt: 'charts' });
  assert.equal(boss.meta.decision, BOSS_DECISIONS.WAIT);
  assert.match(boss.summary, /Halted at CHARTS/);
});

/* ------------------------------------------------------------------ */
/* risk veto and stale / missing evidence                              */
/* ------------------------------------------------------------------ */

test('a run with a cleared plan exists to test the veto path', () => {
  assert.ok(vetoRun, 'no seed produced a risk-cleared plan; the veto tests cannot run');
  const passed = vetoRun.report.reports.risk.evidence.filter(item => item.verdict !== 'NOT_REVIEWED');
  assert.ok(passed.length > 0);
});

test('risk veto blocks every plan and the Boss cannot override it', () => {
  assert.ok(vetoRun);
  const strict = config({ maxSpread: 0.00001 });
  const risk = runRisk(
    vetoRun.report.reports.strategy,
    vetoRun.report.reports.news,
    vetoRun.report.reports.scout,
    vetoRun.report.reports.charts,
    { bankroll: 1000 },
    { config: strict, nowMs: NOW },
  );
  const reviewed = risk.evidence.filter(item => item.verdict !== 'NOT_REVIEWED');
  assert.ok(reviewed.length > 0);
  assert.ok(reviewed.every(item => item.verdict === 'REJECTED'));
  assert.ok(reviewed.every(item => item.failed_checks.includes('spread')));

  const boss = runBoss(
    { ...vetoRun.report.reports, risk },
    { config: strict, nowMs: NOW },
  );
  assert.equal(boss.meta.decision, BOSS_DECISIONS.REJECT);
  assert.equal(boss.meta.approved.length, 0);
});

test('stale reports fail the freshness gate and cannot approve', () => {
  assert.ok(vetoRun);
  const old = iso => new Date(Date.parse(iso) - 6 * 3_600_000).toISOString();
  const scout = { ...vetoRun.report.reports.scout, timestamp_utc: old(vetoRun.report.reports.scout.timestamp_utc) };
  const news = { ...vetoRun.report.reports.news, timestamp_utc: old(vetoRun.report.reports.news.timestamp_utc) };
  const charts = { ...vetoRun.report.reports.charts, timestamp_utc: old(vetoRun.report.reports.charts.timestamp_utc) };
  const strategy = { ...vetoRun.report.reports.strategy, timestamp_utc: old(vetoRun.report.reports.strategy.timestamp_utc) };

  const risk = runRisk(strategy, news, scout, charts, { bankroll: 1000 }, { config: config(), nowMs: NOW });
  const reviewed = risk.evidence.filter(item => item.verdict !== 'NOT_REVIEWED');
  assert.ok(reviewed.length > 0);
  assert.ok(reviewed.every(item => item.verdict === 'REJECTED'));
  assert.ok(reviewed.every(item => item.failed_checks.includes('input_freshness')));
  assert.ok(risk.meta.common_checks.some(check => check.name === 'input_freshness' && !check.pass));

  const boss = runBoss({ ...vetoRun.report.reports, risk }, { config: config(), nowMs: NOW });
  assert.equal(boss.meta.decision, BOSS_DECISIONS.REJECT);
});

test('removing the dated source rejects the plan that relied on it', () => {
  assert.ok(vetoRun);
  const riskReport = vetoRun.report.reports.risk;
  const target = riskReport.evidence.find(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED');
  assert.ok(target, 'needs a cleared plan');
  const news = structuredClone(vetoRun.report.reports.news);
  const item = news.evidence.find(entry => entry.market_id === target.market_id);
  item.fresh_count = 0;
  item.sources = [];
  item.source_count = 0;
  item.flags = ['NO_SOURCES'];
  item.items = [];
  item.tone = 'unknown';

  const risk = runRisk(
    vetoRun.report.reports.strategy,
    news,
    vetoRun.report.reports.scout,
    vetoRun.report.reports.charts,
    { bankroll: 1000 },
    { config: config(), nowMs: NOW },
  );
  const decision = risk.evidence.find(entry => entry.market_id === target.market_id);
  assert.equal(decision.verdict, 'REJECTED');
  assert.ok(decision.failed_checks.includes('news_required'));
  assert.ok(decision.failed_checks.includes('fresh_news'));
});

/* ------------------------------------------------------------------ */
/* sizing and concentration                                            */
/* ------------------------------------------------------------------ */

test('cleared plans respect position, exposure, stop and reward limits', () => {
  assert.ok(vetoRun);
  const cfg = vetoRun.report.config;
  const bankroll = 1000;
  const cleared = vetoRun.report.reports.risk.evidence.filter(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED');
  assert.ok(cleared.length > 0);
  for (const item of cleared) {
    assert.ok(item.plan.entry > item.plan.invalidation);
    assert.ok(item.plan.target > item.plan.entry);
    assert.ok(item.plan.entry - item.plan.invalidation <= cfg.maxStopDistance + 1e-9);
    assert.ok(item.size.shares >= 1);
    assert.ok(item.size.notional <= (bankroll * cfg.maxTotalExposurePct) / 100 + 0.01);
    assert.ok(item.size.risk_dollars <= (bankroll * cfg.maxPositionRiskPct) / 100 + 0.01);
    assert.ok(item.size.risk_dollars <= bankroll * (cfg.maxDailyRiskPct / 100) + 0.01);
    assert.ok(item.size.net_rr >= cfg.minNetRR);
    assert.equal(item.checks.filter(check => !check.pass).length, 0);
  }
});

test('an existing position in the same event blocks a second plan', () => {
  assert.ok(vetoRun);
  const riskReport = vetoRun.report.reports.risk;
  const target = riskReport.evidence.find(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED');
  assert.ok(target);
  const risk = runRisk(
    vetoRun.report.reports.strategy,
    vetoRun.report.reports.news,
    vetoRun.report.reports.scout,
    vetoRun.report.reports.charts,
    {
      bankroll: 1000,
      openPositions: [{
        market_id: 'existing',
        event_id: target.event_id,
        category: target.category,
        notional: 40,
        question: 'A different contract on the same event',
      }],
    },
    { config: config(), nowMs: NOW },
  );
  const decision = risk.evidence.find(item => item.market_id === target.market_id);
  assert.equal(decision.verdict, 'REJECTED');
  assert.ok(decision.failed_checks.includes('event_concentration'));
});

test('a duplicate question already in the book is rejected', () => {
  assert.ok(vetoRun);
  const target = vetoRun.report.reports.risk.evidence
    .find(item => item.verdict === 'PASSED' || item.verdict === 'REDUCED');
  const risk = runRisk(
    vetoRun.report.reports.strategy,
    vetoRun.report.reports.news,
    vetoRun.report.reports.scout,
    vetoRun.report.reports.charts,
    {
      bankroll: 1000,
      openPositions: [{
        market_id: 'existing',
        event_id: 'another-event',
        category: 'other',
        notional: 10,
        question: target.question,
      }],
    },
    { config: config(), nowMs: NOW },
  );
  const decision = risk.evidence.find(item => item.market_id === target.market_id);
  assert.equal(decision.verdict, 'REJECTED');
  assert.ok(decision.failed_checks.includes('duplicate_question'));
});

/* ------------------------------------------------------------------ */
/* determinism + safety                                                */
/* ------------------------------------------------------------------ */

test('the same seed and clock produce the same watchlist and decision', async () => {
  const second = await makeRun(3);
  assert.equal(second.report.boss.meta.decision, base.report.boss.meta.decision);
  const ids = report => report.reports.scout.evidence.map(item => item.market_id).join(',');
  assert.equal(ids(second.report), ids(base.report));
  assert.deepEqual(second.report.reports.scout.evidence[0].metrics, base.report.reports.scout.evidence[0].metrics);
});

test('paper mode and live-order lock are hard defaults', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'paper');
  assert.equal(DEFAULT_CONFIG.allowLiveOrders, false);
  const boss = base.report.reports.boss;
  assert.ok(boss.meta.integrity.some(check => check.name === 'paper_only' && check.pass));
  assert.match(boss.meta.final_word, /No order endpoint/i);
});

test('the browser desk contains no order, wallet or signing code path', async () => {
  const files = await Promise.all([
    readFile(new URL('../public/assets/data.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/assets/agents.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/assets/app.js', import.meta.url), 'utf8'),
  ]);
  const source = files.join('\n');
  for (const pattern of [
    /privateKey/i,
    /mnemonic/i,
    /signTransaction/i,
    /placeOrder\s*\(/i,
    /submitOrder\s*\(/i,
    /method:\s*['"]POST['"]/i,
    /ethers\./i,
  ]) {
    assert.doesNotMatch(source, pattern);
  }
});

test('all cleared sizes are whole shares and at least one share', () => {
  assert.ok(vetoRun);
  for (const item of vetoRun.report.reports.risk.evidence) {
    if (item.verdict === 'PASSED' || item.verdict === 'REDUCED') {
      assert.equal(Number.isInteger(item.size.shares), true);
      assert.ok(item.size.shares > 0);
    }
  }
});
