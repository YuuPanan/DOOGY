import { ReactNode, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { loadSafetyRange, SafetyPeriod, SafetyRange } from '../lib/safetyHistory';
import { Asset } from './assets';
import { Body, Button, Caption, Card, Field, Heading, Notice, Page, Pill, Row, palette } from './ui';

type Data = Record<string, any>;
type Props = { screenId?: string; navigation: any; route?: any };
type PageProps = { screenId: string; title: string; subtitle: string; navigation: any };
export const SAFETY_SCREEN_IDS = ['28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '38a', '38b', '38c', '39'] as const;
const eventName = (value: string) => ({ 'geofence.exited': 'Outside home zone', 'geofence.entered': 'Back inside home', 'battery.low': 'Low battery', 'device.offline': 'Collar offline', 'location.stale': 'Location needs an update' } as Data)[value] ?? value;
const amount = (value: unknown, suffix = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()}${suffix}` : 'Unknown';
const stateLabel = (value: string | undefined) => ({ inside: '在围栏内', outside: '在围栏外', unknown: '判断未知', online: '最近仍有上报', offline: '设备离线', fresh: '位置新鲜', stale: '位置过期', missing: '暂无位置', pending: '等待设备回执', applied: '设备已回执', failed: '执行失败', expired: '命令超时', superseded: '已被新版本替代', unconfigured: '尚未配置' } as Data)[value ?? ''] ?? value ?? '未知';
function go(navigation: any, screenId: string, params: Data = {}) {
  const method = navigation.push ?? navigation.navigate;
  method.call(navigation, 'Pawch', { ...params, screenId });
}
function SwitchRow({ title, subtitle, value, change, disabled = false }: { title: string; subtitle?: string; value: boolean; change: (value: boolean) => void; disabled?: boolean }) {
  return <View style={s.switchRow}><View style={{ flex: 1, gap: 5 }}><Heading>{title}</Heading>{subtitle && <Caption>{subtitle}</Caption>}</View><Switch accessibilityLabel={title} value={value} onValueChange={change} disabled={disabled} trackColor={{ false: '#BCC9BC', true: palette.forest }} /></View>;
}
function Details({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <View style={{ gap: 10 }}><Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={s.details}><Text style={s.detailsText}>{title}</Text><Text style={s.detailsText}>{open ? '−' : '+'}</Text></Pressable>{open && children}</View>;
}
function MapReference({ name, height, onLive }: { name: string; height: number; onLive?: () => void }) {
  const outside = name === 'outside-zone-map' || name === 'track-baku-map';
  // Exported assets retain their intrinsic geometry; only the Figma instance is scaled.
  const layer = (asset: string, x: number, y: number, sourceWidth: number, sourceHeight: number, scale = 1) => <View key={asset} testID={`demo-${name}-${asset}`} style={{ position: 'absolute', left: x, top: y, width: sourceWidth * scale, height: sourceHeight * scale }}><Asset name={asset} style={{ position: 'absolute', left: sourceWidth * (scale - 1) / 2, top: sourceHeight * (scale - 1) / 2, transform: [{ scale }] }} /></View>;
  return <View accessibilityLabel="原型地图示意 · 地图服务未配置 · 不代表当前宠物的位置" style={[s.map, { height }]}>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}><View style={{ position: 'absolute', top: (height - 310) / 2 }}><Asset name={name} /></View>
      {name !== 'gps-accuracy-map' && layer('map-boundary', outside ? 17 : 71, outside ? 69 : 29, 158, 158, outside ? 122 / 158 : 1)}
      {layer(outside ? 'map-pin-alert' : 'map-pin-safe', outside ? 236 : 143, outside ? 34 : 91, outside ? 40 : 43, outside ? 40 : 43)}
      {layer('map-pin-home', outside ? 24 : 18, outside ? height - 35 : 18, 101, 27, outside ? 90 / 101 : 1)}
      {!outside && <View style={[s.mapScale, { bottom: 11 }]}><Text style={{ color: palette.forest, fontSize: 10 }}>100 m · demo</Text></View>}
    </View><View style={s.demoBadge}><Text style={s.demoBadgeText}>DEMO · 非实时地图</Text></View>
    {onLive && <Pressable accessibilityRole="button" accessibilityLabel="Read actual live status" onPress={onLive} style={s.mapLive}><Text style={s.mapLiveText}>Read actual live status  ›</Text></Pressable>}
  </View>;
}
function PositionFacts({ location }: { location: Data | null }) {
  const fallback = !location?.usable_for_tracking && location?.last_usable_location?.usable_for_tracking ? location.last_usable_location : null;
  return <View style={{ gap: 6 }}><Caption>实际采样：{location?.device_ts ?? '未知'} · 接收：{location?.received_at ?? '未知'}</Caption>
    <Caption>来源：{location?.source ?? '未知'} · 精度：{amount(location?.accuracy_m, ' m')} · {stateLabel(location?.freshness)}</Caption>
    {location?.id && <Body>WGS84 {amount(location.lat)}, {amount(location.lon)}</Body>}
    {!!location?.quality_flags?.length && <Caption>质量标记：{location.quality_flags.join('、')}</Caption>}
    {fallback && <Card tone="sage" title="另有可用参考点"><Body>{fallback.lat}, {fallback.lon}</Body><Caption>采样：{fallback.device_ts} · 这是参考点，不是最近采样点。</Caption></Card>}
  </View>;
}

export function PawchSafetyScreen({ screenId = '28', navigation, route }: Props) {
  const { api, user, pet, households } = useApp();
  const role = households.find(item => item.id === pet?.household_id)?.role ?? 'viewer';
  if (!pet) return <Page screenId={screenId} title="Choose your companion" subtitle="先选择宠物，再读取项圈与安全资料。" navigation={navigation}>
    <Notice text="没有项圈也可以继续日常照护。" /><Button title="选择或建立宠物档案" onPress={() => navigation.navigate('Pet')} /><Button title="帮助与支持" secondary onPress={() => navigation.navigate('Support')} />
  </Page>;
  return <SafetyBody key={`${api.baseUrl}:${user?.id}:${pet.id}:${role}:${screenId}`} screenId={screenId} navigation={navigation} route={route} />;
}
function SafetyBody({ screenId = '28', navigation, route }: Props) {
  const { api, pet: selectedPet, households } = useApp(), pet = selectedPet!;
  const canWrite = ['owner', 'caregiver'].includes(households.find(row => row.id === pet.household_id)?.role ?? 'viewer');
  const common = useResource<Data>(async () => {
    const [overview, latest, fences] = await Promise.all([api.get(`/pets/${pet.id}/overview`), api.get(`/pets/${pet.id}/location/latest`), api.get(`/pets/${pet.id}/geofences`)]);
    if (overview.pet?.id !== pet.id) throw new Error('安全资料与当前宠物不一致，请重读。');
    return { overview, latest: latest?.id ? latest : null, fences: fences.items ?? [] };
  }, [api, pet.id]);
  useEffect(() => navigation.addListener?.('focus', () => { void common.refresh(); }), [navigation, common.refresh]);
  const device = common.data?.overview?.device, location = common.data?.latest ?? null, fences: Data[] = common.data?.fences ?? [];
  const deviceScope = useRef('unread');
  if (common.data) deviceScope.current = device?.id ?? 'unbound';
  const fence = fences.find(row => row.enabled) ?? fences[0], reporting = device?.reporting;
  const inside = location?.usable_for_tracking === true && fence?.state?.effective_status === 'inside';
  const captions: Record<string, [string, string]> = {
    '28': [inside ? 'Safe. Sound. Home.' : 'Location & safety.', 'LOCATION / 最近的服务端记录'],
    '29': [location?.usable_for_tracking ? `${pet.name}, right here.` : 'Waiting for location.', 'LIVE STATUS / 原型布局 · 位置以实际资料为准'],
    '30': ['Location data.', 'GPS ACCURACY / 当前采样依据'], '31': ['Your home safe zone.', 'HOME BOUNDARY / 明确保存后生效'],
    '32': ['A helpful heads-up.', `FENCE NOTIFICATIONS / ${pet.name}`], '33': ['More trail time ahead.', `COLLAR BATTERY / ${pet.name}`],
    '34': ['Find your balance.', 'POWER SETTINGS / 期望策略与回执分别显示'], '35': ['Every coming & going.', 'SAFETY HISTORY / 实际事件'],
    '36': ['Outside-zone alert.', 'BOUNDARY EVENT / 历史依据'], '37': ["Let’s find your explorer.", `TRACK ${pet.name} / 显式寻找会话`],
    '38': ['A clear head. A plan.', 'EMERGENCY ACTIONS / 先核对实际情况'], '38a': [`Report ${pet.name} missing`, 'LOCAL ALERT / 仅本地演示'],
    '38b': ['Review alert', 'LOCAL ANIMAL SERVICES / 仅本地演示'], '38c': ['Demo confirmation', 'SIMULATED ALERT / Nothing sent'],
    '39': ['Bring your people in.', 'SHARE WITH CONTACTS / 本地模拟预览'],
  };
  const [title, subtitle] = captions[screenId] ?? captions['28'];
  const shared = { navigation, screenId, title, subtitle };
  const issue = <>{common.loading && <Caption>正在读取安全资料…</Caption>}{common.error && <><Notice text={common.error} tone="error" /><Button title="重试读取安全资料" secondary onPress={common.refresh} /></>}</>;
  const legacy = <Row title="设备、分享与更多业务" subtitle="绑定、位置分享、运行排障和配置历史" onPress={() => navigation.navigate('Devices')} />;
  if (screenId === '31') return <BoundaryEditor page={shared} issue={issue} fences={fences} ready={!!common.data} reading={common.loading} location={location} canWrite={canWrite} refresh={common.refresh} readError={common.error} navigation={navigation} />;
  if (screenId === '32') return <FencePreferences page={shared} navigation={navigation} />;
  if (screenId === '34') return <PowerSettings page={shared} issue={issue} key={deviceScope.current} device={device} ready={!!common.data} canWrite={canWrite} refresh={common.refresh} readError={common.error} navigation={navigation} />;
  if (screenId === '35') return <Page {...shared} footer={<Button title="View latest outside-zone event" onPress={() => go(navigation, '36')} />}><EventHistory navigation={navigation} /></Page>;
  if (screenId === '36') return <Page {...shared} footer={<><Button title={`Track ${pet.name}`} onPress={() => go(navigation, '37')} /><Button title="Emergency actions" secondary onPress={() => go(navigation, '38')} /></>}>{issue}<OutsideEvent eventId={route?.params?.eventId} navigation={navigation} canWrite={canWrite} /></Page>;
  if (screenId === '37') return <Page {...shared} footer={<Button title="Open emergency actions" onPress={() => go(navigation, '38')} />}>{issue}<MapReference name="track-baku-map" height={280} /><Tracking key={deviceScope.current} device={device} canWrite={canWrite} refresh={common.refresh} readError={common.error} navigation={navigation} /><Details title="View position source"><PositionFacts location={location} /></Details></Page>;
  if (['38a', '38b', '38c'].includes(screenId)) return <MissingDemo page={shared} screenId={screenId} navigation={navigation} route={route} location={location} />;
  if (screenId === '39') return <ContactPreview page={shared} navigation={navigation} />;
  if (screenId === '38') return <Page {...shared} footer={<Button title={`Report ${pet.name} missing`} onPress={() => go(navigation, '38a')} />}>
    <Row title="Track the last reported position" subtitle="先看时点与位置质量，避免追赶到危险区域。" onPress={() => go(navigation, '37')} />
    <Row title="Share with trusted contacts" subtitle="选择、预览并仅在本机模拟" tone="sage" onPress={() => go(navigation, '39')} />
    <Row title="Collar light & sound" subtitle="尚未接入硬件协议，当前不可执行。" disabled />
    <Card tone="sage" title="Keep a clear head"><Body>先确保人员与道路安全。走失报告仅作本地演示；不会联系、派遣、拨号或发送。</Body></Card>
    <Row title="真实联系人与帮助入口" subtitle="本人核对后打开现有联系人与支持业务" onPress={() => navigation.navigate('Contacts')} />
  </Page>;
  if (screenId === '33') return <Page {...shared} footer={<Button title="Open power settings" onPress={() => go(navigation, '34')} />}>
    {issue}<View style={s.battery}><Text style={s.batteryValue}>{amount(device?.battery_pct, '%')}</Text><View style={s.batteryTrack}><View style={[s.batteryFill, { width: typeof device?.battery_pct === 'number' ? `${Math.max(0, Math.min(100, device.battery_pct))}%` : '0%' }]} /></View><Text style={s.citronText}>电量来自项圈上报 · 不估算剩余天数</Text></View>
    <Row title="Low battery alert" subtitle={device?.low_battery == null ? '状态未知' : device.low_battery ? '已记录低电量' : '本次上报未标记低电量'} onPress={() => navigation.navigate('Notifications')} />
    <Row title="Last received" subtitle={device?.last_seen_at ?? '尚无设备上报'} />
    <Row title="Power settings" subtitle="平衡采样需求与电池，执行以设备回执为准" onPress={() => go(navigation, '34')} />
    {!device && <Notice text="当前未读取到绑定项圈，电量保持未知。" />}
  </Page>;
  if (screenId === '30') return <Page {...shared} footer={<Button title="Back to live status" onPress={() => go(navigation, '29')} />}>
    {issue}<MapReference name="gps-accuracy-map" height={212} /><View style={s.accuracy}><Text style={s.largeMetric}>{location?.accuracy_m == null ? 'Unknown' : `±${amount(location.accuracy_m, ' m')}`}</Text><Text style={s.citronText}>{location?.usable_for_tracking ? '本次记录质量可用于参考' : '当前记录不足以可靠追踪'}</Text></View>
    <Body>定位误差代表可能范围，不是精确点。建筑、树木和室内环境会影响定位；原型示意不用于导航。</Body><Details title="View position source"><PositionFacts location={location} /></Details>
  </Page>;
  if (screenId === '29') return <Page {...shared} footer={<Button title="View safety history" onPress={() => go(navigation, '35')} />}>
    {issue}<MapReference name="live-status-map" height={264} /><Row title={stateLabel(fence?.state?.effective_status)} subtitle={`${stateLabel(device?.connection_status)} · ${location?.device_ts ?? '尚无采样时间'}`} tone="sage" onPress={() => go(navigation, '31')} />
    <Row title={`GPS accuracy   ${location?.accuracy_m == null ? 'Unknown' : `±${amount(location.accuracy_m, ' m')}`}`} subtitle="查看来源、时点与质量" onPress={() => go(navigation, '30')} /><Details title="View position source"><PositionFacts location={location} /><Button title="读取最新上报" secondary onPress={common.refresh} /><Caption>刷新只读取已有记录，不触发项圈新定位。</Caption></Details>
  </Page>;
  return <Page {...shared} footer={<Button title="View live status" onPress={() => go(navigation, '29')} />}>
    {issue}<MapReference name="location-map" height={216} onLive={() => go(navigation, '29')} /><View style={s.compactMetrics}>
      {[
        { label: 'GPS', value: location?.accuracy_m == null ? 'Unknown' : `±${amount(location.accuracy_m, 'm')}`, id: '30' },
        { label: 'Home', value: fence?.geometry?.type === 'circle' ? amount(fence.geometry.radius_m, 'm') : '未确认', id: '31' },
        { label: 'Battery', value: amount(device?.battery_pct, '%'), id: '33' },
      ].map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.label} ${item.value}`} onPress={() => go(navigation, item.id)} style={s.compactMetric}><Text style={s.metricLabel}>{item.label}</Text><Text style={s.metricValue}>{item.value}</Text></Pressable>)}
    </View><Row title="Safety history" subtitle="实际位置与边界事件" onPress={() => go(navigation, '35')} />
    <Row title="Outside-zone event" subtitle="查看已记录的越界依据，不制造示例预警" tone="alert" onPress={() => go(navigation, '36')} />
    <Caption>{!device ? '尚未绑定项圈；位置与安全判断保持未知。' : `${stateLabel(device.connection_status)} · ${stateLabel(fence?.state?.effective_status)}`}</Caption><Details title="More device & sharing options">{legacy}</Details>
  </Page>;
}

