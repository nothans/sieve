// Lenses and presets: the typed questions Sieve asks of every item.
//
// A lens is one Jev question with a placeholder, {item}, for "the item". Sieve fills it with
// "this item" when each request carries one item, or with a pointer like `items.c` when
// several items share one request (packing). Lenses are declared in the config; see
// examples/*/sieve.config.json and the README for the format.
//
// A preset is what a user picks: one or more lenses asked together per item, reduced to a
// rank value (and a short label, and optionally a group) in code.

const { noul, choice, score, strength } = require('./jev.cjs');
const { view } = require('./sift.cjs');

const fill = (template, item) => String(template).split('{item}').join(item);
const trimDot = (s) => String(s).replace(/\.$/, '');

// Turn a lens spec from the config into { label, hint, build(item) }.
function buildLens(id, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`lens "${id}" must be an object`);
  if (!spec.question || !String(spec.question).includes('{item}')) throw new Error(`lens "${id}": question must include {item}`);
  const base = { id, type: spec.type, label: spec.label || id, hint: spec.hint || '' };
  if (spec.type === 'noul') {
    const criteria = spec.true || spec.false ? { ...(spec.true ? { true: spec.true } : {}), ...(spec.false ? { false: spec.false } : {}) } : undefined;
    return { ...base, meaning: 'The chance the answer to the question is yes.', build: (item) => noul(fill(spec.question, item), criteria) };
  }
  if (spec.type === 'choice') {
    if (!spec.options || typeof spec.options !== 'object') throw new Error(`lens "${id}": a choice needs options`);
    return { ...base, options: Object.keys(spec.options), meaning: 'How sure the model is of the pick shown on each row.', build: (item) => choice(fill(spec.question, item), spec.options) };
  }
  if (spec.type === 'score') {
    if (!Array.isArray(spec.levels)) throw new Error(`lens "${id}": a score needs levels`);
    return { ...base, levels: spec.levels, meaning: `Where each item sits on the scale: 0% is "${trimDot(spec.levels[0])}", 100% is "${trimDot(spec.levels[spec.levels.length - 1])}".`, build: (item) => score(fill(spec.question, item), spec.levels) };
  }
  throw new Error(`lens "${id}": type must be noul, choice, or score`);
}

function buildLenses(specs = {}) {
  return Object.fromEntries(Object.entries(specs).map(([id, spec]) => [id, buildLens(id, spec)]));
}

// A free-form lens from a phrase typed into the search box.
// Jev reads literally (docs: "Literal reading"), so the phrase is quoted verbatim and the
// criteria say what counts as a match, including the boundary case of a passing mention.
function askLens(phrase, type = 'noul') {
  const p = phrase.trim().replace(/[?.]+$/, '');
  if (type === 'score') {
    return {
      label: p,
      type: 'score',
      meaning: 'How closely each item matches: 0% is unrelated, 33% touches it in passing, 67% clearly relevant, 100% squarely about it.',
      build: (item) => score(`How closely does ${item} match this description: "${p}"?`, [
        'Unrelated.',
        'Touches it in passing.',
        'Clearly relevant, but not the main subject.',
        'Squarely about it.',
      ]),
    };
  }
  return {
    label: p,
    type: 'noul',
    meaning: `The chance each item is substantially about "${p}".`,
    build: (item) => noul(`Does ${item} match this description: "${p}"?`, {
      true: `The item is substantially about "${p}".`,
      false: 'The item is about something else, or mentions it only in passing.',
    }),
  };
}

// Evidence against a claim someone types. "Evidence against X" is a hop of indirection, which
// Jev handles less well than a concrete question (docs: "Indirection"), so a config can give
// its counter preset a concrete default lens and use this only for typed claims.
function claimLens(claim) {
  return {
    label: `Against: ${claim}`,
    type: 'noul',
    meaning: `The chance each item holds evidence or an argument against "${claim}".`,
    build: (item) => noul(`Does ${item} contain evidence or an argument against this claim: "${claim}"?`, {
      true: 'It reports facts or makes an argument that cuts against the claim.',
      false: 'It supports the claim, is neutral, or does not address it.',
    }),
  };
}

