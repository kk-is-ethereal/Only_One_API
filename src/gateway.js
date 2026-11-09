import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, scopeFor } from './config.js';

const aiFailures = new Set([401, 402, 403, 404, 408, 429]);
const httpFailures = new Set([408, 429]);
const safeMethods = new Set(['GET', 'HEAD']);
const responseHeaders = ['content-type', 'content-language', 'retry-after'];

export async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new HttpError(413, '请求体超过大小限制。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, '请求体超过大小限制。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function readJson(req, limit = 128 * 1024) {
  const body = await readBody(req, limit);
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* report the same input error */ }
  throw new HttpError(400, '请求体须为 JSON 对象。');
}

export function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function authenticate(store, req) {
  const bearer = /^Bearer (ooa_[\w-]{43})$/i.exec(req.headers.authorization ?? '')?.[1];
  const secret = bearer ?? req.headers['x-api-key'];
  const key = typeof secret === 'string' && /^ooa_[\w-]{43}$/.test(secret) && store.findKey(secret);
  if (!key?.enabled || (key.expiresAt && key.expiresAt <= Date.now())) {
    throw new HttpError(401, 'API Key 无效、停用或已过期。', 'invalid_api_key');
  }
  return key;
}

function upstreamHeaders(store, upstream) {
  const headers = new Headers();
  const secret = store.unseal(upstream.credential, upstream.id);
  if (secret) headers.set(upstream.authHeader, upstream.authPrefix + secret);
  return headers;
}

export async function probeUpstream(store, upstream, timeoutMs, signal, model = upstream.defaultModel) {
  if (!upstream.probePath) return { result: 'skipped', ms: 0 };
  const start = Date.now();
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const headers = upstreamHeaders(store, upstream);
    let body;
    if (upstream.probeMethod === 'POST') {
      if (!model) return { result: 'model_required', ms: 0 };
      headers.set('content-type', 'application/json');
      body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false });
    }
    const response = await fetch(upstream.baseUrl + upstream.probePath, {
      method: upstream.probeMethod, headers, body, redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    await response.body?.cancel();
    return { result: response.ok ? 'healthy' : 'unhealthy', status: response.status, ms: Date.now() - start };
  } catch {
    return { result: timeout.aborted ? 'timeout' : 'unreachable', ms: Date.now() - start };
  }
}

function attemptSignal(deadline, budget, client) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new HttpError(504, '已达到路由组总超时。', 'gateway_timeout');
  const timeout = AbortSignal.timeout(Math.min(remaining, budget));
  return AbortSignal.any([timeout, client]);
}

