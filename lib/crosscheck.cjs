// Crosscheck: every note checked against every other note.
//
// Each item takes a turn as the anchor, and every other item in its group is asked how it relates
// to it: the same stance question as "related" (same, supports, contradicts, topic, unrelated).
// So every pair is judged twice, once from each side, and a pair is reported on the average of
// the two. One side alone saying "contradicts" is mostly noise; two sides agreeing rarely is.
// `node sieve.cjs crosscheck --dry-run` on your own notes says what a run would ask and cost.
//
// Pairs grow with the square of the corpus, so three things keep a run in hand:
//   within   compare items only inside a group: "all" (default), "label", or "kind".
//   budget   the cost is estimated before anything is spent, a run over budget never starts, and
//            a run whose real bill reaches the budget stops there.
//   memory   every judgment is remembered by the text of both notes and the wording of the
//            question, so after a new note lands only the pairs it is part of are asked.
//
// Configured under "crosscheck" in sieve.config.json (every field optional):
//   "crosscheck": { "kinds": ["insight", "brief"], "within": "label", "flag": 0.5, "review": 0.35,
//                   "same": 0.7, "budget": 1, "reportsDir": "reports" }

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { relatedLens, RELATIONS } = require('./lenses.cjs');
const { requestFor, answersFor, view, SLOTS, DEFAULT_PACK } = require('./sift.cjs');
const { changedFiles, annotation } = require('./lint.cjs');
const { link, pct } = require('./route.cjs');
const { buildCorpus } = require('./corpus.cjs');
const backends = require('./backends.cjs');

const DEFAULTS = { within: 'all', flag: 0.5, review: 0.35, same: 0.7, budget: 1 };
const WITHIN = ['all', 'label', 'kind'];
const NAMES = Object.keys(RELATIONS); // the order probabilities are stored in
const CHARS_PER_TOKEN = 3.0; // measured on real bills: these requests are mostly short questions
const JEV_PRICE = 0.042; // dollars per million input tokens, for a backend with no listed price
const PER_MINUTE = 1100; // under Jev's documented 1,200 requests a minute

// A number from the config or the command line. Only a plain decimal counts: "" and null are
// not zero, "0x10" is not sixteen.
function number(value, name, what) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(\d+(\.\d+)?|\.\d+)$/.test(value.trim())) return Number(value);
  throw new Error(`crosscheck: "${name}" is ${what}`);
}

