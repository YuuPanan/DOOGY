import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Choose, Notice, Page, colors } from '../ui';
import { AppScreenProps, Row } from '../types';

const amount = (value: unknown, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString()}${unit}` : '未知';
const dataStatus = (status: string | undefined) => ({ missing: '尚无活动上报', partial: '活动数据部分覆盖', available: '已有活动上报' } as Row)[status ?? ''] ?? '活动数据尚未读取';
function NextStep({ title, detail, onPress }: { title: string; detail: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${detail}`} onPress={onPress} style={({ pressed }) => [s.next, pressed && { opacity: 0.65 }]}>
    <View style={s.nextText}><Text style={s.nextTitle}>{title}</Text><Text style={s.caption}>{detail}</Text></View><Text style={s.arrow}>›</Text>
  </Pressable>;
}
function Metric({ label, value }: { label: string; value: string }) {
  return <View style={s.metric}><Text style={s.metricValue}>{value}</Text><Text style={s.caption}>{label}</Text></View>;
}
function ErrorNotice({ error }: { error: unknown }) {
  return error ? <Notice text={error instanceof Error ? error.message : String(error)} tone="error" /> : null;
}
export function HomeScreen({ navigation, route }: AppScreenProps) {
  const app = useApp(), { api, pet, pets, selectPet, refreshIdentity, region } = app;
  const onboarding = app.onboarding;
  const writable = app.households.some(item => item.id === pet?.household_id && ['owner', 'caregiver'].includes(item.role));
  const environment = useResource(() => api.get('/health'), [api]);
  return <Page title="今天" subtitle={region === 'cn' ? '中国大陆服务区 · DOOGY' : '海外服务区 · DOOGY'}>
    <View style={s.hero}><Text style={s.eyebrow}>一起照顾好每一天</Text>
      {pet && <View style={s.petRow}><View style={s.petMark}><Text style={s.petInitial}>{pet.name?.slice(0, 1) || '宠'}</Text></View>
        <View style={s.nextText}><Text style={s.petName}>{pet.name}</Text><Text style={s.caption}>{({ dog: '狗', cat: '猫', other: '其他宠物' } as Row)[pet.species] ?? '当前宠物'} · 当前照护档案</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="打开宠物档案" onPress={() => navigation.navigate('Pet', { from: 'today' })} style={s.profileLink}><Text style={s.profileText}>宠物档案 ›</Text></Pressable>
      </View>}
      <Text style={s.greeting}>{pet ? `${pet.name}，今天怎么样？` : '先认识你的伙伴'}</Text>
      <Text style={s.caption}>活动上报与日常照护放在一起看，没有项圈也可以开始记录。</Text>
      {pets.length > 0 && <Choose value={pet?.id ?? ''} options={pets.map(item => ({ value: item.id, label: item.name }))} onChange={selectPet} />}
      {pet && <Button title={writable ? '记录今天的照护' : '查看今天的照护'} onPress={() => navigation.navigate('Care', { from: 'today' })} />}
    </View>
    <ErrorNotice error={environment.error} />
    {environment.error && <Button title="重试读取服务状态" variant="secondary" disabled={environment.loading} onPress={environment.refresh} />}
    {environment.data?.demo ? <Text style={s.demoBadge}>合成数据演示环境 · 通知模拟不代表真实送达</Text>
      : environment.data?.mode === 'offline' && <Notice text="当前服务处于offline模式，不调用外部业务服务；App仍需连接服务器。" />}
    {onboarding && !onboarding.completed_at && <Card title="继续设置">
      <Text style={s.caption}>{({ create_or_select_pet: '选择宠物后，就能开始记录每天的照护。', connect_collar: '可以连接已有项圈，也可以先跳过，继续使用手工照护。', finish: '你的选择已保存，完成设置后继续今天的照护。' } as Row)[onboarding.next_step] ?? '继续上次保存的设置。'}</Text>
      <Button title="继续上次设置" onPress={() => navigation.navigate('Onboarding')} />
    </Card>}
    {pet ? <Today key={`${api.baseUrl}:${pet.id}`} navigation={navigation} route={route} /> : <Card title="开始照护">
      <Notice text={pets.length ? '请选择一只宠物，查看它的日常记录与安全状态。' : '先建立宠物档案；绑定项圈不是开始照护的前提。'} />
      <Button title={pets.length ? '选择或建立宠物档案' : '添加第一位伙伴'} onPress={() => navigation.navigate('Pet', { from: 'today' })} />
      <Button title="按步骤完成设置" variant="secondary" onPress={() => navigation.navigate('Onboarding')} />
      <NextStep title="接受家人的邀请" detail="用当前账号加入已有家庭，共同照护宠物。" onPress={() => navigation.navigate('Household')} />
    </Card>}
    <Explore navigation={navigation} />
    <Action title="刷新家庭、宠物与设置" run={refreshIdentity} />
  </Page>;
}
function Today({ navigation }: AppScreenProps) {
  const { api, pet: selectedPet, households } = useApp(), pet = selectedPet!;
  const role = households.find(item => item.id === pet.household_id)?.role ?? 'viewer', writable = ['owner', 'caregiver'].includes(role);
  const overview = useResource(() => api.get(`/pets/${pet.id}/overview`), [api, pet.id]);
  const current = overview.data?.pet?.id === pet.id ? overview.data : null;
  const daily = useResource(async () => {
    if (!current?.activity) return null;
    const period = `?date=${encodeURIComponent(current.activity.local_date)}&timezone=${encodeURIComponent(current.activity.timezone)}`;
    const [goals, body, nutrition] = await Promise.all([
      api.get(`/pets/${pet.id}/goals${period}`), api.get(`/pets/${pet.id}/body-check-ins${period}`), api.get(`/pets/${pet.id}/nutrition/daily${period}`),
    ]);
    return { goals, body, nutrition };
  }, [api, pet.id, current?.activity?.local_date, current?.activity?.timezone]);
  useEffect(() => navigation.addListener('focus', () => { void overview.refresh(); void daily.refresh(); }), [navigation, overview.refresh, daily.refresh]);
  const activity = current?.activity, attention = current?.attention, body = daily.data?.body, nutrition = daily.data?.nutrition;
  const filledBody = body ? ['appetite', 'energy', 'movement', 'stool'].filter(name => body.values?.[name] != null).length : null;
  const target = daily.data?.goals?.goals?.targets?.active_minutes;
  const hasRisks = typeof attention?.unacknowledged_open_event_count === 'number' && attention.unacknowledged_open_event_count > 0;
  const device = current?.device, recentCare = Array.isArray(current?.care_records) ? current.care_records.slice(0, 2) : [];
  return <>
    <ErrorNotice error={overview.error} />
    {overview.loading && <Notice text="正在读取今天的实际记录…" />}
    {!writable && <Notice text="你正在以只读身份查看。家人保存的记录可查看，照护与设置变更需主人或照护者完成。" />}
    <Card title={activity ? `${activity.local_date} · 今日摘要` : '今日摘要'}>
      <View style={s.metrics}><Metric label="上报步数" value={amount(activity?.steps)} /><Metric label="活动分钟" value={amount(activity?.active_minutes)} /><Metric label="睡眠分钟" value={amount(activity?.sleep_minutes)} /></View>
      <Text style={s.caption}>{dataStatus(activity?.data_status)}{typeof activity?.coverage_seconds === 'number' ? ` · 已覆盖${Math.round(activity.coverage_seconds / 360) / 10}小时` : ''}</Text>
      {activity && <Text style={s.caption}>统计时区：{activity.timezone} · 来源：{activity.sources?.length ? activity.sources.map((source: string) => source === 'device' ? '设备上报' : source).join('、') : '尚无上报来源'}{activity.estimated ? ' · 含估算数据' : ''}</Text>}
      {typeof target === 'number' && <Text style={s.caption}>你设置的活动目标为{target}分钟，当前进度以实际已上报数据为准。</Text>}
      <Text style={s.caption}>尚无数据的指标保持未知；这里不生成日常评分。</Text>
      <Button title="查看健康概览与活动趋势" onPress={() => navigation.navigate('Wellness', { section: 'activity' })} />
      <Button title="刷新今日摘要" variant="secondary" disabled={overview.loading} onPress={async () => { await overview.refresh(); await daily.refresh(); }} />
    </Card>
    <Card title="今天的照护，从这里继续">
      <ErrorNotice error={daily.error} />
      {daily.error && <Button title="重试读取今日照护" variant="secondary" disabled={daily.loading} onPress={daily.refresh} />}
      {daily.loading && <Text style={s.caption}>正在读取今日输入和餐食…</Text>}
      <NextStep title={writable ? body?.version > 0 ? '查看或补充身体观察' : '记录今天的身体观察' : '查看今天的身体观察'}
        detail={body ? body.version > 0 ? `${filledBody}/4项已有原文，可继续核对食欲、精力、行动和排便。` : '食欲、精力、行动与排便可以分别记录；未填项保持未知。' : '读取今日观察原文和修订，不生成状态分。'} onPress={() => navigation.navigate('Wellness', { section: 'body' })} />
      <NextStep title={writable ? '记录餐食或体重' : '查看餐食与体重记录'}
        detail={nutrition ? nutrition.record_count ? `今日已记录${nutrition.record_count}条餐食；已知能量${amount(nutrition.known_kcal, ' kcal')}，${nutrition.unknown_energy_count}条能量未知。` : '今天尚未记录餐食；有标签时才计算已知能量。' : '保留实际数量、kg/lb原值与标签来源，记录可以修订。'} onPress={() => navigation.navigate('Care', { from: 'today' })} />
      {writable && <><Button title="记录一餐" variant="secondary" onPress={() => navigation.navigate('Care', { createType: 'feeding', from: 'today' })} /><Button title="记录体重" variant="secondary" onPress={() => navigation.navigate('Care', { createType: 'weight', from: 'today' })} /></>}
      <NextStep title="查看健康观察与提醒" detail="核对完整日活动评估、原证据与本人已阅；没有发现或输入不足也会如实显示。" onPress={() => navigation.navigate('Health')} />
    </Card>
    <Card title={hasRisks ? '有变化需要你留意' : '位置与安全'}>
      {attention ? <Text style={hasRisks ? s.attention : s.nextTitle}>{attention.unacknowledged_open_event_count}项开放事件待确认 · {attention.unread_notification_count}条本人未读通知</Text>
        : <Text style={s.caption}>安全计数尚未读取，不按0处理。</Text>}
      <Text style={s.caption}>{current ? device ? `${({ online: '项圈在线', offline: '项圈离线', unknown: '项圈状态未知' } as Row)[device.connection_status] ?? '项圈状态未知'} · 电量${amount(device.battery_pct, '%')}` : '尚未绑定项圈，位置和围栏判断可能没有数据。' : '正在读取当前项圈与位置状态。'}</Text>
      <Button title={hasRisks ? '查看风险与下一步' : '查看位置、围栏与安全'} onPress={() => navigation.navigate('SafetyHub')} />
      {typeof attention?.unread_notification_count === 'number' && attention.unread_notification_count > 0 && <Button title="打开本人未读通知" variant="secondary" onPress={() => navigation.navigate('Notifications')} />}
    </Card>
    {recentCare.length > 0 && <Card title="今天最近的记录">
      {recentCare.map((record: Row) => <View key={record.id} style={s.recent}><Text style={s.nextTitle}>{({ weight: '体重', feeding: '餐食', medication: '用药', grooming: '护理', note: '笔记', toileting: '排泄', custom: record.custom_type ?? '自定义事项' } as Row)[record.type] ?? '照护记录'}</Text><Text style={s.caption}>{record.recorded_at}</Text>{['note', 'custom', 'toileting'].includes(record.type) && typeof record.value?.text === 'string' && record.value.text ? <Text style={s.caption} numberOfLines={2}>{record.value.text}</Text> : null}{record.notes ? <Text style={s.caption} numberOfLines={2}>{record.notes}</Text> : null}</View>)}
      <Button title="查看记录与修订历史" variant="secondary" onPress={() => navigation.navigate('Care', { from: 'today' })} />
    </Card>}
  </>;
}
function Explore({ navigation }: { navigation: any }) {
  const [more, setMore] = useState(false);
  return <>
    <Card title="更了解你的伙伴">
      <NextStep title="学习一门照护课程" detail="查看已发布内容，保存自己的学习步骤与进度。" onPress={() => navigation.navigate('Learning')} />
      <NextStep title="留下行为观察" detail="记录亲眼观察到的行为，查看已有片段与解释任务。" onPress={() => navigation.navigate('Behavior')} />
      <NextStep title="带着记录提问" detail="明确选择活动、身体观察、课程或行为作为上下文。" onPress={() => navigation.navigate('Assistant')} />
    </Card>
    <Card title="家人一起照护">
      <NextStep title="邀请家人或调整共享权限" detail="查看家庭成员、邀请与照护角色。" onPress={() => navigation.navigate('Household')} />
      <Button title={more ? '收起更多入口' : '更多管理与帮助'} variant="secondary" onPress={() => setMore(!more)} />
      {more && <>
        <Button title="通知收件箱与提醒偏好" variant="secondary" onPress={() => navigation.navigate('Notifications')} />
        <Button title="联系人与文字通知" variant="secondary" onPress={() => navigation.navigate('Contacts')} />
        <Button title="项圈绑定、策略与配置历史" variant="secondary" onPress={() => navigation.navigate('Devices', { section: 'device' })} />
        <Button title="安全事件完整历史" variant="secondary" onPress={() => navigation.navigate('Safety')} />
        <Button title="继续设置宠物与项圈" variant="secondary" onPress={() => navigation.navigate('Onboarding')} />
        <Button title="宠物档案与头像" variant="secondary" onPress={() => navigation.navigate('Pet', { from: 'today' })} />
        <Button title="个人资料" variant="secondary" onPress={() => navigation.navigate('Profile')} />
        <Button title="数据导出与隐私" variant="secondary" onPress={() => navigation.navigate('Privacy')} />
        <Button title="求助与连接帮助" variant="secondary" onPress={() => navigation.navigate('Support')} />
      </>}
    </Card>
  </>;
}
const s = StyleSheet.create({
  hero: { backgroundColor: '#dfead9', borderRadius: 22, padding: 23, gap: 11 }, eyebrow: { color: colors.primary, fontSize: 12, fontWeight: '600' },
  greeting: { fontSize: 25, lineHeight: 34, fontWeight: '700', color: colors.ink }, caption: { color: colors.muted, lineHeight: 22 },
  petRow: { flexDirection: 'row', alignItems: 'center', gap: 11 }, petMark: { width: 50, height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f6ef' },
  petInitial: { color: colors.primary, fontSize: 23, fontWeight: '700' }, petName: { color: colors.ink, fontSize: 18, fontWeight: '700' },
  profileLink: { paddingVertical: 13, paddingHorizontal: 7 }, profileText: { color: colors.primary, fontSize: 14, fontWeight: '600' }, demoBadge: { alignSelf: 'flex-start', color: colors.muted, fontSize: 12, lineHeight: 18 },
  next: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  nextText: { flex: 1, gap: 5 }, nextTitle: { color: colors.ink, fontSize: 16, fontWeight: '600', lineHeight: 23 }, arrow: { color: colors.primary, fontSize: 28 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginVertical: 7 }, metric: { flexGrow: 1, flexBasis: '28%', gap: 5 },
  metricValue: { fontSize: 23, fontWeight: '700', color: colors.ink }, attention: { color: colors.danger, fontSize: 17, lineHeight: 25, fontWeight: '600' },
  recent: { paddingVertical: 8, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
});
