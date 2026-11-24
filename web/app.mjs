import { ApiClient } from './api.mjs';
import { loadHistory, renderHistory, renderEventDetail } from './history.mjs';
import { renderSupportDiagnostics } from './support.mjs';
import { renderFenceForm, syncFenceGeometry, fenceFormBody } from './fences.mjs';
import { renderOperations, renderTelemetryFailures } from './operations.mjs';
import { buildAccountExport } from './account-export.mjs';

const api = new ApiClient();
const intents = new WeakMap();
function intentKey(form, body) {
  const signature = JSON.stringify(body), previous = intents.get(form);
  if (previous?.signature === signature) return previous.key;
  const key = crypto.randomUUID(); intents.set(form, { signature, key }); return key;
}
const sendForm = (form, method, path, body) => api.send(method, path, body, intentKey(form, { method, path, body }));
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const paw = () => icon('paw', 'paw');
const types = { weight: '体重', feeding: '喂食', medication: '用药', grooming: '清洁护理', note: '日常笔记', toileting: '排泄', custom: '自定义' };
const species = { dog: '狗狗', cat: '猫咪', other: '其他宠物' };
const roles = { owner: '家庭所有者', caregiver: '照护者', viewer: '只读成员' };
const modes = { home_idle: '居家静息', home_active: '日常活动', boundary_watch: '边界关注', alert: '高频关注', low_power: '低功耗' };
const labels = { unknown: '未知', online: '在线', offline: '离线', fresh: '新鲜', stale: '已过期', missing: '暂无数据', partial: '部分覆盖', available: '完整覆盖', inside: '围栏内', outside: '围栏外', pending: '等待执行', applied: '已执行', failed: '执行失败', expired: '已过期', superseded: '已被替代', cancelled: '已取消', unconfigured: '尚未配置', simulator: '离线模拟器', device: '设备回执', default: '默认规则', device_unbound: '尚未绑定设备', device_status_unknown: '设备状态未知', device_offline: '设备离线', location_missing: '暂无位置', location_unusable: '位置暂不可用于追踪', geofence_unconfigured: '尚未设置启用围栏', geofence_state_unknown: '围栏状态待确认', reporting_unconfigured: '尚未设置上报策略', activity_missing: '活动数据缺失', activity_partial: '活动数据部分覆盖', period_not_completed: '当天尚未结束', period_not_started: '时段尚未开始', missing_metric: '缺少该指标数据', insufficient_coverage: '指标覆盖率不足 50%', insufficient_baseline: '合格基线不足 3 天', baseline_zero: '基线为零，无法计算百分比', ready: '可比较', insufficient_data: '数据不足', day_in_progress: '当天进行中', geofence_exit: '离开围栏', geofence_enter: '进入围栏', low_battery: '低电量', device_offline_event: '设备离线', location_unavailable: '位置不可用' };
const label = (value) => labels[value] ?? value ?? '暂无';
Object.assign(labels, { 'geofence.exited': '离开围栏', 'geofence.entered': '进入围栏', 'battery.low': '低电量', 'device.offline': '设备离线', 'location.stale': '定位过期' });
const fmt = (value, unit = '') => value == null ? '—' : `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value)}${unit}`;
const when = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无';
const localInput = (value = new Date()) => { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { me: null, households: [], pets: [], petId: '', tab: 'overview', overview: null, care: [], cursor: null, filterType: '', filterStatus: 'active', activityDate: '', daily: null, weekly: null, comparison: null, observation: null, health: null, authMode: 'login', authError: '', busy: false, generation: 0, loading: false, loadError: '' };
state.history = null; state.historyRange = {}; state.familyId = '';
function clearAccount() { state.me = null; state.households = []; state.pets = []; state.petId = ''; state.overview = null; state.care = []; state.daily = null; state.weekly = null; state.comparison = null; state.observation = null; state.history = null; state.historyRange = {}; state.familyId = ''; modal.close(); }
const pet = () => state.pets.find((item) => item.id === state.petId);
const role = () => state.households.find((item) => item.id === pet()?.household_id)?.role;
const writable = () => ['owner', 'caregiver'].includes(role());
const noticeDelivery = { pending: '等待发送', processing: '通道处理中', simulated: '离线模拟', sent: '服务商已受理', dead: '发送失败', skipped: '已跳过发送' };
const disabled = (allowed = writable()) => allowed ? '' : ' disabled';
const badge = (text, tone = '') => `<span class="badge ${tone}"><span class="dot"></span>${esc(text)}</span>`;
const button = (text, action, options = '') => `<button type="button" class="button small" data-action="${action}" ${options}>${text}</button>`;
const empty = (title, description = '') => `<div class="empty">${paw()}<strong>${esc(title)}</strong>${esc(description)}</div>`;
const panel = (title, content, right = '', symbol = 'care') => `<section class="panel"><div class="panel-head"><h2>${icon(symbol)}${title}</h2>${right}</div>${content}</section>`;
const stat = (title, value, unit, note, symbol) => `<article class="stat"><div class="stat-top">${title}${icon(symbol)}</div><div class="stat-value">${value}<span>${unit}</span></div><div class="stat-foot">${note}</div></article>`;
function notify(message, error = false) { const notice = $('#notice'); notice.textContent = message; notice.className = `notice${error ? ' error' : ''}`; notice.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => { notice.hidden = true; }, error ? 10000 : 5000); }
function errorText(error) { return `${error.message || '操作失败，请重试'}${error.requestId ? ` · 请求编号 ${error.requestId}` : ''}`; }
function todayForPet() { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: pet()?.effective_timezone || deviceTimezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()); return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type).value).join('-'); }

