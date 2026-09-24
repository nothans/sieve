// Unit tests for Sieve. No network: Jev is replaced by a stub client or a local fake server.
// Run: node --test "test/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { glob, matches } = require('../lib/glob.cjs');
const { sections, clip, findDate, frontMatter, buildCorpus } = require('../lib/corpus.cjs');
const { loadConfig, kindLabels } = require('../lib/config.cjs');
const { requestFor, siftMany, sift, SLOTS } = require('../lib/sift.cjs');
const { buildLens, buildLenses, preset, presetList, askLens } = require('../lib/lenses.cjs');
const { filterItems } = require('../lib/filter.cjs');
const { isLinked, buildReport } = require('../lib/route.cjs');
const { stripLabels, score, labeledSet } = require('../lib/evaluate.cjs');

const EXAMPLES = path.join(__dirname, '..', 'examples');

// A stand-in for createClient(): answers every question with a noul derived from the state,
// so ranking and packing can be checked without a model.
function stubClient() {
  const calls = [];
  const answerFor = (state) => ({ type: 'noul', noul: Math.min(1, (JSON.stringify(state).match(/match/g) || []).length / 2) });
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
        for (const id of Object.keys(questions)) {
          const slot = id.includes('.') ? id.split('.')[0] : null;
          answers[id] = answerFor(slot ? state.items[slot] : state);
        }
        out[i] = { answers };
        if (onResult) onResult(out[i], i, items[i]);
      }
      return out;
    },
  };
}

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-'));
  for (const [p, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  }
  return root;
}

const item = (id, text, extra = {}) => ({ id, kind: 'note', title: `t${id}`, date: '2026-09-01', path: `notes/${id}.md`, line: 1, text, ...extra });
const LENSES = {
  topic: { type: 'choice', label: 'Topic', question: 'Which topic is {item} about?', options: { a: 'Apples.', b: 'Boats.', none: 'Neither.' } },
  yes: { type: 'noul', label: 'Yes?', question: 'Is {item} good?', true: 'Good.', false: 'Bad.' },
  scale: { type: 'score', label: 'Scale', question: 'How big is {item}?', levels: ['Small.', 'Big.'] },
};

test('glob walks only what the pattern reaches, in directory order, and matches excludes', () => {
  const root = tmpRepo({ 'a/x.md': '', 'a/y.txt': '', 'a/b/z.md': '', 'c/README.md': '', 'node_modules/q.md': '' });
  assert.deepEqual(glob(root, 'a/*.md'), ['a/x.md']);
  assert.deepEqual(glob(root, '**/*.md'), ['a/x.md', 'a/b/z.md', 'c/README.md']);
  assert.deepEqual(glob(root, 'c/README.md'), ['c/README.md']);
  assert.deepEqual(glob(root, 'missing/*.md'), []);
  assert.ok(matches('a/b/z.md', 'a/**'));
  assert.ok(matches('deep/README.md', 'README.md')); // no slash: basename
  assert.ok(matches('x/_queue.md', '_*'));
  assert.ok(!matches('a/x.md', 'b/**'));
});

test('sections splits at a heading level, keeps line numbers, ignores fenced code', () => {
  const md = '# Top\nintro\n## A\nbody a\n```\n## not a heading\n```\n## B\nbody b\n# Next top\nx';
  const s = sections(md, 2);
  assert.deepEqual(s.map((x) => [x.title, x.line]), [['A', 3], ['B', 8]]);
  assert.match(s[0].body, /not a heading/);
  assert.equal(s[1].body, 'body b');
});

test('clip, findDate, and frontMatter', () => {
  const c = clip('One sentence here. '.repeat(300), 500);
  assert.ok(c.length <= 510 && c.endsWith(' ...'));
  assert.equal(findDate(null, 'file 2026-09-22 thing'), '2026-09-22');
  assert.equal(findDate('2026-06 gstack'), '2026-06-01');
  assert.equal(findDate('nothing'), null);
  const { fields, body } = frontMatter('---\ntitle: "Hello: World"\ndate: 2026-07-22\n---\nBody');
  assert.deepEqual([fields.title, fields.date, body], ['Hello: World', '2026-07-22', 'Body']);
});

