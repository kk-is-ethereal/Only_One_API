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
    const [chinese, english] = Array.isArray(message) ? message : [message];
    super(chinese);
    this.english = english;
    this.status = status;
    this.code = code;
  }
}

function check(ok, message, status = 400) {
  if (!ok) throw new HttpError(status, message);
}

function str(value, [zh, en], max = 120) {
  check(typeof value === 'string' && value.trim() && value.length <= max,
    [`${zh}不能为空，且最多 ${max} 个字符。`, `${en} is required and must be at most ${max} characters.`]);
  return value.trim();
}

function integer(value, min, max, [zh, en]) {
  check(Number.isInteger(value) && value >= min && value <= max,
    [`${zh}须在 ${min} 到 ${max} 之间。`, `${en} must be an integer between ${min} and ${max}.`]);
  return value;
}

function array(value, [zh, en], max = 24) {
  check(Array.isArray(value) && value.length > 0 && value.length <= max,
    [`${zh}须选择 1 到 ${max} 项。`, `Select between 1 and ${max} items for ${en}.`]);
  return value;
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function slug(value, [zh, en]) {
  check(typeof value === 'string' && slugPattern.test(value),
    [`${zh}仅支持小写字母、数字、下划线和短横线，最多 48 个字符。`,
      `${en} must start with a lowercase letter or digit and use at most 48 lowercase letters, digits, underscores, or hyphens.`]);
  return value;
}

function path(value) {
  check(typeof value === 'string' && /^\/(?:[a-zA-Z0-9_.~/-]{0,499})$/.test(value) &&
    !value.includes('//') && !value.split('/').some((part) => part === '.' || part === '..'), ['上游路径必须以 / 开头，且不能包含查询参数或路径跳转。', 'The upstream path must start with / and cannot contain a query string or path traversal.']);
  return value;
}

function base(value) {
  const input = str(value, ['上游地址', 'Upstream URL'], 512);
  let url;
  try { url = new URL(input); } catch { throw new HttpError(400, ['请输入有效的上游 URL。', 'Enter a valid upstream URL.']); }
  check(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/.test(input),
    ['上游地址须为 HTTP(S)，且不能包含用户信息、查询或片段。', 'The upstream URL must use HTTP or HTTPS and cannot include user info, a query, or a fragment.']);
  const href = url.href;
  let end = href.length;
  while (href[end - 1] === '/') end -= 1;
  return href.slice(0, end);
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
  check(['ai', 'http'].includes(kind), ['请选择上游协议。', 'Choose an upstream protocol.']);
  const authHeader = input.authHeader ? str(input.authHeader, ['鉴权 Header', 'Auth header'], 80).toLowerCase() : '';
  const authPrefix = typeof input.authPrefix === 'string' ? input.authPrefix : '';
  try {
    if (authHeader) validateHeaderName(authHeader);
    validateHeaderValue('authorization', authPrefix);
  } catch { throw new HttpError(400, ['鉴权 Header 名称或前缀无效。', 'The auth header name or prefix is invalid.']); }
  check(!prohibitedHeaders.has(authHeader) && !authHeader.startsWith('x-forwarded-') && authPrefix.length <= 80,
    ['该 Header 保留给网关使用，或前缀过长。', 'This header is reserved by the gateway or the prefix is too long.']);
  let credential = existing?.credential ?? '';
  if (input.secret !== undefined) {
    check(typeof input.secret === 'string' && input.secret.length <= 16000, ['上游凭据无效。', 'The upstream credential is invalid.']);
    try { validateHeaderValue('authorization', input.secret); } catch { throw new HttpError(400, ['上游凭据不能作为 HTTP Header 使用。', 'The upstream credential cannot be used as an HTTP header value.']); }
    credential = store.seal(input.secret, id);
  }
  check(!credential || authHeader, ['保存了凭据时必须填写鉴权 Header。', 'An auth header is required when a credential is saved.']);
  const endpoints = Object.create(null);
  check(obj(input.endpoints), ['请配置上游功能。', 'Configure the upstream operations.']);
  for (const [name, entry] of array(Object.entries(input.endpoints), ['上游功能', 'upstream operations'])) {
    slug(name, ['功能名称', 'Operation name']);
    check(obj(entry) && methods.has(entry.method), ['请选择有效的 HTTP 方法。', 'Select a valid HTTP method.']);
    if (kind === 'ai') check(Object.hasOwn(aiPaths, name) && entry.method === 'POST', ['AI 功能须为 chat、responses 或 embeddings。', 'AI operations must use POST and be named chat, responses, or embeddings.']);
    endpoints[name] = { method: entry.method, path: path(entry.path) };
  }
  const probeMethod = input.probeMethod ?? 'GET';
  check(['GET', 'HEAD'].includes(probeMethod) || (probeMethod === 'POST' && kind === 'ai' && Object.hasOwn(endpoints, 'chat')),
    ['POST 探测仅适用于配置了对话功能的 AI 上游。', 'POST probes require an AI upstream with a chat operation.']);
  const upstream = {
    id, kind, name: str(input.name, ['上游名称', 'Upstream name']), provider: str(input.provider, ['提供方', 'Provider']),
    baseUrl: base(input.baseUrl), authHeader, authPrefix, credential, endpoints,
    defaultModel: kind === 'ai' && input.defaultModel ? str(input.defaultModel, ['默认模型', 'Default model'], 160) : '',
    probePath: input.probePath ? path(input.probePath) : probeMethod === 'POST' ? endpoints.chat.path : '',
    probeMethod,
    timeoutMs: integer(input.timeoutMs ?? 120000, 500, 600000, ['调用超时', 'Upstream timeout']), enabled: input.enabled !== false
  };
  for (const group of store.list('group')) {
    const member = group.members.find((item) => item.id === id);
    if (!member) continue;
    check(compatible(group, upstream) && (kind !== 'ai' || member.model || upstream.defaultModel),
      [`上游正在路由组「${group.name}」中使用，新配置须兼容该组的功能和模型。`,
        `This upstream is used by “${group.name}”. Its configuration must remain compatible with that group's operations and model.`], 409);
  }
  store.save('upstream', upstream);
  return publicUpstream(upstream);
}

export function saveGroup(store, input, existing) {
  const id = existing?.id ?? randomUUID();
  const kind = input.kind;
  check(['ai', 'http'].includes(kind) && (!existing || existing.kind === kind), ['请选择路由协议，已创建路由的协议固定。', 'Choose a route protocol. A route\'s protocol is fixed after creation.']);
  const alias = slug(input.alias, ['对外别名', 'Public alias']);
  check(!store.list('group').some((group) => group.alias === alias && group.id !== id), ['别名已被使用。', 'This alias is already in use.'], 409);
  const names = new Set();
  const operations = array(input.operations, ['功能', 'operations']).map((entry) => {
    check(obj(entry) && methods.has(entry.method), ['请选择有效的 HTTP 方法。', 'Select a valid HTTP method.']);
    const name = slug(entry.name, ['功能名称', 'Operation name']);
    check(!names.has(name), ['功能名称重复。', 'Operation names must be unique.']);
    names.add(name);
    if (kind === 'ai') check(Object.hasOwn(aiPaths, name) && entry.method === 'POST', ['AI 功能须为 chat、responses 或 embeddings。', 'AI operations must use POST and be named chat, responses, or embeddings.']);
    return { name, method: entry.method };
  });
  const group = {
    id, kind, alias, name: str(input.name, ['路由名称', 'Route name']), operations, enabled: input.enabled !== false,
    probe: input.probe !== false,
    probeTimeoutMs: integer(input.probeTimeoutMs ?? 2500, 250, 10000, ['探测超时', 'Probe timeout']),
    timeoutMs: integer(input.timeoutMs ?? 120000, 1000, 600000, ['总超时', 'Total timeout']),
    replay: kind === 'ai' ? input.replay !== false : input.replay === true
  };
  const seen = new Set();
  group.members = array(input.members, ['上游成员', 'upstream members'], 12).map((member) => {
    check(obj(member) && typeof member.id === 'string' && !seen.has(member.id), ['请选择不同的上游服务。', 'Select distinct upstreams.']);
    seen.add(member.id);
    const upstream = store.get('upstream', member.id);
    check(compatible(group, upstream), [`每个上游都须支持本组配置的功能和方法${upstream ? `（${upstream.name}）` : ''}。`,
      `Every upstream must support the group's operations and methods${upstream ? ` (${upstream.name})` : ''}.`]);
    const model = kind === 'ai' && member.model ? str(member.model, ['覆盖模型', 'Model override'], 160) : '';
    check(kind !== 'ai' || model || upstream.defaultModel, [`请为 ${upstream.name} 指定模型。`, `Set a model for ${upstream.name}.`]);
    return { id: upstream.id, model };
  });
  if (existing) {
    const removed = existing.operations.filter((operation) => !operations.some((entry) =>
      entry.name === operation.name && entry.method === operation.method));
    check(!store.list('key').some((key) => removed.some(({ name }) => key.scopes.includes(scopeFor(group, name)))),
      ['有 Key 已获授此功能。请先修改其权限，再移除功能或改变方法。', 'An API key has access to this operation. Update its permissions before removing the operation or changing its method.'], 409);
  }
  store.save('group', group);
  return group;
}

export function saveKey(store, input, existing) {
  const secret = existing ? null : token('ooa_');
  const scopes = [...new Set(array(input.scopes, ['授权功能', 'allowed operations'], 240))];
  const options = new Set(store.list('group').flatMap((group) => group.operations.map(({ name }) => scopeFor(group, name))));
  check(scopes.every((scope) => options.has(scope)), ['所选功能已不存在。', 'A selected operation no longer exists.']);
  const expiresAt = input.expiresAt == null ? null : integer(input.expiresAt, 1, 8.64e15, ['过期时间', 'Expiration']);
  const key = {
    id: existing?.id ?? randomUUID(), name: str(input.name, ['Key 名称', 'Key name']), scopes, expiresAt,
    rpm: integer(input.rpm ?? 60, 1, 10000, ['每分钟请求量', 'Requests per minute']), enabled: input.enabled !== false,
    createdAt: existing?.createdAt ?? Date.now(), hash: existing?.hash ?? digest(secret),
    prefix: existing?.prefix ?? secret.slice(0, 12)
  };
  store.save('key', key);
  return { ...publicKey(key, store), ...(secret ? { secret } : {}) };
}

export function removeRecord(store, kind, id) {
  if (kind === 'upstream') check(!store.list('group').some((group) => group.members.some((member) => member.id === id)),
    ['请先从引用该上游的路由组移除它。', 'Remove this upstream from its route groups first.'], 409);
  if (kind === 'group') check(!store.list('key').some((key) => key.scopes.some((scope) => scope.startsWith(`${id}:`))),
    ['请先修改或删除引用此路由组的 Key。', 'Update or delete the API keys that reference this route group first.'], 409);
  store.remove(kind, id);
}
