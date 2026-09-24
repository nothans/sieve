// Filter in code before asking the model: cheaper, faster, and Jev never sees what it does
// not need to judge (docs: "Filter first; send only what the question needs").

function filterItems(corpus, { kind, since } = {}) {
  const kinds = kind ? new Set(String(kind).split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const from = since ? (String(since).length === 7 ? `${since}-01` : String(since)) : null;
  return corpus.filter((it) => (!kinds || kinds.has(it.kind)) && (!from || (it.date && it.date >= from)));
}

module.exports = { filterItems };
