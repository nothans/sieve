#!/usr/bin/env node
/*
 * Jev via OpenRouter. Typed decisions (noul, choice, score) with calibrated probabilities.
 *
 * Jev is TypeSafe's "System One" model: you send a state and typed questions, it sends back
 * typed answers with probabilities. It never writes text. That makes it the right call for
 * routing, triage, tagging, gating, and verification, and the wrong call for anything that
 * needs a sentence back. Billed on input tokens only (~$0.042/M); output is free.
 *
 * Usage (CLI):
 *   node lib/jev.cjs noul "Is the writer frustrated?" --state "The build is red again."
 *   node lib/jev.cjs choice "Which team owns this?" billing="Payments, refunds" tech="Bugs" --state-file ticket.txt
 *   node lib/jev.cjs score "How urgent?" "Can wait" "This week" "Blocking revenue" --state -
 *   node lib/jev.cjs ask --request request.json            (full {state, questions})
 *   node lib/jev.cjs batch --in items.jsonl --questions q.json --out results.jsonl
 *
 * Common options:
 *   --state <text> | --state-file <path> | --state -   The state to judge (stdin with -)
 *   --model <id>        typesafe/jev-1.13 (default, pinned) | ~typesafe/jev-latest
 *   --true/--false <d>  Noul criteria: what a yes and a no mean
 *   --gate <hi,lo>      Noul only: print approve/review/block against these thresholds (default 0.9,0.1)
 *   --json              Print the raw response JSON
 *   --no-cache          Skip the on-disk answer cache (batch and ask use it by default)
 *   --concurrency <n>   Parallel requests for batch (default 8)
 *   --help              Full option list
 *
 * Usage (library):
 *   const { createClient, noul, choice, score, gate } = require('./lib/jev.cjs');
 *   const jev = createClient();
 *   const r = await jev.decide(state, { urgent: noul('Does this convey urgency?') });
 *   r.answers.urgent.noul  // 0.95
 *
 * Requires OPENROUTER_API_KEY in the environment or a .env at or above the working directory.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const TYPES = new Set(['noul', 'choice', 'score']);
const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;
// Statuses worth another attempt: rate limits, gateway hiccups (OpenRouter returns 520 under
// load), and server errors. Everything else is a caller mistake and retrying cannot fix it.
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);

class JevError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.body = body;
    this.retryable = Boolean(retryable);
  }
}

// ------------------------------------------------------------------ env and key

// Walk up from a directory looking for a .env, so the tool works from any folder in the repo.
function findEnvFile(start) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Load the nearest .env once (from the working directory, then from this file's folder).
// Variables already in the environment win; loadEnvFile never overwrites them.
let envLoaded = false;
function loadEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const seen = new Set();
  for (const start of [process.cwd(), __dirname]) {
    const file = findEnvFile(start);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    try { process.loadEnvFile(file); } catch (_) { /* unreadable .env: rely on the environment */ }
  }
}

// ------------------------------------------------------------------ questions

function noul(instructions, criteria) {
  const q = { type: 'noul', instructions };
  if (criteria) q.criteria = criteria;
  return q;
}

// options: { key: description|null } or [key, ...]
function choice(instructions, options) {
  const criteria = Array.isArray(options)
    ? Object.fromEntries(options.map((k) => [k, null]))
    : options;
  return { type: 'choice', instructions, criteria };
}

// levels: ordered array, lowest first
function score(instructions, levels) {
  return { type: 'score', instructions, criteria: levels };
}

// Catch malformed questions before they cost a round trip. Mirrors the documented API limits.
function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new JevError('questions must be an object keyed by question id');
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) throw new JevError('questions is empty');
  for (const id of ids) {
    const q = questions[id];
    const where = `question "${id}"`;
    if (!q || typeof q !== 'object') throw new JevError(`${where} must be an object`);
    if (!TYPES.has(q.type)) throw new JevError(`${where}: type must be noul, choice, or score (got ${JSON.stringify(q.type)})`);
    if (q.instructions == null || q.instructions === '') throw new JevError(`${where}: instructions are required`);
    if (q.type === 'choice') {
      const c = q.criteria;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new JevError(`${where}: choice criteria must be an object of option -> description`);
      const n = Object.keys(c).length;
      if (n < 2) throw new JevError(`${where}: a choice needs at least 2 options`);
      if (n > MAX_CHOICE_OPTIONS) throw new JevError(`${where}: a choice allows at most ${MAX_CHOICE_OPTIONS} options (got ${n})`);
    } else if (q.type === 'score') {
      const c = q.criteria;
      if (!Array.isArray(c)) throw new JevError(`${where}: score criteria must be an ordered array of levels`);
      if (c.length < 2 || c.length > MAX_SCORE_LEVELS) throw new JevError(`${where}: a score needs 2-${MAX_SCORE_LEVELS} levels (got ${c.length})`);
    } else if (q.criteria != null) {
      const c = q.criteria;
      if (typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => k !== 'true' && k !== 'false')) {
        throw new JevError(`${where}: noul criteria may only have "true" and "false" keys`);
      }
    }
  }
}