test('buildCorpus reads every source mode from a config', () => {
  const root = tmpRepo({
    'briefs/2026-09_x.md': '# X: "a quote"\n\n**Date:** 2026-09-20\n\n## TL;DR\n\n- the gist of the brief, long enough to count\n\n## Detail\n\nnot in the gist\n\n## Implications\n\n- more words here',
    'briefs/_queue.md': '# queue, excluded, with enough text to otherwise count as an item',
    'news/2026-09/digest.md': '# News\n\n### Story one\n\nSomething happened that is long enough to be an item.\n\n### Empty\n\n### Story two\n\nAnother thing happened, also long enough to keep.',
    'log/verification.md': '# Log\n\n## 2026-09-23 - A sharp entry\n\nWhy it matters, in more than forty characters of text.\n\n## Undated heading\n\nskipped because it has no date in its title at all.',
    'trends/local.md': '# Trend\n\n## Signals\n\n- **2026-09-21 - Clones run on a GPU.** More detail about the signal here.\n\n## Counter-signals\n\n- **2026-09-20 - Calibration is unproven.** Detail about the counter-signal.',
    'posts/my-post/my-post.md': '---\ntitle: "My Post"\ndate: 2026-09-01\n---\nA post body that is long enough to be included as an item.',
    'posts/my-post/research-my-post.md': '# Not the post, a research file with enough words in it',
    'talks/t1/README.md': '# Talk one\n\nA talk readme with enough words to count as an item.',
    'talks/t1/talk.md': '# Talk one, full\n\nThe long version, skipped because README comes first.',
  });
  const config = {
    root,
    gitDates: false,
    sources: [
      { kind: 'brief', glob: 'briefs/*.md', exclude: ['_*'], dateFrom: ['field', 'filename'] },
      { kind: 'news', glob: 'news/*/*.md', split: { heading: 3, requireBody: true }, dateFrom: ['folder'] },
      { kind: 'entry', glob: 'log/*.md', split: { heading: 2, requireDate: true, stripDate: true }, dateFrom: ['title'], label: 'filename' },
      { kind: 'signal', counterKind: 'counter', glob: 'trends/*.md', split: 'dated-bullets', label: 'filename' },
      { kind: 'post', glob: 'posts/*/*.md', sameNameAsFolder: true, text: 'body', dateFrom: ['frontmatter'] },
      { kind: 'talk', glob: 'talks/*/*.md', firstOf: ['abstract.md', 'README.md', 'talk.md'], text: 'full' },
    ],
  };
  const c = buildCorpus(config);
  assert.deepEqual(c.map((i) => i.kind), ['brief', 'news', 'news', 'entry', 'signal', 'counter', 'post', 'talk']);
  const brief = c[0];
  assert.equal(brief.date, '2026-09-20');
  assert.match(brief.text, /TL;DR/);
  assert.doesNotMatch(brief.text, /not in the gist/);
  assert.equal(c[1].date, '2026-09-01');
  assert.equal(c[3].title, 'A sharp entry');
  assert.equal(c[3].label, 'verification');
  assert.equal(c[5].title, 'Calibration is unproven');
  assert.equal(c[6].title, 'My Post');
  assert.equal(c[7].path, 'talks/t1/README.md');
  assert.ok(c.every((i, n) => i.id === `i${n}` && i.ref === `${i.path}:${i.line}`));
});

test('loadConfig resolves paths against the config file and checks references', () => {
  const dir = tmpRepo({
    'cfg/sieve.config.json': JSON.stringify({ root: '../corpus', sources: [{ kind: 'n', glob: '*.md' }], lenses: LENSES, presets: [{ id: 'yes', lens: 'yes' }], route: { lenses: { topic: 'topic' } } }),
    'bad/sieve.config.json': JSON.stringify({ sources: [{ kind: 'n', glob: '*.md' }], presets: [{ id: 'p', lens: 'nope' }] }),
    'empty/sieve.config.json': JSON.stringify({ sources: [] }),
  });
  const c = loadConfig(path.join(dir, 'cfg', 'sieve.config.json'));
  assert.equal(c.root, path.join(dir, 'corpus'));
  assert.equal(c.route.reportsDir, path.join(dir, 'cfg', 'reports'));
  assert.throws(() => loadConfig(path.join(dir, 'bad', 'sieve.config.json')), /unknown lens "nope"/);
  assert.throws(() => loadConfig(path.join(dir, 'empty', 'sieve.config.json')), /at least one source/);
  assert.throws(() => loadConfig(path.join(dir, 'missing.json')), /cannot read config/);
});