function BoundaryEditor({ page, issue, fences, ready, reading, location, canWrite, refresh, readError, navigation }: { page: PageProps; issue: ReactNode; fences: Data[]; ready: boolean; reading: boolean; location: Data | null; canWrite: boolean; refresh: () => Promise<void>; readError: unknown; navigation: any }) {
  const { api, pet } = useApp(), initialized = useRef(false);
  const [id, setId] = useState(''), [name, setName] = useState(''), [lat, setLat] = useState(''), [lon, setLon] = useState(''), [radius, setRadius] = useState(''), [enabled, setEnabled] = useState(true), [shape, setShape] = useState('circle');
  const [receipt, setReceipt] = useState<Data | null>(null), [dirty, setDirty] = useState(true), [saving, setSaving] = useState(false), [editing, setEditing] = useState(false);
  function select(fence?: Data) { initialized.current = true; setId(fence?.id ?? ''); setName(fence?.name ?? ''); setLat(String(fence?.geometry?.lat ?? '')); setLon(String(fence?.geometry?.lon ?? '')); setRadius(String(fence?.geometry?.radius_m ?? '')); setEnabled(fence?.enabled ?? true); setShape(fence?.geometry?.type ?? 'circle'); setReceipt(null); setDirty(true); setEditing(!fence); }
  useEffect(() => { if (ready && !initialized.current) select(fences[0]); }, [ready, fences]);
  const edit = (setter: (value: string) => void) => (value: string) => { setter(value); setDirty(true); };
  const numeric = (text: string, label: string, min: number, max: number) => { const number = Number(text); if (!text.trim() || !Number.isFinite(number) || number < min || number > max) throw new Error(`${label}须为${min}至${max}之间的数字`); return number; };
  const saved = !!receipt && !dirty, confirmed = saved && !reading && fences.some(row => row.id === receipt.id && row.name === receipt.name && JSON.stringify(row.geometry) === JSON.stringify(receipt.geometry) && row.enabled === receipt.enabled);
  const stored = fences.find(row => row.id === id), summaryRadius = stored?.geometry?.radius_m ?? radius;
  const save = canWrite && shape === 'circle' ? <Button title="Save home boundary" disabled={!ready || !name.trim() || saved || saving} run={async () => {
    const geometry = { type: 'circle', lat: numeric(lat, '纬度', -90, 90), lon: numeric(lon, '经度', -180, 180), radius_m: numeric(radius, '半径', 1, 100000) };
    const body = { name: name.trim(), geometry, enabled };
    setSaving(true);
    try { const result = id ? await api.patch(`/geofences/${id}`, body) : await api.post('/geofences', { ...body, pet_id: pet!.id });
      setId(result.id); setReceipt(result); setDirty(false); await refresh();
    } finally { setSaving(false); }
  }} /> : <Button title="Back to location" onPress={() => go(navigation, '28')} />;
  return <Page {...page} footer={save}>{issue}<MapReference name="home-boundary-map" height={228} />
    <Pressable accessibilityRole="button" accessibilityLabel={canWrite ? 'Edit boundary details' : 'Review boundary details'} accessibilityState={{ expanded: editing }} disabled={!ready || saving} onPress={() => setEditing(!editing)} style={s.radiusSummary}><View style={{ flex: 1, gap: 4 }}><Text style={s.metricLabel}>{stored ? 'SAVED BOUNDARY' : 'UNSAVED DRAFT'} · {shape === 'circle' ? 'RADIUS' : 'BOUNDARY'}</Text><Text style={s.radiusValue}>{shape === 'circle' && summaryRadius ? `${summaryRadius} m` : shape === 'circle' ? 'Not set' : 'Polygon'}</Text><Text style={s.metricLabel}>{stored?.name ?? (name || '请填写真实边界')} · {(stored?.enabled ?? enabled) ? 'Enabled' : 'Disabled'}</Text></View><Text style={s.detailsText}>{editing ? '−' : '+'}</Text></Pressable>
    {(editing || fences.length > 1) && <View style={s.metricRow}>{fences.map(fence => <Pill key={fence.id} title={fence.name} selected={id === fence.id} disabled={saving} onPress={() => select(fence)} />)}{canWrite && <Pill title="新建围栏" disabled={saving} onPress={() => select()} />}</View>}
    {!canWrite && <Notice text="只读成员可以查看围栏，不能修改共享边界。" />}
    {editing && (shape === 'circle' ? <Card tone="sage"><Caption>RADIUS · WGS84</Caption><Field label="围栏名称" value={name} onChangeText={edit(setName)} editable={canWrite && !saving} /><Field label="Radius (m)" value={radius} onChangeText={edit(setRadius)} keyboardType="decimal-pad" editable={canWrite && !saving} />
      <View style={s.coordinates}><View style={{ flex: 1 }}><Field label="纬度" value={lat} onChangeText={edit(setLat)} editable={canWrite && !saving} /></View><View style={{ flex: 1 }}><Field label="经度" value={lon} onChangeText={edit(setLon)} editable={canWrite && !saving} /></View></View>
      {canWrite && location?.usable_for_tracking && <Button title="采用这条已上报位置" disabled={saving} secondary onPress={() => { setLat(String(location.lat)); setLon(String(location.lon)); setDirty(true); }} />}
      <SwitchRow title="启用此围栏" value={enabled} change={value => { setEnabled(value); setDirty(true); }} disabled={!canWrite || saving} />
    </Card> : <Card tone="sage" title="已保存的多边形围栏"><Body>{name}</Body><Caption>该边界保留原几何，不会从示意图改成圆形。</Caption><Button title="编辑多边形与高级规则" secondary onPress={() => navigation.navigate('Devices', { section: 'fences' })} /></Card>)}
    <Row title="Fence notifications" subtitle="本人围栏通知偏好，与共享边界分开" onPress={() => go(navigation, '32')} />
    <Caption>地图仅作示意，不能拖动设点。更改真实边界后，需等待新的有效定位。</Caption>
    {saved && <Notice text={reading ? '围栏保存已确认，正在重新读取…' : confirmed && !readError ? '围栏已保存并重新读取。' : '围栏保存已确认；列表暂未确认，请只重试读取。'} tone={confirmed && !readError ? 'success' : 'warning'} />}
    {(saved || !!readError) && <Button title="重新读取围栏" secondary onPress={refresh} />}<Details title="Advanced boundary options">{!saved && !readError && <Button title="重新读取围栏" secondary onPress={refresh} />}{canWrite && <Button title="新建另一围栏" secondary disabled={saving} onPress={() => select()} />}<Row title="Advanced boundary settings" subtitle="保留判定缓冲、确认点、多边形及配置历史" onPress={() => navigation.navigate('Devices', { section: 'fences' })} /></Details>
  </Page>;
}

