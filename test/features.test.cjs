// Tests for related, compare, narrowing, lint, and backend-neutral wording. No network: Jev is a
// stub client or a local fake server.
// Run: node --test "test/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const { requestFor, siftMany, view } = require('../lib/sift.cjs');
const { preset, relatedPreset, comparePreset, RELATIONS } = require('../lib/lenses.cjs');
const { lint, rulesFor, changedFiles, githubAnnotations } = require('../lib/lint.cjs');
const { buildReport } = require('../lib/route.cjs');
const { thresholdsFor } = require('../lib/evaluate.cjs');

const item = (id, text, extra = {}) => ({ id, kind: 'note', title: `t${id}`, date: '2026-09-01', path: `notes/${id}.md`, line: 1, text, ...extra });

// A stand-in for createClient(): `answer(stateItem, question, fullState)` decides each answer.
function stubClient(answer) {
  const calls = [];
  return {
    calls,
    model: 'stub',
    summary: () => ({ requests: calls.length, cached: 0, cost_usd: 0 }),
    async map(items, toRequest, { onResult } = {}) {
      const out = [];
      for (let i = 0; i < items.length; i++) {
        const { state, questions } = toRequest(items[i], i);
        calls.push({ state, questions });
        const answers = {};
        for (const [id, q] of Object.entries(questions)) {
          const slot = id.includes('.') ? id.split('.')[0] : null;
          const it = slot ? state.items[slot] : state.item || state;
          answers[id] = answer(it, q, state);
        }
        out[i] = it0(answers);
        if (onResult) onResult(out[i], i, items[i]);
      }
      return out;
    },
  };
}
const it0 = (answers) => (Object.values(answers).some((a) => a === 'boom') ? { error: 'boom' } : { answers });
const choiceOf = (probs) => {
  const [choice, confidence] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice, confidence, probabilities: probs };
};

test('requestFor with a shared context: the anchor rides along, packed or alone', () => {
  const lens = { build: (it) => ({ type: 'noul', instructions: `Is ${it} like \`anchor\`?` }) };
  const context = { anchor: view(item('z', 'the anchor text')) };
  const one = requestFor([item('a', 'alone')], { q: lens }, context);
  assert.equal(one.state.anchor.text, 'the anchor text');
  assert.equal(one.state.item.text, 'alone');
  assert.equal(one.questions.q.instructions, 'Is `item` like `anchor`?');
  const packed = requestFor([item('a', 'x'), item('b', 'y')], { q: lens }, context);
  assert.deepEqual(Object.keys(packed.state).sort(), ['anchor', 'items']);
  assert.equal(packed.questions['b.q'].instructions, 'Is `items.b` like `anchor`?');
  // without a context, nothing changes
  assert.equal(requestFor([item('a', 'alone')], { q: lens }).state.text, 'alone');
});

test('related: a stance choice against the anchor, ranked by how closely items connect', async () => {
  const anchor = item('z', 'grants fund launches, not upkeep');
  const p = relatedPreset(anchor);
  assert.equal(p.exclude, 'z');
  assert.equal(p.context.anchor.text, anchor.text);
  assert.equal(p.context.anchor.path, undefined); // paths never reach the model
  const q = p.lenses.q.build('`items.a`');
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria), Object.keys(RELATIONS));
  assert.match(q.instructions, /`items\.a`.*`anchor`/);

  const probs = { same: 0, supports: 0, contradicts: 0, topic: 0, unrelated: 0 };
  const a = (x) => ({ q: choiceOf({ ...probs, ...x }) });
  assert.equal(p.value(a({ contradicts: 0.9, unrelated: 0.1 })), 0.9);
  assert.equal(p.value(a({ topic: 1 })), 0.5); // a shared topic counts half
  assert.equal(p.group(a({ supports: 0.7, unrelated: 0.3 })), 'supports');
  assert.equal(p.label(a({ same: 0.94, unrelated: 0.06 })), 'same');
  // "unrelated" by a hair, but half related in total: filed under its likeliest real relation
  assert.equal(p.group(a({ unrelated: 0.4, supports: 0.3, contradicts: 0.3 })), 'supports');
  assert.equal(p.group(a({ unrelated: 0.8, topic: 0.2 })), 'unrelated');

  const jev = stubClient((it, question, state) => choiceOf({ ...probs, [it.text === state.anchor.text ? 'same' : it.text.includes('grants') ? 'supports' : 'unrelated']: 1 }));
  const items = [item('a', 'more grants for launches'), item('b', 'a microcontroller')];
  const res = await siftMany(jev, items, p.lenses, { pack: 16, context: p.context });
  assert.deepEqual(res.map((r) => p.group(r.answers)), ['supports', 'unrelated']);
  assert.ok(jev.calls.every((c) => c.state.anchor.text === anchor.text));
});

