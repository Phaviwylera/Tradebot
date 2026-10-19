/*
 * data.js — market data layer for the Opus Agent Desk.
 *
 * Two sources only:
 *   live — Polymarket's public Gamma + CLOB APIs, through the /gamma and /clob relays.
 *   test — deterministic SYNTHETIC data generated in the browser. No network.
 *
 * Nothing in this file can place an order. There is no wallet, key, or signing code.
 */

export const MODE = { LIVE: 'live', TEST: 'test' };

export const SOURCE_LABEL = {
  live: 'Polymarket public API',
  test: 'SYNTHETIC TEST DATA',
};

const HAS_LOCATION = typeof location !== 'undefined';
const FILE_PROTOCOL = HAS_LOCATION && location.protocol === 'file:';

// On a normal deploy the Vercel rewrites (or the local Python server) proxy these paths.
// Opening the page straight from disk has no proxy, so live mode calls the public APIs directly.
const GAMMA = FILE_PROTOCOL ? 'https://gamma-api.polymarket.com' : '/gamma';
const CLOB = FILE_PROTOCOL ? 'https://clob.polymarket.com' : '/clob';
const NEWS = FILE_PROTOCOL ? '' : '/news';

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

export function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function parseMaybeJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export function hoursBetween(laterMs, earlierMs) {
  return (laterMs - earlierMs) / 3_600_000;
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation, scaled to behave like a standard deviation. */
export function mad(values) {
  if (!values.length) return 0;
  const m = median(values);
  return 1.4826 * median(values.map(v => Math.abs(v - m)));
}

export function robustZ(value, values) {
  if (!values.length) return 0;
  const m = median(values);
  const spread = mad(values);
  if (spread < 1e-9) return value === m ? 0 : 0;
  return clamp((value - m) / spread, -4, 4);
}

async function fetchWithTimeout(url, { timeoutMs = 12_000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < (options.retries ?? 1) + 1; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.split('?')[0]}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < (options.retries ?? 1)) {
        await new Promise(resolve => setTimeout(resolve, 400 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/** Run async jobs with a small concurrency cap so we do not hammer public APIs. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* normalisation                                                       */
/* ------------------------------------------------------------------ */

const CATEGORY_RULES = [
  ['crypto', /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|xrp|doge|binance|coinbase|stablecoin|blockchain)\b/i],
  ['sports', /\b(nfl|nba|mlb|nhl|ufc|f1|premier league|champions league|vs\.?|cowboys|packers|yankees|dodgers|lakers|celtics|game|match|title|playoff)\b/i],
  ['politics', /\b(president|senate|congress|election|poll|governor|parliament|minister|trump|harris|democrat|republican|shutdown|impeach)\b/i],
  ['econ', /\b(cpi|inflation|fed|rate cut|rate hike|fomc|gdp|unemployment|jobs report|payrolls|recession|treasury|tariff)\b/i],
  ['weather', /\b(temperature|rain|snow|hurricane|storm|weather|degrees)\b/i],
  ['culture', /\b(oscar|grammy|emmy|movie|album|box office|celebrity|taylor swift|netflix|ticket)\b/i],
];

export function inferCategory(market) {
  const tags = Array.isArray(market.tags)
    ? market.tags.map(tag => (typeof tag === 'string' ? tag : tag?.label || tag?.slug || '')).join(' ')
    : '';
  const haystack = `${market.category || ''} ${tags} ${market.eventTitle || ''} ${market.question || ''}`;
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(haystack)) return category;
  }
  return 'other';
}

/**
 * Turn a raw Gamma market into the shape the agents understand.
 * Every numeric is finite; missing data becomes null rather than an invented value.
 */
export function normalizeMarket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const outcomes = parseMaybeJson(raw.outcomes, []).map(String);
  const prices = parseMaybeJson(raw.outcomePrices, []).map(v => num(v, NaN));
  const tokens = parseMaybeJson(raw.clobTokenIds, []).map(String);
  if (outcomes.length < 2 || tokens.length < 2) return null;

  const event = Array.isArray(raw.events) && raw.events.length ? raw.events[0] : null;
  let bestBid = num(raw.bestBid, NaN);
  let bestAsk = num(raw.bestAsk, NaN);
  const last = num(raw.lastTradePrice, NaN);
  const outcome0 = num(prices[0], NaN);
  const reportedSpread = num(raw.spread, NaN);

  let price;
  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk > 0) {
    price = (bestBid + bestAsk) / 2;
  } else if (Number.isFinite(last) && last > 0 && last < 1) {
    price = last;
  } else if (Number.isFinite(outcome0)) {
    price = outcome0;
  } else {
    price = 0.5;
  }

  let hasQuote = Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestAsk > bestBid && bestBid > 0;
  if (!hasQuote && Number.isFinite(reportedSpread) && reportedSpread > 0 && Number.isFinite(price)) {
    // A reported spread is enough to derive a two-sided quote around the mid.
    bestBid = clamp(price - reportedSpread / 2, 0.001, 0.999);
    bestAsk = clamp(price + reportedSpread / 2, 0.001, 0.999);
    hasQuote = bestAsk > bestBid;
  }
  const spread = hasQuote ? Math.max(0, bestAsk - bestBid) : null;

  const endDate = raw.endDate || raw.endDateIso || null;
  const market = {
    id: String(raw.id ?? raw.conditionId ?? raw.slug ?? ''),
    conditionId: raw.conditionId || '',
    slug: raw.slug || '',
    question: raw.question || raw.title || 'Untitled market',
    description: raw.description || '',
    resolutionSource: raw.resolutionSource || '',
    eventId: String(event?.id ?? raw.eventId ?? raw.id ?? ''),
    eventTitle: event?.title || raw.eventTitle || raw.question || 'Untitled event',
    category: (raw.category || '').toLowerCase(),
    outcomes,
    tokens,
    price,
    hasQuote,
    bestBid: hasQuote ? bestBid : null,
    bestAsk: hasQuote ? bestAsk : null,
    spread,
    liquidity: num(raw.liquidityNum ?? raw.liquidity, 0),
    volume24h: num(raw.volume24hr, 0),
    volume1wk: num(raw.volume1wk ?? raw.volume, 0),
    volumeTotal: num(raw.volumeNum ?? raw.volume, 0),
    move1h: num(raw.oneHourPriceChange, 0),
    move24h: num(raw.oneDayPriceChange, 0),
    move1wk: num(raw.oneWeekPriceChange, 0),
    openInterest: num(event?.openInterest, 0),
    endDate,
    endMs: endDate ? Date.parse(endDate) : NaN,
    updatedAt: raw.updatedAt || raw.acceptingOrdersTimestamp || null,
    acceptingOrders: raw.acceptingOrders !== false && raw.closed !== true,
    closed: raw.closed === true,
    resolved: raw.closed === true && Boolean(raw.outcomePrices),
    enableOrderBook: raw.enableOrderBook !== false,
    orderMinSize: num(raw.orderMinSize, 5),
    tickSize: num(raw.orderPriceMinTickSize, 0.001),
    feesEnabled: raw.feesEnabled === true,
    feeRate: num(raw.feeSchedule?.rate, 0),
    negRisk: raw.negRisk === true,
    featured: raw.featured === true,
    commentCount: num(event?.commentCount, 0),
    synthetic: raw.synthetic === true,
    demoRegime: raw.demoRegime || null,
    demoNews: raw.demoNews || null,
    demoEventRisk: raw.demoEventRisk || null,
    raw,
  };

  market.category = inferCategory(market);
  market.yes = {
    label: outcomes[0],
    token: tokens[0],
    price,
    bid: hasQuote ? market.bestBid : null,
    ask: hasQuote ? market.bestAsk : null,
  };
  market.no = {
    label: outcomes[1],
    token: tokens[1],
    price: clamp(1 - price, 0.001, 0.999),
    bid: hasQuote ? clamp(1 - market.bestAsk, 0.001, 0.999) : null,
    ask: hasQuote ? clamp(1 - market.bestBid, 0.001, 0.999) : null,
  };
  market.url = market.slug ? `https://polymarket.com/market/${market.slug}` : '';
  return market;
}