// ------------------------------------------------------------------ gating

// Turn a probability into an action. The band between the thresholds is where a human looks.
function gate(p, { approve = 0.9, block = 0.1 } = {}) {
  if (!(approve > block)) throw new JevError('gate: approve threshold must be above block threshold');
  if (p >= approve) return 'approve';
  if (p <= block) return 'block';
  return 'review';
}

// The single number most callers want from any answer: noul probability, choice confidence,
// or score position normalized to 0..1 (0 = first level, 1 = last).
function strength(answer) {
  if (!answer) return NaN;
  if (answer.type === 'noul') return answer.noul;
  if (answer.type === 'choice') return answer.confidence;
  if (answer.type === 'score') {
    const levels = Object.keys(answer.legend || answer.probabilities || {}).length;
    return levels > 1 ? answer.score / (levels - 1) : NaN;
  }
  return NaN;
}

// ------------------------------------------------------------------ cache

// Answers are a pure function of (model, state, questions) for a pinned model, so repeat runs
// over the same corpus can skip the network. One JSON line per entry, append-only.
class AnswerCache {
  constructor(file) {
    this.file = file;
    this.map = new Map();
    if (file && fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); this.map.set(e.key, e.response); } catch (_) { /* torn write: skip */ }
      }
    }
  }
  // `scope` separates backends that answer to the same model name (every Kev checkpoint calls
  // itself "kev-latest"). Unscoped keys stay as they were, so existing Jev caches keep working.
  static key(model, state, questions, scope) {
    const parts = scope ? [model, state, questions, scope] : [model, state, questions];
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }
  get(key) { return this.map.get(key); }
  set(key, response) {
    this.map.set(key, response);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ key, response }) + '\n');
  }
}

// ------------------------------------------------------------------ client

