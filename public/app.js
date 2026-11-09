import { locale, setLocale, t } from './i18n.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tabs = { overview: '总览', upstreams: '上游服务', groups: '路由组', keys: 'API Key', logs: '调用日志' };
const editorTitles = { upstreams: ['新建上游', '编辑上游'], groups: ['新建路由组', '编辑路由组'], keys: ['签发 API Key', '编辑 API Key'] };
const aiPaths = { chat: '/chat/completions', responses: '/responses', embeddings: '/embeddings' };
const aiLabels = { chat: '对话', responses: 'Responses', embeddings: '向量嵌入' };
const methods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const content = $('#content');
const dialog = $('#editor');
const editor = $('#editor-form');
const e = escapeHtml;
const opts = (options, value) => options.map(([id, name]) => `<option value="${e(id)}" ${id === value ? 'selected' : ''}>${e(name)}</option>`).join('');
const input = (name, value = '', attrs = '') => `<input name="${name}" value="${e(value)}" ${attrs}>`;
const select = (name, options, value, attrs = '') => `<select name="${name}" ${attrs}>${opts(options, value)}</select>`;
const field = (label, control, wide = false) => `<label${wide ? ' class="wide"' : ''}>${label}${control}</label>`;
const checkbox = (name, label, checked) => `<label class="inline-check"><input type="checkbox" name="${e(name)}" ${checked ? 'checked' : ''}>${e(label)}</label>`;
const button = (action, label, cls = 'small', id = '') => `<button type="button" data-action="${action}" data-id="${e(id)}" class="${cls}">${label}</button>`;
const chip = (label, cls = '') => `<span class="pill ${cls}">${e(label)}</span>`;
const status = (enabled) => enabled ? chip(t('启用'), 'good') : chip(t('停用'), 'neutral');
const sub = (value) => `<span class="sub">${e(value)}</span>`;
const date = (value) => value ? new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'medium' }).format(value) : '—';
const kindLabel = (kind) => kind === 'ai' ? t('OpenAI 兼容') : t('HTTP 反代');
const groupEndpoint = (group, name) => group.kind === 'ai' ? `/v1${aiPaths[name]}` : `/api/${group.alias}/${name}`;
const find = (resource, id) => state[resource].find((item) => item.id === id);
const operationLabel = (group, name) => group.kind === 'ai' ? t(aiLabels[name]) : name;
let state;
let active = 'overview';
let edit;
let filters = { route: '', failed: false };
let logs = [];
let toastTimer;

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-ooa-admin': '1', 'x-ooa-language': locale() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/admin/login') showLogin();
    throw Object.assign(new Error(data.error?.message ?? `HTTP ${response.status}`), { status: response.status });
  }
  return data;
}

