import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { matchScore, parseKalshi, parseManifold, parsePolymarket, searchMarkets } from '../tools/markets.mjs';
import { runTool } from './helpers.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/markets/', import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'));
const noWait = async () => {};

test('polymarket: yes/no prices, multi-outcome markets, closed markets skipped', () => {
  const out = parsePolymarket(fixture('polymarket'));
  assert.equal(out.length, 2);
  const [cut, chair] = out;
  assert.equal(cut.price_yes, 0.62);
  assert.equal(cut.volume_usd, 1250000.5);
  assert.equal(cut.spread, 0.02);
  assert.equal(cut.url, 'https://polymarket.com/event/fed-decision-in-december');
  assert.equal(cut.real_money, true);
  assert.equal(chair.price_yes, null);
  assert.deepEqual(chair.outcomes, { Alpha: 0.5, Beta: 0.3, Gamma: 0.2 });
});

test('kalshi: cents and dollar-string prices both read, settled markets skipped', () => {
  const out = parseKalshi(fixture('kalshi'));
  assert.equal(out.length, 3);
  const cut = out.find((m) => m.id === 'FEDDEC26-CUT25');
  assert.equal(cut.price_yes, 0.59);
  assert.equal(cut.spread, 0.02);
  assert.equal(cut.volume_usd, 310000);
  assert.equal(cut.liquidity_usd, 25000);
  assert.match(cut.title, /Fed rate decision December 2026: Cut of 25 bp/);
  const hold = out.find((m) => m.id === 'FEDDEC26-HOLD');
  assert.equal(hold.price_yes, 0.4);
  assert.equal(hold.volume_usd, 5200);
});

test('manifold: play money is marked as such and never given a dollar volume', () => {
  const out = parseManifold(fixture('manifold'));
  assert.equal(out.length, 2);
  assert.equal(out[0].price_yes, 0.57);
  assert.equal(out[0].real_money, false);
  assert.equal(out[0].volume_usd, null);
  assert.equal(out[0].volume_play_money, 15432.1);
  assert.equal(out[1].price_yes, null);
});

test('parsers accept empty or unexpected replies without throwing', () => {
  for (const parse of [parsePolymarket, parseKalshi, parseManifold]) {
    assert.deepEqual(parse(null), []);
    assert.deepEqual(parse({ unexpected: true }), []);
  }
  assert.deepEqual(parsePolymarket({ events: [{ markets: [{ outcomes: 'not json', outcomePrices: '[' }] }] })[0].price_yes, null);
});

test('matching ranks by shared key words', () => {
  assert.equal(matchScore('Fed cut December 2026', 'Will the Fed cut interest rates in December 2026?'), 1);
  assert.equal(matchScore('Fed cut December 2026', 'Rain in a city tomorrow'), 0);
  assert.equal(matchScore('the and will', 'anything'), 0);
});

test('search with the fixture folder: all venues, best match first, unrelated markets dropped', async () => {
  const res = await runTool('markets.mjs', ['--query', 'Fed cut December 2026', '--fixture', FIXTURES]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.errors, []);
  assert.ok(out.results.length >= 3);
  assert.equal(out.results[0].match_score, 1);
  assert.ok(!out.results.some((r) => /Rain/.test(r.title)));
  assert.deepEqual(new Set(out.results.map((r) => r.venue)), new Set(['polymarket', 'kalshi', 'manifold']));
});

test('a venue that times out or fails is reported and the others still answer', async () => {
  const fetch = async (url) => {
    const host = new URL(url).host;
    if (host.startsWith('gamma-api')) throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (host.startsWith('api.elections')) return { status: 503, text: async () => 'busy' };
    return { status: 200, text: async () => JSON.stringify(fixture('manifold')) };
  };
  const out = await searchMarkets({ query: 'Fed December 2026', fetch, sleep: noWait, now: () => 0 });
  assert.deepEqual(out.errors, [{ venue: 'polymarket', error: 'timed out' }, { venue: 'kalshi', error: 'HTTP 503' }]);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].venue, 'manifold');
  assert.equal(out.real_money_unreachable, true, 'both real-money venues failed');
  assert.equal(out.note, 'all real-money venues unreachable');
});

test('one real-money venue answering is enough: real_money_unreachable stays false', async () => {
  const fetch = async (url) => {
    const host = new URL(url).host;
    if (host.startsWith('gamma-api')) return { status: 503, text: async () => 'busy' };
    return { status: 200, text: async () => '[]' };
  };
  const out = await searchMarkets({ query: 'Fed December 2026', venues: ['polymarket', 'kalshi'], fetch, sleep: noWait, now: () => 0 });
  assert.equal(out.real_money_unreachable, false);
  assert.equal(out.note, undefined);
});

test('only GET requests are sent, spaced at least one second apart', async () => {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init) => {
    calls.push(init.method);
    return { status: 200, text: async () => '[]' };
  };
  await searchMarkets({ query: 'Fed December', venues: ['manifold', 'manifold'], fetch, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(calls, ['GET', 'GET']);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 1000);
});

test('bad input is refused', async () => {
  await assert.rejects(searchMarkets({ query: 'the and', fetch: async () => {} }), { code: 'query_empty' });
  await assert.rejects(searchMarkets({ query: 'Fed cut', venues: ['predictit'], fetch: async () => {} }), { code: 'venue_unknown' });
  assert.equal((await runTool('markets.mjs', ['--fixture', FIXTURES])).code, 2);
  assert.equal((await runTool('markets.mjs', ['--query', 'Fed', '--limit', '0', '--fixture', FIXTURES])).code, 1);
});

test('a spread outside 0..1 (for example in cents) is recorded as unknown', () => {
  const reply = { events: [{ slug: 'e', markets: [{ id: 'm', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', volumeNum: 300000, spread: 2 }] }] };
  assert.equal(parsePolymarket(reply)[0].spread, null);
  const ok = { events: [{ slug: 'e', markets: [{ id: 'm', question: 'Q', outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', volumeNum: 300000, spread: 0.02 }] }] };
  assert.equal(parsePolymarket(ok)[0].spread, 0.02);
});
