import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Share, Switch, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Page, Card, Field, Button, Action, Notice, Facts, Choose } from '../ui';
import { AppScreenProps } from '../types';
import { trajectoryLayout, TrajectorySample } from '../lib/trajectory';
import { loadSafetyRange, SafetyPeriod, SafetyRange } from '../lib/safetyHistory';

type Row = Record<string, any>;
const query = (values: Row) => {
  const params = Object.entries(values).filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
  return params ? `?${params}` : '';
};
const options = (values: string[]) => values.map(value => ({ label: value || '全部', value }));
function numberValue(text: string, label: string, min: number, max: number, integer = false) {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`${label}须为 ${min}–${max} 的${integer ? '整数' : '数字'}`);
  return value;
}
function confirmChange(title: string, message: string) {
  return new Promise<void>((resolve, reject) => Alert.alert(title, message, [
    { text: '取消', style: 'cancel', onPress: () => reject(new Error('已取消操作')) },
    { text: '确认', style: 'destructive', onPress: () => resolve() },
  ], { cancelable: false }));
}
function ErrorNotice({ error }: { error: unknown }) {
  return error ? <Notice text={error instanceof Error ? error.message : String(error)} tone="error" /> : null;
}
function Toggle({ label, value, change }: { label: string; value: boolean; change: (value: boolean) => void }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}><Text style={{ flex: 1 }}>{label}</Text><Switch value={value} onValueChange={change} /></View>;
}
function Pager({ page, cursor, change }: { page: any; cursor: string; change: (value: string) => void }) {
  return <View style={{ gap: 8 }}>{cursor ? <Button title="返回最新" onPress={() => change('')} /> : null}
    {page?.next_cursor ? <Button title="更早记录" onPress={() => change(page.next_cursor)} /> : null}</View>;
}
function currentRole(household: any, households: any[], pet: any) {
  return households.find(item => item.id === pet?.household_id)?.role ?? (household?.id === pet?.household_id ? household.role : 'viewer');
}

export function DevicesScreen({ navigation, route }: AppScreenProps) {
  const app = useApp();
  if (!app.pet) return <Page title="设备与定位"><Notice text="先选择或建立宠物档案，才能将设备绑定到宠物。" /><Button title="宠物档案" onPress={() => navigation.navigate('Pet')} /><OwnedDevices /><Button title="绑定帮助与工单" onPress={() => navigation.navigate('Support')} /><Button title="返回安全页" onPress={() => navigation.navigate('Main', { screen: 'SafetyTab' })} /></Page>;
  return <DevicesBody key={`${app.api.baseUrl}:${app.pet.id}`} navigation={navigation} initialSection={route.params?.section} />;
}
function DevicesBody({ navigation, initialSection }: { navigation: any; initialSection?: string }) {
  const { api, pet, household, households, refreshIdentity } = useApp();
  const [section, setSection] = useState('device');
  useEffect(() => { if (['device', 'fences', 'locations', 'shares', 'history', 'operations'].includes(initialSection ?? '')) setSection(initialSection!); }, [initialSection]);
  const overview = useResource(() => api.get(`/pets/${pet!.id}/overview`), [api, pet!.id]);
  const device = overview.data?.device;
  const canWrite = ['owner', 'caregiver'].includes(currentRole(household, households, pet));
  return <Page title={`${pet!.name} · 设备与定位`}>
    <Choose value={section} onChange={setSection} options={[
      { label: '设备', value: 'device' }, { label: '围栏', value: 'fences' }, { label: '足迹', value: 'locations' },
      { label: '位置分享', value: 'shares' }, { label: '配置历史', value: 'history' }, { label: '运行排障', value: 'operations' }]} />
    <Button title={overview.loading ? '读取中…' : '刷新当前状态'} onPress={overview.refresh} disabled={overview.loading} />
    <ErrorNotice error={overview.error} />
    {!canWrite ? <Notice text="当前为只读角色；设备、围栏及策略变更需要家庭写权限。" /> : null}
    {section === 'device' ? <DeviceControls device={device} ready={Boolean(overview.data)} canWrite={canWrite} refresh={async () => { await overview.refresh(); await refreshIdentity(); }} /> : null}
    {section === 'fences' ? <Fences petId={pet!.id} canWrite={canWrite} /> : null}
    {section === 'locations' ? <Locations petId={pet!.id} /> : null}
    {section === 'shares' ? <LocationShares petId={pet!.id} canWrite={canWrite} /> : null}
    {section === 'history' ? <ConfigurationHistory petId={pet!.id} /> : null}
    {section === 'operations' ? <Operations petId={pet!.id} householdId={pet!.household_id} canWrite={canWrite} /> : null}
    <Button title="安全事件" onPress={() => navigation.navigate('Safety')} />
    <Button title="绑定帮助与工单" onPress={() => navigation.navigate('Support')} />
  </Page>;
}

