// The Sieve web UI: a local page that sifts the corpus live.
//
// Results stream to the browser over Server-Sent Events as each Jev batch lands, so the list
// fills and re-ranks while the sift runs. The server binds to 127.0.0.1 only: it spends
// OpenRouter credit on every request and holds the key, so it is not for the network.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('./jev.cjs');
const { buildCorpus } = require('./corpus.cjs');
const { preset, presetList, buildLenses } = require('./lenses.cjs');
const { kindLabels } = require('./config.cjs');
const { siftMany, DEFAULT_PACK } = require('./sift.cjs');
const { filterItems } = require('./filter.cjs');

const MAX_PHRASE = 300;
const REINDEX_MS = 60_000; // pick up new briefs without a restart, but not on every keystroke

function serve({ config, corpus: initial, port = 4177, cacheFile, host = '127.0.0.1' }) {
  const { root } = config;
  const lenses = buildLenses(config.lenses);
  let corpus = initial;
  let indexedAt = Date.now();
  let running = 0;
  const jev = createClient({ cacheFile });
  const page = path.join(__dirname, '..', 'web', 'index.html');

  function freshCorpus() {
    if (Date.now() - indexedAt > REINDEX_MS) {
      corpus = buildCorpus(config);
      indexedAt = Date.now();
    }
    return corpus;
  }

  function meta() {
    const by = {};
    for (const it of corpus) by[it.kind] = (by[it.kind] || 0) + 1;
    return {
      name: config.name, tagline: config.tagline || 'Sift everything in the corpus by one question.',
      items: corpus.length, dated: corpus.filter((it) => it.date).length, by, kinds: kindLabels(config), presets: presetList(config), examples: config.examples || [],
      model: jev.model, pack: DEFAULT_PACK, root: root.split(path.sep).join('/'),
    };
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
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
    if (params.get('check')) return json(res, 200, { ok: true, title: p.title });
    running++;

    const items = filterItems(freshCorpus(), { kind: params.get('kind'), since: params.get('since') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let closed = false;
    req.on('close', () => { closed = true; });

    const before = jev.summary();
    const t0 = Date.now();
    const lensLabels = Object.fromEntries(Object.entries(p.lenses).map(([k, l]) => [k, l.label || '']));
    send('start', { title: p.title, total: items.length, grouped: Boolean(p.group), lensLabels });
    try {
      await siftMany(jev, items, p.lenses, {
        pack: DEFAULT_PACK,
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
      const after = jev.summary();
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

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(page).pipe(res);
    }
    if (url.pathname === '/api/meta') return json(res, 200, meta());
    if (url.pathname === '/api/item') {
      const it = corpus.find((x) => x.id === url.searchParams.get('id'));
      return it ? json(res, 200, it) : json(res, 404, { error: 'no such item' });
    }
    if (url.pathname === '/api/sift') return sift(req, res, url.searchParams);
    json(res, 404, { error: 'not found' });
  });

  server.listen(port, host, () => {
    process.stderr.write(`Sieve: http://${host}:${port}  (${corpus.length} items, ${jev.model})\n`);
  });
  return server;
}

module.exports = { serve };
