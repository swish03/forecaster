#!/usr/bin/env node
// Looks for prediction markets about the same event on Polymarket, Kalshi and
// Manifold, using only their public read (GET) endpoints, one request per
// second at most. A venue that fails or times out is reported, not fatal.
// The tool only finds candidates; the agent decides whether one is the
// "same" question (method.md, research plan step 4).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DataError, required, runCli, writeJson } from './core/cli.mjs';

const HELP = `markets: search public prediction markets for a question.

Usage:
  node tools/markets.mjs --query "<key words>" [--venues polymarket,kalshi,manifold]
       [--limit 8] [--timeout-ms 10000] [--out <file>] [--fixture <folder>]

--fixture  read saved responses (polymarket.json, kalshi.json, manifold.json)
           from a folder instead of the network (for tests)

Prints { query, checked_at, results: [...], errors: [...], real_money_unreachable },
best keyword match first. real_money_unreachable is true (with the note
"all real-money venues unreachable") when Polymarket and Kalshi both failed.
For a multiple-choice question, map the options to these results with
option-market.mjs (it copies the prices); only that table can be blended.
Each result: venue, id, title, url, price_yes, outcomes, volume_usd, liquidity_usd,
spread, close_time, real_money, match_score (0-1, keyword overlap only).
Exit 0 = searched (even if some venues failed), 1 = bad input, 2 = wrong command.`;

const HOSTS = {
  polymarket: 'https://gamma-api.polymarket.com',
  kalshi: 'https://api.elections.kalshi.com',
  manifold: 'https://api.manifold.markets',
};
const SPACING_MS = 1100;
const KALSHI_PAGES = 3;
const STOP = new Set(['the', 'and', 'will', 'for', 'with', 'from', 'than', 'that', 'this', 'what', 'when', 'which', 'before', 'after', 'into', 'over', 'under', 'between', 'more', 'less', 'least', 'most', 'there', 'their', 'have', 'been', 'are', 'was', 'any', 'how', 'many', 'much']);

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
const isoOrNull = (v) => {
  const ms = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

export function tokens(text) {
  return new Set(String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w)));
}

export function matchScore(query, title) {
  const q = tokens(query);
  if (!q.size) return 0;
  const t = tokens(title);
  let hits = 0;
  for (const w of q) if (t.has(w)) hits += 1;
  return Number((hits / q.size).toFixed(3));
}

// ---- response parsers (one per venue) ---------------------------------------

// A bid-ask spread as a share of $1 (0 to 1). Anything else (for example a
// value in cents) is unknown rather than guessed, so it never earns weight.
function unitSpread(value) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Number(value.toFixed(4));
}

export function parsePolymarket(json) {
  const out = [];
  for (const event of Array.isArray(json?.events) ? json.events : []) {
    for (const m of Array.isArray(event?.markets) ? event.markets : []) {
      if (m?.closed === true || m?.active === false) continue;
      const names = parseList(m.outcomes);
      const prices = parseList(m.outcomePrices)?.map(num);
      let priceYes = null;
      let outcomes = null;
      if (names && prices && names.length === prices.length) {
        const yes = names.findIndex((n) => String(n).toLowerCase() === 'yes');
        if (yes !== -1 && names.length === 2) priceYes = prices[yes];
        else outcomes = Object.fromEntries(names.map((n, i) => [String(n), prices[i]]));
      }
      const bid = num(m.bestBid);
      const ask = num(m.bestAsk);
      out.push({
        venue: 'polymarket',
        id: String(m.id ?? m.slug ?? ''),
        title: String(m.question ?? event.title ?? ''),
        url: event.slug ? `https://polymarket.com/event/${event.slug}` : null,
        price_yes: priceYes,
        outcomes,
        volume_usd: num(m.volumeNum ?? m.volume),
        liquidity_usd: num(m.liquidityNum ?? m.liquidity),
        spread: unitSpread(num(m.spread) ?? (bid !== null && ask !== null ? ask - bid : null)),
        close_time: isoOrNull(m.endDate ?? event.endDate),
        real_money: true,
      });
    }
  }
  return out;
}

