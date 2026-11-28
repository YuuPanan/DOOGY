import { strict as assert } from 'node:assert';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const historyModule = new Function('url', 'return import(url)')(pathToFileURL(resolve('web/history.mjs')).href);
const range = { from: '2026-11-17T00:00:00.001Z', to: '2026-11-18T00:00:00.001Z' };
const point = (id: string, lat = 31.2, extra = {}) => ({ id, device_id: 'device-a', binding_id: 'binding-a', device_ts: `2026-11-17T00:00:0${id}Z`, lat, lon: 121.4, accuracy_m: 0, source: 'gnss', quality_flags: [], freshness: 'stale', usable_for_tracking: false, ...extra });
const data = (items: any[], extra = {}) => ({ locations: { items, range, next_cursor: null, ...extra }, events: { items: [] as any[], next_cursor: null as string | null } });

test('历史客户端：位置范围和两个独立游标按合同发送并保留精确范围', async () => {
  const { loadHistory } = await historyModule, calls: string[] = [];
  const api = { get: async (path: string) => { calls.push(path); return path.includes('/locations?') ? { items: [], range, next_cursor: 'more-locations' } : { items: [], next_cursor: 'more-events' }; } };
  const result = await loadHistory(api, 'pet', { ...range, locationCursor: 'point/one', eventCursor: 'event/two' });
  assert.equal(result.locations.range.to, range.to);
  const locations = new URL(calls[0], 'http://local'), events = new URL(calls[1], 'http://local');
  assert.equal(locations.searchParams.get('limit'), '20'); assert.equal(locations.searchParams.get('cursor'), 'point/one');
  assert.equal(locations.searchParams.get('from'), range.from); assert.equal(locations.searchParams.get('to'), range.to);
  assert.equal(events.searchParams.get('cursor'), 'event/two'); assert.equal(events.searchParams.has('from'), false);
});

test('历史轨迹：无数据不伪造点，合格历史点可画但异常和换绑不连线', async () => {
  const { renderHistory } = await historyModule;
  assert.match(renderHistory(data([])), /至少需要两个/);
  const valid = renderHistory(data([point('1'), point('2', 31.201)]));
  assert.equal((valid.match(/<line /g) ?? []).length, 1); assert.match(valid, /0 m/); assert.match(valid, /采样新鲜度：已过期/);
  assert.doesNotMatch(renderHistory(data([point('1', 31.2, { usable_for_tracking: true }), point('2', 31.201)])), /当前可用于追踪/);
  const split = renderHistory(data([point('1'), point('2', 31.201, { quality_flags: ['poor_accuracy'] }), point('3', 31.202), point('4', 31.203, { binding_id: 'binding-b' }), point('5', 31.204, { device_id: 'device-b' })]));
  assert.equal((split.match(/<line /g) ?? []).length, 0); assert.equal((split.match(/<circle /g) ?? []).length, 4);
  assert.equal((renderHistory(data([point('1', 31.2, { binding_id: null }), point('2', 31.201, { binding_id: null })])).match(/<line /g) ?? []).length, 0);
});

test('历史渲染：事件状态和分页真实显示，动态文字转义', async () => {
  const { renderHistory, renderEventDetail } = await historyModule;
  const state = data([], { next_cursor: 'point-next' });
  state.events = { items: [{ id: 'event"x', type: '<img src=x>', status: 'closed', occurred_at: range.from, closed_at: range.to }], next_cursor: 'event-next' };
  const html = renderHistory(state);
  assert.match(html, /history-more-locations/); assert.match(html, /history-more-events/); assert.match(html, /已关闭/);
  assert.ok(!html.includes('<img src=x>')); assert.match(html, /&lt;img src=x&gt;/); assert.match(html, /data-id="event&quot;x"/);
  const event = { ...state.events.items[0], type: 'battery.low', status: 'open', details: { battery_pct: 0, message: '<script>x</script>' }, location: null, acknowledgement: null, notifications: [{ id: 'note', status: 'simulated', created_at: range.from, read_at: null }] };
  const viewer = renderEventDetail(event, { canWrite: false }), writer = renderEventDetail(event, { canWrite: true });
  assert.ok(!viewer.includes('data-action="ack"')); assert.match(writer, /data-action="ack"/); assert.match(viewer, /data-action="read"/); assert.match(viewer, /0%/);
  assert.match(viewer, /离线模拟/); assert.match(viewer, /手机实际送达/); assert.match(viewer, /&lt;script&gt;/);
  const read = renderEventDetail({ ...event, acknowledgement: { acknowledged_at: range.to, note: '已检查' }, notifications: [{ ...event.notifications[0], read_at: range.to }] }, { canWrite: true });
  assert.ok(!read.includes('data-action="ack"')); assert.ok(!read.includes('data-action="read"')); assert.match(read, /已检查/);
});

test('安全事件历史区分回到围栏、配置关闭和未记录原因的旧记录', async () => {
  const { renderHistory, renderEventDetail } = await historyModule;
  const event = { id: 'closed-fence', type: 'geofence.exited', status: 'closed', occurred_at: range.from, closed_at: range.to,
    closed_reason: 'geofence_returned', details: {}, location: null, acknowledgement: null, notifications: [] };
  for (const [reason, label] of [['geofence_returned', '定位确认已返回围栏'], ['fence_disabled', '围栏已停用'],
    ['fence_rule_changed', '围栏规则已修改'], [null, '未知（旧记录未记录原因）']] as const) {
    const closed = { ...event, closed_reason: reason };
    assert.ok(renderEventDetail(closed).includes(label));
    const state = data([]);
    state.events.items = [closed];
    assert.ok(renderHistory(state).includes(label));
  }
  assert.doesNotMatch(renderEventDetail({ ...event, status: 'open', closed_at: null, closed_reason: null }), /关闭原因/);
});