// How an item relates to one anchor item, as a stance rather than a similarity score. The anchor
// rides along in every request's state (sift's `context`), so this works packed or one by one,
// and no embeddings or index are needed: "more like this" is just another typed question.
const RELATIONS = {
  same: 'Makes the same main point as `anchor`, or reports the same event.',
  supports: "A different item that backs up `anchor`'s main point with its own evidence or example.",
  contradicts: "Disagrees with `anchor`, or reports facts that cut against its main point.",
  topic: 'Same broad topic as `anchor`, but a different point.',
  unrelated: 'A different topic.',
};
// Rank: a shared point, evidence, or a rebuttal counts fully; a merely shared topic counts half.
const relatedness = (a) => (a ? (a.probabilities.same ?? 0) + (a.probabilities.supports ?? 0) + (a.probabilities.contradicts ?? 0) + 0.5 * (a.probabilities.topic ?? 0) : -1);

// The relation to show for an item. When "unrelated" is the single likeliest option but the other
// four together still make the item at least half related, name the likeliest of those instead,
// so an item ranked as related is never filed under "unrelated".
function relationOf(a) {
  if (!a?.probabilities) return null;
  if (a.choice !== 'unrelated' || relatedness(a) < 0.5) return a.choice;
  return Object.entries(a.probabilities).filter(([k]) => k !== 'unrelated').sort((x, y) => y[1] - x[1])[0][0];
}

function relatedLens() {
  return { label: 'Relation', build: (item) => choice(`How does ${item} relate to \`anchor\`?`, RELATIONS) };
}

function relatedPreset(anchor) {
  return {
    id: 'related',
    title: `Related to: ${anchor.title}`,
    lenses: { q: relatedLens() },
    context: { anchor: view(anchor) },
    exclude: anchor.id,
    meaning: 'How closely each item connects to this one: the same point, support, or a contradiction counts fully; only a shared topic counts half.',
    value: (a) => relatedness(a.q),
    label: (a) => relationOf(a.q) ?? 'error',
    group: (a) => relationOf(a.q),
  };
}

// Two wordings of one question, asked in the same request (the state is read once, so the second
// wording is nearly free). Grouped by where they agree, so you can see what each wording adds.
function comparePreset(phrase, vs, type) {
  const a = askLens(phrase, type);
  const b = askLens(vs, type);
  return {
    id: 'ask',
    title: `"${a.label}" vs "${b.label}"`,
    lenses: { a, b },
    meaning: 'The higher of the two chances; each row shows A (the first wording) and B (the second).',
    value: (x) => Math.max(strength(x.a), strength(x.b)),
    label: (x) => `A ${Math.round(strength(x.a) * 100)}% · B ${Math.round(strength(x.b) * 100)}%`,
    group: (x) => {
      const ya = strength(x.a) >= 0.5;
      const yb = strength(x.b) >= 0.5;
      return ya && yb ? 'both' : ya ? 'only A' : yb ? 'only B' : 'neither';
    },
  };
}

// A preset's rank value for one item, or -1 when there is nothing to rank by: a failed request, or
// a model that left a question unanswered (a packed slot a local server skipped gives NaN).
function rankOf(p, answers) {
  if (!answers) return -1;
  const v = p.value(answers);
  return Number.isFinite(v) ? v : -1;
}

function describe(answer) {
  if (!answer) return 'error';
  if (answer.type === 'noul') return ''; // the rank value already is the probability
  if (answer.type === 'choice') return answer.choice; // the rank value is already its confidence
  return answer.legend?.[String(Math.round(answer.score))] ?? answer.score.toFixed(2);
}

