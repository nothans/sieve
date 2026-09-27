// Tests for crosscheck: every pair judged from both sides, remembered, and kept inside a budget.
// No network: Jev is a stub client, or the real client over a stubbed fetch.
// Run: node --test "test/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cc = require('../lib/crosscheck.cjs');
const { createClient, noul } = require('../lib/jev.cjs');
const { requestFor, view } = require('../lib/sift.cjs');
const { relatedLens } = require('../lib/lenses.cjs');
const { buildCorpus } = require('../lib/corpus.cjs');
const { loadConfig } = require('../lib/config.cjs');

const item = (id, text, extra = {}) => ({ id, kind: 'note', title: `t${id}`, date: '2026-09-01', path: `notes/${id}.md`, line: 1, text, ...extra });
const config = (crosscheck) => ({ root: os.tmpdir(), dir: os.tmpdir(), crosscheck });
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-cc-')), name);

// A stand-in for the client. `says(anchorText, itemText)` gives the chance that the item
// contradicts the anchor; the rest of the probability goes to "unrelated". A number below zero
// fails the whole request.
function stub(says, profile) {
  const calls = [];
  return {
    calls,
    model: profile?.model || 'stub',
    profile,
    summary: () => ({ requests: calls.length, cached: 0, cost_usd: calls.length * 0.001 }),
    async map(requests, toRequest, { onResult, cache } = {}) {
      for (let i = 0; i < requests.length; i++) {
        const { state, questions } = toRequest(requests[i], i);
        calls.push({ state, questions, cache });
        const answers = {};
        let failed = false;
        for (const id of Object.keys(questions)) {
          const it = id.includes('.') ? state.items[id.split('.')[0]] : state.item;
          const c = says(state.anchor.text, it.text);
          if (c < 0) failed = true;
          const probabilities = typeof c === 'object' ? c : { same: 0, supports: 0, contradicts: c, topic: 0, unrelated: 1 - c };
          answers[id] = { type: 'choice', choice: 'x', confidence: 1, probabilities };
        }
        onResult(failed ? { error: 'boom' } : { answers }, i, requests[i]);
      }
    },
  };
}
const asked = (jev) => jev.calls.reduce((n, c) => n + Object.keys(c.questions).length, 0);

test('crosscheck settings: defaults, overrides, and mistakes caught before anything runs', () => {
  assert.deepEqual({ ...cc.settingsFor(config()), kinds: undefined, reportsDir: undefined }, { within: 'all', flag: 0.5, review: 0.35, same: 0.7, budget: 1, kinds: undefined, reportsDir: undefined });
  assert.equal(cc.settingsFor(config({ within: 'label' }), { within: 'kind' }).within, 'kind');
  assert.equal(cc.settingsFor(config({ budget: 3 }), { budget: '0.5' }).budget, 0.5);
  assert.throws(() => cc.settingsFor(config({ within: 'folder' })), /one of all, label, kind/);
  assert.throws(() => cc.settingsFor(config({ flag: 0.3, review: 0.35 })), /"flag" must be above "review"/);
  assert.throws(() => cc.settingsFor(config({ same: 1.2 })), /probability between 0 and 1/);
  assert.throws(() => cc.settingsFor(config(), { budget: 'lots' }), /amount in dollars/);
  assert.throws(() => cc.settingsFor(config({ kinds: 'insight' })), /"kinds" must be a list/);
});

test('pairs: each pair once, inside its group, and only the changed ones when asked', () => {
  const items = [item('a', 'x', { label: 'one' }), item('b', 'y', { label: 'one' }), item('c', 'z', { label: 'two' }), item('d', 'w', { label: 'two' }), item('e', 'v', { label: 'three' })];
  const ids = (pairs) => pairs.map(([x, y]) => x.id + y.id);
  assert.deepEqual(ids(cc.pairsOf(cc.groupsOf(items, 'label'))), ['ab', 'cd']); // "three" has nobody to compare with
  assert.equal(cc.pairsOf(cc.groupsOf(items, 'all')).length, 10);
  assert.equal(cc.pairsOf(cc.groupsOf(items, 'kind')).length, 10);
  assert.deepEqual(ids(cc.pairsOf(cc.groupsOf(items, 'all'), new Set(['e']))), ['ae', 'be', 'ce', 'de']);
});

test('a pair is flagged on the average of both sides, never on one side alone', async () => {
  const items = [
    item('old', 'warnings were ignored', { date: '2026-03-01' }),
    item('new', 'warnings were enough', { date: '2026-09-01' }),
    item('loud', 'a one-sided reader'),
    item('calm', 'nothing to do with it'),
  ];
  const jev = stub((anchor, it) => {
    if (anchor.includes('warnings') && it.includes('warnings')) return 0.9; // both sides agree
    if (anchor.includes('one-sided') && it.includes('nothing')) return 0.8; // only this side
    return 0;
  });
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.plan.pairs, 6);
  assert.equal(asked(jev), 12); // every pair from both sides
  assert.equal(jev.calls.every((c) => c.cache === false), true); // the pair memory is the record
  assert.equal(res.contradictions.length, 1);
  assert.deepEqual([res.contradictions[0].a.id, res.contradictions[0].b.id], ['new', 'old']); // newer first
  assert.deepEqual(res.contradictions[0].sides, [0.9, 0.9]);
  assert.equal(res.review.length, 1); // 0.8 and 0 average 0.4: a second look, not a finding
  assert.deepEqual(res.review[0].sides.slice().sort(), [0, 0.8]);
  assert.equal(res.same.length, 0);
});