function createClient(opts = {}) {
  loadEnv();
  // A local /v1/systemone server (Kev, Laya, ...) usually needs no key: pass requireKey: false.
  const keyName = opts.keyName || 'OPENROUTER_API_KEY';
  const apiKey = 'apiKey' in opts ? opts.apiKey : process.env[keyName];
  const requireKey = opts.requireKey ?? true;
  const model = opts.model || process.env.JEV_MODEL || DEFAULT_MODEL;
  const baseUrl = opts.baseUrl || process.env.JEV_BASE_URL || DEFAULT_BASE_URL;
  const cacheScope = opts.cacheScope || '';
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const doFetch = opts.fetch || globalThis.fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // OpenRouter app attribution (shows up in its activity dashboard); override per app.
  const appUrl = opts.appUrl || process.env.JEV_APP_URL || 'https://github.com/nothans/sieve';
  const appTitle = opts.appTitle || process.env.JEV_APP_TITLE || 'Sieve';
  const cache = opts.cacheFile ? new AnswerCache(opts.cacheFile) : null;

  const stats = { requests: 0, cached: 0, retries: 0, failures: 0, inputTokens: 0, cost: 0, latencyMs: [] };

  async function post(body) {
    let attempt = 0;
    for (;;) {
      const t0 = Date.now();
      let res, text;
      try {
        res = await doFetch(baseUrl, {
          method: 'POST',
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            'Content-Type': 'application/json',
            'HTTP-Referer': appUrl,
            'X-Title': appTitle,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        if (attempt < maxRetries) { attempt++; stats.retries++; await sleep(backoff(attempt)); continue; }
        throw new JevError(`network error: ${err.message}`, { retryable: true });
      }
      const latency = Date.now() - t0;
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* non-JSON gateway page */ }
      if (res.ok && json && json.answers) {
        stats.latencyMs.push(latency);
        return json;
      }
      const status = res.status;
      const retryable = RETRYABLE.has(status) || (res.ok && !json?.answers);
      if (retryable && attempt < maxRetries) {
        attempt++;
        stats.retries++;
        const after = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff(attempt));
        continue;
      }
      throw new JevError(errorMessage(status, json, text), { status, body: json || text, retryable });
    }
  }

  // One state, several questions, one round trip. All questions see the same state.
  async function decide(state, questions, callOpts = {}) {
    if (!apiKey && requireKey) throw new JevError(`${keyName} is not set (env or .env)`);
    if (state == null || state === '') throw new JevError('state is empty');
    validateQuestions(questions);
    const useModel = callOpts.model || model;
    const useCache = cache && callOpts.cache !== false;
    const key = useCache ? AnswerCache.key(useModel, state, questions, cacheScope) : null;
    if (useCache) {
      const hit = cache.get(key);
      if (hit) { stats.cached++; return { ...hit, cached: true }; }
    }
    stats.requests++;
    let json;
    try {
      json = await post({ model: useModel, state, questions });
    } catch (err) {
      stats.failures++;
      throw err;
    }
    stats.inputTokens += json.usage?.input_tokens || 0;
    stats.cost += json.usage?.cost || 0;
    if (useCache) cache.set(key, json);
    return json;
  }

  // Many states, bounded concurrency, results in input order. A failed item yields
  // { error } in its slot instead of sinking the whole batch.
  async function map(items, toRequest, { concurrency = 8, onResult } = {}) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        const { state, questions } = toRequest(items[i], i);
        try {
          results[i] = await decide(state, questions);
        } catch (err) {
          results[i] = { error: err.message, status: err.status };
        }
        if (onResult) onResult(results[i], i, items[i]);
      }
    }
    const n = Math.max(1, Math.min(concurrency, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }

  function summary() {
    const l = [...stats.latencyMs].sort((a, b) => a - b);
    const pct = (p) => (l.length ? l[Math.min(l.length - 1, Math.floor(p * l.length))] : null);
    return {
      requests: stats.requests, cached: stats.cached, retries: stats.retries, failures: stats.failures,
      input_tokens: stats.inputTokens, cost_usd: Number(stats.cost.toFixed(6)),
      latency_ms: { p50: pct(0.5), p90: pct(0.9), max: l.length ? l[l.length - 1] : null },
    };
  }

  return { decide, map, summary, stats, model, baseUrl };
}

function backoff(attempt) {
  return Math.min(8000, 400 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
}

function errorMessage(status, json, text) {
  const raw = json?.error?.message ?? (typeof text === 'string' ? text.slice(0, 300) : '');
  // OpenRouter wraps TypeSafe's zod validation errors as a JSON string; surface the readable part.
  let msg = raw;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) msg = parsed.map((e) => `${(e.path || []).join('.')}: ${e.message}`).join('; ');
  } catch (_) { /* already readable */ }
  return `Jev request failed (${status}): ${msg}`;
}

// ------------------------------------------------------------------ CLI

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

function readState(a) {
  if (a['state-file']) return parseMaybeJson(fs.readFileSync(a['state-file'], 'utf8'));
  if (a.state === '-') return parseMaybeJson(fs.readFileSync(0, 'utf8'));
  if (a.state != null) return a.state;
  if (!process.stdin.isTTY) return parseMaybeJson(fs.readFileSync(0, 'utf8'));
  return null;
}

// A state that is valid JSON goes over as structure; anything else is plain text.
function parseMaybeJson(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch (_) { /* text */ } }
  return t;
}

// "key=description" or just "key"
function parseOption(arg) {
  const eq = arg.indexOf('=');
  return eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
}

function bar(p, width = 20) {
  const n = Math.round(Math.max(0, Math.min(1, p)) * width);
  return '#'.repeat(n) + '.'.repeat(width - n);
}