function renderAuth() {
  const registering = state.authMode === 'register';
  $('#app').innerHTML = `<div class="auth-layout"><aside class="auth-story"><div class="brand">${paw()}<div>DOOGY<small>伴 宠 日 常</small></div></div><div class="auth-message"><div class="eyebrow">EVERY LITTLE MOMENT MATTERS</div><h1>把每一天的陪伴，<br>变成<em>看得见的关心。</em></h1><p>从一餐一饭，到每一次出门。把照护、活动和设备状态放在一起，安心陪伴它的日常。</p><div class="auth-paw">${paw()}</div></div><div class="auth-story-foot">MADE FOR YOUR LITTLE COMPANION</div></aside><main class="auth-form-area" id="main"><div><div class="eyebrow">YOUR PET, YOUR DAILY CONNECTION</div><h2>${registering ? '开启你们的伴宠日常' : '欢迎回到伴宠日常'}</h2><p>${registering ? '创建一个家庭，开始记录小伙伴的每一天。' : '登录后，继续照顾你的小伙伴。'}</p><div class="toolbar auth-tabs"><button class="button ${!registering ? 'primary' : ''}" data-action="auth-login" aria-pressed="${!registering}">登录</button><button class="button ${registering ? 'primary' : ''}" data-action="auth-register" aria-pressed="${registering}">注册家庭</button></div><div id="auth-entry-help">${renderEntryHelp()}</div><form id="auth-form" class="form-grid"><label>邮箱地址<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="you@example.com"></label><label>密码<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" minlength="8" maxlength="128" required placeholder="至少 8 个字符"></label>${registering ? '<label>家庭名称<input name="household_name" required maxlength="100" placeholder="例如：我们的小家"></label>' : ''}<div id="auth-error" class="inline-message" role="alert">${esc(state.authError)}</div><button class="button primary" type="submit">${registering ? '创建家庭并开始' : '登录伴宠日常'}${icon('arrow')}</button></form><p class="hint">${registering ? `家庭时区将设置为当前设备的 ${esc(deviceTimezone)}。` : '请使用已注册的邮箱；首次使用可选择「注册家庭」。'}</p><div class="auth-environment environment">${healthText()}</div></div></main></div>`;
  $('#app').setAttribute('aria-busy', 'false');
}
function healthText() { return state.health ? `${state.health.demo ? '合成数据演示 · ' : ''}${esc(state.health.mode === 'offline' ? 'OFFLINE · 离线模式' : state.health.mode)} / ${esc(state.health.database)} · 服务已连接` : '本地服务连接中'; }
function renderEntryHelp() {
  const host = esc(location.origin), accounts = state.health?.demo_accounts;
  if (!state.health) return '<p class="hint">正在确认当前环境…</p>';
  if (!state.health.demo) return `<div class="entry-help"><strong>当前是普通数据环境</strong><p>访问地址：${host}</p><p>请使用你在此环境注册的账号。内置演示账号和示例数据请通过项目中的 <b>start-demo.bat</b> 打开，再访问新窗口打印的地址。</p></div>`;
  if (!accounts) return '<div class="entry-help"><strong>当前是演示环境</strong><p>请重启 start-demo.bat，加载最新的演示登录入口。</p></div>';
  return `<div class="entry-help"><strong>合成数据演示 · 可直接体验</strong><p>访问地址：${host}</p><div class="row-actions"><button type="button" class="button primary" data-action="demo-login" data-role="owner">主人演示登录</button><button type="button" class="button" data-action="demo-login" data-role="viewer">只读演示登录</button></div><p>主人：${esc(accounts.owner.email)}<br>只读：${esc(accounts.viewer.email)}<br>演示密码：<code>${esc(accounts.owner.password)}</code></p><p>所有宠物、位置和活动均为合成数据。</p></div>`;
}
function render() {
  if (!state.me) return renderAuth();
  const titles = { overview: ['每一天，都好好陪伴。', '把日常照护和当前状态放在一起，了解它的每一个小变化。'], care: ['照顾它的每个小细节。', '记录一餐、一刻和每一次照护，让日常有迹可循。'], activity: ['一起，动出好状态。', '查看已上报活动与覆盖情况，用可靠的数据了解日常。'], device: ['让陪伴，多一份连接。', '管理设备、围栏和上报策略，清楚看到每一次执行状态。'], history: ['每一次足迹，都有来处。', '回看定位与安全事件，了解发生时间、数据质量和处理记录。'] };
  const current = pet();
  $('#app').innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand">${paw()}<div>DOOGY<small>伴 宠 日 常</small></div></div><div class="nav-label">我的伴宠空间</div><nav class="nav" aria-label="主要导航">${[['overview', 'home', '日常概览'], ['care', 'care', '照护记录'], ['activity', 'activity', '活动趋势'], ['device', 'device', '设备与安全'], ['history', 'pin', '足迹与事件']].map(([key, symbol, title]) => `<button data-action="tab" data-tab="${key}" ${state.tab === key ? 'aria-current="page"' : ''}>${icon(symbol)}${title}</button>`).join('')}</nav><div class="sidebar-note"><div class="mini-paw">${paw()}</div><p>每一份小小的记录，<br>都是陪伴的温度。</p><small>BUSINESS EXPERIENCE · v1</small></div></aside><div class="main-wrap"><header class="topbar"><div class="breadcrumb">伴宠空间 <strong>/ ${titles[state.tab][0].replace('。', '')}</strong></div><div class="top-actions"><span class="environment">${healthText()}</span><span class="account" title="${esc(state.me.email)}">${esc(state.me.email[0].toUpperCase())}</span><button type="button" class="icon-button top-notice" data-action="notification-inbox" aria-label="通知中心" title="通知中心">${icon('bell')}</button><button class="logout" type="button" data-action="support-list">我的工单</button>${state.me.support_staff ? '<button class="logout" type="button" data-action="support-list" data-staff="true">客服处理</button>' : ''}<button class="logout" data-action="family">家庭</button><button class="logout" type="button" data-action="account-export">数据导出</button><button class="logout" data-action="logout">退出</button></div></header><main id="main" tabindex="-1"><div class="page-heading"><div><div class="eyebrow">${state.tab === 'overview' ? 'A LITTLE CARE, EVERY DAY' : 'YOUR COMPANION, CONNECTED'}</div><h1>${titles[state.tab][0]}</h1><p>${titles[state.tab][1]}</p></div><div class="heading-actions"><button class="icon-button" data-action="refresh" aria-label="刷新当前数据" title="刷新当前数据">${icon('refresh')}</button><button class="button primary" data-action="new-pet"${disabled(state.households.some((item) => item.role !== 'viewer'))}>${icon('plus')}添加宠物</button></div></div>${current ? `<section class="pet-strip" aria-label="当前宠物"><div class="pet-avatar">${paw()}</div><div><label class="sr-only" for="pet-select">选择宠物</label><select id="pet-select" class="pet-select">${state.pets.map((item) => `<option value="${esc(item.id)}" ${item.id === state.petId ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select><div class="pet-meta">${esc(species[current.species] ?? current.species)}${current.breed ? ` · ${esc(current.breed)}` : ''} · ${fmt(current.weight_kg, ' kg')} · ${esc(current.effective_timezone)}</div></div><div class="pet-status">${button('修改资料', 'edit-pet', disabled())}${badge(role() === 'owner' ? '家庭所有者' : role() === 'caregiver' ? '照护者' : '只读成员', 'neutral')}${badge(state.overview?.device ? label(state.overview.device.connection_status) : '未绑定设备', state.overview?.device?.connection_status === 'online' ? '' : 'warning')}</div></section>` : ''}${current && !writable() ? '<div class="readonly">你当前以只读成员身份查看此宠物，照护、设备及安全设置需要家庭所有者或照护者操作。</div>' : ''}${state.health?.demo ? '<div class="readonly demo-banner">演示环境 · 所有宠物、位置、活动与账号均为合成数据。设备没有持续上报，状态会随时间自然过期。</div>' : ''}<div id="view" aria-busy="${state.loading}">${!current ? empty('为你的小伙伴建立档案', '点击「添加宠物」，从第一次记录开始。') : state.loading ? '<div class="loading-panel">正在读取最新数据…</div>' : state.loadError ? `<div class="empty"><strong>暂时无法读取数据</strong>${esc(state.loadError)}<br>${button('重新加载', 'refresh')}</div>` : view()}</div></main><footer class="footer"><span>DOOGY 伴宠日常 · 业务体验台</span><span>${state.overview ? `状态读取于 ${esc(when(state.overview.current_state_at))} · 手动刷新` : '所有记录来自当前服务'}</span></footer></div></div>`;
  $('#app').setAttribute('aria-busy', String(state.loading));
}
function view() { return ({ overview: renderOverview, care: renderCare, activity: renderActivity, device: renderDevice, history: () => renderHistory(state.history, { canWrite: writable() }) })[state.tab](); }
function careSummary(record) {
  const value = record.value || {};
  return ({ weight: () => `${fmt(value.weight_kg)} kg`, feeding: () => [value.food, value.amount_g == null ? null : `${value.amount_g} g`].filter(Boolean).join(' · '), medication: () => [value.name, value.dose].filter(Boolean).join(' · '), grooming: () => value.activity, note: () => value.text, toileting: () => `${{ urination: '排尿', defecation: '排便', both: '排尿与排便' }[value.kind] ?? value.kind ?? ''}${value.text ? ` · ${value.text}` : ''}`, custom: () => value.text }[record.type]?.() || '已记录');
}
function renderOverview() {
  const data = state.overview, attention = data.attention, activity = data.activity;
  const gaps = [...data.data_gaps.current_state, ...data.data_gaps.activity_period];
  const recent = data.care_records.slice(0, 4).map((record) => `<div class="data-row"><div class="row-icon">${icon('care')}</div><div class="row-body"><div class="row-title">${esc(types[record.type])} ${record.custom_type ? `· ${esc(record.custom_type)}` : ''}</div><div class="row-note">${esc(careSummary(record))} · ${esc(when(record.recorded_at))}</div></div></div>`).join('');
  const events = attention.unacknowledged_open_events.map((event) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(label(event.type))}</div><div class="row-note">${esc(when(event.occurred_at))} · 事件仍开放</div></div>${button('我已知晓', 'ack', `data-id="${esc(event.id)}"${disabled()}`)}</div>`).join('');
  const unread = attention.unread_notifications.map((item) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(label(item.type))}</div><div class="row-note">${esc(when(item.created_at))} · ${esc(noticeDelivery[item.status] ?? '通道状态未知')}</div></div>${button('标为已读', 'read', `data-id="${esc(item.id)}"`)}</div>`).join('');
  return `<section class="hero"><div class="hero-copy"><div class="eyebrow">HELLO, LITTLE COMPANION</div><h2>${esc(pet().name)}的日常，值得用心记录。</h2><p>${gaps.length ? `当前有 ${gaps.length} 项数据或配置待补齐，慢慢把陪伴的拼图补完整。` : '当前状态已读取，和它一起开始今天的小日常。'}</p><button class="button" data-action="new-care"${disabled()}>记录一次照护 ${icon('arrow')}</button></div><div class="hero-art">${paw()}</div></section><div class="stats">${stat('今日上报步数', fmt(activity.steps), '步', esc(label(activity.data_status)), 'activity')}${stat('今日活动时长', fmt(activity.active_minutes), '分钟', `样本 ${fmt(activity.sample_count)} 条 · 覆盖 ${fmt(activity.coverage_seconds / 3600)} 小时`, 'care')}${stat('开放安全事件', fmt(attention.open_event_count), '项', `其中 ${fmt(attention.unacknowledged_open_event_count)} 项待确认`, 'bell')}${stat('我的未读通知', fmt(attention.unread_notification_count), '条', '已读与事件确认分别记录', 'device')}</div><div class="columns"><div class="stack">${panel('最近位置', locationContent(data.location, data.location_wait), '<button class="text-button" data-action="tab" data-tab="history">查看足迹 →</button>', 'pin')}${panel('今天的照护', recent ? `<div class="rows">${recent}</div>` : empty('今天还没有照护记录', '吃饭、称重或小日记，都可以从这里开始。'), '<button class="text-button" data-action="tab" data-tab="care">全部记录 →</button>')}${panel('当前围栏', fenceRows(data.geofences.items), '<button class="text-button" data-action="tab" data-tab="device">管理围栏 →</button>', 'pin')}</div><div class="stack">${panel('需要你留意', events ? `<div class="rows">${events}</div><p class="hint">展示最近 5 项待确认事件。确认知晓会保留事件的开放状态。</p>` : empty('暂无待确认事件', '请结合设备和位置数据完整性查看当前状态。'), badge(`${attention.unacknowledged_open_event_count} 项`, attention.unacknowledged_open_event_count ? 'warning' : 'neutral'), 'bell')}${panel('我的通知', unread ? `<div class="rows">${unread}</div><p class="hint">展示最近 5 条未读通知；通知状态不代表手机实际送达。</p>` : empty('暂无未读通知'), button('全部通知', 'notification-inbox'), 'bell')}${panel('数据完整性', gaps.length ? `<p class="hint">补齐数据后，才能更好地理解当前状态。</p><div class="gap-list">${gaps.map((gap) => badge(label(gap), 'warning')).join('')}</div>` : '<p class="hint">本次查询未报告当前数据缺口。</p>', '', 'activity')}</div></div>`;
}
function locationContent(location, wait) {
  if (!location) {
    if (wait?.status === 'delayed') return empty('仍无可显示定位', '绑定已满 10 分钟。请检查项圈是否开机、连接是否正常，并到开阔处等待定位，再刷新页面。');
    if (wait?.status === 'waiting') return empty('等待首次定位', '设备已绑定。等待项圈上报后刷新页面。');
    return empty('尚无定位', '绑定设备并收到位置上报后，可在这里查看。');
  }
  return `<div class="location">${icon('pin')}<strong>${esc(location.lat)}, ${esc(location.lon)}</strong><small>${location.usable_for_tracking ? '可用于追踪' : '暂不可用于追踪'} · ${esc(location.source)}</small></div><dl class="detail-list"><div class="detail-row"><dt>定位时间</dt><dd>${esc(when(location.device_ts))}</dd></div><div class="detail-row"><dt>精度 / 质量标记</dt><dd>${fmt(location.accuracy_m, ' m')} / ${esc(location.quality_flags?.join('、') || '无标记')}</dd></div></dl>`;
}
function fenceRows(items, controls = false) {
  return items.length ? `<div class="rows">${items.map((fence) => {
    const attrs = `data-id="${esc(fence.id)}"${disabled()}`;
    return `<div class="data-row"><div class="row-icon">${icon('pin')}</div><div class="row-body"><div class="row-title">${esc(fence.name)} ${badge(fence.enabled ? label(fence.state.effective_status) : '已停用', fence.enabled && fence.state.effective_status === 'inside' ? '' : 'neutral')}</div><div class="row-note">${fence.geometry.type === 'circle' ? `圆形 · ${esc(fence.geometry.lat)}, ${esc(fence.geometry.lon)} · 半径 ${fmt(fence.geometry.radius_m)} m` : `多边形 · ${fmt(fence.geometry.coordinates.length)} 个坐标点`}</div></div>${controls ? `<div class="row-actions">${button('编辑围栏', 'edit-fence', attrs)}${fence.enabled ? button('停用', 'disable-fence', attrs) : button('启用', 'enable-fence', attrs)}</div>` : ''}</div>`;
  }).join('')}</div>` : empty('还没有围栏', '在设备与安全中添加一个日常活动范围。');
}
function renderCare() {
  return `<div class="toolbar"><label>记录类型<select id="care-type-filter"><option value="">全部类型</option>${Object.entries(types).map(([key, text]) => `<option value="${key}" ${state.filterType === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label><label>记录状态<select id="care-status-filter">${[['active', '有效记录'], ['withdrawn', '已撤回'], ['all', '全部状态']].map(([key, text]) => `<option value="${key}" ${state.filterStatus === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label><button class="button primary" data-action="new-care"${disabled()}>${icon('plus')}记录照护</button></div><div class="records">${state.care.length ? state.care.map((record) => `<article class="record ${record.withdrawn_at ? 'withdrawn' : ''}"><div class="record-heading"><div><div class="record-type">${icon('care')}${esc(types[record.type])}${record.custom_type ? ` · ${esc(record.custom_type)}` : ''}${record.withdrawn_at ? badge('已撤回', 'neutral') : ''}</div><div class="record-time">${esc(when(record.recorded_at))} · ${record.source === 'vet' ? '兽医记录' : '家庭记录'}</div></div><div class="row-actions">${button('历史', 'history', `data-id="${esc(record.id)}"`)}${button(`附件 ${record.attachments.length}`, 'attachments', `data-id="${esc(record.id)}"`)}${button('编辑', 'edit-care', `data-id="${esc(record.id)}"${disabled(writable() && !record.withdrawn_at)}`)}${button('撤回', 'withdraw', `data-id="${esc(record.id)}"${disabled(writable() && !record.withdrawn_at && (record.created_by === state.me.id || role() === 'owner'))}`)}</div></div><div class="record-value">${esc(careSummary(record))}</div>${record.notes ? `<div class="record-notes">${esc(record.notes)}</div>` : ''}${record.withdrawn_at ? `<div class="record-notes">撤回于 ${esc(when(record.withdrawn_at))} · 理由：${esc(record.withdrawal_reason)}</div>` : ''}</article>`).join('') : empty('还没有符合条件的记录', '调整筛选条件，或记录一次新的照护。')}</div>${state.cursor ? `<div style="text-align:center;margin-top:20px">${button('加载更多', 'load-more')}</div>` : ''}`;
}
const metricNames = { steps: '上报步数', active_minutes: '活动分钟数' };
const feedbackLabels = { helpful: '有用', incorrect: '不准确' };

function renderHistoricalObservation(result) {
  const title = '所选日期的活动观察';
  if (!result || result.status === 'day_in_progress') {
    return panel(title, '<p class="hint">选择已结束的日期查看完整自然日观察及证据。</p>', button('查看昨天', 'activity-yesterday'), 'activity');
  }
  const comparisons = result.comparisons.map((item) => {
    const observation = result.observations.find((entry) => entry.evidence_ids.includes(item.evidence_id));
    const status = item.status !== 'ready' || item.reason ? label(item.reason)
      : observation ? observation.text : '上报量变化未达 30% 的观察门槛。';
    return `<article class="comparison"><div class="comparison-head"><span>${esc(metricNames[item.metric])}</span>${observation ? button('查看证据', 'activity-evidence', `data-id="${esc(item.evidence_id)}" aria-label="查看证据：${esc(metricNames[item.metric])}"`) : ''}</div>
      <p>指标覆盖 ${fmt(item.coverage_fraction * 100)}% · 合格基线 ${fmt(item.baseline_days)} 天<br>${esc(status)}</p></article>`;
  }).join('');
  return panel(title, `<div class="panel-subtitle">${esc(result.local_date)} · ${esc(result.timezone)}</div>${comparisons}`, '', 'activity');
}

function renderActivity() {
  const daily = state.daily, weekly = state.weekly, comparison = state.comparison;
  const days = weekly.days, maximum = Math.max(1, ...days.map((day) => day.steps ?? 0));
  return `<div class="toolbar"><label>查看日期<input id="activity-date" type="date" value="${esc(state.activityDate)}" required></label><span class="hint">汇总时区：${esc(daily.timezone)} · 周趋势截至所选日期</span></div><div class="stats">${stat('上报步数', fmt(daily.steps), '步', `${fmt(daily.metric_sample_counts.steps)} 条指标样本`, 'activity')}${stat('活动时长', fmt(daily.active_minutes), '分钟', `覆盖 ${fmt(daily.metric_coverage_seconds.active_seconds / 3600)} 小时`, 'care')}${stat('上报距离', fmt(daily.distance_m), '米', `${daily.estimated ? '含估算或区间分摊' : '上报样本汇总'}`, 'pin')}${stat('数据覆盖', fmt(daily.coverage_seconds / 3600), '小时', esc(label(daily.data_status)), 'device')}</div><div class="columns"><div class="stack">${panel('过去七天 · 上报步数', `<div class="chart" role="img" aria-label="过去七天上报步数，详细数据见下表">${days.map((day) => `<div class="chart-day"><span class="chart-label">${fmt(day.steps)}</span><div class="chart-bar ${day.steps == null ? 'missing' : ''}" style="height:${day.steps == null ? 3 : Math.max(3, day.steps / maximum * 115)}px"></div><span>${esc(day.local_date.slice(5))}</span></div>`).join('')}</div><p class="hint">短虚线表示缺少数据，零步数会显示为 0；覆盖不足时不代表整天活动量。</p><div class="table-scroll"><table><caption class="sr-only">七天活动与覆盖详情</caption><thead><tr><th>日期</th><th>步数</th><th>活动 / 分钟</th><th>覆盖 / 小时</th></tr></thead><tbody>${days.map((day) => `<tr><td>${esc(day.local_date)}</td><td>${fmt(day.steps)}</td><td>${fmt(day.active_minutes)}</td><td>${fmt(day.coverage_seconds / 3600)} · ${esc(label(day.data_status))}</td></tr>`).join('')}</tbody></table></div>`, '', 'activity')}</div><div class="stack">${panel('截至当前时刻的活动比较', `<div class="panel-subtitle">${esc(comparison.local_date)} · ${esc(when(comparison.as_of))}<br>与前 7 天内合格的同等已过时长窗口比较。</div>${comparison.comparisons.map((item) => `<article class="comparison"><div class="comparison-head"><span>${item.metric === 'steps' ? '上报步数' : '活动分钟数'}</span>${badge(item.status === 'ready' ? '可比较' : '暂不可比较', item.status === 'ready' ? '' : 'warning')}</div><p>当前 ${fmt(item.observed)} · 指标覆盖 ${fmt(item.coverage_fraction * 100)}%<br>合格基线 ${fmt(item.baseline_days)} 天${item.baseline_median == null ? '' : ` · 中位数 ${fmt(item.baseline_median)}`}${item.delta_percent == null ? '' : `<br>相较基线 ${item.delta_percent > 0 ? '+' : ''}${fmt(item.delta_percent)}%`}${item.reason ? `<br>${esc(label(item.reason))}` : ''}</p><div class="progress" aria-hidden="true"><span style="width:${Math.max(0, Math.min(100, item.coverage_fraction * 100))}%"></span></div></article>`).join('')}<p class="hint">至少需要 50% 指标覆盖和 3 个合格基线日。活动变化仍需结合佩戴情况、环境和日常安排理解。</p><p class="hint">这里只展示数据规则比较；${comparison.model_output === null ? '当前没有模型输出。' : '请结合数据来源阅读结果。'}当前比较独立于左侧所选历史日期。</p>`, '', 'activity')}${renderHistoricalObservation(state.observation)}</div></div>`;
}
function renderDevice() {
  const device = state.overview.device, reporting = device?.reporting;
  return `<div class="columns"><div class="stack">${panel('我的穿戴设备', device ? `<div class="pet-strip" style="margin:0;border:0;padding:0"><div class="pet-avatar">${icon('device')}</div><div><div class="row-title">${esc(device.model || '宠物穿戴设备')}</div><div class="pet-meta">${esc(device.serial_no)}</div></div>${badge(label(device.connection_status), device.connection_status === 'online' ? '' : 'warning')}</div><dl class="detail-list"><div class="detail-row"><dt>设备 ID</dt><dd>${esc(device.id)}</dd></div><div class="detail-row"><dt>电量</dt><dd>${fmt(device.battery_pct, '%')}</dd></div><div class="detail-row"><dt>最近连接</dt><dd>${esc(when(device.last_seen_at))}</dd></div><div class="detail-row"><dt>定位新鲜度</dt><dd>${esc(label(device.data_freshness))}</dd></div></dl>${button('解绑设备', 'unbind-device', `data-id="${esc(device.id)}"${disabled(writable() && device.is_owner)}`)}` : `${empty('先连接它的穿戴设备', '使用已预置设备的 ID 和有效绑定码完成绑定。')}<p class="hint">绑定码由设备所有者或授权配置人员提供。</p><button class="button primary" data-action="claim" style="margin-top:15px"${disabled()}>绑定设备</button>`, '', 'device')}${panel('日常活动围栏', `${fenceRows(state.overview.geofences.items, true)}<p class="hint">状态依赖有效定位与确认点；未知状态不表示宠物在围栏内。</p>`, `<button class="button small" data-action="new-fence"${disabled()}>${icon('plus')}添加围栏</button>`, 'pin')}${panel('运行与排障', `<div class="row-actions ops-actions">${button('家庭运行简报', 'operations')}${device ? button('遥测失败', 'telemetry-failures') : ''}</div>`, '', 'activity')}</div><div class="stack">${panel('设备上报策略', device ? `<dl class="detail-list"><div class="detail-row"><dt>请求状态</dt><dd>${badge(label(reporting.status), reporting.status === 'applied' ? '' : 'warning')}</dd></div><div class="detail-row"><dt>期望策略 / 版本</dt><dd>${policyText(reporting.desired)} / ${reporting.desired_version ?? '—'}</dd></div><div class="detail-row"><dt>实际策略 / 版本</dt><dd>${policyText(reporting.applied)} / ${reporting.applied_version ?? '—'}</dd></div><div class="detail-row"><dt>执行来源</dt><dd>${esc(label(reporting.execution_source))}</dd></div></dl><p class="hint">提交策略后等待设备回执，再显示为「已执行」。离线模拟器回执会明确标记来源。</p><button class="button soft" data-action="policy" style="margin-top:16px"${disabled(writable() && !reporting.lost_mode.enabled)}>调整上报策略</button>` : empty('绑定设备后可配置'), '', 'activity')}${panel('走失模式', renderLostMode(device), button('位置分享', 'location-shares', disabled()), 'pin')}</div></div>`;
}
function policyText(policy) { return policy ? `${esc(modes[policy.mode] ?? policy.mode)} · ${fmt(policy.interval_seconds)} 秒` : '尚无策略'; }

function renderLostMode(device) {
  if (!device) return empty('绑定设备后可开启');
  const lost = device.reporting.lost_mode;
  return `<div class="row-title">${badge(lost.enabled ? '走失模式已开启' : '走失模式未开启', lost.enabled ? 'warning' : 'neutral')}</div>
    ${lost.enabled ? `<p class="hint">有效至 ${esc(when(lost.session.expires_at))}</p>` : ''}
    <p class="hint">开启后请求高频定位；实际执行仍需设备回执。到期后会请求恢复之前的策略。</p>
    <div class="share-actions"><button class="button ${lost.enabled ? '' : 'primary'}" data-action="lost-mode"${disabled()}>${lost.enabled ? '关闭走失模式' : '开启走失模式'}</button></div>`;
}

async function loadAccount(session) {
  if (!session) { state.me = null; state.authError = '登录已失效，请重新登录。'; renderAuth(); return; }
  state.me = session.user; state.households = session.households;
  await refresh();
}
function carePath(cursor) { const query = new URLSearchParams({ status: state.filterStatus, limit: '20' }); if (state.filterType) query.set('type', state.filterType); if (cursor) query.set('cursor', cursor); return `/pets/${state.petId}/care-records?${query}`; }
async function refresh() {
  const generation = ++state.generation, tab = state.tab;
  state.loading = true; state.loadError = ''; render();
  try {
    const [households, pets] = await Promise.all([api.get('/households'), api.get('/pets')]);
    if (generation !== state.generation) return;
    state.households = households.items; state.pets = pets.items;
    const oldId = state.petId;
    if (!pet()) state.petId = state.pets[0]?.id || '';
    if (oldId !== state.petId) { state.historyRange = {}; state.activityDate = ''; }
    if (!pet()) { state.overview = null; return; }
    if (!state.activityDate) state.activityDate = todayForPet();
    const id = state.petId, date = state.activityDate;
    const [overview, details] = await Promise.all([api.get(`/pets/${id}/overview`), tab === 'care' ? api.get(carePath()) : tab === 'activity' ? Promise.all([api.get(`/pets/${id}/activity/daily?date=${date}`), api.get(`/pets/${id}/activity/weekly?date=${date}`), api.get(`/pets/${id}/observations/current`)]) : tab === 'history' ? loadHistory(api, id, state.historyRange) : null]);
    if (generation !== state.generation) return;
    const observation = tab === 'activity' && date < details[2].local_date
      ? await api.get(`/pets/${id}/observations?${new URLSearchParams({ date })}`) : null;
    if (generation !== state.generation) return;
    state.overview = overview; state.pets = state.pets.map((item) => item.id === id ? overview.pet : item);
    if (tab === 'care') { state.care = details.items; state.cursor = details.next_cursor; }
    if (tab === 'activity') {
      [state.daily, state.weekly, state.comparison] = details;
      state.observation = observation;
    }
    if (tab === 'history') { state.history = details; state.historyRange = details.locations.range; }
  } catch (error) { if (generation === state.generation) { if (!api.authenticated) { clearAccount(); state.authError = errorText(error); } else state.loadError = errorText(error); } }
  finally { if (generation === state.generation) { state.loading = false; render(); } }
}

let blobUrl, exportManifest, exportController;
const modal = $('#modal');
modal.addEventListener('close', () => {
  if (modal.open) return;
  if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
  if ($('#account-export-preview')) {
    exportController?.abort();
    exportManifest = null;
  }
  if ($('#share-url') || $('#support-diagnostics') || $('#account-export-preview')) $('#dialog-content').replaceChildren();
});
function dialog(title, content) {
  $('#dialog-content').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="close-button" data-action="close" aria-label="关闭对话框">×</button></div><div class="dialog-body">${content}<div id="dialog-error" class="inline-message" role="alert"></div></div>`;
  if (!modal.open) modal.showModal();
}
const field = (text, name, value = '', attrs = '') => `<label>${text}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
const area = (text, name, value = '', attrs = '') => `<label>${text}<textarea name="${name}" rows="3" ${attrs}>${esc(value)}</textarea></label>`;
const submit = (text = '保存记录') => `<div class="form-actions full-span"><button class="button" type="button" data-action="close">取消</button><button class="button primary" type="submit">${text}</button></div>`;
const exportSectionNames = {
  profile: '账号资料', sessions: '会话时间', notification_preferences: '提醒偏好', push_token_metadata: '推送终端信息',
  owned_devices: '本人设备', support_tickets: '工单', support_history: '工单回复', notifications: '通知', feedback: '反馈', audit: '操作记录',
  households: '家庭资料', members: '家庭成员', pets: '宠物档案', devices: '绑定设备', device_bindings: '绑定历史', device_state: '设备状态',
  device_events: '上报处理记录', locations: '定位轨迹', activity_samples: '活动样本', geofences: '围栏', geofence_evaluations: '围栏判断',
  safety_events: '安全事件', safety_acknowledgements: '事件确认', care_records: '照护记录', care_record_revisions: '照护修订',
  care_attachments: '照护附件与正文', reporting_policies: '上报策略', device_commands: '设备命令', lost_mode_sessions: '走失历史',
  daily_summaries: '日摘要', activity_observations: '活动观察', location_shares: '位置分享记录'
};

async function accountExportDialog() {
  const manifest = await api.get('/auth/data-export');
  exportManifest = manifest;
  const sectionList = (sections) => `<details><summary>${sections.length} 个分区</summary>
    <p class="row-note">${esc(sections.map((section) => exportSectionNames[section] ?? section).join('、'))}</p></details>`;
  dialog('数据导出', `<section id="account-export-preview" aria-label="授权范围预览">
    <p class="hint">记录时间上界 ${esc(when(manifest.generated_at))}（本机时间）。生成时按页检查当前权限。</p>
    <h3>个人数据</h3><p class="row-note">${esc(manifest.user.email)}</p>${sectionList(manifest.personal_sections)}
    <h3>授权家庭</h3>
    ${manifest.households.length ? `<div class="rows">${manifest.households.map((household) => `<div class="data-row"><div class="row-body">
      <div class="row-title">${esc(household.name)} ${badge(roles[household.role], 'neutral')}</div>${sectionList(household.sections)}
    </div></div>`).join('')}</div>` : '<p class="hint">当前没有可导出的家庭。</p>'}
    <p class="hint">文件可能包含精确位置、照护备注与附件，请妥善保管。大量附件可使用本地导出命令逐页写入。</p>
    <div class="form-actions" id="account-export-actions">${button('生成导出文件', 'generate-account-export')}</div>
    <p class="hint" id="account-export-status" role="status"></p>
  </section>`);
}

async function generateAccountExport() {
  const status = $('#account-export-status'), actions = $('#account-export-actions'), controller = new AbortController();
  exportController = controller;
  status.textContent = '正在读取授权数据…';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button small';
  cancel.textContent = '取消导出';
  cancel.addEventListener('click', () => { controller.abort(); modal.close(); });
  actions.append(cancel);
  try {
    const result = await buildAccountExport(api, exportManifest, {
      signal: controller.signal,
      onProgress: ({ completed, total }) => { status.textContent = `已读取 ${completed} / ${total} 个分区…`; },
    });
    if (!modal.open || controller.signal.aborted) return;
    blobUrl = URL.createObjectURL(result.blob);
    const download = document.createElement('a');
    download.className = 'button primary';
    download.href = blobUrl;
    download.download = result.filename;
    download.textContent = '下载 NDJSON';
    actions.replaceChildren(download);
    download.focus();
    status.textContent = `文件已生成 · ${fmt(result.rows)} 条记录 · ${fmt(result.sections)} 个分区`;
  } catch (error) {
    if (controller.signal.aborted || !modal.open) return;
    status.textContent = '文件未生成。关闭对话框后可重新预览导出范围。';
    throw error;
  } finally {
    cancel.remove();
    exportController = null;
  }
}

function activityEvidenceDialog(evidenceId) {
  const result = state.observation;
  const observation = result?.observations.find((item) => item.evidence_ids.includes(evidenceId));
  const evidence = result?.evidence.find((item) => item.id === evidenceId);
  if (!observation || !evidence) return;
  const feedback = writable() ? `<form id="activity-feedback-form" class="form-grid" data-id="${esc(result.id)}" data-evidence="${esc(evidence.id)}" data-date="${esc(result.local_date)}" data-pet="${esc(result.pet_id)}">
    <div class="full-span">${area('反馈说明', 'comment', '', 'required maxlength="4000"')}</div>
    <div class="form-actions full-span">${Object.entries(feedbackLabels).map(([value, text]) => `<button class="button" type="submit" name="assessment" value="${value}">${text}</button>`).join('')}</div>
  </form>` : '<p class="hint">只读成员可查看证据。提交反馈需要家庭所有者或照护者权限。</p>';
  dialog('活动观察证据', `<p class="hint">${esc(pet().name)} · ${esc(result.local_date)} · ${esc(result.timezone)}</p>
    <p class="record-value">${esc(observation.text)}</p>
    <p class="hint">来源：设备上报活动样本 · ${evidence.estimated ? '含估算或时段分摊' : '按已上报样本汇总'}<br>规则 ${esc(result.rule_version)} · 聚合 ${esc(evidence.aggregation_version)}</p>
    <div class="table-scroll"><table><caption>参与比较的基线日期</caption><thead><tr><th scope="col">日期</th><th scope="col">指标覆盖率</th></tr></thead>
    <tbody>${evidence.baseline.map((day) => `<tr><td>${esc(day.local_date)}</td><td>${fmt(day.coverage_fraction * 100)}%</td></tr>`).join('')}</tbody></table></div>
    <p class="hint">理解变化时可结合佩戴情况、环境与日常安排。</p>${feedback}`);
}
function petDialog(current) {
  const households = state.households.filter((item) => item.role !== 'viewer');
  dialog(current ? '修改宠物资料' : '添加小伙伴', `<form id="pet-form" data-id="${esc(current?.id || '')}" class="form-grid">${current ? '' : `<label>所属家庭<select name="household_id" required>${households.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select></label>`}${field('宠物名字', 'name', current?.name, 'required maxlength="100" placeholder="它叫什么名字？"')}<label>宠物类型<select name="species">${Object.entries(species).map(([key, text]) => `<option value="${key}" ${current?.species === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${field('品种（可选）', 'breed', current?.breed, 'maxlength="100"')}${field('生日（可选）', 'birth_date', current?.birth_date, 'type="date"')}${current ? '<p class="hint full-span">体重通过照护记录维护，可保留每次称重的时间和历史。</p>' : field('体重 kg（可选）', 'weight_kg', '', 'type="number" min="0.001" max="300" step="any"')}${field('统计时区（留空继承家庭）', 'timezone', current?.timezone, 'maxlength="100" placeholder="例如：Asia/Shanghai"')}${submit(current ? '保存宠物资料' : '建立宠物档案')}</form>`);
}

async function familyDialog(id = state.familyId || pet()?.household_id || state.households[0]?.id, message = '') {
  state.familyId = id;
  const household = state.households.find((item) => item.id === id);
  const members = household ? (await api.get(`/households/${id}/members`)).items : [];
  const owner = household?.role === 'owner';
  dialog('家庭与成员', `<div class="toolbar"><label>选择家庭<select id="family-select">${state.households.map((item) => `<option value="${esc(item.id)}" ${item.id === id ? 'selected' : ''}>${esc(item.name)} · ${esc(roles[item.role])}</option>`).join('')}</select></label></div>${message}<p class="hint">当前登录：${esc(state.me.email)}。邀请仅生成邀请码，请自行交给对应邮箱的用户；系统不会发送邮件。</p>${owner ? `<form id="household-form" data-id="${esc(id)}" class="form-grid">${field('家庭名称', 'name', household.name, 'required maxlength="100"')}${field('家庭统计时区', 'timezone', household.timezone, 'required maxlength="100"')}<button class="button" type="submit">保存家庭设置</button></form>` : ''}<h3>家庭成员</h3><div class="rows">${members.map((member) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(member.email)}${member.user_id === state.me.id ? '（我）' : ''}</div><div class="row-note">${esc(roles[member.role])}</div></div>${owner && member.role !== 'owner' ? `<form id="member-${esc(member.user_id)}" class="member-form row-actions" data-household="${esc(id)}" data-user="${esc(member.user_id)}"><label class="sr-only" for="role-${esc(member.user_id)}">${esc(member.email)}的角色</label><select name="role" id="role-${esc(member.user_id)}">${['caregiver', 'viewer'].map((value) => `<option value="${value}" ${member.role === value ? 'selected' : ''}>${roles[value]}</option>`).join('')}</select><button class="button small" type="submit">更新角色</button>${button('移除成员', 'remove-member', `data-id="${esc(member.user_id)}" data-household="${esc(id)}" data-email="${esc(member.email)}"`)}</form>` : ''}</div>`).join('')}</div>${owner ? `<h3>邀请成员</h3><form id="invite-form" data-id="${esc(id)}" class="form-grid">${field('受邀用户邮箱', 'email', '', 'type="email" required maxlength="254"')}<label>邀请角色<select name="role"><option value="viewer">只读成员</option><option value="caregiver">照护者</option></select></label><button class="button primary" type="submit">生成邀请码</button></form>` : ''}<h3>加入其他家庭</h3><form id="accept-invite-form" class="form-grid">${field('收到的邀请码', 'token', '', 'required autocomplete="off"')}<button class="button" type="submit">接受邀请</button></form><p class="hint">请使用受邀邮箱登录后接受；邀请码有效 7 天。</p>`);
}

function claimReceipt(receipt) {
  dialog('设备已解绑', `<p>设备已解除与宠物的关联，历史记录保留。重新绑定需要下列设备 ID 与绑定码；设备所有权仍属于当前账号。</p><label class="field">设备 ID<input readonly value="${esc(receipt.device_id)}"></label><label class="field">重新绑定码<input readonly value="${esc(receipt.claim_code)}"></label><p class="hint">有效至 ${esc(when(receipt.claim_expires_at))}。请先保存信息，再切换目标宠物并点击「绑定设备」。</p><div class="row-actions">${button('重新签发绑定码', 'renew-claim', `data-id="${esc(receipt.device_id)}"`)}${button('关闭', 'close')}</div>`);
}
function careFields(type, value = {}, customType = '') {
  if (type === 'weight') return field('体重（kg）', 'weight_kg', value.weight_kg, 'type="number" min="0.001" max="300" step="any" required');
  if (type === 'feeding') return field('食物名称', 'food', value.food, 'required maxlength="1000"') + field('喂食量（g）', 'amount_g', value.amount_g, 'type="number" min="0.001" step="any" required');
  if (type === 'medication') return field('药品名称', 'name', value.name, 'required maxlength="1000"') + field('实际记录的用量', 'dose', value.dose, 'required maxlength="1000" placeholder="例如：按既有医嘱记录的用量"') + '<p class="hint full-span">仅记录已发生的用药，不生成剂量或用药建议。</p>';
  if (type === 'grooming') return field('护理内容', 'activity', value.activity, 'required maxlength="2000" placeholder="例如：梳毛、洗澡、剪指甲"');
  if (type === 'toileting') return `<label>排泄类型<select name="kind">${[['urination', '排尿'], ['defecation', '排便'], ['both', '排尿与排便']].map(([key, text]) => `<option value="${key}" ${value.kind === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${area('情况描述（可选）', 'text', value.text, 'maxlength="4000"')}`;
  return (type === 'custom' ? field('自定义照护名称', 'custom_type', customType, 'required maxlength="100"') : '') + area('记录内容', 'text', value.text, 'required maxlength="4000"');
}
function careDialog(record) {
  const type = record?.type || 'weight';
  dialog(record ? '编辑照护记录' : '记录一次照护', `<form id="care-form" data-id="${esc(record?.id || '')}" class="form-grid"><label>照护类型<select name="type" id="care-kind" ${record ? 'disabled' : ''}>${Object.entries(types).map(([key, text]) => `<option value="${key}" ${type === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${field('记录时间', 'recorded_at', localInput(record?.recorded_at), 'type="datetime-local" required')}<p class="hint full-span">时间按当前设备的 ${esc(deviceTimezone)} 输入和显示，保存时转换为带时区的时间。</p><div id="care-fields" class="form-grid full-span">${careFields(type, record?.value, record?.custom_type)}</div>${area('补充备注（可选）', 'notes', record?.notes, 'maxlength="4000"')}${submit()}</form>`);
}
function attachmentDialog(record) {
  dialog('照护附件', `<p class="hint">${esc(types[record.type])} · ${esc(when(record.recorded_at))}${record.withdrawn_at ? ' · 记录已撤回，原附件仍可读取。' : ''}</p><div class="rows">${record.attachments.length ? record.attachments.map((file) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(file.filename)}</div><div class="row-note">${fmt(file.size_bytes / 1024)} KB · ${esc(file.content_type)}</div></div><div class="row-actions">${file.content_type.startsWith('image/') ? button('预览', 'preview', `data-id="${esc(file.id)}" data-record="${esc(record.id)}"`) : ''}${button('下载', 'download', `data-id="${esc(file.id)}" data-record="${esc(record.id)}"`)}</div></div>`).join('') : empty('还没有附件')}</div><form id="attachment-form" class="form-grid" data-id="${esc(record.id)}" style="margin-top:22px"><label>添加图片或 PDF<input name="file" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required${disabled(writable() && !record.withdrawn_at && record.attachments.length < 10)}></label><p class="hint">支持 JPEG、PNG、WebP 和 PDF，单个最多 5 MiB，每条记录最多 10 个。</p><button class="button primary" type="submit"${disabled(writable() && !record.withdrawn_at && record.attachments.length < 10)}>上传附件</button></form>`);
}
async function historyDialog(id) {
  const data = await api.get(`/care-records/${id}/history`);
  dialog('照护记录历史', [...data.revisions.map((revision) => ({ ...revision.record, changed_at: revision.changed_at, changed_by: revision.changed_by })), { ...data.current, current: true }].map((record) => `<article class="history-item"><strong>${record.current ? '当前版本' : '历史快照'} · ${esc(types[record.type])}${record.withdrawn_at ? ' · 已撤回' : ''}</strong><small>记录时间 ${esc(when(record.recorded_at))}<br>${record.current ? `最近更新 ${esc(when(record.updated_at))}` : `变更时间 ${esc(when(record.changed_at))}`}</small><p>${esc(careSummary(record))}</p>${record.notes ? `<p>${esc(record.notes)}</p>` : ''}${record.withdrawal_reason ? `<p>撤回理由：${esc(record.withdrawal_reason)}</p>` : ''}<small>附件 ${record.attachments?.length ?? 0} 个</small></article>`).join(''));
}
const selectedFence = (id) => state.overview.geofences.items.find((item) => item.id === id);
function fenceDialog(fence) {
  dialog(fence ? '编辑围栏' : '添加围栏', renderFenceForm(fence, submit(fence ? '保存围栏' : '创建围栏')));
  syncFenceGeometry($('#fence-form'));
}
async function operationsDialog() {
  const household = state.households.find((item) => item.id === pet()?.household_id);
  if (!household) return;
  const report = await api.get(`/households/${household.id}/operations?hours=24`);
  dialog('家庭运行简报', renderOperations(report, household.name));
}
async function telemetryFailuresDialog(status = '', cursor = '', message = '') {
  const query = new URLSearchParams({ limit: '10' });
  if (status) query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  const page = await api.get(`/pets/${state.petId}/telemetry-failures?${query}`);
  dialog('遥测失败', `<div id="failure-list" data-status="${esc(status)}">${message ? `<p class="hint" role="status">${esc(message)}</p>` : ''}${renderTelemetryFailures(page, { canRetry: writable(), status, cursor })}</div>`);
}
function policyDialog() { const policy = state.overview.device.reporting.desired; dialog('调整上报策略', `<form id="policy-form" class="form-grid"><label>上报模式<select name="mode">${Object.entries(modes).map(([key, text]) => `<option value="${key}" ${policy?.mode === key ? 'selected' : ''}>${text}</option>`).join('')}</select></label>${field('上报间隔（秒）', 'interval_seconds', policy?.interval_seconds ?? 120, 'type="number" min="15" max="86400" step="1" required')}<p class="hint full-span">间隔可设为 15 至 86400 秒。提交后等待设备执行回执，超时不会视为成功。</p>${submit('请求更新策略')}</form>`); }

async function locationSharesDialog(cursor) {
  const petId = state.petId;
  const query = new URLSearchParams({ limit: '10' });
  if (cursor) query.set('cursor', cursor);
  const { items, next_cursor } = await api.get(`/pets/${petId}/location-shares?${query}`);
  const lost = state.overview?.device?.reporting.lost_mode;
  const activeSession = lost?.enabled && Date.parse(lost.session.expires_at) > Date.now() ? lost.session : null;
  const rows = items.map((item) => {
    const expired = Date.parse(item.expires_at) <= Date.now();
    const status = item.revoked_at ? '已撤销' : expired ? '已到期' : '未撤销';
    const canRevoke = !item.revoked_at && !expired && (role() === 'owner' || state.me.id === item.created_by);
    return `<div class="data-row"><div class="row-body"><div class="row-title">${status}</div><div class="row-note">创建于 ${esc(when(item.created_at))} · 有效期至 ${esc(when(item.expires_at))}</div></div>${canRevoke ? button('撤销', 'revoke-location-share', `data-id="${esc(item.id)}"`) : ''}</div>`;
  }).join('');
  const form = cursor ? '' : activeSession ? `<form id="location-share-form" class="form-grid" data-pet="${esc(petId)}">
      <label>分享有效期<select name="minutes"><option value="15">15 分钟</option><option value="60" selected>1 小时</option><option value="240">4 小时</option><option value="1440">24 小时</option></select></label>
      <label class="share-consent full-span"><input type="checkbox" name="consent" required>我同意持有链接的人查看宠物的位置。</label>
      <p class="hint full-span">分享最晚于本次走失会话结束时失效。请仅发给可信的接收者。</p>
      <div class="full-span"><button class="button primary" type="submit">创建分享链接</button></div>
    </form>` : '<p class="hint">宠物绑定设备并开启走失模式后，可创建分享链接。</p>';
  dialog('位置分享', `${form}<section class="share-history"><h3>分享记录</h3>${rows ? `<div class="rows">${rows}</div><p class="hint">链接还受走失会话、设备绑定和创建人授权状态约束。</p>` : empty('暂无分享记录')}<div class="share-actions">${cursor ? button('返回第一页', 'location-shares') : ''}${next_cursor ? button('下一页', 'location-shares', `data-cursor="${esc(next_cursor)}"`) : ''}</div></section>`);
}

function locationShareReceipt(share) {
  const url = new URL(`share.html#${encodeURIComponent(share.token)}`, location.href).href;
  dialog('分享链接已创建', `<p class="hint">有效至 ${esc(when(share.expires_at))}。请现在复制链接，关闭后无法从历史记录取回。</p>
    <label class="field share-history">分享链接<input id="share-url" type="text" readonly value="${esc(url)}"></label>
    <div class="share-actions">${button('复制链接', 'copy-location-share')}<a class="button small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开分享页</a>${button('返回分享记录', 'location-shares')}</div>
    ${['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ? '<p class="hint">当前链接只在本机可打开。跨设备分享需使用接收者能访问的服务地址。</p>' : ''}`);
}

const notificationFilters = { all: '全部', unread: '未读', read: '已读' };
const notificationPreferences = { geofence: '围栏进出', battery: '低电量', offline: '设备离线', location: '定位过期' };
function noticeContext({ filter, cursor }, content, event = '') {
  return `<div id="notification-context" data-filter="${esc(filter)}" data-cursor="${esc(cursor)}" data-event="${esc(event)}">${content}</div>`;
}
const noticePageAttrs = (filter, cursor = '') => `data-filter="${esc(filter)}" data-cursor="${esc(cursor)}"`;

async function notificationInbox(filter = 'all', cursor = '') {
  const query = new URLSearchParams({ limit: '10' });
  if (filter !== 'all') query.set('unread', String(filter === 'unread'));
  if (cursor) query.set('cursor', cursor);
  const { items, next_cursor } = await api.get(`/notifications?${query}`);
  const filters = Object.entries(notificationFilters).map(([key, name]) => button(name, 'notification-inbox', `${noticePageAttrs(key)} aria-pressed="${filter === key}"`)).join('');
  const rows = items.map((item) => {
    const name = state.pets.find((current) => current.id === item.pet_id)?.name ?? '宠物';
    return `<div class="data-row"><div class="row-body"><div class="row-title">${esc(label(item.type))} ${badge(item.read_at ? '已读' : '未读', item.read_at ? 'neutral' : 'warning')}</div>
      <div class="row-note">${esc(name)} · ${esc(when(item.created_at))}<br>${esc(noticeDelivery[item.status] ?? '通道状态未知')}${item.read_at ? ` · 已读于 ${esc(when(item.read_at))}` : ''}</div></div>
      <div class="row-actions">${button('查看事件', 'notification-event', `data-id="${esc(item.event_id)}"`)}${item.read_at ? '' : button('标为已读', 'read', `data-id="${esc(item.id)}"`)}</div></div>`;
  }).join('');
  dialog('通知中心', noticeContext({ filter, cursor }, `
    <div class="toolbar notice-filters" role="group" aria-label="通知筛选">${filters}${button('提醒偏好', 'notification-preferences')}</div>
    ${rows ? `<div class="rows">${rows}</div>` : empty(filter === 'all' ? '暂无通知' : `暂无${notificationFilters[filter]}通知`)}
    <div class="share-actions">${cursor ? button('返回最新', 'notification-inbox', noticePageAttrs(filter)) : ''}${next_cursor ? button('更早通知', 'notification-inbox', noticePageAttrs(filter, next_cursor)) : ''}</div>
    <p class="hint">这里只显示发给你的通知。通道处理与本人已读分别记录，手机实际送达未知。</p>`));
}

async function notificationEvent(id, context) {
  const event = await api.get(`/safety-events/${id}`);
  const eventPet = state.pets.find((item) => item.id === event.pet_id);
  const eventRole = state.households.find((item) => item.id === eventPet?.household_id)?.role;
  dialog('安全事件详情', noticeContext(context, `${button('返回通知', 'notification-inbox', noticePageAttrs(context.filter, context.cursor))}<div class="notice-detail">${renderEventDetail(event, { canWrite: ['owner', 'caregiver'].includes(eventRole) })}</div>`, id));
}

async function notificationPreferencesDialog(context) {
  const settings = await api.get('/notification-preferences');
  const options = Object.entries(notificationPreferences).map(([key, name]) => `<label class="share-consent full-span"><input type="checkbox" name="${key}"${settings[key] ? ' checked' : ''}>${name}</label>`).join('');
  dialog('提醒偏好', noticeContext(context, `<form id="notification-preferences-form" class="form-grid">
    <p class="hint full-span">关闭某类提醒后，该类新事件不会为你生成通知，尚未发送的通知可能跳过投递。既有通知保留，仍可在「足迹与事件」查看安全事件。</p>
    ${options}<div class="form-actions full-span">${button('返回通知', 'notification-inbox', noticePageAttrs(context.filter, context.cursor))}<button class="button primary" type="submit">保存偏好</button></div></form>`));
}

async function afterNotificationAction(message) {
  const context = $('#notification-context')?.dataset;
  if (!context) return changed(message);
  await refresh();
  if (state.me && modal.open) {
    if (context.event) await notificationEvent(context.event, context);
    else await notificationInbox(context.filter, context.cursor);
  }
  notify(message);
}

const ticketCategories = { location: '定位不准', notification: '提醒异常', binding: '绑定问题', battery: '电量异常', wearing: '佩戴不适', other: '其他问题' };
const ticketStatuses = { open: '待处理', in_progress: '处理中', resolved: '已解决' };
const ticketPath = (staff) => staff ? '/admin/support/tickets' : '/support/tickets';
const ticketPageAttrs = ({ staff, status = '', cursor = '' }) => `data-staff="${staff}" data-status="${esc(status)}" data-cursor="${esc(cursor)}"`;
const ticketContext = (context, content) => `<div id="ticket-context" ${ticketPageAttrs(context)}>${content}</div>`;
const readTicketContext = ({ staff, status, cursor }) => ({ staff: staff === 'true', status, cursor });
const ticketPetName = (ticket) => state.pets.find((item) => item.id === ticket.pet_id)?.name;
const ticketDevice = () => state.overview?.pet.id === state.petId ? state.overview.device : null;

async function ticketList(context) {
  const { staff, status, cursor } = context;
  const query = new URLSearchParams({ limit: '10' });
  if (status) query.set('status', status);
  if (cursor) query.set('cursor', cursor);
  const { items, next_cursor } = await api.get(`${ticketPath(staff)}?${query}`);
  const filters = Object.entries({ '': '全部', ...ticketStatuses }).map(([value, name]) => button(name, 'support-list', `${ticketPageAttrs({ staff, status: value })} aria-pressed="${value === status}"`)).join('');
  const rows = items.map((item) => `<div class="data-row"><div class="row-body"><div class="row-title">${esc(ticketCategories[item.category])} ${badge(ticketStatuses[item.status], 'neutral')}</div>
    <div class="row-note">${item.device_id ? (ticketPetName(item) ? `${esc(ticketPetName(item))} · ` : '') : '绑定前求助 · '}${esc(when(item.created_at))}</div></div>${button('查看工单', 'support-detail', `data-id="${esc(item.id)}"`)}</div>`).join('');
  const device = ticketDevice();
  const create = staff ? '' : `<div class="toolbar">${button('绑定前求助', 'support-new', 'data-before-binding="true"')}${device ? button('提交工单', 'support-new') : ''}</div>`;
  dialog(staff ? '客服处理' : '我的工单', ticketContext(context, `${create}
    <div class="toolbar notice-filters" role="group" aria-label="工单状态筛选">${filters}</div>
    ${rows ? `<div class="rows">${rows}</div>` : empty('暂无符合条件的工单')}
    <div class="share-actions">${cursor ? button('返回最新', 'support-list', ticketPageAttrs({ staff, status })) : ''}${next_cursor ? button('更早工单', 'support-list', ticketPageAttrs({ staff, status, cursor: next_cursor })) : ''}</div>`));
}

function newTicketDialog(beforeBinding) {
  const device = ticketDevice();
  if (beforeBinding) {
    dialog('绑定前求助', `<form id="support-create-form" class="form-grid">
      <p class="hint full-span">描述卡在哪一步。你可在「我的工单」查看客服回复。请勿填写密码、绑定码或设备令牌。</p>
      <div class="full-span">${area('问题描述', 'description', '', 'required maxlength="4000"')}</div>
      ${submit('确认提交')}</form>`);
    return;
  }
  if (!device) return;
  dialog('提交工单', `<form id="support-create-form" class="form-grid" data-id="${esc(device.id)}">
    <p class="hint full-span">${esc(pet().name)} · 设备 ${esc(device.serial_no)}</p>
    <label>问题类别<select name="category">${Object.entries(ticketCategories).map(([value, name]) => `<option value="${value}">${name}</option>`).join('')}</select></label>
    <div class="full-span">${area('问题描述', 'description', '', 'required maxlength="4000"')}</div>
    <label class="share-consent full-span"><input type="checkbox" name="diagnostics_consent">同意客服查看本次工单的设备诊断摘要</label>
    <p class="hint full-span">授权最长七天，可随时撤销。快照包含设备状态、告警及上报延迟摘要，不含精确轨迹、设备令牌或原始报文。</p>
    ${submit('确认提交')}</form>`);
}

function showTicket(ticket, context, diagnostics) {
  const { staff } = context, grant = ticket.diagnostics;
  const consent = !ticket.device_id ? '绑定前求助，仅包含文字描述' : grant.revoked_at ? '已撤销' : grant.available ? `有效至 ${when(grant.expires_at)}` : grant.consented_at ? '已到期或失效' : '未授权';
  const history = ticket.history.map((item) => `<div class="history-item"><strong>${esc(ticketStatuses[item.status])}</strong><small>${esc(when(item.created_at))}</small>${item.reply ? `<p>${esc(item.reply)}</p>` : ''}</div>`).join('');
  const replyOptions = ['in_progress', 'resolved'];
  const reply = staff ? `<h3>回复与状态</h3><form id="support-reply-form" class="form-grid" data-id="${esc(ticket.id)}">
    <label>处理状态<select name="status">${replyOptions.map(value => `<option value="${value}"${ticket.status === value ? ' selected' : ''}>${ticketStatuses[value]}</option>`).join('')}</select></label>
    <div class="full-span">${area('客服回复（可选）', 'reply', '', 'maxlength="4000"')}</div>
    <div class="full-span"><button class="button primary" type="submit">保存处理结果</button></div></form>` : '';
  dialog('工单详情', ticketContext(context, `${button('返回工单列表', 'support-list', ticketPageAttrs(context))}
    <h3>${esc(ticketCategories[ticket.category])} ${badge(ticketStatuses[ticket.status], 'neutral')}</h3>
    <div class="row-note">${ticketPetName(ticket) ? `${esc(ticketPetName(ticket))} · ` : ''}${esc(when(ticket.created_at))} · 工单 ${esc(ticket.id)}</div>
    <p class="record-value">${esc(ticket.description)}</p>
    <h3>诊断授权</h3><p class="hint">${esc(consent)}</p>
    <div class="share-actions">${staff && grant.available && !diagnostics ? button('查看诊断快照', 'support-diagnostics', `data-id="${esc(ticket.id)}" data-device="${esc(ticket.device_id)}"`) : ''}
    ${!staff && grant.consented_at && !grant.revoked_at ? button('撤销诊断授权', 'support-revoke', `data-id="${esc(ticket.id)}"`) : ''}</div>
    ${diagnostics ? `<section id="support-diagnostics">${renderSupportDiagnostics(diagnostics)}</section>` : ''}
    <h3>处理历史</h3>${history}${reply}`));
}

async function ticketDetail(id, context) {
  showTicket(await api.get(`${ticketPath(context.staff)}/${id}`), context);
}

async function run(task) {
  if (state.busy) return;
  state.busy = true;
  const controls = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
  controls.forEach((control) => { control.disabled = true; });
  if ($('#dialog-error')) $('#dialog-error').textContent = '';
  try { await task(); }
  catch (error) { const message = errorText(error); if (state.me && !api.authenticated) { clearAccount(); state.authError = message; renderAuth(); } else if ($('#dialog-error') && modal.open) $('#dialog-error').textContent = message; else if (!state.me) { state.authError = message; renderAuth(); } else notify(message, true); }
  finally { state.busy = false; controls.forEach((control) => { if (control.isConnected) control.disabled = false; }); }
}
async function changed(message) { modal.close(); await refresh(); notify(message); }
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled || state.busy) return;
  const action = target.dataset.action, id = target.dataset.id;
  if (action === 'close') { modal.close(); return; }
  if (action === 'auth-login' || action === 'auth-register') { state.authMode = action === 'auth-login' ? 'login' : 'register'; state.authError = ''; renderAuth(); return; }
  if (action === 'tab') { state.tab = target.dataset.tab; run(refresh); return; }
  if (action === 'refresh') { run(refresh); return; }
  if (action === 'activity-yesterday') {
    state.activityDate = new Date(Date.parse(`${state.comparison.local_date}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    run(refresh); return;
  }
  if (action === 'activity-evidence') { activityEvidenceDialog(id); return; }
  if (action === 'new-pet') { petDialog(); return; }
  if (action === 'edit-pet') { if (writable()) petDialog(pet()); return; }
  if (action === 'new-care') { if (writable()) careDialog(); return; }
  if (action === 'edit-care') { careDialog(state.care.find((record) => record.id === id)); return; }
  if (action === 'new-fence') { fenceDialog(); return; }
  if (action === 'edit-fence') { const fence = selectedFence(id); if (fence) fenceDialog(fence); return; }
  if (action === 'enable-fence') { dialog('启用这个围栏？', `<form id="enable-fence-form" data-id="${esc(id)}"><p class="hint">启用后等待新的有效定位。当前状态将重置为未知。</p>${submit('确认启用')}</form>`); return; }
  if (action === 'retry-telemetry') {
    const status = $('#failure-list').dataset.status;
    dialog('重新排队', `<form id="retry-telemetry-form" class="form-grid" data-id="${esc(id)}" data-status="${esc(status)}"><p class="hint full-span">重试由后台处理。请先确认导致失败的问题已处理，并记录重试理由。</p><div class="full-span">${area('重试理由', 'reason', '', 'required maxlength="500"')}</div><div class="form-actions full-span">${button('返回失败列表', 'telemetry-failures', `data-status="${esc(status)}"`)}<button type="submit" class="button primary">确认重新排队</button></div></form>`);
    return;
  }
  if (action === 'policy') { policyDialog(); return; }
  if (action === 'claim') { dialog('绑定穿戴设备', `<form id="claim-form" class="form-grid">${field('设备 ID', 'device_id', '', 'required')}${field('绑定码', 'claim_code', '', 'required autocomplete="off"')}<p class="hint full-span">使用已预置设备的有效绑定码。每个宠物只能绑定一台设备。</p>${submit('确认绑定')}</form>`); return; }
  if (action === 'unbind-device') { dialog('解绑当前设备？', `<form id="unbind-form" data-id="${esc(id)}"><p>解绑会停止此宠物的当前设备状态与策略、关闭相关开放事件，保留历史资料。随后生成重新绑定码，所有权仍保留。</p>${submit('确认解绑')}</form>`); return; }
  if (action === 'remove-member') { dialog('移除家庭成员？', `<form id="remove-member-form" data-id="${esc(id)}" data-household="${esc(target.dataset.household)}"><p>移除 ${esc(target.dataset.email)} 后，该账号不能继续访问本家庭资料；已有照护记录保留。需要再次加入时可重新邀请。</p>${submit('确认移除')}</form>`); return; }
  if (action === 'withdraw') { dialog('撤回这条照护记录？', `<form id="withdraw-form" data-id="${esc(id)}" class="form-grid"><p class="hint full-span">撤回后保留历史和原附件，记录将不再计入有效照护数据。体重记录撤回后会重新计算最近有效体重。</p>${area('撤回理由', 'reason', '', 'required maxlength="500"')}${submit('确认撤回')}</form>`); return; }
  if (action === 'disable-fence') { dialog('停用这个围栏？', `<form id="disable-fence-form" data-id="${esc(id)}"><p class="hint">停用后围栏状态会重置，相关开放围栏事件将关闭。</p>${submit('确认停用')}</form>`); return; }
  if (action === 'location-shares') { run(() => locationSharesDialog(target.dataset.cursor)); return; }
  if (action === 'revoke-location-share') { dialog('撤销位置分享？', `<form id="revoke-location-share-form" data-id="${esc(id)}"><p>撤销后，接收者将无法再读取此链接的位置。</p>${submit('确认撤销')}</form>`); return; }
  if (action === 'copy-location-share') {
    const input = $('#share-url');
    const select = () => { input.focus(); input.select(); notify('已选中链接，请手动复制。'); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(input.value).then(() => notify('已复制分享链接。'), select);
    else select();
    return;
  }
  if (action === 'lost-mode') { const enabled = state.overview.device.reporting.lost_mode.enabled; dialog(enabled ? '关闭走失模式？' : '开启走失模式', `<form id="lost-form" class="form-grid" data-enabled="${!enabled}"><p class="hint full-span">${enabled ? '关闭后请求恢复之前的上报策略，实际执行以设备回执为准。' : '请求每 15 秒上报一次定位；实际执行以设备回执为准。'}</p>${enabled ? '' : field('持续时间（分钟）', 'minutes', 60, 'type="number" min="1" max="1440" step="1" required')}${submit(enabled ? '确认关闭' : '请求开启')}</form>`); return; }
  run(async () => {
    if (action === 'demo-login') { const account = state.health?.demo_accounts?.[target.dataset.role]; if (account) { state.authError = ''; await loadAccount(await api.login(account)); } }
    if (action === 'family') await familyDialog();
    if (action === 'account-export') await accountExportDialog();
    if (action === 'generate-account-export') await generateAccountExport();
    if (action === 'operations') await operationsDialog();
    if (action === 'telemetry-failures') await telemetryFailuresDialog(target.dataset.status, target.dataset.cursor);
    if (action === 'support-list') await ticketList(readTicketContext(target.dataset));
    if (action === 'support-new') newTicketDialog(target.dataset.beforeBinding === 'true');
    if (action === 'support-detail') await ticketDetail(id, readTicketContext($('#ticket-context').dataset));
    if (action === 'support-diagnostics') {
      const context = readTicketContext($('#ticket-context').dataset);
      const ticket = await api.get(`${ticketPath(true)}/${id}`);
      const diagnostics = await api.get(`/admin/devices/${target.dataset.device}/diagnostics?${new URLSearchParams({ ticket_id: id })}`);
      showTicket(ticket, context, diagnostics);
    }
    if (action === 'support-revoke') {
      const context = readTicketContext($('#ticket-context').dataset);
      dialog('撤销诊断授权', ticketContext(context, `<form id="support-revoke-form" data-id="${esc(id)}"><p>撤销后，客服无法再打开本工单的设备诊断快照。工单及回复会保留。</p><div class="form-actions">${button('返回工单详情', 'support-detail', `data-id="${esc(id)}"`)}<button type="submit" class="button primary">确认撤销授权</button></div></form>`));
    }
    if (action === 'notification-inbox') await notificationInbox(target.dataset.filter, target.dataset.cursor);
    if (action === 'notification-event') await notificationEvent(id, $('#notification-context').dataset);
    if (action === 'notification-preferences') await notificationPreferencesDialog($('#notification-context').dataset);
    if (action === 'renew-claim') claimReceipt(await api.send('POST', `/devices/${id}/claim-code`));
    if (action === 'event-detail') dialog('安全事件详情', renderEventDetail(await api.get(`/safety-events/${id}`), { canWrite: writable() }));
    if (action === 'history-more-locations' || action === 'history-more-events') {
      const locations = action === 'history-more-locations', page = state.history[locations ? 'locations' : 'events'];
      const query = new URLSearchParams({ limit: '20', cursor: page.next_cursor });
      if (locations) { query.set('from', page.range.from); query.set('to', page.range.to); }
      const next = await api.get(`/pets/${state.petId}/${locations ? 'locations' : 'safety-events'}?${query}`);
      page.items.push(...next.items); page.next_cursor = next.next_cursor; render();
    }
    if (action === 'logout') { try { await api.logout(); } finally { clearAccount(); state.authError = ''; renderAuth(); } }
    if (action === 'ack') { await api.send('POST', `/safety-events/${id}/ack`, {}); await afterNotificationAction('已记录你对该事件的知晓，事件状态仍由实际数据决定。'); }
    if (action === 'read') { await api.send('PATCH', `/notifications/${id}/read`); await afterNotificationAction('通知已标为已读。'); }
    if (action === 'history') await historyDialog(id);
    if (action === 'attachments') attachmentDialog(await api.get(`/care-records/${id}`));
    if (action === 'load-more') { const result = await api.get(carePath(state.cursor)); state.care.push(...result.items); state.cursor = result.next_cursor; render(); }
    if (action === 'preview' || action === 'download') {
      const record = await api.get(`/care-records/${target.dataset.record}`), file = record.attachments.find((item) => item.id === id);
      const result = await api.blob(file.download_path);
      if (action === 'preview') { const url = URL.createObjectURL(result.blob); dialog(file.filename, `<img class="image-preview" src="${esc(url)}" alt="${esc(file.filename)}"><p class="hint">${esc(file.filename)}</p>`); if (blobUrl) URL.revokeObjectURL(blobUrl); blobUrl = url; }
      else { const url = URL.createObjectURL(result.blob); const link = document.createElement('a'); link.href = url; link.download = file.filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  });
});
document.addEventListener('change', (event) => {
  if (state.busy) return;
  const target = event.target;
  if (target.type === 'file') intents.delete(target.form);
  if (target.name === 'shape' && target.form?.id === 'fence-form') syncFenceGeometry(target.form);
  if (target.id === 'family-select') { run(() => familyDialog(target.value)); }
  if (target.id === 'pet-select') { state.petId = target.value; state.activityDate = todayForPet(); state.historyRange = {}; run(refresh); }
  if (target.id === 'care-kind') $('#care-fields').innerHTML = careFields(target.value);
  if (target.id === 'care-type-filter' || target.id === 'care-status-filter') { state[target.id === 'care-type-filter' ? 'filterType' : 'filterStatus'] = target.value; run(refresh); }
  if (target.id === 'activity-date' && target.value) { state.activityDate = target.value; run(refresh); }
});
document.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target; if (state.busy || !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form)), id = form.dataset.id;
  run(async () => {
    if (form.id === 'auth-form') { state.authError = ''; const session = await api[state.authMode]({ ...values, ...(state.authMode === 'register' ? { timezone: deviceTimezone } : {}) }); await loadAccount(session); return; }
    if (form.id === 'pet-form') {
      const body = { name: values.name, species: values.species, breed: values.breed || null, birth_date: values.birth_date || null, timezone: values.timezone.trim() || null };
      if (id) { await api.send('PATCH', `/pets/${id}`, body); await changed('宠物资料已更新。'); }
      else { const created = await sendForm(form, 'POST', '/pets', { ...body, household_id: values.household_id, ...(values.weight_kg ? { weight_kg: Number(values.weight_kg) } : {}) }); state.petId = created.id; state.pets.push(created); state.activityDate = todayForPet(); state.historyRange = {}; await changed('已建立宠物档案。'); }
    }
    if (form.id === 'household-form') { await api.send('PATCH', `/households/${id}`, values); await refresh(); await familyDialog(id); notify('家庭设置已更新。'); }
    if (form.classList.contains('member-form')) { await api.send('PATCH', `/households/${form.dataset.household}/members/${form.dataset.user}`, { role: values.role }); await familyDialog(form.dataset.household); notify('成员角色已更新。'); }
    if (form.id === 'invite-form') { const invitation = await api.send('POST', `/households/${id}/invitations`, values); await familyDialog(id, `<div class="readonly"><strong>已为 ${esc(invitation.email)} 生成邀请</strong><label class="field">邀请码<input readonly value="${esc(invitation.token)}"></label><div>有效至 ${esc(when(invitation.expires_at))}，请交给对应用户自行接受。</div></div>`); }
    if (form.id === 'accept-invite-form') { const accepted = await api.send('POST', `/invitations/${encodeURIComponent(values.token.trim())}/accept`); state.familyId = accepted.household_id; await loadAccount(await api.resume()); await familyDialog(accepted.household_id); notify('已加入家庭，可以关闭窗口选择家庭宠物。'); }
    if (form.id === 'remove-member-form') { await api.send('DELETE', `/households/${form.dataset.household}/members/${id}`); await refresh(); await familyDialog(form.dataset.household); notify('已移除该成员。'); }
    if (form.id === 'unbind-form') { const receipt = await api.send('POST', `/devices/${id}/unbind`); await refresh(); claimReceipt(receipt); }
    if (form.id === 'history-range-form') { const from = new Date(values.from), to = new Date(values.to); if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw new Error('请选择有效的起止时间，结束时间应晚于开始时间。'); state.historyRange = { from: from.toISOString(), to: to.toISOString() }; await refresh(); }
    if (form.id === 'care-form') {
      const old = id ? state.care.find((record) => record.id === id) : null, type = old?.type || values.type, value = { ...(old?.value || {}) };
      const keys = { weight: ['weight_kg'], feeding: ['food', 'amount_g'], medication: ['name', 'dose'], grooming: ['activity'], note: ['text'], toileting: ['kind', 'text'], custom: ['text'] }[type];
      for (const key of keys) value[key] = ['weight_kg', 'amount_g'].includes(key) ? Number(values[key]) : values[key];
      const body = { value, recorded_at: old && values.recorded_at === localInput(old.recorded_at) ? old.recorded_at : new Date(values.recorded_at).toISOString(), notes: values.notes, ...(type === 'custom' ? { custom_type: values.custom_type } : {}) };
      await sendForm(form, id ? 'PATCH' : 'POST', id ? `/care-records/${id}` : '/care-records', id ? body : { ...body, pet_id: state.petId, type }); await changed(id ? '照护记录已更新，历史版本已保留。' : '照护记录已保存，可在记录中添加附件。');
    }
    if (form.id === 'withdraw-form') { await sendForm(form, 'POST', `/care-records/${id}/withdraw`, { reason: values.reason }); await changed('照护记录已撤回，历史和原附件仍可查看。'); }
    if (form.id === 'activity-feedback-form') {
      const assessment = event.submitter?.value;
      if (!Object.hasOwn(feedbackLabels, assessment)) return;
      const comment = values.comment.trim();
      if (!comment) throw new Error('请填写反馈说明。');
      await sendForm(form, 'POST', `/pets/${form.dataset.pet}/feedback`, { feature_date: form.dataset.date, assessment, comment, observation: { id, evidence_id: form.dataset.evidence } });
      if (form.isConnected && modal.open) {
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.className = 'readonly';
        status.textContent = `反馈已保存 · ${feedbackLabels[assessment]}`;
        form.replaceWith(status);
      }
    }
    if (form.id === 'attachment-form') { const file = values.file; if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MiB 的有效附件。'); await api.upload(`/care-records/${id}/attachments`, file, undefined, intentKey(form, { name: file.name, size: file.size, type: file.type, modified: file.lastModified })); const record = await api.get(`/care-records/${id}`); await refresh(); attachmentDialog(record); notify('附件已上传。'); }
    if (form.id === 'claim-form') { await api.send('POST', '/devices/claim', { ...values, pet_id: state.petId }); await changed('设备已绑定，等待设备上报数据。'); }
    if (form.id === 'fence-form') {
      const body = fenceFormBody(values, id ? selectedFence(id) : undefined);
      if (id) {
        if (!Object.keys(body).length) { modal.close(); return; }
        await api.send('PATCH', `/geofences/${id}`, body);
        await changed('围栏已保存。');
      } else {
        await sendForm(form, 'POST', '/geofences', { pet_id: state.petId, ...body });
        await changed('围栏已创建，状态将在有效定位上报后判断。');
      }
    }
    if (form.id === 'enable-fence-form') { await api.send('PATCH', `/geofences/${id}`, { enabled: true }); await changed('围栏已启用，等待有效定位。'); }
    if (form.id === 'disable-fence-form') { await api.send('DELETE', `/geofences/${id}`); await changed('围栏已停用。'); }
    if (form.id === 'retry-telemetry-form') {
      await sendForm(form, 'POST', `/ingest/events/${id}/retry`, { reason: values.reason.trim() });
      await telemetryFailuresDialog(form.dataset.status, '', '已重新排队，等待后台处理。');
    }
    if (form.id === 'policy-form') { await sendForm(form, 'PUT', `/devices/${state.overview.device.id}/reporting-policy`, { mode: values.mode, interval_seconds: Number(values.interval_seconds) }); await changed('上报策略已请求，等待设备执行回执。'); }
    if (form.id === 'lost-form') { await sendForm(form, 'POST', `/devices/${state.overview.device.id}/lost-mode`, { enabled: form.dataset.enabled === 'true', ...(values.minutes ? { expires_in_seconds: Number(values.minutes) * 60 } : {}) }); await changed('走失模式请求已提交，请查看设备的实际执行状态。'); }
    if (form.id === 'location-share-form') { locationShareReceipt(await api.send('POST', `/pets/${form.dataset.pet}/location-shares`, { consent: values.consent === 'on', expires_in_seconds: Number(values.minutes) * 60 })); }
    if (form.id === 'revoke-location-share-form') { await api.send('DELETE', `/location-shares/${id}`); await locationSharesDialog(); notify('位置分享已撤销。'); }
    if (form.id === 'notification-preferences-form') {
      const { filter, cursor } = $('#notification-context').dataset;
      const preferences = Object.fromEntries(Object.keys(notificationPreferences).map(key => [key, values[key] === 'on']));
      await api.send('PATCH', '/notification-preferences', preferences);
      await notificationInbox(filter, cursor);
      $('#dialog-error').textContent = '';
      notify('提醒偏好已保存。');
    }
    if (form.id === 'support-create-form') {
      const body = id ? { device_id: id, category: values.category, description: values.description, diagnostics_consent: values.diagnostics_consent === 'on' }
        : { category: 'binding', description: values.description };
      const ticket = await sendForm(form, 'POST', ticketPath(false), body);
      await ticketDetail(ticket.id, { staff: false });
    }
    if (form.id === 'support-revoke-form') {
      const context = readTicketContext($('#ticket-context').dataset);
      await api.send('DELETE', `${ticketPath(false)}/${id}/diagnostics-consent`);
      await ticketDetail(id, context);
    }
    if (form.id === 'support-reply-form') {
      const context = readTicketContext($('#ticket-context').dataset);
      const ticket = await sendForm(form, 'PATCH', `${ticketPath(true)}/${id}`, { status: values.status, reply: values.reply });
      showTicket(ticket, context);
    }
  });
});

renderAuth();
api.get('/health').then((health) => { state.health = health; document.querySelectorAll('.environment').forEach((item) => { item.innerHTML = healthText(); }); const help = $('#auth-entry-help'); if (help) help.innerHTML = renderEntryHelp(); }).catch(() => { document.querySelectorAll('.environment').forEach((item) => { item.textContent = '本地服务暂未连接'; }); });
run(async () => { const session = await api.resume(); if (session) await loadAccount(session); });
