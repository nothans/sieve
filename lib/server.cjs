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
const { preset, presetList, buildLenses } = require('./lenses.cjs');
const { kindLabels } = require('./config.cjs');
const { siftMany } = require('./sift.cjs');
const { filterItems } = require('./filter.cjs');
const backends = require('./backends.cjs');

const MAX_PHRASE = 300;
const MAX_BODY = 64 * 1024;
const REINDEX_MS = 60_000; // pick up new briefs without a restart, but not on every keystroke

function serve({ config, corpus: initial, port = 4177, cacheFile, host = '127.0.0.1', settingsFile = backends.SETTINGS_FILE }) {
  const { root } = config;
  const lenses = buildLenses(config.lenses);
  let corpus = initial;
  let indexedAt = Date.now();
  let running = 0;
  let settings = backends.readSettings(settingsFile);
  let jev = null; // the active backend's client, built on first use and after every settings change
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
    };
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
    try {
      p = preset(config, params.get('preset') || 'ask', { phrase, type: params.get('type') || 'noul', thesis: (params.get('thesis') || '').slice(0, MAX_PHRASE) }, lenses);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    // One sift at a time: a second tab should not double the spend by accident.
    if (running) return json(res, 429, { error: 'A sift is already running. Wait for it to finish.' });
    // Preflight: the page validates here first, because EventSource cannot read an error body.
    if (params.get('check')) return json(res, 200, { ok: true, title: p.title, backend: backendSummary() });
    running++;

    let jevNow;
    try {
      jevNow = await client();
    } catch (err) {
      running--;
      return json(res, 502, { error: `backend unavailable: ${err.message}` });
    }
    const profile = jevNow.profile;
    const items = filterItems(freshCorpus(), { kind: params.get('kind'), since: params.get('since') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let closed = false;
    req.on('close', () => { closed = true; });

    const before = jevNow.summary();
    const t0 = Date.now();
    const lensLabels = Object.fromEntries(Object.entries(p.lenses).map(([k, l]) => [k, l.label || '']));
    send('start', { title: p.title, total: items.length, grouped: Boolean(p.group), lensLabels, backend: backendSummary() });
    try {
      await siftMany(jevNow, items, p.lenses, {
        pack: profile.pack,
        concurrency: profile.concurrency,
        onResult: (batch) => {
          if (closed) return;
          send('batch', batch.map((r) => ({
            id: r.item.id, kind: r.item.kind, date: r.item.date, title: r.item.title,
            path: r.item.path, line: r.item.line,
            value: r.answers ? p.value(r.answers) : -1,
            label: r.answers ? p.label(r.answers) : r.error,
            group: r.answers && p.group ? p.group(r.answers) : null,
            answers: r.answers,
            error: r.error,
          })));
        },
      });
      const after = jevNow.summary();
      send('done', {
        items: items.length,
        requests: after.requests - before.requests,
        cached: after.cached - before.cached,
        failures: after.failures - before.failures,
        cost: after.cost_usd - before.cost_usd,
        ms: Date.now() - t0,
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