// The presets a config offers, in order. "ask" is built in; list it to control its position.
function presetList(config) {
  const list = config.presets && config.presets.length ? config.presets : [{ id: 'ask' }];
  return list.map((p) => {
    if (p.id === 'ask') return { id: 'ask', title: p.title || 'Ask anything', hint: p.hint || 'Type what you are looking for in plain words. Each item is asked whether it matches; results rank by that probability.', input: true, answerAs: true, grouped: false };
    const lens = p.lens ? config.lenses?.[p.lens] : null;
    return {
      id: p.id,
      title: p.title || lens?.label || p.id,
      hint: p.hint || lens?.hint || '',
      input: p.thesis !== undefined,
      optional: p.thesis !== undefined,
      placeholder: p.thesis ? `${p.thesis} (default)` : '',
      answerAs: false,
      grouped: Boolean(p.group),
      ...preview(p, config.lenses || {}),
    };
  });
}

// What a preset will ask, for the page to show before anything is spent: the question itself, and
// the options or scale levels the model picks from.
function preview(p, specs) {
  const ask = (spec) => String(spec.question).split('{item}').join('this item');
  if (p.lens) {
    const spec = specs[p.lens] || {};
    return {
      asks: [ask(spec)],
      ...(spec.type === 'choice' ? { choices: Object.keys(spec.options || {}) } : {}),
      ...(spec.type === 'score' ? { levels: (spec.levels || []).map(trimDot) } : {}),
    };
  }
  return { asks: Object.values(p.lenses || {}).map((id) => specs[id]).filter(Boolean).map(ask) };
}

// Build a runnable preset: { id, title, lenses: {key: lens}, value(a), label(a), group?(a) }.
// Single-lens presets ask under the key "q".
function preset(config, id, { phrase, type, thesis, vs } = {}, lenses = buildLenses(config.lenses)) {
  const single = (lens, extra = {}) => ({
    lenses: { q: lens },
    meaning: lens.meaning || '',
    value: (a) => strength(a.q),
    label: (a) => describe(a.q),
    ...extra,
  });
  if (id === 'ask') {
    if (!phrase || !phrase.trim()) throw new Error('ask needs a phrase');
    if (vs && vs.trim()) return comparePreset(phrase, vs, type);
    return { id, title: phrase.trim(), ...single(askLens(phrase, type)) };
  }
  const p = (config.presets || []).find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset "${id}" (${['ask', ...(config.presets || []).map((x) => x.id).filter((x) => x !== 'ask')].join(', ')})`);

  if (p.lens) {
    const typed = thesis && thesis.trim();
    if (p.thesis !== undefined && typed) return { id, title: `Against: ${typed}`, ...single(claimLens(typed)) };
    const lens = lenses[p.lens];
    if (!lens) throw new Error(`preset "${id}": no lens "${p.lens}"`);
    const title = p.thesis ? `Against: ${p.thesis}` : p.title || lens.label;
    return { id, title, ...single(lens, p.group ? { group: (a) => a.q?.choice ?? null } : {}) };
  }

  // Composite: several lenses under aliases, reduced by `value`, labelled by `label`.
  if (!p.lenses) throw new Error(`preset "${id}" needs "lens" or "lenses"`);
  const keyed = Object.fromEntries(Object.entries(p.lenses).map(([alias, lensId]) => {
    if (!lenses[lensId]) throw new Error(`preset "${id}": no lens "${lensId}"`);
    return [alias, lenses[lensId]];
  }));
  const maxOf = p.value?.max || Object.keys(keyed);
  const v = (a) => Math.max(...maxOf.map((k) => strength(a[k])));
  const argmax = (a) => [...maxOf].sort((x, y) => strength(a[y]) - strength(a[x]))[0];
  return {
    id,
    title: p.title || id,
    lenses: keyed,
    meaning: `The strongest of ${maxOf.length} yes/no angles, each asked separately.`,
    value: v,
    label: (a) => {
      if (!p.label) return '';
      const k = argmax(a);
      const via = p.label.via ? ` via ${p.label.via[k] || k}` : '';
      return `${p.label.choice ? a[p.label.choice]?.choice ?? '' : ''}${via}`.trim();
    },
    ...(p.group ? { group: (a) => a[p.group]?.choice } : {}),
  };
}

module.exports = { buildLens, buildLenses, askLens, claimLens, relatedLens, relatedPreset, comparePreset, RELATIONS, preset, presetList, describe, rankOf };
