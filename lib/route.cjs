// The routing report: where Jev thinks items belong, and what nothing links to yet.
//
// Up to three sections, each confidence-gated so a person reads the ambiguous cases, not all
// of them (configured under "route" in sieve.config.json):
//   1. Orphans      items of the file-level kinds that no link file mentions yet, grouped by the
//                   category Jev would file them under.
//   2. Hooks        items that clear a composite bar (the strongest of several yes/no angles)
//                   and are not yet mentioned in the given files, grouped by a choice lens.
//   3. Second looks labeled items Jev confidently files under a different category than the
//                   one they carry: misfiled, or genuinely cross-cutting.
//
// Jev decides; code does the bookkeeping (what is linked, what is new, the thresholds).

const fs = require('fs');
const path = require('path');
const { glob } = require('./glob.cjs');
const { buildLenses } = require('./lenses.cjs');
const { siftMany } = require('./sift.cjs');

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const readAll = (root, patterns = []) => patterns.flatMap((p) => glob(root, p)).map((f) => read(path.join(root, f))).join('\n');

// An item counts as linked when the text mentions its file by path or name, or (for a
// folder's README) the folder, or (for a file named like its folder) the folder name.
function isLinked(item, text) {
  const p = item.path;
  const base = path.posix.basename(p);
  const dir = path.posix.dirname(p);
  const needles = [p];
  if (/^readme\.md$/i.test(base)) needles.push(`${dir}/`);
  else needles.push(base);
  if (path.posix.basename(base, path.posix.extname(base)) === path.posix.basename(dir)) needles.push(path.posix.basename(dir));
  return needles.some((n) => n && n !== './' && text.includes(n));
}

const pct = (x) => `${Math.round(x * 100)}%`;
// Titles are quoted from other files; strip link-breaking brackets and normalize em dashes.
// `from` is { root, dir }: the corpus root and the report's folder, both absolute.
const href = (item, from) => path.relative(from.dir, path.join(from.root, item.path)).split(path.sep).join('/').replace(/ /g, '%20');
const link = (item, from) => `[${item.title.replace(/[[\]|]/g, '').replace(/\s*—\s*/g, ' - ')}](${href(item, from)}${item.line > 1 ? `#L${item.line}` : ''})`;
const top2 = (a) => Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 2);
const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}` : xs.join(''));

function buildReport({ results, route, linked, stats, today, since, linkFrom, lensLabels }) {
  const lines = [];
  const push = (...l) => lines.push(...l);
  const cat = route.category;
  const confident = route.confident ?? 0.8;
  const counts = {};

  push(`# ${route.title || 'Sieve routing report'}, ${today}`, '');
  const asked = Object.keys(route.lenses).map((k) => lensLabels[k] || k);
  push(`Jev (\`${stats.model}\`) read ${results.length} items${since ? ` dated ${since} or later` : ''} and answered ${asked.length} question${asked.length === 1 ? '' : 's'} about each (${list(asked)}).`);
  push(`It took ${stats.requests} requests (${stats.cached} answered from cache), ${(stats.ms / 1000).toFixed(1)} seconds, and $${stats.cost.toFixed(4)}.`);
  if (cat) push(`Confident means Jev's confidence is ${confident} or higher; run \`sieve eval\` to see how often answers at that level match your own labels.`);
  push('Everything below is a suggestion: file it, link it, or ignore it.', '');

  let section = 0;
  if (route.orphans && cat) {
    const kinds = new Set(route.orphans.kinds || []);
    const orphans = results.filter((r) => (!kinds.size || kinds.has(r.item.kind)) && r.answers && !isLinked(r.item, linked.all));
    counts.orphans = orphans.length;
    push(`## ${++section}. Orphans: nothing in the link files points here yet (${orphans.length})`, '');
    if (!orphans.length) push('None. Every item of these kinds is linked from at least one link file.', '');
    const byCat = {};
    for (const r of orphans) (byCat[r.answers[cat].choice] ||= []).push(r);
    // Largest category first; "none" last, since those are the items that need no filing.
    const order = ([a, x], [b, y]) => (a === 'none') - (b === 'none') || y.length - x.length;
    for (const [c, rows] of Object.entries(byCat).sort(order)) {
      push(c === 'none' ? `### ${route.noneLabel || 'No category'} (${rows.length})` : `### ${c} (${rows.length})`, '');
      push('| Item | Kind | Date | Jev | Runner-up |', '|---|---|---|---|---|');
      rows.sort((x, y) => y.answers[cat].confidence - x.answers[cat].confidence);
      for (const r of rows) {
        const a = r.answers[cat];
        const [, second] = top2(a);
        const tag = a.confidence >= confident ? `**${pct(a.confidence)}**` : `${pct(a.confidence)} (review)`;
        push(`| ${link(r.item, linkFrom)} | ${r.item.kind} | ${r.item.date || ''} | ${tag} | ${second ? `${second[0]} ${pct(second[1])}` : ''} |`);
      }
      push('');
    }
  }

  const hooks = route.hooks;
  if (hooks) {
    const angles = hooks.angles || {};
    const keys = Object.keys(angles);
    const kinds = new Set(hooks.kinds || []);
    const per = hooks.perGroup || 12;
    const found = results
      .filter((r) => r.answers && (!kinds.size || kinds.has(r.item.kind)))
      .map((r) => {
        const [angle, feeds] = keys.map((k) => [k, r.answers[k].noul]).sort((x, y) => y[1] - x[1])[0];
        return { ...r, angle, feeds };
      })
      .filter((r) => r.feeds >= (hooks.min ?? 0.6) && r.answers[hooks.choice].choice !== 'none' && !isLinked(r.item, linked.hooks))
      .sort((x, y) => y.feeds - x.feeds);
    counts.hooks = found.length;
    push(`## ${++section}. ${hooks.title || 'Hooks'} (${found.length})`, '');
    push(`Items that feed ${hooks.about || 'the topic'}: at least ${pct(hooks.min ?? 0.6)} on one of ${keys.length} yes/no angles (${list(keys.map((k) => angles[k]))}), filed under the ${lensLabels[hooks.choice] ? lensLabels[hooks.choice].toLowerCase() : 'choice'} Jev picks.`);
    push('Newest first within each group.', '');
    const byGroup = {};
    for (const r of found) (byGroup[r.answers[hooks.choice].choice] ||= []).push(r);
    for (const g of Object.keys(byGroup).sort()) {
      push(`### ${g} (${byGroup[g].length})`, '');
      for (const r of byGroup[g].sort((x, y) => (y.item.date || '').localeCompare(x.item.date || '')).slice(0, per)) {
        push(`- ${link(r.item, linkFrom)} (${r.item.kind}, ${r.item.date || 'undated'}): ${angles[r.angle]} ${pct(r.feeds)}, this ${(lensLabels[hooks.choice] || "group").toLowerCase()} ${pct(r.answers[hooks.choice].probabilities[g])}.`);
      }
      if (byGroup[g].length > per) push(`- ...and ${byGroup[g].length - per} more.`);
      push('');
    }
  }

  if (route.secondLooks && cat) {
    const kinds = new Set(route.secondLooks.kinds || []);
    const min = route.secondLooks.min ?? 0.9;
    const looks = results
      .filter((r) => r.answers && r.item.label && (!kinds.size || kinds.has(r.item.kind)))
      .filter((r) => r.answers[cat].choice !== r.item.label && r.answers[cat].choice !== 'none' && r.answers[cat].confidence >= min)
      .sort((x, y) => y.answers[cat].confidence - x.answers[cat].confidence);
    counts.secondLooks = looks.length;
    push(`## ${++section}. Second looks: filed under one category, Jev is sure it is another (${looks.length})`, '');
    push(`Items where Jev is at least ${pct(min)} confident of a different category than the one they carry.`);
    push('Some are misfiled; most are cross-cutting and worth a cross-link.', '');
    if (!looks.length) push('None.', '');
    else {
      push('| Entry | Filed under | Jev says |', '|---|---|---|');
      for (const r of looks) push(`| ${link(r.item, linkFrom)} | ${r.item.label} | ${r.answers[cat].choice} ${pct(r.answers[cat].confidence)} |`);
      push('');
    }
  }

  push('---', '', `Generated by \`sieve route${since ? ` --since ${since}` : ''}\`. Re-running is cheap: unchanged items come from the answer cache.`);
  return { markdown: lines.join('\n') + '\n', counts };
}

