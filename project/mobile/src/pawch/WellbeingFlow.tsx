import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { bodyForm, bodyVersion, useServerDraft, useWriteKey } from '../screens/CareScreens';
import { Body, Button, Caption, Card, Field, go, Heading, Notice, Page, palette, Pill, Row, styles } from './ui';
import { amount, Bars, Data, dayAt, finite, FlowProps, instant, query, ReadState, shiftDay, useAlive, useRead } from './data';

const observations = [['energy', 'Energy'], ['appetite', 'Appetite · owner-reported'], ['movement', 'Movement · owner-reported'], ['stool', 'Stool · owner-reported']];
export function PawchWellbeingScreen(props: FlowProps) {
  const { api, user, pet, households } = useApp(), role = households.find(row => row.id === pet?.household_id)?.role;
  return pet ? <WellbeingBody key={`${api.baseUrl}:${user?.id}:${pet.id}:${role}:${props.screenId}`} {...props} /> : <Page {...props} title="Meet your companion."><Notice text="先建立或选择宠物；没有项圈也可以记录日常照护。" /><Button title="Meet your dog" onPress={() => go(props.navigation, '03')} /><Button secondary title="Family & invitations" onPress={() => props.navigation.navigate('Household')} /></Page>;
}
function WellbeingBody(props: FlowProps) {
  const { screenId: id, navigation } = props, params = props.route?.params ?? props.params ?? {};
  const { api, pet: selected, pets, households, selectPet, refreshIdentity } = useApp(), pet = selected!;
  const canWrite = households.some(row => row.id === pet.household_id && ['owner', 'caregiver'].includes(row.role));
  const zone = pet.effective_timezone ?? pet.timezone ?? 'Asia/Shanghai', date = params.date ?? dayAt(zone);
  const read = useRead(async () => {
    const overview = await api.get(`/pets/${pet.id}/overview`), qs = query({ date, timezone: zone });
    const [goals, body, nutrition] = await Promise.all([api.get(`/pets/${pet.id}/goals${qs}`), api.get(`/pets/${pet.id}/body-check-ins${qs}`), api.get(`/pets/${pet.id}/nutrition/daily${qs}`)]);
    return { overview, goals, body, nutrition };
  }, [api, pet.id, date, zone], navigation);
  const metric = id === '12' ? 'sleep_minutes' : id === '16' ? 'weight_kg' : 'active_minutes';
  const trend = useRead(() => ['11', '12', '16'].includes(id) ? api.get(`/pets/${pet.id}/trends${query({ metric, from: shiftDay(date, -6), to: shiftDay(date, 1), timezone: zone, limit: 7 })}`) : Promise.resolve(null), [api, pet.id, metric, date, zone], navigation);
  const data = read.data, activity = data?.overview?.activity, device = data?.overview?.device, goals = data?.goals?.goals?.targets, body = data?.body, nutrition = data?.nutrition;
  const nav = (target: string, values: Data = {}) => go(navigation, target, values);
  const retry = <ReadState resource={read} />;
  const source = <Caption>{activity ? `${activity.local_date} · ${activity.timezone} · ${(activity.sources ?? []).join(', ') || 'No source'} · ${activity.data_status}` : '尚无已读取的活动来源。'}{activity?.estimated ? ' · 含估算' : ''}</Caption>;
  const metricPanel = (label: string, value: string, target?: string) => <View style={s.dark}><Text style={s.lime}>{label}</Text><Text style={[s.big, value.length > 10 && { fontSize: 32, lineHeight: 40 }]}>{value}</Text>{target && <Text style={s.light}>{target}</Text>}</View>;
  const empty = !read.loading && !data && !read.error ? <Notice text="No journal data yet." /> : null;
  if (id === '15a') return <BodyEditor {...props} value={body ?? null} read={read} canWrite={canWrite} date={date} zone={zone} />;
  if (id === '17') return <WeightEditor {...props} canWrite={canWrite} />;
  if (id === '09') return <Page {...props} back title={`A day with ${pet.name}.`} subtitle={`${date} · Your field journal`}>
    {retry}{empty}
    <View style={[s.dark, { minHeight: 176 }]}><Text style={s.lime}>WELLBEING · OBSERVATIONS</Text><Text style={s.big}>{amount(activity?.active_minutes, ' min')}</Text><Text style={s.light}>Daily facts, without a made-up score.</Text></View>
    <Row title={`Activity  ${amount(activity?.active_minutes)} / ${amount(goals?.active_minutes)} min`} subtitle="Actual reports and your own target" onPress={() => nav('11')} />
    <Row tone="sage" title={device ? `Collar · ${device.connection_status ?? 'unknown'}` : 'Location · not yet known'} subtitle={device ? `Battery ${amount(device.battery_pct, '%')} · Read safety evidence` : 'No bound collar. This does not mean safe.'} onPress={() => nav('28')} />
    <Row title="Health overview" subtitle="Sleep, body check-ins and daily patterns" onPress={() => nav('10')} />
    <View style={styles.row}>{[['Insights', '18'], ['Food', '20'], ['Exercise', '40']].map(([label, target]) => <View style={{ flex: 1 }} key={target}><Button secondary title={label} onPress={() => nav(target)} /></View>)}</View>
    {source}
    {data?.overview?.care_records?.slice(0, 2).map((row: Data) => <Row key={row.id} title={row.value?.text ?? row.custom_type ?? row.type} subtitle={row.recorded_at} onPress={() => navigation.navigate('Care', { from: 'today' })} />)}
    <Button title={canWrite ? 'Record care' : 'View care'} onPress={() => nav('26')} />
    <Row title="Today's inputs" subtitle="Add owner context and review collar sources" onPress={() => nav('14')} />
    {pets.length > 1 && <View style={s.pills}>{pets.map(row => <Pill key={row.id} title={row.name} selected={row.id === pet.id} onPress={() => selectPet(row.id)} />)}</View>}
    <Button secondary title="Refresh identity & permissions" run={async () => { await refreshIdentity(); await read.refresh(); }} />
    <Button secondary title="Account, family & privacy" onPress={() => navigation.navigate('Profile')} />
  </Page>;
  if (id === '10') return <Page {...props} title="The bigger picture." subtitle={`${pet.name}'s health · daily overview`} footer={<Button title="Review wellbeing evidence" onPress={() => nav('13')} />}>
    {retry}<Row title="Activity" subtitle={`${amount(activity?.active_minutes, ' min active')} · ${amount(activity?.steps, ' steps')}`} onPress={() => nav('11')} /><Row title="Sleep" subtitle={amount(activity?.sleep_minutes, ' min reported')} onPress={() => nav('12')} /><Row title="Weight" subtitle={amount(pet.weight_kg, ' kg')} onPress={() => nav('16')} /><Row title="Nutrition" subtitle={`${amount(nutrition?.known_kcal)} of ${amount(nutrition?.target_kcal)} kcal logged`} onPress={() => nav('20')} /><Row tone="alert" title="Health warnings" subtitle="Read evidence, coverage and uncertainty" onPress={() => nav('24')} /><Row title="Care & vet guidance" subtitle="Published guidance and your own care notes" onPress={() => nav('26')} />
  </Page>;
  if (id === '11' || id === '12') {
    const sleep = id === '12', value = sleep ? activity?.sleep_minutes : activity?.active_minutes;
    return <Page {...props} title={sleep ? 'Rest is an adventure, too.' : 'Every step counts.'} subtitle={sleep ? 'TODAY / Reported sleep' : 'TODAY / Activity'} footer={<Button title={sleep ? 'Explore sleep trends' : "Build today's plan"} onPress={() => nav(sleep ? '19' : '41', { metric: sleep ? 'sleep_minutes' : 'active_minutes' })} />}>
      {retry}<View><Text style={styles.metric}>{amount(sleep && value != null ? value / 60 : value, sleep ? ' h' : ' min')}</Text><Caption>{sleep ? '仅展示已上报总量，不推断夜间分段、午睡或正常范围。' : `Target ${amount(goals?.active_minutes, ' min')} · goals are not completed activity`}</Caption></View>
      <ReadState resource={trend} /><Bars items={trend.data?.items ?? []} unit={sleep ? 'minutes of reported sleep' : 'active minutes / day'} />
      {sleep ? <><Row title="Night rest" subtitle="未配置可核验的睡眠分段" /><Row title="Daytime naps" subtitle="不从总睡眠分钟推造午睡时长" /></> : <Card tone="sage"><View style={styles.split}><View><Heading>{amount(activity?.steps)}</Heading><Caption>steps today</Caption></View><View><Heading>{amount(activity?.distance_m == null ? null : activity.distance_m / 1000, ' km')}</Heading><Caption>reported distance</Caption></View></View></Card>}
      {source}<Row title={sleep ? 'Sleep evidence' : 'A little more exploring'} subtitle="Review your own plan and the available coverage" onPress={() => nav(sleep ? '15c' : '40')} />
    </Page>;
  }
  if (id === '13') return <Page {...props} title="What makes today?" subtitle="Four sources. One daily view." footer={<Button title="Review today's inputs" onPress={() => nav('14')} />}>
    {retry}{metricPanel('WELLBEING SCORE', 'Not configured', '原型80/100及四项25%不是已确认算法。')}
    <Card>{[['Activity', amount(activity?.active_minutes, ' min')], ['Sleep', amount(activity?.sleep_minutes, ' min')], ['Body', body?.version > 0 ? `${observations.filter(([key]) => body.values?.[key] != null).length}/4 observations` : 'Not supplied'], ['Nutrition', amount(nutrition?.known_kcal, ' kcal')]].map(([label, value]) => <View key={label} style={{ gap: 10 }}><View style={styles.split}><Body>{label}</Body><Body>{value}</Body></View><View style={{ height: 7, borderRadius: 4, backgroundColor: palette.sage }} /></View>)}</Card><Caption>原始事实与缺失状态分别显示，不计算示例分数或医学结论。</Caption>
  </Page>;
  if (id === '14') return <Page {...props} title="Today's inputs" subtitle="A little context makes a clearer picture." footer={<Button title={`Check in with ${pet.name}`} onPress={() => nav('15')} />}>
    {retry}<Row title="Collar activity" subtitle={amount(activity?.active_minutes, ' active min')} onPress={() => nav('11')} /><Row title="Rest & sleep" subtitle={amount(activity?.sleep_minutes, ' min reported')} onPress={() => nav('12')} /><Row tone="sage" title="Body check-in" subtitle={body?.version > 0 ? `Owner observations · version ${body.version}` : 'Ready for your observations'} onPress={() => nav('15')} /><Row title="Food journal" subtitle={amount(nutrition?.known_kcal, ' kcal logged')} onPress={() => nav('20')} /><Row title="Weight" subtitle={amount(pet.weight_kg, ' kg')} onPress={() => nav('16')} /><Notice text="Your observations matter. Look for changes from your companion's usual." />
  </Page>;
  if (id === '15') return <Page {...props} title="Body check-in" subtitle={`${date} / Separate sources`} footer={<><Button title="Review collar summary" onPress={() => nav('15c')} /><Button title={canWrite ? 'Log manually' : 'View owner observations'} onPress={() => nav('15a')} /><Button secondary title="Review health warnings" onPress={() => nav('24')} /></>}>
    {retry}<Card tone="sage"><Heading>Automatically reported</Heading><Caption>{device ? `Collar source · ${activity?.local_date ?? 'time unknown'}` : 'No bound collar source'}</Caption><Body>Activity: {amount(activity?.active_minutes, ' min')}</Body><Body>Rest: {amount(activity?.sleep_minutes, ' min')}</Body><Caption>食欲、行动、姿势不由活动总量推断。</Caption></Card><Card title="Owner observations">{observations.map(([key, label]) => <View key={key}><Caption>{label}</Caption><Body>{body?.values?.[key] ?? 'Not supplied'}</Body></View>)}</Card>
  </Page>;
  if (id === '15b') return <Page {...props} title={body?.version > 0 ? 'Check-in saved' : 'Check-in not confirmed'} subtitle={`${date} / Owner observations`} footer={<><Button title="Back to body check-in" onPress={() => nav('15')} /><Button secondary title="Review health warnings" onPress={() => nav('24')} /></>}>
    {retry}<Body>{body?.version > 0 ? `Owner-reported · version ${body.version}` : '尚无服务端已保存版本；此页面不凭导航宣称成功。'}</Body>{observations.map(([key, label]) => <Row key={key} title={label} subtitle={body?.values?.[key] ?? 'Not supplied'} />)}<Caption>项圈自动上报与主人原文分开，保存到当前配置的服务，不冒称“数据未离开原型”。</Caption>
  </Page>;
  if (id === '15c') return <Page {...props} title="Review collar summary" titleStyle={{ fontSize: 26, lineHeight: 32 }} subtitle={`${date} / Reported evidence`} footer={<><Button title="Review owner observations" onPress={() => nav('15a')} /><Button secondary title="Back to body check-in" onPress={() => nav('15')} /></>}>
    {retry}<Row title="Activity · reported source" subtitle={amount(activity?.active_minutes, ' min')} onPress={() => nav('11')} /><Row title="Rest · reported source" subtitle={amount(activity?.sleep_minutes, ' min')} onPress={() => nav('12')} />{source}<Notice text="自动遥测是只读证据；不能按原型按钮改写设备历史。需要补充时记录主人观察原文，保留来源。" />
  </Page>;
  return <Page {...props} title="A journal of their own." subtitle={`WEIGHT / ${pet.name}'s body journal`} footer={<Button title="Log weight" disabled={!canWrite} onPress={() => nav('17')} />}>
    {retry}<Text style={styles.metric}>{amount(pet.weight_kg, ' kg')}</Text><Caption>Actual recorded weight · no invented healthy range</Caption><ReadState resource={trend} /><Bars items={trend.data?.items ?? []} unit="weight (kg)" /><Row title="Latest entry" subtitle={trend.data?.items?.filter((row: Data) => row.value != null).slice(-1)[0]?.local_date ?? 'No recorded entry in this range'} onPress={() => navigation.navigate('Care', { type: 'weight' })} /><Body>Weight is one part of the picture. 不能据此自动推断健康或营养处方。</Body>{!canWrite && <Notice text="只读成员可以查看；称重写入需主人或照护成员。" />}
  </Page>;
}
function BodyEditor(props: FlowProps & { value: Data | null; read: any; canWrite: boolean; date: string; zone: string }) {
  const { api, pet } = useApp(), { value, read, canWrite, date, zone, navigation } = props;
  const state = useServerDraft(value, bodyForm, bodyVersion), key = useWriteKey(), alive = useAlive();
  const [receipt, setReceipt] = useState<Data | null>(null), [readError, setReadError] = useState('');
  const form = state.draft?.form ?? {};
  const editable = canWrite && !!state.draft && !state.busy && !receipt;
  async function rereadSaved() {
    try { const saved = await api.get(`/pets/${pet!.id}/body-check-ins${query({ date, timezone: zone })}`); if (!alive.current) return; state.adopt(saved); setReadError(''); go(navigation, '15b', { date, savedVersion: saved.version }); }
    catch (error) { if (alive.current) setReadError(error instanceof Error ? error.message : 'Saved, but reread failed'); }
  }
  return <Page {...props} title="Log manually" subtitle={`${date} / Owner observations`} footer={receipt ? <Button title="Reread saved observations" run={rereadSaved} /> : <><Button title="Save observations" disabled={!canWrite || !state.draft || state.busy || state.stale} run={() => state.run(async () => {
    const base = state.draft!.base, input = { expected_version: base.version, values: Object.fromEntries(observations.map(([name]) => [name, String(form[name] ?? '').trim() || null])), notes: form.notes ?? '', toileting_record_id: form.toileting_record_id || null, ...(form.observed_at ? { observed_at: instant(form.observed_at) } : {}) };
    const saved = await api.put(`/pets/${pet!.id}/body-check-ins${query({ date: base.local_date, timezone: base.timezone })}`, input, key.for(input)); if (!alive.current) return; setReceipt(saved); key.clear(); await rereadSaved();
  })} /><Button secondary title="Cancel" disabled={state.busy} onPress={() => navigation.goBack()} /></>}>
    <ReadState resource={read} />{observations.map(([name, label]) => <Field key={name} label={label} value={String(form[name] ?? '')} placeholder="Not supplied" multiline editable={editable} onChangeText={text => state.edit({ [name]: text })} />)}
    <Field label="Observation time" value={form.observed_at ?? ''} editable={editable} onChangeText={text => state.edit({ observed_at: text })} /><Caption>实际ISO时间保留时区；空观察保持未知，不生成分数。</Caption>
    {state.stale && <Notice tone="warning" text="服务端版本已变化，草稿保留；请明确重读后再保存。" />}{!receipt && <Button secondary title="Reread observations · discard draft" disabled={state.busy} run={async () => { state.adopt(await api.get(`/pets/${pet!.id}/body-check-ins${query({ date, timezone: zone })}`)); key.clear(); }} />}
    {receipt && <Notice text={readError ? `已保存版本${receipt.version}，读取失败：${readError}。只重试读取。` : '已确认写入，正在核对服务端版本…'} />}{!canWrite && <Notice text="Read-only household role. 原文可查看，不能提交。" />}
  </Page>;
}
function WeightEditor(props: FlowProps & { canWrite: boolean }) {
  const { api, pet, refreshIdentity } = useApp(), { navigation, canWrite } = props;
  const [weight, setWeight] = useState(''), [at, setAt] = useState(() => new Date().toISOString()), [notes, setNotes] = useState(''), [receipt, setReceipt] = useState<Data | null>(null), [busy, setBusy] = useState(false), [readError, setReadError] = useState('');
  const key = useWriteKey(), alive = useAlive();
  async function reread(row: Data) { try { const detail = await api.get(`/care-records/${row.id}`); if (detail.pet_id !== pet!.id || detail.type !== 'weight' || detail.withdrawn_at) throw new Error('记录所属宠物不匹配或体重已撤回'); await refreshIdentity(); if (alive.current) { setReadError(''); go(navigation, '16'); } } catch (error) { if (alive.current) setReadError(error instanceof Error ? error.message : 'Read failed'); } }
  return <Page {...props} title="A little weigh-in." subtitle={`LOG WEIGHT / ${pet!.name}`} footer={receipt ? <Button title="Reread saved weight" run={() => reread(receipt)} /> : <Button title="Save weight" disabled={!canWrite || busy} run={async () => {
    const value = finite(weight, '体重'); if (value === null || value <= 0 || value > 300) throw new Error('体重须为0到300kg之间的有效值');
    const input = { pet_id: pet!.id, type: 'weight', value: { weight: value, unit: 'kg' }, recorded_at: instant(at), notes, source: 'owner' }; setBusy(true);
    try { const saved = await api.post('/care-records', input, key.for(input)); if (!alive.current) return; setReceipt(saved); key.clear(); await reread(saved); } finally { if (alive.current) setBusy(false); }
  }} />}>
    <Card tone="sage"><Caption>WEIGHT IN KILOGRAMS</Caption><TextInput accessibilityLabel="Weight in kg" value={weight} placeholder="—" placeholderTextColor={palette.inkMuted} keyboardType="decimal-pad" editable={canWrite && !busy && !receipt} onChangeText={setWeight} style={{ fontSize: 60, lineHeight: 72, height: 80, color: palette.forest, fontWeight: '700', padding: 0 }} /><Caption>kg · user-provided</Caption></Card><Field label="Date and time" value={at} onChangeText={setAt} editable={canWrite && !busy && !receipt} /><Field label="Note" value={notes} onChangeText={setNotes} editable={canWrite && !busy && !receipt} multiline /><Caption>写入当前服务的照护记录；返回后读取实际持久结果。</Caption>{receipt && <Notice text={readError ? `已保存，读取暂失败：${readError}。不要再次提交。` : '已确认保存，正在重新读取…'} />}{!canWrite && <Notice text="Read-only role. Weight records cannot be changed." />}
  </Page>;
}
const s = StyleSheet.create({ dark: { backgroundColor: palette.forest, borderRadius: 20, padding: 20, gap: 12 }, lime: { color: palette.citron, fontSize: 12 }, light: { color: palette.white, fontSize: 16, lineHeight: 22 }, big: { color: palette.white, fontWeight: '700', fontSize: 44, lineHeight: 52 }, pills: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } });
