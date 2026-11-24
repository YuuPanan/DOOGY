const esc = (value) => String(value ?? '未知').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const when = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const measure = (value, unit) => Number.isFinite(value) ? `${value} ${unit}` : '未知';
const detail = (name, value) => `<div class="detail-row"><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`;
const details = (...rows) => `<dl class="detail-list">${rows.map(([name, value]) => detail(name, value)).join('')}</dl>`;
const connectionNames = { online: '在线', offline: '离线', unknown: '未知' };
const freshnessNames = { fresh: '新鲜', stale: '已过期', missing: '尚无定位' };
const telemetryNames = { pending: '待处理', retry: '待重试', dead: '死信', processed: '已处理' };
const notificationNames = { simulated: '离线模拟', pending: '等待发送', processing: '处理中', sent: '服务商已受理', skipped: '已跳过', dead: '发送失败' };
const alertNames = { 'geofence.exited': '离开围栏', 'geofence.entered': '进入围栏', 'battery.low': '低电量', 'device.offline': '设备离线', 'location.stale': '定位过期' };
const eventNames = { 'location.reported': '定位上报', 'state.reported': '状态上报', 'activity.reported': '活动上报' };
const nameOf = (labels, code) => Object.hasOwn(labels, code) ? labels[code] : code ?? '未知';
const counts = (values, names) => Object.entries(values).map(([key, count]) => [nameOf(names, key), measure(count, '条')]);
const empty = (message) => `<div class="empty"><strong>${message}</strong></div>`;

function delay({ p95_ms, samples }) {
  return `${measure(p95_ms, '毫秒')} · ${measure(samples, '个样本')}`;
}

export function renderOperations(report, householdName) {
  const { window, devices, totals, queue, telemetry, location_quality: quality, notifications, open_safety_events: risks } = report;
  const deviceRows = devices.map(({ pet_name, serial_no, connection_status, battery_pct, low_battery, last_seen_at, location }) => {
    const age = location.age_seconds < 0 ? `时钟超前 ${Math.round(-location.age_seconds)} 秒` : measure(location.age_seconds == null ? null : Math.round(location.age_seconds), '秒');
    return `<div class="data-row"><div class="row-body">
      <div class="row-title">${esc(pet_name)} · ${esc(nameOf(connectionNames, connection_status))}</div>
      <div class="row-note">${esc(serial_no)} · 电量 ${esc(measure(battery_pct, '%'))}${low_battery ? '（低电量）' : ''}<br>最近接收 ${esc(when(last_seen_at))}<br>最近采样 ${esc(when(location.device_ts))} · ${esc(nameOf(freshnessNames, location.freshness))} · 位置年龄 ${esc(age)}</div>
    </div></div>`;
  }).join('');
  const ratio = Number.isFinite(quality.good_point_ratio) ? `${(quality.good_point_ratio * 100).toFixed(1)}%` : '未知';
  const noticeCounts = counts(notifications.counts_by_status, notificationNames), riskCounts = counts(risks.counts_by_type, alertNames);
  return `<p class="hint">${esc(householdName)} · ${report.mode === 'offline' ? '离线模式' : 'API 模式'} · 生成于 ${esc(when(report.generated_at))}</p>
    <h3>当前绑定设备</h3>
    <p class="hint">共 ${esc(totals.devices)} 台，在线 ${esc(totals.online)}，离线 ${esc(totals.offline)}，状态未知 ${esc(totals.unknown)}，低电量 ${esc(totals.low_battery)}。</p>
    ${deviceRows ? `<div class="rows">${deviceRows}</div>` : empty('当前没有绑定设备')}
    <h3>当前处理积压</h3>
    ${details(...counts({ pending: queue.pending, retry: queue.retry, dead: queue.dead }, telemetryNames), ['最早未完成消息的接收时间', when(queue.oldest_unprocessed_received_at)], ['距最早未完成消息接收', measure(queue.oldest_unprocessed_age_seconds, '秒')])}
    <h3>最近 ${esc(window.hours)} 小时遥测</h3>
    <p class="hint">接收时间范围：${esc(when(window.from))} 至 ${esc(when(window.to))}。</p>
    ${details(['接收上报', measure(telemetry.event_count, '条')], ...counts(telemetry.counts_by_status, telemetryNames), ['设备时钟超前', measure(telemetry.clock_ahead_count, '条')],
      ['采样至接收 P95', delay(telemetry.ingest_delay)], ['接收至开始处理 P95', delay(telemetry.queue_delay)], ['接收至处理完成 P95', delay(telemetry.processing_delay)])}
    <h3>位置质量</h3>
    ${details(['已接收并处理为位置点', measure(quality.received_points, '个')], ['其中合格点', measure(quality.good_points, '个')], ['合格点占比', ratio])}
    <p class="hint">分母为窗口内已接收且已经生成的位置记录，尚未处理的上报不计入。合格点为精度不超过 100 米且无质量标记的 GNSS 点。</p>
    <h3>我的通知通道结果</h3>
    ${noticeCounts.length ? details(...noticeCounts) : empty('窗口内没有本人通知')}
    <p class="hint">这里统计通道处理状态。手机实际送达未知。</p>
    <h3>当前开放安全事件</h3>
    ${riskCounts.length ? details(...riskCounts) : empty('当前没有开放安全事件')}`;
}

const failureFilterButton = (title, status, cursor = '', pressed) => `<button type="button" class="button small" data-action="telemetry-failures" data-status="${esc(status)}" data-cursor="${esc(cursor)}"${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${title}</button>`;

export function renderTelemetryFailures(page, { canRetry = false, status = '', cursor = '' } = {}) {
  const rows = page.items.map((event) => `<div class="data-row"><div class="row-body">
    <div class="row-title">${esc(nameOf(eventNames, event.type))} · ${esc(nameOf(telemetryNames, event.process_status))}</div>
    <div class="row-note">接收于 ${esc(when(event.received_at))} · 已尝试 ${esc(measure(event.attempts, '次'))}<br>事件 ID ${esc(event.event_id)} · 错误代码 ${esc(event.error ?? '未知')}</div></div>
    ${canRetry ? `<button type="button" class="button small" data-action="retry-telemetry" data-id="${esc(event.event_id)}">重新排队</button>` : ''}
  </div>`).join('');
  const filters = [['全部失败', ''], ['待重试', 'retry'], ['死信', 'dead']]
    .map(([title, key]) => failureFilterButton(title, key, '', key === status)).join('');
  return `<div class="toolbar notice-filters" role="group" aria-label="遥测失败状态筛选">${filters}</div>
    ${rows ? `<div class="rows">${rows}</div>` : empty('当前绑定下没有符合条件的失败记录')}
    <div class="share-actions">${cursor ? failureFilterButton('返回最新', status) : ''}${page.next_cursor ? failureFilterButton('更早记录', status, page.next_cursor) : ''}</div>
    <p class="hint">仅显示当前绑定设备的失败遥测。${canRetry ? '重新排队后由 Worker 再次处理，可刷新运行简报查看进度。' : '当前角色可查看失败记录。'}</p>`;
}