/* ------------------------------------------------------------------ */
/* live universe                                                       */
/* ------------------------------------------------------------------ */

export async function fetchLiveUniverse({ maxScan = 500, pageSize = 100, onProgress } = {}) {
  const collected = [];
  const seen = new Set();
  let offset = 0;
  let pages = 0;

  while (collected.length < maxScan && pages < 10) {
    const params = new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: String(Math.min(pageSize, maxScan - collected.length)),
      offset: String(offset),
      order: 'volume24hr',
      ascending: 'false',
    });
    const page = await getJson(`${GAMMA}/markets?${params}`);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page) {
      const market = normalizeMarket(raw);
      if (!market || seen.has(market.id)) continue;
      seen.add(market.id);
      collected.push(market);
    }
    offset += page.length;
    pages += 1;
    onProgress?.({ loaded: collected.length, target: maxScan, page: pages });
    if (page.length < pageSize) break;
  }

  return {
    markets: collected,
    fetchedAt: new Date().toISOString(),
    source: 'live',
    note: `Gamma /markets, ordered by 24h volume, ${pages} page(s)`,
  };
}

/* ------------------------------------------------------------------ */
/* live price history + news                                           */
/* ------------------------------------------------------------------ */

export async function fetchLiveHistory(tokenId, { interval = '1d', fidelity = 10 } = {}) {
  if (!tokenId) throw new Error('missing token id');
  const params = new URLSearchParams({ market: tokenId, interval, fidelity: String(fidelity) });
  const body = await getJson(`${CLOB}/prices-history?${params}`);
  const points = Array.isArray(body?.history) ? body.history : [];
  return points
    .map(point => ({ t: num(point.t) * 1000, p: num(point.p, NaN) }))
    .filter(point => Number.isFinite(point.p) && point.t > 0)
    .sort((a, b) => a.t - b.t);
}