function DeviceControls({ device, ready, canWrite, refresh }: { device: any; ready: boolean; canWrite: boolean; refresh: () => Promise<void> }) {
  const { api, pet } = useApp();
  const [deviceId, setDeviceId] = useState(''), [claimCode, setClaimCode] = useState(''), [receipt, setReceipt] = useState<any>(null);
  const [mode, setMode] = useState('home_active'), [interval, setInterval] = useState('120');
  const [ttl, setTtl] = useState('300'), [lostTtl, setLostTtl] = useState('3600'), [commandId, setCommandId] = useState(''), [advancedCommand, setAdvancedCommand] = useState(false), [manualCommandId, setManualCommandId] = useState('');
  const command = useResource(() => device && commandId ? api.get(`/devices/${device.id}/commands/${encodeURIComponent(commandId)}`) : Promise.resolve(null), [api, device?.id, commandId]);
  const mounted = useRef(true);
  const deviceScope = useRef(device?.id); deviceScope.current = device?.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setCommandId(device?.reporting?.command_id ?? ''); }, [device?.id, device?.reporting?.command_id]);
  useEffect(() => { if (device?.reporting?.desired) { setMode(device.reporting.desired.mode); setInterval(String(device.reporting.desired.interval_seconds)); } }, [device?.id, device?.reporting?.desired_version]);
  const policyDone = async (value: any) => { if (!mounted.current || deviceScope.current !== device?.id) return; setCommandId(value.command_id ?? ''); await refresh(); };
  return <>
    <Card title="连接与能力"><Notice text="蓝牙功能尚未接入，当前近场连接状态未知。下方在线状态来自后端接收记录；设备绑定、蓝牙连接和独立远程链路分别表示。" />
      {device ? <Facts value={{ 设备ID: device.id, 序列号: device.serial_no, 状态: device.connection_status, 最近接收: device.last_seen_at,
        最近采样: device.reported_at, 电量百分比: device.battery_pct, 定位新鲜度: device.data_freshness, 固件: device.firmware_version, 凭证状态: device.credential?.status }} /> : <Notice text={ready ? '当前宠物未绑定设备。' : '设备状态尚未读取，保持未知。'} />}
    </Card>
    {!device && canWrite ? <Card title="绑定已预置设备"><Field label="设备 ID" value={deviceId} onChangeText={setDeviceId} /><Field label="短期绑定码" value={claimCode} onChangeText={setClaimCode} />
      <Action title="确认绑定此宠物" run={async () => { const value = await api.post('/devices/claim', { device_id: deviceId.trim(), claim_code: claimCode.trim(), pet_id: pet!.id }); setClaimCode(''); setReceipt(null); return value; }} onDone={refresh} success="已绑定；等待设备实际上报。" />
      <Notice text="仅填写设备 ID 与绑定码。App 不获取或保存设备长期密钥。" /></Card> : null}
    {device ? <Card title="期望策略与设备回执"><Facts value={device.reporting} />
      <Notice text="提交只创建期望策略。已应用版本与执行来源以设备回执为准；simulator 为离线模拟，超时不能视为已执行。" />
      {canWrite ? <><Choose value={mode} onChange={setMode} options={options(['home_idle', 'home_active', 'boundary_watch', 'alert', 'low_power'])} />
        <Field label="上报间隔（15–86400 秒）" value={interval} onChangeText={setInterval} keyboardType="numeric" />
        <Field label="命令有效期（30–3600 秒）" value={ttl} onChangeText={setTtl} keyboardType="numeric" />
        {device.reporting?.lost_mode?.enabled ? <Notice text="走失模式开启期间，请先关闭走失模式再修改普通上报策略。" /> : <Action title="请求更新策略" run={() => api.put(`/devices/${device.id}/reporting-policy`, { mode, interval_seconds: numberValue(interval, '上报间隔', 15, 86400, true), expires_in_seconds: numberValue(ttl, '命令有效期', 30, 3600, true) })} onDone={policyDone} success="已请求；下方显示命令回执，可继续刷新。" />}
        <Field label="走失寻找有效期（60–86400 秒）" value={lostTtl} onChangeText={setLostTtl} keyboardType="numeric" />
        <Action title={device.reporting?.lost_mode?.enabled ? '关闭走失模式' : '请求开启走失模式'} run={() => api.post(`/devices/${device.id}/lost-mode`, { enabled: !device.reporting?.lost_mode?.enabled, expires_in_seconds: numberValue(lostTtl, '走失有效期', 60, 86400, true) })} onDone={policyDone} success="请求已提交；请查看期望与实际策略。" /></> : null}
      <ErrorNotice error={command.error} />{command.data ? <Facts value={command.data} /> : !commandId ? <Notice text="暂无策略命令。提交请求后会在此读取对应回执。" /> : null}
      {!!commandId && <Button title="刷新当前命令回执" onPress={command.refresh} disabled={command.loading} />}
      <Toggle label="高级：按命令 ID 查询" value={advancedCommand} change={setAdvancedCommand} />
      {advancedCommand && <><Field label="命令 ID" value={manualCommandId} onChangeText={setManualCommandId} /><Button title="读取此命令" disabled={!manualCommandId.trim()} onPress={() => { if (commandId === manualCommandId.trim()) void command.refresh(); else setCommandId(manualCommandId.trim()); }} /></>}
    </Card> : null}
    {device?.is_owner ? <Card title="解绑"><Notice text="解绑会清当前设备缓存、取消待执行命令并结束走失会话；宠物历史仍保留。" />
      <Action title="解绑当前设备" run={async () => { await confirmChange('解绑设备', '确认结束当前绑定和走失会话？'); if (!mounted.current || deviceScope.current !== device.id) return; const value = await api.post(`/devices/${device.id}/unbind`); if (!mounted.current || deviceScope.current !== device.id) return; setReceipt(value); setDeviceId(value.device_id); setClaimCode(value.claim_code); await refresh(); }} /></Card> : null}
    <OwnedDevices key={device?.id ?? 'unbound'} initialReceipt={receipt} onClaim={value => { if (mounted.current) { setDeviceId(value.device_id); setClaimCode(value.claim_code); } }} onChanged={async () => { if (!mounted.current) return; setDeviceId(''); setClaimCode(''); setReceipt(null); await refresh(); }} />
  </>;
}

