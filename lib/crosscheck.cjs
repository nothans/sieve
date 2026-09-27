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
//   budget   the cost is estimated before anything is spent, and a run over budget stops there.
//   memory   every judgment is remembered by the text of both notes, so after a new note lands
//            only the pairs it is part of are asked.
//
// Configured under "crosscheck" in sieve.config.json (every field optional):
//   "crosscheck": { "kinds": ["insight", "brief"], "within": "label", "flag": 0.5, "review": 0.35,
//                   "same": 0.7, "budget": 1, "reportsDir": "reports" }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { relatedLens } = require('./lenses.cjs');
const { requestFor, answersFor, view, SLOTS, DEFAULT_PACK } = require('./sift.cjs');
const { changedFiles, annotation } = require('./lint.cjs');
const { link, pct } = require('./route.cjs');
const backends = require('./backends.cjs');

const DEFAULTS = { within: 'all', flag: 0.5, review: 0.35, same: 0.7, budget: 1 };
const WITHIN = ['all', 'label', 'kind'];
const CHARS_PER_TOKEN = 3.0; // measured on real bills: these requests are mostly short questions
const JEV_PRICE = 0.042; // dollars per million input tokens, for a backend with no listed price
const PER_MINUTE = 1100; // under Jev's documented 1,200 requests a minute

function settingsFor(config, opts = {}) {
  const c = config.crosscheck || {};
  const pick = (k) => (opts[k] !== undefined && opts[k] !== null ? opts[k] : c[k] !== undefined ? c[k] : DEFAULTS[k]);
  const s = { within: String(pick('within')), flag: Number(pick('flag')), review: Number(pick('review')), same: Number(pick('same')), budget: Number(pick('budget')) };
  if (!WITHIN.includes(s.within)) throw new Error(`crosscheck: "within" is one of ${WITHIN.join(', ')}`);
  for (const k of ['flag', 'review', 'same']) if (!(s[k] >= 0 && s[k] <= 1)) throw new Error(`crosscheck: "${k}" is a probability between 0 and 1`);
  if (!(s.flag > s.review)) throw new Error('crosscheck: "flag" must be above "review"');
  if (!(s.budget >= 0)) throw new Error('crosscheck: "budget" is an amount in dollars, like 1 or 0.25');
  if (c.kinds !== undefined && !(Array.isArray(c.kinds) && c.kinds.length)) throw new Error('crosscheck: "kinds" must be a list, like ["insight"]');
  s.kinds = c.kinds ? new Set(c.kinds) : null;
  s.reportsDir = path.resolve(config.dir || '.', c.reportsDir || config.route?.reportsDir || 'reports');
  return s;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// What the model sees of an item, hashed. A judgment is remembered for exactly this text, so
// editing a note forgets its pairs and moving it to another file or line does not.
const fingerprint = (item) => sha(JSON.stringify(view(item))).slice(0, 24);

// Judgments already made, one line each in a JSONL file: the two fingerprints, in the order
// (anchor, item), and the probabilities. Without a file it remembers for this run only.
class PairMemory {
  constructor(file, scope = '') {
    this.file = file || null;
    this.scope = scope;
    this.map = new Map();
    if (this.file && fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const { k, p } = JSON.parse(line); if (k && p) this.map.set(k, p); } catch (_) { /* a torn last line */ }
      }
    }
  }
  key(anchor, item) { return sha(`${this.scope}|${anchor}|${item}`).slice(0, 32); }
  get(anchor, item) { return this.map.get(this.key(anchor, item)); }
  set(anchor, item, p) {
    const k = this.key(anchor, item);
    this.map.set(k, p);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ k, p }) + '\n');
  }
}

