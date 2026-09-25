// Backends: where Sieve sends its typed questions.
//
// Every backend speaks the same request shape ({ model, state, questions } in, { answers } out):
// Jev through OpenRouter, Jev direct from TypeSafe, or any local /v1/systemone server (Kev, Laya,
// openjev, ...). A backend is a profile: URL, model, which environment variable holds its key,
// and how hard to drive it (items per request, requests in flight, timeout). A laptop CPU running
// Kev wants 1 item and 1-2 requests at a time; Jev on OpenRouter is happy with 16 and 16.
//
// Profiles live in local/settings.json (never the key itself: only the NAME of the environment
// variable that holds it, so a settings file can never leak a secret).

const fs = require('fs');
const path = require('path');
const { createClient, noul, loadEnv } = require('./jev.cjs');
const { SIEVE_DIR } = require('./config.cjs');

loadEnv(); // so the Settings page can say whether each key variable is set
const SETTINGS_FILE = process.env.SIEVE_SETTINGS || path.join(SIEVE_DIR, 'local', 'settings.json');

const BUILTIN = [
  {
    id: 'openrouter', label: 'Jev via OpenRouter', kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13',
    keyEnv: 'OPENROUTER_API_KEY', pack: 16, concurrency: 16, timeoutMs: 30000,
  },
  {
    id: 'typesafe', label: 'Jev via TypeSafe', kind: 'typesafe',
    baseUrl: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest',
    keyEnv: 'TYPESAFE_API_KEY', pack: 16, concurrency: 16, timeoutMs: 30000,
  },
  {
    id: 'local', label: 'Local server (Kev, Laya, ...)', kind: 'local',
    baseUrl: 'http://127.0.0.1:8009/v1/systemone', model: 'kev-latest',
    keyEnv: '', pack: 1, concurrency: 1, timeoutMs: 300000,
  },
];

const LIMITS = { pack: [1, 26], concurrency: [1, 32], timeoutMs: [1000, 1800000] };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

function clampInt(v, [lo, hi], fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// Check one profile from the settings file or the UI. Throws with a message a person can act on.
function normalizeProfile(p, base = {}) {
  const out = { ...base, ...p };
  if (!ID_RE.test(out.id || '')) throw new Error('a backend id is lowercase letters, digits, and dashes');
  let url;
  try { url = new URL(out.baseUrl); } catch (_) { throw new Error(`"${out.baseUrl}" is not a URL`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('the backend URL must be http or https');
  // A key over plain http would travel in the clear; only allow http for this machine.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !loopback) throw new Error('use https for anything that is not on this machine');
  if (!out.model || typeof out.model !== 'string') throw new Error('a backend needs a model name');
  if (out.keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(out.keyEnv)) throw new Error('the key variable is an environment variable NAME, like OPENROUTER_API_KEY');
  return {
    id: out.id,
    label: String(out.label || out.id).slice(0, 60),
    kind: out.kind || 'custom',
    baseUrl: url.toString(),
    model: out.model.slice(0, 120),
    keyEnv: out.keyEnv || '',
    pack: clampInt(out.pack, LIMITS.pack, 16),
    concurrency: clampInt(out.concurrency, LIMITS.concurrency, 8),
    timeoutMs: clampInt(out.timeoutMs, LIMITS.timeoutMs, 30000),
  };
}

function readSettings(file = SETTINGS_FILE) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first run, or unreadable: defaults */ }
  const byId = new Map(BUILTIN.map((b) => [b.id, { ...b, builtin: true }]));
  for (const p of saved.backends || []) {
    try {
      const base = byId.get(p.id) || {};
      byId.set(p.id, { ...normalizeProfile(p, base), builtin: Boolean(base.builtin) });
    } catch (_) { /* a hand-edited bad profile is skipped, not fatal */ }
  }
  const backends = [...byId.values()];
  const active = backends.some((b) => b.id === saved.active) ? saved.active : 'openrouter';
  return { active, backends };
}

function writeSettings(settings, file = SETTINGS_FILE) {
  const clean = {
    active: settings.active,
    backends: settings.backends.map(({ builtin, ...p }) => normalizeProfile(p)),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2) + '\n');
  return readSettings(file);
}

function getProfile(settings, id) {
  const p = settings.backends.find((b) => b.id === (id || settings.active));
  if (!p) throw new Error(`unknown backend "${id}" (${settings.backends.map((b) => b.id).join(', ')})`);
  return p;
}

// What the UI may see about a profile: everything but secrets, plus whether its key is present.
function publicProfile(p) {
  return { ...p, keySet: p.keyEnv ? Boolean(process.env[p.keyEnv]) : null };
}

// Local servers can swap checkpoints behind one model name; ask what is actually loaded so the
// answer cache never mixes Kev-4B and Kev-0.8B answers. Best effort: silent on failure.
async function servedRun(p, fetchImpl = globalThis.fetch) {
  if (p.kind === 'openrouter' || p.kind === 'typesafe') return '';
  try {
    const url = new URL('/v1/models', p.baseUrl);
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    const m = (j.models || []).find((x) => x.name === p.model) || (j.models || [])[0];
    return m ? String(m.run || m.name || '') : '';
  } catch (_) {
    return '';
  }
}

// Scope the answer cache by where answers came from. Jev via OpenRouter keeps the unscoped key,
// so every answer already cached stays valid.
function cacheScope(p, run) {
  if (p.kind === 'openrouter') return '';
  return `${p.baseUrl}|${run || ''}`;
}

async function clientFor(p, { cacheFile, fetchImpl } = {}) {
  const run = await servedRun(p, fetchImpl);
  const client = createClient({
    baseUrl: p.baseUrl,
    model: p.model,
    keyName: p.keyEnv || 'NO_KEY',
    requireKey: Boolean(p.keyEnv),
    timeoutMs: p.timeoutMs,
    cacheFile,
    cacheScope: cacheScope(p, run),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return Object.assign(client, { profile: p, servedRun: run });
}

// One small real request, uncached, so "Test" means the backend answered just now.
async function probe(p, { fetchImpl } = {}) {
  const t0 = Date.now();
  const client = await clientFor(p, { fetchImpl });
  const res = await client.decide(
    'The build is red again. Third time today.',
    { frustrated: noul('Is the writer frustrated?') },
    { cache: false },
  );
  return {
    ok: true,
    ms: Date.now() - t0,
    model: res.model || p.model,
    served: client.servedRun || null,
    noul: res.answers?.frustrated?.noul,
    cost: res.usage?.cost ?? null,
  };
}

module.exports = {
  BUILTIN, SETTINGS_FILE, readSettings, writeSettings, normalizeProfile, getProfile, publicProfile,
  clientFor, probe, cacheScope, servedRun,
};
