import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Choose, Facts, Field, Heading, Notice, Page } from '../ui';

type AppScreenProps = { navigation: any; route: any };
type Row = Record<string, any>;
const careTypes = [
  { label: '体重', value: 'weight' }, { label: '喂食', value: 'feeding' }, { label: '用药', value: 'medication' },
  { label: '清洁护理', value: 'grooming' }, { label: '日常笔记', value: 'note' }, { label: '排泄', value: 'toileting' }, { label: '自定义', value: 'custom' },
];
const units = ['g', 'kg', 'ml', 'portion'].map(value => ({ label: value === 'portion' ? '份' : value, value }));
const typeName = (type: string) => careTypes.find(item => item.value === type)?.label ?? type;
const query = (values: Row) => '?' + Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
const text = (value: unknown) => value == null ? '' : String(value);
const zoneFor = (pet: Row) => pet.effective_timezone ?? pet.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
function dayAt(zone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
}
const shiftDay = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
function number(value: string, label: string, nullable = false): number | null {
  if (!value.trim()) { if (nullable) return null; throw new Error(`请填写${label}`); }
  const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${label}必须为有效数字`); return parsed;
}
function instant(value: string) {
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('时间请填写含时区的ISO时间，例如2026-11-24T12:00:00+08:00');
  return new Date(value).toISOString();
}
function useWriteKey() {
  const saved = useRef<{ body: string; key: string } | null>(null);
  return { for: (body: unknown) => {
    const encoded = JSON.stringify(body);
    if (saved.current?.body !== encoded) saved.current = { body: encoded, key: `mobile-care-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    return saved.current!.key;
  }, clear: () => { saved.current = null; } };
}
function ResourceState({ resource }: { resource: { loading: boolean; error: any } }) {
  return <>{resource.loading && <Notice text="正在读取…" />}{resource.error && <Notice text={String(resource.error.message ?? resource.error)} tone="error" />}</>;
}
function MissingPet({ navigation }: AppScreenProps) {
  return <Page><Heading>先选择宠物</Heading><Notice text="请选择已有宠物或先建立档案，照护记录不要求绑定项圈。" /><Button title="宠物档案" onPress={() => navigation.navigate('Pet')} /></Page>;
}
function recordSummary(record: Row) {
  const value = record.value ?? {};
  if (record.type === 'weight') return `${value.weight ?? value.weight_kg ?? '未知'} ${value.unit ?? 'kg'}`;
  if (record.type === 'feeding') return `${value.food_name ?? value.food ?? '未命名食物'} · ${value.amount ?? value.amount_g ?? '未知'} ${value.unit ?? (value.amount_g != null ? 'g' : '')}`;
  if (record.type === 'medication') return `${value.name ?? ''} ${value.dose ?? ''}`;
  if (record.type === 'grooming') return value.activity ?? '护理记录';
  if (record.type === 'toileting') return ({ urination: '排尿', defecation: '排便', both: '排尿与排便' } as Row)[value.kind] ?? '排泄记录';
  return value.text ?? record.custom_type ?? '已记录';
}