async function route(jev, corpus, config, { since, pack, today = new Date().toLocaleDateString('en-CA') } = {}) {
  const r = config.route;
  if (!r || !r.lenses) throw new Error('this config has no "route" section (see README)');
  const all = buildLenses(config.lenses);
  const lensMap = Object.fromEntries(Object.entries(r.lenses).map(([alias, id]) => {
    if (!all[id]) throw new Error(`route: no lens "${id}"`);
    return [alias, all[id]];
  }));
  const lensLabels = Object.fromEntries(Object.entries(r.lenses).map(([alias, id]) => [alias, all[id].label]));
  const from = since ? (since.length === 7 ? `${since}-01` : since) : null;
  const skip = new Set(r.skipKinds || []);
  const items = corpus.filter((it) => !skip.has(it.kind) && (!from || (it.date && it.date >= from)));
  const before = jev.summary();
  const t0 = Date.now();
  const results = await siftMany(jev, items, lensMap, { pack });
  const after = jev.summary();
  const stats = {
    model: jev.model, requests: after.requests - before.requests, cached: after.cached - before.cached,
    cost: after.cost_usd - before.cost_usd, ms: Date.now() - t0,
  };
  const linked = {
    all: readAll(config.root, r.orphans?.linkFiles),
    hooks: readAll(config.root, r.hooks?.notLinkedIn),
  };
  fs.mkdirSync(r.reportsDir, { recursive: true });
  const file = path.join(r.reportsDir, `route-${today}.md`);
  const { markdown, counts } = buildReport({ results, route: r, linked, stats, today, since: from, linkFrom: { root: config.root, dir: r.reportsDir }, lensLabels });
  fs.writeFileSync(file, markdown);
  return { file, n: items.length, counts, results };
}

module.exports = { route, buildReport, isLinked };
