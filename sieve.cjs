#!/usr/bin/env node
/*
 * Sieve: sift a whole folder of notes by any judgment, in seconds, for fractions of a cent.
 *
 * Every note (or section, or dated bullet, per the config) becomes an item. Jev, TypeSafe's
 * System One model, answers one typed question per item through OpenRouter, and Sieve ranks
 * the items by the answer.
 *
 * Usage:
 *   node sieve.cjs index                                  count items by kind
 *   node sieve.cjs ask "fables about greed" [--kind fable] [--since 2026-06] [--top 15]
 *   node sieve.cjs lens <preset>                          run a preset from the config
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
 *   --pack <n>       items per request (default 16; see README for the measured trade)
 *   --top <n>        rows to print (default 15)
 *   --json           machine-readable output
 *   --no-cache       ignore the answer cache
 *
 * Try it: node sieve.cjs ask "a clever animal outwits a stronger one" --config examples/aesop/sieve.config.json
 * Requires OPENROUTER_API_KEY (environment, or a .env here or in any parent folder).
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('./lib/jev.cjs');
const { buildCorpus } = require('./lib/corpus.cjs');
const { loadConfig, SIEVE_DIR } = require('./lib/config.cjs');
const { preset, buildLenses } = require('./lib/lenses.cjs');
const { siftMany, DEFAULT_PACK } = require('./lib/sift.cjs');
const { filterItems } = require('./lib/filter.cjs');

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

function report(jev, t0, n) {
  const s = jev.summary();
  process.stderr.write(`\n${n} items, ${s.requests} requests (${s.cached} cached, ${s.retries} retries, ${s.failures} failed), $${s.cost_usd.toFixed(4)}, ${((Date.now() - t0) / 1000).toFixed(1)} s, p50 ${s.latency_ms.p50 ?? '-'} ms\n`);
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

  const jev = createClient({ cacheFile: a['no-cache'] ? null : CACHE });
  const t0 = Date.now();
  const pack = Number(a.pack) || DEFAULT_PACK;

  if (cmd === 'ask' || cmd === 'lens') {
    const items = filterItems(corpus, a);
    const p = cmd === 'ask'
      ? preset(config, 'ask', { phrase: a._.slice(1).join(' '), type: a.type })
      : preset(config, a._[1], { thesis: a.thesis });
    const results = (await siftMany(jev, items, p.lenses, { pack }))
      .map((r) => ({ item: r.item, answers: r.answers, value: r.answers ? p.value(r.answers) : -1, label: r.answers ? p.label(r.answers) : r.error }))
      .sort((x, y) => y.value - x.value);
    const top = Number(a.top) || 15;
    if (a.json) console.log(JSON.stringify(results.slice(0, top).map((r) => ({ ...r.item, text: undefined, value: r.value, label: r.label, answers: r.answers })), null, 2));
    else printRanked(results, { top });
    report(jev, t0, items.length);
    return;
  }

  if (cmd === 'eval') {
    const { evaluate } = require('./lib/evaluate.cjs');
    const e = config.eval || {};
    if (!e.lens) throw new Error('this config has no "eval" section (see README)');
    const lens = buildLenses(config.lenses)[e.lens];
    if (!lens) throw new Error(`eval: no lens "${e.lens}"`);
    const packs = String(a.packs || '1,8,16,26').split(',').map(Number);
    const res = await evaluate(jev, corpus, lens, { packs, n: Number(a.n) || e.n || 240, kinds: e.kinds, strip: e.strip });
    if (a.json) { console.log(JSON.stringify(res, null, 2)); return; }
    console.log(`Eval of "${e.lens}": ${res.size} labeled items, label text stripped. Labels: ${JSON.stringify(res.labels)}`);
    for (const r of res.runs) {
      console.log(`\npack ${r.pack}: accuracy ${(r.accuracy * 100).toFixed(1)}%  top-2 ${(r.top2 * 100).toFixed(1)}%  ${r.requests} requests (${r.cached} cached)  $${r.cost_usd.toFixed(4)}  ${(r.ms / 1000).toFixed(1)} s  errors ${r.errors}`);
      for (const b of r.bands) console.log(`  confidence ${b.band}: ${String(b.n).padStart(3)} items (${(b.share * 100).toFixed(0)}%), accuracy ${b.accuracy == null ? '-' : (b.accuracy * 100).toFixed(1) + '%'}`);
      const worst = Object.entries(r.confusion).sort((x, y) => y[1] - x[1]).slice(0, 4);
      if (worst.length) console.log(`  most common misses: ${worst.map(([k, v]) => `${k} (${v})`).join(', ')}`);
    }
    report(jev, t0, res.size * packs.length);
    return;
  }

  if (cmd === 'route') {
    const { route } = require('./lib/route.cjs');
    const out = await route(jev, corpus, config, { since: a.since, pack });
    console.log(`wrote ${path.relative(process.cwd(), out.file)}`);
    report(jev, t0, out.n);
    return;
  }

  throw new Error(`unknown command "${cmd}" (index, ask, lens, eval, route, serve)`);
}

main().catch((err) => {
  process.stderr.write(`sieve: ${err.message}\n`);
  process.exit(1);
});
