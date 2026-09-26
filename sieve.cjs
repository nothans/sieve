#!/usr/bin/env node
/*
 * Sieve: sift a whole folder of notes by any judgment, in seconds, for fractions of a cent.
 *
 * Every note (or section, or dated bullet, per the config) becomes an item. Jev, TypeSafe's
 * System One model, answers the same typed question about every item (through OpenRouter, or a
 * compatible model on your own machine), and Sieve ranks the items by the answer.
 *
 * Usage:
 *   node sieve.cjs index                                  count items by kind
 *   node sieve.cjs ask "fables about greed" [--kind fable] [--since 2026-06] [--top 15]
 *   node sieve.cjs ask "A" --vs "B"                       compare two wordings of one question
 *   node sieve.cjs ask "A" --then "B" [--min 0.5]         ask B of only the items A matched
 *   node sieve.cjs lens <preset>                          run a preset from the config
 *   node sieve.cjs related "<title words or id>"          how every other item relates to one item
 *   node sieve.cjs lint [--changed origin/main]           check plain-English rules; exit 1 on a fail
 *   node sieve.cjs route                                  write the routing report
 *   node sieve.cjs eval [--n 240] [--packs 1,8,16,26]     measure a choice lens against your labels
 *   node sieve.cjs serve [--port 4177]                    the web UI
 *
 * Options:
 *   --config <file>  which sieve.config.json (default: local/sieve.config.json, then
 *                    ./sieve.config.json, or $SIEVE_CONFIG)
 *   --kind <k,k>     only these kinds
 *   --since <date>   only items dated on or after (YYYY-MM or YYYY-MM-DD)
 *   --type <t>       ask as noul (default) or score
 *   --thesis <text>  for a preset with a thesis: test this claim instead of the default
 *   --vs <text>      ask: a second wording, asked in the same request; shows where they differ
 *   --then <text>    ask: a follow-up question for the items that clear --min (default 0.5)
 *   --changed <ref>  lint: only items in files that differ from this git ref
 *   --format <f>     lint: text (default), json, or github (Actions annotations)
 *   --backend <id>   which backend from Settings (default: the active one; see local/settings.json)
 *   --pack <n>       items per request (default: the backend's setting)
 *   --concurrency <n> requests in flight (default: the backend's setting)
 *   --top <n>        rows to print (default 15)
 *   --json           machine-readable output
 *   --no-cache       ignore the answer cache
 *
 * Try it: node sieve.cjs ask "a clever animal outwits a stronger one" --config examples/aesop/sieve.config.json
 * Uses the active backend from Settings: Jev via OpenRouter by default, which needs OPENROUTER_API_KEY
 * (environment, or a .env here or in any parent folder), or a local /v1/systemone server.
 */

const fs = require('fs');
const path = require('path');
const backends = require('./lib/backends.cjs');
const { buildCorpus } = require('./lib/corpus.cjs');
const { loadConfig, SIEVE_DIR } = require('./lib/config.cjs');
const { preset, buildLenses, relatedPreset, rankOf } = require('./lib/lenses.cjs');
const { siftMany, DEFAULT_PACK } = require('./lib/sift.cjs');
const { filterItems } = require('./lib/filter.cjs');
const { MIN_CUT } = require('./lib/evaluate.cjs');

const CACHE = path.join(SIEVE_DIR, '.cache', 'answers.jsonl');

function parseArgs(argv) {
  const flags = new Set(['json', 'no-cache', 'help']);
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h') a.help = true;
    else if (t.startsWith('--')) {
      const key = t.slice(2);
      if (flags.has(key)) a[key] = true;
      else a[key] = argv[++i];
    } else a._.push(t);
  }
  return a;
}

function bar(p, width = 16) {
  const n = Math.round(Math.max(0, Math.min(1, p)) * width);
  return '#'.repeat(n) + '.'.repeat(width - n);
}

function printRanked(rows, { top = 15 } = {}) {
  for (const r of rows.slice(0, top)) {
    console.log(`${bar(Math.max(0, r.value))} ${r.value < 0 ? ' err' : r.value.toFixed(2)}  ${r.item.kind.padEnd(8)} ${r.item.date || '          '}  ${r.item.title.slice(0, 90)}`);
    console.log(`${' '.repeat(23)}${r.label}  ${r.item.path}:${r.item.line}`);
  }
}

function thresholdLine(t) {
  const pct = Math.round(t.target * 100);
  if (t.confidence != null) return `to be right ${pct}% of the time, act at confidence >= ${t.confidence.toFixed(2)}: covers ${Math.round(t.coverage * 100)}% of items (${(t.accuracy * 100).toFixed(1)}% right)`;
  if (t.small) return `${pct}%: the top ${t.small.n} answers (confidence >= ${t.small.confidence.toFixed(2)}) are ${(t.small.accuracy * 100).toFixed(1)}% right, but a threshold needs ${MIN_CUT}+ answers above it; label more items to set one`;
  if (t.n < MIN_CUT) return `${pct}%: only ${t.n} answers, too few to set a threshold (needs ${MIN_CUT}+); label more items`;
  return `no confidence level reaches ${pct}% accuracy on these items`;
}

