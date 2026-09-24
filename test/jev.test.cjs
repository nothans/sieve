// Unit tests for the Jev client. No network: fetch is stubbed.
// Run: node --test "test/*.test.cjs"
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createClient, noul, choice, score, gate, strength, validateQuestions, JevError,
} = require('../lib/jev.cjs');

const OK = {
  model: 'typesafe/jev-1.13-20260917',
  answers: { a: { type: 'noul', noul: 0.8 } },
  usage: { input_tokens: 300, output_tokens: 20, cost: 0.0000126 },
};

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

// fetch stub that plays back a script of responses and records each request body
function scripted(...steps) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, calls };
}

const client = (fetch, extra = {}) => createClient({ apiKey: 'k', fetch, sleep: async () => {}, ...extra });
const Q = { a: noul('Is it?') };

test('question builders produce the documented shapes', () => {
  assert.deepEqual(noul('q', { true: 'y', false: 'n' }), { type: 'noul', instructions: 'q', criteria: { true: 'y', false: 'n' } });
  assert.deepEqual(choice('q', ['x', 'y']), { type: 'choice', instructions: 'q', criteria: { x: null, y: null } });
  assert.deepEqual(score('q', ['lo', 'hi']), { type: 'score', instructions: 'q', criteria: ['lo', 'hi'] });
});

test('validation rejects malformed questions before any request', () => {
  assert.throws(() => validateQuestions({}), /empty/);
  assert.throws(() => validateQuestions({ a: { type: 'bogus', instructions: 'q' } }), /type must be/);
  assert.throws(() => validateQuestions({ a: { type: 'noul' } }), /instructions are required/);
  assert.throws(() => validateQuestions({ a: choice('q', ['only']) }), /at least 2/);
  const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
  assert.throws(() => validateQuestions({ a: choice('q', many) }), /at most 255/);
  assert.throws(() => validateQuestions({ a: score('q', ['one']) }), /2-10 levels/);
  assert.throws(() => validateQuestions({ a: score('q', Array(11).fill('x')) }), /2-10 levels/);
  assert.throws(() => validateQuestions({ a: { type: 'noul', instructions: 'q', criteria: { maybe: 'x' } } }), /only have "true" and "false"/);
  validateQuestions({ a: noul('q'), b: choice('q', ['x', 'y']), c: score('q', ['l', 'h']) });
});

test('decide sends model, state, questions and returns the answers', async () => {
  const { fetch, calls } = scripted(response(200, OK));
  const jev = client(fetch);
  const r = await jev.decide('state text', Q);
  assert.equal(r.answers.a.noul, 0.8);
  assert.deepEqual(calls[0], { model: 'typesafe/jev-1.13', state: 'state text', questions: Q });
  assert.equal(jev.summary().input_tokens, 300);
});

test('retries gateway errors and rate limits, then succeeds', async () => {
  const { fetch, calls } = scripted(response(520, 'bad gateway'), response(429, { error: { message: 'slow down' } }, { 'retry-after': '1' }), response(200, OK));
  const jev = client(fetch);
  const r = await jev.decide('s', Q);
  assert.equal(r.answers.a.noul, 0.8);
  assert.equal(calls.length, 3);
  assert.equal(jev.summary().retries, 2);
});

test('retries network errors', async () => {
  const { fetch, calls } = scripted(new Error('ECONNRESET'), response(200, OK));
  await client(fetch).decide('s', Q);
  assert.equal(calls.length, 2);
});

test('does not retry a bad request and surfaces the readable validation message', async () => {
  const zod = JSON.stringify([{ path: ['questions', 'a', 'type'], message: "Invalid discriminator value. Expected 'noul' | 'choice' | 'score'" }]);
  const { fetch, calls } = scripted(response(400, { error: { message: zod, code: 400 } }));
  await assert.rejects(client(fetch).decide('s', Q), (err) => {
    assert.ok(err instanceof JevError);
    assert.equal(err.status, 400);
    assert.match(err.message, /questions\.a\.type: Invalid discriminator/);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('gives up after maxRetries', async () => {
  const { fetch, calls } = scripted(response(503, 'down'));
  await assert.rejects(client(fetch, { maxRetries: 2 }).decide('s', Q), /503/);
  assert.equal(calls.length, 3);
});

test('a 200 without answers is treated as a transient failure', async () => {
  const { fetch, calls } = scripted(response(200, '<html>'), response(200, OK));
  await client(fetch).decide('s', Q);
  assert.equal(calls.length, 2);
});

test('refuses to call with an empty state', async () => {
  const { fetch, calls } = scripted(response(200, OK));
  await assert.rejects(client(fetch).decide('', Q), /state is empty/);
  await assert.rejects(client(fetch).decide(null, Q), /state is empty/);
  assert.equal(calls.length, 0);
});

test('cache answers repeat questions from disk without a request', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-')), 'answers.jsonl');
  const first = scripted(response(200, OK));
  await client(first.fetch, { cacheFile: file }).decide('s', Q);
  const second = scripted(response(500, 'should not be called'));
  const jev = client(second.fetch, { cacheFile: file });
  const r = await jev.decide('s', Q);
  assert.equal(r.cached, true);
  assert.equal(second.calls.length, 0);
  assert.equal(jev.summary().cached, 1);
  // a different state misses
  await assert.rejects(jev.decide('other', Q), /500/);
});

test('map keeps input order and isolates failures', async () => {
  const fetch = async (url, init) => {
    const { state } = JSON.parse(init.body);
    await new Promise((r) => setTimeout(r, state === 'slow' ? 20 : 1));
    if (state === 'bad') return response(400, { error: { message: 'nope' } });
    return response(200, { ...OK, answers: { a: { type: 'noul', noul: state.length / 10 } } });
  };
  const jev = client(fetch);
  const seen = [];
  const out = await jev.map(['slow', 'bad', 'ok'], (s) => ({ state: s, questions: Q }), { concurrency: 3, onResult: (_, i) => seen.push(i) });
  assert.equal(out[0].answers.a.noul, 0.4);
  assert.match(out[1].error, /400/);
  assert.equal(out[2].answers.a.noul, 0.2);
  assert.equal(seen.length, 3);
});

test('gate splits a probability into approve, review, block', () => {
  assert.equal(gate(0.95), 'approve');
  assert.equal(gate(0.9), 'approve');
  assert.equal(gate(0.5), 'review');
  assert.equal(gate(0.1), 'block');
  assert.equal(gate(0.7, { approve: 0.6, block: 0.2 }), 'approve');
  assert.throws(() => gate(0.5, { approve: 0.2, block: 0.4 }), /above block/);
});

test('strength normalizes every answer type to 0..1', () => {
  assert.equal(strength({ type: 'noul', noul: 0.3 }), 0.3);
  assert.equal(strength({ type: 'choice', choice: 'x', confidence: 0.7 }), 0.7);
  assert.equal(strength({ type: 'score', score: 2, legend: { 0: 'a', 1: 'b', 2: 'c' } }), 1);
  assert.equal(strength({ type: 'score', score: 1.5, probabilities: { 0: 0, 1: 0.5, 2: 0.5, 3: 0 } }), 0.5);
  assert.ok(Number.isNaN(strength(undefined)));
});
