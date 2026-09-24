// Measure a choice lens against labels you already have.
//
// Sources can give each item a label (for example the file it was filed in: `"label":
// "filename"`). That filing is ground truth. `eval` strips anything that would give the answer
// away (config `eval.strip`, regexes), asks the lens, and compares. The same set runs at
// several pack sizes so the accuracy cost of packing is a measured number, not a guess.

const { sift } = require('./sift.cjs');

function stripLabels(text, patterns = []) {
  let t = text;
  for (const p of patterns) t = t.replace(new RegExp(p, 'gm'), '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function labeledSet(corpus, lens, { kinds, strip } = {}) {
  const options = new Set(lens.options || []);
  return corpus
    .filter((it) => (!kinds || kinds.includes(it.kind)) && it.label && options.has(it.label))
    .map((it) => ({ ...it, text: stripLabels(it.text, strip) }));
}

// Deterministic, label-balanced sample so repeated runs hit the answer cache and stay comparable.
function sample(items, n) {
  if (!n || n >= items.length) return items;
  const byLabel = {};
  for (const it of items) (byLabel[it.label] ||= []).push(it);
  const out = [];
  const labels = Object.keys(byLabel);
  for (let i = 0; out.length < n; i++) {
    const bucket = byLabel[labels[i % labels.length]];
    const pick = bucket[Math.floor(i / labels.length)];
    if (pick) out.push(pick);
    if (i > items.length * labels.length) break;
  }
  return out;
}

function score(results) {
  const rows = results.filter((r) => r.answer);
  const correct = (r) => r.answer.choice === r.item.label;
  const acc = rows.length ? rows.filter(correct).length / rows.length : 0;
  const bands = [[0.8, 1.01], [0.5, 0.8], [0, 0.5]].map(([lo, hi]) => {
    const inBand = rows.filter((r) => r.answer.confidence >= lo && r.answer.confidence < hi);
    return {
      band: `${lo.toFixed(1)}-${Math.min(hi, 1).toFixed(1)}`,
      n: inBand.length,
      share: rows.length ? inBand.length / rows.length : 0,
      accuracy: inBand.length ? inBand.filter(correct).length / inBand.length : null,
    };
  });
  // Does the second choice rescue the misses? A useful signal for "review" UIs.
  const top2 = rows.length ? rows.filter((r) => Object.entries(r.answer.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 2).some(([k]) => k === r.item.label)).length / rows.length : 0;
  const confusion = {};
  for (const r of rows.filter((r) => !correct(r))) {
    const k = `${r.item.label} -> ${r.answer.choice}`;
    confusion[k] = (confusion[k] || 0) + 1;
  }
  return { n: rows.length, errors: results.length - rows.length, accuracy: acc, top2, bands, confusion };
}

async function evaluate(jev, corpus, lens, { packs = [1, 8, 16, 26], n = 240, kinds, strip, concurrency = 16 } = {}) {
  if (!lens.options) throw new Error('eval needs a choice lens (config eval.lens)');
  const set = sample(labeledSet(corpus, lens, { kinds, strip }), n);
  if (!set.length) throw new Error('eval found no labeled items: give a source `"label": "filename"` (or "folder") whose values are options of the eval lens');
  const runs = [];
  for (const pack of packs) {
    const before = { ...jev.summary() };
    const t0 = Date.now();
    const results = await sift(jev, set, lens, { pack, concurrency });
    const after = jev.summary();
    runs.push({
      pack,
      ms: Date.now() - t0,
      requests: after.requests - before.requests,
      cached: after.cached - before.cached,
      cost_usd: after.cost_usd - before.cost_usd,
      ...score(results),
    });
  }
  const labels = {};
  for (const it of set) labels[it.label] = (labels[it.label] || 0) + 1;
  return { size: set.length, labels, runs };
}

module.exports = { evaluate, labeledSet, stripLabels, sample, score };