function settingsFor(config, opts = {}) {
  const c = config.crosscheck || {};
  const pick = (k) => (opts[k] !== undefined ? opts[k] : c[k] !== undefined ? c[k] : DEFAULTS[k]);
  const s = { within: String(pick('within')) };
  if (!WITHIN.includes(s.within)) throw new Error(`crosscheck: "within" is one of ${WITHIN.join(', ')}`);
  for (const k of ['flag', 'review', 'same']) {
    s[k] = number(pick(k), k, 'a probability between 0 and 1');
    if (s[k] > 1) throw new Error(`crosscheck: "${k}" is a probability between 0 and 1`);
  }
  if (!(s.flag > s.review)) throw new Error('crosscheck: "flag" must be above "review"');
  s.budget = number(pick('budget'), 'budget', 'an amount in dollars, like 1 or 0.25');
  if (c.kinds !== undefined && !(Array.isArray(c.kinds) && c.kinds.length)) throw new Error('crosscheck: "kinds" must be a list, like ["insight"]');
  s.kinds = c.kinds ? new Set(c.kinds) : null;
  s.reportsDir = path.resolve(config.dir || '.', c.reportsDir || config.route?.reportsDir || 'reports');
  return s;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// What the model sees of an item, hashed. A judgment is remembered for exactly this text, so
// editing a note forgets its pairs and moving it to another file or line does not.
const fingerprint = (item) => sha(JSON.stringify(view(item))).slice(0, 24);

const round = (x) => Math.round(x * 1e4) / 1e4;
const valid = (p) => Array.isArray(p) && p.length === NAMES.length && p.every((x) => typeof x === 'number' && x >= 0 && x <= 1);

// Judgments already made, one line each in a JSONL file: a key (the backend, the question, and
// the two fingerprints in the order anchor, item) and the five probabilities in NAMES order.
// Without a file it remembers for this run only.
//
// The file is read in pieces, never as one string, so a memory of millions of judgments loads.
// Lines that are torn, repeated, or in an older shape are dropped or rewritten on load.
class PairMemory {
  constructor(file, scope = '') {
    this.file = file || null;
    this.scope = scope;
    this.map = new Map();
    this.pending = [];
    if (this.file && fs.existsSync(this.file)) this.load();
  }

  load() {
    let lines = 0;
    let untidy = false;
    const take = (line) => {
      if (!line.trim()) return;
      lines++;
      let entry;
      try { entry = JSON.parse(line); } catch (_) { untidy = true; return; }
      let p = entry?.p;
      if (p && !Array.isArray(p) && typeof p === 'object') { p = NAMES.map((name) => p[name] ?? 0); untidy = true; }
      if (typeof entry?.k !== 'string' || !valid(p)) { untidy = true; return; }
      this.map.set(entry.k, p);
    };
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      const decoder = new StringDecoder('utf8');
      let rest = '';
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        const parts = (rest + decoder.write(buf.subarray(0, n))).split('\n');
        rest = parts.pop();
        for (const line of parts) take(line);
      }
      rest += decoder.end();
      if (rest) { untidy = true; take(rest); } // no newline at the end: the last write was cut short
    } finally { fs.closeSync(fd); }
    if (untidy || lines > this.map.size) this.compact();
  }

  // Rewrite the file as one line for each judgment, through a temporary file.
  compact() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, '');
    let batch = [];
    const flush = () => { if (batch.length) fs.appendFileSync(tmp, batch.join('')); batch = []; };
    for (const [k, p] of this.map) {
      batch.push(`${JSON.stringify({ k, p })}\n`);
      if (batch.length >= 20000) flush();
    }
    flush();
    fs.renameSync(tmp, this.file);
  }

  key(anchor, item) { return sha(`${this.scope}|${anchor}|${item}`).slice(0, 32); }
  has(anchor, item) { return this.map.has(this.key(anchor, item)); }
  get(anchor, item) {
    const p = this.map.get(this.key(anchor, item));
    return p ? Object.fromEntries(NAMES.map((name, i) => [name, p[i]])) : undefined;
  }
  set(anchor, item, probabilities) {
    const k = this.key(anchor, item);
    const p = NAMES.map((name) => round(Math.min(1, Math.max(0, Number(probabilities[name]) || 0))));
    this.map.set(k, p);
    if (this.file) this.pending.push(`${JSON.stringify({ k, p })}\n`);
  }
  // One write for everything set since the last save: a request's answers land together.
  save() {
    if (!this.file || !this.pending.length) return;
    if (!this.ready) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); this.ready = true; }
    fs.appendFileSync(this.file, this.pending.join(''));
    this.pending = [];
  }
}

// Answers from one backend, or to one wording of the question, never stand in for another's.
function scopeOf(jev, lens) {
  return sha(`${jev.model || ''}|${jev.profile ? backends.cacheScope(jev.profile, jev.servedRun) : ''}|${JSON.stringify(lens.build('`item`'))}`).slice(0, 16);
}

function groupsOf(items, within) {
  const groups = new Map();
  for (const it of items) {
    const g = within === 'all' ? '' : within === 'kind' ? it.kind : it.label || '(no label)';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  return [...groups.entries()].filter(([, g]) => g.length > 1);
}

// Every pair to judge, each once: [a, b] with a before b in its group. `only` (a set of item ids)
// keeps the pairs that touch one of those items, which is what `--changed` asks for.
function pairsOf(groups, only) {
  const pairs = [];
  for (const [, g] of groups) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        if (only && !only.has(g[i].id) && !only.has(g[j].id)) continue;
        pairs.push([g[i], g[j]]);
      }
    }
  }
  return pairs;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// The work for a set of pairs: how many distinct judgments they need, how many are remembered,