function FencePreferences({ page, navigation }: { page: PageProps; navigation: any }) {
  const { api, user } = useApp(), prefs = useResource<Data>(() => api.get('/notification-preferences'), [api, user?.id]);
  const [enabled, setEnabled] = useState(false), [dirty, setDirty] = useState(false), [saved, setSaved] = useState(false), [saving, setSaving] = useState(false), [submitted, setSubmitted] = useState<boolean | null>(null);
  useEffect(() => { if (prefs.data && !dirty) setEnabled(prefs.data.geofence === true); }, [prefs.data, dirty]);
  const change = (value: boolean) => { setEnabled(value); setDirty(true); setSaved(false); };
  return <Page {...page} footer={<Button title="Save notification settings" disabled={!prefs.data || saved || saving} run={async () => { setSaving(true); try { await api.patch('/notification-preferences', { geofence: enabled }); setSubmitted(enabled); setSaved(true); setDirty(false); await prefs.refresh(); } finally { setSaving(false); } }} />}>{prefs.error && <Notice text={prefs.error} tone="error" />}<Card tone="sage"><SwitchRow title="Boundary exits" subtitle="围栏入口与出口采用同一分类开关" value={enabled} change={change} disabled={!prefs.data || saving} /></Card>
    <Card tone="sage"><SwitchRow title="Back inside" subtitle="与上方同步；不创建另一份围栏规则" value={enabled} change={change} disabled={!prefs.data || saving} /></Card>
    <Row title="Quiet hours" subtitle="当前接口尚未支持静默时段，未配置。" disabled /><Card tone="alert" title="Good to know"><Body>定位与网络延迟可能影响提醒。边界是辅助信息，不能替代陪伴与看护。</Body><Caption>此处只修改本人偏好，只读家庭成员也能设置自己的通知；不修改共享围栏。</Caption></Card>
    {saved && <Notice text={prefs.loading ? '偏好保存已确认，正在重新读取…' : prefs.error || prefs.data?.geofence !== submitted ? '偏好保存已确认，请只重试读取并核对最新值。' : '本人偏好已保存并重新读取。'} tone={prefs.error || prefs.loading ? 'warning' : 'success'} />}
    <Button title="Back to home boundary" secondary onPress={() => go(navigation, '31')} /><Details title="More notification options"><Button title="重新读取本人偏好" secondary onPress={prefs.refresh} /><Row title="所有通知与其他偏好" onPress={() => navigation.navigate('Notifications')} /></Details>
  </Page>;
}
function PolicyReceipt({ reporting }: { reporting?: Data }) {
  return <Card tone="sage"><Body>{stateLabel(reporting?.status)}</Body><Caption>期望版本 {reporting?.desired_version ?? '未知'} · 已应用版本 {reporting?.applied_version ?? '未知'}</Caption><Caption>执行来源：{reporting?.execution_source ?? '未知'}{reporting?.execution_source === 'simulator' ? '（离线模拟回执，不是硬件验收）' : ''}</Caption></Card>;
}
function PowerSettings({ page, issue, device, ready, canWrite, refresh, readError, navigation }: { page: PageProps; issue: ReactNode; device?: Data; ready: boolean; canWrite: boolean; refresh: () => Promise<void>; readError: unknown; navigation: any }) {
  const { api } = useApp(), initialized = useRef(false);
  const [mode, setMode] = useState(''), [interval, setInterval] = useState(''), [advanced, setAdvanced] = useState(false), [receipt, setReceipt] = useState<Data | null>(null), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => { if (device && !initialized.current) { initialized.current = true; setMode(device.reporting?.desired?.mode ?? ''); setInterval(String(device.reporting?.desired?.interval_seconds ?? '')); } }, [device]);
  const modes = [{ key: 'home_active', title: 'Balanced', detail: '家庭活动模式' }, { key: 'boundary_watch', title: 'Adventure', detail: '边界观察模式' }, { key: 'low_power', title: 'Battery saver', detail: '低功耗模式' }, ...(advanced ? [{ key: 'home_idle', title: 'Home idle', detail: '家庭静止模式' }, { key: 'alert', title: 'Alert', detail: '警戒策略模式' }] : [])];
  const save = <Button title="Save power settings" disabled={!device || !canWrite || !mode || !interval || saving || (receipt !== null && !dirty) || !!device.reporting?.lost_mode?.enabled} run={async () => {
      const seconds = Number(interval); if (!Number.isInteger(seconds) || seconds < 15 || seconds > 86400) throw new Error('上报间隔须为15至86400秒的整数');
      setSaving(true); try { const value = await api.put(`/devices/${device!.id}/reporting-policy`, { mode, interval_seconds: seconds, expires_in_seconds: 300 }); setReceipt(value); setDirty(false); await refresh(); } finally { setSaving(false); }
    }} />;
  return <Page {...page} footer={save}>{issue}<View style={s.modeList}>{modes.map(item => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={`${mode === item.key ? '●' : '○'}  ${item.title}`} accessibilityState={{ selected: mode === item.key, disabled: !canWrite || !device || saving }} disabled={!canWrite || !device || saving} onPress={() => { setMode(item.key); setDirty(true); }} style={[s.mode, mode === item.key && { backgroundColor: palette.sage }]}><View style={{ flex: 1, gap: 5 }}><Text style={s.modeTitle}>{item.title}</Text><Caption>{item.detail}</Caption></View><View style={[s.radio, mode === item.key && { backgroundColor: palette.forest }]}>{mode === item.key && <View style={s.radioDot} />}</View></Pressable>)}</View>
    <Row title="Emergency live tracking" subtitle="更快的上报请求可能增加耗电，执行以设备回执为准" tone="alert" onPress={() => go(navigation, '37')} />
    <Caption>实际保存间隔：{interval || '未知'} 秒。只回填已保存策略，不采用原型电池天数或示例频率。</Caption>{!canWrite && <Notice text="只读成员不能修改设备策略。" />}{ready && !device && <Notice text="尚未绑定项圈，不能提交策略。" />}
    {receipt && <Notice text={readError ? '请求已受理，当前状态未能重读；请只重试读取。' : '期望策略已受理，是否执行以设备回执为准。'} tone={readError ? 'warning' : 'info'} />}
    {device?.reporting?.lost_mode?.enabled && <Notice text="当前寻找会话已开启；先关闭会话，才能修改普通策略。" />}
    <Pressable accessibilityRole="button" accessibilityLabel="Advanced power settings" accessibilityState={{ expanded: advanced }} disabled={saving} onPress={() => setAdvanced(!advanced)} style={s.details}><Text style={s.detailsText}>Advanced power settings</Text><Text style={s.detailsText}>{advanced ? '−' : '+'}</Text></Pressable>
    {advanced && <><Field label="Update interval (seconds)" value={interval} onChangeText={value => { setInterval(value); setDirty(true); }} keyboardType="number-pad" editable={canWrite && !!device && !saving} /><PolicyReceipt reporting={device?.reporting ?? receipt ?? undefined} /><Row title="完整设备策略与配置历史" onPress={() => navigation.navigate('Devices', { section: 'history' })} /></>}
    {(advanced || receipt || !!readError) && <Button title="重新读取策略与回执" secondary onPress={refresh} />}
  </Page>;
}