test('pairs making the same point are listed apart from contradictions', async () => {
  const items = [item('a', 'the survey'), item('b', 'the survey, retold'), item('c', 'elsewhere')];
  const jev = stub((anchor, it) => (anchor.includes('survey') && it.includes('survey') ? { same: 0.9, supports: 0.1, contradicts: 0, topic: 0, unrelated: 0 } : 0));
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.contradictions.length, 0);
  assert.equal(res.same.length, 1);
  assert.equal(res.same[0].relation, 'same');
  assert.ok(Math.abs(res.same[0].p - 0.9) < 1e-9);
});

test('memory: a second run asks nothing, a new note asks only its pairs, an edited note asks again', async () => {
  const file = tmp('pairs.jsonl');
  const items = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
  const run = async (list) => {
    const jev = stub(() => 0.1);
    const res = await cc.crosscheck(jev, list, config(), { memoryFile: file });
    return { jev, res };
  };
  assert.equal(asked((await run(items)).jev), 6);
  const again = await run(items);
  assert.equal(asked(again.jev), 0);
  assert.equal(again.res.plan.remembered, 6);
  assert.equal(again.res.plan.estimate.cost, 0);

  const grown = await run([...items, item('d', 'delta')]);
  assert.equal(asked(grown.jev), 6); // d against a, b, c, from both sides
  assert.equal(grown.res.plan.remembered, 6);

  // moving a note keeps its judgments; changing its words forgets them
  const moved = await run([item('a', 'alpha', { path: 'elsewhere/a.md', line: 40 }), items[1], items[2]]);
  assert.equal(asked(moved.jev), 0);
  const edited = await run([item('a', 'alpha, revised'), items[1], items[2]]);
  assert.equal(asked(edited.jev), 4);
});

test('memory is kept apart for each backend', async () => {
  const file = tmp('pairs.jsonl');
  const items = [item('a', 'alpha'), item('b', 'beta')];
  const cloud = stub(() => 0.1, { id: 'openrouter', kind: 'openrouter', model: 'typesafe/jev-1.13', baseUrl: 'https://openrouter.ai/api/alpha/decisions', pack: 16 });
  await cc.crosscheck(cloud, items, config(), { memoryFile: file });
  const local = stub(() => 0.1, { id: 'local', kind: 'local', model: 'kev-latest', baseUrl: 'http://127.0.0.1:8009/v1/systemone', pack: 1 });
  const res = await cc.crosscheck(local, items, config(), { memoryFile: file });
  assert.equal(asked(local), 2);
  assert.equal(local.calls.length, 2); // one item per request, as the local profile asks
  assert.equal(res.plan.estimate.cost, 0); // a model on this machine costs nothing
});

test('budget: a run that would cost too much stops before spending, and a dry run never asks', async () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`n${i}`, `note ${i} `.repeat(200)));
  const profile = { id: 'openrouter', kind: 'openrouter', model: 'typesafe/jev-1.13', baseUrl: 'https://openrouter.ai/api/alpha/decisions', pack: 16, concurrency: 4 };
  const jev = stub(() => 0, profile);
  let plan;
  await assert.rejects(cc.crosscheck(jev, items, config({ budget: 0.01 }), { onPlan: (p) => { plan = p; } }), /over the \$0\.01 budget\. Nothing was spent\./);
  assert.equal(jev.calls.length, 0);
  assert.equal(plan.pairs, 780);
  assert.equal(plan.estimate.judgments, 1560);
  assert.ok(plan.estimate.cost > 0.01);

  const dry = await cc.crosscheck(jev, items, config(), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(jev.calls.length, 0);
  assert.equal(dry.contradictions.length, 0);
});

test('the estimate sizes each request without building it', () => {
  const lens = relatedLens();
  const anchor = item('z', 'the anchor note, with some length to it');
  for (const size of [1, 2, 9, 16, 26]) {
    const group = Array.from({ length: size }, (_, i) => item(`g${i}`, `body ${i} `.repeat(30 + i)));
    const real = JSON.stringify(requestFor(group, { q: lens }, { anchor: view(anchor) })).length;
    const guess = cc.requestChars(anchor, group, lens);
    assert.equal(guess, real, `pack ${size}`);
  }
});