function report(jev, t0, n) {
  const s = jev.summary();
  process.stderr.write(`\n${n} item${n === 1 ? '' : 's'}, ${s.requests} request${s.requests === 1 ? '' : 's'} (${s.cached} cached, ${s.retries} retries, ${s.failures} failed), $${s.cost_usd.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)} s, p50 ${s.latency_ms.p50 ?? '-'} ms\n`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.help || !cmd) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, ''));
    return;
  }
  const config = loadConfig(a.config);
  const corpus = buildCorpus(config);

  if (cmd === 'index') {
    const by = {};
    for (const it of corpus) by[it.kind] = (by[it.kind] || 0) + 1;
    const tokens = Math.round(corpus.reduce((n, it) => n + it.text.length, 0) / 4);
    if (a.json) console.log(JSON.stringify({ config: config.file, items: corpus.length, by, approx_tokens: tokens }, null, 2));
    else {
      console.log(`${config.name}: ${corpus.length} items, about ${tokens.toLocaleString()} tokens of state`);
      for (const [k, v] of Object.entries(by).sort((x, y) => y[1] - x[1])) console.log(`  ${k.padEnd(15)} ${v}`);
    }
    return;
  }

  if (cmd === 'serve') {
    require('./lib/server.cjs').serve({ config, corpus, port: Number(a.port) || 4177, cacheFile: a['no-cache'] ? null : CACHE });
    return;
  }

  const profile = backends.getProfile(backends.readSettings(), a.backend);
  const setup = backends.keyProblem(profile);
  if (setup) throw new Error(setup);
  const jev = await backends.clientFor(profile, { cacheFile: a['no-cache'] ? null : CACHE });
  process.stderr.write(`backend ${profile.id}: ${profile.model} at ${new URL(profile.baseUrl).host}${jev.servedRun ? ` (serving ${jev.servedRun})` : ''}
`);
  const t0 = Date.now();
  const pack = Number(a.pack) || profile.pack || DEFAULT_PACK;
  const concurrency = Number(a.concurrency) || profile.concurrency;

  // Run a preset over items and rank them: value, label, group per item, highest first.
  const rank = async (items, p) => (await siftMany(jev, items, p.lenses, { pack, concurrency, context: p.context }))
    .map((r) => ({ item: r.item, answers: r.answers, value: rankOf(p, r.answers), label: r.answers ? p.label(r.answers) : r.error, group: r.answers && p.group ? p.group(r.answers) : null }))
    .sort((x, y) => y.value - x.value);
  const top = Number(a.top) || 15;
  const output = (results, n) => {
    if (!a.json && results.some((r) => r.group)) {
      const counts = {};
      for (const r of results) if (r.group) counts[r.group] = (counts[r.group] || 0) + 1;
      process.stderr.write(`${Object.entries(counts).sort((x, y) => y[1] - x[1]).map(([g, k]) => `${g} ${k}`).join(' · ')}\n`);
    }
    if (a.json) console.log(JSON.stringify(results.slice(0, top).map((r) => ({ ...r.item, text: undefined, value: r.value, label: r.label, group: r.group, answers: r.answers })), null, 2));
    else printRanked(results, { top });
    report(jev, t0, n);
  };

  if (cmd === 'ask' || cmd === 'lens') {
    let items = filterItems(corpus, a);
    const phrase = a._.slice(1).join(' ');
    let p = cmd === 'ask'
      ? preset(config, 'ask', { phrase, type: a.type, vs: a.vs })
      : preset(config, a._[1], { thesis: a.thesis });
    let results = await rank(items, p);
    if (a.then) {
      const min = a.min != null ? Number(a.min) : 0.5;
      if (!(min >= 0 && min <= 1)) throw new Error('--min is a probability between 0 and 1, like 0.5');
      const kept = results.filter((r) => r.value >= min);
      process.stderr.write(`${kept.length} of ${results.length} items cleared ${Math.round(min * 100)}% on "${p.title}"; asking "${a.then}" of those\n`);
      p = preset(config, 'ask', { phrase: a.then, type: a.type });
      items = kept.map((r) => r.item);
      results = await rank(items, p);
    }
    output(results, items.length);
    return;
  }

  if (cmd === 'related') {
    const query = a._.slice(1).join(' ').trim();
    if (!query) throw new Error('related needs an item: part of its title, or its id from --json output');
    const anchor = findItem(corpus, query);
    process.stderr.write(`related to: ${anchor.title} (${anchor.path}:${anchor.line})\n`);
    const p = relatedPreset(anchor);
    const items = filterItems(corpus, a).filter((it) => it.id !== anchor.id);
    output(await rank(items, p), items.length);
    return;
  }

  if (cmd === 'lint') {
    const { lint, githubAnnotations } = require('./lib/lint.cjs');
    const res = await lint(jev, filterItems(corpus, a), config, { changed: a.changed, pack, concurrency });
    const format = a.json ? 'json' : a.format || 'text';
    if (format === 'json') console.log(JSON.stringify({ ...res, findings: res.findings.map((f) => ({ ...f, item: { ...f.item, text: undefined } })), errors: res.errors.map((e) => ({ ...e, item: { ...e.item, text: undefined } })) }, null, 2));
    else if (format === 'github') for (const line of githubAnnotations(res, config.root)) console.log(line);
    else {
      for (const f of res.findings) console.log(`${f.level.padEnd(4)}  ${String(Math.round(f.p * 100)).padStart(3)}%  ${f.rule}  ${f.item.path}:${f.item.line}  ${f.item.title.slice(0, 80)}`);
      for (const e of res.errors) console.log(`err         ${e.item.path}:${e.item.line}  not checked: ${e.error}`);
      const scope = res.changed ? `${res.checked} items in ${res.changed.length} changed files` : `${res.checked} items`;
      console.log(`\n${res.counts.fail} failed, ${res.counts.warn} to review, ${scope} checked against ${res.rules.map((r) => r.id).join(', ')}${res.skipped ? ` (${res.skipped} not covered by any rule)` : ''}`);
    }
    report(jev, t0, res.checked);
    if (res.counts.fail || res.counts.errors) process.exitCode = 1;
    return;
  }

  if (cmd === 'eval') {
    const { evaluate } = require('./lib/evaluate.cjs');
    const e = config.eval || {};
    if (!e.lens) throw new Error('this config has no "eval" section (see README)');
    const lens = buildLenses(config.lenses)[e.lens];
    if (!lens) throw new Error(`eval: no lens "${e.lens}"`);
    const packs = String(a.packs || (profile.pack > 1 ? '1,8,16,26' : '1')).split(',').map(Number);
    const res = await evaluate(jev, corpus, lens, { packs, n: Number(a.n) || e.n || 240, kinds: e.kinds, strip: e.strip, concurrency });
    if (a.json) { console.log(JSON.stringify(res, null, 2)); return; }
    console.log(`Eval of "${e.lens}": ${res.size} labeled items, label text stripped. Labels: ${JSON.stringify(res.labels)}`);
    for (const r of res.runs) {
      console.log(`\npack ${r.pack}: accuracy ${(r.accuracy * 100).toFixed(1)}%  top-2 ${(r.top2 * 100).toFixed(1)}%  ${r.requests} requests (${r.cached} cached)  $${r.cost_usd.toFixed(4)}  ${(r.ms / 1000).toFixed(1)} s  errors ${r.errors}`);
      if (r.withoutNone) console.log(`  "none" was picked ${r.withoutNone.noneChosen} times; best real option right ${(r.withoutNone.accuracy * 100).toFixed(1)}% of the time`);
      for (const t of r.thresholds) console.log(`  ${thresholdLine(t)}`);
      for (const b of r.bands) console.log(`  confidence ${b.band}: ${String(b.n).padStart(3)} items (${(b.share * 100).toFixed(0)}%), accuracy ${b.accuracy == null ? '-' : (b.accuracy * 100).toFixed(1) + '%'}`);
      const worst = Object.entries(r.confusion).sort((x, y) => y[1] - x[1]).slice(0, 4);
      if (worst.length) console.log(`  most common misses: ${worst.map(([k, v]) => `${k} (${v})`).join(', ')}`);
    }
    report(jev, t0, res.size * packs.length);
    return;
  }

  if (cmd === 'route') {
    const { route } = require('./lib/route.cjs');
    const out = await route(jev, corpus, config, { since: a.since, pack, concurrency });
    console.log(`wrote ${path.relative(process.cwd(), out.file)}`);
    report(jev, t0, out.n);
    return;
  }

  throw new Error(`unknown command "${cmd}" (index, ask, lens, related, lint, eval, route, serve)`);
}

// An item by id, or by words in its title (case-insensitive). Ambiguous words list the candidates.
function findItem(corpus, query) {
  const byId = corpus.find((it) => it.id === query);
  if (byId) return byId;
  const q = query.toLowerCase();
  const hits = corpus.filter((it) => it.title.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  const exact = hits.filter((it) => it.title.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  if (!hits.length) throw new Error(`no item's title contains "${query}"`);
  throw new Error(`"${query}" matches ${hits.length} items; be more specific or pass an id:\n${hits.slice(0, 8).map((it) => `  ${it.id}  ${it.title}`).join('\n')}`);
}

main().catch((err) => {
  process.stderr.write(`sieve: ${err.message}\n`);
  process.exit(1);
});
