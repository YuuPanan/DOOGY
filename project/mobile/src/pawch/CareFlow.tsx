import { useState } from 'react';
import { Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useWriteKey } from '../screens/CareScreens';
import { Body, Button, Caption, Card, Field, go, Heading, Notice, Page, palette, Row, styles } from './ui';
import { amount, Data, FlowProps, ReadState, useAlive, useRead } from './data';

export function PawchCareScreen(props: FlowProps) {
  const { api, user, pet, households } = useApp(), role = households.find(row => row.id === pet?.household_id)?.role;
  return pet ? <CareBody key={`${api.baseUrl}:${user?.id}:${pet.id}:${role}:${props.screenId}:${props.route?.params?.observationId ?? ''}`} {...props} /> : <Page {...props} title="Care starts with context."><Notice text="先选择宠物，观察、已阅和照护分别按身份授权。" /><Button title="Meet your dog" onPress={() => go(props.navigation, '03')} /></Page>;
}
function CareBody(props: FlowProps) {
  const { screenId: id, navigation } = props, params = props.route?.params ?? props.params ?? {};
  const { api, pet: chosen, households } = useApp(), pet = chosen!;
  const writable = households.some(row => row.id === pet.household_id && ['owner', 'caregiver'].includes(row.role)), alive = useAlive(), key = useWriteKey();
  const history = useRead(() => api.get(`/pets/${pet.id}/health-observations?limit=10&read_status=all`), [api, pet.id], navigation);
  const observationId = params.observationId ?? history.data?.items?.[0]?.id;
  const detail = useRead(async () => { if (!observationId) return null; const row = await api.get(`/health-observations/${encodeURIComponent(observationId)}`); if (row.pet_id !== pet.id) throw new Error('观察不属于当前宠物'); return row; }, [api, pet.id, observationId], navigation);
  const guide = useRead(() => api.get('/content?kind=guidance&category=health&limit=20'), [api], navigation);
  const [ack, setAck] = useState(false), [showJournal, setShowJournal] = useState(false), [note, setNote] = useState(''), [at, setAt] = useState(() => new Date().toISOString()), [receipt, setReceipt] = useState<Data | null>(null), [saved, setSaved] = useState<Data | null>(null), [busy, setBusy] = useState(false), [readError, setReadError] = useState('');
  const assessment = detail.data?.assessment, findings = assessment?.observations ?? [];
  const finding = findings.find((row: Data) => row.evidence_ids?.includes(params.evidenceId)) ?? findings[0];
  const evidence = finding ? assessment?.evidence?.find((row: Data) => finding.evidence_ids?.includes(row.id)) : assessment?.evidence?.[0];
  const nav = (target: string, values: Data = {}) => go(navigation, target, values);
  const viewGuidance = (row: Data) => nav('49', { contentId: row.id, contentVersion: row.content_version });
  const context = <Caption>活动观察不是诊断；原型中的静息心率、120bpm和风险阈值没有接入。没有提醒也不等于健康正常。</Caption>;
  async function rereadNote(row: Data) { setSaved(null); setReadError(''); try { const result = await api.get(`/care-records/${row.id}`); if (result.pet_id !== pet.id || result.type !== 'note' || result.withdrawn_at) throw new Error('照护记录不属于当前宠物或已撤回'); if (alive.current) { setSaved(result); setReadError(''); } } catch (error) { if (alive.current) { setSaved(null); setReadError(error instanceof Error ? error.message : 'Read failed'); } } }
  if (id === '24') return <Page {...props} title="Worth a closer look." subtitle="HEALTH WARNINGS / Recorded observations" footer={<Button title="View observation details" disabled={!observationId} onPress={() => nav('25', { observationId })} />}>
    <ReadState resource={history} /><Card tone="alert"><Heading>Evidence, before a conclusion.</Heading><Body>{history.data?.items?.length ? `${history.data.items.length} saved day assessment(s) in this page.` : 'No saved assessments have been read in this range.'}</Body><Caption>不是疾病预警数量；完整日活动评估可能无发现或输入不足。</Caption></Card>
    {history.data?.items?.map((row: Data) => <Row key={row.id} tone={row.finding_count > 0 ? 'alert' : 'white'} title={`${row.local_date} · ${row.finding_count} observations`} subtitle={`${row.timezone} · ${row.read_at ? 'Read by you' : 'Unread by you'}${row.superseded ? ' · older version' : ''}`} onPress={() => nav('25', { observationId: row.id })} />)}
    <Card tone="sage"><Heading>One reading is not a diagnosis.</Heading><Body>Read the available source, coverage and context. 不把原型医疗示例当作已实现能力。</Body></Card><Row title="Your care checklist" subtitle="Notes and published guidance" onPress={() => nav('26')} />{context}<Button secondary title="Full observation history and filters" onPress={() => navigation.navigate('Health')} />
  </Page>;
  if (id === '25') return <Page {...props} title="One observation, in context." titleStyle={{ fontSize: 24, lineHeight: 32 }} subtitle={`SAVED EVIDENCE / ${detail.data?.local_date ?? 'Not selected'}`} footer={<><Button title="Open care steps" onPress={() => nav('26', { observationId })} /><Button secondary title="When to reach out" onPress={() => nav('27')} /></>}>
    <ReadState resource={history} /><ReadState resource={detail} /><Card tone="alert"><Text style={styles.metric}>{amount(evidence?.observed)}</Text><Heading>{evidence?.metric ?? 'No selected metric'}</Heading><Caption>Baseline: {amount(evidence?.baseline_median)} · Coverage: {typeof evidence?.coverage_fraction === 'number' ? `${Math.round(evidence.coverage_fraction * 100)}%` : 'Unknown'}</Caption></Card>
    <Card tone="sage"><Heading>Start with {pet.name}, not a number.</Heading>{finding ? <Body>{finding.text}</Body> : <Body>{detail.data ? '本版本没有可报告的变化发现；请结合不足原因与来源。' : '尚无可读取的已保存观察。'}</Body>}</Card>{findings.length > 1 && findings.filter((row: Data) => row !== finding).map((row: Data, index: number) => <Row key={row.evidence_ids?.[0] ?? index} title={`Review ${row.metric} observation`} subtitle="Read this finding with its own evidence" onPress={() => nav('25', { observationId, evidenceId: row.evidence_ids?.[0] })} />)}{context}
    {detail.data && <><Caption>{detail.data.generated_at} · {detail.data.timezone} · {detail.data.superseded ? 'Historical version' : 'Latest saved version'}</Caption><Button secondary title={detail.data.read_at || ack ? 'Reread acknowledgement' : 'Mark as read by me'} run={async () => { if (!ack && !detail.data.read_at) { await api.patch(`/health-observations/${detail.data.id}/read`, {}, key.for({ id: detail.data.id })); if (!alive.current) return; setAck(true); key.clear(); } await detail.refresh(); }} /><Caption>本人已阅不关闭风险，也不代表诊断或风险解除。</Caption></>}
  </Page>;
  if (id === '26') return <Page {...props} title="A calmer next step." subtitle={`CARE / Support for ${pet.name}`} footer={<><Button title="Read vet guidance" onPress={() => nav('27')} /><Button secondary title="Back to today" onPress={() => navigation.popTo ? navigation.popTo('Main', { screen: 'HomeTab' }) : navigation.navigate('Main', { screen: 'HomeTab' })} /></>}>
    <ReadState resource={guide} /><Row title="01 Review the evidence" subtitle="Read source, time and coverage" onPress={() => nav('25', { observationId })} /><Row title="02 Check the collar source" subtitle="View binding and reporting status" onPress={() => nav('08')} /><Row title={`03 Observe ${pet.name}`} subtitle="Keep owner observations separate" onPress={() => nav('15')} /><Row title="04 Note what changed" subtitle="Save what you actually observed" onPress={() => setShowJournal(true)} />
    {guide.data?.items?.map((row: Data) => <Row key={row.id} title={row.title} subtitle={`Published guidance · version ${row.content_version}`} onPress={() => viewGuidance(row)} />)}{!guide.loading && !guide.error && !guide.data?.items?.length && <Notice text="尚无已发布的护理说明。原型步骤不是自动生成的医疗方案。" />}
    <Card tone="alert"><Heading>Keep context close.</Heading><Body>本页记录原文和内容来源，不新增自动诊断、阈值或就医承诺。</Body></Card>
    {!showJournal && <Button title={writable ? 'Log a care note' : 'View care journal'} onPress={() => setShowJournal(true)} />}
    {showJournal && <Card title="Your care journal"><Field label="Care note" value={note} multiline editable={writable && !busy && !receipt} onChangeText={setNote} /><Field label="Recorded at" value={at} editable={writable && !busy && !receipt} onChangeText={setAt} />
      {!receipt ? <Button title="Save care note" disabled={!writable || busy || !note.trim()} run={async () => {
        if (!/(Z|[+-]\d{2}:\d{2})$/i.test(at) || !Number.isFinite(Date.parse(at))) throw new Error('请填写含时区的实际记录时间');
        const input = { pet_id: pet.id, type: 'note', source: 'owner', value: { text: note }, notes: '', recorded_at: new Date(at).toISOString() }; setBusy(true);
        try { const row = await api.post('/care-records', input, key.for(input)); if (!alive.current) return; setReceipt(row); key.clear(); await rereadNote(row); } finally { if (alive.current) setBusy(false); }
      }} /> : <><Notice text={saved ? 'Saved and reread from the server.' : `已确认写入；读取尚未成功${readError ? `：${readError}` : '，正在读取…'}。只重试读。`} /><Button secondary title="Reread saved care note" run={() => rereadNote(receipt)} />{saved && <><Body>{saved.value?.text}</Body><Caption>{saved.recorded_at}</Caption><Button title="Return to pet profile" onPress={() => nav('07')} /></>}</>}
      {!writable && <Notice text="只读角色可查看历史，不能提交照护记录。" />}<Button secondary title="All care records and revisions" onPress={() => navigation.navigate('Care')} /></Card>}
  </Page>;
  return <Page {...props} title="Know when to reach out." titleStyle={{ fontSize: 26, lineHeight: 32 }} subtitle="VET GUIDANCE / Not a diagnosis" footer={<Button title="Back to care checklist" onPress={() => nav('26')} />}>
    <ReadState resource={guide} /><Card tone="alert"><Heading>Reviewed guidance</Heading><Body>就医说明只展示当前服务中可读取的已发布内容，不把原型阈值和症状示例冒充正式分诊。</Body></Card><Card tone="sage"><Heading>Your usual support</Heading><Body>查看你保存的联系人；打开资料不代表已拨号、派遣或发送。</Body><Button secondary title="Open contact details" onPress={() => navigation.navigate('Contacts')} /></Card>
    {guide.data?.items?.length ? guide.data.items.map((row: Data) => <Row key={row.id} title={row.title} subtitle={`Published · version ${row.content_version}`} onPress={() => viewGuidance(row)} />) : <Notice text="No published guidance available. 请使用你自己的专业照护渠道，App不作诊断。" />}{context}<Button secondary title="Help and support" onPress={() => navigation.navigate('Support')} />
  </Page>;
}