function OwnedDevices({ initialReceipt, onClaim, onChanged }: { initialReceipt?: any; onClaim?: (value: any) => void; onChanged?: () => Promise<void> }) {
  const { api } = useApp();
  const [cursor, setCursor] = useState(''), [selectedId, setSelectedId] = useState(''), [receipt, setReceipt] = useState<any>(null);
  const page = useResource(() => api.get(`/devices${query({ cursor, limit: 20 })}`), [api, cursor, initialReceipt]);
  const selected = page.data?.items?.find((row: Row) => row.id === selectedId && row.binding_status === 'unbound');
  useEffect(() => { if (initialReceipt?.claim_code) { setCursor(''); setSelectedId(initialReceipt.device_id); setReceipt(initialReceipt); } }, [initialReceipt]);
  const changePage = (next: string) => { setSelectedId(''); setReceipt(null); setCursor(next); };
  return <Card title="我的设备"><Notice text="只列本人持有的设备。所有权不等于家庭数据访问权；已绑定设备需先在对应宠物的设备页解绑。" /><Button title="刷新我的设备" onPress={async () => { setSelectedId(''); setReceipt(null); await page.refresh(); }} disabled={page.loading} /><ErrorNotice error={page.error} />
    {page.data?.items?.map((row: Row) => <View key={row.id}><Text>{row.serial_no} · {row.binding_status === 'bound' ? '已绑定' : '已解绑'}</Text><Facts value={{ 厂商: row.vendor, 型号: row.model, 凭证状态: row.credential?.status }} /></View>)}
    {!page.loading && !page.error && page.data?.items?.length === 0 && <Notice text="当前没有本人持有的设备。新设备需取得设备 ID 与有效短期绑定码后认领。" />}
    {!!page.data?.items?.some((row: Row) => row.binding_status === 'unbound') && <Choose value={selected?.id ?? ''} options={[{ label: '选择已解绑设备', value: '' }, ...page.data.items.filter((row: Row) => row.binding_status === 'unbound').map((row: Row) => ({ label: `${row.serial_no} · 已解绑`, value: row.id }))]} onChange={id => { setReceipt(null); setSelectedId(id); }} />}
    {selected && <OwnedDeviceActions key={selected.id} device={selected} issued={value => { setReceipt(value); onClaim?.(value); }} changed={async () => { setSelectedId(''); setReceipt(null); await page.refresh(); await onChanged?.(); }} />}
    {receipt?.claim_code && <><Facts value={{ 设备ID: receipt.device_id, 绑定码到期时间: receipt.claim_expires_at }} /><Text selectable>{receipt.claim_code}</Text><Notice text="短期绑定码仅本次展示。已填入本页绑定表单（如有）；请确认宠物后再提交绑定。勿作为设备长期认证密钥使用。" /><Action title="复制绑定码" run={() => Clipboard.setStringAsync(receipt.claim_code)} success="绑定码已复制。" /><Button title="隐藏本次绑定码" onPress={() => setReceipt(null)} /></>}
    {!!cursor && <Button title="设备返回第一页" onPress={() => changePage('')} />}{page.data?.next_cursor && <Button title="更多本人设备" onPress={() => changePage(page.data.next_cursor)} />}
  </Card>;
}
function OwnedDeviceActions({ device, issued, changed }: { device: Row; issued: (value: any) => void; changed: () => Promise<void> }) {
  const { api } = useApp(), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <><Action title="重新签发短期绑定码" run={async () => { const value = await api.post(`/devices/${device.id}/claim-code`); if (mounted.current) issued(value); }} />
    <Action title="释放所有权供他人认领" run={async () => { await confirmChange('释放设备所有权', `确认释放 ${device.serial_no}，允许其他账号使用有效绑定码认领？`); if (!mounted.current) return; await api.post(`/devices/${device.id}/release`); if (mounted.current) await changed(); }} /></>;
}

