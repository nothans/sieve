// The Sieve web UI: a local page that sifts the corpus live.
//
// Results stream to the browser over Server-Sent Events as each batch lands, so the list fills
// and re-ranks while the sift runs. The server binds to 127.0.0.1 only: it spends API credit on
// every request and holds the keys, so it is not for the network.
//
// Binding to localhost is not enough on its own: any web page the user has open can still send
// requests to 127.0.0.1. So every API call must come from this page (Host, Origin, and
// Sec-Fetch-Site checks, which also stop DNS rebinding), and anything that changes settings
// must carry an X-Sieve header, which a cross-site page cannot add without a CORS preflight
// this server never grants.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildCorpus } = require('./corpus.cjs');
const { preset, presetList, buildLenses, relatedPreset, rankOf } = require('./lenses.cjs');
const { kindLabels } = require('./config.cjs');
const { siftMany, requestFor, SLOTS } = require('./sift.cjs');
const { filterItems } = require('./filter.cjs');
const backends = require('./backends.cjs');

const MAX_PHRASE = 300;
const MAX_BODY = 64 * 1024;
const REINDEX_MS = 60_000; // pick up new briefs without a restart, but not on every keystroke
const KEEP_SIFTS = 12; // result sets remembered for "narrow these", newest kept

function serve({ config, corpus: initial, port = 4177, cacheFile, host = '127.0.0.1', settingsFile = backends.SETTINGS_FILE }) {
  const { root } = config;
  const lenses = buildLenses(config.lenses);
  let corpus = initial;
  let indexedAt = Date.now();
  let running = 0;
  let settings = backends.readSettings(settingsFile);
  let jev = null; // the active backend's client, built on first use and after every settings change
  // Finished sifts, by id: item id -> { value, group }. "Narrow these" asks a new question of only
  // the items that cleared a bar in one of these, so a search can be built up step by step.
  const sifts = new Map();
  let siftSeq = 0;
  const page = path.join(__dirname, '..', 'web', 'index.html');

  async function client() {
    if (!jev) jev = await backends.clientFor(backends.getProfile(settings), { cacheFile });
    return jev;
  }

  function freshCorpus() {
    if (Date.now() - indexedAt > REINDEX_MS) {
      corpus = buildCorpus(config);
      indexedAt = Date.now();
    }
    return corpus;
  }

  function backendSummary() {
    const p = backends.getProfile(settings);
    return { id: p.id, label: p.label, model: p.model, host: new URL(p.baseUrl).host, pack: p.pack, concurrency: p.concurrency, kind: p.kind, served: jev?.servedRun || null };
  }

  function meta() {
    const by = {};
    for (const it of corpus) by[it.kind] = (by[it.kind] || 0) + 1;
    return {
      name: config.name, tagline: config.tagline || 'Sift everything in the corpus by one question.',
      items: corpus.length, dated: corpus.filter((it) => it.date).length, by, kinds: kindLabels(config), presets: presetList(config), examples: config.examples || [],
      backend: backendSummary(), model: backendSummary().model, root: root.split(path.sep).join('/'),
      cache: Boolean(cacheFile),
      setup: (() => {
        const p = backends.getProfile(settings);
        const text = backends.keyProblem(p);
        return text ? { text, keyEnv: p.keyEnv, kind: p.kind, label: p.label } : null;
      })(),
    };
  }

  // Wall-clock time per request, measured on this server for each backend, so the page can say
  // "about 4 min" for a slow local model before anyone presses the button.
  const pace = new Map();

  // What a sift will take, before it runs: requests, an approximate cost (Jev bills input tokens;
  // about 3.6 characters per token matched real bills within 20% on the demos), and a time based on
  // what this backend has measured so far. Cached answers make the real numbers smaller.
  function estimate(items, p, profile) {
    const pack = Math.max(1, Math.min(profile.pack, SLOTS.length));
    const requests = Math.ceil(items.length / pack);
    const price = backends.pricePerMTok(profile);
    let cost = price === 0 ? 0 : null;
    if (price) {
      let chars = 0;
      for (let i = 0; i < items.length; i += pack) chars += JSON.stringify(requestFor(items.slice(i, i + pack), p.lenses, p.context || null)).length;
      cost = (chars / 3.6) * (price / 1e6);
    }
    const ms = pace.get(profile.id);
    return { requests, cost, seconds: ms ? (Math.ceil(requests / Math.max(1, profile.concurrency)) * ms) / 1000 : null };
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { reject(new Error('body is not JSON')); }
      });
      req.on('error', reject);
    });
  }

  // Only this page may use the API. Returns a reason to refuse, or null.
  function refuse(req, needsHeader) {
    const actual = server.address().port;
    const hosts = [`127.0.0.1:${actual}`, `localhost:${actual}`];
    if (!hosts.includes(req.headers.host || '')) return 'unexpected Host header';
    const origin = req.headers.origin;
    if (origin && !hosts.some((h) => origin === `http://${h}`)) return 'cross-origin request';
    if (req.headers['sec-fetch-site'] === 'cross-site') return 'cross-site request';
    if (needsHeader && req.headers['x-sieve'] !== '1') return 'missing X-Sieve header';
    return null;
  }

  async function sift(req, res, params) {
    let p;
    const phrase = (params.get('q') || '').slice(0, MAX_PHRASE);
    const current = freshCorpus();
    let items = filterItems(current, { kind: params.get('kind'), since: params.get('since') });
    try {
      if (params.get('preset') === 'related') {
        const anchor = current.find((x) => x.id === params.get('anchor'));
        if (!anchor) throw new Error('That item is no longer in the corpus. Run the sift again, then pick it.');
        p = relatedPreset(anchor);
      } else {
        p = preset(config, params.get('preset') || 'ask', {
          phrase, type: params.get('type') || 'noul',
          thesis: (params.get('thesis') || '').slice(0, MAX_PHRASE),
          vs: (params.get('vs') || '').slice(0, MAX_PHRASE),
        }, lenses);
      }
      if (p.exclude) items = items.filter((it) => it.id !== p.exclude);
      if (params.get('within')) {
        const prev = sifts.get(params.get('within'));
        if (!prev) throw new Error('Those results have expired (the server restarted or many sifts ran since). Run the first question again.');
        const min = Math.min(1, Math.max(0, Number(params.get('min')) || 0));
        const g = params.get('wgroup');
        items = items.filter((it) => {
          const r = prev.get(it.id);
          return r && r.value >= min && (!g || r.group === g);
        });
      }
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    // A backend that cannot answer yet says why here, before anything runs, instead of failing on
    // every item.
    const profileNow = backends.getProfile(settings);
    const setup = backends.keyProblem(profileNow);
    if (setup) return json(res, 400, { error: setup, setup: true });
    // One sift at a time: a second tab should not double the spend by accident.
    if (running) return json(res, 429, { error: 'A sift is already running. Wait for it to finish.' });
    // Preflight: the page validates here first, because EventSource cannot read an error body. It
    // also carries the estimate the page shows next to the Sift button, so it is called as the
    // question and filters change (it is free: nothing is sent to the model).
    if (params.get('check')) return json(res, 200, { ok: true, title: p.title, meaning: p.meaning || '', items: items.length, estimate: estimate(items, p, profileNow), backend: backendSummary() });
    running++;

    let jevNow;
    try {
      jevNow = await client();
    } catch (err) {
      running--;
      return json(res, 502, { error: `backend unavailable: ${err.message}` });
    }
    const profile = jevNow.profile;
    const sid = `s${++siftSeq}`;
    const kept = new Map();
    const errors = [];
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // A closed page stops the sift: requests already in flight finish, no new ones start, so a
    // tab closed ten seconds into a slow local run does not keep the model busy for minutes.
    let closed = false;
    const stop = new AbortController();
    res.on('close', () => { closed = true; stop.abort(); });

    const before = jevNow.summary();
    const t0 = Date.now();
    const lensLabels = Object.fromEntries(Object.entries(p.lenses).map(([k, l]) => [k, l.label || '']));
    send('start', { sid, title: p.title, meaning: p.meaning || '', total: items.length, grouped: Boolean(p.group), lensLabels, backend: backendSummary() });
    try {
      await siftMany(jevNow, items, p.lenses, {
        pack: profile.pack,
        concurrency: profile.concurrency,
        context: p.context || null,
        signal: stop.signal,
        onResult: (batch) => {
          const rows = batch.map((r) => ({
            id: r.item.id, kind: r.item.kind, date: r.item.date, title: r.item.title,
            path: r.item.path, line: r.item.line,
            value: rankOf(p, r.answers),
            label: r.answers ? p.label(r.answers) : r.error,
            group: r.answers && p.group ? p.group(r.answers) : null,
            answers: r.answers,
            error: r.error,
          }));
          for (const r of rows) {
            kept.set(r.id, { value: r.value, group: r.group });
            if (r.error) errors.push(r.error);
          }
          if (!closed) send('batch', rows);
        },
      });
      const after = jevNow.summary();
      if (closed) return; // stopped early: nothing to narrow, nobody to tell
      sifts.set(sid, kept);
      while (sifts.size > KEEP_SIFTS) sifts.delete(sifts.keys().next().value);
      const requests = after.requests - before.requests;
      const ms = Date.now() - t0;
      // Time per wave of requests in flight together, so a 1-request narrow and a 20-request
      // sweep at 16 at a time predict each other.
      if (requests) pace.set(profile.id, ms / Math.ceil(requests / Math.max(1, profile.concurrency)));
      // Items the model could not judge, and the most common reason, so a failed sift never
      // looks like an empty one.
      const reasons = {};
      for (const e of errors) reasons[e] = (reasons[e] || 0) + 1;
      const [reason] = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0] || [];
      send('done', {
        sid,
        items: items.length,
        requests,
        cached: after.cached - before.cached,
        failures: after.failures - before.failures,
        errors: errors.length,
        reason: reason || null,
        cost: after.cost_usd - before.cost_usd,
        ms,
      });
    } catch (err) {
      send('failed', { error: err.message });
    } finally {
      running--;
      res.end();
    }
  }

  function settingsView() {
    return {
      active: settings.active,
      backends: settings.backends.map(backends.publicProfile),
      file: path.relative(process.cwd(), settingsFile).split(path.sep).join('/'),
    };
  }

  async function putSettings(req, res) {
    if (running) return json(res, 409, { error: 'Wait for the running sift to finish before changing the backend.' });
    let body;
    try {
      body = await readBody(req);
      const list = Array.isArray(body.backends) ? body.backends.map((p) => backends.normalizeProfile(p)) : null;
      if (!list || !list.length) throw new Error('send the full list of backends');
      if (new Set(list.map((p) => p.id)).size !== list.length) throw new Error('two backends share an id');
      for (const b of backends.BUILTIN) if (!list.some((p) => p.id === b.id)) throw new Error(`the built-in backend "${b.id}" cannot be removed`);
      if (!list.some((p) => p.id === body.active)) throw new Error('the active backend must be in the list');
      settings = backends.writeSettings({ active: body.active, backends: list }, settingsFile);
      jev = null; // rebuilt on next use with the new profile
      return json(res, 200, settingsView());
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  async function testBackend(req, res) {
    try {
      const body = await readBody(req);
      const p = backends.normalizeProfile(body.backend || {});
      return json(res, 200, await backends.probe(p));
    } catch (err) {
      return json(res, 200, { ok: false, error: err.message });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
      return fs.createReadStream(page).pipe(res);
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    const mutating = req.method !== 'GET';
    const why = refuse(req, mutating || url.pathname.startsWith('/api/settings'));
    if (why) return json(res, 403, { error: `refused: ${why}` });

    if (url.pathname === '/api/meta') return json(res, 200, meta());
    if (url.pathname === '/api/item') {
      const it = corpus.find((x) => x.id === url.searchParams.get('id'));
      return it ? json(res, 200, it) : json(res, 404, { error: 'no such item' });
    }
    if (url.pathname === '/api/sift' && req.method === 'GET') return sift(req, res, url.searchParams);
    if (url.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settingsView());
    if (url.pathname === '/api/settings' && req.method === 'PUT') return putSettings(req, res);
    if (url.pathname === '/api/settings/test' && req.method === 'POST') return testBackend(req, res);
    json(res, 404, { error: 'not found' });
  });

  server.listen(port, host, () => {
    const p = backends.getProfile(settings);
    process.stderr.write(`Sieve: http://${host}:${server.address().port}  (${corpus.length} items, backend ${p.id}: ${p.model})\n`);
  });
  return server;
}

module.exports = { serve };
