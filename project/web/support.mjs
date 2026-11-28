const esc = (value) => String(value ?? '未知').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const when = (value) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const measurement = (value, unit) => Number.isFinite(value) ? `${value} ${unit}` : '未知';
const detail = (title, value) => `<div class="detail-row"><dt>${title}</dt><dd>${esc(value)}</dd></div>`;

const deviceStates = { online: '在线', offline: '离线', fresh: '新鲜', stale: '已过期', missing: '无定位记录' };
const commandStates = { pending: '等待回执', applied: '已应用', failed: '执行失败', expired: '已超时', superseded: '已被新指令替代', cancelled: '已取消', unconfigured: '未配置' };
const executionSources = { simulator: '离线模拟器', device: '设备回执' };
const alertNames = { 'geofence.exited': '离开围栏', 'geofence.entered': '返回围栏', 'battery.low': '低电量', 'device.offline': '设备离线', 'location.stale': '定位过期' };
const alertStates = { open: '未关闭', closed: '已关闭' };
const notificationStates = { simulated: '离线模拟', pending: '等待发送', processing: '处理中', sent: '服务商已受理', skipped: '已跳过', dead: '发送失败' };
const named = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : '未知';

export function renderSupportDiagnostics({ consent_expires_at, snapshot }) {
  const { device = {}, state = {}, reporting = {}, telemetry = {}, recent_alerts = [], notification_results = [] } = snapshot ?? {};
  const alerts = recent_alerts.map((alert) => `<div class="data-row"><div class="row-body">
    <div class="row-title">${esc(named(alertNames, alert.type))} · ${esc(named(alertStates, alert.status))}</div>
    <div class="row-note">发生于 ${esc(when(alert.occurred_at))}${alert.closed_at ? ` · 关闭于 ${esc(when(alert.closed_at))}` : ''}</div>
  </div></div>`).join('');
  const notifications = notification_results.map((row) => `<div class="data-row"><div class="row-body">
    <div class="row-title">${esc(named(notificationStates, row.status))} · ${esc(measurement(row.count, '条'))}</div>
    ${row.error ? `<div class="row-note">原因代码 ${esc(row.error)}</div>` : ''}
  </div></div>`).join('');

  return `<section aria-label="授权诊断快照">
    <p class="hint">这是提交工单时保存的快照。生成于 ${esc(when(snapshot?.generated_at))}，授权有效至 ${esc(when(consent_expires_at))}。</p>
    <h3>设备状态</h3>
    <dl class="detail-list">
      ${detail('设备型号', device.model)}
      ${detail('设备序列号', device.serial_no)}
      ${detail('固件版本', device.firmware_version)}
      ${detail('电量', measurement(state.battery_pct, '%'))}
      ${detail('连接状态', named(deviceStates, state.connection_status))}
      ${detail('最近连接时间', when(state.last_seen_at))}
      ${detail('最近定位时间', when(state.last_location_at))}
      ${detail('定位新鲜度', named(deviceStates, state.data_freshness))}
    </dl>
    <h3>上报策略与回执</h3>
    <dl class="detail-list">
      ${detail('期望策略版本', reporting.desired_version)}
      ${detail('已应用策略版本', reporting.applied_version)}
      ${detail('指令状态', named(commandStates, reporting.status))}
      ${detail('执行来源', named(executionSources, reporting.execution_source))}
    </dl>
    <h3>最近 24 小时遥测</h3>
    <dl class="detail-list">
      ${detail('上报总量', measurement(telemetry.event_count, '条'))}
      ${detail('采样至接收 P95', measurement(telemetry.ingest_delay_p95_ms, '毫秒'))}
      ${detail('接收到开始处理 P95', measurement(telemetry.queue_delay_p95_ms, '毫秒'))}
      ${detail('接收到处理完成 P95', measurement(telemetry.processing_delay_p95_ms, '毫秒'))}
    </dl>
    <h3>最近安全事件</h3>
    ${alerts ? `<div class="rows">${alerts}</div>` : '<p class="hint">该快照没有近期安全事件。</p>'}
    <h3>通知通道汇总</h3>
    ${notifications ? `<div class="rows">${notifications}</div>` : '<p class="hint">该快照没有近期通知记录。</p>'}
    <p class="hint">这里展示通道处理结果。手机实际送达未知。</p>
  </section>`;
}
