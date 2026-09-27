// Lint: plain-English rules checked across the corpus, with an exit code for CI.
//
// A rule is a yes/no lens where "yes" means a problem ("Does {item} give a figure without its
// source?"). Every item a rule covers is asked; the probability sorts findings into fail, warn,
// or pass by the rule's thresholds, so the uncertain middle is flagged for a person instead of
// guessed. All rules that cover an item go in the same request (the state is read once).
//
// Configured under "lint" in sieve.config.json:
//   "lint": { "rules": [ { "id": "unsourced-figure", "lens": "unsourced", "kinds": ["insight"],
//                           "fail": 0.9, "warn": 0.6 } ] }
//
// `sieve lint --changed origin/main` checks only items in files that differ from that ref, which
// is what a pull-request check wants.

const path = require('path');
const { execFileSync } = require('child_process');
const { buildLenses } = require('./lenses.cjs');
const { siftMany } = require('./sift.cjs');

function rulesFor(config) {
  const rules = config.lint?.rules;
  if (!Array.isArray(rules) || !rules.length) throw new Error('this config has no "lint" rules (see README, "Lint")');
  const lenses = buildLenses(config.lenses);
  const ids = new Set();
  const unit = (x) => typeof x === 'number' && x >= 0 && x <= 1;
  return rules.map((r, i) => {
    const id = r.id || r.lens;
    if (!id) throw new Error(`lint rule ${i + 1} needs an "id" or a "lens"`);
    if (ids.has(id)) throw new Error(`lint rule "${id}" appears twice; give each rule its own "id"`);
    ids.add(id);
    const spec = config.lenses[r.lens];
    if (!spec) throw new Error(`lint rule "${id}": no lens "${r.lens}"`);
    if (spec.type !== 'noul') throw new Error(`lint rule "${id}": the lens must be a yes/no (noul) question where yes means a problem`);
    if (r.kinds !== undefined && !(Array.isArray(r.kinds) && r.kinds.length)) throw new Error(`lint rule "${id}": "kinds" must be a list, like ["insight"]`);
    const fail = r.fail ?? 0.9;
    const warn = r.warn ?? 0.6;
    if (!unit(fail) || !unit(warn)) throw new Error(`lint rule "${id}": "fail" and "warn" are probabilities between 0 and 1`);
    if (!(fail > warn)) throw new Error(`lint rule "${id}": "fail" must be above "warn"`);
    return { id, lens: lenses[r.lens], kinds: r.kinds ? new Set(r.kinds) : null, fail, warn, message: r.message || lenses[r.lens].label };
  });
}

// Files that differ from a git ref (committed or not) plus untracked files, relative to the
// corpus root. Everything else is skipped by `--changed`.
function changedFiles(root, ref) {
  // -z: raw, NUL-separated paths. Without it git quotes and escapes non-ASCII names ("caf\303\251.md"),
  // which would never match an item's path, and those files would silently skip the check.
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const diff = git(['diff', '-z', '--name-only', '--relative', ref, '--']);
    const untracked = git(['ls-files', '-z', '--others', '--exclude-standard']);
    return new Set(`${diff}\0${untracked}`.split('\0').filter(Boolean));
  } catch (err) {
    throw new Error(`--changed ${ref}: git could not compare against that ref (${String(err.stderr || err.message).trim().split('\n')[0]})`);
  }
}

async function lint(jev, corpus, config, { changed, pack, concurrency } = {}) {
  const rules = rulesFor(config);
  const only = changed ? changedFiles(config.root, changed) : null;
  const items = only ? corpus.filter((it) => only.has(it.path)) : corpus;

  // Items that share the same set of applicable rules go through one siftMany, so every rule an
  // item needs is asked in a single request.
  const bySet = new Map();
  for (const it of items) {
    const applies = rules.filter((r) => !r.kinds || r.kinds.has(it.kind));
    if (!applies.length) continue;
    const key = applies.map((r) => r.id).join('\n');
    if (!bySet.has(key)) bySet.set(key, { rules: applies, items: [] });
    bySet.get(key).items.push(it);
  }

  const findings = [];
  const errors = [];
  let checked = 0;
  for (const { rules: set, items: group } of bySet.values()) {
    const lensMap = Object.fromEntries(set.map((r, i) => [`r${i}`, r.lens]));
    const results = await siftMany(jev, group, lensMap, { pack, concurrency });
    for (const res of results) {
      checked++;
      if (!res.answers) { errors.push({ item: res.item, error: res.error }); continue; }
      set.forEach((r, i) => {
        const p = res.answers[`r${i}`]?.noul;
        if (typeof p !== 'number') return;
        const level = p >= r.fail ? 'fail' : p >= r.warn ? 'warn' : null;
        if (level) findings.push({ level, p, rule: r.id, message: r.message, item: res.item });
      });
    }
  }
  findings.sort((a, b) => (a.level === b.level ? b.p - a.p : a.level === 'fail' ? -1 : 1));
  return {
    rules: rules.map((r) => ({ id: r.id, fail: r.fail, warn: r.warn })),
    checked,
    skipped: items.length - checked, // items no rule covers
    changed: only ? [...only] : null,
    findings,
    errors,
    counts: { fail: findings.filter((f) => f.level === 'fail').length, warn: findings.filter((f) => f.level === 'warn').length, errors: errors.length },
  };
}

// GitHub Actions workflow commands: findings show up as annotations on the pull request's diff.
// GitHub resolves `file=` from the repository root, so paths are made relative to
// GITHUB_WORKSPACE (the checkout) rather than to whatever working directory the step uses.
function annotation(cmd, item, title, message, root, cwd = process.env.GITHUB_WORKSPACE || process.cwd()) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const file = path.relative(cwd, path.join(root, item.path)).split(path.sep).join('/');
  return `::${cmd} file=${escProp(file)},line=${item.line},title=${escProp(title)}::${esc(message)}`;
}

function githubAnnotations(result, root, cwd = process.env.GITHUB_WORKSPACE || process.cwd()) {
  const lines = result.findings.map((f) => annotation(f.level === 'fail' ? 'error' : 'warning', f.item, `sieve: ${f.rule}`, `${f.message} (${Math.round(f.p * 100)}%): ${f.item.title}`, root, cwd));
  for (const e of result.errors) lines.push(annotation('warning', e.item, 'sieve', `not checked: ${e.error}`, root, cwd));
  return lines;
}

module.exports = { lint, rulesFor, changedFiles, githubAnnotations, annotation };
