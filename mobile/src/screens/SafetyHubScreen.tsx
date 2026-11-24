import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Button, Card, Facts, Notice, Page, colors } from '../ui';
import { AppScreenProps, Row } from '../types';

const amount = (value: unknown, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()}${unit}` : '未知';
const eventName = (type: string) => ({ 'geofence.exited': '离开围栏', 'geofence.entered': '返回围栏', 'battery.low': '电量偏低', 'device.offline': '设备离线', 'location.stale': '位置过期' } as Row)[type] ?? type;
export function SafetyHubScreen(props: AppScreenProps) {
  const { api, pet } = useApp();
  if (!pet) return <Page title="安全与位置"><Notice text="先选择宠物，才能读取它的项圈、位置和安全记录。没有项圈也可以使用日常照护。" />
    <Button title="选择或建立宠物档案" onPress={() => props.navigation.navigate('Pet')} /><Button title="连接项圈的设置指引" variant="secondary" onPress={() => props.navigation.navigate('Onboarding')} />
    <Button title="查看求助与工单" variant="secondary" onPress={() => props.navigation.navigate('Support')} />
  </Page>;
  return <PetSafetyHub key={`${api.baseUrl}:${pet.id}`} {...props} />;
}
function PetSafetyHub({ navigation }: AppScreenProps) {
  const { api, pet: selectedPet, households } = useApp(), pet = selectedPet!;
  const writable = ['owner', 'caregiver'].includes(households.find(item => item.id === pet.household_id)?.role ?? 'viewer');
  const resource = useResource(async () => {
    const [overview, latest] = await Promise.all([api.get(`/pets/${pet.id}/overview`), api.get(`/pets/${pet.id}/location/latest`)]);
    return { overview, latest };
  }, [api, pet.id]);
  useEffect(() => navigation.addListener('focus', () => { void resource.refresh(); }), [navigation, resource.refresh]);
  const overview = resource.data?.overview, location = resource.data?.latest?.id ? resource.data.latest : null, device = overview?.device, attention = overview?.attention;
  const fallback = !location?.usable_for_tracking && location?.last_usable_location?.usable_for_tracking ? location.last_usable_location : null;
  const fences: Row[] = overview?.geofences?.items ?? [], enabledFences = fences.filter(item => item.enabled);
  const pending: Row[] = attention?.unacknowledged_open_events ?? [];
  const lostEnabled = device?.reporting?.lost_mode?.enabled === true;
  const toDevice = (section: string) => navigation.navigate('Devices', { section });
  const positionTitle = !resource.data ? '位置状态尚未读取' : !device ? '尚未绑定项圈' : !location
    ? overview.location_wait?.status === 'delayed' ? '仍在等待首次定位，请检查项圈' : '等待项圈首次定位'
    : location.usable_for_tracking ? '最近采样位置可用' : fallback ? '最近点暂不可用，另有可用参考点' : location.freshness === 'stale' ? '最近位置已经过期' : '最近位置暂不可用';
  return <Page title={`${pet.name} · 安全与位置`} subtitle="先看实际状态，再选择下一步" loading={resource.loading} onRefresh={resource.refresh}>
    {resource.error && <Notice text={resource.error} tone="error" />}
    {!writable && <Notice text="当前为只读身份，可查看位置与安全记录；变更围栏、走失或分享需家庭写权限。" />}
    <Card title="现在在哪里">
      <View style={s.position}><Text style={s.positionTitle}>{positionTitle}</Text>
        <Text style={s.body}>最近采样：{location?.device_ts ?? '未知'}</Text><Text style={s.body}>最近接收：{location?.received_at ?? '未知'}</Text>
        {location && <Text style={s.body}>定位精度：{amount(location.accuracy_m, '米')} · 来源：{({ gnss: '卫星定位', wifi: 'Wi-Fi', cellular: '蜂窝网络', ble: '蓝牙', vendor: '供应商' } as Row)[location.source] ?? location.source ?? '未知'}</Text>}
      </View>
      {location && <Facts value={{ 纬度: location.lat, 经度: location.lon, 定位新鲜度: location.freshness, 质量说明: location.quality_flags }} />}
      {fallback && <><Text style={s.label}>可用参考点（与最近点分开）</Text><Facts value={{ 采样时间: fallback.device_ts, 接收时间: fallback.received_at, 纬度: fallback.lat, 经度: fallback.lon, 精度米: fallback.accuracy_m }} /></>}
      <Notice text="显示的是服务端已有位置记录。刷新不会请求项圈新定位；近场蓝牙状态尚未接入。" />
      <Button title="查看位置与足迹" onPress={() => toDevice('locations')} />
      <Button title="重新读取位置和状态" variant="secondary" onPress={resource.refresh} disabled={resource.loading} />
    </Card>
    <Card title="需要留意的变化">
      <View style={s.counts}><View style={s.count}><Text style={s.number}>{amount(attention?.unacknowledged_open_event_count)}</Text><Text style={s.body}>开放事件待确认</Text></View>
        <View style={s.count}><Text style={s.number}>{amount(attention?.open_event_count)}</Text><Text style={s.body}>当前开放事件</Text></View>
        <View style={s.count}><Text style={s.number}>{amount(attention?.unread_notification_count)}</Text><Text style={s.body}>本人未读通知</Text></View>
      </View>
      {attention?.open_event_count === 0 && <Text style={s.body}>当前没有已记录的开放安全事件；设备和位置缺少数据时仍会单独提示。</Text>}
      {pending.map(event => <View key={event.id} style={s.event}><Text style={s.label}>{eventName(event.type)}</Text><Text style={s.body}>{event.occurred_at}</Text>
        <Button title={writable ? '查看并确认这项事件' : '查看事件依据'} variant="secondary" onPress={() => navigation.navigate('Safety', { eventId: event.id, petId: pet.id })} />
      </View>)}
      <Button title={typeof attention?.unacknowledged_open_event_count === 'number' && attention.unacknowledged_open_event_count > 0 ? writable ? '处理待确认安全事件' : '查看待确认安全事件' : '查看安全历史'} onPress={() => navigation.navigate('Safety')} />
      <Button title="查看本人通知与提醒偏好" variant="secondary" onPress={() => navigation.navigate('Notifications')} />
    </Card>
    <Card title="家庭围栏">
      {resource.data ? enabledFences.length ? enabledFences.map(fence => <View key={fence.id} style={s.event}><Text style={s.label}>{fence.name}</Text>
        <Text style={s.body}>{({ inside: '服务端判断在围栏内', outside: '服务端判断在围栏外', unknown: '当前判断未知' } as Row)[fence.state?.effective_status] ?? '当前判断未知'}</Text>
        <Text style={s.body}>判断时点：{fence.state?.last_ts ?? '未知'}</Text>
      </View>) : <Notice text="目前没有启用的围栏。可以查看设置，或在确认边界后由主人/照护者保存。" /> : <Text style={s.body}>围栏状态尚未读取。</Text>}
      <Button title={writable ? '查看与调整围栏' : '查看围栏设置'} onPress={() => toDevice('fences')} />
      <Button title="查看规则与策略修改记录" variant="secondary" onPress={() => toDevice('history')} />
    </Card>
    <Card title="需要协助寻找时">
      <Text style={s.body}>{resource.data ? !device ? '当前没有绑定项圈。先完成绑定并确认收到定位，才能依赖项圈位置寻找。' : lostEnabled ? '走失会话已开启。采样频率是否改变，仍以设备实际回执为准。' : '尚未开启走失会话。需要时可显式请求开启，再查看执行状态。' : '走失会话状态尚未读取。'}</Text>
      {device && <Facts value={{ 连接状态: device.connection_status, 电量百分比: device.battery_pct, 走失会话: device.reporting?.lost_mode, 策略状态: device.reporting?.status }} />}
      <Button title={device ? lostEnabled ? '查看寻找会话与设备回执' : writable ? '查看并请求开启寻找会话' : '查看寻找会话与策略' : '查看项圈绑定与设置'} onPress={() => toDevice('device')} />
      <Button title="查看限时位置分享" variant="secondary" onPress={() => toDevice('shares')} disabled={!writable} />
      {!writable && <Text style={s.body}>位置分享由当前有写权限的成员显式创建和管理。</Text>}
      <Notice text="位置分享需要有效走失会话及本次授权，有期限且可撤销。不会自动随联系人文字通知发送。" />
      <Button title="联系人、拨号与文字通知" variant="secondary" onPress={() => navigation.navigate('Contacts')} />
    </Card>
    <Card title="项圈与连接帮助">
      <Text style={s.body}>绑定、设备上报与手机蓝牙是不同状态。目前没有实际蓝牙配对、项圈声响或召回通道，不提供虚假的执行成功。</Text>
      <Button title="继续项圈设置指引" onPress={() => navigation.navigate('Onboarding')} />
      <Button title="查看绑定帮助或提交工单" variant="secondary" onPress={() => navigation.navigate('Support')} />
    </Card>
  </Page>;
}
const s = StyleSheet.create({
  position: { padding: 16, borderRadius: 14, backgroundColor: '#e9f0e7', gap: 7 }, positionTitle: { color: colors.ink, fontWeight: '700', fontSize: 20, lineHeight: 28 },
  body: { color: colors.muted, lineHeight: 22 }, label: { color: colors.ink, fontSize: 16, fontWeight: '600', lineHeight: 23 },
  counts: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginVertical: 7 }, count: { flexGrow: 1, flexBasis: '28%', gap: 4 }, number: { color: colors.ink, fontSize: 25, fontWeight: '700' },
  event: { paddingVertical: 10, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