// Kalshi prices are cents (yes_bid) in older replies and dollar strings
// (yes_bid_dollars) in newer ones; both are read. Volume is in contracts,
// each paying $1, so contracts are reported as the dollar face value.
export function parseKalshi(json) {
  const price = (m, field) => {
    const dollars = num(m[`${field}_dollars`]);
    if (dollars !== null) return dollars;
    const cents = num(m[field]);
    return cents === null ? null : cents / 100;
  };
  const out = [];
  for (const event of Array.isArray(json?.events) ? json.events : []) {
    for (const m of Array.isArray(event?.markets) ? event.markets : []) {
      if (m?.status && !['open', 'active'].includes(m.status)) continue;
      const bid = price(m, 'yes_bid');
      const ask = price(m, 'yes_ask');
      const last = price(m, 'last_price');
      const mid = bid && ask ? (bid + ask) / 2 : last;
      const sub = m.yes_sub_title ?? m.subtitle ?? '';
      out.push({
        venue: 'kalshi',
        id: String(m.ticker ?? ''),
        title: [event.title ?? m.title ?? '', sub].filter(Boolean).join(': '),
        url: m.ticker ? `https://kalshi.com/markets/${String(event.series_ticker ?? m.ticker).toLowerCase()}` : null,
        price_yes: mid === null ? null : Number(mid.toFixed(4)),
        outcomes: null,
        volume_usd: num(m.volume_fp ?? m.volume),
        liquidity_usd: num(m.liquidity_dollars) ?? (num(m.liquidity) === null ? null : num(m.liquidity) / 100),
        spread: bid !== null && ask !== null && ask > 0 ? unitSpread(ask - bid) : null,
        close_time: isoOrNull(m.close_time ?? m.expiration_time),
        real_money: true,
      });
    }
  }
  return out;
}

// Manifold uses play money (mana), so its volume is not dollars and the blend
// never gives it weight; the price is still useful context for the dossier.
export function parseManifold(json) {
  const out = [];
  for (const m of Array.isArray(json) ? json : []) {
    if (!m || m.isResolved) continue;
    const answers = Array.isArray(m.answers)
      ? Object.fromEntries(m.answers.filter((a) => a?.text).map((a) => [String(a.text), num(a.probability)]))
      : null;
    out.push({
      venue: 'manifold',
      id: String(m.id ?? ''),
      title: String(m.question ?? ''),
      url: typeof m.url === 'string' ? m.url : null,
      price_yes: m.outcomeType === 'BINARY' ? num(m.probability) : null,
      outcomes: answers,
      volume_usd: null,
      liquidity_usd: null,
      volume_play_money: num(m.volume),
      spread: null,
      close_time: isoOrNull(m.closeTime),
      real_money: false,
    });
  }
  return out;
}

// ---- fetching ---------------------------------------------------------------

function fixtureFetch(dir) {
  const byHost = { 'gamma-api.polymarket.com': 'polymarket.json', 'api.elections.kalshi.com': 'kalshi.json', 'api.manifold.markets': 'manifold.json' };
  return async (url) => {
    const name = byHost[new URL(url).host];
    let text;
    try {
      text = await readFile(join(dir, name), 'utf8');
    } catch {
      throw new Error(`no fixture for ${new URL(url).host}`);
    }
    return { ok: true, status: 200, text: async () => text };
  };
}

function makeGetter({ fetch, timeoutMs, sleep }) {
  let last = -Infinity;
  return async (url) => {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let response;
    try {
      response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' || /timeout/i.test(String(error?.cause?.code)) ? 'timed out' : `network error (${error.message})`);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    try {
      return JSON.parse(await response.text());
    } catch {
      throw new Error('reply was not JSON');
    }
  };
}

