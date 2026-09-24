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

const fill = (template, item) => String(template).split('{item}').join(item);

// Turn a lens spec from the config into { label, hint, build(item) }.
function buildLens(id, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`lens "${id}" must be an object`);
  if (!spec.question || !String(spec.question).includes('{item}')) throw new Error(`lens "${id}": question must include {item}`);
  const base = { id, label: spec.label || id, hint: spec.hint || '' };
  if (spec.type === 'noul') {
    const criteria = spec.true || spec.false ? { ...(spec.true ? { true: spec.true } : {}), ...(spec.false ? { false: spec.false } : {}) } : undefined;
    return { ...base, build: (item) => noul(fill(spec.question, item), criteria) };
  }
  if (spec.type === 'choice') {
    if (!spec.options || typeof spec.options !== 'object') throw new Error(`lens "${id}": a choice needs options`);
    return { ...base, options: Object.keys(spec.options), build: (item) => choice(fill(spec.question, item), spec.options) };
  }
  if (spec.type === 'score') {
    if (!Array.isArray(spec.levels)) throw new Error(`lens "${id}": a score needs levels`);
    return { ...base, build: (item) => score(fill(spec.question, item), spec.levels) };
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
    build: (item) => noul(`Does ${item} contain evidence or an argument against this claim: "${claim}"?`, {
      true: 'It reports facts or makes an argument that cuts against the claim.',
      false: 'It supports the claim, is neutral, or does not address it.',
    }),
  };
}

function describe(answer) {
  if (!answer) return 'error';
  if (answer.type === 'noul') return ''; // the rank value already is the probability
  if (answer.type === 'choice') return `${answer.choice} (${Math.round(answer.confidence * 100)}% conf.)`;
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
      input: Boolean(p.thesis !== undefined || p.claim),
      optional: p.thesis !== undefined,
      placeholder: p.thesis ? `${p.thesis} (default)` : '',
      answerAs: false,
      grouped: Boolean(p.group),
    };
  });
}

// Build a runnable preset: { id, title, lenses: {key: lens}, value(a), label(a), group?(a) }.
// Single-lens presets ask under the key "q".
function preset(config, id, { phrase, type, thesis } = {}, lenses = buildLenses(config.lenses)) {
  const single = (lens, extra = {}) => ({
    lenses: { q: lens },
    value: (a) => strength(a.q),
    label: (a) => describe(a.q),
    ...extra,
  });
  if (id === 'ask') {
    if (!phrase || !phrase.trim()) throw new Error('ask needs a phrase');
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
    return { id, title, ...single(lens, p.group ? { group: (a) => a.q.choice } : {}) };
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
    value: v,
    label: (a) => {
      if (!p.label) return '';
      const k = argmax(a);
      const via = p.label.via ? ` via ${p.label.via[k] || k}` : '';
      return `${p.label.choice ? a[p.label.choice].choice : ''}${via}`.trim();
    },
    ...(p.group ? { group: (a) => a[p.group]?.choice } : {}),
  };
}

module.exports = { buildLens, buildLenses, askLens, claimLens, preset, presetList, describe };