test('the shipped examples load and index offline', () => {
  const aesop = loadConfig(path.join(EXAMPLES, 'aesop', 'sieve.config.json'));
  const fables = buildCorpus(aesop);
  assert.equal(fables.length, 313);
  assert.equal(fables[0].title, 'The Lion And The Mouse');
  assert.deepEqual(presetList(aesop).map((p) => p.id), ['ask', 'moral', 'harsh', 'bedtime']);

  const notes = loadConfig(path.join(EXAMPLES, 'research-notes', 'sieve.config.json'));
  const items = buildCorpus(notes);
  const by = {};
  for (const it of items) by[it.kind] = (by[it.kind] || 0) + 1;
  assert.deepEqual(by, { brief: 12, news: 12, insight: 20 });
  assert.deepEqual(kindLabels(notes), { brief: 'briefs', news: 'news', insight: 'insights' });
  assert.equal(labeledSet(items, buildLenses(notes.lenses).theme, { kinds: ['insight'] }).length, 20);
});

test('buildLens builds each type and rejects bad specs', () => {
  const l = buildLenses(LENSES);
  assert.deepEqual(l.topic.build('this item'), { type: 'choice', instructions: 'Which topic is this item about?', criteria: LENSES.topic.options });
  assert.deepEqual(l.topic.options, ['a', 'b', 'none']);
  assert.deepEqual(l.yes.build('`items.a`'), { type: 'noul', instructions: 'Is `items.a` good?', criteria: { true: 'Good.', false: 'Bad.' } });
  assert.deepEqual(l.scale.build('x').criteria, ['Small.', 'Big.']);
  assert.throws(() => buildLens('q', { type: 'noul', question: 'no placeholder' }), /must include \{item\}/);
  assert.throws(() => buildLens('q', { type: 'choice', question: '{item}?' }), /needs options/);
  assert.throws(() => buildLens('q', { type: 'poll', question: '{item}?' }), /type must be/);
});

test('presets: ask, single-lens, thesis override, and composite', () => {
  const config = {
    lenses: { ...LENSES, counter: { type: 'noul', question: 'Does {item} cut against it?' } },
    presets: [
      { id: 'ask' },
      { id: 'topic', lens: 'topic', group: true },
      { id: 'counter', lens: 'counter', thesis: 'the default claim' },
      { id: 'combo', title: 'Combo', lenses: { y: 'yes', s: 'scale', t: 'topic' }, value: { max: ['y', 's'] }, label: { choice: 't', via: { y: 'goodness', s: 'size' } }, group: 't' },
    ],
  };
  assert.throws(() => preset(config, 'ask', { phrase: ' ' }), /needs a phrase/);
  assert.throws(() => preset(config, 'nope'), /unknown preset "nope"/);
  assert.equal(preset(config, 'ask', { phrase: 'x', type: 'score' }).lenses.q.build('this item').type, 'score');

  const topic = preset(config, 'topic');
  assert.equal(topic.group({ q: { choice: 'b' } }), 'b');

  assert.equal(preset(config, 'counter').title, 'Against: the default claim');
  assert.match(preset(config, 'counter').lenses.q.build('it').instructions, /cut against it/);
  const typed = preset(config, 'counter', { thesis: 'open models win' });
  assert.match(typed.lenses.q.build('it').instructions, /against this claim: "open models win"/);

  const combo = preset(config, 'combo');
  const a = { y: { type: 'noul', noul: 0.2 }, s: { type: 'score', score: 1, legend: { 0: 's', 1: 'b' } }, t: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9 } } };
  assert.equal(combo.value(a), 1);
  assert.equal(combo.label(a), 'a via size');
  assert.equal(combo.group(a), 'a');

  const list = presetList(config);
  assert.deepEqual(list.map((p) => [p.id, p.input, p.grouped]), [['ask', true, false], ['topic', false, true], ['counter', true, false], ['combo', false, true]]);
});

test('filterItems applies kinds and a since date in code', () => {
  const items = [item('a', 'x', { date: '2026-05-01' }), item('b', 'x', { kind: 'news', date: '2026-09-01' }), item('c', 'x', { date: null })];
  assert.deepEqual(filterItems(items, { kind: 'news' }).map((i) => i.id), ['b']);
  assert.deepEqual(filterItems(items, { since: '2026-06' }).map((i) => i.id), ['b']);
  assert.equal(filterItems(items, {}).length, 3);
});

