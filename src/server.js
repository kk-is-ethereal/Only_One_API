import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { aiRoutes, HttpError, publicKey, publicUpstream, removeRecord, saveGroup, saveKey, saveUpstream, scopeFor } from './config.js';
import { authenticate, gateway, json, probeUpstream, readJson } from './gateway.js';
import { openStore, token } from './store.js';

const cookieName = 'ooa_session';
const assetTypes = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const assets = new Map(Object.entries(assetTypes).map(([route, [file, mime]]) => [route, {
  data: readFileSync(new URL(`../public/${file}`, import.meta.url)), mime
}]));
const resources = { upstreams: ['upstream', saveUpstream], groups: ['group', saveGroup], keys: ['key', saveKey] };

function sessionCookie(req) {
  return /(?:^|;\s*)ooa_session=(ses_[\w-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
}

function setCookie(res, value, secure) {
  res.setHeader('set-cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? 43200 : 0}${secure ? '; Secure' : ''}`);
}

function lookup(store, kind, id) {
  const entry = store.get(kind, id);
  if (!entry) throw new HttpError(404, '记录不存在。');
  return entry;
}

function createAdmin(store, secure) {
  const logins = new Map();
  return async function admin(req, res, url) {
    const { pathname } = url;
    if (req.method !== 'GET' && req.headers['x-ooa-admin'] !== '1') throw new HttpError(403, '缺少管理请求标头。');
    if (pathname === '/admin/login' && req.method === 'POST') {
      const source = req.socket.remoteAddress;
      const now = Date.now();
      for (const [address, entry] of logins) if (entry.expires <= now) logins.delete(address);
      const entry = logins.get(source) ?? { expires: now + 60000, count: 0 };
      if (entry.count >= 8 || (logins.size >= 2000 && !logins.has(source))) throw new HttpError(429, '登录尝试过多，请稍后再试。');
      entry.count += 1;
      logins.set(source, entry);
      const { password } = await readJson(req, 4096);
      if (!store.verifyPassword(password)) throw new HttpError(401, '管理员密码有误。');
      logins.delete(source);
      setCookie(res, store.session(), secure);
      return json(res, 200, { ok: true });
    }
    const session = sessionCookie(req);
    if (!store.hasSession(session)) throw new HttpError(401, '请先登录管理台。');
    if (pathname === '/admin/logout' && req.method === 'POST') {
      store.removeSession(session);
      setCookie(res, '', secure);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/admin/state' && req.method === 'GET') {
      return json(res, 200, { upstreams: store.list('upstream').map(publicUpstream), groups: store.list('group'),
        keys: store.list('key').map((key) => publicKey(key, store)), stats: store.stats() });
    }
    if (pathname === '/admin/logs' && req.method === 'GET') {
      return json(res, 200, store.logs({ route: url.searchParams.get('route') ?? '', failed: url.searchParams.get('failed') === '1' }));
    }
    const match = /^\/admin\/(upstreams|groups|keys)(?:\/([0-9a-f-]{36}))?(\/probe)?$/.exec(pathname);
    if (match) {
      const [, resource, id, probe] = match;
      const [kind, save] = resources[resource];
      if (!probe && !id && req.method === 'POST') return json(res, 201, save(store, await readJson(req)));
      if (!probe && id && req.method === 'PUT') {
        const input = await readJson(req);
        return json(res, 200, save(store, input, lookup(store, kind, id)));
      }
      if (!probe && id && req.method === 'DELETE') {
        lookup(store, kind, id);
        removeRecord(store, kind, id);
        return json(res, 200, { ok: true });
      }
      if (probe && id && kind === 'upstream' && req.method === 'POST') {
        return json(res, 200, await probeUpstream(store, lookup(store, kind, id), 5000));
      }
    }
    throw new HttpError(404, '找不到此管理接口。');
  };
}

export function createGatewayServer(store, { secureCookie = false } = {}) {
  const admin = createAdmin(store, secureCookie);
  return createServer({ requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, '无效的请求地址。');
      const url = new URL(req.url, 'http://only-one-api.local');
      const { pathname } = url;
      if (pathname.startsWith('/admin/')) return await admin(req, res, url);
      if (req.method === 'GET' && assets.has(pathname)) {
        const { mime, data } = assets.get(pathname);
        res.writeHead(200, { 'content-type': `${mime}; charset=utf-8` });
        return res.end(data);
      }
      if (req.method === 'GET' && pathname === '/healthz') return json(res, 200, { status: 'ok' });
      // Proxy content shares the listener with the UI and must be treated as untrusted.
      res.setHeader('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
      const proxy = /^\/api\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/.exec(pathname);
      const ai = aiRoutes.get(pathname);
      if (pathname === '/v1/models' && req.method === 'GET') {
        const key = authenticate(store, req);
        const data = store.list('group').filter((group) => group.kind === 'ai' && group.enabled &&
          group.operations.some(({ name }) => key.scopes.includes(scopeFor(group, name))))
          .map((group) => ({ id: group.alias, object: 'model', created: 0, owned_by: 'only_one_api' }));
        return json(res, 200, { object: 'list', data });
      }
      if (proxy || ai) {
        const key = authenticate(store, req);
        if (ai && req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          throw new HttpError(405, '该接口仅支持 POST。');
        }
        const payload = ai ? await readJson(req, 8 * 1024 * 1024) : undefined;
        if (ai && (typeof payload.model !== 'string' || !payload.model)) throw new HttpError(400, '请填写路由组别名作为 model。');
        const group = store.list('group').find((item) => item.alias === (ai ? payload.model : proxy[1]) && item.kind === (ai ? 'ai' : 'http'));
        const operation = group?.operations.find(({ name }) => name === (ai ?? proxy[2]));
        if (operation) return await gateway({ store, req, res, url, key, group, operation, payload });
      }
      throw new HttpError(404, '找不到接口或对应功能。', 'route_not_found');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Gateway internal error:', error.code ?? error.name);
      if (res.headersSent || res.destroyed) return res.destroy();
      req.resume();
      return json(res, error.status ?? 500, { error: {
        message: error instanceof HttpError ? error.message : '网关内部错误。',
        type: error.code ?? 'internal_error', code: error instanceof HttpError ? error.code : 'internal_error'
      } });
    }
  });
}

function main() {
  const reset = process.argv.includes('--reset-admin');
  const store = openStore(resolve(process.env.OOA_DATA_DIR || 'data'));
  if (reset || !store.initialized()) {
    const supplied = process.env.OOA_ADMIN_PASSWORD;
    const password = supplied || token('admin_');
    if (store.changePassword(password, reset)) {
      console.log(reset ? 'Admin password reset. Previous sessions are invalid.' : 'Admin account initialized.');
      if (!supplied) console.log(`Admin password (shown once): ${password}`);
    }
  }
  if (reset) return store.close();
  const port = Number(process.env.OOA_PORT || 8787);
  const host = process.env.OOA_HOST || '127.0.0.1';
  const server = createGatewayServer(store, { secureCookie: process.env.OOA_SECURE_COOKIE === '1' });
  server.listen(port, host, () => console.log(`Only_One_API listening on http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => store.close()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