function CareForm({ record, initialType = 'note', pet, onSaved, onCancel }: { record?: Row; initialType?: string; pet: Row; onSaved: (row: Row) => void; onCancel: () => void }) {
  const { api } = useApp(), key = useWriteKey(), old = record?.value ?? {};
  const [type, setType] = useState(record?.type ?? initialType);
  const [form, setForm] = useState<Row>({ recorded_at: record?.recorded_at ?? new Date().toISOString(), notes: record?.notes ?? '',
    source: record?.source ?? 'owner', custom_type: record?.custom_type ?? '', weight: text(old.weight ?? old.weight_kg), weight_unit: old.unit === 'lb' ? 'lb' : 'kg',
    feeding_mode: !record || old.schema_version === 'feeding-v1' ? 'structured' : 'legacy', food: old.food_name ?? old.food ?? '',
    category: old.category ?? '', amount: text(old.amount ?? old.amount_g), unit: old.unit ?? 'g', meal_type: old.meal_type ?? 'meal',
    kcal: text(old.label_energy?.kcal), per_amount: text(old.label_energy?.per_amount), label_unit: old.label_energy?.unit ?? old.unit ?? 'g',
    energy_source: old.label_energy?.source ?? '', name: old.name ?? '', dose: old.dose ?? '', activity: old.activity ?? '', kind: old.kind ?? 'urination', text: old.text ?? '' });
  const set = (name: string, value: string) => setForm(current => ({ ...current, [name]: value }));
  const input = (label: string, name: string, multiline = false, numeric = false) => <Field label={label} value={form[name]} onChangeText={(value: string) => set(name, value)} multiline={multiline} keyboardType={numeric ? 'decimal-pad' : 'default'} />;
  async function save() {
    let value: Row = { ...old };
    if (type === 'weight') { delete value.weight_kg; value = { ...value, weight: number(form.weight, '体重'), unit: form.weight_unit }; }
    else if (type === 'feeding' && form.feeding_mode === 'structured') {
      const withEnergy = [form.kcal, form.per_amount, form.energy_source].some(item => item.trim());
      if (withEnergy && !form.energy_source.trim()) throw new Error('请填写标签能量来源；没有标签可全部留空');
      value = { schema_version: 'feeding-v1', food_name: form.food.trim(), category: form.category.trim(), amount: number(form.amount, '食物数量'),
        unit: form.unit, meal_type: form.meal_type, label_energy: withEnergy ? { kcal: number(form.kcal, '标签kcal'), per_amount: number(form.per_amount, '标签基准数量'), unit: form.label_unit, source: form.energy_source.trim() } : null };
    } else if (type === 'feeding') value = { ...value, ...(form.food.trim() ? { [Object.hasOwn(old, 'food_name') ? 'food_name' : 'food']: form.food.trim() } : {}), ...(form.amount.trim() ? { [Object.hasOwn(old, 'amount') ? 'amount' : 'amount_g']: number(form.amount, '喂食量') } : {}) };
    else if (type === 'medication') value = { ...value, name: form.name.trim(), dose: form.dose.trim() };
    else if (type === 'grooming') value = { ...value, activity: form.activity.trim() };
    else if (type === 'toileting') value = { ...value, kind: form.kind, text: form.text };
    else value = { ...value, text: form.text };
    const body = { value, recorded_at: instant(form.recorded_at), notes: form.notes, ...(type === 'custom' ? { custom_type: form.custom_type.trim() } : {}) };
    const result = record ? await api.patch(`/care-records/${record.id}`, body, key.for(body))
      : await api.post('/care-records', { ...body, pet_id: pet.id, type, source: form.source }, key.for({ ...body, type, source: form.source, pet_id: pet.id }));
    key.clear(); onSaved(result);
  }
  return <Card><Heading>{record ? `编辑${typeName(type)}` : '新增照护记录'}</Heading>
    {!record && <Choose value={type} options={careTypes} onChange={setType} />}
    {type === 'weight' && <>{input('原始体重', 'weight', false, true)}<Choose value={form.weight_unit} options={[{ label: 'kg', value: 'kg' }, { label: 'lb', value: 'lb' }]} onChange={(v: string) => set('weight_unit', v)} /></>}
    {type === 'feeding' && <>{record && form.feeding_mode === 'legacy' && <Notice text="旧喂食记录保留原有字段，不推断能量。新增记录使用标签能量合同。" />}
      {input('食物名称', 'food')}{input(form.feeding_mode === 'legacy' ? `喂食量（${old.unit ?? (old.amount_g != null ? 'g' : '原记录单位未提供')}）` : '数量', 'amount', false, true)}
      {form.feeding_mode === 'structured' && <>{input('食物类别（按实际记录）', 'category')}<Choose value={form.unit} options={units} onChange={(v: string) => set('unit', v)} />
        <Choose value={form.meal_type} options={[{ label: '正餐', value: 'meal' }, { label: '零食', value: 'snack' }]} onChange={(v: string) => set('meal_type', v)} />
        <Notice text="以下标签资料可全部留空，能量将保持未知；不换算ml与g或份。" />
        {input('标签能量（kcal）', 'kcal', false, true)}{input('每多少数量', 'per_amount', false, true)}
        <Choose value={form.label_unit} options={units} onChange={(v: string) => set('label_unit', v)} />{input('标签来源', 'energy_source')}
      </>}
    </>}
    {type === 'medication' && <>{input('实际使用的药品名称', 'name')}{input('实际记录的用量', 'dose')}<Notice text="只记录已经发生的用药，不生成剂量建议。" /></>}
    {type === 'grooming' && input('护理内容', 'activity', true)}
    {type === 'toileting' && <Choose value={form.kind} options={[{ label: '排尿', value: 'urination' }, { label: '排便', value: 'defecation' }, { label: '两者', value: 'both' }]} onChange={(v: string) => set('kind', v)} />}
    {type === 'custom' && input('自定义照护名称', 'custom_type')}
    {['note', 'custom', 'toileting'].includes(type) && input('原始记录', 'text', true)}
    {input('记录时间（ISO，包含Z或时区偏移）', 'recorded_at')}{input('备注', 'notes', true)}
    {!record && <Choose value={form.source} options={[{ label: '主人记录', value: 'owner' }, { label: '兽医来源记录', value: 'vet' }]} onChange={(v: string) => set('source', v)} />}
    <Action title="保存记录" run={save} /><Button title="取消编辑" onPress={onCancel} variant="secondary" />
  </Card>;
}

