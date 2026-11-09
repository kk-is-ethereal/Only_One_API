import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGatewayServer } from '../src/server.js';
import { openStore } from '../src/store.js';

const password = 'test-admin-password-only';

async function listen(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handle) {
  const calls = [];
  const provider = await listen(t, createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
    calls.push(call);
    handle(call, res);
  }));
  const dir = mkdtempSync(join(tmpdir(), 'only-one-api-'));
  const store = openStore(dir);
  store.changePassword(password);
  const origin = await listen(t, createGatewayServer(store));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const headers = { 'content-type': 'application/json', 'x-ooa-admin': '1' };
  const login = await fetch(`${origin}/admin/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  headers.cookie = login.headers.get('set-cookie').split(';')[0];
  async function admin(path, body, method = body ? 'POST' : 'GET', status = body ? 201 : 200) {
    const response = await fetch(`${origin}/admin/${path}`, { method, headers, body: body && JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data;
  }
  async function issue(group, operation, options = {}) {
    return admin('keys', { name: 'Client', scopes: [`${group.id}:${operation}`], ...options });
  }
  function request(path, secret, data, extra = {}) {
    return fetch(origin + path, { method: data === undefined ? 'GET' : 'POST', body: data === undefined ? undefined : JSON.stringify(data),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...extra } });
  }
  return { origin, provider, store, calls, admin, issue, request };
}

test('probes each candidate, skips unhealthy, retries real failures and relays SSE with rewritten model', async (t) => {
  const { provider, calls, admin, issue, request } = await fixture(t, (call, res) => {
    if (call.url.endsWith('/models')) return res.writeHead(call.url.startsWith('/one') ? 503 : 200).end();
    if (call.url.startsWith('/two')) return res.writeHead(429).end('quota');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'set-cookie': 'bad=1' });
    res.write('data: {"ok":true}\n\n');
    setTimeout(() => res.end('data: [DONE]\n\n'), 20);
  });
  const members = [];
  for (const name of ['one', 'two', 'three', 'four']) {
    const upstream = await admin('upstreams', { name, provider: 'Mock', kind: 'ai', baseUrl: `${provider}/${name}`, probePath: '/models',
      authHeader: 'Authorization', authPrefix: 'Bearer ', secret: `secret-${name}`, defaultModel: name,
      endpoints: { chat: { method: 'POST', path: '/chat/completions' }, embeddings: { method: 'POST', path: '/embeddings' } } });
    assert.equal(upstream.hasCredential, true);
    assert.equal(upstream.credential, undefined);
    members.push({ id: upstream.id, model: `model-${name}` });
  }
  const group = await admin('groups', { name: 'A', alias: 'a', kind: 'ai', members,
    operations: [{ name: 'chat', method: 'POST' }, { name: 'embeddings', method: 'POST' }] });
  const key = await issue(group, 'chat');
  const models = await request('/v1/models', key.secret);
  assert.deepEqual((await models.json()).data.map(({ id }) => id), ['a']);
  assert.equal((await request('/v1/embeddings', key.secret, { model: 'a' })).status, 403);
  const response = await request('/v1/chat/completions', key.secret, { model: 'a', messages: [], stream: true });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'data: {"ok":true}\n\ndata: [DONE]\n\n');
  assert.deepEqual(calls.map(({ url }) => url), ['/one/models', '/two/models', '/two/chat/completions', '/three/models', '/three/chat/completions']);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer secret-three');
  assert.equal(JSON.parse(calls.at(-1).body).model, 'model-three');
  const [log] = await admin('logs?route=a');
  assert.equal(log.id, response.headers.get('x-request-id'));
  assert.equal(log.fallback, true);
  assert.deepEqual(log.attempts.map(({ result }) => result), ['probe_failed', 'retryable', 'success']);
  const state = await admin('state');
  assert.equal(state.keys[0].hash, undefined);
  assert.equal(state.keys[0].secret, undefined);
  assert.equal(state.stats.successful, 1);
  assert.equal((await request('/v1/chat/completions', 'invalid', { model: 'a' })).status, 401);
});

test('fixed HTTP routes forward query and data without leaking key or cookie, and never replay writes by default', async (t) => {
  const { origin, provider, calls, admin, issue, request } = await fixture(t, ({ url }, res) => {
    if (url.endsWith('/health')) return res.writeHead(204).end();
    if (url.startsWith('/primary')) return res.writeHead(503).end('temporary');
    return res.writeHead(200, { 'content-type': 'text/plain' }).end('fallback');
  });
  const members = [];
  for (const name of ['primary', 'secondary']) {
    const upstream = await admin('upstreams', { name, kind: 'http', provider: 'Mock', baseUrl: `${provider}/${name}`, probePath: '/health',
      authHeader: 'x-upstream-token', secret: 'provider-credential', endpoints: { save: { method: 'POST', path: '/fixed' }, lookup: { method: 'GET', path: '/fixed' } } });
    members.push({ id: upstream.id });
  }
  const group = await admin('groups', { name: 'Proxy', alias: 'proxy', kind: 'http', members,
    operations: [{ name: 'save', method: 'POST' }, { name: 'lookup', method: 'GET' }] });
  const key = await issue(group, 'save');
  const response = await request('/api/proxy/save?q=example', key.secret, { value: 42 }, { cookie: 'inbound=secret' });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'temporary');
  assert.deepEqual(calls.map(({ url }) => url), ['/primary/health', '/primary/fixed?q=example']);
  assert.deepEqual(JSON.parse(calls[1].body), { value: 42 });
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers.cookie, undefined);
  assert.equal(calls[1].headers['x-upstream-token'], 'provider-credential');
  assert.equal((await request('/api/proxy/lookup', key.secret)).status, 403);
  assert.equal((await request('/api/proxy/save', key.secret)).status, 405);
  const reader = await issue(group, 'lookup');
  assert.equal(await (await request('/api/proxy/lookup', reader.secret)).text(), 'fallback');
  assert.equal((await fetch(`${origin}/admin/state`)).status, 401);
});

test('applies rate limits, revocation, expiry and checks references when editing or deleting', async (t) => {
  const { provider, store, admin, issue, request } = await fixture(t, ({ url }, res) => {
    if (url.endsWith('/chat/completions')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(404).end();
  });
  const upstream = await admin('upstreams', { name: 'Model', provider: 'Mock', kind: 'ai', baseUrl: provider, defaultModel: 'real',
    probeMethod: 'POST', endpoints: { chat: { method: 'POST', path: '/chat/completions' } } });
  const group = await admin('groups', { name: 'Route', alias: 'route', kind: 'ai', members: [{ id: upstream.id }], operations: [{ name: 'chat', method: 'POST' }] });
  assert.equal((await admin(`upstreams/${upstream.id}/probe`, {}, 'POST', 200)).result, 'healthy');
  const key = await issue(group, 'chat', { rpm: 1 });
  const payload = { model: 'route' };
  assert.equal((await request('/v1/chat/completions', key.secret, payload)).status, 200);
  assert.equal((await request('/v1/chat/completions', key.secret, payload)).status, 429);
  await admin(`keys/${key.id}`, { ...key, enabled: false }, 'PUT', 200);
  assert.equal((await request('/v1/chat/completions', key.secret, payload)).status, 401);
  const expired = await issue(group, 'chat', { expiresAt: Date.now() - 1000 });
  assert.equal((await request('/v1/chat/completions', expired.secret, payload)).status, 401);
  await admin(`groups/${group.id}`, undefined, 'DELETE', 409);
  await admin(`upstreams/${upstream.id}`, undefined, 'DELETE', 409);
  store.changePassword('replacement-admin-password', true);
  await admin('state', undefined, 'GET', 401);
});
