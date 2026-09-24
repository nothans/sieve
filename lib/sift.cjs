// Run lenses over many items and rank them.
//
// Two ways to ask:
//   pack = 1   one request per item; the item is the whole state.
//   pack = n   n items share one request as { items: { a, b, ... } }, one question per item
//              per lens. Far fewer requests, which keeps a full-corpus sift under the
//              1,200 requests/minute limit and cuts the per-request overhead.
// `node sieve.cjs eval` measures the accuracy of each against labels you already have (README).
//
// Several lenses in one call are the docs' "speculative fan-out": the state is read once and
// every question is answered against it in parallel.

const { strength } = require('./jev.cjs');

const SLOTS = 'abcdefghijklmnopqrstuvwxyz';
const DEFAULT_PACK = 16;

// What Jev sees of an item. Title and kind help it; paths and ids would only distract.
function view(item) {
  return { kind: item.kind, title: item.title, date: item.date, text: item.text };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// lensMap: { name: lens }. Question ids are "<slot>.<lens>" packed, "<lens>" alone.
function requestFor(group, lensMap) {
  const names = Object.keys(lensMap);
  if (group.length === 1) {
    return {
      state: view(group[0]),
      questions: Object.fromEntries(names.map((n) => [n, lensMap[n].build('this item')])),
    };
  }
  const items = {};
  const questions = {};
  group.forEach((it, k) => {
    const slot = SLOTS[k];
    items[slot] = view(it);
    for (const n of names) questions[`${slot}.${n}`] = lensMap[n].build(`\`items.${slot}\``);
  });
  return { state: { items }, questions };
}

function answersFor(res, group, k, names) {
  if (res.error) return null;
  const prefix = group.length === 1 ? '' : `${SLOTS[k]}.`;
  return Object.fromEntries(names.map((n) => [n, res.answers[prefix + n]]));
}

// target: for a choice lens, rank by the probability of this option instead of confidence
function rankValue(answer, target) {
  if (!answer) return -1;
  if (target && answer.type === 'choice') return answer.probabilities?.[target] ?? 0;
  const s = strength(answer);
  return Number.isFinite(s) ? s : -1;
}

// Every item comes back once, with an `answers` map keyed by lens name.
async function siftMany(jev, items, lensMap, { pack = DEFAULT_PACK, concurrency = 16, onResult } = {}) {
  const names = Object.keys(lensMap);
  const size = Math.max(1, Math.min(pack, SLOTS.length));
  const groups = chunk(items, size);
  const results = [];
  await jev.map(groups, (g) => requestFor(g, lensMap), {
    concurrency,
    onResult: (res, gi, group) => {
      const batch = group.map((item, k) => ({
        item,
        answers: answersFor(res, group, k, names),
        error: res.error || null,
        cached: Boolean(res.cached),
      }));
      results.push(...batch);
      if (onResult) onResult(batch);
    },
  });
  return results;
}

// One lens, ranked by its answer.
async function sift(jev, items, lens, { target, onResult, ...opts } = {}) {
  const shape = (r) => ({ item: r.item, answer: r.answers?.q ?? null, value: rankValue(r.answers?.q, target), error: r.error, cached: r.cached });
  const results = (await siftMany(jev, items, { q: lens }, {
    ...opts,
    onResult: onResult && ((batch) => onResult(batch.map(shape))),
  })).map(shape);
  results.sort((x, y) => y.value - x.value);
  return results;
}

module.exports = { sift, siftMany, requestFor, rankValue, view, SLOTS, DEFAULT_PACK };