export function CareScreen(props: AppScreenProps) {
  const { pet } = useApp(); return pet ? <PetCare key={pet.id} {...props} /> : <MissingPet {...props} />;
}
function PetCare({ navigation, route }: AppScreenProps) {
  const { api, pet: selectedPet, household, user } = useApp(), pet = selectedPet!, canWrite = ['owner', 'caregiver'].includes(household?.role ?? ''), key = useWriteKey();
  const [type, setType] = useState(''), [status, setStatus] = useState('active'), [cursor, setCursor] = useState('');
  const [id, setId] = useState(''), [creating, setCreating] = useState(false), [editing, setEditing] = useState(false), [reason, setReason] = useState('');
  const [createType, setCreateType] = useState('note');
  useEffect(() => {
    const requested = route.params?.createType;
    if (canWrite && careTypes.some(item => item.value === requested)) {
      setCreateType(requested); setType(requested); setCreating(true); setEditing(false); setId(''); setCursor('');
      navigation.setParams({ createType: undefined });
    }
  }, [route.params?.createType, canWrite]);
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [range, setRange] = useState({ from: '', to: '' });
  const list = useResource(() => api.get(`/pets/${pet.id}/care-records${query({ type, status, ...range, limit: 20, cursor })}`), [api, pet.id, type, status, range, cursor]);
  const detail = useResource(() => id ? api.get(`/care-records/${id}`) : Promise.resolve(null), [api, pet.id, id]);
  const history = useResource(() => id ? api.get(`/care-records/${id}/history`) : Promise.resolve(null), [api, pet.id, id]);
  const [showHistory, setShowHistory] = useState(false);
  const [showRawRecord, setShowRawRecord] = useState(false);
  useEffect(() => { setShowRawRecord(false); }, [id]);
  const record = detail.data?.id === id ? detail.data : null;
  const refresh = () => { list.refresh(); detail.refresh(); history.refresh(); };
  function saved(row: Row) { setCreating(false); setEditing(false); setId(row.id); refresh(); }
  async function upload() {
    const picked = await DocumentPicker.getDocumentAsync({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], copyToCacheDirectory: true, multiple: false });
    if (picked.canceled) return;
    const file = picked.assets[0];
    if (file.size != null && file.size > 5 * 1024 * 1024) throw new Error('单个附件最多5MiB');
    const mimeType = file.mimeType ?? ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' } as Row)[file.name.split('.').pop()?.toLowerCase() ?? ''];
    if (!mimeType) throw new Error('请选择JPEG、PNG、WebP或PDF');
    const fileInput = { uri: file.uri, name: file.name, mimeType };
    await api.upload(`/care-records/${id}/attachments`, fileInput, key.for({ id, ...fileInput })); key.clear(); refresh();
  }
  return <Page><Heading>{pet.name} · 照护</Heading><Button title="目标、身体观察与趋势" onPress={() => navigation.navigate('Wellness')} />
    <Notice text={canWrite ? '记录实际发生的照护。编辑保留修订；撤回不会删除原文或附件。' : '当前为只读查看，写入需要家庭主人或照护者权限。'} />
    {canWrite && !creating && <Button title="新增记录" onPress={() => { setCreateType('note'); setCreating(true); setId(''); }} />}
    {canWrite && creating && <CareForm key={`create:${createType}`} initialType={createType} pet={pet} onSaved={saved} onCancel={() => setCreating(false)} />}
    <Card><Heading>照护历史</Heading><Choose value={type} options={[{ label: '全部类型', value: '' }, ...careTypes]} onChange={(v: string) => { setType(v); setCursor(''); }} />
      <Choose value={status} options={[{ label: '有效', value: 'active' }, { label: '已撤回', value: 'withdrawn' }, { label: '全部', value: 'all' }]} onChange={(v: string) => { setStatus(v); setCursor(''); }} />
      <Field label="起点（可留空，ISO含时区）" value={from} onChangeText={setFrom} /><Field label="终点（不含，可留空）" value={to} onChangeText={setTo} />
      <Action title="应用时间筛选" run={async () => { setRange({ from: from ? instant(from) : '', to: to ? instant(to) : '' }); setCursor(''); }} />
      <ResourceState resource={list} />{list.data?.items?.length === 0 && <Notice text="此范围没有照护记录。" />}
      {list.data?.items?.map((item: Row) => <Card key={item.id}><Text>{typeName(item.type)} · {recordSummary(item)}</Text><Text>{item.recorded_at}{item.withdrawn_at ? ' · 已撤回' : ''}</Text>
        <Button title="详情与修订" onPress={() => { setId(item.id); setCreating(false); setEditing(false); setShowHistory(false); setReason(''); }} variant="secondary" /></Card>)}
      <Button title="刷新列表" onPress={list.refresh} variant="secondary" />{list.data?.next_cursor && <Button title="下一页" onPress={() => setCursor(list.data.next_cursor)} />}
      {!!cursor && <Button title="返回第一页" onPress={() => setCursor('')} variant="secondary" />}
    </Card>
    {!!id && <Card><Heading>记录详情</Heading><ResourceState resource={detail} />{record && <><Heading>{typeName(record.type)}</Heading><Text>{recordSummary(record)}</Text>
      <Facts value={{ 记录时间: record.recorded_at, 来源: record.source, 备注: record.notes || '未填写', 当前状态: record.withdrawn_at ? '已撤回' : '有效', ...(record.withdrawn_at ? { 撤回时间: record.withdrawn_at, 撤回理由: record.withdrawal_reason } : {}) }} />
      <Button title="返回今天查看汇总" onPress={() => navigation.popTo('Main', { screen: 'HomeTab' })} />
      <Button title={showRawRecord ? '收起完整记录信息' : '查看完整记录信息'} variant="secondary" onPress={() => setShowRawRecord(!showRawRecord)} />{showRawRecord && <Facts value={record} />}
      <Button title="重新读取当前记录" onPress={refresh} variant="secondary" />
      {canWrite && !record.withdrawn_at && !editing && <Button title="编辑这条记录" onPress={() => setEditing(true)} />}
      {canWrite && editing && !record.withdrawn_at && <CareForm key={`${record.id}:${record.updated_at}`} record={record} pet={pet} onSaved={saved} onCancel={() => setEditing(false)} />}
      <Button title={showHistory ? '收起修订历史' : '查看修订历史'} onPress={() => setShowHistory(!showHistory)} variant="secondary" />
      {showHistory && <><ResourceState resource={history} /><Facts value={history.data?.current?.id === id ? history.data : null} /></>}
      <Heading>附件</Heading><Notice text="JPEG、PNG、WebP或PDF，单个最多5MiB，每条最多10个。现有服务不支持单独删除附件；撤回后仍可下载。" />
      {record.attachments?.length === 0 && <Text>尚无附件</Text>}
      {record.attachments?.map((file: Row) => <Card key={file.id}><Text>{file.filename} · {file.size_bytes} 字节</Text>
        <Action title="下载原文件" run={() => api.download(`/care-attachments/${file.id}/content`, file.filename)} success="已打开系统分享入口；请在系统中确认后续操作。" /></Card>)}
      {canWrite && !record.withdrawn_at && <Action title="选择并上传附件" run={upload} />}
      <Button title="共享资料删除与数据管理" onPress={() => navigation.navigate('Privacy')} variant="secondary" />
      {canWrite && !record.withdrawn_at && (household?.role === 'owner' || record.created_by === user?.id) && <>
        <Field label="撤回理由（撤回将停止计入汇总）" value={reason} onChangeText={setReason} multiline />
        <Action title="确认撤回这条记录" run={async () => {
          if (!reason.trim()) throw new Error('请填写撤回理由'); const body = { reason: reason.trim() };
          await api.post(`/care-records/${id}/withdraw`, body, key.for({ id, ...body })); key.clear(); setEditing(false); refresh();
        }} success="已撤回，原文与附件保留。" />
      </>}
    </>}</Card>}
  </Page>;
}