test('requestFor: one item is the whole state; packed items get a slot and a pointer', () => {
  const l = buildLenses(LENSES);
  const one = requestFor([item('a', 'hello')], { q: askLens('topic') });
  assert.equal(one.state.text, 'hello');
  assert.match(one.questions.q.instructions, /^Does this item match/);
  const packed = requestFor([item('a', 'x'), item('b', 'y')], { t: l.topic, y: l.yes });
  assert.deepEqual(Object.keys(packed.state.items), ['a', 'b']);
  assert.deepEqual(Object.keys(packed.questions).sort(), ['a.t', 'a.y', 'b.t', 'b.y']);
  assert.match(packed.questions['b.t'].instructions, /`items\.b`/);
  assert.equal(packed.state.items.a.path, undefined); // paths and ids never reach the model
});

test('siftMany maps packed answers back to the right items, in any pack size', async () => {
  const items = Array.from({ length: 40 }, (_, i) => item(`i${i}`, i % 3 === 0 ? 'match match' : 'nothing'));
  for (const pack of [1, 7, 16, 26, 99]) {
    const jev = stubClient();
    const res = await siftMany(jev, items, { q: askLens('x') }, { pack });
    assert.equal(res.length, 40);
    for (const r of res) assert.equal(r.answers.q.noul, r.item.text === 'match match' ? 1 : 0, `pack ${pack}`);
    assert.equal(jev.calls.length, Math.ceil(40 / Math.min(pack, SLOTS.length)));
  }
});

test('sift ranks by value, highest first', async () => {
  const res = await sift(stubClient(), [item('a', 'nothing'), item('b', 'match match'), item('c', 'match')], askLens('x'), { pack: 2 });
  assert.deepEqual(res.map((r) => r.item.id), ['b', 'c', 'a']);
});

test('isLinked finds a file by path, basename, README folder, or same-name folder', () => {
  const text = 'see `notes/briefs/2026-09_a.md` and guides/2026-06 setup/ and the my-first-post post';
  assert.ok(isLinked({ path: 'notes/briefs/2026-09_a.md' }, text));
  assert.ok(isLinked({ path: 'elsewhere/2026-09_a.md' }, text));
  assert.ok(isLinked({ path: 'guides/2026-06 setup/README.md' }, text));
  assert.ok(isLinked({ path: 'blog/drafts/my-first-post/my-first-post.md' }, text));
  assert.ok(!isLinked({ path: 'notes/briefs/2026-09_b.md' }, text));
  // a README is not "linked" just because some other README.md is mentioned
  assert.ok(!isLinked({ path: 'talks/t1/README.md' }, 'see talks/t2/README.md'));
});