test('compare: two wordings in the same request, grouped by where they agree', async () => {
  const p = preset({ lenses: {} }, 'ask', { phrase: 'security risks', vs: 'attacks on AI' });
  assert.equal(p.title, '"security risks" vs "attacks on AI"');
  assert.deepEqual(Object.keys(p.lenses), ['a', 'b']);
  const n = (x) => ({ type: 'noul', noul: x });
  assert.equal(p.group({ a: n(0.9), b: n(0.8) }), 'both');
  assert.equal(p.group({ a: n(0.9), b: n(0.2) }), 'only A');
  assert.equal(p.group({ a: n(0.1), b: n(0.6) }), 'only B');
  assert.equal(p.group({ a: n(0.1), b: n(0.2) }), 'neither');
  assert.equal(p.value({ a: n(0.1), b: n(0.6) }), 0.6);
  assert.equal(p.label({ a: n(0.97), b: n(0.47) }), 'A 97% · B 47%');
  // both wordings share one request per pack: the state is read once
  const jev = stubClient(() => n(0.5));
  await siftMany(jev, [item('a', 'x'), item('b', 'y')], p.lenses, { pack: 16 });
  assert.equal(jev.calls.length, 1);
  assert.deepEqual(Object.keys(jev.calls[0].questions).sort(), ['a.a', 'a.b', 'b.a', 'b.b']);
  // an empty second wording is a plain ask
  assert.deepEqual(Object.keys(preset({ lenses: {} }, 'ask', { phrase: 'x', vs: ' ' }).lenses), ['q']);
  assert.deepEqual(comparePreset('x', 'y').lenses.b.label, 'y');
});

const LINT_CONFIG = (extra = {}) => ({
  root: os.tmpdir(),
  lenses: {
    unsourced: { type: 'noul', label: 'Figure without a source', question: 'Does {item} give a figure without a source?' },
    secret: { type: 'noul', label: 'Private contact detail', question: 'Does {item} contain a private phone number?' },
    theme: { type: 'choice', question: 'Which theme is {item}?', options: { a: 'A', b: 'B' } },
  },
  lint: { rules: [{ id: 'unsourced-figure', lens: 'unsourced', kinds: ['insight'], fail: 0.9, warn: 0.6 }, { lens: 'secret' }] },
  ...extra,
});

test('lint rules: validated up front, yes/no lenses only, fail above warn', () => {
  const rules = rulesFor(LINT_CONFIG());
  assert.deepEqual(rules.map((r) => [r.id, r.fail, r.warn]), [['unsourced-figure', 0.9, 0.6], ['secret', 0.9, 0.6]]);
  assert.throws(() => rulesFor({ lenses: {} }), /no "lint" rules/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ id: 'x', lens: 'nope' }] } })), /no lens "nope"/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ lens: 'theme' }] } })), /must be a yes\/no/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ lens: 'secret', fail: 0.5, warn: 0.7 }] } })), /"fail" must be above "warn"/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ lens: 'secret' }, { id: 'secret', lens: 'unsourced' }] } })), /appears twice/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ lens: 'secret', kinds: 'brief' }] } })), /"kinds" must be a list/);
  assert.throws(() => rulesFor(LINT_CONFIG({ lint: { rules: [{ lens: 'secret', fail: 90, warn: 60 }] } })), /between 0 and 1/);
});

test('a missing answer ranks as -1, never NaN (which would break sorting, narrowing, and CSV)', () => {
  const { rankOf, preset: presetOf } = require('../lib/lenses.cjs');
  const cmp = presetOf({ lenses: {} }, 'ask', { phrase: 'a', vs: 'b' });
  assert.equal(rankOf(cmp, { a: { type: 'noul', noul: 0.7 } }), -1); // b left unanswered
  assert.equal(rankOf(cmp, null), -1);
  assert.equal(rankOf(cmp, { a: { type: 'noul', noul: 0.7 }, b: { type: 'noul', noul: 0.2 } }), 0.7);
  const rel = relatedPreset(item('z', 'anchor'));
  assert.equal(rel.group({}), null);
  assert.equal(rel.label({}), 'error');
});