const SEARCHES = {
  async polymarket(get, query) {
    return parsePolymarket(await get(`${HOSTS.polymarket}/public-search?${new URLSearchParams({ q: query, limit_per_type: '10' })}`));
  },
  // Kalshi has no documented text search, so open events are paged and matched here.
  async kalshi(get) {
    const found = [];
    let cursor = '';
    for (let page = 0; page < KALSHI_PAGES; page += 1) {
      const params = new URLSearchParams({ status: 'open', with_nested_markets: 'true', limit: '200' });
      if (cursor) params.set('cursor', cursor);
      const json = await get(`${HOSTS.kalshi}/trade-api/v2/events?${params}`);
      found.push(...parseKalshi(json));
      cursor = typeof json?.cursor === 'string' ? json.cursor : '';
      if (!cursor) break;
    }
    return found;
  },
  async manifold(get, query) {
    return parseManifold(await get(`${HOSTS.manifold}/v0/search-markets?${new URLSearchParams({ term: query, limit: '10', filter: 'open', sort: 'liquidity' })}`));
  },
};

export async function searchMarkets({ query, venues = Object.keys(SEARCHES), limit = 8, fetch = globalThis.fetch, timeoutMs = 10000, sleep, now = Date.now }) {
  if (typeof query !== 'string' || !tokens(query).size) throw new DataError('query_empty', 'give a few key words');
  const unknown = venues.filter((v) => !SEARCHES[v]);
  if (unknown.length) throw new DataError('venue_unknown', unknown.join(', '));
  const get = makeGetter({ fetch, timeoutMs, sleep: sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))) });
  const results = [];
  const errors = [];
  for (const venue of venues) {
    try {
      results.push(...(await SEARCHES[venue](get, query)));
    } catch (error) {
      errors.push({ venue, error: error.message });
    }
  }
  const ranked = results
    .map((r) => ({ ...r, match_score: matchScore(query, r.title) }))
    .filter((r) => r.match_score > 0)
    .sort((a, b) => b.match_score - a.match_score || (b.volume_usd ?? -1) - (a.volume_usd ?? -1));
  // Polymarket and Kalshi are the real-money venues. When both failed, the
  // agent may skip them for the rest of the run (RUNBOOK step 3).
  const realMoney = venues.filter((v) => REAL_MONEY_VENUES.has(v));
  const failed = new Set(errors.map((e) => e.venue));
  const unreachable = realMoney.length > 0 && realMoney.every((v) => failed.has(v));
  const out = { query, checked_at: new Date(now()).toISOString(), results: ranked.slice(0, limit), errors, real_money_unreachable: unreachable };
  if (unreachable) out.note = 'all real-money venues unreachable';
  return out;
}

const REAL_MONEY_VENUES = new Set(['polymarket', 'kalshi']);

await runCli({
  meta: import.meta,
  help: HELP,
  options: {
    query: { type: 'string' }, venues: { type: 'string', default: 'polymarket,kalshi,manifold' },
    limit: { type: 'string', default: '8' }, 'timeout-ms': { type: 'string', default: '10000' },
    out: { type: 'string' }, fixture: { type: 'string' },
  },
  async main(values) {
    required(values, 'query');
    const limit = Number(values.limit);
    const timeoutMs = Number(values['timeout-ms']);
    if (!Number.isInteger(limit) || limit < 1 || !(timeoutMs > 0)) throw new DataError('options_invalid', '--limit and --timeout-ms must be positive numbers');
    const result = await searchMarkets({
      query: values.query,
      venues: values.venues.split(',').map((v) => v.trim()).filter(Boolean),
      limit,
      timeoutMs,
      fetch: values.fixture ? fixtureFetch(values.fixture) : globalThis.fetch,
      sleep: values.fixture ? async () => {} : undefined,
    });
    if (values.out) await writeJson(values.out, result);
    return result;
  },
});