// Answers from one backend never stand in for another's.
function scopeOf(jev) {
  return `${jev.model || ''}|${jev.profile ? backends.cacheScope(jev.profile, jev.servedRun) : ''}`;
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

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// The requests still to make: for each anchor, the items it has no remembered judgment for,
// packed `pack` to a request.
function requestsFor(pairs, memory, prints, pack) {
  const todo = new Map(); // anchor -> items
  const want = (anchor, item) => {
    if (memory.get(prints.get(anchor), prints.get(item))) return;
    if (!todo.has(anchor)) todo.set(anchor, []);
    todo.get(anchor).push(item);
  };
  for (const [a, b] of pairs) { want(a, b); want(b, a); }
  const size = Math.max(1, Math.min(pack, SLOTS.length));
  const requests = [];
  for (const [anchor, items] of todo) for (const group of chunk(items, size)) requests.push({ anchor, group });
  return requests;
}

// The size of a request in characters, without building it: a run can hold tens of thousands.
// It mirrors the two shapes sift's requestFor makes, a lone item and a pack.
function requestChars(anchor, group, lens) {
  const a = JSON.stringify(view(anchor)).length;
  const body = (it) => JSON.stringify(view(it)).length;
  if (group.length === 1) {
    return '{"state":{"anchor":,"item":},"questions":{"q":}}'.length + a + body(group[0]) + JSON.stringify(lens.build('`item`')).length;
  }
  const question = JSON.stringify(lens.build('`items.a`')).length;
  let n = '{"state":{"anchor":,"items":{}},"questions":{}}'.length + a + 2 * (group.length - 1); // the commas
  for (const it of group) n += '"a":'.length + body(it) + '"a.q":'.length + question;
  return n;
}

function estimate(requests, lens, profile) {
  let chars = 0;
  let judgments = 0;
  for (const r of requests) { chars += requestChars(r.anchor, r.group, lens); judgments += r.group.length; }
  const listed = profile ? backends.pricePerMTok(profile) : null;
  const price = listed === null ? JEV_PRICE : listed;
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  return { requests: requests.length, judgments, tokens, cost: tokens * (price / 1e6), priced: listed !== null };
}

const RELATIONS = ['same', 'supports', 'contradicts', 'topic', 'unrelated'];
const newerFirst = (a, b) => ((a.date || '') >= (b.date || '') ? [a, b] : [b, a]);

// A pair's two judgments, averaged. `sides` keeps each side's number for the relation reported.
function verdicts(pairs, memory, prints, s) {
  const out = { contradictions: [], review: [], same: [], unjudged: 0 };
  for (const [x, y] of pairs) {
    const xy = memory.get(prints.get(x), prints.get(y));
    const yx = memory.get(prints.get(y), prints.get(x));
    if (!xy || !yx) { out.unjudged++; continue; }
    const mean = Object.fromEntries(RELATIONS.map((r) => [r, ((xy[r] ?? 0) + (yx[r] ?? 0)) / 2]));
    const [a, b] = newerFirst(x, y);
    // sides[0] is the judgment with `a` as the anchor, sides[1] the one with `b`
    const [fromA, fromB] = a === x ? [xy, yx] : [yx, xy];
    const row = (relation) => ({ a, b, relation, p: mean[relation], sides: [fromA[relation] ?? 0, fromB[relation] ?? 0], mean });
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

async function crosscheck(jev, corpus, config, opts = {}) {
  const s = settingsFor(config, opts);
  const items = corpus.filter((it) => !s.kinds || s.kinds.has(it.kind));
  const changed = opts.changed ? changedFiles(config.root, opts.changed) : null;
  const only = changed ? new Set(items.filter((it) => changed.has(it.path)).map((it) => it.id)) : null;
  const groups = groupsOf(items, s.within);
  const pairs = pairsOf(groups, only);
  const prints = new Map(items.map((it) => [it, fingerprint(it)]));
  const memory = opts.memory || new PairMemory(opts.memoryFile, scopeOf(jev));
  const lens = relatedLens();
  const pack = opts.pack || jev.profile?.pack || DEFAULT_PACK;
  const requests = requestsFor(pairs, memory, prints, pack);
  const est = estimate(requests, lens, jev.profile);
  const plan = {
    items: items.length, groups: groups.length, within: s.within, pairs: pairs.length,
    judgments: pairs.length * 2, remembered: pairs.length * 2 - est.judgments, estimate: est, budget: s.budget,
  };
  plan.overBudget = est.cost > s.budget;
  if (opts.onPlan) opts.onPlan(plan);
  if (plan.overBudget && !opts.dryRun) {
    throw new Error(`crosscheck would cost about ${usd(est.cost)} (${est.requests.toLocaleString('en-US')} requests for ${est.judgments.toLocaleString('en-US')} judgments), over the ${usd(s.budget)} budget. Nothing was spent. Narrow it with --kind, --since, or "within" in the config, or allow it with --budget ${Math.ceil(est.cost * 1.25 * 100) / 100}.`);
  }

  const before = jev.summary();
  const t0 = Date.now();
  const errors = [];
  if (!opts.dryRun && requests.length) {
    const hosted = jev.profile && jev.profile.kind !== 'local';
    let done = 0;
    await jev.map(requests, (r) => requestFor(r.group, { q: lens }, { anchor: view(r.anchor) }), {
      concurrency: opts.concurrency || jev.profile?.concurrency || 8,
      cache: false, // the pair memory is the record; a second copy per request would only grow
      perMinute: hosted ? PER_MINUTE : 0,
      signal: opts.signal,
      onResult: (res, i, r) => {
        r.group.forEach((it, k) => {
          const p = answersFor(res, r.group, k, ['q'])?.q?.probabilities;
          if (p) memory.set(prints.get(r.anchor), prints.get(it), p);
          else errors.push({ anchor: r.anchor, item: it, error: res.error || 'no answer' });
        });
        if (opts.onProgress) opts.onProgress(++done, requests.length);
      },
    });
  }
  const after = jev.summary();
  const found = opts.dryRun ? { contradictions: [], review: [], same: [], unjudged: 0 } : verdicts(pairs, memory, prints, s);
  return {
    settings: { within: s.within, flag: s.flag, review: s.review, same: s.same, budget: s.budget },
    plan,
    dryRun: Boolean(opts.dryRun),
    changed: changed ? [...changed] : null,
    ...found,
    contested: contested(found.contradictions),
    errors,
    stats: {
      model: jev.model, served: jev.servedRun || '', label: jev.profile?.label,
      requests: after.requests - before.requests, cost: (after.cost_usd || 0) - (before.cost_usd || 0), ms: Date.now() - t0,
    },
    reportsDir: s.reportsDir,
  };
}

const sidesOf = (f) => `${pct(f.sides[0])} and ${pct(f.sides[1])}`;
const n = (x) => x.toLocaleString('en-US');
// Dollars to the cent, or to four places when a cent would round the amount away.
const usd = (x) => `$${x.toFixed(x > 0 && x < 0.01 ? 4 : 2)}`;

function buildReport(res, { today, linkFrom }) {
  const lines = [];
  const push = (...l) => lines.push(...l);
  const { plan, stats, settings } = res;
  push(`# Sieve crosscheck, ${today}`, '');
  push(`Answered by ${stats.label ? `${stats.label}: ` : ''}\`${stats.model}\`${stats.served ? `, serving ${stats.served}` : ''}.`);
  push(`It compared ${n(plan.items)} item${plan.items === 1 ? '' : 's'} in ${n(plan.pairs)} pair${plan.pairs === 1 ? '' : 's'}${settings.within === 'all' ? '' : `, each within its own ${settings.within}`}${res.changed ? `, keeping the pairs that touch ${res.changed.length} changed file${res.changed.length === 1 ? '' : 's'}` : ''}.`);
  push(`Each pair was judged from both sides: ${n(plan.judgments)} judgments, ${n(plan.remembered)} remembered from earlier runs and ${n(plan.judgments - plan.remembered)} asked now in ${n(stats.requests)} requests, ${(stats.ms / 1000).toFixed(1)} seconds, and $${stats.cost.toFixed(4)}.`);
  push(`A pair is listed when the two sides average ${pct(settings.flag)} or more; the two numbers on each row are the sides.`);
  push('Everything below is a suggestion: a disagreement can be a mistake, a fact that has moved on, or the most useful note in the folder.', '');

  const table = (rows) => {
    push('| Average | Sides | Newer | Older |', '|---|---|---|---|');
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

  if (res.unjudged || res.errors.length) push(`${n(res.unjudged)} pair${res.unjudged === 1 ? ' was' : 's were'} not judged because a request failed; run it again to ask only those.`, '');
  push('---', '', 'Generated by `sieve crosscheck`. Running it again asks only about notes that are new or edited.');
  return lines.join('\n') + '\n';
}

function writeReport(res, config, { today = new Date().toLocaleDateString('en-CA') } = {}) {
  fs.mkdirSync(res.reportsDir, { recursive: true });
  const file = path.join(res.reportsDir, `crosscheck-${today}.md`);
  fs.writeFileSync(file, buildReport(res, { today, linkFrom: { root: config.root, dir: res.reportsDir } }));
  return file;
}

// A contradiction is annotated on the newer note, where a pull request would have added it.
function githubAnnotations(res, root, { strict = false, cwd } = {}) {
  const where = (it) => `${it.path}:${it.line}`;
  const line = (cmd, f, word) => annotation(cmd, f.a, 'sieve: crosscheck', `${word} "${f.b.title}" (${where(f.b)}), ${pct(f.p)}: ${f.a.title}`, root, cwd);
  return [
    ...res.contradictions.map((f) => line(strict ? 'error' : 'warning', f, 'Contradicts')),
    ...res.review.map((f) => line('notice', f, 'May contradict')),
  ];
}

module.exports = {
  crosscheck, settingsFor, PairMemory, fingerprint, groupsOf, pairsOf, requestsFor, requestChars, estimate,
  verdicts, contested, buildReport, writeReport, githubAnnotations, DEFAULTS,
};