function EventHistory({ navigation }: { navigation: any }) {
  const { api, pet } = useApp(), zone = pet!.effective_timezone ?? pet!.timezone ?? 'Asia/Shanghai';
  const [range, setRange] = useState<SafetyRange>({ period: 'all', timezone: zone, from: null, to: null }), [cursor, setCursor] = useState('');
  const query = new URLSearchParams({ limit: '25', ...(range.from ? { from: range.from, to: range.to! } : {}), ...(cursor ? { cursor } : {}) });
  const events = useResource<Data>(() => api.get(`/pets/${pet!.id}/safety-events?${query}`), [api, pet!.id, range, cursor]);
  return <View style={{ gap: 14 }}>
    {events.error && <Notice text={events.error} tone="error" />}{events.data?.items?.map((event: Data) => <Row key={event.id} title={eventName(event.type)} subtitle={`${event.occurred_at} · ${event.status === 'closed' ? '已关闭历史' : '开放事件'}`} tone={event.type === 'geofence.exited' && event.status !== 'closed' ? 'alert' : event.type === 'geofence.entered' ? 'sage' : 'white'} onPress={() => go(navigation, '36', { eventId: event.id })} />)}
    {events.data?.items?.length === 0 && <Notice text="当前范围没有安全事件，不代表现场没有风险。" />}<Body>事件时点与当前状态分别查看。确认知晓不会关闭风险，也不代表通知已送达。</Body>
    <Details title="Time range & history options"><View style={s.metricRow}>{(['today', 'week', 'all'] as SafetyPeriod[]).map(period => <Button key={period} title={({ today: 'Today', week: 'Week', all: 'All' })[period]} secondary={range.period !== period} run={async () => { const next = await loadSafetyRange(api, pet!.id, period, zone); setCursor(''); setRange(next); }} />)}</View><Caption>{range.from_date ? `${range.from_date} — ${range.to_date} · ${range.timezone}` : `全部已记录历史 · ${range.timezone}`}</Caption><Button title="Refresh safety history" secondary onPress={events.refresh} />{events.data?.next_cursor && <Button title="Earlier events" secondary onPress={() => setCursor(events.data!.next_cursor)} />}{cursor && <Button title="Back to latest events" secondary onPress={() => setCursor('')} />}</Details>
  </View>;
}
function OutsideEvent({ eventId, navigation, canWrite }: { eventId?: string; navigation: any; canWrite: boolean }) {
  const { api, pet } = useApp();
  const events = useResource<Data | null>(() => eventId ? Promise.resolve(null) : api.get(`/pets/${pet!.id}/safety-events?limit=25`), [api, pet!.id, eventId]);
  const id = eventId ?? events.data?.items?.find((event: Data) => event.type === 'geofence.exited')?.id;
  return <>{events.error && <Notice text={events.error} tone="error" />}<EventDetails key={id ?? 'none'} id={id} navigation={navigation} canWrite={canWrite} refreshHistory={events.refresh} /></>;
}
function EventDetails({ id, navigation, canWrite, refreshHistory }: { id?: string; navigation: any; canWrite: boolean; refreshHistory: () => Promise<void> }) {
  const { api, pet } = useApp(), [note, setNote] = useState(''), [acknowledged, setAcknowledged] = useState(false), [saving, setSaving] = useState(false);
  const detail = useResource<Data>(async () => { if (!id) return null; const result = await api.get(`/safety-events/${id}`); if (result.pet_id !== pet!.id) throw new Error('此事件不属于当前宠物。'); return result; }, [api, pet!.id, id]);
  const event = detail.data;
  return <View style={{ gap: 16 }}>{detail.error && <Notice text={detail.error} tone="error" />}<Card tone="alert"><Heading>{event ? eventName(event.type) : 'No event selected'}</Heading><Body>{event?.status === 'closed' ? '这是一条已关闭的历史事件。' : event ? '已记录的开放事件；请结合当前位置核对。' : '没有可读的越界依据，不能使用原型350 m示例填充。'}</Body><Caption>{event?.occurred_at ?? '发生时间未知'}</Caption></Card>
    <MapReference name="outside-zone-map" height={208} /><Caption>采样：{event?.location?.device_ts ?? '未知'} · 精度：{amount(event?.location?.accuracy_m, ' m')} · 原型地图不标记此坐标。</Caption><Details title="Review event evidence & acknowledgement"><PositionFacts location={event?.location ?? null} />
    {event?.details?.cause && <Caption>事件依据：{String(event.details.cause)}</Caption>}
    {event && !event.acknowledgement && canWrite && !acknowledged && <><Field label="确认备注（可空）" value={note} onChangeText={setNote} editable={!saving} /><Button title="确认已知晓" run={async () => { setSaving(true); try { await api.post(`/safety-events/${event.id}/ack`, { note: note.trim() }); setAcknowledged(true); await detail.refresh(); } finally { setSaving(false); } }} /></>}
    {(event?.acknowledgement || acknowledged) && <Notice text="已确认知晓。确认不会关闭事件；通知真实送达状态仍未知。" />}
    <Button title="重新读取事件依据" secondary onPress={() => { void refreshHistory(); void detail.refresh(); }} /></Details>
  </View>;
}
function Tracking({ device, canWrite, refresh, readError, navigation }: { device?: Data; canWrite: boolean; refresh: () => Promise<void>; readError: unknown; navigation: any }) {
  const { api } = useApp(), [ttl, setTtl] = useState('3600'), [receipt, setReceipt] = useState<Data | null>(null), [saving, setSaving] = useState(false);
  const reporting = device?.reporting, known = typeof reporting?.lost_mode?.enabled === 'boolean', active = reporting?.lost_mode?.enabled === true;
  return <View style={{ gap: 16 }}><View style={s.accuracy}><Text style={s.trackTitle}>{!known ? 'SESSION STATUS UNKNOWN' : active ? 'FINDING SESSION OPEN' : 'NO ACTIVE SESSION'}</Text><Text style={s.citronText}>{!known ? '尚无可读取的项圈会话状态' : active ? '请求会话已开启；不是设备实际定位成功' : '尚未开启寻找会话'}</Text></View>
    <Body>留意道路与周围环境，不要为追赶宠物进入危险区域。刷新只读取已上报资料。</Body>
    <Details title="Manage finding session"><Field label="寻找会话有效秒数" value={ttl} onChangeText={setTtl} keyboardType="number-pad" editable={canWrite && !saving} />
    {receipt && <Notice text={readError ? '请求已受理，请只重试读取会话。' : '会话请求已受理，采样策略执行以设备回执为准。'} />}
    <Button title={active ? 'Stop finding session' : 'Start finding session'} disabled={!device || !known || !canWrite || saving || (!!receipt && !!readError)} run={async () => {
      const seconds = Number(ttl); if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) throw new Error('会话有效期须为60至86400秒的整数');
      setSaving(true); try { const result = await api.post(`/devices/${device!.id}/lost-mode`, { enabled: !active, expires_in_seconds: seconds }); setReceipt(result); await refresh(); } finally { setSaving(false); }
    }} />
    {!device && <Notice text="没有可用的绑定项圈，不能开启设备寻找会话。" />}{!canWrite && <Notice text="只读成员可以查看会话，不能开启或停止。" />}
    <PolicyReceipt reporting={reporting ?? receipt ?? undefined} /><Button title="重新读取寻找会话" secondary onPress={refresh} /></Details>
  </View>;
}