test('buildReport: orphans by category, composite hooks, and confident refilings', () => {
  const noul = (p) => ({ type: 'noul', noul: p });
  const cat = (choice, confidence) => ({ type: 'choice', choice, confidence, probabilities: { [choice]: confidence, none: 1 - confidence } });
  const grp = (choice) => ({ type: 'choice', choice, confidence: 0.9, probabilities: { [choice]: 0.9, none: 0.1 } });
  const answers = (c, g, x, y = 0.1) => ({ lane: c, book: g, one: noul(x), two: noul(y) });
  const results = [
    { item: item('orphan', 'x', { title: 'Orphan note' }), answers: answers(cat('verification', 0.95), grp('none'), 0.1) },
    { item: item('linked', 'x', { title: 'Linked note' }), answers: answers(cat('verification', 0.95), grp('ch05'), 0.9) },
    { item: item('hook', 'x', { title: 'Hook note' }), answers: answers(cat('community', 0.7), grp('ch02'), 0.2, 0.85) },
    { item: item('ins', 'x', { kind: 'entry', title: 'Misfiled entry', label: 'engineering', path: 'log/engineering.md', line: 9 }), answers: answers(cat('verification', 0.97), grp('none'), 0.1) },
  ];
  const route = {
    lenses: { lane: 'lane', book: 'book', one: 'one', two: 'two' },
    category: 'lane', confident: 0.8,
    orphans: { kinds: ['note'] },
    hooks: { title: 'Hooks', about: 'the book', kinds: ['note'], angles: { one: 'angle one', two: 'angle two' }, choice: 'book', min: 0.6 },
    secondLooks: { kinds: ['entry'], min: 0.9 },
  };
  const linked = { all: 'notes/linked.md notes/hook.md', hooks: '' };
  const root = path.join(os.tmpdir(), 'corpus');
  const { markdown, counts } = buildReport({
    results, route, linked, today: '2026-09-23',
    stats: { model: 'stub', requests: 1, cached: 0, cost: 0.001, ms: 900 },
    linkFrom: { root, dir: path.join(root, 'reports') },
    lensLabels: { lane: 'Lane', book: 'Book chapter', one: 'One', two: 'Two' },
  });
  assert.deepEqual(counts, { orphans: 1, hooks: 2, secondLooks: 1 });
  assert.match(markdown, /\| \[Orphan note\]\(\.\.\/notes\/orphan\.md\) \| note \| 2026-09-01 \| \*\*95%\*\*/);
  assert.match(markdown, /### ch02 \(1\)\n\n- \[Hook note\].*angle two 85%, this book chapter 90%/);
  assert.match(markdown, /### ch05 \(1\)\n\n- \[Linked note\].*angle one 90%/);
  assert.match(markdown, /Misfiled entry\]\(\.\.\/log\/engineering\.md#L9\) \| engineering \| verification 97% \|/);
  assert.doesNotMatch(markdown, /—/);
});

test('eval strips configured patterns and scores accuracy, bands, and confusion', () => {
  const t = stripLabels('**Tags:** `[verification]`\nBody about [some-tag] things.', ['^\\*\\*Tags:\\*\\*.*$', '`?\\[[a-z0-9-]+\\]`?']);
  assert.equal(t, 'Body about  things.');
  const r = (label, choice, confidence) => ({ item: { label }, answer: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence, [label]: 1 - confidence } } });
  const s = score([r('a', 'a', 0.9), r('a', 'b', 0.6), r('b', 'b', 0.95), { item: { label: 'a' }, answer: null }]);
  assert.deepEqual([s.n, s.errors, s.accuracy, s.top2, s.bands[0].accuracy], [3, 1, 2 / 3, 1, 1]);
  assert.deepEqual(s.confusion, { 'a -> b': 1 });
});

test('server binds to localhost, serves config meta, runs one sift at a time, and preflights for free', async () => {
  const { serve } = require('../lib/server.cjs');
  const config = { name: 'Test', root: os.tmpdir(), sources: [{ kind: 'note', display: 'notes', glob: '*.none' }], lenses: LENSES, presets: [{ id: 'ask' }, { id: 'topic', lens: 'topic', group: true }], examples: ['one'] };
  const corpus = [item('a', 'match'), item('b', 'nothing')];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { questions } = JSON.parse(body);
      const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul', noul: 0.7 }]));
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'fake', answers, usage: { input_tokens: 10, cost: 0.000001 } })); }, 150);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  process.env.JEV_BASE_URL = `http://127.0.0.1:${fake.address().port}/`;
  process.env.OPENROUTER_API_KEY ||= 'test-key';
  const server = serve({ config, corpus, port: 0, cacheFile: null });
  await new Promise((r) => server.once('listening', r));
  const { address, port } = server.address();
  assert.equal(address, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.items, 2);
    assert.equal(meta.dated, 2);
    assert.deepEqual(meta.presets.map((p) => p.id), ['ask', 'topic']);
    assert.deepEqual(meta.examples, ['one']);
    assert.deepEqual(meta.kinds, { note: 'notes' });

    assert.equal((await fetch(`${base}/api/sift?preset=ask&q=`)).status, 400);
    assert.equal((await fetch(`${base}/api/sift?preset=nope`)).status, 400);
    const pre = await fetch(`${base}/api/sift?preset=ask&q=topic&check=1`);
    assert.deepEqual(await pre.json(), { ok: true, title: 'topic' });

    const first = fetch(`${base}/api/sift?preset=ask&q=topic`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await fetch(`${base}/api/sift?preset=ask&q=topic`)).status, 429);
    const stream = await first;
    assert.match(stream, /event: start/);
    assert.match(stream, /event: batch/);
    assert.match(stream, /event: done\ndata: \{"items":2,"requests":1/);
  } finally {
    delete process.env.JEV_BASE_URL;
    server.close();
    fake.close();
  }
});