test('lint: every rule an item needs in one request, sorted into fail, warn, and pass', async () => {
  const p = (text, rule) => {
    const m = text.match(new RegExp(`${rule}=([0-9.]+)`));
    return m ? Number(m[1]) : 0.05;
  };
  const jev = stubClient((it, q) => (it.text === 'explode' ? 'boom' : { type: 'noul', noul: p(it.text, q.instructions.includes('figure') ? 'fig' : 'sec') }));
  const corpus = [
    item('a', 'fig=0.95', { kind: 'insight' }),
    item('b', 'fig=0.7 sec=0.92', { kind: 'insight' }),
    item('c', 'fig=0.99', { kind: 'brief' }), // unsourced-figure does not cover briefs
    item('d', 'clean', { kind: 'brief' }),
    item('e', 'explode', { kind: 'insight' }),
  ];
  // one item per request, so the item whose request fails does not take its neighbors with it
  const res = await lint(jev, corpus, LINT_CONFIG(), { pack: 1 });
  assert.deepEqual(res.findings.map((f) => [f.level, f.rule, f.item.id]), [
    ['fail', 'unsourced-figure', 'a'], ['fail', 'secret', 'b'], ['warn', 'unsourced-figure', 'b'],
  ]);
  assert.deepEqual(res.counts, { fail: 2, warn: 1, errors: 1 });
  assert.equal(res.errors[0].item.id, 'e');
  assert.equal(res.checked, 5);
  // insights get both rules in one request; briefs get only the rule that covers them
  const asked = (id) => Object.values(jev.calls.find((c) => c.state.text === corpus.find((x) => x.id === id).text).questions).map((q) => (/phone/.test(q.instructions) ? 'secret' : 'figure'));
  assert.deepEqual(asked('a'), ['figure', 'secret']);
  assert.deepEqual(asked('c'), ['secret']);
  assert.equal(jev.calls.length, 5);
  // packed, every item's questions share one request per rule set
  const packed = stubClient(() => ({ type: 'noul', noul: 0.1 }));
  await lint(packed, corpus.filter((x) => x.id !== 'e'), LINT_CONFIG(), { pack: 16 });
  assert.deepEqual(packed.calls.map((c) => Object.keys(c.questions).length).sort(), [2, 4]); // 2 insights x 2 rules, 2 briefs x 1 rule

  const lines = githubAnnotations(res, '/repo/notes', '/repo');
  assert.equal(lines[0], '::error file=notes/notes/a.md,line=1,title=sieve%3A unsourced-figure::Figure without a source (95%25): ta');
  // in Actions, paths are relative to the checkout even when the step runs in a subfolder
  const was = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = path.resolve('/repo');
  try { assert.match(githubAnnotations(res, path.resolve('/repo/notes'))[0], /file=notes\/notes\/a\.md,/); }
  finally { if (was === undefined) delete process.env.GITHUB_WORKSPACE; else process.env.GITHUB_WORKSPACE = was; }
  assert.match(lines[2], /^::warning file=notes\/notes\/b\.md,line=1,/);
  assert.match(lines[3], /^::warning .*not checked: boom/);
});

test('lint --changed: only files that differ from a git ref, plus untracked files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-git-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  fs.mkdirSync(path.join(root, 'notes'));
  fs.writeFileSync(path.join(root, 'notes/old.md'), 'old');
  fs.writeFileSync(path.join(root, 'notes/edited.md'), 'v1');
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  fs.writeFileSync(path.join(root, 'notes/edited.md'), 'v2');
  fs.writeFileSync(path.join(root, 'notes/new.md'), 'new');
  fs.writeFileSync(path.join(root, 'notes/café notes.md'), 'accented and spaced'); // git would quote this without -z
  assert.deepEqual([...changedFiles(root, 'HEAD')].sort(), ['notes/café notes.md', 'notes/edited.md', 'notes/new.md']);
  assert.deepEqual([...changedFiles(path.join(root, 'notes'), 'HEAD')].sort(), ['café notes.md', 'edited.md', 'new.md']); // relative to the corpus root
  assert.throws(() => changedFiles(root, 'no-such-ref'), /git could not compare/);
  // a ref that is also a folder name is still read as a ref
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'branch', 'notes');
  assert.ok(changedFiles(root, 'notes').has('notes/edited.md'));
});