export function WellnessScreen(props: AppScreenProps) {
  const { pet } = useApp(); return pet ? <PetWellness key={pet.id} {...props} /> : <MissingPet {...props} />;
}
function PetWellness({ navigation, route }: AppScreenProps) {
  const { api, pet: selectedPet, household } = useApp(), pet = selectedPet!, canWrite = ['owner', 'caregiver'].includes(household?.role ?? '');
  const [zone, setZone] = useState(zoneFor(pet)), [date, setDate] = useState(dayAt(zoneFor(pet)));
  const [period, setPeriod] = useState({ date, timezone: zone });
  const [section, setSection] = useState('activity');
  const [planDraft, setPlanDraft] = useState<Row | null>(null), lastPlan = useRef('');
  useEffect(() => {
    if (['activity', 'body', 'goals', 'nutrition', 'trends'].includes(route.params?.section)) {
      setSection(route.params.section); navigation.setParams({ section: undefined });
    }
  }, [route.params?.section]);
  useEffect(() => {
    const plan = route.params?.plan, signature = plan && `${plan.id}@${plan.content_version}`;
    if (canWrite && plan?.id && plan?.content_version != null && signature !== lastPlan.current) {
      lastPlan.current = signature; setPlanDraft(plan); setSection('goals'); navigation.setParams({ plan: undefined });
    }
  }, [route.params?.plan, canWrite]);
  const current = useResource(() => api.get(`/pets/${pet.id}/observations/current${query({ timezone: period.timezone })}`), [api, pet.id, period.timezone]);
  const resource = useResource(async () => {
    const qs = query(period), daily = await api.get(`/pets/${pet.id}/activity/daily${qs}`);
    const [goals, body, nutrition, toileting, weekly] = await Promise.all([
      api.get(`/pets/${pet.id}/goals${qs}`), api.get(`/pets/${pet.id}/body-check-ins${qs}`), api.get(`/pets/${pet.id}/nutrition/daily${qs}`),
      api.get(`/pets/${pet.id}/care-records${query({ type: 'toileting', from: daily.period_start, to: daily.period_end, limit: 100 })}`),
      api.get(`/pets/${pet.id}/activity/weekly${qs}`),
    ]); return { daily, weekly, goals, body, nutrition, toileting };
  }, [api, pet.id, period]);
  useEffect(() => navigation.addListener('focus', () => { void resource.refresh(); void current.refresh(); }), [navigation, resource.refresh, current.refresh]);
  const data = resource.data?.daily.local_date === period.date && resource.data?.daily.timezone === period.timezone ? resource.data : null;
  return <Page><Heading>{pet.name} · 健康概览</Heading>
    <Choose value={section} options={[{ label: '活动', value: 'activity' }, { label: '身体观察', value: 'body' }, { label: '目标与计划', value: 'goals' }, { label: '营养', value: 'nutrition' }, { label: '趋势', value: 'trends' }]} onChange={setSection} />
    <Field label="当地日期（YYYY-MM-DD）" value={date} onChangeText={setDate} /><Field label="IANA时区" value={zone} onChangeText={setZone} />
    <Button title="读取所选日期" onPress={() => setPeriod({ date: date.trim(), timezone: zone.trim() })} />
    <ResourceState resource={resource} /><Notice text="没有记录或测量的数据保持未知；这里不生成状态分、饮食处方或健康结论。" />
    {section === 'activity' && <Card><Heading>今日同进度比较</Heading><Notice text={`按${period.timezone}的今天午夜至实际查询时刻，与历史相同经过时长比较；不随上方历史日期变化。输入不足保留原因。此结果不持久化，反馈请使用健康观察中的完整日版本。`} />
      <ResourceState resource={current} /><Facts value={current.data} /><Button title="更新今日实际比较" onPress={current.refresh} variant="secondary" />
    </Card>}
    {data && section === 'activity' && <Card><Heading>当日活动</Heading><Facts value={data.daily} /><Heading>当周活动</Heading><Facts value={data.weekly} /><Button title="设置活动目标与计划" onPress={() => setSection('goals')} /></Card>}
    <View style={{ display: section === 'goals' ? 'flex' : 'none' }}><Button title="浏览运动计划" onPress={() => navigation.navigate('Learning', { kind: 'plan', category: 'exercise' })} /><GoalEditor key={`${period.date}:${period.timezone}`} value={data?.goals ?? null} pet={pet} canWrite={canWrite} onSaved={resource.refresh} planDraft={planDraft} onPlanApplied={() => setPlanDraft(null)} /></View>
    <View style={{ display: section === 'body' ? 'flex' : 'none' }}><BodyEditor key={`body:${period.date}:${period.timezone}`} value={data?.body ?? null} toileting={data?.toileting ?? {}} pet={pet} canWrite={canWrite} onSaved={resource.refresh} /></View>
    {data && section === 'nutrition' && <Card><Heading>当日摄入</Heading><Notice text="完整性仅针对已经记录的餐食，不能证明全天实际摄入完整；未知kcal不会当作0。" /><Facts value={data.nutrition} /><Button title={canWrite ? '记录一餐' : '查看餐食记录'} onPress={() => navigation.navigate('Care', canWrite ? { createType: 'feeding' } : undefined)} /><Button title="查看喂养指导" onPress={() => navigation.navigate('Learning', { kind: 'guidance', category: 'nutrition' })} /></Card>}
    {section === 'trends' && <TrendReader pet={pet} initialZone={zoneFor(pet)} />}{section === 'activity' && <IntervalReader pet={pet} initialZone={zoneFor(pet)} />}
    <Button title="健康观察历史" onPress={() => navigation.navigate('Health')} />
  </Page>;
}
function goalForm(value: Row) {
  const target = value.goals?.targets ?? {}, plan = value.goals?.plan;
  return { active_minutes: text(target.active_minutes), steps: text(target.steps), intake_kcal: text(target.intake_kcal), enabled: plan ? 'yes' : 'no',
    name: plan?.name ?? '', content_version: plan?.content_version ?? '', walk_minutes: text(plan?.walk_minutes ?? 0), play_minutes: text(plan?.play_minutes ?? 0), training_minutes: text(plan?.training_minutes ?? 0) };
}
const goalVersion = (value: Row) => JSON.stringify([value.local_date, value.timezone, value.effective_date_version, value.goals?.id, value.goals?.version]);
const bodyVersion = (value: Row) => JSON.stringify([value.local_date, value.timezone, value.id, value.version]);
const bodyForm = (value: Row) => ({ ...value.values, observed_at: value.observed_at ?? '', notes: value.notes ?? '', toileting_record_id: value.toileting_record_id ?? '' });
function useServerDraft(value: Row | null, formOf: (value: Row) => Row, versionOf: (value: Row) => string) {
  const [draft, setDraft] = useState<{ base: Row; form: Row; dirty: boolean } | null>(null);
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), lock = useRef(false);
  const adopt = (row: Row) => { setDraft({ base: row, form: formOf(row), dirty: false }); setConflict(false); };
  useEffect(() => { if (value) setDraft(current => current?.dirty ? current : { base: value, form: formOf(value), dirty: false }); }, [value]);
  const edit = (fields: Row) => { if (!lock.current) setDraft(current => current && { ...current, form: { ...current.form, ...fields }, dirty: true }); };
  async function run(work: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { await work(); } catch (error) { if ((error as { status?: number }).status === 409) setConflict(true); throw error; }
    finally { lock.current = false; setBusy(false); }
  }
  return { draft, adopt, edit, busy, run, stale: conflict || !!(value && draft?.dirty && versionOf(value) !== versionOf(draft.base)) };
}
function GoalEditor({ value, pet, canWrite, onSaved, planDraft, onPlanApplied }: { value: Row | null; pet: Row; canWrite: boolean; onSaved: () => void; planDraft: Row | null; onPlanApplied: () => void }) {
  const { api } = useApp(), key = useWriteKey(), state = useServerDraft(value, goalForm, goalVersion);
  useEffect(() => {
    if (canWrite && planDraft && state.draft && !state.busy) {
      state.edit({ enabled: 'yes', name: planDraft.title, content_version: `${planDraft.id}@${planDraft.content_version}`,
        walk_minutes: text(planDraft.walk_minutes), play_minutes: text(planDraft.play_minutes), training_minutes: text(planDraft.training_minutes) }); onPlanApplied();
    }
  }, [planDraft, !!state.draft, canWrite, state.busy]);
  if (!value || !state.draft) return null;
  const { form, base } = state.draft;
  const field = (label: string, name: string, numeric = false) => <Field label={label} value={form[name] ?? ''} editable={!state.busy} onChangeText={(v: string) => state.edit({ [name]: v })} keyboardType={numeric ? 'decimal-pad' : 'default'} />;
  return <Card><Heading>有效目标与运动计划</Heading><Facts value={value} /><Notice text={`将保存${value.local_date}生效的完整快照。空目标表示未知；计划与目标分别保存，计划不表示实际完成。`} />
    {canWrite && <>{field('活动分钟目标（可留空）', 'active_minutes', true)}{field('步数目标（可留空）', 'steps', true)}{field('摄入kcal目标（可留空）', 'intake_kcal', true)}
      {state.draft.dirty && <Notice text="当前为未保存草稿；刷新其他分项不会替换这里的输入。" />}
      {state.stale && <Notice text="服务器版本已变化，草稿保留。请先重读本分项并确认内容，再保存。" tone="warning" />}
      <Action title="重读目标（丢弃本分项草稿）" disabled={state.busy} run={() => state.run(async () => { state.adopt(await api.get(`/pets/${pet.id}/goals${query({ date: value.local_date, timezone: value.timezone })}`)); key.clear(); onSaved(); })} />
      <Choose value={form.enabled ?? 'no'} disabled={state.busy} options={[{ label: '不采用计划/清除计划', value: 'no' }, { label: '填写采用的计划', value: 'yes' }]} onChange={(v: string) => state.edit({ enabled: v })} />
      {form.enabled === 'yes' && <>{field('计划名称', 'name')}{field('所用计划的内容版本', 'content_version')}{field('散步分钟', 'walk_minutes', true)}{field('玩耍分钟', 'play_minutes', true)}{field('训练分钟', 'training_minutes', true)}
        <Notice text="采用的是你确认的计划快照，可以修改或清除；不会自动改写活动目标，保存前不会写入后端。" />
        <Text>计划合计：{['walk_minutes', 'play_minutes', 'training_minutes'].every(name => form[name]?.trim() && Number.isFinite(Number(form[name]))) ? ['walk_minutes', 'play_minutes', 'training_minutes'].reduce((sum, name) => sum + Number(form[name]), 0) : '未完整填写'} 分钟；活动目标：{form.active_minutes || '未知'} 分钟。</Text></>}
      <Action title="保存目标与计划" disabled={state.busy || state.stale} run={() => state.run(async () => {
        const body = { effective_date: base.local_date, expected_version: base.effective_date_version,
          targets: { active_minutes: number(form.active_minutes, '活动分钟', true), steps: number(form.steps, '步数', true), intake_kcal: number(form.intake_kcal, '摄入kcal', true) }, source: 'user_provided',
          plan: form.enabled === 'yes' ? { name: form.name.trim(), content_version: form.content_version.trim(), walk_minutes: number(form.walk_minutes, '散步分钟'), play_minutes: number(form.play_minutes, '玩耍分钟'), training_minutes: number(form.training_minutes, '训练分钟') } : null };
        const saved = await api.put(`/pets/${pet.id}/goals`, body, key.for(body)); state.adopt({ ...value, goals: saved, effective_date_version: saved.version }); key.clear(); onSaved();
      })} success="已保存新版本；下方有效目标将复读服务器结果。" />
    </>}
  </Card>;
}
function BodyEditor({ value, toileting, pet, canWrite, onSaved }: { value: Row | null; toileting: Row; pet: Row; canWrite: boolean; onSaved: () => void }) {
  const { api } = useApp(), key = useWriteKey(), state = useServerDraft(value, bodyForm, bodyVersion);
  if (!value || !state.draft) return null;
  const { form, base } = state.draft;
  const names = [{ key: 'appetite', label: '食欲原文' }, { key: 'energy', label: '精力原文' }, { key: 'movement', label: '活动/行动原文' }, { key: 'stool', label: '排便观察原文' }];
  const candidates = toileting.items?.filter((row: Row) => ['defecation', 'both'].includes(row.value?.kind)) ?? [];
  const options = [{ label: '不关联排便手记', value: '' }, ...candidates.map((row: Row) => ({ label: `${row.recorded_at} · ${recordSummary(row)}`, value: row.id }))];
  if (form.toileting_record_id && !options.some(item => item.value === form.toileting_record_id)) options.push({ label: `原关联（${value.toileting_record_status ?? '请核对'}）`, value: form.toileting_record_id });
  return <Card><Heading>四项身体观察</Heading><Facts value={value} /><Notice text="保存可空原文，不进行评分。每次保存完整快照；关联排便只引用已有手记。" />
    {canWrite && <>{names.map(item => <Field key={item.key} label={`${item.label}（可留空）`} value={form[item.key] ?? ''} editable={!state.busy} multiline onChangeText={(v: string) => state.edit({ [item.key]: v })} />)}
      <Field label="观察时间（含时区ISO；补历史日需填写）" value={form.observed_at ?? ''} editable={!state.busy} onChangeText={(v: string) => state.edit({ observed_at: v })} />
      <Field label="备注" value={form.notes ?? ''} multiline editable={!state.busy} onChangeText={(v: string) => state.edit({ notes: v })} />
      <Choose value={form.toileting_record_id ?? ''} disabled={state.busy} options={options} onChange={(v: string) => state.edit({ toileting_record_id: v })} />
      {toileting.next_cursor && <Notice text="这里只列出所选日最近100条排泄手记，其余记录仍可在照护历史查看。" />}
      {state.stale && <Notice text="服务器版本已变化，草稿保留。请先重读本分项并确认内容，再保存。" tone="warning" />}
      <Action title="重读身体观察（丢弃本分项草稿）" disabled={state.busy} run={() => state.run(async () => { state.adopt(await api.get(`/pets/${pet.id}/body-check-ins${query({ date: value.local_date, timezone: value.timezone })}`)); key.clear(); onSaved(); })} />
      <Action title="保存身体观察" disabled={state.busy || state.stale} run={() => state.run(async () => {
        const body = { expected_version: base.version, values: Object.fromEntries(names.map(item => [item.key, form[item.key]?.trim() || null])),
          notes: form.notes ?? '', toileting_record_id: form.toileting_record_id || null, ...(form.observed_at?.trim() ? { observed_at: instant(form.observed_at.trim()) } : {}) };
        state.adopt(await api.put(`/pets/${pet.id}/body-check-ins${query({ date: base.local_date, timezone: base.timezone })}`, body, key.for(body))); key.clear(); onSaved();
      })} success="已保存原文和修订版本。" />
    </>}
  </Card>;
}
function TrendReader({ pet, initialZone }: { pet: Row; initialZone: string }) {
  const { api } = useApp(), today = dayAt(initialZone);
  const [from, setFrom] = useState(shiftDay(today, -6)), [to, setTo] = useState(shiftDay(today, 1)), [zone, setZone] = useState(initialZone), [metric, setMetric] = useState('steps');
  const [params, setParams] = useState<Row>({ from, to, timezone: zone, metric }), [cursor, setCursor] = useState('');
  const result = useResource(() => api.get(`/pets/${pet.id}/trends${query({ ...params, limit: 10, cursor })}`), [api, pet.id, params, cursor]);
  return <Card><Heading>日趋势与比较</Heading><Field label="当地起始日（含）" value={from} onChangeText={setFrom} /><Field label="当地截止日（不含，最多31天）" value={to} onChangeText={setTo} />
    <Field label="IANA时区" value={zone} onChangeText={setZone} /><Choose value={metric} options={[{ label: '步数', value: 'steps' }, { label: '活动分钟', value: 'active_minutes' }, { label: '睡眠分钟', value: 'sleep_minutes' }, { label: '距离（米）', value: 'distance_m' }, { label: '体重（kg）', value: 'weight_kg' }]} onChange={setMetric} />
    <Button title="读取趋势" onPress={() => { setParams({ from, to, timezone: zone, metric }); setCursor(''); }} /><ResourceState resource={result} />
    <Notice text="对照等长前一日期窗口；基线为零、缺失、覆盖不足或来源不一致时保留不可比原因。" /><Facts value={result.data} />
    {result.data?.next_cursor && <Button title="下一页趋势" onPress={() => setCursor(result.data.next_cursor)} />}{!!cursor && <Button title="趋势第一页" onPress={() => setCursor('')} variant="secondary" />}
  </Card>;
}
function IntervalReader({ pet, initialZone }: { pet: Row; initialZone: string }) {
  const { api } = useApp(), [from, setFrom] = useState(new Date(Date.now() - 86400000).toISOString()), [to, setTo] = useState(new Date().toISOString());
  const [zone, setZone] = useState(initialZone), [bucket, setBucket] = useState('hour'), [params, setParams] = useState<Row>({ from, to, timezone: zone, bucket }), [cursor, setCursor] = useState('');
  const result = useResource(() => api.get(`/pets/${pet.id}/activity/intervals${query({ ...params, limit: 12, cursor })}`), [api, pet.id, params, cursor]);
  return <Card><Heading>活动时段与覆盖</Heading><Field label="开始（含，ISO带时区）" value={from} onChangeText={setFrom} /><Field label="结束（不含，最多31天）" value={to} onChangeText={setTo} />
    <Field label="IANA时区" value={zone} onChangeText={setZone} /><Choose value={bucket} options={[{ label: '真实一小时', value: 'hour' }, { label: '当地自然日', value: 'day' }]} onChange={setBucket} />
    <Action title="读取时段" run={async () => { setParams({ from: instant(from), to: instant(to), timezone: zone, bucket }); setCursor(''); }} />
    <ResourceState resource={result} /><Facts value={result.data} />{result.data?.next_cursor && <Button title="下一页时段" onPress={() => setCursor(result.data.next_cursor)} />}
    {!!cursor && <Button title="时段第一页" onPress={() => setCursor('')} variant="secondary" />}
  </Card>;
}

