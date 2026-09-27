// Tests for crosscheck: every pair judged from both sides, remembered, and kept inside a budget.
// No network: Jev is a stub client, or the real client over a stubbed fetch.
// Run: node --test "test/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const cc = require('../lib/crosscheck.cjs');
const { createClient, noul } = require('../lib/jev.cjs');
const { requestFor, view } = require('../lib/sift.cjs');
const { relatedLens, RELATIONS } = require('../lib/lenses.cjs');
const { buildCorpus } = require('../lib/corpus.cjs');
const { loadConfig } = require('../lib/config.cjs');

const SIEVE = path.join(__dirname, '..');
const item = (id, text, extra = {}) => ({ id, kind: 'note', title: `t${id}`, date: '2026-09-01', path: `notes/${id}.md`, line: 1, text, ...extra });
const config = (crosscheck) => ({ root: os.tmpdir(), dir: os.tmpdir(), crosscheck });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-cc-'));
const tmp = (name) => path.join(tmpdir(), name);

const OPENROUTER = { id: 'openrouter', label: 'Jev via OpenRouter', kind: 'openrouter', model: 'typesafe/jev-1.13', baseUrl: 'https://openrouter.ai/api/alpha/decisions', pack: 16, concurrency: 4 };
const LOCAL = { id: 'local', label: 'Local server', kind: 'local', model: 'kev-latest', baseUrl: 'http://127.0.0.1:8009/v1/systemone', pack: 1 };

// A stand-in for the client. `says(anchorText, itemText)` gives the chance that the item
// contradicts the anchor (the rest goes to "unrelated"), or a whole set of probabilities. A
// number below zero fails the request. Like the real map, it stops sending once the signal is
// aborted. Every request bills `price`.
function stub(says, profile, { price = 0.001 } = {}) {
  const calls = [];
  return {
    calls,
    model: profile?.model || 'stub',
    profile,
    summary: () => ({ requests: calls.length, cached: 0, cost_usd: calls.length * price }),
    async map(requests, toRequest, options = {}) {
      this.options = options;
      for (let i = 0; i < requests.length; i++) {
        if (options.signal?.aborted) return;
        const { state, questions } = toRequest(requests[i], i);
        calls.push({ state, questions, cache: options.cache });
        const answers = {};
        let failed = false;
        for (const id of Object.keys(questions)) {
          const it = id.includes('.') ? state.items[id.split('.')[0]] : state.item;
          const c = says(state.anchor.text, it.text);
          if (c < 0) failed = true;
          const probabilities = typeof c === 'object' ? c : { same: 0, supports: 0, contradicts: c, topic: 0, unrelated: 1 - c };
          answers[id] = { type: 'choice', choice: 'x', confidence: 1, probabilities };
        }
        options.onResult(failed ? { error: 'boom' } : { answers }, i, requests[i]);
      }
    },
  };
}
const asked = (jev) => jev.calls.reduce((n, c) => n + Object.keys(c.questions).length, 0);

test('crosscheck settings: defaults, overrides, and mistakes caught before anything runs', () => {
  assert.deepEqual({ ...cc.settingsFor(config()), kinds: undefined, reportsDir: undefined }, { within: 'all', flag: 0.5, review: 0.35, same: 0.7, budget: 1, kinds: undefined, reportsDir: undefined });
  assert.equal(cc.settingsFor(config({ within: 'label' }), { within: 'kind' }).within, 'kind');
  assert.equal(cc.settingsFor(config({ budget: 3 }), { budget: '0.5' }).budget, 0.5);
  assert.equal(cc.settingsFor(config(), { budget: '0' }).budget, 0);
  assert.throws(() => cc.settingsFor(config({ within: 'folder' })), /one of all, label, kind/);
  assert.throws(() => cc.settingsFor(config({ flag: 0.3, review: 0.35 })), /"flag" must be above "review"/);
  assert.throws(() => cc.settingsFor(config({ same: 1.2 })), /probability between 0 and 1/);
  assert.throws(() => cc.settingsFor(config({ kinds: 'insight' })), /"kinds" must be a list/);
  // only a plain decimal is a number: nothing here may quietly become 0, 1, or 16
  for (const bad of ['lots', '', ' ', '0x10', '-1', '1e3']) assert.throws(() => cc.settingsFor(config(), { budget: bad }), /amount in dollars/, `--budget "${bad}"`);
  for (const bad of [null, true, [2], -1, NaN]) assert.throws(() => cc.settingsFor(config({ budget: bad })), /amount in dollars/, `budget ${JSON.stringify(bad)}`);
  assert.throws(() => cc.settingsFor(config({ review: null })), /probability between 0 and 1/);
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
    if (anchor.includes('ignored') && it.includes('enough')) return 0.7; // asked with the old note as the anchor
    if (anchor.includes('enough') && it.includes('ignored')) return 0.9; // asked with the new note as the anchor
    if (anchor.includes('one-sided') && it.includes('nothing')) return 0.8; // only this side
    return 0;
  });
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.plan.pairs, 6);
  assert.equal(asked(jev), 12); // every pair from both sides
  assert.equal(jev.calls.every((c) => c.cache === false), true); // the pair memory is the record
  assert.equal(res.contradictions.length, 1);
  const [found] = res.contradictions;
  assert.deepEqual([found.a.id, found.b.id], ['new', 'old']); // newer first
  assert.deepEqual(found.sides, [0.9, 0.7]); // the first side is the one asked with `a` as the anchor
  assert.ok(Math.abs(found.p - 0.8) < 1e-9);
  assert.equal(res.review.length, 1); // 0.8 and 0 average 0.4: a second look, not a finding
  assert.deepEqual([res.review[0].a.id, res.review[0].sides], ['loud', [0.8, 0]]);
  assert.equal(res.same.length, 0);
});