async function forward(res, response, signal) {
  const headers = {};
  for (const name of responseHeaders) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const mime = (headers['content-type'] ?? '').split(';', 1)[0].toLowerCase();
  if (!mime || !/^(application\/(json|[\w.+-]+\+json)|text\/(event-stream|plain|csv))$/.test(mime)) {
    headers['content-disposition'] = 'attachment';
  }
  if (mime === 'text/event-stream') headers['x-accel-buffering'] = 'no';
  if (!response.body) {
    res.writeHead(response.status, headers).end();
    return;
  }
  const reader = response.body.getReader();
  try {
    // Delay committing response headers until the upstream produces its first bytes.
    const first = await reader.read();
    res.writeHead(response.status, headers);
    if (first.done) {
      res.end();
      return;
    }
    async function* chunks() {
      yield first.value;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        yield chunk.value;
      }
    }
    await pipeline(Readable.from(chunks()), res, { signal });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function gateway({ store, req, res, url, key, group, operation, payload }) {
  if (!group?.enabled) throw new HttpError(404, '找不到可用的路由。', 'route_not_found');
  if (!key.scopes.includes(scopeFor(group, operation.name))) throw new HttpError(403, '当前 Key 未获授权使用此功能。', 'scope_denied');
  if (req.method !== operation.method) {
    res.setHeader('allow', operation.method);
    throw new HttpError(405, '该功能不支持此 HTTP 方法。');
  }

  const start = Date.now();
  const id = randomUUID();
  const attempts = [];
  const deadline = start + group.timeoutMs;
  const replay = group.replay || safeMethods.has(req.method);
  const client = new AbortController();
  res.once('close', () => { if (!res.writableFinished) client.abort(); });
  res.setHeader('x-request-id', id);
  let status = 500;
  let fallback = false;
  let used = '';
  try {
    if (!store.spend(key)) {
      res.setHeader('retry-after', Math.ceil((60000 - Date.now() % 60000) / 1000));
      throw new HttpError(429, '已达到当前 Key 的每分钟请求上限。', 'rate_limit_exceeded');
    }
    const isAi = group.kind === 'ai';
    const body = !isAi && !safeMethods.has(req.method) ? await readBody(req, 8 * 1024 * 1024) : undefined;
    const failures = isAi ? aiFailures : httpFailures;
    let timedOut = false;
    for (const [index, member] of group.members.entries()) {
      if (client.signal.aborted) throw new HttpError(499, '客户端已断开。', 'client_closed');
      const upstream = store.get('upstream', member.id);
      const attempt = { upstream: upstream?.name ?? member.id, result: 'disabled' };
      attempts.push(attempt);
      if (!upstream?.enabled) continue;
      const endpoint = upstream.endpoints[operation.name];
      if (group.probe) {
        const probeBudget = Math.min(group.probeTimeoutMs, deadline - Date.now());
        if (probeBudget <= 0) throw new HttpError(504, '已达到路由组总超时。', 'gateway_timeout');
        const probe = await probeUpstream(store, upstream, probeBudget, client.signal, member.model || upstream.defaultModel);
        attempt.probe = probe;
        if (probe.result !== 'healthy' && probe.result !== 'skipped') {
          attempt.result = 'probe_failed';
          timedOut ||= probe.result === 'timeout';
          continue;
        }
      }
      const signal = attemptSignal(deadline, upstream.timeoutMs, client.signal);
      const headers = upstreamHeaders(store, upstream);
      const contentType = isAi ? 'application/json' : req.headers['content-type'];
      if (contentType) headers.set('content-type', contentType);
      if (!isAi && req.headers['content-encoding']) headers.set('content-encoding', req.headers['content-encoding']);
      if (req.headers.accept) headers.set('accept', req.headers.accept);
      const target = upstream.baseUrl + endpoint.path + (isAi ? '' : url.search);
      const data = isAi ? JSON.stringify({ ...payload, model: member.model || upstream.defaultModel }) : body;
      const started = Date.now();
      used = upstream.name;
      fallback ||= index > 0;
      try {
        const response = await fetch(target, { method: req.method, headers, body: data, redirect: 'manual', signal });
        attempt.status = response.status;
        const transient = response.status >= 500 || failures.has(response.status);
        if (transient && replay) {
          await response.body?.cancel();
          attempt.result = 'retryable';
          continue;
        }
        if ((isAi && !response.ok) || (response.status >= 300 && response.status < 400)) {
          await response.body?.cancel();
          attempt.result = 'upstream_error';
          throw new HttpError(response.status >= 400 ? response.status : 502,
            '上游拒绝了请求。请按请求 ID 查看管理台日志。', 'upstream_error');
        }
        await forward(res, response, signal);
        status = response.status;
        attempt.result = status < 400 ? 'success' : 'upstream_error';
        return;
      } catch (error) {
        if (client.signal.aborted && !res.headersSent) throw new HttpError(499, '客户端已断开。', 'client_closed');
        if (error instanceof HttpError) throw error;
        const attemptTimedOut = signal.aborted && !client.signal.aborted;
        timedOut ||= attemptTimedOut;
        attempt.result = res.headersSent ? 'interrupted' : attemptTimedOut ? 'timeout' : 'unreachable';
        if (res.headersSent || !replay) {
          throw new HttpError(client.signal.aborted && !attemptTimedOut ? 499 : attemptTimedOut ? 504 : 502,
            '上游连接或响应中断。', 'upstream_interrupted');
        }
      } finally {
        attempt.ms = Date.now() - started;
      }
    }
    if (client.signal.aborted) throw new HttpError(499, '客户端已断开。', 'client_closed');
    throw new HttpError(timedOut ? 504 : 502, '本组上游均不可用。请按请求 ID 查看管理台日志。', 'upstreams_unavailable');
  } catch (error) {
    status = error.status ?? 500;
    throw error;
  } finally {
    store.log({ id, at: start, route: group.alias, operation: operation.name, key: key.name,
      status, fallback, upstream: used, ms: Date.now() - start, attempts });
  }
}