// and the requests for the rest (for each anchor, the items still to ask, `pack` to a request).
// Two notes with the same text share a fingerprint, so a judgment about one covers the other
// and is asked once.
function requestsFor(pairs, memory, prints, pack) {
  const todo = new Map(); // anchor -> items
  const seen = new Set();
  let remembered = 0;
  const want = (anchor, item) => {
    const key = `${prints.get(anchor)}|${prints.get(item)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (memory.has(prints.get(anchor), prints.get(item))) { remembered++; return; }
    if (!todo.has(anchor)) todo.set(anchor, []);
    todo.get(anchor).push(item);
  };
  for (const [a, b] of pairs) { want(a, b); want(b, a); }
  const size = Math.max(1, Math.min(pack, SLOTS.length));
  const requests = [];
  for (const [anchor, items] of todo) for (const group of chunk(items, size)) requests.push({ anchor, group });
  return { requests, judgments: seen.size, remembered };
}

// The size of a request in characters, without building it: a run can hold tens of thousands.
// It mirrors the two shapes sift's requestFor makes, a lone item and a pack. `size` gives the
// length of an item as the model sees it (pass a cached one for a long run).
function requestChars(anchor, group, lens, size = (it) => JSON.stringify(view(it)).length) {
  if (group.length === 1) {
    return '{"state":{"anchor":,"item":},"questions":{"q":}}'.length + size(anchor) + size(group[0]) + JSON.stringify(lens.build('`item`')).length;
  }
  const question = JSON.stringify(lens.build('`items.a`')).length;
  let n = '{"state":{"anchor":,"items":{}},"questions":{}}'.length + size(anchor) + 2 * (group.length - 1); // the commas
  for (const it of group) n += '"a":'.length + size(it) + '"a.q":'.length + question;
  return n;
}

// A server on this machine costs nothing and has no rate limit, whatever its profile calls it.
const onThisMachine = (profile) => Boolean(profile) && (profile.kind === 'local' || backends.isLoopback(profile.baseUrl));

function estimate(requests, lens, profile) {
  const lengths = new Map();
  const size = (it) => {
    if (!lengths.has(it)) lengths.set(it, JSON.stringify(view(it)).length);
    return lengths.get(it);
  };
  let chars = 0;
  let judgments = 0;
  for (const r of requests) { chars += requestChars(r.anchor, r.group, lens, size); judgments += r.group.length; }
  const listed = onThisMachine(profile) ? 0 : profile ? backends.pricePerMTok(profile) : null;
  const price = listed === null ? JEV_PRICE : listed;
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  return { requests: requests.length, judgments, tokens, cost: tokens * (price / 1e6), priced: listed !== null };
}

// The order a pair is shown in: the newer note first when both are dated and the dates differ,
// otherwise the order they have in the corpus.
const newerFirst = (a, b) => (a.date && b.date && b.date > a.date ? [b, a] : [a, b]);

// A pair's two judgments, averaged. `sides` keeps each side's number for the relation reported.
// `subject` is the note a finding is about: the changed one under `--changed`, else the first.
function verdicts(pairs, memory, prints, s, only = null) {
  const out = { contradictions: [], review: [], same: [], unjudged: 0 };
  for (const [x, y] of pairs) {
    const xy = memory.get(prints.get(x), prints.get(y));
    const yx = memory.get(prints.get(y), prints.get(x));
    if (!xy || !yx) { out.unjudged++; continue; }
    const mean = Object.fromEntries(NAMES.map((r) => [r, (xy[r] + yx[r]) / 2]));
    const [a, b] = newerFirst(x, y);
    // sides[0] is the judgment with `a` as the anchor, sides[1] the one with `b`
    const [fromA, fromB] = a === x ? [xy, yx] : [yx, xy];
    const subject = only && !only.has(a.id) && only.has(b.id) ? b : a;
    const row = (relation) => ({ a, b, subject, other: subject === a ? b : a, relation, p: mean[relation], sides: [fromA[relation], fromB[relation]], mean });
    if (mean.contradicts >= s.flag) out.contradictions.push(row('contradicts'));
    else if (mean.contradicts >= s.review) out.review.push(row('contradicts'));
    else if (mean.same >= s.same) out.same.push(row('same'));
  }
  for (const k of ['contradictions', 'review', 'same']) out[k].sort((m, n) => n.p - m.p);
  return out;
}

// Items that disagree with several others: a dissenting note, or one that has gone stale.
function contested(contradictions, min = 3) {
  const by = new Map();
  for (const c of contradictions) for (const it of [c.a, c.b]) by.set(it, (by.get(it) || 0) + 1);
  return [...by.entries()].filter(([, n]) => n >= min).sort((x, y) => y[1] - x[1]).map(([item, n]) => ({ item, pairs: n }));
}

// The items that differ from a git ref. A changed file is read as it was at the ref, split into
// items the same way, and an item whose title and text were already there is left out: adding a
// section to a long file does not make every older section in it new.
function changedItems(config, items, ref) {
  const files = changedFiles(config.root, ref);
  const touched = [...new Set(items.filter((it) => files.has(it.path)).map((it) => it.path))];
  if (!touched.length) return { only: new Set(), files: [] };
  const git = (args) => execFileSync('git', args, { cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  const prefix = git(['rev-parse', '--show-prefix']).trim();
  const before = fs.mkdtempSync(path.join(os.tmpdir(), 'sieve-before-'));
  try {
    for (const file of touched) {
      let text;
      try { text = git(['show', `${ref}:${prefix}${file}`]); } catch (_) { continue; } // not there at the ref: a new file
      const at = path.join(before, file);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, text);
    }
    const words = (it) => `${it.path}\n${it.title}\n${it.text}`;
    const was = new Set(buildCorpus({ ...config, root: before, gitDates: false }).map(words));
    const only = new Set(items.filter((it) => files.has(it.path) && !was.has(words(it))).map((it) => it.id));
    return { only, files: [...new Set(items.filter((it) => only.has(it.id)).map((it) => it.path))] };
  } finally {
    fs.rmSync(before, { recursive: true, force: true });
  }
}

// Dollars to the cent, or to four places when a cent would round the amount away.
const usd = (x) => `$${x.toFixed(x > 0 && x < 0.01 ? 4 : 2)}`;

async function crosscheck(jev, corpus, config, opts = {}) {
  const s = settingsFor(config, opts);
  const items = corpus.filter((it) => !s.kinds || s.kinds.has(it.kind));
  const changed = opts.changed ? changedItems(config, items, opts.changed) : null;
  const only = changed ? changed.only : null;
  const groups = groupsOf(items, s.within);
  const pairs = pairsOf(groups, only);
  const prints = new Map(items.map((it) => [it, fingerprint(it)]));
  const lens = relatedLens();
  const memory = new PairMemory(opts.memoryFile, scopeOf(jev, lens));
  const pack = opts.pack || jev.profile?.pack || DEFAULT_PACK;
  const work = requestsFor(pairs, memory, prints, pack);
  const { requests } = work;
  const est = estimate(requests, lens, jev.profile);
  const plan = {
    items: items.length, groups: groups.length, within: s.within, pairs: pairs.length,
    judgments: work.judgments, remembered: work.remembered, estimate: est, budget: s.budget,
    overBudget: est.cost > s.budget, changed: changed ? changed.files : null,
  };
  if (opts.onPlan) opts.onPlan(plan);
  if (plan.overBudget && !opts.dryRun) {
    // when both round to the same cents, show the places that tell them apart
    const close = usd(est.cost) === usd(s.budget);
    const show = (x) => (close ? `$${x.toFixed(4)}` : usd(x));
    throw new Error(`crosscheck would cost about ${show(est.cost)} (${est.requests.toLocaleString('en-US')} requests for ${est.judgments.toLocaleString('en-US')} judgments), over the ${show(s.budget)} budget. Nothing was spent. Narrow it with --kind, --since, or "within" in the config, or allow it with --budget ${Math.ceil(est.cost * 1.25 * 100) / 100}.`);
  }

  const before = jev.summary();
  const t0 = Date.now();
  const errors = [];
  let stopped = null;
  const spent = () => (jev.summary().cost_usd || 0) - (before.cost_usd || 0);
  if (!opts.dryRun && requests.length) {
    const guard = new AbortController();
    const outside = () => { stopped = stopped || 'signal'; guard.abort(); };
    if (opts.signal?.aborted) outside();
    else opts.signal?.addEventListener('abort', outside, { once: true });
    let done = 0;
    await jev.map(requests, (r) => requestFor(r.group, { q: lens }, { anchor: view(r.anchor) }), {
      concurrency: opts.concurrency || jev.profile?.concurrency || 8,
      cache: false, // the pair memory is the record; a second copy per request would only grow
      perMinute: onThisMachine(jev.profile) ? 0 : PER_MINUTE,
      signal: guard.signal,
      onResult: (res, i, r) => {
        r.group.forEach((it, k) => {
          const p = answersFor(res, r.group, k, ['q'])?.q?.probabilities;
          if (p) memory.set(prints.get(r.anchor), prints.get(it), p);
          else errors.push({ anchor: r.anchor, item: it, error: res.error || 'no answer' });
        });
        memory.save();
        // The estimate is a guess at the bill; the bill itself is the limit. Requests already
        // sent still land, so a run can end a few requests past the budget, never far.
        if (!stopped && spent() > s.budget) { stopped = 'budget'; guard.abort(); }
        if (opts.onProgress) opts.onProgress(++done, requests.length);
      },
    });
    opts.signal?.removeEventListener('abort', outside);
  }
  const after = jev.summary();
  const found = opts.dryRun ? { contradictions: [], review: [], same: [], unjudged: 0 } : verdicts(pairs, memory, prints, s, only);
  return {
    settings: { within: s.within, flag: s.flag, review: s.review, same: s.same, budget: s.budget },
    plan,
    dryRun: Boolean(opts.dryRun),
    changed: changed ? changed.files : null,
    ...found,
    contested: contested(found.contradictions),
    errors,
    stopped,
    stats: {
      model: jev.model, served: jev.servedRun || '', label: jev.profile?.label,
      requests: after.requests - before.requests, cost: spent(), ms: Date.now() - t0,
    },
    reportsDir: s.reportsDir,
  };
}

const sidesOf = (f) => `${pct(f.sides[0])} and ${pct(f.sides[1])}`;
const n = (x) => x.toLocaleString('en-US');

// Why some pairs have no verdict, in words a person can act on.
function unjudgedLine(res) {
  if (!res.unjudged) return '';
  const pairs = `${n(res.unjudged)} pair${res.unjudged === 1 ? ' was' : 's were'} not judged`;
  if (res.stopped === 'budget') return `${pairs}: the run stopped when the bill reached the ${usd(res.settings.budget)} budget. What was judged is remembered, so a run with a higher --budget asks only the rest.`;
  if (res.stopped) return `${pairs}: the run was stopped. What was judged is remembered, so the next run asks only the rest.`;
  return `${pairs} because a request failed; run it again to ask only those.`;
}

function buildReport(res, { today, linkFrom }) {
  const lines = [];
  const push = (...l) => lines.push(...l);
  const { plan, stats, settings } = res;
  push(`# Sieve crosscheck, ${today}`, '');
  push(`Answered by ${stats.label ? `${stats.label}: ` : ''}\`${stats.model}\`${stats.served ? `, serving ${stats.served}` : ''}.`);
  push(`It compared ${n(plan.items)} item${plan.items === 1 ? '' : 's'} in ${n(plan.pairs)} pair${plan.pairs === 1 ? '' : 's'}${settings.within === 'all' ? '' : `, each within its own ${settings.within}`}${res.changed ? `, keeping the pairs that touch a changed note (${res.changed.length} file${res.changed.length === 1 ? '' : 's'})` : ''}.`);
  push(`Each pair was judged from both sides: ${n(plan.judgments)} judgments, ${n(plan.remembered)} remembered from earlier runs and ${n(plan.judgments - plan.remembered)} to ask, in ${n(stats.requests)} requests, ${(stats.ms / 1000).toFixed(1)} seconds, and $${stats.cost.toFixed(4)}.`);
  push(`A pair is listed when the two sides average ${pct(settings.flag)} or more; the two numbers on each row are the sides.`);
  push('When the dates of a pair differ, the newer note is first.');
  push('Everything below is a suggestion: a disagreement can be a mistake, a fact that has moved on, or the most useful note in the folder.', '');
  if (res.unjudged) push(unjudgedLine(res), '');

  const table = (rows) => {
    push('| Average | Sides | Note | Against |', '|---|---|---|---|');
    for (const f of rows) push(`| ${pct(f.p)} | ${sidesOf(f)} | ${f.a.date ? `${f.a.date} ` : ''}${link(f.a, linkFrom)} | ${f.b.date ? `${f.b.date} ` : ''}${link(f.b, linkFrom)} |`);
    push('');
  };

  push(`## 1. Contradictions (${res.contradictions.length})`, '');
  push('Pairs where each note disagrees with the other, or reports facts that cut against it.');
  push('When the dates differ, check whether the newer note replaces the older one.', '');
  if (res.contradictions.length) table(res.contradictions); else push('None.', '');

  if (res.contested.length) {
    push(`## 2. Notes that disagree with several others (${res.contested.length})`, '');
    push('One note against many is a dissenting view worth keeping in sight, or a note that has gone stale.', '');
    for (const c of res.contested) push(`- ${link(c.item, linkFrom)}: ${c.pairs} contradictions`);
    push('');
  }

  const base = res.contested.length ? 2 : 1;
  push(`## ${base + 1}. Worth a second look (${res.review.length})`, '');
  push(`Pairs that average between ${pct(settings.review)} and ${pct(settings.flag)}. Some are real tensions stated mildly; some are one side misreading the other.`, '');
  if (res.review.length) table(res.review); else push('None.', '');

  push(`## ${base + 2}. The same point, twice (${res.same.length})`, '');
  push(`Pairs that average ${pct(settings.same)} or more on making the same point or reporting the same event: a note and its source, or a duplicate. Link them or merge them.`, '');
  if (res.same.length) table(res.same); else push('None.', '');

  push('---', '', 'Generated by `sieve crosscheck`. Running it again asks only about notes that are new or edited.');
  return lines.join('\n') + '\n';
}

// `name` tells a narrowed run's report from the full one written the same day.
function writeReport(res, config, { today = new Date().toLocaleDateString('en-CA'), name = '' } = {}) {
  fs.mkdirSync(res.reportsDir, { recursive: true });
  const tail = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(res.reportsDir, `crosscheck-${today}${tail ? `-${tail}` : ''}.md`);
  fs.writeFileSync(file, buildReport(res, { today, linkFrom: { root: config.root, dir: res.reportsDir } }));
  return file;
}

// A finding is annotated on its subject: the changed note in a pull request, else the first of
// the pair. The other note is named by the same path GitHub would show for it.
function githubAnnotations(res, root, { strict = false, cwd = process.env.GITHUB_WORKSPACE || process.cwd() } = {}) {
  const where = (it) => `${path.relative(cwd, path.join(root, it.path)).split(path.sep).join('/')}:${it.line}`;
  const line = (cmd, f, word) => annotation(cmd, f.subject, 'sieve: crosscheck', `${word} "${f.other.title}" (${where(f.other)}), ${pct(f.p)}: ${f.subject.title}`, root, cwd);
  const failed = new Map(); // anchor -> how many of its judgments have no answer
  for (const e of res.errors) failed.set(e.anchor, (failed.get(e.anchor) || 0) + 1);
  return [
    ...res.contradictions.map((f) => line(strict ? 'error' : 'warning', f, 'Contradicts')),
    ...res.review.map((f) => line('notice', f, 'May contradict')),
    ...[...failed].map(([item, count]) => annotation('warning', item, 'sieve: crosscheck', `not checked against ${count} note${count === 1 ? '' : 's'}: a request failed`, root, cwd)),
    ...(res.stopped ? [`::warning title=sieve%3A crosscheck::${unjudgedLine(res).replace(/%/g, '%25')}`] : []),
  ];
}

module.exports = {
  crosscheck, settingsFor, PairMemory, fingerprint, groupsOf, pairsOf, requestsFor, requestChars, estimate,
  verdicts, contested, changedItems, buildReport, writeReport, githubAnnotations, unjudgedLine, usd, DEFAULTS,
};