test('the routing report names the backend it used, never assumes Jev', () => {
  const results = [{ item: item('a', 'x'), answers: { lane: choiceOf({ one: 0.9, none: 0.1 }) } }];
  const { markdown } = buildReport({
    results, route: { lenses: { lane: 'lane' }, category: 'lane', orphans: {} }, linked: { all: '', hooks: '' },
    stats: { model: 'kev-latest', served: 'jaredpalmer/kev-4b', label: 'Local server', requests: 1, cached: 0, cost: 0, ms: 5000 },
    today: '2026-09-26', linkFrom: { root: '/c', dir: '/c/reports' }, lensLabels: { lane: 'Lane' },
  });
  assert.match(markdown, /^Answered by Local server: `kev-latest`, serving jaredpalmer\/kev-4b\.\nIt read 1 item /m);
  assert.match(markdown, /\| Item \| Kind \| Date \| Answer \| Runner-up \|/);
  assert.doesNotMatch(markdown, /Jev/);
});

test('eval thresholds explain a short eval instead of calling the model hopeless', () => {
  // 20 answers: the top 15 are 14/15 right (93%), all 20 only 15/20 (75%)
  const rows = Array.from({ length: 20 }, (_, i) => ({ ok: i < 15 ? i !== 7 : i === 19, answer: { confidence: 0.9 - i * 0.02 } }));
  const [t90] = thresholdsFor(rows, (r) => r.ok);
  assert.equal(t90.confidence, null);
  assert.equal(t90.small.n, 15);
  assert.ok(Math.abs(t90.small.accuracy - 14 / 15) < 1e-9);
  const [few] = thresholdsFor(rows.slice(0, 5).map((r) => ({ ...r, ok: false })), (r) => r.ok);
  assert.deepEqual([few.confidence, few.small, few.n], [null, null, 5]);
});

test('server: related, compare, and narrowing a finished sift', async () => {
  const { serve } = require('../lib/server.cjs');
  const LENSES = { yes: { type: 'noul', label: 'Yes?', question: 'Is {item} good?' } };
  const config = { name: 'Test', root: os.tmpdir(), sources: [{ kind: 'note', glob: '*.none' }], lenses: LENSES, presets: [{ id: 'ask' }] };
  const corpus = [item('a', 'hot'), item('b', 'warm'), item('c', 'cold')];
  const seen = [];
  const heat = { hot: 0.9, warm: 0.6, cold: 0.1 };
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); return res.end('{"models":[]}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { state, questions } = JSON.parse(body);
      seen.push({ state, questions });
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        const it = id.includes('.') ? state.items[id.split('.')[0]] : state.item || state;
        answers[id] = q.type === 'choice'
          ? { type: 'choice', choice: 'supports', confidence: 0.8, probabilities: { same: 0, supports: 0.8, contradicts: 0, topic: 0, unrelated: 0.2 } }
          : { type: 'noul', noul: heat[it.text] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake', answers }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-srv2-')), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ active: 'fake', backends: [{ id: 'fake', label: 'Fake', kind: 'local', baseUrl: `http://127.0.0.1:${fake.address().port}/v1/systemone`, model: 'fake', pack: 16, concurrency: 1, timeoutMs: 5000 }] }));
  const server = serve({ config, corpus, port: 0, cacheFile: null, settingsFile });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = (text) => Object.fromEntries(text.split('\n\n').filter(Boolean).map((b) => [b.match(/^event: (\w+)/)[1], JSON.parse(b.match(/\ndata: (.*)$/)[1])]));
  try {
    // related: the anchor is excluded, rides in the state, and a missing anchor is a clear 400
    const rel = events(await (await fetch(`${base}/api/sift?preset=related&anchor=a`)).text());
    assert.equal(rel.start.total, 2);
    assert.equal(rel.start.grouped, true);
    assert.equal(seen.at(-1).state.anchor.text, 'hot');
    const missing = await fetch(`${base}/api/sift?preset=related&anchor=gone&check=1`);
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /no longer in the corpus/);

    // compare: grouped, one request for both wordings
    const cmp = events(await (await fetch(`${base}/api/sift?preset=ask&q=hot&vs=warm`)).text());
    assert.equal(cmp.start.grouped, true);
    assert.equal(cmp.done.requests, 1);

    // narrowing: ask a new question of only the items that cleared a bar in a finished sift
    const first = events(await (await fetch(`${base}/api/sift?preset=ask&q=heat`)).text());
    const pre = await (await fetch(`${base}/api/sift?preset=ask&q=again&within=${first.done.sid}&min=0.5&check=1`)).json();
    assert.equal(pre.items, 2); // hot and warm
    const second = events(await (await fetch(`${base}/api/sift?preset=ask&q=again&within=${first.done.sid}&min=0.8`)).text());
    assert.equal(second.start.total, 1);
    assert.deepEqual(Object.keys(seen.at(-1).state), ['kind', 'title', 'date', 'text']); // one item: the state is the item
    assert.equal(seen.at(-1).state.text, 'hot');
    const expired = await fetch(`${base}/api/sift?preset=ask&q=x&within=s999&check=1`);
    assert.equal(expired.status, 400);
    assert.match((await expired.json()).error, /expired/);
    const none = await (await fetch(`${base}/api/sift?preset=ask&q=again&within=${first.done.sid}&min=0.99&check=1`)).json();
    assert.equal(none.items, 0); // the page refuses a zero-item sift before opening the paid stream
  } finally {
    server.close();
    fake.close();
  }
});