export function HealthScreen(props: AppScreenProps) {
  const { pet } = useApp(); return pet ? <PetHealth key={pet.id} {...props} /> : <MissingPet {...props} />;
}
function ActivityFeedback({ observation }: { observation: Row }) {
  const { api, pet, household } = useApp(), key = useWriteKey();
  const submitting = useRef(false), [busy, setBusy] = useState(false);
  const [evidenceId, setEvidenceId] = useState(''), [assessment, setAssessment] = useState('helpful'), [comment, setComment] = useState(''), [receipt, setReceipt] = useState<Row | null>(null);
  const findings = Array.isArray(observation.observations) ? observation.observations as Row[] : [];
  const evidence = Array.isArray(observation.evidence) ? observation.evidence as Row[] : [];
  const linked = findings.flatMap(finding => (Array.isArray(finding.evidence_ids) ? finding.evidence_ids as string[] : [])
    .map(id => ({ finding, evidence: evidence.find(item => item.id === id && item.metric === finding.metric) })).filter(item => item.evidence));
  const selected = linked.find(item => item.evidence!.id === evidenceId);
  const canWrite = ['owner', 'caregiver'].includes(household?.role ?? '');
  const metricName = (metric: string) => ({ steps: '步数', active_minutes: '活动分钟' } as Row)[metric] ?? metric;
  const signature = JSON.stringify([observation.id, observation.local_date, observation.timezone, linked.map(item => item.evidence!.id)]);
  useEffect(() => { setEvidenceId(''); setAssessment('helpful'); setComment(''); setReceipt(null); key.clear(); }, [signature, pet?.id]);
  if (!linked.length) return <Notice text="本版本没有可绑定反馈的变化发现；原评估、覆盖与不足原因仍可查看。" />;
  return <Card><Heading>反馈这份活动观察</Heading><Notice text="选择原观察里的实际发现；服务端核对宠物、日期和证据版本后保存引用，反馈不改变原评估。" />
    {linked.map(item => <Text key={item.evidence!.id}>{item.finding.text}</Text>)}
    <Choose value={evidenceId} disabled={busy} options={[{ label: '选择一项实际观察', value: '' }, ...linked.map(item => ({ label: metricName(item.finding.metric), value: item.evidence!.id }))]}
      onChange={(value: string) => { if (submitting.current) return; setEvidenceId(value); setComment(''); setReceipt(null); key.clear(); }} />
    {selected && <Facts value={selected.evidence} />}
    {canWrite ? <>
      <Choose value={assessment} disabled={busy} options={[{ label: '有用', value: 'helpful' }, { label: '不准确', value: 'incorrect' }, { label: '其他反馈', value: 'other' }]}
        onChange={(value: string) => { if (submitting.current) return; setAssessment(value); setReceipt(null); }} />
      <Field label="反馈说明（1–4000字）" value={comment} editable={!busy} multiline onChangeText={(value: string) => { if (submitting.current) return; setComment(value); setReceipt(null); }} />
      {selected && !receipt ? <Action title="保存关联反馈" run={async () => {
        if (!pet || observation.pet_id !== pet.id || observation.status === 'day_in_progress' || !observation.id || !observation.local_date) throw new Error('请重新读取本宠物的完整日观察');
        const note = comment.trim(); if (!note || note.length > 4000) throw new Error('反馈说明须为1–4000字');
        const body = { feature_date: observation.local_date, assessment, comment: note, observation: { id: observation.id, evidence_id: selected.evidence!.id } };
        submitting.current = true; setBusy(true);
        try { const result = await api.post(`/pets/${pet.id}/feedback`, body, key.for(body)); key.clear(); setReceipt(result); }
        finally { submitting.current = false; setBusy(false); }
      }} success="反馈已保存，原观察与证据保持不变。" /> : !receipt && <Button title="先选择实际观察证据" onPress={() => {}} disabled />}
      {receipt && <><Notice text="已保存这份反馈。编辑说明或选择其他证据后可以提交新的反馈。" tone="success" /><Facts value={receipt} /></>}
    </> : <Button title="只读成员可查看证据；反馈需家庭写权限" onPress={() => {}} disabled />}
  </Card>;
}
function PetHealth({ navigation }: AppScreenProps) {
  const { api, pet: selectedPet } = useApp(), pet = selectedPet!, key = useWriteKey();
  const [initialRange] = useState(() => { const end = Date.now(); return { from: new Date(end - 31 * 86400000).toISOString(), to: new Date(end).toISOString() }; });
  const [from, setFrom] = useState(initialRange.from), [to, setTo] = useState(initialRange.to);
  const [zone, setZone] = useState(''), [readStatus, setReadStatus] = useState('all'), [params, setParams] = useState<Row>({ from, to, read_status: 'all' }), [cursor, setCursor] = useState('');
  const [id, setId] = useState(''), [assessmentDate, setAssessmentDate] = useState(shiftDay(dayAt(zoneFor(pet)), -1)), [assessmentZone, setAssessmentZone] = useState(zoneFor(pet));
  const list = useResource(() => api.get(`/pets/${pet.id}/health-observations${query({ ...params, limit: 10, cursor })}`), [api, pet.id, params, cursor]);
  const detail = useResource(() => id ? api.get(`/health-observations/${id}`) : Promise.resolve(null), [api, pet.id, id]);
  const refresh = () => { list.refresh(); detail.refresh(); };
  function recent(generated?: Row) {
    const end = new Date(Math.max(Date.now(), generated?.generated_at ? Date.parse(generated.generated_at) + 1 : 0)), start = new Date(end.getTime() - 31 * 86400000), startAt = start.toISOString(), endAt = end.toISOString();
    const nextZone = generated ? '' : zone.trim(), nextStatus = generated ? 'all' : readStatus;
    setFrom(startAt); setTo(endAt); setZone(nextZone); setReadStatus(nextStatus); setParams({ from: startAt, to: endAt, timezone: nextZone, read_status: nextStatus }); setCursor('');
  }
  return <Page><Heading>{pet.name} · 健康观察</Heading><Notice text="这里保存的是完整自然日活动评估，包括无发现与输入不足；不是疾病诊断。空历史不表示没有健康异常。" />
    <Button title="查看照护说明" onPress={() => navigation.navigate('Learning', { kind: 'guidance', category: 'health' })} />
    <Card><Heading>查看某日活动评估</Heading><Field label="已结束的当地日期" value={assessmentDate} onChangeText={(value: string) => { setAssessmentDate(value); setId(''); }} /><Field label="IANA时区" value={assessmentZone} onChangeText={(value: string) => { setAssessmentZone(value); setId(''); }} />
      <Action title="读取/生成该日实际评估" run={async () => {
        const result = await api.get(`/pets/${pet.id}/observations${query({ date: assessmentDate, timezone: assessmentZone })}`);
        if (result.status === 'day_in_progress') throw new Error('该自然日尚未结束，临时评估不进入历史');
        if (result.id) { setId(result.id); recent(result); }
      }} success="已读取实际输入的评估，并更新最近31天历史；无发现或输入不足也如实保留。" />
    </Card>
    <Card><Heading>已保存评估历史</Heading><Field label="生成时间起点（含，ISO）" value={from} onChangeText={setFrom} /><Field label="生成时间终点（不含，最多31天）" value={to} onChangeText={setTo} />
      <Field label="评估时区筛选（留空为全部）" value={zone} onChangeText={setZone} /><Choose value={readStatus} options={[{ label: '全部', value: 'all' }, { label: '本人未阅', value: 'unread' }, { label: '本人已阅', value: 'read' }]} onChange={setReadStatus} />
      <Action title="应用历史筛选" run={async () => { setParams({ from: instant(from), to: instant(to), timezone: zone.trim(), read_status: readStatus }); setCursor(''); setId(''); }} />
      <ResourceState resource={list} />{list.data?.items?.length === 0 && <Notice text="此范围尚无已保存的完整日评估。历史不会自动补齐没有生成过的日期。" />}
      {list.data?.items?.map((item: Row) => <Card key={item.id}><Text>{item.local_date} · {item.timezone}</Text><Text>{item.finding_count} 项发现 · {item.superseded ? '历史版本' : '当前版本'} · {item.read_at ? '本人已阅' : '本人未阅'}</Text>
        <Text>生成于 {item.generated_at}</Text><Button title="查看原评估与证据" onPress={() => setId(item.id)} /></Card>)}
      <Button title="刷新此时间窗" onPress={list.refresh} variant="secondary" /><Button title="更新为最近31天" onPress={() => recent()} variant="secondary" />{list.data?.next_cursor && <Button title="下一页评估" onPress={() => setCursor(list.data.next_cursor)} />}
      {!!cursor && <Button title="返回历史第一页" onPress={() => setCursor('')} variant="secondary" />}
    </Card>
    {!!id && <Card><Heading>原评估与证据</Heading><ResourceState resource={detail} />{detail.data?.id === id && <><Facts value={detail.data} />
      {detail.data.assessment?.id === id && <ActivityFeedback key={id} observation={detail.data.assessment} />}
      <Notice text="标为已阅只记录本人知晓，不关闭观察、不改变安全事件。新有效输入的版本有独立已阅状态。" />
      <Action title={detail.data.read_at ? '已阅（保留首次时间）' : '标记本人已阅'} run={async () => { await api.patch(`/health-observations/${id}/read`, {}, key.for({ id })); refresh(); }} success="本人已阅状态已保存。" />
    </>}</Card>}
    <Button title="日常输入与趋势" onPress={() => navigation.navigate('Wellness')} />
  </Page>;
}