function printAnswer(id, ans, a) {
  if (ans.type === 'noul') {
    const [hi, lo] = String(a.gate || '0.9,0.1').split(',').map(Number);
    console.log(`${id}  noul ${ans.noul.toFixed(2)}  ${bar(ans.noul)}  -> ${gate(ans.noul, { approve: hi, block: lo })}`);
    return;
  }
  const head = ans.type === 'choice'
    ? `${id}  choice ${ans.choice}  (confidence ${ans.confidence.toFixed(2)})`
    : `${id}  score ${ans.score.toFixed(2)} "${ans.legend?.[String(Math.round(ans.score))] ?? ''}"  (confidence ${ans.confidence.toFixed(2)})`;
  console.log(head);
  const probs = Object.entries(ans.probabilities || {});
  if (ans.type === 'choice') probs.sort((x, y) => y[1] - x[1]);
  for (const [k, p] of probs) {
    const label = ans.type === 'score' ? `${k} ${ans.legend?.[k] ?? ''}` : k;
    console.log(`    ${bar(p)} ${p.toFixed(2)}  ${label}`);
  }
}

const HELP = fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\n?/, '').replace(/^ \* ?/gm, '');

async function cli() {
  const a = parseArgs(process.argv.slice(2));
  const cmd = a._[0];
  if (a.help || !cmd) { process.stdout.write(HELP); return; }

  const cacheFile = a['no-cache'] ? null : path.join(__dirname, '.cache', 'answers.jsonl');
  const jev = createClient({ model: a.model, cacheFile: cmd === 'batch' || cmd === 'ask' ? cacheFile : null });
  const t0 = Date.now();

  if (cmd === 'batch') {
    if (!a.in || !a.questions) throw new JevError('batch needs --in items.jsonl and --questions questions.json');
    const questions = JSON.parse(fs.readFileSync(a.questions, 'utf8'));
    validateQuestions(questions);
    const lines = fs.readFileSync(a.in, 'utf8').split('\n').filter((l) => l.trim());
    const items = lines.map((l) => parseMaybeJson(l));
    const field = a['state-field'];
    const outStream = a.out ? fs.createWriteStream(a.out) : null;
    let done = 0;
    const results = await jev.map(items, (item) => ({ state: field ? item[field] : item, questions }), {
      concurrency: Number(a.concurrency) || 8,
      onResult: () => { done++; if (process.stderr.isTTY) process.stderr.write(`\r${done}/${items.length}`); },
    });
    if (process.stderr.isTTY) process.stderr.write('\n');
    for (let i = 0; i < items.length; i++) {
      const r = results[i];
      const line = JSON.stringify({ input: items[i], answers: r.answers, error: r.error, model: r.model }) + '\n';
      if (outStream) outStream.write(line); else process.stdout.write(line);
    }
    if (outStream) await new Promise((r) => outStream.end(r));
  } else {
    let state = readState(a);
    let questions;
    if (cmd === 'ask') {
      if (!a.request) throw new JevError('ask needs --request request.json');
      const req = JSON.parse(fs.readFileSync(a.request, 'utf8'));
      questions = req.questions;
      state = state ?? req.state;
    } else {
      const [instructions, ...rest] = a._.slice(1);
      if (!instructions) throw new JevError(`${cmd} needs the question text`);
      if (cmd === 'noul') {
        const crit = {};
        if (a.true) crit.true = a.true;
        if (a.false) crit.false = a.false;
        questions = { answer: noul(instructions, Object.keys(crit).length ? crit : undefined) };
      } else if (cmd === 'choice') {
        questions = { answer: choice(instructions, Object.fromEntries(rest.map(parseOption))) };
      } else if (cmd === 'score') {
        questions = { answer: score(instructions, rest) };
      } else {
        throw new JevError(`unknown command "${cmd}" (noul, choice, score, ask, batch)`);
      }
    }
    if (state == null) throw new JevError('no state: pass --state, --state-file, or pipe it on stdin');
    const res = await jev.decide(state, questions);
    if (a.json) console.log(JSON.stringify(res, null, 2));
    else for (const [id, ans] of Object.entries(res.answers)) printAnswer(id, ans, a);
  }

  const s = jev.summary();
  process.stderr.write(`[${jev.model}] ${s.requests} request(s), ${s.cached} cached, $${s.cost_usd.toFixed(6)}, ${Date.now() - t0} ms\n`);
}

function main() {
  cli().catch((err) => {
    process.stderr.write(`jev: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createClient, noul, choice, score, gate, strength, validateQuestions, loadEnv,
  AnswerCache, JevError, DEFAULT_MODEL, DEFAULT_BASE_URL, main,
};

if (require.main === module) main();