test('presets explain themselves: what they ask, what they pick from, what the number means', () => {
  const { presetList, preset: presetOf } = require('../lib/lenses.cjs');
  const config = { lenses: { ...LINT_CONFIG().lenses, scale: { type: 'score', question: 'How big is {item}?', levels: ['Small.', 'Huge.'] } }, presets: [{ id: 'ask' }, { id: 'theme', lens: 'theme', group: true }, { id: 'size', lens: 'scale' }, { id: 'fig', lens: 'unsourced' }] };
  const [, theme, size, fig] = presetList(config);
  assert.deepEqual(theme.asks, ['Which theme is this item?']);
  assert.deepEqual(theme.choices, ['a', 'b']);
  assert.deepEqual(size.levels, ['Small', 'Huge']);
  assert.equal(fig.choices, undefined);
  assert.match(presetOf(config, 'size').meaning, /0% is "Small", 100% is "Huge"/);
  assert.match(presetOf(config, 'fig').meaning, /chance the answer to the question is yes/);
  assert.match(presetOf(config, 'ask', { phrase: 'dogs' }).meaning, /substantially about "dogs"/);
  assert.match(presetOf(config, 'ask', { phrase: 'dogs', vs: 'cats' }).meaning, /higher of the two/);
  assert.match(relatedPreset(item('z', 'x')).meaning, /counts half/);
});

test('backends say what a sift costs and what setup is missing, in words a person can act on', () => {
  const b = require('../lib/backends.cjs');
  assert.equal(b.pricePerMTok({ kind: 'openrouter', model: 'typesafe/jev-1.13' }), 0.042);
  assert.equal(b.pricePerMTok({ kind: 'local', model: 'kev-latest' }), 0);
  assert.equal(b.pricePerMTok({ kind: 'typesafe', model: 'jev-latest' }), null); // unpriced here
  const was = process.env.SIEVE_TEST_KEY;
  delete process.env.SIEVE_TEST_KEY;
  try {
    const msg = b.keyProblem({ label: 'Jev via OpenRouter', kind: 'openrouter', keyEnv: 'SIEVE_TEST_KEY' });
    assert.match(msg, /needs an API key/);
    assert.match(msg, /SIEVE_TEST_KEY=\.\.\./);
    assert.match(msg, /openrouter\.ai\/keys/);
    assert.equal(b.keyProblem({ label: 'Local', kind: 'local', keyEnv: '' }), null);
    process.env.SIEVE_TEST_KEY = 'x';
    assert.equal(b.keyProblem({ label: 'Jev via OpenRouter', kind: 'openrouter', keyEnv: 'SIEVE_TEST_KEY' }), null);
  } finally { if (was === undefined) delete process.env.SIEVE_TEST_KEY; else process.env.SIEVE_TEST_KEY = was; }
});