function renderLanguage() {
  document.documentElement.lang = locale();
  document.title = `Only_One_API · ${t('网关管理台')}`;
  for (const node of $$('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const [key, attribute] of [['label', 'aria-label'], ['placeholder', 'placeholder'], ['content', 'content']]) {
    for (const node of $$(`[data-i18n-${key}]`)) node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${key}`)));
  }
  for (const control of $$('[data-language]')) control.value = locale();
}

function notify(message) {
  const toast = $('#toast');
  toast.className = 'toast';
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function showLogin() {
  dialog.close();
  editor.replaceChildren();
  $('#app').hidden = true;
  $('#login').hidden = false;
}

async function refresh() {
  state = await api('/admin/state');
  if (active === 'logs') await loadLogs();
  $('#login').hidden = true;
  $('#app').hidden = false;
  render();
}

async function loadLogs() {
  const params = new URLSearchParams({ route: filters.route, failed: filters.failed ? '1' : '0' });
  logs = await api(`/admin/logs?${params}`);
}

function page(kicker, title, description, action = '') {
  return `<div class="page-head"><div><p class="eyebrow">${kicker}</p><h1>${title}</h1><p class="muted">${description}</p></div>${action}</div>`;
}

function empty(title, description, action = '') {
  return `<section class="empty"><h3>${title}</h3><p class="muted">${description}</p>${action}</section>`;
}

function table(columns, rows) {
  return `<div class="table-wrap"><table><thead><tr>${columns.map((name) => `<th scope="col">${name}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function overview() {
  const { stats, upstreams, groups, keys } = state;
  const success = stats.total ? `${(100 * stats.successful / stats.total).toFixed(1)}%` : '—';
  const metrics = [[t('启用的上游'), `${upstreams.filter((item) => item.enabled).length} / ${upstreams.length}`],
    [t('请求数 · 24 小时'), stats.total], [t('成功率 · 24 小时'), success], [t('切换次数 · 24 小时'), stats.fallbacks]];
  const steps = [['01', t('录入一个上游服务'), 'upstreams', upstreams.length], ['02', t('配置路由组与优先级'), 'groups', groups.length],
    ['03', t('勾选功能并签发 Key'), 'keys', keys.length]];
  return page('WORKSPACE', t('网关总览'), t('在同一个入口管理上游、故障切换和 API 权限。')) +
    `<section class="hero"><div><p class="eyebrow">UNIFIED API</p><h2>${t('一个地址，按功能授权')}</h2><p>${t('AI 客户端连接兼容接口，其他应用通过固定路由访问反代服务。')}</p></div>
    ${button('copy-base', t('复制 AI Base URL'), '')}</section>
    <div class="metrics">${metrics.map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('')}</div>
    <div class="panels"><section class="panel"><h3>${t('快速配置')}</h3><ol class="steps">${steps.map(([num, label, tab, count]) =>
      `<li><span class="step">${num}</span><p>${label}${sub(count ? t('已配置 {count} 项', { count }) : t('待配置'))}</p>${button('go', t('打开 →'), 'small', tab)}</li>`).join('')}</ol></section>
    <section class="panel"><h3>${t('调用入口')}</h3><div class="endpoints"><div class="endpoint"><strong>AI Base URL</strong><code>${e(location.origin)}/v1</code></div>
    <div class="endpoint"><strong>${t('模型列表')}</strong><code>GET /v1/models</code></div><div class="endpoint"><strong>${t('HTTP 反代')}</strong><code>${t('/api/{路由别名}/{功能名}')}</code></div></div></section></div>`;
}

function rowActions(id, probe = false) {
  return `<div class="actions">${probe ? button('probe', t('探测'), 'small', id) : ''}${button('edit', t('编辑'), 'small', id)}${button('delete', t('删除'), 'small danger', id)}</div>`;
}

function upstreamsPage() {
  const add = button('new', t('＋ 新建上游'), 'primary');
  return page('UPSTREAMS', t('上游服务'), t('保存提供方、认证凭据、模型、接口路径及健康探测设置。'), add) +
    (state.upstreams.length ? table([t('服务 / 提供方'), t('连接地址'), t('功能 / 探测'), t('状态'), t('操作')], state.upstreams.map((item) => [
      `<strong>${e(item.name)}</strong>${sub(`${item.provider} · ${kindLabel(item.kind)}`)}`,
      `<code>${e(item.baseUrl)}</code>${sub(item.defaultModel || (item.hasCredential ? t('已配置鉴权') : t('无凭据')))}`,
      `${e(Object.keys(item.endpoints).join('、'))}${sub(item.probePath ? `${item.probeMethod} ${item.probePath}` : t('使用实际请求判断状态'))}`,
      status(item.enabled), rowActions(item.id, true)
    ])) : empty(t('还没有上游服务'), t('选择 OpenAI 兼容或通用 HTTP，填写服务的连接地址。'), add));
}

function groupsPage() {
  const add = button('new', t('＋ 新建路由组'), 'primary');
  return page('ROUTING', t('路由组'), t('将多个服务排成优先级队列，并用一个别名对外调用。'), add) +
    (state.groups.length ? table([t('路由 / 别名'), t('对外功能'), t('优先级队列'), t('状态'), t('操作')], state.groups.map((group) => [
      `<strong>${e(group.name)}</strong>${sub(`${group.alias} · ${kindLabel(group.kind)}`)}`,
      group.operations.map(({ name, method }) => `<code>${e(method)} ${e(groupEndpoint(group, name))}</code>`).join('<br>'),
      group.members.map(({ id, model }, index) => sub(`${index + 1}. ${find('upstreams', id)?.name ?? id}${model ? ` · ${model}` : ''}`)).join(''),
      `${status(group.enabled)}${sub(group.probe ? t('请求前探测已启用') : t('直接调用'))}`, rowActions(group.id)
    ])) : empty(t('还没有路由组'), t('配置路由后，即可生成有权限的 API Key。'), add));
}

function keysPage() {
  const add = button('new', t('＋ 签发 Key'), 'primary');
  return page('ACCESS', 'API Key', t('为应用分别签发密钥，按功能授权，并设置有效期及调用限额。'), add) +
    (state.keys.length ? table([t('名称 / 前缀'), t('授权功能'), t('限额 / 到期'), t('状态 / 最近调用'), t('操作')], state.keys.map((key) => [
      `<strong>${e(key.name)}</strong>${sub(`${key.prefix}…`)}`,
      key.scopes.map((scope) => { const [id, op] = scope.split(':'); return sub(`${find('groups', id)?.alias ?? id} / ${op}`); }).join(''),
      `${t('{count} 次 / 分钟', { count: key.rpm })}${sub(key.expiresAt ? date(key.expiresAt) : t('长期有效'))}`,
      `${key.expiresAt && key.expiresAt <= Date.now() ? chip(t('已过期'), 'bad') : status(key.enabled)}${sub(date(key.lastUsed))}`, rowActions(key.id)
    ])) : empty(t('还没有 API Key'), t('签发时选择允许调用的路由功能。'), add));
}

const outcomes = { skipped: '无独立探测', healthy: '通过', unhealthy: '探测异常', timeout: '超时', unreachable: '连接失败', model_required: '请先填写默认模型',
  probe_failed: '跳过', retryable: '可切换故障', upstream_error: '上游错误', disabled: '已停用', success: '成功', interrupted: '流中断' };
const outcomeLabel = (result) => t(outcomes[result] ?? result ?? '—');

function logsPage() {
  const aliases = [...new Set([...state.groups.map(({ alias }) => alias), ...logs.map(({ route }) => route), filters.route])].filter(Boolean);
  return page('OBSERVABILITY', t('调用日志'), t('查询最近请求的状态、耗时与上游切换过程。')) +
    `<div class="filter">${select('route', [['', t('全部路由')], ...aliases.map((alias) => [alias, alias])], filters.route, `aria-label="${e(t("筛选路由"))}"`)}
    ${checkbox('failed', t('仅失败请求'), filters.failed)}</div>` +
    (logs.length ? table([t('时间 / 请求 ID'), t('路由 / Key'), t('状态'), t('耗时'), t('上游尝试')], logs.map((item) => [
      `${date(item.at)}${sub(item.id)}`, `<strong>${e(item.route)} / ${e(item.operation)}</strong>${sub(item.key)}`,
      `${chip(item.status, item.status < 400 ? 'good' : 'bad')}${item.fallback ? ` ${chip(t('已切换'))}` : ''}`,
      `${item.ms} ms`, item.attempts.length ? `<details class="log-attempts"><summary>${e(item.upstream || t('未转发'))} · ${t('{count} 条', { count: item.attempts.length })}</summary>
      <ol>${item.attempts.map((entry) => `<li>${e(entry.upstream)} · ${e(outcomeLabel(entry.result))} ${entry.status ?? ''}
      ${entry.probe ? sub(`${t('探测{result}', { result: outcomeLabel(entry.probe.result) })} ${entry.probe.status ?? ''} · ${entry.probe.ms} ms`) : ''}</li>`).join('')}</ol></details>` : '—'
    ])) : empty(t('暂无符合条件的调用'), t('使用已授权的 Key 发起请求后，记录会显示在这里。')));
}

function render() {
  const pages = { overview, upstreams: upstreamsPage, groups: groupsPage, keys: keysPage, logs: logsPage };
  $('#crumb').textContent = t(tabs[active]);
  for (const tab of $$('[data-tab]')) {
    if (tab.dataset.tab === active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  content.innerHTML = pages[active]();
}

const choices = (values) => values.map((value) => [value, value]);
const kindChoices = () => [['ai', kindLabel('ai')], ['http', kindLabel('http')]];
const probeChoices = (kind) => kind === 'ai' ? [['GET', 'GET'], ['HEAD', 'HEAD'], ['POST', t('POST 最小对话')]] : choices(['GET', 'HEAD']);
const numeric = (name, value, min, max) => input(name, value, `type="number" required min="${min}" max="${max}"`);
const section = (label, hint, list, action, labelButton) => `<div class="form-section"><div class="section-head"><h3>${label}</h3>
  ${button(action, labelButton)}</div><p class="hint">${hint}</p><div data-list="${list}"></div></div>`;

function operationRow(kind, upstream, item = {}) {
  const name = kind === 'ai' ? select('opName', Object.entries(aiLabels).map(([id, label]) => [id, t(label)]), item.name ?? 'chat', `aria-label="${e(t('AI 功能'))}"`) :
    input('opName', item.name, `required placeholder="${e(t("功能名，如 lookup"))}" aria-label="${e(t("功能名"))}"`);
  const method = kind === 'ai' ? input('opMethod', 'POST', 'type="hidden"') :
    select('opMethod', choices(methods), item.method ?? 'GET', `class="method" aria-label="${e(t("HTTP 方法"))}"`);
  return `<div class="row">${name}${method}${upstream ? input('opPath', item.path ?? (kind === 'ai' ? aiPaths[item.name ?? 'chat'] : ''),
    `required placeholder="${e(t("上游路径，如 /lookup"))}" aria-label="${e(t("上游路径"))}"`) : ''}${button('remove-row', t('移除'))}</div>`;
}

function memberRow(kind, item = {}) {
  const available = state.upstreams.filter((entry) => entry.kind === kind);
  return `<div class="row">${select('memberId', [['', t('选择上游')], ...available.map(({ id, name }) => [id, name])], item.id ?? '',
    `required aria-label="${e(t("上游成员"))}"`)}${kind === 'ai' ? input('memberModel', item.model, `placeholder="${e(t("覆盖模型（可选）"))}" aria-label="${e(t("覆盖模型"))}"`) : ''}
    ${button('up-row', '↑')}${button('down-row', '↓')}${button('remove-row', t('移除'))}</div>`;
}

function upstreamForm(item) {
  const kind = item.kind ?? 'ai';
  return `<div class="form-grid">
    ${field(t('接入协议'), select('kind', kindChoices(), kind), true)}
    ${field(t('上游名称'), input('name', item.name, `required maxlength="120" placeholder="${e(t("如 主线路"))}"`))}
    ${field(t('提供方'), input('provider', item.provider, `required maxlength="120" placeholder="${e(t("如 内部服务"))}"`))}
    <label class="wide" ${kind === 'http' ? 'hidden' : ''}>${t('默认模型')}${input('defaultModel', item.defaultModel, `maxlength="160" placeholder="${e(t('填上游的真实模型 ID'))}" ${kind === 'http' ? 'disabled' : ''}`)}</label>
    ${field('Base URL', input('baseUrl', item.baseUrl, 'required type="url" placeholder="https://provider.example/v1"'), true)}
    ${field(t('鉴权 Header'), input('authHeader', item.authHeader ?? 'Authorization', `placeholder="${e(t("如 Authorization / Cookie"))}"`))}
    ${field(t('鉴权前缀（可选）'), input('authPrefix', item.authPrefix ?? 'Bearer ', `placeholder="${e(t("如 Bearer 加空格"))}"`))}
    ${field(t('上游凭据'), input('secret', '', `type="password" autocomplete="new-password" placeholder="${item.hasCredential ? t('已保存，留空则保留') : t('填写服务端 API Key 或授权凭据')}"`), true)}
    ${item.hasCredential ? checkbox('clearSecret', t('清除已保存凭据'), false) : ''}
    ${field(t('探测路径（可选）'), input('probePath', item.probePath, `placeholder="${e(t("如 /models 或 /health"))}"`))}
    ${field(t('探测方法'), select('probeMethod', probeChoices(kind), item.probeMethod ?? 'GET'))}
    ${field(t('单上游超时（毫秒）'), numeric('timeoutMs', item.timeoutMs ?? 120000, 500, 600000))}
  </div><p class="hint">${t('GET / HEAD 路径留空时使用实际请求判断。')} <span data-ai-probe-hint ${kind === 'http' ? 'hidden' : ''}>${t('POST 使用对话路径发送最小请求，可能产生费用。')}</span></p>
  ${section(t('上游功能'), t('路径相对于 Base URL。HTTP 反代通过这些固定路径转发。'), 'operations', 'add-op', t('＋ 添加功能'))}
  ${checkbox('enabled', t('启用上游'), item.enabled !== false)}`;
}

function groupForm(item) {
  const kind = item.kind ?? 'ai';
  return `<div class="form-grid">
    ${field(t('路由名称'), input('name', item.name, `required maxlength="120" placeholder="${e(t("如 日常对话"))}"`))}
    ${field(t('对外别名'), input('alias', item.alias, `required maxlength="48" pattern="[a-z0-9][a-z0-9_\\-]{0,47}" placeholder="${e(t("如 chat-main"))}"`))}
    ${field(t('协议'), select('kind', kindChoices(), kind, item.id ? 'disabled' : ''))}
    ${field(t('总超时（毫秒）'), numeric('timeoutMs', item.timeoutMs ?? 120000, 1000, 600000))}
    ${field(t('每次探测超时（毫秒）'), numeric('probeTimeoutMs', item.probeTimeoutMs ?? 2500, 250, 10000))}
  </div>
  ${section(t('对外功能'), t('每个成员均须配置相同的功能和 HTTP 方法。AI 客户端用组别名作为 model。'), 'operations', 'add-op', t('＋ 添加功能'))}
  ${section(t('上游成员'), t('从上到下依次尝试。箭头可调整优先级，覆盖模型留空时使用上游默认值。'), 'members', 'add-member', t('＋ 添加上游'))}
  ${checkbox('probe', t('每次调用前探测已配置探测路径的候选上游'), item.probe !== false)}
  ${checkbox('replay', t('实际写请求失败后允许转到下一线路（可能重复执行或计费）'), item.replay ?? kind === 'ai')}
  ${checkbox('enabled', t('启用路由'), item.enabled !== false)}`;
}

function localDateTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function keyForm(item) {
  return `<div class="form-grid">
    ${field(t('Key 名称'), input('name', item.name, `required maxlength="120" placeholder="${e(t("如 工作台 · 对话"))}"`))}
    ${field(t('请求上限（次 / 分钟）'), numeric('rpm', item.rpm ?? 60, 1, 10000))}
    ${field(t('过期时间（可选，本地时间）'), input('expiresAt', localDateTime(item.expiresAt), 'type="datetime-local"'))}
  </div><section class="form-section"><h3>${t('授权功能')}</h3><div class="checks">${state.groups.length ? state.groups.flatMap((group) => group.operations.map(({ name }) => {
    const scope = `${group.id}:${name}`;
    return `<label><input type="checkbox" name="scope" value="${scope}" ${item.scopes?.includes(scope) ? 'checked' : ''}>
      ${e(group.name)} · ${e(operationLabel(group, name))} <code>${e(groupEndpoint(group, name))}</code></label>`;
  })).join('') : `<p class="hint">${t('请先创建至少一个路由组。')}</p>`}</div></section>
  ${checkbox('enabled', t('启用 Key'), item.enabled !== false)}`;
}

function addRow(list, html) { $(`[data-list="${list}"]`, editor).insertAdjacentHTML('beforeend', html); }

function showEditor(resource, item = {}) {
  edit = { resource, id: item.id, mode: 'edit' };
  const forms = { upstreams: upstreamForm, groups: groupForm, keys: keyForm };
  $('#editor-title').textContent = t(editorTitles[resource][Number(Boolean(item.id))]);
  editor.innerHTML = `${forms[resource](item)}<p class="error" role="alert"></p><div class="form-footer">${button('close', t('取消'), '')}
    <button type="submit" class="primary">${resource === 'keys' && !item.id ? t('生成 Key') : t('保存')}</button></div>`;
  if (resource !== 'keys') {
    const kind = item.kind ?? 'ai';
    const upstream = resource === 'upstreams';
    const operations = upstream ? Object.entries(item.endpoints ?? {}).map(([name, endpoint]) => ({ name, ...endpoint })) : (item.operations ?? []);
    for (const op of operations.length ? operations : [{}]) addRow('operations', operationRow(kind, upstream, op));
    if (!upstream) for (const member of item.members ?? [{}]) addRow('members', memberRow(kind, member));
  }
  dialog.showModal();
}

function formData() {
  const data = new FormData(editor);
  const get = (name) => data.get(name);
  const base = { name: get('name'), enabled: data.has('enabled') };
  if (edit.resource === 'keys') return { ...base, scopes: data.getAll('scope'), rpm: Number(get('rpm')),
    expiresAt: get('expiresAt') ? new Date(get('expiresAt')).valueOf() : null };
  const kind = editor.elements.kind.value;
  const operations = $$('[data-list="operations"] .row', editor).map((row) => ({
    name: $('[name="opName"]', row).value, method: $('[name="opMethod"]', row).value, path: $('[name="opPath"]', row)?.value
  }));
  if (edit.resource === 'groups') return { ...base, kind, operations, alias: get('alias'), timeoutMs: Number(get('timeoutMs')),
    probe: data.has('probe'), replay: data.has('replay'), probeTimeoutMs: Number(get('probeTimeoutMs')),
    members: $$('[data-list="members"] .row', editor).map((row) => ({ id: $('[name="memberId"]', row).value,
      model: $('[name="memberModel"]', row)?.value })) };
  const endpoints = Object.fromEntries(operations.map(({ name, method, path }) => [name, { method, path }]));
  if (Object.keys(endpoints).length !== operations.length) throw new Error(t('上游功能名不能重复。'));
  return { ...base, kind, endpoints, provider: get('provider'), baseUrl: get('baseUrl'), authHeader: get('authHeader'),
    authPrefix: get('authPrefix'), defaultModel: get('defaultModel'), probePath: get('probePath'), probeMethod: get('probeMethod'),
    timeoutMs: Number(get('timeoutMs')), secret: data.has('clearSecret') ? '' : get('secret') || undefined };
}

function confirmDelete(id) {
  const item = find(active, id);
  edit = { resource: active, id, mode: 'delete' };
  $('#editor-title').textContent = t('删除记录');
  editor.innerHTML = `<div class="confirm-box"><p>${e(t('确定删除「{name}」？', { name: item.name }))}</p><p class="error" role="alert"></p>
    <div class="form-footer">${button('close', t('取消'), '')}<button class="danger" type="submit">确认删除</button></div></div>`;
  dialog.showModal();
}

function showSecret(secret) {
  $('#editor-title').textContent = t('API Key 已签发');
  editor.innerHTML = `<p class="muted">${t('完整密钥仅在此显示一次。请复制并保存。')}</p>
    ${field('API Key', input('generated', secret, 'class="secret-value" readonly'))}
    <div class="form-footer">${button('close', t('完成'), '')}${button('copy-secret', t('复制密钥'), 'primary')}</div>`;
  dialog.showModal();
}

async function copy(value) {
  if (!navigator.clipboard) throw new Error(t('浏览器无法访问剪贴板，请手动复制。'));
  await navigator.clipboard.writeText(value);
  notify(t('已复制'));
}

async function navigate(tab) {
  active = tab;
  if (active === 'logs') await loadLogs();
  render();
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button[data-action],button[data-tab]');
  if (!target) return;
  const { action, id, tab } = target.dataset;
  const row = target.closest('.row');
  try {
    if (tab || action === 'go') return await navigate(tab || id);
    switch (action) {
      case 'new': return showEditor(active);
      case 'edit': return showEditor(active, find(active, id));
      case 'delete': return confirmDelete(id);
      case 'close': return dialog.close();
      case 'refresh': await refresh(); return notify(t('已刷新'));
      case 'logout': await api('/admin/logout', { method: 'POST' }); return showLogin();
      case 'copy-base': return await copy(`${location.origin}/v1`);
      case 'copy-secret': editor.elements.generated.select(); return await copy(editor.elements.generated.value);
      case 'remove-row': return row.remove();
      case 'up-row': if (row.previousElementSibling) row.previousElementSibling.before(row); return;
      case 'down-row': if (row.nextElementSibling) row.nextElementSibling.after(row); return;
      case 'add-op': return addRow('operations', operationRow(editor.elements.kind.value, edit.resource === 'upstreams'));
      case 'add-member': return addRow('members', memberRow(editor.elements.kind.value));
      case 'probe': {
        target.disabled = true;
        try {
          const result = await api(`/admin/upstreams/${id}/probe`, { method: 'POST' });
          return notify(`${outcomeLabel(result.result)}${result.status ? ` · HTTP ${result.status}` : ''} · ${result.ms} ms`);
        } finally { target.disabled = false; }
      }
    }
  } catch (error) { notify(error.message); }
});

function resetRows(kind) {
  const upstream = edit.resource === 'upstreams';
  $('[data-list="operations"]', editor).innerHTML = operationRow(kind, upstream);
  if (upstream) {
    const model = editor.elements.defaultModel;
    model.disabled = kind === 'http';
    model.closest('label').hidden = model.disabled;
    const probe = editor.elements.probeMethod;
    probe.innerHTML = opts(probeChoices(kind), probe.value);
    $('[data-ai-probe-hint]', editor).hidden = kind === 'http';
  } else {
    $('[data-list="members"]', editor).innerHTML = memberRow(kind);
    editor.elements.replay.checked = kind === 'ai';
  }
}

editor.addEventListener('change', ({ target }) => {
  if (target.name === 'kind') resetRows(target.value);
  if (target.name === 'opName' && target.tagName === 'SELECT') {
    const path = $('[name="opPath"]', target.closest('.row'));
    if (path) path.value = aiPaths[target.value];
  }
});

content.addEventListener('change', async ({ target }) => {
  if (active !== 'logs') return;
  if (target.name === 'route') filters.route = target.value;
  if (target.name === 'failed') filters.failed = target.checked;
  try { await loadLogs(); if (active === 'logs') render(); } catch (error) { notify(error.message); }
});

editor.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { resource, id, mode } = edit;
  const submit = event.submitter;
  const close = $$('.dialog-header button, #editor-form button[data-action="close"]', dialog);
  if (submit) submit.disabled = true;
  for (const button of close) button.disabled = true;
  const errorLine = $('.error', editor);
  errorLine.textContent = '';
  try {
    const path = `/admin/${resource}${id ? `/${id}` : ''}`;
    const result = await api(path, { method: mode === 'delete' ? 'DELETE' : id ? 'PUT' : 'POST', body: mode === 'delete' ? undefined : formData() });
    dialog.close();
    if (result.secret) showSecret(result.secret);
    else notify(mode === 'delete' ? t('已删除') : t('已保存'));
    try { await refresh(); } catch (error) { notify(error.message); }
  } catch (error) { errorLine.textContent = error.message; }
  finally {
    if (submit) submit.disabled = false;
    for (const button of close) button.disabled = false;
  }
});

dialog.addEventListener('cancel', (event) => {
  if ($('button[type="submit"]:disabled', editor)) event.preventDefault();
});
dialog.addEventListener('close', () => {
  if (!dialog.open) editor.replaceChildren();
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const errorLine = $('#login-error');
  errorLine.textContent = '';
  event.submitter.disabled = true;
  try {
    await api('/admin/login', { method: 'POST', body: { password: form.elements.password.value } });
    form.reset();
    await refresh();
  } catch (error) { errorLine.textContent = error.message; }
  finally { event.submitter.disabled = false; }
});

document.addEventListener('change', ({ target }) => {
  if (!target.matches('[data-language]')) return;
  setLocale(target.value);
  renderLanguage();
  $('#login-error').textContent = '';
  $('#toast').hidden = true;
  if (state && !$('#app').hidden) render();
});

renderLanguage();
try { await refresh(); } catch (error) {
  showLogin();
  if (error.status !== 401) $('#login-error').textContent = error.message;
}