const ruleFields = [
  ['buffer_m', '固定缓冲（米）', 0, 500, 10], ['min_buffer_m', '最小动态缓冲（米）', 0, 500, 15],
  ['accuracy_limit_m', '最大定位误差（米，须大于0）', 0, 500, 100], ['confirm_points', '连续确认点数', 2, 10, 2],
  ['min_exit_seconds', '越界持续时间（秒）', 0, 3600, 0], ['min_enter_seconds', '返回持续时间（秒）', 0, 3600, 0],
] as const;
function Fences({ petId, canWrite }: { petId: string; canWrite: boolean }) {
  const { api } = useApp();
  const page = useResource(() => api.get(`/pets/${petId}/geofences`), [api, petId]);
  const [editing, setEditing] = useState<any>(undefined);
  return <><Card title="围栏"><ErrorNotice error={page.error} /><Button title="刷新围栏" onPress={page.refresh} />
    <Notice text="WGS84 坐标；地图底图与拖动编辑待地图适配。停用保留围栏及历史，不会永久删除。" />
    {canWrite ? <Button title="新增围栏" onPress={() => setEditing(null)} /> : null}
    {page.data?.items?.length === 0 ? <Notice text="尚未建立围栏。" /> : null}
    {page.data?.items?.map((fence: Row) => <Card key={fence.id} title={fence.name}><Facts value={{ ID: fence.id, 启用: fence.enabled, 规则版本: fence.rule_version, 当前判断: fence.state?.effective_status, 最近判断: fence.state?.last_ts, 几何范围: fence.geometry }} />
      {canWrite ? <><Button title="编辑名称、范围与规则" onPress={() => setEditing(fence)} />
        <Action title={fence.enabled ? '停用围栏' : '启用围栏'} run={() => fence.enabled ? api.delete(`/geofences/${fence.id}`) : api.patch(`/geofences/${fence.id}`, { enabled: true })} onDone={page.refresh} /></> : null}</Card>)}
  </Card>{editing !== undefined && canWrite ? <FenceEditor key={editing?.id ?? 'new'} existing={editing} petId={petId} done={async () => { setEditing(undefined); await page.refresh(); }} cancel={() => setEditing(undefined)} /> : null}</>;
}
function FenceEditor({ existing, petId, done, cancel }: { existing: any; petId: string; done: () => Promise<void>; cancel: () => void }) {
  const { api } = useApp();
  const [name, setName] = useState(existing?.name ?? ''), [shape, setShape] = useState(existing?.geometry?.type ?? 'circle');
  const [lat, setLat] = useState(String(existing?.geometry?.lat ?? '')), [lon, setLon] = useState(String(existing?.geometry?.lon ?? ''));
  const [radius, setRadius] = useState(String(existing?.geometry?.radius_m ?? '100'));
  const [coordinates, setCoordinates] = useState(existing?.geometry?.coordinates?.map((pair: number[]) => pair.join(', ')).join('\n') ?? '');
  const [rules, setRules] = useState<Record<string, string>>(Object.fromEntries(ruleFields.map(([key, , , , initial]) => [key, String(existing?.[key] ?? initial)])));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true), [dynamic, setDynamic] = useState(existing?.dynamic_buffer ?? false);
  function body() {
    if (!name.trim()) throw new Error('请填写围栏名称。');
    let geometry: Row;
    if (shape === 'circle') {
      const radiusM = numberValue(radius, '半径', 0, 100000); if (radiusM <= 0) throw new Error('圆形半径必须大于0。');
      geometry = { type: 'circle', lat: numberValue(lat, '纬度', -90, 90), lon: numberValue(lon, '经度', -180, 180), radius_m: radiusM };
    }
    else {
      const lines = coordinates.trim().split(/\r?\n/);
      if (lines.length < 3 || lines.length > 101) throw new Error('请输入 3–101 行边界顶点，每行「经度, 纬度」。');
      geometry = { type: 'polygon', coordinates: lines.map((line: string, index: number) => {
        const pair = line.split(/[,，]/); if (pair.length !== 2) throw new Error(`第 ${index + 1} 行须为「经度, 纬度」。`);
        return [numberValue(pair[0], '经度', -180, 180), numberValue(pair[1], '纬度', -90, 90)];
      }) };
    }
    const result: Row = { name: name.trim(), geometry, enabled, dynamic_buffer: dynamic };
    for (const [key, label, min, max] of ruleFields) result[key] = numberValue(rules[key], label, min, max, ['confirm_points', 'min_exit_seconds', 'min_enter_seconds'].includes(key));
    if (result.accuracy_limit_m <= 0) throw new Error('最大定位误差必须大于0。');
    if (!existing) return { ...result, pet_id: petId };
    const changed = Object.fromEntries(Object.entries(result).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(existing[key])));
    if (!Object.keys(changed).length) throw new Error('没有修改；可直接取消编辑。');
    return changed;
  }
  return <Card title={existing ? '编辑围栏' : '新增围栏'}><Field label="名称" value={name} onChangeText={setName} maxLength={100} />
    <Choose value={shape} onChange={setShape} options={[{ label: '圆形', value: 'circle' }, { label: '多边形', value: 'polygon' }]} />
    {shape === 'circle' ? <><Field label="中心纬度" value={lat} onChangeText={setLat} /><Field label="中心经度" value={lon} onChangeText={setLon} /><Field label="半径（米）" value={radius} onChangeText={setRadius} keyboardType="numeric" /></>
      : <Field label="顶点，每行经度, 纬度；边界按顺序，不可自相交" value={coordinates} onChangeText={setCoordinates} multiline />}
    {ruleFields.map(([key, label]) => <Field key={key} label={label} value={rules[key]} onChangeText={value => setRules(previous => ({ ...previous, [key]: value }))} keyboardType="numeric" />)}
    <Toggle label="启用此围栏" value={enabled} change={setEnabled} /><Toggle label="根据定位误差扩大缓冲" value={dynamic} change={setDynamic} />
    <Notice text="改变判定规则会清旧判断，等待新的有效定位。提交后以服务端几何及规则校验为准。" />
    <Action title="保存围栏" run={() => existing ? api.patch(`/geofences/${existing.id}`, body()) : api.post('/geofences', body())} onDone={done} />
    <Button title="取消编辑" onPress={cancel} /></Card>;
}