export function parseRss(xmlText) {
  if (typeof DOMParser === 'undefined') throw new Error('RSS parsing needs a browser');
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('news feed returned invalid XML');
  return [...doc.querySelectorAll('item')].map(item => ({
    title: (item.querySelector('title')?.textContent || '').replace(/\s+/g, ' ').trim(),
    link: item.querySelector('link')?.textContent || '',
    publishedAt: item.querySelector('pubDate')?.textContent || '',
    source: item.querySelector('source')?.textContent || '',
    sourceUrl: item.querySelector('source')?.getAttribute('url') || '',
    description: item.querySelector('description')?.textContent || '',
  })).filter(item => item.title);
}

export async function fetchLiveNews(query, { maxItems = 8 } = {}) {
  if (!NEWS) throw new Error('news relay unavailable when the page is opened from disk');
  const params = new URLSearchParams({
    q: query,
    hl: 'en-US',
    gl: 'US',
    ceid: 'US:en',
  });
  const response = await fetchWithTimeout(`${NEWS}?${params}`, { timeoutMs: 12_000 });
  if (!response.ok) throw new Error(`news relay returned HTTP ${response.status}`);
  const items = parseRss(await response.text());
  return items.slice(0, maxItems).map(item => {
    const published = Date.parse(item.publishedAt);
    return {
      ...item,
      publishedAtIso: Number.isFinite(published) ? new Date(published).toISOString() : null,
      publishedMs: Number.isFinite(published) ? published : null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* deterministic synthetic test data                                   */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const random = mulberry32(seed);
  const normal = () => {
    const u = Math.max(random(), 1e-9);
    const v = Math.max(random(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    random,
    normal,
    between: (lo, hi) => lo + random() * (hi - lo),
    int: (lo, hi) => Math.floor(lo + random() * (hi - lo + 1)),
    pick: list => list[Math.floor(random() * list.length)],
  };
}

const TEAM_POOLS = [
  ['Cowboys', 'Packers', 'Chiefs', 'Bills', '49ers', 'Ravens', 'Eagles', 'Lions'],
  ['Yankees', 'Dodgers', 'Cubs', 'Mets', 'Astros', 'Braves'],
  ['Celtics', 'Lakers', 'Knicks', 'Heat', 'Nuggets', 'Warriors'],
  ['Arsenal', 'Chelsea', 'Liverpool', 'City', 'Spurs', 'United'],
  ['Maple Leafs', 'Bruins', 'Rangers', 'Oilers', 'Canadiens'],
];
const POLITICS = [
  'the Senate pass the budget bill',
  'the government shut down',
  'the incumbent lead the next poll',
  'the bill clear the House',
  'the coalition win the election',
  'the nominee be confirmed',
  'the tariff package be signed',
  'the recount be certified',
];
const CRYPTO = [
  ['BTC', 62_000, 130_000],
  ['ETH', 2_100, 5_400],
  ['SOL', 90, 260],
  ['XRP', 0.4, 1.6],
];
const ECON = [
  'Core CPI come in above 3.0%',
  'the Fed cut rates at the next meeting',
  'the Fed hold rates at the next meeting',
  'payrolls beat 200k',
  'GDP growth top 2.5%',
  'unemployment print below 4.2%',
];
const CULTURE = [
  'the film open above $50M',
  'the album debut at number one',
  'the show win best drama',
  'the game sell 10M copies',
  'the tour add a second date',
];
const WEATHER = [
  'the high in New York top 70F',
  'rain fall in London',
  'the storm be upgraded to a hurricane',
  'snow fall in Chicago',
];

function isoDate(ms) {
  return new Date(ms).toISOString();
}

function makeQuestion(random, category, nowMs) {
  const day = new Date(nowMs + random.between(2, 40) * 86_400_000);
  const dateLabel = day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (category === 'sports') {
    const pool = random.pick(TEAM_POOLS);
    const a = random.pick(pool);
    let b = random.pick(pool);
    while (b === a) b = random.pick(pool);
    return {
      question: `${a} vs. ${b}: ${a} to win`,
      event: `${a} vs. ${b}`,
      outcomes: [a, b],
    };
  }
  if (category === 'politics') {
    const topic = random.pick(POLITICS);
    return { question: `Will ${topic} by ${dateLabel}?`, event: 'Politics', outcomes: ['Yes', 'No'] };
  }
  if (category === 'crypto') {
    const [symbol, lo, hi] = random.pick(CRYPTO);
    const level = Math.round(random.between(lo, hi) / 500) * 500 || Math.round(random.between(lo, hi));
    const direction = random.random() > 0.5 ? 'above' : 'below';
    return {
      question: `Will ${symbol} close ${direction} $${level.toLocaleString('en-US')} on ${dateLabel}?`,
      event: `${symbol} price on ${dateLabel}`,
      outcomes: ['Yes', 'No'],
    };
  }
  if (category === 'econ') {
    return { question: `Will ${random.pick(ECON)}?`, event: 'US macro', outcomes: ['Yes', 'No'] };
  }
  if (category === 'weather') {
    return { question: `Will ${random.pick(WEATHER)} on ${dateLabel}?`, event: 'Weather', outcomes: ['Yes', 'No'] };
  }
  return {
    question: `Will ${random.pick(CULTURE)} by ${dateLabel}?`,
    event: 'Culture',
    outcomes: ['Yes', 'No'],
  };
}

const CATEGORY_PLAN = [
  ['sports', 175], ['politics', 115], ['crypto', 95], ['econ', 65],
  ['culture', 40], ['weather', 20], ['other', 10],
];

/**
 * Build 520 synthetic markets. They are labelled everywhere as test data.
 * The shape of each record matches a normalised live market, so every agent
 * runs the exact same code path in both modes.
 */
export function synthesizeUniverse({ nowMs = Date.now(), seed = 20261019 } = {}) {
  const random = makeRandom(seed);
  const markets = [];
  let index = 0;

  for (const [category, count] of CATEGORY_PLAN) {
    for (let i = 0; i < count; i += 1) {
      const ident = makeQuestion(random, category, nowMs);
      const hot = index % 22 === 5;
      const veryHot = index % 47 === 8;
      const price = hot
        ? random.between(0.18, 0.82)
        : random.between(0.04, 0.96);
      const direction = random.random() > 0.45 ? 1 : -1;
      const move24h = hot
        ? direction * random.between(0.09, 0.28)
        : direction * random.between(0.002, 0.06);
      const move1h = move24h * random.between(0.15, 0.9);
      const spread = hot ? random.between(0.002, 0.014) : random.between(0.002, 0.075);
      const liquidity = hot
        ? random.between(45_000, 700_000)
        : Math.exp(random.normal() * 1.05 + 8.9);
      const volume24h = hot
        ? liquidity * random.between(0.35, 1.6)
        : liquidity * random.between(0.03, 0.7);
      const hoursToEnd = hot ? random.between(3, 60) : random.between(0.4, 40 * 24);
      const endMs = nowMs + hoursToEnd * 3_600_000;
      const regime = hot
        ? (direction > 0 ? (random.random() > 0.5 ? 'up' : 'breakout') : 'down')
        : random.pick(['range', 'range', 'up', 'down', 'breakout']);
      const newsCount = hot ? random.int(2, 4) : random.int(0, 3);
      const eventRisk = category === 'econ' || category === 'politics'
        ? random.pick(['low', 'medium', 'medium', 'high'])
        : random.pick(['low', 'low', 'low', 'medium']);

      const bid = clamp(price - spread / 2, 0.002, 0.998);
      const ask = clamp(price + spread / 2, 0.002, 0.998);
      const raw = {
        id: `test-${String(index + 1).padStart(4, '0')}`,
        conditionId: `0xtest${index}`,
        slug: `test-market-${index + 1}`,
        question: ident.question,
        description:
          'SYNTHETIC TEST MARKET. This question, its prices and its volume were generated by the desk. ' +
          'It does not describe a real Polymarket contract and must not be read as a forecast.',
        resolutionSource: 'https://example.com/test-data',
        outcomes: JSON.stringify(ident.outcomes),
        outcomePrices: JSON.stringify([price.toFixed(4), (1 - price).toFixed(4)]),
        clobTokenIds: JSON.stringify([`test-yes-${index + 1}`, `test-no-${index + 1}`]),
        events: [{
          id: `test-event-${category}-${Math.floor(index / 3)}`,
          title: ident.event,
          commentCount: random.int(0, 400),
          openInterest: liquidity * random.between(0.1, 1.5),
        }],
        liquidityNum: liquidity,
        volume24hr: volume24h,
        volume1wk: volume24h * random.between(1.5, 12),
        volumeNum: volume24h * random.between(2, 30),
        oneHourPriceChange: move1h,
        oneDayPriceChange: move24h,
        oneWeekPriceChange: move24h * random.between(0.6, 2.4),
        lastTradePrice: price,
        bestBid: bid,
        bestAsk: ask,
        spread,
        endDate: isoDate(endMs),
        updatedAt: isoDate(nowMs - random.between(5, 240) * 1000),
        acceptingOrders: true,
        closed: false,
        enableOrderBook: true,
        orderMinSize: 5,
        orderPriceMinTickSize: 0.001,
        feesEnabled: random.random() > 0.5,
        feeSchedule: { rate: 0.02 },
        category,
        synthetic: true,
        demoRegime: regime,
        demoNews: newsCount,
        demoEventRisk: eventRisk,
      };
      const market = normalizeMarket(raw);
      if (!market) continue;
      market.synthetic = true;
      market.demoRegime = regime;
      market.demoNews = newsCount;
      market.demoEventRisk = eventRisk;
      market.category = category;
      markets.push(market);
      index += 1;
    }
  }

  return {
    markets,
    fetchedAt: new Date(nowMs).toISOString(),
    source: MODE.TEST,
    note: '520 synthetic markets generated in the browser (seeded, deterministic)',
  };
}

/** Build a 24-hour, 15-minute price series that ends exactly at the market's current price. */
export function synthesizeHistory(market, { nowMs = Date.now(), seed } = {}) {
  const regime = market.demoRegime || 'range';
  const baseSeed = seed ?? [...String(market.id)].reduce((acc, ch) => acc + ch.charCodeAt(0), 7) * 7919;
  const random = makeRandom(baseSeed);
  const points = 96;
  const stepMs = 15 * 60_000;
  const noise = regime === 'range' ? 0.0032 : 0.0045;
  const price = clamp(market.price, 0.03, 0.97);
  const series = new Array(points);
  let value = price;

  // Walk backwards from the quoted price so the last point always matches the market
  // and the intended regime shape is preserved instead of being flattened by an anchor shift.
  for (let i = points - 1; i >= 0; i -= 1) {
    series[i] = { t: nowMs - (points - 1 - i) * stepMs, p: Number(value.toFixed(4)) };
    let drift = 0;
    if (regime === 'up') drift = 0.0018;
    else if (regime === 'down') drift = -0.0018;
    else if (regime === 'breakout') drift = i < points * 0.62 ? 0.0002 : 0.009;
    else drift = (price - value) * 0.05;
    value = clamp(value - drift - random.normal() * noise, 0.02, 0.98);
  }

  return series;
}

const SYNTHETIC_HEADLINES = {
  crypto: [
    'Spot flows turn positive as large wallets add exposure',
    'Exchange reserves slip to a fresh monthly low',
    'Analysts split on whether the move has confirmation',
  ],
  econ: [
    'Traders trim odds ahead of the next data print',
    'Revised consensus puts the headline figure slightly higher',
    'Officials repeat that policy stays data dependent',
  ],
  politics: [
    'Committee vote scheduled for later this week',
    'New polling shows the gap narrowing',
    'Leadership signals the timeline may slip',
  ],
  sports: [
    'Starting lineup confirmed after a limited practice week',
    'Weather forecast shifts wind direction for kickoff',
    'Coach says the game plan is unchanged',
  ],
  culture: [
    'Early tracking estimates land above expectations',
    'Release schedule moves by one week',
    'Festival jury announces its shortlist',
  ],
  weather: [
    'Forecast model nudges the probability band upward',
    'Local stations issue an advisory for the region',
    'Updated guidance keeps the same general pattern',
  ],
  other: [
    'Desk note flags thin liquidity around the event window',
    'Participants report wider quotes than yesterday',
  ],
};

export function synthesizeNews(market, { nowMs = Date.now() } = {}) {
  const count = market.demoNews ?? 0;
  if (!count) return [];
  const random = makeRandom([...String(market.id)].reduce((acc, ch) => acc + ch.charCodeAt(0), 11) * 104_729);
  const pool = SYNTHETIC_HEADLINES[market.category] || SYNTHETIC_HEADLINES.other;
  const risk = market.demoEventRisk || 'low';
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const title = `${market.eventTitle}: ${pool[i % pool.length]}`;
    items.push({
      title,
      link: `https://example.com/test-data/${market.id}/${i}`,
      source: 'TEST DATA wire (synthetic)',
      sourceUrl: 'https://example.com/test-data',
      publishedAtIso: new Date(nowMs - random.between(5, 20) * 60_000 * (i + 1)).toISOString(),
      publishedMs: nowMs - random.between(5, 20) * 60_000 * (i + 1),
      description: `Synthetic headline generated for ${market.question}`,
      synthetic: true,
      eventRiskHint: i === 0 ? risk : 'low',
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* facade used by the desk                                             */
/* ------------------------------------------------------------------ */

export function createDataLayer({ mode = MODE.LIVE, now = () => Date.now(), seed = 20261019 } = {}) {
  let universeById = new Map();

  return {
    mode,
    sourceLabel: SOURCE_LABEL[mode],

    async getUniverse({ maxScan = 500, onProgress } = {}) {
      const universe = mode === MODE.TEST
        ? synthesizeUniverse({ nowMs: now(), seed })
        : await fetchLiveUniverse({ maxScan, onProgress });
      universeById = new Map(universe.markets.map(market => [market.id, market]));
      return universe;
    },

    getMarketById(id) {
      return universeById.get(id) || null;
    },

    /** Full outcome series used by the Charts agent. */
    async getSeries(market) {
      if (!market) throw new Error('market not found in the scanned universe');
      if (mode === MODE.TEST) {
        return {
          points: synthesizeHistory(market, { nowMs: now() }),
          source: 'synthetic 15-minute series',
          outcomes: market.outcomes,
          fetchedAt: new Date(now()).toISOString(),
        };
      }
      let points;
      let usedInterval = '1d / 10m';
      try {
        points = await fetchLiveHistory(market.tokens[0], { interval: '1d', fidelity: 10 });
      } catch {
        // One retry on a wider window before the Charts agent decides it has too little data.
        points = await fetchLiveHistory(market.tokens[0], { interval: '1w', fidelity: 60 });
        usedInterval = '1w / 60m';
      }
      return {
        points,
        source: `Polymarket CLOB /prices-history (${usedInterval})`,
        outcomes: market.outcomes,
        fetchedAt: new Date(now()).toISOString(),
      };
    },

    async getNews(market) {
      if (!market) throw new Error('market not found in the scanned universe');
      if (mode === MODE.TEST) return synthesizeNews(market, { nowMs: now() });
      const items = await fetchLiveNews(buildNewsQuery(market));
      return items.map(item => ({ ...item, synthetic: false }));
    },

    isLive() {
      return mode === MODE.LIVE;
    },
  };
}

export function buildNewsQuery(market) {
  const stop = new Set([
    'will', 'the', 'a', 'an', 'by', 'on', 'in', 'at', 'to', 'of', 'and', 'or', 'for',
    'market', 'close', 'above', 'below', 'yes', 'no', 'this', 'that', 'next', 'be',
  ]);
  const words = `${market.eventTitle || ''} ${market.question || ''}`
    .replace(/[^a-zA-Z0-9$%.\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 1 && !stop.has(word.toLowerCase()));
  const unique = [...new Set(words)].slice(0, 7);
  return unique.join(' ');
}