test('server: a missing key is caught before anything runs; estimates, meanings, and failures are reported', async () => {
  const { serve } = require('../lib/server.cjs');
  const config = { name: 'Test', root: os.tmpdir(), sources: [{ kind: 'note', glob: '*.none' }], lenses: {}, presets: [{ id: 'ask' }] };
  const corpus = [item('a', 'fine'), item('b', 'explode'), item('c', 'fine too')];
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); return res.end('{"models":[]}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { state, questions } = JSON.parse(body);
      if (JSON.stringify(state).includes('explode')) { res.writeHead(400); return res.end('{"error":{"message":"state too odd"}}'); }
      const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.8 }]));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake', answers }));
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-srv4-'));
  const url = `http://127.0.0.1:${fake.address().port}/v1/systemone`;
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ active: 'keyed', backends: [
    { id: 'keyed', label: 'Keyed', kind: 'local', baseUrl: url, model: 'fake', keyEnv: 'SIEVE_TEST_MISSING_KEY', pack: 1, concurrency: 1, timeoutMs: 5000 },
    { id: 'open', label: 'Open', kind: 'local', baseUrl: url, model: 'fake', keyEnv: '', pack: 1, concurrency: 1, timeoutMs: 5000 },
  ] }));
  delete process.env.SIEVE_TEST_MISSING_KEY;
  const server = serve({ config, corpus, port: 0, cacheFile: null, settingsFile });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { 'X-Sieve': '1', 'Content-Type': 'application/json' };
  const events = (text) => Object.fromEntries(text.split('\n\n').filter(Boolean).map((blk) => [blk.match(/^event: (\w+)/)[1], JSON.parse(blk.match(/\ndata: (.*)$/)[1])]));
  try {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.setup.keyEnv, 'SIEVE_TEST_MISSING_KEY');
    const pre = await fetch(`${base}/api/sift?preset=ask&q=x&check=1`);
    assert.equal(pre.status, 400);
    assert.equal((await pre.json()).setup, true);
    assert.equal((await fetch(`${base}/api/sift?preset=ask&q=x`)).status, 400); // the stream itself refuses too

    const st = await (await fetch(`${base}/api/settings`, { headers: H })).json();
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ active: 'open', backends: st.backends.map(({ keySet, builtin, ...p }) => p) }) });
    assert.equal((await (await fetch(`${base}/api/meta`)).json()).setup, null);
    const ok = await (await fetch(`${base}/api/sift?preset=ask&q=x&check=1`)).json();
    assert.equal(ok.items, 3);
    assert.deepEqual(ok.estimate, { requests: 3, cost: 0, seconds: null }); // local: free, not timed yet
    assert.match(ok.meaning, /substantially about "x"/);
    const run = events(await (await fetch(`${base}/api/sift?preset=ask&q=x`)).text());
    assert.match(run.start.meaning, /substantially about "x"/);
    assert.equal(run.done.errors, 1);
    assert.match(run.done.reason, /state too odd/);
    const timed = await (await fetch(`${base}/api/sift?preset=ask&q=x&check=1`)).json();
    assert.ok(timed.estimate.seconds > 0); // measured on the run above
  } finally {
    server.close();
    fake.close();
  }
});

test('server: closing the page stops the sift, and a stopped sift cannot be narrowed', async () => {
  const { serve } = require('../lib/server.cjs');
  const config = { name: 'Test', root: os.tmpdir(), sources: [{ kind: 'note', glob: '*.none' }], lenses: {}, presets: [{ id: 'ask' }] };
  const corpus = Array.from({ length: 12 }, (_, i) => item(`n${i}`, `note ${i}`));
  let asked = 0;
  const fake = http.createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(200); return res.end('{"models":[]}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      asked++;
      const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions).map((k) => [k, { type: 'noul', noul: 0.9 }]));
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'fake', answers })); }, 60);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  const settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-srv3-')), 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ active: 'fake', backends: [{ id: 'fake', label: 'Fake', kind: 'local', baseUrl: `http://127.0.0.1:${fake.address().port}/v1/systemone`, model: 'fake', pack: 1, concurrency: 1, timeoutMs: 5000 }] }));
  const server = serve({ config, corpus, port: 0, cacheFile: null, settingsFile });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/sift?preset=ask&q=x`, { signal: ctl.signal });
    const reader = res.body.getReader();
    let text = '';
    while (!/event: batch/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
    const sid = text.match(/"sid":"(s\d+)"/)[1];
    ctl.abort();
    await new Promise((r) => setTimeout(r, 400)); // long enough for all 12 if nothing stopped them
    assert.ok(asked < 6, `expected the sift to stop early, but ${asked} of 12 requests went out`);
    const after = asked;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(asked, after);
    const narrowed = await fetch(`${base}/api/sift?preset=ask&q=y&within=${sid}&check=1`);
    assert.equal(narrowed.status, 400); // a partial result set is never offered for narrowing
    // and the server is free for the next sift
    assert.equal((await fetch(`${base}/api/sift?preset=ask&q=x&check=1`)).status, 200);
  } finally {
    server.close();
    fake.close();
  }
});