function TrajectoryChart({ items }: { items: TrajectorySample[] }) {
  const [width, setWidth] = useState(320), height = 200;
  const layout = trajectoryLayout(items, width, height);
  if (!layout.points.length) return <Notice text="当前页没有质量足够的历史 GNSS 点可绘制。" />;
  return <><View onLayout={event => { const next = event.nativeEvent.layout.width; if (next > 0) setWidth(next); }}
    accessibilityRole="image" accessibilityLabel={`当前页 ${layout.points.length} 个历史GNSS点的局部坐标示意，北向上；非导航地图`}
    style={{ width: '100%', height, backgroundColor: '#f2f4eb', borderRadius: 12, overflow: 'hidden', position: 'relative' }}>
    {layout.segments.map((segment, index) => {
      const from = layout.points[segment.from], to = layout.points[segment.to];
      const x1 = from.x * width, y1 = from.y * height, x2 = to.x * width, y2 = to.y * height;
      const length = Math.hypot(x2 - x1, y2 - y1); if (!length) return null;
      return <View key={`line-${index}`} style={{ position: 'absolute', left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - 1, width: length, height: 2, backgroundColor: '#7c985b', transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
    })}
    {layout.points.map((point, index) => <View key={point.id} style={{ position: 'absolute', left: point.x * width - 4, top: point.y * height - 4,
      width: 8, height: 8, borderRadius: 4, backgroundColor: index === 0 ? '#217565' : '#244b3e' }} />)}
    <Text style={{ position: 'absolute', top: 7, left: 10, color: '#5b706a' }}>北 ↑</Text>
  </View><Notice text={`仅显示当前页最多30条记录中的 ${layout.points.length} 个质量足够的 GNSS 点；按采样时间排序，同设备、同次绑定且中间无异常点才连线，无明确归属只显示散点。局部坐标示意，无地图底图，不用于导航或精确距离测量。历史点不代表当前位置。`} /></>;
}

function Locations({ petId }: { petId: string }) {
  const { api } = useApp();
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [range, setRange] = useState<Row>({}), [cursor, setCursor] = useState('');
  const fixedRange = useRef<Row | null>(null);
  const latest = useResource(() => api.get(`/pets/${petId}/location/latest`), [api, petId]);
  const locations = useResource(async () => {
    const result = await api.get(`/pets/${petId}/locations${query({ ...(fixedRange.current ?? range), cursor, limit: 30 })}`);
    return result;
  }, [api, petId, range, cursor]);
  useEffect(() => { if (locations.data?.range) fixedRange.current = locations.data.range; }, [locations.data]);
  const firstPage = (nextRange: Row) => { fixedRange.current = null; setCursor(''); setRange(nextRange); };
  return <><Card title="最近位置"><ErrorNotice error={latest.error} /><Button title="重新读取位置" onPress={latest.refresh} /><Notice text="刷新只读取已有上报，不触发设备新定位。暂无地图底图；坐标为 WGS84，缺失保持未知。" /><Facts value={latest.data ?? { 位置: '未知' }} /></Card>
    <Card title="位置轨迹列表"><Field label="开始时间 ISO（可留空，默认最近24小时）" value={from} onChangeText={setFrom} /><Field label="结束时间 ISO（单次最多31天）" value={to} onChangeText={setTo} />
      <Button title="应用时间范围" onPress={() => firstPage({ from: from.trim(), to: to.trim() })} /><Button title="刷新本范围的第一页" onPress={() => firstPage({ ...range })} disabled={locations.loading} /><ErrorNotice error={locations.error} />
      <Facts value={locations.data?.range} />{locations.data?.items?.length === 0 ? <Notice text="该范围没有位置记录，不表示宠物未活动。" /> : null}
      {locations.data ? <TrajectoryChart items={locations.data.items ?? []} /> : null}
      {locations.data?.items?.map((row: Row) => <Card key={row.id}><Facts value={{ 采样时间: row.device_ts, 接收时间: row.received_at, 纬度: row.lat, 经度: row.lon, 精度米: row.accuracy_m, 来源: row.source, 质量标记: row.quality_flags, 可用于追踪: row.usable_for_tracking, 设备: row.device_id }} /></Card>)}
      <Pager page={locations.data} cursor={cursor} change={next => next ? setCursor(next) : firstPage({ ...range })} /></Card></>;
}

function LocationShares({ petId, canWrite }: { petId: string; canWrite: boolean }) {
  const { api, user, household, households, pet } = useApp();
  const [cursor, setCursor] = useState(''), [ttl, setTtl] = useState('3600'), [consent, setConsent] = useState(false), [created, setCreated] = useState<any>(null);
  const page = useResource(() => canWrite ? api.get(`/pets/${petId}/location-shares${query({ cursor, limit: 20 })}`) : Promise.resolve(null), [api, petId, canWrite, cursor]);
  const url = created?.token ? `${api.origin}/app/share.html#${created.token}` : '';
  return <Card title="临时位置分享"><Notice text="须有有效走失会话。链接持有者在授权期内可查看位置；退出走失、撤权、解绑或撤销后失效。创建后仅本次可复制链接。" />
    {canWrite ? <><Field label="分享有效期（60–86400 秒，受走失会话期限限制）" value={ttl} onChangeText={setTtl} keyboardType="numeric" /><Toggle label="同意本次向链接持有者分享宠物位置" value={consent} change={setConsent} />
      <Action title="创建限时位置链接" run={async () => { if (!consent) throw new Error('请先明确同意本次分享。'); return api.post(`/pets/${petId}/location-shares`, { consent: true, expires_in_seconds: numberValue(ttl, '分享有效期', 60, 86400, true) }); }} onDone={async value => { setCreated(value); setConsent(false); await page.refresh(); }} />
      {url ? <><Text selectable>{url}</Text><Facts value={{ 到期时间: created.expires_at }} /><Action title="复制链接" run={() => Clipboard.setStringAsync(url)} /><Action title="系统分享菜单" run={() => Share.share({ message: url })} /><Button title="隐藏本次链接" onPress={() => setCreated(null)} /></> : null}
      <Button title="刷新分享记录" onPress={page.refresh} /><ErrorNotice error={page.error} />
      {page.data?.items?.map((row: Row) => <Card key={row.id}><Facts value={row} />{!row.revoked_at && (row.created_by === user?.id || currentRole(household, households, pet) === 'owner') ? <Action title="撤销此分享" run={() => api.delete(`/location-shares/${row.id}`)} onDone={async () => { if (created?.id === row.id) setCreated(null); await page.refresh(); }} /> : null}</Card>)}
      <Pager page={page.data} cursor={cursor} change={setCursor} /></> : <Notice text="当前只读角色无法创建或管理分享。" />}
  </Card>;
}

function ConfigurationHistory({ petId }: { petId: string }) {
  const { api } = useApp();
  const [kind, setKind] = useState(''), [cursor, setCursor] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [range, setRange] = useState<Row>({});
  const page = useResource(() => api.get(`/pets/${petId}/configuration-history${query({ ...range, kind, cursor, limit: 20 })}`), [api, petId, kind, cursor, range]);
  return <Card title="配置修改历史"><Choose value={kind} options={options(['', 'geofence', 'reporting_policy'])} onChange={value => { setKind(value); setCursor(''); }} />
    <Field label="开始时间 ISO（可留空，默认最近31天）" value={from} onChangeText={setFrom} /><Field label="结束时间 ISO（单次最多31天）" value={to} onChangeText={setTo} />
    <Button title="应用历史时间范围" onPress={() => { setCursor(''); setRange({ from: from.trim(), to: to.trim() }); }} />
    <Notice text="默认最近31天，只包含开始记录后的实际变更；策略请求不等于设备已经执行。" /><ErrorNotice error={page.error} /><Button title="刷新历史" onPress={page.refresh} />
    {page.data?.items?.map((row: Row) => <Card key={row.id} title={`版本 ${row.version} · ${row.kind}`}><Facts value={row} /></Card>)}
    {page.data?.items?.length === 0 ? <Notice text="该范围没有已保存的配置变更。" /> : null}<Pager page={page.data} cursor={cursor} change={setCursor} /></Card>;
}

function Operations({ petId, householdId, canWrite }: { petId: string; householdId: string; canWrite: boolean }) {
  const { api } = useApp();
  const [status, setStatus] = useState(''), [cursor, setCursor] = useState(''), [reason, setReason] = useState('');
  const summary = useResource(() => api.get(`/households/${householdId}/operations?hours=24`), [api, householdId]);
  const failures = useResource(() => api.get(`/pets/${petId}/telemetry-failures${query({ status, cursor, limit: 20 })}`), [api, petId, status, cursor]);
  return <><Card title="家庭最近24小时运行简报"><Button title="刷新简报" onPress={summary.refresh} /><ErrorNotice error={summary.error} /><Facts value={summary.data} /><Notice text="通知只统计本人通道处理结果；手机送达未知。样本为空的时延保持未知。" /></Card>
    <Card title="当前绑定的失败遥测"><Choose value={status} options={options(['', 'retry', 'dead'])} onChange={value => { setStatus(value); setCursor(''); }} /><ErrorNotice error={failures.error} />
      {canWrite ? <Field label="手动重新排队理由" value={reason} onChangeText={setReason} multiline maxLength={500} /> : null}
      {failures.data?.items?.map((row: Row) => <Card key={row.event_id}><Facts value={row} />{canWrite ? <Action title="有理由重新排队此消息" run={() => { if (!reason.trim()) throw new Error('请填写重新排队理由。'); return api.post(`/ingest/events/${encodeURIComponent(row.event_id)}/retry`, { reason: reason.trim() }); }} onDone={async () => { await failures.refresh(); await summary.refresh(); }} success="已重新排队；最终处理以 Worker 后续状态为准。" /> : null}</Card>)}
      {failures.data?.items?.length === 0 ? <Notice text="当前没有符合条件的失败记录。" /> : null}<Pager page={failures.data} cursor={cursor} change={setCursor} /></Card></>;
}

export function SafetyScreen({ navigation, route }: AppScreenProps) {
  const { api, pet } = useApp();
  if (!pet) return <Page title="安全事件"><Notice text="先选择宠物。" /><Button title="选择宠物" onPress={() => navigation.navigate('Pet')} /></Page>;
  return <SafetyBody key={`${api.baseUrl}:${pet.id}`} initialId={route.params?.petId === pet.id ? route.params?.eventId ?? route.params?.id ?? '' : ''} />;
}
function SafetyBody({ initialId }: { initialId: string }) {
  const { api, pet, household, households } = useApp();
  const [cursor, setCursor] = useState(''), [id, setId] = useState(initialId), [note, setNote] = useState('');
  const [period, setPeriod] = useState<SafetyPeriod>('all'), [timezone, setTimezone] = useState(pet!.effective_timezone ?? 'Asia/Shanghai');
  const [range, setRange] = useState<SafetyRange>({ period: 'all', timezone, from: null, to: null });
  useEffect(() => { setId(initialId); setNote(''); }, [initialId]);
  const list = useResource(() => api.get(`/pets/${pet!.id}/safety-events${query({ from: range.from, to: range.to, cursor, limit: 25 })}`), [api, pet!.id, range, cursor]);
  const detail = useResource(async () => {
    if (!id) return null;
    const value = await api.get(`/safety-events/${id}`);
    if (value.pet_id !== pet!.id) throw new Error('此事件属于另一只宠物，请先切换到对应宠物后查看。');
    return value;
  }, [api, id, pet!.id]);
  const canWrite = ['owner', 'caregiver'].includes(currentRole(household, households, pet));
  return <Page title={`${pet!.name} · 安全事件`}><Notice text="确认知晓、本人通知已读与风险关闭分别记录；确认不会关闭事件，服务商受理不证明手机送达。" />
    <Card title="查看时间"><Choose value={period} options={[{ label: '今天', value: 'today' }, { label: '近7个自然日', value: 'week' }, { label: '全部历史', value: 'all' }]} onChange={value => setPeriod(value as SafetyPeriod)} />
      <Field label="IANA 时区" value={timezone} onChangeText={setTimezone} placeholder="Asia/Shanghai" />
      <Action title="应用时间筛选" run={() => loadSafetyRange(api, pet!.id, period, timezone.trim())} onDone={value => { setCursor(''); setId(''); setNote(''); setRange(value); }} />
      <Notice text={range.period === 'all' ? '当前显示全部安全历史。' : `当前显示：${range.from_date} 至 ${range.to_date}（${range.timezone}）；包括今天，固定自然日窗口。跨日或更改筛选后请重新应用。`} />
      {range.from && <Facts value={{ 窗口开始: range.from, 窗口结束_不含: range.to }} />}
    </Card>
    <Button title="刷新事件" onPress={list.refresh} /><ErrorNotice error={list.error} />
    {list.data?.items?.map((row: Row) => <Card key={row.id} title={({ 'geofence.exited': '离开围栏', 'geofence.entered': '返回围栏', 'battery.low': '低电量', 'device.offline': '设备离线', 'location.stale': '位置过期' } as Row)[row.type] ?? row.type}><Facts value={{ 状态: row.status, 发生时间: row.occurred_at, 关闭时间: row.closed_at, 关闭原因: row.closed_reason }} /><Button title="查看依据与确认情况" onPress={() => { setId(row.id); setNote(''); }} /></Card>)}
    {list.data?.items?.length === 0 ? <Notice text="当前范围没有安全事件；不等于现场没有风险。" /> : null}<Pager page={list.data} cursor={cursor} change={setCursor} />
    {id ? <Card title="事件详情"><ErrorNotice error={detail.error} /><Facts value={detail.data} />
      <Button title="重读详情" onPress={detail.refresh} />
      {canWrite && detail.data && !detail.data.acknowledgement ? <><Field label="确认备注（可选）" value={note} onChangeText={setNote} multiline maxLength={1000} />
        <Action title="确认已知晓" run={() => api.post(`/safety-events/${id}/ack`, { note: note.trim() })} onDone={async () => { await detail.refresh(); await list.refresh(); }} /></> : null}
      <Button title="收起详情" onPress={() => setId('')} /></Card> : null}
  </Page>;
}

export function SupportScreen({ route }: AppScreenProps) {
  const { api, user } = useApp();
  return <SupportBody key={`${api.baseUrl}:${user?.id}`} initialId={route.params?.ticketId ?? ''} />;
}
function SupportBody({ initialId }: { initialId: string }) {
  const { api, user, pet } = useApp();
  const [staff, setStaff] = useState(false), [status, setStatus] = useState(''), [cursor, setCursor] = useState(''), [selected, setSelected] = useState(initialId);
  const [category, setCategory] = useState('binding'), [description, setDescription] = useState(''), [diagnostics, setDiagnostics] = useState(false), [attach, setAttach] = useState(false);
  const [reply, setReply] = useState(''), [nextStatus, setNextStatus] = useState('in_progress'), [snapshot, setSnapshot] = useState<any>(null);
  const overview = useResource(() => pet ? api.get(`/pets/${pet.id}/overview`) : Promise.resolve(null), [api, pet?.id]);
  const device = overview.data?.device;
  const base = staff ? '/admin/support/tickets' : '/support/tickets';
  const list = useResource(() => api.get(`${base}${query({ status, cursor, limit: 20 })}`), [api, base, status, cursor]);
  const detail = useResource(() => selected ? api.get(`${base}/${selected}`) : Promise.resolve(null), [api, base, selected]);
  useEffect(() => { setSelected(initialId); }, [initialId]);
  useEffect(() => { setSnapshot(null); setReply(''); }, [selected, staff]);
  useEffect(() => { setAttach(false); setDiagnostics(false); }, [pet?.id]);
  useEffect(() => { if (!attach) setCategory('binding'); }, [attach]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') setSnapshot(null); });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (!snapshot) return;
    const remaining = Date.parse(snapshot.consent_expires_at) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setSnapshot(null); return; }
    const timer = setTimeout(() => setSnapshot(null), Math.min(remaining, 2147483647));
    return () => clearTimeout(timer);
  }, [snapshot]);
  return <Page title={staff ? '客服处理' : '帮助与工单'}>
    {user?.support_staff ? <Choose value={staff ? 'staff' : 'own'} options={[{ label: '我的工单', value: 'own' }, { label: '客服处理', value: 'staff' }]} onChange={value => { setStaff(value === 'staff'); setSelected(''); setCursor(''); }} /> : null}
    {!staff ? <Card title="提交求助"><Notice text="绑定前可提交纯文字绑定问题。诊断需选择当前已绑定设备并明确同意，只保存创建时快照，授权最长七天。" />
      <ErrorNotice error={overview.error} />{device ? <Toggle label={`关联当前设备 ${device.serial_no ?? device.id}`} value={attach} change={value => { setAttach(value); if (!value) setDiagnostics(false); }} /> : <Notice text="尚未选择有效绑定设备，可提交绑定前求助。" />}
      <Choose value={category} options={options(attach ? ['binding', 'location', 'notification', 'battery', 'wearing', 'other'] : ['binding'])} onChange={setCategory} />
      <Field label="问题描述" value={description} onChangeText={setDescription} multiline maxLength={4000} />
      {attach ? <Toggle label="自愿授权客服读取本工单的设备诊断快照" value={diagnostics} change={setDiagnostics} /> : null}
      <Action title="提交工单" run={() => { if (!description.trim()) throw new Error('请填写问题描述。'); return api.post('/support/tickets', { category: attach && device ? category : 'binding', description: description.trim(), device_id: attach && device ? device.id : null, diagnostics_consent: Boolean(attach && device && diagnostics) }); }}
        onDone={async value => { setDescription(''); setDiagnostics(false); setSelected(value.id); await list.refresh(); }} success="工单已保存，可查看回复及处理状态。" />
    </Card> : <Notice text="客服权限由服务端白名单检查；仅在有效诊断授权期间可读取快照。" />}
    <Card title="工单列表"><Choose value={status} options={options(['', 'open', 'in_progress', 'resolved'])} onChange={value => { setStatus(value); setCursor(''); }} /><Button title="刷新工单" onPress={list.refresh} /><ErrorNotice error={list.error} />
      {list.data?.items?.map((ticket: Row) => <Card key={ticket.id} title={`${ticket.category} · ${ticket.status}`}><Facts value={{ 创建时间: ticket.created_at, 描述: ticket.description, 设备: ticket.device_id }} /><Button title="查看工单与回复" onPress={() => setSelected(ticket.id)} /></Card>)}
      {list.data?.items?.length === 0 ? <Notice text="没有符合筛选的工单。" /> : null}<Pager page={list.data} cursor={cursor} change={setCursor} /></Card>
    {selected ? <Card title="工单详情"><ErrorNotice error={detail.error} /><Facts value={detail.data} /><Button title="重读详情" onPress={async () => { setSnapshot(null); await detail.refresh(); }} />
      {!staff && detail.data?.diagnostics?.consented_at && !detail.data?.diagnostics?.revoked_at ? <Action title="撤销本工单诊断授权" run={() => api.delete(`/support/tickets/${selected}/diagnostics-consent`)} onDone={async () => { setSnapshot(null); await detail.refresh(); await list.refresh(); }} success="诊断授权已撤销；工单与回复保留。" /> : null}
      {staff && detail.data ? <><Choose value={nextStatus} options={options(['in_progress', 'resolved'])} onChange={setNextStatus} /><Field label="客服回复" value={reply} onChangeText={setReply} multiline maxLength={4000} />
        <Action title="保存回复与状态" run={() => api.patch(`/admin/support/tickets/${selected}`, { status: nextStatus, reply: reply.trim() })} onDone={async () => { setReply(''); await detail.refresh(); await list.refresh(); }} />
        {detail.data.diagnostics?.available ? <Action title="读取获授权诊断快照" run={() => api.get(`/admin/devices/${detail.data.device_id}/diagnostics${query({ ticket_id: selected })}`)} onDone={setSnapshot} /> : <Notice text="诊断未授权、已撤销、过期或绑定失效；不读取旧快照。" />}</> : null}
      {snapshot && staff && detail.data?.diagnostics?.available ? <Card title="提交时的诊断快照"><Facts value={snapshot} /><Button title="隐藏快照" onPress={() => setSnapshot(null)} /></Card> : null}
      <Button title="收起工单" onPress={() => { setSelected(''); setSnapshot(null); }} />
    </Card> : null}
  </Page>;
}