test('a failed request leaves its pairs unjudged, and the next run asks only those', async () => {
  const file = tmp('pairs.jsonl');
  const items = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma')];
  const flaky = stub((anchor) => (anchor === 'alpha' ? -1 : 0.9));
  const res = await cc.crosscheck(flaky, items, config(), { memoryFile: file });
  assert.equal(res.unjudged, 2); // a-b and a-c lack a's side
  assert.equal(res.errors.length, 2);
  assert.equal(res.contradictions.length, 1); // b-c was judged from both sides
  const healed = stub(() => 0.9);
  const next = await cc.crosscheck(healed, items, config(), { memoryFile: file });
  assert.equal(asked(healed), 2);
  assert.equal(next.unjudged, 0);
  assert.equal(next.contradictions.length, 3);
});

test('the report names the backend, puts the newer note first, and calls out a note at odds with several', async () => {
  const items = [
    item('lone', 'the dissent', { date: '2026-09-20', title: 'The dissent' }),
    ...['one', 'two', 'three'].map((id, i) => item(id, `the consensus ${id}`, { date: `2026-0${i + 1}-01`, title: `Consensus ${id}` })),
  ];
  const jev = stub((anchor, it) => ((anchor.includes('dissent') ? 1 : 0) + (it.includes('dissent') ? 1 : 0) === 1 ? 0.95 : 0), { id: 'local', label: 'Local server', kind: 'local', model: 'kev-latest', baseUrl: 'http://127.0.0.1:8009/v1/systemone', pack: 1 });
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.contradictions.length, 3);
  assert.deepEqual(res.contested.map((c) => [c.item.id, c.pairs]), [['lone', 3]]);
  const md = cc.buildReport(res, { today: '2026-09-27', linkFrom: { root: os.tmpdir(), dir: path.join(os.tmpdir(), 'reports') } });
  assert.match(md, /^# Sieve crosscheck, 2026-09-27/);
  assert.match(md, /Answered by Local server: `kev-latest`/);
  assert.doesNotMatch(md, /Jev/);
  assert.match(md, /It compared 4 items in 6 pairs\./);
  assert.match(md, /12 judgments, 0 remembered from earlier runs and 12 asked now/);
  assert.match(md, /## 1\. Contradictions \(3\)/);
  assert.match(md, /\| 95% \| 95% and 95% \| 2026-09-20 \[The dissent\]\(\.\.\/notes\/lone\.md\) \| 2026-03-01 \[Consensus three\]/);
  assert.match(md, /## 2\. Notes that disagree with several others \(1\)/);
  assert.match(md, /## 3\. Worth a second look \(0\)/);
  assert.match(md, /## 4\. The same point, twice \(0\)/);
});

test('annotations land on the newer note; --strict turns a contradiction into an error', async () => {
  const items = [item('old', 'claim', { date: '2026-01-01', title: 'Old claim' }), item('new', 'claim, reversed', { date: '2026-09-01', title: 'New claim', line: 12 })];
  const res = await cc.crosscheck(stub(() => 0.9), items, config());
  const root = path.join(os.tmpdir(), 'repo');
  const [warn] = cc.githubAnnotations(res, root, { cwd: root });
  assert.equal(warn, '::warning file=notes/new.md,line=12,title=sieve%3A crosscheck::Contradicts "Old claim" (notes/old.md:1), 90%25: New claim');
  assert.match(cc.githubAnnotations(res, root, { cwd: root, strict: true })[0], /^::error file=notes\/new\.md/);
});

test('the shipped crosscheck example loads: the sample notebook plus sixteen field notes', () => {
  const notes = loadConfig(path.join(__dirname, '..', 'examples', 'research-notes', 'crosscheck.config.json'));
  const items = buildCorpus(notes);
  const by = {};
  for (const it of items) by[it.kind] = (by[it.kind] || 0) + 1;
  assert.deepEqual(by, { brief: 12, news: 12, insight: 20, 'field-note': 16 });
  assert.equal(cc.settingsFor(notes).budget, 0.25);
  assert.equal(cc.pairsOf(cc.groupsOf(items, 'all')).length, 1770);
});

test('the client: map can skip the cache and cap request starts per minute', async () => {
  const file = tmp('answers.jsonl');
  const ok = { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, cost: 0 } }) };
  let now = 0;
  const waits = [];
  const startedAt = [];
  const jev = createClient({
    apiKey: 'k', cacheFile: file, now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
    fetch: async () => { startedAt.push(now); return ok; },
  });
  const Q = { a: noul('Is it?') };
  // the same request five times: the cache would answer four of them, cache: false asks all five
  await jev.map([1, 2, 3, 4, 5], () => ({ state: 'same', questions: Q }), { concurrency: 1, cache: false, perMinute: 2 });
  assert.deepEqual(startedAt, [0, 0, 60000, 60000, 120000]);
  assert.deepEqual(waits, [60000, 60000]);
  assert.equal(fs.existsSync(file), false);
  // without a cap nothing waits, and the cache works as before
  waits.length = 0;
  await jev.map([1, 2, 3], () => ({ state: 'same', questions: Q }), { concurrency: 1 });
  assert.deepEqual(waits, []);
  assert.equal(jev.summary().requests, 6);
  assert.equal(jev.summary().cached, 2);
});
