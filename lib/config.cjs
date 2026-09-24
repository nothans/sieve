// Load and check a sieve.config.json. Paths inside it (root, reportsDir) are relative to the
// config file, so a config can live next to its corpus or in local/ pointing elsewhere.

const fs = require('fs');
const path = require('path');

const SIEVE_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIGS = [path.join(SIEVE_DIR, 'local', 'sieve.config.json'), path.join(SIEVE_DIR, 'sieve.config.json')];

function findConfig(explicit) {
  const chosen = explicit || process.env.SIEVE_CONFIG;
  if (chosen) return path.resolve(chosen);
  const found = DEFAULT_CONFIGS.find((f) => fs.existsSync(f));
  if (found) return found;
  throw new Error('no config found. Pass --config <file>, or try the demo: --config examples/aesop/sieve.config.json (see README, "Point it at your own notes").');
}

function loadConfig(file) {
  const abs = findConfig(file);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read config ${abs}: ${err.message}`);
  }
  const dir = path.dirname(abs);
  config.file = abs;
  config.dir = dir;
  config.root = path.resolve(dir, config.root || '.');
  config.name ||= path.basename(config.root);
  if (!Array.isArray(config.sources) || !config.sources.length) throw new Error(`${abs}: "sources" must list at least one source`);
  for (const [i, s] of config.sources.entries()) {
    if (!s.kind) throw new Error(`${abs}: source ${i + 1} needs a "kind"`);
    if (!s.glob) throw new Error(`${abs}: source "${s.kind}" needs a "glob"`);
  }
  config.lenses ||= {};
  for (const p of config.presets || []) {
    if (p.lens && !config.lenses[p.lens]) throw new Error(`${abs}: preset "${p.id}" uses unknown lens "${p.lens}"`);
    for (const l of Object.values(p.lenses || {})) if (!config.lenses[l]) throw new Error(`${abs}: preset "${p.id}" uses unknown lens "${l}"`);
  }
  if (config.route) config.route.reportsDir = path.resolve(dir, config.route.reportsDir || 'reports');
  return config;
}

// Display names for kinds, for the UI chips and reports.
function kindLabels(config) {
  const out = {};
  for (const s of config.sources) {
    out[s.kind] ||= s.display || s.kind;
    if (s.counterKind) out[s.counterKind] ||= s.counterDisplay || s.counterKind;
  }
  return out;
}

module.exports = { loadConfig, findConfig, kindLabels, SIEVE_DIR };