function MissingDemo({ page, screenId, navigation, route, location }: { page: PageProps; screenId: string; navigation: any; route?: any; location: Data | null }) {
  const { api, user, pet } = useApp(), scope = `${api.baseUrl}:${user?.id}:${pet!.id}`;
  const [description, setDescription] = useState(pet!.breed ?? '');
  const candidate = route?.params?.missingDraft, draft = candidate?.scope === scope ? candidate : null;
  const confirmation = route?.params?.missingConfirmation?.scope === scope ? route.params.missingConfirmation : null;
  const petSummary = <Card tone="sage"><View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}><View style={s.petInitial}><Text style={s.petInitialText}>{pet!.name.slice(0, 1)}</Text></View><View style={{ flex: 1, gap: 4 }}><Heading>{pet!.name}</Heading><Caption>LOCAL REPORT · 仅本机演示</Caption></View></View><Body>{screenId === '38a' ? description || '宠物特征尚未填写' : draft?.description || '宠物特征尚未填写'}</Body><Caption>最近已知位置：{draft?.position ?? (location?.id ? `${location.lat}, ${location.lon}` : '未知')}</Caption><Caption>采样时点：{draft?.sampledAt ?? location?.device_ts ?? '未知'}</Caption></Card>;
  if (screenId === '38c') return <Page {...page} footer={<><Button title="Back to emergency actions" onPress={() => go(navigation, '38')} /><Button title={`Track ${pet!.name}`} secondary onPress={() => go(navigation, '37')} /></>}><View style={s.demoConfirmation}><View style={s.confirmationCircle}><Text style={s.confirmationMark}>{confirmation ? '✓' : '…'}</Text></View><Heading>{confirmation ? 'Missing-pet alert simulated' : 'No local confirmation yet'}</Heading><Body>{pet!.name}</Body><Body>没有报告发送；没有联系或派遣任何机构。</Body></View><Body>这是自主查看的本地流程示例，不是紧急报告服务。</Body>
    {!confirmation && <Button title="Prepare local report" onPress={() => go(navigation, '38a')} />}
  </Page>;
  const action = screenId === '38a' ? <Button title="Review alert" onPress={() => go(navigation, '38b', { missingDraft: { scope, petId: pet!.id, description: description.trim(), position: location?.id ? `${location.lat}, ${location.lon}` : '未知', sampledAt: location?.device_ts ?? '未知' } })} /> : <Button title="Confirm demo alert" disabled={!draft} onPress={() => go(navigation, '38c', { missingConfirmation: { scope, petId: pet!.id, confirmedAt: new Date().toISOString() } })} />;
  return <Page {...page} footer={<>{action}<Button title="Cancel" secondary onPress={() => go(navigation, '38')} /></>}><Row title="To: Local animal services" subtitle="示例接收方 · 不建立联系" />{petSummary}
    {screenId === '38a' ? <><Body>确认前核对宠物资料。此演示不会通知机构或派遣协助。</Body><Details title="Edit local report details"><Field label="宠物特征（只用于本次本地预览）" value={description} onChangeText={setDescription} multiline /></Details></>
      : <><Body>确认只显示本地演示结果，不会发出报告、拨号或分享位置。</Body>{!draft && <Notice text="本次草稿不存在或所属宠物/账号已变更，请重新准备。" tone="warning" />}{!draft && <Button title="Prepare local report" secondary onPress={() => go(navigation, '38a')} />}</>}
  </Page>;
}
function ContactPreview({ page, navigation }: { page: PageProps; navigation: any }) {
  const { api, pet } = useApp(), contacts = useResource<Data>(() => api.get(`/households/${pet!.household_id}/contacts?limit=25`), [api, pet!.household_id]);
  const [selection, setSelection] = useState<Record<string, number>>({}), [review, setReview] = useState(false), [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState('');
  const selected = (contacts.data?.items ?? []).filter((row: Data) => selection[row.id] === row.version);
  const stale = Object.keys(selection).some(id => !selected.some((row: Data) => row.id === id));
  const action = confirmed ? <Button title="Back to emergency actions" onPress={() => go(navigation, '38')} /> : review ? <Button title={`Confirm simulation to ${selected.length} contacts`} disabled={stale || !selected.length} onPress={() => setConfirmed(true)} /> : <Button title={`Preview for ${selected.length} contacts`} disabled={stale || !selected.length || !message.trim()} onPress={() => setReview(true)} />;
  return <Page {...page} footer={<>{action}<Button title="Cancel preview" secondary onPress={() => { setReview(false); setConfirmed(false); }} /></>}>{contacts.error && <Notice text={contacts.error} tone="error" />}{contacts.data?.items?.map((contact: Data) => <Row key={contact.id} title={`${selection[contact.id] === contact.version ? '✓ ' : ''}${contact.name}`} subtitle={`${contact.phone ? 'Phone' : contact.email ? 'Email' : '尚无联系方式'} · 同意报告：${contact.consent?.status ?? 'unknown'}`} onPress={() => { setReview(false); setConfirmed(false); setSelection(previous => { const next = { ...previous }; if (next[contact.id] === contact.version) delete next[contact.id]; else next[contact.id] = contact.version; return next; }); }} />)}
    {contacts.data?.items?.length === 0 && <Notice text="当前家庭没有联系人。可先在业务入口添加，不使用原型中的Sam或Jamie作为实际收件人。" />}
    <Card tone="sage"><Caption>MESSAGE PREVIEW</Caption><Body>{pet!.name} · 本地联系人通知演示</Body><TextInput accessibilityLabel="本地预览文字" placeholder="Write a local preview…" placeholderTextColor={palette.inkMuted} value={message} multiline style={s.messageInput} onChangeText={value => { setMessage(value); setReview(false); setConfirmed(false); }} /><Caption>不会自动附加位置链接，也不会发起通知API。</Caption></Card>
    <Body>This sends nothing. A confirmation appears inside this local demo only.</Body>{stale && <Notice text="联系人版本已变更，请刷新并重新选择。" tone="warning" />}
    {review && !confirmed && <Card tone="alert" title="Review local simulation"><Body>{selected.map((row: Data) => row.name).join('、')}</Body><Body>{message}</Body><Caption>仅本机模拟，不代表同意已核验或消息已送达。</Caption></Card>}
    {confirmed && <Notice text="本地模拟已确认；没有发送通知、联系收件人或分享位置。" tone="success" />}
    <Details title="More contact options"><Button title="重新读取联系人并清除选择" secondary onPress={() => { setSelection({}); setReview(false); setConfirmed(false); void contacts.refresh(); }} /><Row title="联系人管理与文字通知业务" subtitle="保留原有同意核对、显式请求和逐人回执入口" onPress={() => navigation.navigate('Contacts')} />{!confirmed && <Button title="Back to emergency actions" secondary onPress={() => go(navigation, '38')} />}</Details>
  </Page>;
}
const s = StyleSheet.create({
  map: { borderRadius: 20, overflow: 'hidden', backgroundColor: palette.sage, alignItems: 'center', justifyContent: 'center' },
  demoBadge: { position: 'absolute', right: 10, top: 10, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 5, backgroundColor: palette.canvas }, demoBadgeText: { fontSize: 9, lineHeight: 12, color: palette.forest, fontWeight: '700' },
  mapScale: { position: 'absolute', right: 16, width: 80, height: 20, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.canvas },
  mapLive: { position: 'absolute', left: 14, right: 14, bottom: 12, height: 44, borderRadius: 12, backgroundColor: palette.forest, justifyContent: 'center', alignItems: 'center' }, mapLiveText: { color: palette.canvas, fontSize: 13, fontWeight: '600' },
  details: { minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }, detailsText: { fontSize: 13, lineHeight: 18, color: palette.forest, fontWeight: '600' },
  compactMetrics: { flexDirection: 'row', gap: 8 }, compactMetric: { flex: 1, minWidth: 0, minHeight: 58, borderRadius: 16, backgroundColor: palette.sage, padding: 12, justifyContent: 'center', gap: 3 }, metricLabel: { color: palette.inkMuted, fontSize: 11, lineHeight: 14 }, metricValue: { color: palette.forest, fontSize: 14, lineHeight: 18, fontWeight: '600' },
  radiusSummary: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 96, paddingHorizontal: 18, paddingVertical: 14, borderRadius: 18, backgroundColor: palette.sage }, radiusValue: { color: palette.forest, fontSize: 30, lineHeight: 34, fontWeight: '700' },
  modeList: { borderRadius: 20, overflow: 'hidden', backgroundColor: palette.white }, mode: { minHeight: 84, paddingHorizontal: 18, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 }, modeTitle: { color: palette.forest, fontSize: 16, lineHeight: 20, fontWeight: '600' }, radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: palette.forest, alignItems: 'center', justifyContent: 'center' }, radioDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.canvas },
  petInitial: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.citron }, petInitialText: { color: palette.forest, fontSize: 24, fontWeight: '700' },
  demoConfirmation: { gap: 18, alignItems: 'center', paddingVertical: 20 }, confirmationCircle: { width: 120, height: 120, borderRadius: 60, backgroundColor: palette.citron, justifyContent: 'center', alignItems: 'center' }, confirmationMark: { color: palette.forest, fontSize: 54, fontWeight: '600' },
  messageInput: { minHeight: 80, color: palette.forest, fontSize: 15, lineHeight: 21, textAlignVertical: 'top', padding: 0 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, coordinates: { flexDirection: 'row', gap: 10 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  battery: { borderRadius: 20, backgroundColor: palette.forest, padding: 20, gap: 22 }, batteryValue: { color: palette.canvas, fontSize: 64, fontWeight: '700' },
  batteryTrack: { height: 44, padding: 5, borderRadius: 8, backgroundColor: '#46665C' }, batteryFill: { height: 34, borderRadius: 5, backgroundColor: palette.citron },
  citronText: { color: palette.citron, fontSize: 13, lineHeight: 19 }, accuracy: { padding: 20, borderRadius: 20, backgroundColor: palette.forest, gap: 8 },
  largeMetric: { color: palette.canvas, fontSize: 40, fontWeight: '700' }, trackTitle: { color: palette.canvas, fontSize: 19, fontWeight: '700' },
});