test('findings come strongest first, and an undated note is never taken for the newer one', async () => {
  const items = [item('a', 'claim one'), item('b', 'claim two', { date: null }), item('c', 'claim three', { date: '2026-01-01' })];
  const strength = { 'claim one|claim two': 0.6, 'claim one|claim three': 0.9, 'claim two|claim three': 0.75 };
  const jev = stub((anchor, it) => strength[`${anchor}|${it}`] ?? strength[`${it}|${anchor}`]);
  const res = await cc.crosscheck(jev, items, config());
  assert.deepEqual(res.contradictions.map((f) => `${f.a.id}${f.b.id} ${f.p}`), ['ac 0.9', 'bc 0.75', 'ab 0.6']);
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

test('"kinds" in the config limits what is compared', async () => {
  const items = [item('a', 'alpha'), item('b', 'beta'), item('c', 'gamma', { kind: 'draft' })];
  const jev = stub(() => 0);
  const res = await cc.crosscheck(jev, items, config({ kinds: ['note'] }));
  assert.equal(res.plan.items, 2);
  assert.equal(res.plan.pairs, 1);
  assert.equal(asked(jev), 2);
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

test('memory is kept apart for each backend and for each wording of the question', async () => {
  const file = tmp('pairs.jsonl');
  const items = [item('a', 'alpha'), item('b', 'beta')];
  const run = async (profile) => {
    const jev = stub(() => 0.1, profile);
    const res = await cc.crosscheck(jev, items, config(), { memoryFile: file });
    return { jev, res };
  };
  assert.equal(asked((await run(OPENROUTER)).jev), 2);
  assert.equal(asked((await run(OPENROUTER)).jev), 0);
  // the same model name served from somewhere else is another backend
  const elsewhere = { ...LOCAL, model: OPENROUTER.model };
  const other = await run(elsewhere);
  assert.equal(asked(other.jev), 2);
  assert.equal(other.jev.calls.length, 2); // one item per request, as the local profile asks
  assert.equal(other.res.plan.estimate.cost, 0); // a model on this machine costs nothing
  assert.equal(asked((await run({ ...elsewhere, baseUrl: 'http://127.0.0.1:9000/v1/systemone' })).jev), 2);

  // rewording a relation is a new question: the old answers do not stand in for it
  const was = RELATIONS.topic;
  RELATIONS.topic = `${was} Reworded.`;
  try { assert.equal(asked((await run(OPENROUTER)).jev), 2); } finally { RELATIONS.topic = was; }
  assert.equal(asked((await run(OPENROUTER)).jev), 0);
});

test('memory file: read in pieces, tidied on load, and written once for each request', async () => {
  const file = tmp('pairs.jsonl');
  const p = [0.1, 0.2, 0.3, 0.4, 0];
  const lines = [
    JSON.stringify({ k: 'one', p }),
    JSON.stringify({ k: 'one', p }), // repeated
    JSON.stringify({ k: 'old-shape', p: { same: 0.5, contradicts: 0.5 } }), // how the first release wrote it
    JSON.stringify({ k: 'empty', p: {} }).replace('{}', '[]'), // not five numbers
    JSON.stringify({ k: 'text', p: 'str' }),
    'not json at all',
    JSON.stringify({ k: 'two', p }),
  ];
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n{"k":"torn","p":[0.1,0.`); // CRLF, and a last write cut short
  const memory = new cc.PairMemory(file);
  assert.deepEqual([...memory.map.keys()].sort(), ['old-shape', 'one', 'two']);
  assert.deepEqual(memory.map.get('old-shape'), [0.5, 0, 0.5, 0, 0]);
  // the file now holds exactly what was kept, ending in a newline, so the next append is whole
  const kept = fs.readFileSync(file, 'utf8');
  assert.equal(kept.endsWith('\n'), true);
  assert.deepEqual(kept.trim().split('\n').map((l) => JSON.parse(l).k).sort(), ['old-shape', 'one', 'two']);

  memory.set('x', 'y', { same: 0.12345678, supports: 0, contradicts: 0.9, topic: 0, unrelated: 0 });
  memory.set('y', 'x', { same: 0, supports: 0, contradicts: 1.7, topic: -3, unrelated: 0 });
  assert.equal(fs.readFileSync(file, 'utf8'), kept); // nothing is written until save
  memory.save();
  const again = new cc.PairMemory(file);
  assert.deepEqual(again.get('x', 'y'), { same: 0.1235, supports: 0, contradicts: 0.9, topic: 0, unrelated: 0 });
  assert.deepEqual(again.get('y', 'x'), { same: 0, supports: 0, contradicts: 1, topic: 0, unrelated: 0 });
  assert.equal(again.get('x', 'z'), undefined);

  // a whole last line with no newline after it is kept, and the newline is put back, so the next
  // append cannot run into it
  const cut = tmp('cut.jsonl');
  fs.writeFileSync(cut, `${JSON.stringify({ k: 'first', p })}\n${JSON.stringify({ k: 'last', p })}`);
  assert.deepEqual([...new cc.PairMemory(cut).map.keys()], ['first', 'last']);
  assert.equal(fs.readFileSync(cut, 'utf8'), `${JSON.stringify({ k: 'first', p })}\n${JSON.stringify({ k: 'last', p })}\n`);

  // a chunk boundary in the middle of a line, and of a multi-byte character, loses nothing
  const big = tmp('big.jsonl');
  const many = Array.from({ length: 40000 }, (_, i) => `${JSON.stringify({ k: `k${i}-é`, p })}\n`).join('');
  assert.ok(Buffer.byteLength(many) > (1 << 20));
  fs.writeFileSync(big, many);
  assert.equal(new cc.PairMemory(big).map.size, 40000);
  assert.equal(fs.readFileSync(big, 'utf8'), many); // a tidy file is left alone
});

test('two notes with the same words are asked about once', async () => {
  const items = [item('x', 'the same words', { title: 'same' }), item('y', 'the same words', { title: 'same', path: 'notes/copy.md' }), item('z', 'other words')];
  const jev = stub(() => 0.9);
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.plan.pairs, 3);
  assert.equal(res.plan.judgments, 3); // twin against twin, twin against z, z against twin
  assert.equal(asked(jev), 3);
  assert.equal(res.contradictions.length, 3);
  assert.equal(res.unjudged, 0);
});

test('budget: a run that would cost too much stops before spending, and a dry run never asks', async () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`n${i}`, `note ${i} `.repeat(200)));
  const jev = stub(() => 0, OPENROUTER);
  let plan;
  await assert.rejects(cc.crosscheck(jev, items, config({ budget: 0.01 }), { onPlan: (p) => { plan = p; } }), /over the \$0\.01 budget\. Nothing was spent\./);
  assert.equal(jev.calls.length, 0);
  assert.equal(plan.pairs, 780);
  assert.equal(plan.estimate.judgments, 1560);
  assert.ok(plan.estimate.cost > 0.01);
  assert.equal(plan.estimate.priced, true);
  // an estimate a hair over the budget says so in figures that differ
  const close = Math.floor(plan.estimate.cost * 1000) / 1000;
  await assert.rejects(cc.crosscheck(jev, items, config(), { budget: String(close) }), (err) => {
    const [cost, budget] = err.message.match(/\$\d+\.\d+/g);
    return cost !== budget && /^\$\d+\.\d{4}$/.test(cost);
  });

  // a dry run reports the plan, over budget or not, and sends nothing
  const dry = await cc.crosscheck(jev, items, config({ budget: 0.01 }), { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.plan.overBudget, true);
  assert.equal(jev.calls.length, 0);
  assert.equal(dry.contradictions.length, 0);
});

test('budget: the bill itself is the limit, whatever the estimate said', async () => {
  const file = tmp('pairs.jsonl');
  const items = Array.from({ length: 6 }, (_, i) => item(`n${i}`, `note ${i}`));
  // the estimate for these few words is a fraction of a cent; this backend bills a cent a request
  const dear = () => stub(() => 0.9, { ...OPENROUTER, pack: 1 }, { price: 0.01 });
  const jev = dear();
  const res = await cc.crosscheck(jev, items, config(), { memoryFile: file, budget: '0.045' });
  assert.ok(res.plan.estimate.cost < 0.045);
  assert.equal(res.stopped, 'budget');
  assert.equal(jev.calls.length, 5); // the fifth request took the bill past 4.5 cents
  assert.ok(res.unjudged > 0);
  assert.match(cc.unjudgedLine(res), /stopped when the bill reached the \$0\.04 budget|stopped when the bill reached the \$0\.05 budget/);
  // what was judged is kept, so a run with more to spend asks only the rest
  const more = dear();
  const rest = await cc.crosscheck(more, items, config(), { memoryFile: file, budget: '1' });
  assert.equal(more.calls.length, 30 - 5);
  assert.equal(rest.stopped, null);
  assert.equal(rest.unjudged, 0);
});

test('a run can be stopped from outside, and says so', async () => {
  const items = Array.from({ length: 5 }, (_, i) => item(`n${i}`, `note ${i}`));
  const stopper = new AbortController();
  const jev = stub(() => 0.9, LOCAL);
  const res = await cc.crosscheck(jev, items, config(), { signal: stopper.signal, onProgress: (done) => { if (done === 3) stopper.abort(); } });
  assert.equal(jev.calls.length, 3);
  assert.equal(res.stopped, 'signal');
  assert.match(cc.unjudgedLine(res), /the run was stopped/);
});

test('what a backend is decides its price and its rate cap', async () => {
  const items = [item('a', 'alpha'), item('b', 'beta')];
  const run = async (profile) => {
    const jev = stub(() => 0, profile);
    const res = await cc.crosscheck(jev, items, config());
    return { perMinute: jev.options.perMinute, estimate: res.plan.estimate };
  };
  const hosted = await run(OPENROUTER);
  assert.equal(hosted.perMinute, 1100);
  assert.ok(hosted.estimate.cost > 0);
  assert.equal(hosted.estimate.priced, true);
  // no listed price: estimated at Jev's, and marked as a guess
  const direct = await run({ ...OPENROUTER, id: 'typesafe', kind: 'typesafe', baseUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' });
  assert.equal(direct.perMinute, 1100);
  assert.equal(direct.estimate.cost, hosted.estimate.cost);
  assert.equal(direct.estimate.priced, false);
  const local = await run(LOCAL);
  assert.deepEqual([local.perMinute, local.estimate.cost, local.estimate.priced], [0, 0, true]);
  // a hand-written profile for a server on this machine, with no "kind"
  const custom = await run({ ...LOCAL, id: 'mine', kind: 'custom' });
  assert.deepEqual([custom.perMinute, custom.estimate.cost], [0, 0]);
});

test('the estimate sizes each request without building it', () => {
  const lens = relatedLens();
  const anchor = item('z', 'the anchor note, with some length to it');
  for (const size of [1, 2, 9, 16, 26]) {
    const group = Array.from({ length: size }, (_, i) => item(`g${i}`, `body ${i} `.repeat(30 + i)));
    const real = JSON.stringify(requestFor(group, { q: lens }, { anchor: view(anchor) })).length;
    assert.equal(cc.requestChars(anchor, group, lens), real, `pack ${size}`);
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
  assert.match(cc.unjudgedLine(res), /2 pairs were not judged because a request failed/);
  const notes = cc.githubAnnotations(res, os.tmpdir(), { cwd: os.tmpdir() });
  assert.equal(notes.filter((l) => /^::warning file=notes\/a\.md,line=1,.*not checked against 2 notes/.test(l)).length, 1);
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
  const jev = stub((anchor, it) => ((anchor.includes('dissent') ? 1 : 0) + (it.includes('dissent') ? 1 : 0) === 1 ? 0.95 : 0), LOCAL);
  const res = await cc.crosscheck(jev, items, config());
  assert.equal(res.contradictions.length, 3);
  assert.deepEqual(res.contested.map((c) => [c.item.id, c.pairs]), [['lone', 3]]);
  const md = cc.buildReport(res, { today: '2026-09-27', linkFrom: { root: os.tmpdir(), dir: path.join(os.tmpdir(), 'reports') } });
  assert.match(md, /^# Sieve crosscheck, 2026-09-27/);
  assert.match(md, /Answered by Local server: `kev-latest`/);
  assert.doesNotMatch(md, /Jev/);
  assert.match(md, /It compared 4 items in 6 pairs\./);
  assert.match(md, /12 judgments, 0 remembered from earlier runs and 12 to ask, in 12 requests/);
  assert.match(md, /## 1\. Contradictions \(3\)/);
  assert.match(md, /\| 95% \| 95% and 95% \| 2026-09-20 \[The dissent\]\(\.\.\/notes\/lone\.md\) \| 2026-03-01 \[Consensus three\]/);
  assert.match(md, /## 2\. Notes that disagree with several others \(1\)/);
  assert.match(md, /## 3\. Worth a second look \(0\)/);
  assert.match(md, /## 4\. The same point, twice \(0\)/);
  assert.doesNotMatch(md, /not judged/);

  // a narrowed run is written beside the full report, not over it
  const dir = tmpdir();
  const full = cc.writeReport({ ...res, reportsDir: dir }, config(), { today: '2026-09-27' });
  const narrow = cc.writeReport({ ...res, reportsDir: dir }, config(), { today: '2026-09-27', name: 'changed-insight,News-since-2026-06' });
  assert.equal(path.basename(full), 'crosscheck-2026-09-27.md');
  assert.equal(path.basename(narrow), 'crosscheck-2026-09-27-changed-insight-news-since-2026-06.md');
});

test('annotations: contradictions warn, --strict makes them errors, second looks are notices', async () => {
  const items = [
    item('old', 'claim', { date: '2026-01-01', title: 'Old claim' }),
    item('new', 'claim, reversed', { date: '2026-09-01', title: 'New claim', line: 12 }),
    item('mild', 'claim, qualified', { date: '2026-09-02', title: 'Mild claim' }),
  ];
  const jev = stub((anchor, it) => (anchor.includes('qualified') || it.includes('qualified') ? (anchor === 'claim' || it === 'claim' ? 0.4 : 0) : 0.9));
  const res = await cc.crosscheck(jev, items, config());
  const root = path.join(os.tmpdir(), 'repo');
  const lines = cc.githubAnnotations(res, root, { cwd: root });
  assert.deepEqual(lines, [
    '::warning file=notes/new.md,line=12,title=sieve%3A crosscheck::Contradicts "Old claim" (notes/old.md:1), 90%25: New claim',
    '::notice file=notes/mild.md,line=1,title=sieve%3A crosscheck::May contradict "Old claim" (notes/old.md:1), 40%25: Mild claim',
  ]);
  assert.match(cc.githubAnnotations(res, root, { cwd: root, strict: true })[0], /^::error file=notes\/new\.md/);
  // from a checkout above the notes folder, both paths are the ones GitHub shows
  assert.match(cc.githubAnnotations(res, path.join(root, 'kb'), { cwd: root })[0], /^::warning file=kb\/notes\/new\.md,.*\(kb\/notes\/old\.md:1\)/);
});

test('--changed: only the notes that are new or edited, and findings land on them', async () => {
  const repo = tmpdir();
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
  const kb = path.join(repo, 'kb');
  fs.mkdirSync(path.join(kb, 'notes'), { recursive: true });
  const section = (date, title, body) => `## ${date} - ${title}\n\n${body}\n\n`;
  const log = path.join(kb, 'notes', 'log file.md');
  fs.writeFileSync(log, `# Log\n\n${section('2026-09-01', 'Warnings were ignored', 'Nobody read the deprecation warnings until the build failed, in every team we asked.')}${section('2026-08-01', 'Docs are read by agents', 'Completion tools consult the official documentation before they suggest any code.')}`);
  fs.writeFileSync(path.join(kb, 'notes', 'other.md'), `# Other\n\n${section('2026-07-01', 'Grants fund launches', 'Most grants run six to twelve months against milestones and never pay for upkeep.')}`);
  git('add', '-A');
  git('commit', '-q', '-m', 'notes');

  // the pull request: one section added to the log, dated before the note it contradicts, and a new file
  fs.appendFileSync(log, section('2026-01-05', 'Warnings were enough', 'Deprecation warnings alone moved nearly every call site within six weeks of release.'));
  fs.writeFileSync(path.join(kb, 'notes', 'fresh.md'), `# Fresh\n\n${section('2026-09-20', 'Upkeep grants went unclaimed', 'A fund for maintenance work closed its round with half of the money never allocated.')}`);
  fs.writeFileSync(path.join(kb, 'scratch.txt'), 'not a note');

  const conf = { root: kb, dir: kb, gitDates: false, sources: [{ kind: 'note', glob: 'notes/*.md', split: { heading: 2, requireDate: true, stripDate: true }, dateFrom: ['title'] }] };
  const items = buildCorpus(conf);
  assert.equal(items.length, 5);
  const changed = cc.changedItems(conf, items, 'HEAD');
  assert.deepEqual(items.filter((it) => changed.only.has(it.id)).map((it) => it.title).sort(), ['Upkeep grants went unclaimed', 'Warnings were enough']);
  assert.deepEqual(changed.files.sort(), ['notes/fresh.md', 'notes/log file.md']); // the scratch file holds no note

  const jev = stub((anchor, it) => (/[Ww]arnings/.test(anchor) && /[Ww]arnings/.test(it) ? 0.9 : 0));
  const res = await cc.crosscheck(jev, items, conf, { changed: 'HEAD' });
  assert.equal(res.plan.pairs, 7); // 2 changed notes against 3 that were there, and against each other
  assert.equal(asked(jev), 14);
  assert.equal(res.contradictions.length, 1);
  const [found] = res.contradictions;
  assert.equal(found.a.title, 'Warnings were ignored'); // the newer note still leads the row
  assert.equal(found.subject.title, 'Warnings were enough'); // the finding is about the note the change added
  assert.deepEqual(cc.githubAnnotations(res, kb, { cwd: repo }), [
    `::warning file=kb/notes/log file.md,line=${found.subject.line},title=sieve%3A crosscheck::Contradicts "Warnings were ignored" (kb/notes/log file.md:${found.other.line}), 90%25: Warnings were enough`,
  ]);
  const md = cc.buildReport(res, { today: '2026-09-27', linkFrom: { root: kb, dir: path.join(kb, 'reports') } });
  assert.match(md, /keeping the pairs that touch a changed note \(2 files\)/);

  // nothing changed: nothing to compare, nothing asked
  git('add', '-A');
  git('commit', '-q', '-m', 'more');
  const quiet = stub(() => 0.9);
  const none = await cc.crosscheck(quiet, buildCorpus(conf), conf, { changed: 'HEAD' });
  assert.deepEqual([none.plan.pairs, quiet.calls.length, none.contradictions.length], [0, 0, 0]);
});

test('the shipped crosscheck example loads: the sample notebook plus sixteen field notes', () => {
  const notes = loadConfig(path.join(SIEVE, 'examples', 'research-notes', 'crosscheck.config.json'));
  const items = buildCorpus(notes);
  const by = {};
  for (const it of items) by[it.kind] = (by[it.kind] || 0) + 1;
  assert.deepEqual(by, { brief: 12, news: 12, insight: 20, 'field-note': 16 });
  assert.equal(cc.settingsFor(notes).budget, 0.25);
  assert.equal(cc.pairsOf(cc.groupsOf(items, 'all')).length, 1770);
});

test('the command line: a dry run needs no key and prints its plan; a flag cannot swallow the next one', () => {
  const dir = tmpdir();
  const run = (...args) => spawnSync(process.execPath, [path.join(SIEVE, 'sieve.cjs'), 'crosscheck', '--config', path.join(SIEVE, 'examples', 'research-notes', 'crosscheck.config.json'), '--no-cache', ...args], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, OPENROUTER_API_KEY: '', SIEVE_SETTINGS: path.join(dir, 'settings.json') },
  });
  const dry = run('--dry-run', '--json');
  assert.equal(dry.status, 0, dry.stderr);
  const out = JSON.parse(dry.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual([out.plan.items, out.plan.pairs, out.plan.judgments, out.plan.estimate.requests], [60, 1770, 3540, 240]);
  assert.ok(out.plan.estimate.cost > 0.03 && out.plan.estimate.cost < 0.08);

  for (const flag of ['--top', '--pack', '--since', '--budget']) {
    const bad = run(flag, '--dry-run');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, new RegExp(`${flag} needs a value`));
  }
  const last = run('--dry-run', '--budget');
  assert.equal(last.status, 1);
  assert.match(last.stderr, /--budget needs a value/);
  assert.match(run('--dry-run', '--top', '-3').stderr, /--top is a whole number/);
  assert.match(run('--dry-run', '--format', 'pdf').stderr, /--format is text, json, or github/);
});

test('the client: the per-minute cap counts every request sent, retries included', async () => {
  const ok = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 10, cost: 0 } }) });
  const busy = () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '{"error":{"message":"slow down"}}' });
  const Q = { a: noul('Is it?') };
  const worst = (sent) => Math.max(...sent.map((t) => sent.filter((u) => u >= t && u < t + 60000).length));

  for (const concurrency of [1, 3, 8]) {
    // A clock that moves only when every request is waiting on it, then jumps to the next wake.
    let now = 0;
    const timers = [];
    const sent = [];
    const attempts = new Map();
    const jev = createClient({
      apiKey: 'k', now: () => now,
      sleep: (ms) => new Promise((resolve) => timers.push({ wake: now + ms, resolve })),
      fetch: async (url, init) => {
        sent.push(now);
        const n = (attempts.get(init.body) || 0) + 1;
        attempts.set(init.body, n);
        return n === 1 ? busy() : ok(); // every request is refused once, then answered
      },
    });
    let results = null;
    jev.map(Array.from({ length: 12 }, (_, i) => i), (i) => ({ state: `note ${i}`, questions: Q }), { concurrency, cache: false, perMinute: 5 }).then((r) => { results = r; });
    while (!results) {
      await new Promise((resolve) => setImmediate(resolve)); // let everything that can run, run
      const next = timers.sort((a, b) => a.wake - b.wake).shift();
      if (next) { now = Math.max(now, next.wake); next.resolve(); }
    }
    assert.equal(results.every((r) => r.answers), true);
    assert.equal(sent.length, 24);
    assert.equal(worst(sent), 5, `concurrency ${concurrency}`);
  }
});

