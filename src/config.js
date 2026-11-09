import { randomUUID } from 'node:crypto';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { digest, token } from './store.js';

export const aiPaths = { chat: '/chat/completions', responses: '/responses', embeddings: '/embeddings' };
export const aiRoutes = new Map(Object.entries(aiPaths).map(([operation, path]) => [`/v1${path}`, operation]));
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const prohibitedHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'expect', 'accept', 'accept-encoding', 'content-type', 'content-encoding', 'forwarded', 'origin']);
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export class HttpError extends Error {
  constructor(status, message, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function check(ok, message, status = 400) {
  if (!ok) throw new HttpError(status, message);
}

function str(value, label, max = 120) {
  check(typeof value === 'string' && value.trim() && value.length <= max, `${label}不能为空，且最多 ${max} 个字符。`);
  return value.trim();
}

function integer(value, min, max, label) {
  check(Number.isInteger(value) && value >= min && value <= max, `${label}须在 ${min} 到 ${max} 之间。`);
  return value;
}

function array(value, label, max = 24) {
  check(Array.isArray(value) && value.length > 0 && value.length <= max, `${label}须选择 1 到 ${max} 项。`);
  return value;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function slug(value, label) {
  check(typeof value === 'string' && slugPattern.test(value), `${label}仅支持小写字母、数字、下划线和短横线，最多 48 个字符。`);
  return value;
}

function path(value) {
  check(typeof value === 'string' && /^\/(?:[a-zA-Z0-9_.~/-]{0,499})$/.test(value) &&
    !value.includes('//') && !value.split('/').some((part) => part === '.' || part === '..'), '上游路径必须以 / 开头，且不能包含查询参数或路径跳转。');
  return value;
}

function base(value) {
  const input = str(value, '上游地址', 512);
  let url;
  try { url = new URL(input); } catch { throw new HttpError(400, '请输入有效的上游 URL。'); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(input),
    '上游地址须为 HTTP(S)，且不能包含用户信息、查询或片段。');
  return url.href.replace(/\/+$/, '');
}

function compatible(group, upstream) {
  return upstream && upstream.kind === group.kind && group.operations.every((operation) => {
    const endpoint = Object.hasOwn(upstream.endpoints, operation.name) && upstream.endpoints[operation.name];
    return endpoint && endpoint.method === operation.method;
  });
}

export const publicUpstream = ({ credential, ...item }) => ({ ...item, hasCredential: Boolean(credential) });
export const publicKey = ({ hash, ...key }, store) => ({ ...key, lastUsed: store.keyUse(key.id) });
export const scopeFor = (group, operation) => `${group.id}:${operation}`;

export function saveUpstream(store, input, existing) {
  const id = existing?.id ?? randomUUID();
  const kind = input.kind;
  check(['ai', 'http'].includes(kind), '请选择上游协议。');
  const authHeader = input.authHeader ? str(input.authHeader, '鉴权 Header', 80).toLowerCase() : '';
  const authPrefix = typeof input.authPrefix === 'string' ? input.authPrefix : '';
  try {
    if (authHeader) validateHeaderName(authHeader);
    validateHeaderValue('authorization', authPrefix);
  } catch { throw new HttpError(400, '鉴权 Header 名称或前缀无效。'); }
  check(!prohibitedHeaders.has(authHeader) && !authHeader.startsWith('x-forwarded-') && authPrefix.length <= 80,
    '该 Header 保留给网关使用，或前缀过长。');
  let credential = existing?.credential ?? '';
  if (input.secret !== undefined) {
    check(typeof input.secret === 'string' && input.secret.length <= 16000, '上游凭据无效。');
    try { validateHeaderValue('authorization', input.secret); } catch { throw new HttpError(400, '上游凭据不能作为 HTTP Header 使用。'); }
    credential = store.seal(input.secret, id);
  }
  check(!credential || authHeader, '保存了凭据时必须填写鉴权 Header。');
  const endpoints = Object.create(null);
  check(obj(input.endpoints), '请配置上游功能。');
  for (const [name, entry] of array(Object.entries(input.endpoints), '上游功能')) {
    slug(name, '功能名称');
    check(obj(entry) && methods.has(entry.method), '请选择有效的 HTTP 方法。');
    if (kind === 'ai') check(Object.hasOwn(aiPaths, name) && entry.method === 'POST', 'AI 功能须为 chat、responses 或 embeddings。');
    endpoints[name] = { method: entry.method, path: path(entry.path) };
  }
  const probeMethod = input.probeMethod ?? 'GET';
  check(['GET', 'HEAD'].includes(probeMethod) || (probeMethod === 'POST' && kind === 'ai' && Object.hasOwn(endpoints, 'chat')),
    'POST 探测仅适用于配置了对话功能的 AI 上游。');
  const upstream = {
    id, kind, name: str(input.name, '上游名称'), provider: str(input.provider, '提供方'),
    baseUrl: base(input.baseUrl), authHeader, authPrefix, credential, endpoints,
    defaultModel: kind === 'ai' && input.defaultModel ? str(input.defaultModel, '默认模型', 160) : '',
    probePath: input.probePath ? path(input.probePath) : probeMethod === 'POST' ? endpoints.chat.path : '',
    probeMethod,
    timeoutMs: integer(input.timeoutMs ?? 120000, 500, 600000, '调用超时'), enabled: input.enabled !== false
  };
  for (const group of store.list('group')) {
    const member = group.members.find((item) => item.id === id);
    if (!member) continue;
    check(compatible(group, upstream) && (kind !== 'ai' || member.model || upstream.defaultModel),
      `上游正在路由组「${group.name}」中使用，新配置须兼容该组的功能和模型。`, 409);
  }
  store.save('upstream', upstream);
  return publicUpstream(upstream);
}

export function saveGroup(store, input, existing) {
  const id = existing?.id ?? randomUUID();
  const kind = input.kind;
  check(['ai', 'http'].includes(kind) && (!existing || existing.kind === kind), '请选择路由协议，已创建路由的协议固定。');
  const alias = slug(input.alias, '对外别名');
  check(!store.list('group').some((group) => group.alias === alias && group.id !== id), '别名已被使用。', 409);
  const names = new Set();
  const operations = array(input.operations, '功能').map((entry) => {
    check(obj(entry) && methods.has(entry.method), '请选择有效的 HTTP 方法。');
    const name = slug(entry.name, '功能名称');
    check(!names.has(name), '功能名称重复。');
    names.add(name);
    if (kind === 'ai') check(Object.hasOwn(aiPaths, name) && entry.method === 'POST', 'AI 功能须为 chat、responses 或 embeddings。');
    return { name, method: entry.method };
  });
  const group = {
    id, kind, alias, name: str(input.name, '路由名称'), operations, enabled: input.enabled !== false,
    probe: input.probe !== false,
    probeTimeoutMs: integer(input.probeTimeoutMs ?? 2500, 250, 10000, '探测超时'),
    timeoutMs: integer(input.timeoutMs ?? 120000, 1000, 600000, '总超时'),
    replay: kind === 'ai' ? input.replay !== false : input.replay === true
  };
  const seen = new Set();
  group.members = array(input.members, '上游成员', 12).map((member) => {
    check(obj(member) && typeof member.id === 'string' && !seen.has(member.id), '请选择不同的上游服务。');
    seen.add(member.id);
    const upstream = store.get('upstream', member.id);
    check(compatible(group, upstream), `每个上游都须支持本组配置的功能和方法${upstream ? `（${upstream.name}）` : ''}。`);
    const model = kind === 'ai' && member.model ? str(member.model, '覆盖模型', 160) : '';
    check(kind !== 'ai' || model || upstream.defaultModel, `请为 ${upstream.name} 指定模型。`);
    return { id: upstream.id, model };
  });
  if (existing) {
    const removed = existing.operations.filter((operation) => !operations.some((entry) =>
      entry.name === operation.name && entry.method === operation.method));
    check(!store.list('key').some((key) => removed.some(({ name }) => key.scopes.includes(scopeFor(group, name)))),
      '有 Key 已获授此功能。请先修改其权限，再移除功能或改变方法。', 409);
  }
  store.save('group', group);
  return group;
}

export function saveKey(store, input, existing) {
  const secret = existing ? null : token('ooa_');
  const scopes = [...new Set(array(input.scopes, '授权功能', 240))];
  const options = new Set(store.list('group').flatMap((group) => group.operations.map(({ name }) => scopeFor(group, name))));
  check(scopes.every((scope) => options.has(scope)), '所选功能已不存在。');
  const expiresAt = input.expiresAt == null ? null : integer(input.expiresAt, 1, 8.64e15, '过期时间');
  const key = {
    id: existing?.id ?? randomUUID(), name: str(input.name, 'Key 名称'), scopes, expiresAt,
    rpm: integer(input.rpm ?? 60, 1, 10000, '每分钟请求量'), enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now(), hash: existing?.hash ?? digest(secret),
    prefix: existing?.prefix ?? secret.slice(0, 12)
  };
  store.save('key', key);
  return { ...publicKey(key, store), ...(secret ? { secret } : {}) };
}

export function removeRecord(store, kind, id) {
  if (kind === 'upstream') check(!store.list('group').some((group) => group.members.some((member) => member.id === id)),
    '请先从引用该上游的路由组移除它。', 409);
  if (kind === 'group') check(!store.list('key').some((key) => key.scopes.some((scope) => scope.startsWith(`${id}:`))),
    '请先修改或删除引用此路由组的 Key。', 409);
  store.remove(kind, id);
}