test('the client: map can skip the cache, an answer from the cache uses none of the cap, and a stop ends a wait', async () => {
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
  // with the cache, ten identical requests send one and wait for nothing
  waits.length = 0;
  startedAt.length = 0;
  now = 1e9;
  await jev.map(Array.from({ length: 10 }, (_, i) => i), () => ({ state: 'same', questions: Q }), { concurrency: 1, perMinute: 2 });
  assert.deepEqual([startedAt.length, waits.length], [1, 0]);
  assert.equal(jev.summary().cached, 9);

  // a stop while requests wait on the cap: they give up, and map returns without sending them
  const stopper = new AbortController();
  let sent = 0;
  const slow = createClient({
    apiKey: 'k', now: () => 0,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 5000)),
    fetch: async () => { sent++; return ok; },
  });
  const seen = [];
  const t0 = Date.now();
  const results = await slow.map(Array.from({ length: 12 }, (_, i) => i), (i) => ({ state: `note ${i}`, questions: Q }), {
    concurrency: 8, cache: false, perMinute: 4, signal: stopper.signal,
    onResult: (r, i) => { seen.push(i); if (seen.length === 4) stopper.abort(); },
  });
  assert.equal(sent, 4);
  assert.equal(seen.length, 4);
  assert.equal(results.filter(Boolean).length, 4); // the slots never asked stay empty
  assert.ok(Date.now() - t0 < 2000, 'the waiting requests did not sit out their sleep');
  assert.equal(slow.summary().requests, 4);

  // a stop while a refused request waits to retry: the retry is never sent
  const halt = new AbortController();
  let tries = 0;
  const refused = createClient({
    apiKey: 'k',
    sleep: async () => { halt.abort(); },
    fetch: async () => { tries++; return { ok: false, status: 429, headers: { get: () => null }, text: async () => '{"error":{"message":"slow down"}}' }; },
  });
  const answered = [];
  const left = await refused.map([1], () => ({ state: 'note', questions: Q }), { concurrency: 1, cache: false, signal: halt.signal, onResult: (r) => answered.push(r) });
  assert.deepEqual([tries, answered.length, left[0]], [1, 0, undefined]);
});
