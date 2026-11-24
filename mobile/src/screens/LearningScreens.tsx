import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Switch, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Choose, Facts, Field, Heading, Notice, Page } from '../ui';
import { AppScreenProps, Row } from '../types';
import { MediaPreview } from '../ui/MediaPreview';
import { MediaCapture } from '../ui/MediaCapture';
import { loadSafetyRange } from '../lib/safetyHistory';

const query = (values: Row) => '?' + Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
const taskStatuses = ['pending', 'processing', 'succeeded', 'failed', 'cancelled'];
const options = (values: string[]) => values.map(value => ({ label: value || '全部', value }));
function useMounted() { const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); return alive; }
function iso(value: string) {
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('请填写带时区的ISO时间，例如2026-11-24T12:00:00+08:00');
  return new Date(value).toISOString();
}
function State({ resource }: { resource: { loading: boolean; error: unknown } }) {
  return <>{resource.loading && <Notice text="正在读取…" />}{!!resource.error && <Notice tone="error" text={resource.error instanceof Error ? resource.error.message : String(resource.error)} />}</>;
}
function Toggle({ title, value, change, disabled = false }: { title: string; value: boolean; change: (value: boolean) => void; disabled?: boolean }) {
  return <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><Text style={{ flex: 1 }}>{title}</Text><Switch value={value} onValueChange={change} disabled={disabled} /></View>;
}
function Pager({ data, cursor, change }: { data: Row | null; cursor: string; change: (value: string) => void }) {
  return <>{!!cursor && <Button title="返回第一页" onPress={() => change('')} />}{data?.next_cursor && <Button title="下一页" onPress={() => change(data.next_cursor)} />}</>;
}
function Submit({ title, enabled, run, success }: { title: string; enabled: boolean; run: () => Promise<any>; success?: string }) {
  return enabled ? <Action title={title} run={run} success={success} /> : <Button title={title} onPress={() => {}} disabled />;
}
function Background({ value, change }: { value: string[]; change: (value: string[]) => void }) {
  return <>{[{ id: 'routine_changed', title: '近期日常安排有变化' }, { id: 'not_sure_yet', title: '背景情况还不确定' }].map(item => <Toggle key={item.id} title={item.title} value={value.includes(item.id)} change={enabled => change(enabled ? [...value, item.id] : value.filter(id => id !== item.id))} />)}</>;
}

export function LearningScreen(props: AppScreenProps) {
  const { api, user } = useApp();
  return <LearningBody key={`${api.baseUrl}:${user?.id}`} {...props} />;
}
function LearningBody({ navigation, route }: AppScreenProps) {
  const { api } = useApp();
  const [kind, setKind] = useState('lesson'), [category, setCategory] = useState(''), [search, setSearch] = useState(''), [filters, setFilters] = useState<Row>({ kind: 'lesson' });
  const [cursor, setCursor] = useState(''), [progressCursor, setProgressCursor] = useState(''), [id, setId] = useState(''), [version, setVersion] = useState('');
  const appliedRoute = useRef('');
  useEffect(() => {
    const requestedKind = route.params?.kind, requestedCategory = route.params?.category;
    if (requestedKind === undefined && requestedCategory === undefined) return;
    if (requestedKind !== undefined && !['', 'lesson', 'tip', 'guidance', 'plan'].includes(requestedKind)) return;
    const signature = JSON.stringify([requestedKind, requestedCategory]);
    if (appliedRoute.current === signature) return;
    appliedRoute.current = signature;
    const nextKind = requestedKind ?? '', nextCategory = typeof requestedCategory === 'string' ? requestedCategory : '';
    setKind(nextKind); setCategory(nextCategory); setCursor(''); setId('');
    setFilters({ kind: nextKind, category: nextCategory });
  }, [route.params?.kind, route.params?.category]);
  const catalog = useResource<Row>(() => api.get(`${filters.kind === 'lesson' ? '/lessons' : '/content'}${query({ ...filters, ...(filters.kind === 'lesson' ? { kind: undefined } : {}), cursor, limit: 15 })}`), [api, filters, cursor]);
  const progress = useResource<Row>(() => api.get(`/learning-progress${query({ cursor: progressCursor, limit: 15 })}`), [api, progressCursor]);
  return <Page title="课程与内容">
    <Card title="已发布目录">
      <Choose value={kind} options={[{ label: '课程', value: 'lesson' }, { label: '建议', value: 'tip' }, { label: '指导', value: 'guidance' }, { label: '计划', value: 'plan' }, { label: '全部', value: '' }]} onChange={setKind} />
      <Field label="类别（精确匹配，可空）" value={category} onChangeText={setCategory} />
      <Field label="标题搜索（可空）" value={search} onChangeText={setSearch} />
      <Button title="应用目录筛选" onPress={() => { setCursor(''); setFilters({ kind, category: category.trim(), q: search.trim() }); }} />
      <State resource={catalog} />
      {(catalog.data?.items ?? []).map((row: Row) => <Card key={row.id} title={row.title}><Facts value={{ 类型: row.kind, 类别: row.category, 版本: row.content_version, 摘要: row.summary, 本人学习: row.progress ?? null }} /><Button title="阅读正文与来源" onPress={() => { setId(row.id); setVersion(''); }} /></Card>)}
      {!catalog.loading && !catalog.error && !catalog.data?.items?.length && <Notice text="没有已审核发布的内容。默认目录可以为空，不使用编造的课程补齐。" />}
      <Button title="刷新目录" onPress={catalog.refresh} /><Pager data={catalog.data} cursor={cursor} change={setCursor} />
    </Card>
    {id && <LessonDetail key={`${id}:${version}`} id={id} version={version} navigation={navigation} onCurrent={() => setVersion('')} onClose={() => setId('')} onSaved={async () => { setProgressCursor(''); await Promise.all([progress.refresh(), catalog.refresh()]); }} />}
    <Card title="本人学习历史">
      <State resource={progress} /><Facts value={{ 全当前发布目录计数: progress.data?.counts, 完成依据: progress.data?.completion_basis }} />
      {(progress.data?.items ?? []).map((row: Row) => <Card key={`${row.content_id}:${row.content_version}`} title={row.title ?? '原内容已不可用'}><Facts value={row} />{row.content_status !== 'unavailable' && <Button title="读取这条记录的内容版本" onPress={() => { setId(row.content_id); setVersion(String(row.content_version)); }} />}</Card>)}
      <Button title="刷新学习记录" onPress={progress.refresh} /><Pager data={progress.data} cursor={progressCursor} change={setProgressCursor} />
    </Card>
  </Page>;
}
function LessonDetail({ id, version, navigation, onCurrent, onClose, onSaved }: { id: string; version: string; navigation: any; onCurrent: () => void; onClose: () => void; onSaved: () => Promise<void> }) {
  const { api, pet, households } = useApp(), alive = useMounted();
  const [completed, setCompleted] = useState<string[]>([]), [learned, setLearned] = useState(false), [saving, setSaving] = useState(false);
  const detail = useResource<Row>(() => api.get(`/content/${encodeURIComponent(id)}${query({ version })}`), [api, id, version]);
  useEffect(() => { setCompleted(detail.data?.progress?.completed_step_ids ?? []); setLearned(Boolean(detail.data?.progress?.learned)); }, [detail.data]);
  const current = detail.data, canSave = !saving && current?.kind === 'lesson' && current.content_version === current.current_version;
  const historical = current?.kind === 'lesson' && current.content_version !== current.current_version;
  return <Card title="正文与版本">
      <State resource={detail} /><Button title="重读当前所选版本" onPress={detail.refresh} />
      <Button title={historical ? '查看最新课程版本' : '读取当前发布版本'} onPress={() => { if (version) onCurrent(); else void detail.refresh(); }} />
      {current && <>
        <Heading>{current.title}</Heading><Facts value={{ 内容ID: current.id, 版本: current.content_version, 当前发布版本: current.current_version, 适用范围: current.applicability, 审核: current.review, 来源: current.sources }} />
        {historical && <Notice tone="warning" text="正在查看历史版本及当时保存的学习记录，只能阅读，不能修改步骤或已学状态。请查看最新课程版本继续学习；新版本不会自动继承旧进度。" />}
        <Text selectable style={{ lineHeight: 24 }}>{current.body}</Text>
        {current.kind === 'plan' && <>
          {current.exercise_plan ? <><Facts value={current.exercise_plan} /><Button title="选用此运动计划" disabled={!pet || !['owner', 'caregiver'].includes(households.find(row => row.id === pet.household_id)?.role ?? '')} onPress={() => { const params = { section: 'goals', plan: { id: current.id, title: current.title, content_version: current.content_version, ...current.exercise_plan } }; if (navigation.getState?.()?.routes?.some((row: Row) => row.name === 'Wellness') && typeof navigation.popTo === 'function') navigation.popTo('Wellness', params); else navigation.navigate('Wellness', params); }} /><Notice text="仅预填当前宠物的目标草稿，仍需你核对并明确保存；各项分钟不会自动联动。" /></> : <Notice text="此计划未提供结构化分钟参数，可阅读正文；不会从文字猜测目标。" />}
        </>}
        {current.kind !== 'lesson' && <><Notice text="此内容没有课程问答引用合同。可以打开问答，再明确选择活动、身体观察或营养等已有上下文；不会把它当作课程。" /><Button title="打开问答并选择上下文" onPress={() => navigation.navigate('Assistant', { kind: 'activity' })} /></>}
        {current.lesson?.video && <><Facts value={{ 视频链接: current.lesson.video.url, 已提供时长秒: current.lesson.video.duration_seconds }} /><Action title="确认后打开课程外部视频" run={async () => {
          await new Promise<void>((resolve, reject) => Alert.alert('打开外部视频', '将打开外部地址并使用网络，不会自动下载。', [{ text: '取消', style: 'cancel', onPress: () => reject(new Error('已取消')) }, { text: '打开', onPress: () => resolve() }], { cancelable: false }));
          await Linking.openURL(current.lesson.video.url);
        }} /></>}
        {(current.lesson?.steps ?? []).map((step: Row) => <Card key={step.id} title={step.title}><Text selectable>{step.body}</Text><Toggle title="我已完成这一步" value={completed.includes(step.id)} disabled={!canSave} change={checked => setCompleted(previous => checked ? [...previous, step.id] : previous.filter(id => id !== step.id))} /></Card>)}
        {current.kind === 'lesson' && <>
          <Toggle title="我明确报告已学过此版本" value={learned} change={setLearned} disabled={!canSave} />
          <Notice text="完成步骤和“已学过”分别保存。新版本不继承旧进度；旧版本只读，失效内容不返回正文。收藏暂未提供后端合同，不把已学过当作收藏。" />
          <Action title="保存本人学习进度" disabled={!canSave} run={async () => {
            setSaving(true);
            try {
              await api.put(`/lessons/${current.id}/progress`, { content_version: current.content_version, completed_step_ids: completed, learned, expected_version: current.progress?.version ?? 0 });
              if (alive.current) { await detail.refresh(); if (alive.current) await onSaved(); }
            } finally { if (alive.current) setSaving(false); }
          }} success="本人学习记录已保存" />
          <Button title="以此课程版本提问" onPress={() => navigation.navigate('Assistant', { kind: 'lesson', lessonId: current.id, lessonVersion: current.content_version, lessonTitle: current.title })} />
        </>}
      </>}
      <Button title="收起正文" onPress={onClose} />
    </Card>;
}

export function BehaviorScreen(props: AppScreenProps) {
  const { api, user, pet, households } = useApp();
  if (!pet) return <Page title="行为与解释"><Notice text="先选择宠物。人工记录不要求已有媒体。" /><Button title="宠物档案" onPress={() => props.navigation.navigate('Pet')} /></Page>;
  return <BehaviorBody key={`${api.baseUrl}:${user?.id}:${pet.id}:${households.find(row => row.id === pet.household_id)?.role}`} {...props} pet={pet} />;
}
function BehaviorBody({ pet, navigation }: AppScreenProps & { pet: Row }) {
  const { api, user, households } = useApp(), alive = useMounted();
  const canWrite = ['owner', 'caregiver'].includes(households.find(row => row.id === pet.household_id)?.role ?? 'viewer');
  const [section, setSection] = useState('records'), [period, setPeriod] = useState('today'), [custom, setCustom] = useState<Row>({}), [rangeRevision, setRangeRevision] = useState(0);
  const [from, setFrom] = useState(''), [to, setTo] = useState('');
  const bounds = useResource<Row>(async () => period === 'custom' ? custom : loadSafetyRange(api, pet.id, period === 'week' ? 'week' : 'today', pet.effective_timezone ?? pet.timezone ?? 'UTC'), [api, pet.id, period, custom, rangeRevision]);
  useEffect(() => { if (bounds.data?.from && bounds.data?.to) { setFrom(bounds.data.from); setTo(bounds.data.to); } }, [bounds.data]);
  const range = bounds.data ? { from: bounds.data.from, to: bounds.data.to } : null;
  const [labelFilter, setLabelFilter] = useState(''), [mediaFilter, setMediaFilter] = useState(''), [status, setStatus] = useState(''), [filters, setFilters] = useState<Row>({});
  const [recordCursor, setRecordCursor] = useState(''), [taskCursor, setTaskCursor] = useState(''), [mediaCursor, setMediaCursor] = useState('');
  const [recordId, setRecordId] = useState(''), [taskId, setTaskId] = useState(''), [mediaId, setMediaId] = useState('');
  const recordSelection = useRef(0), taskSelection = useRef(0);
  const chooseRecord = (id: string) => { recordSelection.current++; setRecordId(id); };
  const chooseTask = (id: string) => { taskSelection.current++; setTaskId(id); };
  const [labels, setLabels] = useState(''), [recordFrom, setRecordFrom] = useState(() => new Date(Date.now() - 60000).toISOString()), [recordTo, setRecordTo] = useState(() => new Date().toISOString()), [recordNotes, setRecordNotes] = useState('');
  const [taskFrom, setTaskFrom] = useState(''), [taskTo, setTaskTo] = useState(''), [recordRef, setRecordRef] = useState(''), [background, setBackground] = useState<string[]>([]), [taskNotes, setTaskNotes] = useState('');
  const records = useResource<Row>(() => range ? api.get(`/pets/${pet.id}/behavior-records${query({ ...range, label: filters.label, media_id: filters.media_id, cursor: recordCursor, limit: 15 })}`) : Promise.resolve({ items: [] }), [api, pet.id, bounds.data, filters, recordCursor]);
  const tasks = useResource<Row>(() => range ? api.get(`/pets/${pet.id}/interpretations${query({ ...range, status: filters.status, media_id: filters.media_id, cursor: taskCursor, limit: 15 })}`) : Promise.resolve({ items: [] }), [api, pet.id, bounds.data, filters, taskCursor]);
  const media = useResource<Row>(() => api.get(`/pets/${pet.id}/media${query({ cursor: mediaCursor, limit: 15 })}`), [api, pet.id, mediaCursor]);
  const scoped = async (path: string) => { const value = await api.get(path); if (value.pet_id !== pet.id) throw new Error('该来源属于另一只宠物，请切换宠物后查看'); return value; };
  const recordRead = useResource<Row | null>(() => recordId ? scoped(`/behavior-records/${encodeURIComponent(recordId)}`) : Promise.resolve(null), [api, pet.id, recordId]);
  const record = { ...recordRead, data: recordRead.data?.id === recordId ? recordRead.data : null };
  const mediaRead = useResource<Row | null>(() => mediaId ? scoped(`/media/${encodeURIComponent(mediaId)}`) : Promise.resolve(null), [api, pet.id, mediaId]);
  const selectedMedia = { ...mediaRead, data: mediaRead.data?.id === mediaId ? mediaRead.data : null };
  const refreshHistory = async () => { setRecordCursor(''); setTaskCursor(''); setRangeRevision(value => value + 1); };
  return <Page title={`${pet.name} · 行为与解释`}>
    <Notice text="人工标签是成员观察；offline解释为固定演示，未分析音视频；api无模型时真实失败。不能据此诊断健康或推断情绪。" />
    <Choose value={section} options={[{ label: '人工行为', value: 'records' }, { label: '媒体', value: 'media' }, { label: '解释任务', value: 'tasks' }]} onChange={setSection} />
    {section !== 'media' && <Card title="历史筛选">
      <Choose value={period} options={[{ label: '今天', value: 'today' }, { label: '近7个当地自然日', value: 'week' }, { label: '自定范围', value: 'custom' }]} onChange={value => { if (value === 'custom' && range) setCustom(range); setPeriod(value); setRecordCursor(''); setTaskCursor(''); }} />
      <State resource={bounds} />
      {period === 'custom' ? <><Field label="开始 ISO 时间（带时区）" value={from} onChangeText={setFrom} /><Field label="结束 ISO 时间（单次最多31天）" value={to} onChangeText={setTo} /></> : <Notice text={`按宠物时区 ${pet.effective_timezone ?? pet.timezone ?? 'UTC'} 读取${period === 'week' ? '近7个当地自然日' : '今天'}。`} />}
      <Field label="媒体ID筛选（可空）" value={mediaFilter} onChangeText={setMediaFilter} />
      {section === 'records' ? <Field label="标签精确筛选（可空）" value={labelFilter} onChangeText={setLabelFilter} /> : <Choose value={status} options={options(['', ...taskStatuses])} onChange={setStatus} />}
      <Action title="应用历史筛选" run={async () => { if (period === 'custom') { const range = { from: iso(from), to: iso(to) }; if (range.from >= range.to || Date.parse(range.to) - Date.parse(range.from) > 31 * 86400000) throw new Error('范围须先开始后结束，且最多31天'); setCustom(range); } setRecordCursor(''); setTaskCursor(''); setFilters({ label: labelFilter.trim(), media_id: mediaFilter.trim(), status }); setRangeRevision(value => value + 1); }} />
      <Notice text="今天和近7天按服务端宠物时区读取，刷新会重新核对日期。自定范围或过滤可能排除新任务，可切回今天并清空过滤查看。" />
    </Card>}
    {section === 'records' && <>
      <Card title="人工记录历史"><State resource={records} />{(records.data?.items ?? []).map((row: Row) => <Card key={row.id}><Facts value={{ 标签: row.labels, 开始: row.start_at, 结束: row.end_at, 来源: row.source, 媒体: row.media_id }} /><Button title="读取记录详情" onPress={() => chooseRecord(row.id)} /></Card>)}<Button title="刷新人工记录" onPress={refreshHistory} /><Pager data={records.data} cursor={recordCursor} change={setRecordCursor} /></Card>
      {recordId && <Card title="人工记录详情"><State resource={record} />{record.data && <><Facts value={record.data} /><Button title="将此记录用于解释" disabled={!record.data.media_id} onPress={() => { setRecordRef(record.data!.id); setMediaId(record.data!.media_id); setSection('tasks'); }} />{!record.data.media_id && <Notice text="此人工观察没有媒体，可以按原文提问；媒体解释仍需真实片段。" />}<Button title="以此记录提问" disabled={!!record.data.media_deleted_at} onPress={() => navigation.navigate('Assistant', { kind: 'behavior', behaviorRecordId: record.data!.id, referenceTitle: record.data!.labels?.join('、') || '人工观察' })} /><Button title="查看相关提示" onPress={() => navigation.navigate('Learning', { kind: 'tip', category: 'behavior' })} /></>}<Button title="重读记录" onPress={record.refresh} /><Button title="收起记录" onPress={() => chooseRecord('')} /></Card>}
      {canWrite && <Card title="新增人工观察">
        <Field label="标签（英文逗号分隔，最多10个）" value={labels} onChangeText={setLabels} /><Field label="开始 ISO 时间" value={recordFrom} onChangeText={setRecordFrom} /><Field label="结束 ISO 时间" value={recordTo} onChangeText={setRecordTo} />
        <Field label="观察说明" value={recordNotes} onChangeText={setRecordNotes} multiline /><Field label="可选已有媒体ID（本宠物）" value={mediaId} onChangeText={setMediaId} />
        <Action title="保存人工观察" run={async () => { const selection = recordSelection.current; const saved = await api.post(`/pets/${pet.id}/behavior-records`, { labels: labels.split(',').map(value => value.trim()).filter(Boolean), start_at: iso(recordFrom), end_at: iso(recordTo), notes: recordNotes, media_id: mediaId.trim() || null }); if (alive.current) { if (selection === recordSelection.current) chooseRecord(saved.id); await refreshHistory(); } }} />
      </Card>}
    </>}
    {section === 'media' && <Card title="已有授权媒体">
      {canWrite && <MediaCapture key={`${api.origin}:${user?.id}:${pet.id}`} petId={pet.id} onSaved={saved => { setMediaId(saved.id); if (mediaCursor) setMediaCursor(''); else void media.refresh(); }} />}
      <Notice text="下载通过授权请求交给系统分享入口，不将令牌附在公开URL上。保存新媒体后只读取详情，不会自动创建解释。" /><State resource={media} />
      {(media.data?.items ?? []).map((row: Row) => <Card key={row.id} title={row.filename}><Facts value={{ 媒体ID: row.id, 类型: row.content_type, 大小字节: row.size_bytes, 采集开始: row.captured_at, 时长秒: row.duration_seconds, 来源: row.source }} /><Button title="选择并读取媒体详情" onPress={() => setMediaId(row.id)} /></Card>)}
      <Field label="读取已有媒体ID" value={mediaId} onChangeText={setMediaId} /><State resource={selectedMedia} />
      {selectedMedia.data && <><Facts value={selectedMedia.data} /><Action title="授权下载 / 分享原文件" run={() => api.download(selectedMedia.data!.content_path, selectedMedia.data!.filename)} />
        <MediaPreview key={`${api.baseUrl}:${selectedMedia.data.id}`} id={selectedMedia.data.id} petId={pet.id} />
        {canWrite && <Action title="确认后永久删除此媒体" run={async () => {
          await new Promise<void>((resolve, reject) => Alert.alert('删除媒体', '原始文件及关联解释、问答和反馈证据会按服务端规则清理，不能撤销。', [{ text: '取消', style: 'cancel', onPress: () => reject(new Error('已取消')) }, { text: '删除', style: 'destructive', onPress: () => resolve() }], { cancelable: false }));
          const selected = selectedMedia.data!.id; await api.delete(`/media/${selected}`); if (!alive.current) return; setMediaId(previous => previous === selected ? '' : previous); await Promise.all([media.refresh(), records.refresh(), record.refresh(), tasks.refresh()]);
        }} />}
        <Button title="将所选媒体用于解释" onPress={() => setSection('tasks')} />
      </>}
      <Button title="刷新媒体列表与详情" onPress={() => { void media.refresh(); void selectedMedia.refresh(); }} /><Pager data={media.data} cursor={mediaCursor} change={setMediaCursor} />
    </Card>}
    {section === 'tasks' && <>
      <Card title="解释任务历史"><State resource={tasks} />{(tasks.data?.items ?? []).map((row: Row) => <Card key={row.id}><Facts value={row} /><Button title="读取任务正文与证据" onPress={() => chooseTask(row.id)} /></Card>)}<Button title="刷新解释历史" onPress={refreshHistory} /><Button title="查看今天全部解释" onPress={() => { setPeriod('today'); setFilters({}); setStatus(''); setMediaFilter(''); void refreshHistory(); }} /><Pager data={tasks.data} cursor={taskCursor} change={setTaskCursor} /></Card>
      {canWrite && <Card title="创建解释任务"><Field label="本宠物已有媒体ID" value={mediaId} onChangeText={setMediaId} /><Field label="可选人工行为记录ID" value={recordRef} onChangeText={setRecordRef} /><Field label="解释窗口开始 ISO（可空）" value={taskFrom} onChangeText={setTaskFrom} /><Field label="解释窗口结束 ISO（可空）" value={taskTo} onChangeText={setTaskTo} />
        <Notice text="开始/结束必须同时填写；都为空时使用采集开始与服务端已验证时长。时长未知必须显式填写。" /><Background value={background} change={setBackground} /><Field label="补充背景" value={taskNotes} onChangeText={setTaskNotes} multiline />
        <Submit title="创建解释任务" enabled={!!mediaId.trim()} run={async () => { if (!!taskFrom.trim() !== !!taskTo.trim()) throw new Error('解释窗口开始与结束必须同时填写'); const selection = taskSelection.current; const saved = await api.post(`/pets/${pet.id}/interpretations`, { media_id: mediaId.trim(), behavior_record_id: recordRef.trim() || null, ...(taskFrom.trim() ? { from: iso(taskFrom), to: iso(taskTo) } : {}), background, notes: taskNotes }); if (alive.current) { if (selection === taskSelection.current) chooseTask(saved.id); await refreshHistory(); } }} />
      </Card>}
      <Field label="任务ID（高级读取）" value={taskId} onChangeText={chooseTask} />
      {taskId && <InterpretationDetail key={taskId} pet={pet} id={taskId} canWrite={canWrite} navigation={navigation} onChanged={refreshHistory} />}
    </>}
  </Page>;
}

function InterpretationDetail({ pet, id, canWrite, navigation, onChanged }: { pet: Row; id: string; canWrite: boolean; navigation: any; onChanged: () => Promise<void> }) {
  const { api } = useApp(), alive = useMounted();
  const task = useResource<Row>(async () => { const result = await api.get(`/interpretations/${encodeURIComponent(id)}`); if (result.id !== id || result.pet_id !== pet.id) throw new Error('解释不属于当前宠物'); return result; }, [api, pet.id, id]);
  const refresh = async () => { await task.refresh(); if (alive.current) await onChanged(); };
  const current = task.data;
  async function change(action: 'retry' | 'cancel') {
    if (!current) return;
    await api.post(`/interpretations/${id}/${action}`, action === 'retry' ? { expected_attempt: current.attempt } : {});
    if (alive.current) await refresh();
  }
  return <Card title="解释任务详情"><State resource={task} /><Button title="重读任务状态与证据" onPress={refresh} />
    {current && <><Facts value={current} /><Button title="查看相关提示" onPress={() => navigation.navigate('Learning', { kind: 'tip', category: 'behavior' })} />{canWrite && <>
      {['failed', 'cancelled'].includes(current.status) && current.media_id && <Action title="重试当前失败 / 取消尝试" run={() => change('retry')} />}
      {['pending', 'processing'].includes(current.status) && <Action title="取消尚未结束的解释" run={() => change('cancel')} />}
    </>}
    {current.status === 'succeeded' && current.media_id && !current.error_code && <>
      <InterpretationFeedback key={`${id}:${current.attempt}`} task={current} canWrite={canWrite} />
      <Button title="以此解释提问" onPress={() => navigation.navigate('Assistant', { kind: 'behavior', interpretationId: id, referenceTitle: '已完成解释' })} />
    </>}</>}
  </Card>;
}
function InterpretationFeedback({ task, canWrite }: { task: Row; canWrite: boolean }) {
  const { api } = useApp(), alive = useMounted();
  const [cursor, setCursor] = useState(''), [assessment, setAssessment] = useState('helpful'), [comment, setComment] = useState(''), [saving, setSaving] = useState(false);
  const saved = useResource<Row>(() => api.get(`/interpretations/${task.id}/feedback${query({ expected_attempt: task.attempt, limit: 15, cursor })}`), [api, task.id, task.attempt, cursor]);
  return <Card title="本人对本次尝试的反馈"><State resource={saved} />
    {(saved.data?.items ?? []).map((row: Row) => <Facts key={row.id} value={{ 评价: row.assessment, 说明: row.comment, 保存时间: row.created_at }} />)}
    {!saved.loading && !saved.error && !saved.data?.items?.length && <Notice text="本次尝试尚无本人反馈。" />}
    <Button title="重读本人反馈" onPress={saved.refresh} /><Pager data={saved.data} cursor={cursor} change={setCursor} />
    {canWrite && <><Choose value={assessment} disabled={saving} options={[{ label: '有帮助', value: 'helpful' }, { label: '不正确', value: 'incorrect' }, { label: '其他', value: 'other' }]} onChange={setAssessment} /><Field label="对本次解释的反馈（必填）" value={comment} editable={!saving} onChangeText={setComment} multiline />
      <Action title="提交当前尝试的解释反馈" disabled={saving || !comment.trim() || comment.trim().length > 4000} run={async () => {
        setSaving(true);
        try { await api.post(`/interpretations/${task.id}/feedback`, { expected_attempt: task.attempt, assessment, comment: comment.trim() }); if (alive.current) { setComment(''); setCursor(''); await saved.refresh(); } }
        finally { if (alive.current) setSaving(false); }
      }} success="反馈已保存，可重新读取" />
    </>}
  </Card>;
}

export function AssistantScreen(props: AppScreenProps) {
  const { api, user, pet } = useApp();
  if (!pet) return <Page title="本人问答"><Notice text="先选择宠物，问答会话固定归属本人及一只宠物。" /><Button title="宠物档案" onPress={() => props.navigation.navigate('Pet')} /></Page>;
  return <AssistantBody key={`${api.baseUrl}:${user?.id}:${pet.id}`} {...props} pet={pet} />;
}
function ContextChoices({ pet, kind, referenceKind, onLesson, onBehavior }: { pet: Row; kind: string; referenceKind: string; onLesson: (row: Row) => void; onBehavior: (row: Row) => void }) {
  const { api } = useApp();
  const [cursor, setCursor] = useState('');
  const bounds = useResource<Row | null>(() => kind === 'behavior' ? loadSafetyRange(api, pet.id, 'week', pet.effective_timezone ?? pet.timezone ?? 'UTC') : Promise.resolve(null), [api, pet.id, kind]);
  const source = useResource<Row>(async () => {
    if (kind === 'lesson') return api.get(`/lessons${query({ limit: 15, cursor })}`);
    if (!bounds.data) return { items: [] };
    const path = referenceKind === 'behavior_record_id' ? 'behavior-records' : 'interpretations';
    return api.get(`/pets/${pet.id}/${path}${query({ from: bounds.data.from, to: bounds.data.to, limit: 15, cursor, ...(path === 'interpretations' ? { status: 'succeeded' } : {}) })}`);
  }, [api, pet.id, kind, referenceKind, bounds.data, cursor]);
  return <Card title={kind === 'lesson' ? '选择已发布课程及版本' : '选择近7个当地自然日的行为来源'}>
    <State resource={bounds} /><State resource={source} />
    {(source.data?.items ?? []).map((row: Row) => <View key={row.id}>
      <Text>{kind === 'lesson' ? `${row.title} · 版本${row.content_version}` : referenceKind === 'behavior_record_id' ? `${row.labels?.join('、') || '人工观察'} · ${row.start_at}` : `解释 · ${row.created_at}`}</Text>
      <Button title={kind === 'lesson' ? '选择这门课程' : '选择这条行为来源'} disabled={kind === 'behavior' && (referenceKind === 'interpretation_id' ? !row.media_id || !!row.error_code : !!row.media_deleted_at)} onPress={() => kind === 'lesson' ? onLesson(row) : onBehavior(row)} />
    </View>)}
    {!source.loading && !source.error && !source.data?.items?.length && <Notice text="此范围暂无可选来源。可以先保存人工观察或阅读课程；高级入口支持其他已有来源。" />}
    <Button title="刷新可用来源" onPress={async () => { setCursor(''); if (kind === 'behavior') await bounds.refresh(); else await source.refresh(); }} /><Pager data={source.data} cursor={cursor} change={setCursor} />
  </Card>;
}
function AssistantBody({ pet, route }: AppScreenProps & { pet: Row }) {
  const { api } = useApp(), alive = useMounted();
  const [title, setTitle] = useState(''), [conversation, setConversation] = useState(''), [cursor, setCursor] = useState(''), [messageCursor, setMessageCursor] = useState(''), [messageId, setMessageId] = useState('');
  const [question, setQuestion] = useState(''), [kind, setKind] = useState('activity'), [date, setDate] = useState(''), [timezone, setTimezone] = useState(pet.effective_timezone ?? '');
  const [lessonId, setLessonId] = useState(''), [lessonVersion, setLessonVersion] = useState(''), [referenceKind, setReferenceKind] = useState('behavior_record_id'), [referenceId, setReferenceId] = useState('');
  const [background, setBackground] = useState<string[]>([]), [notes, setNotes] = useState('');
  const [advanced, setAdvanced] = useState(false), [sourceTitle, setSourceTitle] = useState('');
  const conversationSequence = useRef(0), messageSequence = useRef(0), questionRevision = useRef(0), contextRevision = useRef(0);
  useEffect(() => {
    contextRevision.current++;
    if (route.params?.kind === 'lesson') { setKind('lesson'); setLessonId(route.params.lessonId ?? ''); setLessonVersion(String(route.params.lessonVersion ?? '')); setSourceTitle(route.params.lessonTitle ?? '所读课程'); }
    if (route.params?.kind === 'behavior') { setKind('behavior'); setReferenceKind(route.params.interpretationId ? 'interpretation_id' : 'behavior_record_id'); setReferenceId(route.params.interpretationId ?? route.params.behaviorRecordId ?? ''); setSourceTitle(route.params.referenceTitle ?? '所选行为来源'); }
    if (['activity', 'body_check_in', 'nutrition'].includes(route.params?.kind)) setKind(route.params.kind);
  }, [route.params?.kind, route.params?.lessonId, route.params?.lessonVersion, route.params?.behaviorRecordId, route.params?.interpretationId]);
  const conversations = useResource<Row>(() => api.get(`/pets/${pet.id}/assistant-conversations${query({ cursor, limit: 15 })}`), [api, pet.id, cursor]);
  const messages = useResource<Row | null>(async () => {
    if (!conversation) return null;
    const page = await api.get(`/assistant-conversations/${conversation}/messages${query({ cursor: messageCursor, limit: 15 })}`);
    if (page.items.some((row: Row) => row.pet_id !== pet.id || row.conversation_id !== conversation)) throw new Error('消息不属于当前会话，请重新读取'); return page;
  }, [api, pet.id, conversation, messageCursor]);
  const messageRead = useResource<Row | null>(async () => { if (!messageId) return null; const row = await api.get(`/assistant-messages/${encodeURIComponent(messageId)}`); if (row.pet_id !== pet.id || (conversation && row.conversation_id !== conversation)) throw new Error('问答不属于当前宠物或会话，请从消息历史重新选择'); return row; }, [api, pet.id, conversation, messageId]);
  const message = { ...messageRead, data: messageRead.data?.id === messageId && (!conversation || messageRead.data?.conversation_id === conversation) ? messageRead.data : null };
  const selectMessage = (id: string) => { messageSequence.current++; setMessageId(id); };
  const selectConversation = (id: string) => { conversationSequence.current++; setConversation(id); setMessageCursor(''); selectMessage(''); };
  const refresh = async () => { await Promise.all([message.refresh(), messages.refresh(), conversations.refresh()]); };
  function context() {
    const result: Row = { kind, background, notes };
    if (['activity', 'body_check_in', 'nutrition'].includes(kind)) { if (date.trim()) result.date = date.trim(); if (timezone.trim()) result.timezone = timezone.trim(); }
    if (kind === 'lesson') { if (!lessonId.trim() || !Number.isInteger(Number(lessonVersion)) || Number(lessonVersion) <= 0) throw new Error('请填写真实课程ID和正整数版本'); result.lesson_id = lessonId.trim(); result.lesson_version = Number(lessonVersion); }
    if (kind === 'behavior') { if (!referenceId.trim()) throw new Error('请选定一条本宠物的有效人工记录或成功解释'); result[referenceKind] = referenceId.trim(); }
    return result;
  }
  return <Page title={`${pet.name} · 本人问答`}>
    <Notice text="会话仅本人可见，家庭成员不会共享。offline为固定演示，证据仅准备且未被模型分析；api无模型返回 MODEL_NOT_CONFIGURED。当前不提供诊断或流式回答。" />
    <Card title="本人会话">
      <State resource={conversations} />
      {(conversations.data?.items ?? []).map((row: Row) => <Card key={row.id} title={row.title}><Facts value={{ 会话ID: row.id, 创建: row.created_at, 更新: row.updated_at, 当前选择: conversation === row.id }} /><Button title="选择此会话" onPress={() => selectConversation(row.id)} /></Card>)}
      <Button title="刷新会话" onPress={conversations.refresh} /><Pager data={conversations.data} cursor={cursor} change={setCursor} />
      <Field label="新会话名称（最多200字）" value={title} onChangeText={setTitle} />
      <Submit title="创建本人会话" enabled={!!title.trim() && title.trim().length <= 200} run={async () => { const selection = conversationSequence.current, submitted = title; const saved = await api.post(`/pets/${pet.id}/assistant-conversations`, { title: title.trim() }); if (alive.current) { if (selection === conversationSequence.current) selectConversation(saved.id); setTitle(previous => previous === submitted ? '' : previous); setCursor(''); await conversations.refresh(); } }} />
    </Card>
    {conversation && <>
      <Card title="本次问题与明确上下文">
        <Facts value={{ 会话ID: conversation, 固定宠物: pet.name }} /><Field label="问题（1–4000字）" value={question} onChangeText={value => { questionRevision.current++; setQuestion(value); }} multiline />
        <Choose value={kind} options={[{ label: '活动', value: 'activity' }, { label: '身体观察', value: 'body_check_in' }, { label: '营养', value: 'nutrition' }, { label: '课程', value: 'lesson' }, { label: '行为', value: 'behavior' }]} onChange={value => { contextRevision.current++; setKind(value); setSourceTitle(''); }} />
        {['activity', 'body_check_in', 'nutrition'].includes(kind) && <><Field label="日期 YYYY-MM-DD（空则使用服务端当前日）" value={date} onChangeText={value => { contextRevision.current++; setDate(value); }} /><Field label="IANA 时区" value={timezone} onChangeText={value => { contextRevision.current++; setTimezone(value); }} /></>}
        {kind === 'behavior' && <Choose value={referenceKind} options={[{ label: '人工行为记录（可仅原文）', value: 'behavior_record_id' }, { label: '成功解释（需有效媒体）', value: 'interpretation_id' }]} onChange={value => { contextRevision.current++; setReferenceKind(value); setReferenceId(''); setSourceTitle(''); }} />}
        {['lesson', 'behavior'].includes(kind) && <><Notice text={sourceTitle ? `当前明确来源：${sourceTitle}${kind === 'lesson' ? ` · 版本${lessonVersion}` : ''}` : '请从下方实际列表选择来源。'} />
          <ContextChoices key={`${kind}:${referenceKind}`} pet={pet} kind={kind} referenceKind={referenceKind} onLesson={row => { contextRevision.current++; setLessonId(row.id); setLessonVersion(String(row.content_version)); setSourceTitle(row.title); }} onBehavior={row => { contextRevision.current++; setReferenceId(row.id); setSourceTitle(referenceKind === 'behavior_record_id' ? row.labels?.join('、') || '人工观察' : '已完成解释'); }} />
          <Button title={advanced ? '收起高级引用输入' : '高级：输入已有来源ID'} variant="secondary" onPress={() => setAdvanced(value => !value)} />
          {advanced && (kind === 'lesson' ? <><Field label="已发布课程ID" value={lessonId} onChangeText={value => { contextRevision.current++; setLessonId(value); setSourceTitle('手动课程引用'); }} /><Field label="所读课程版本" value={lessonVersion} onChangeText={value => { contextRevision.current++; setLessonVersion(value); }} keyboardType="number-pad" /></> : <Field label="所选来源ID（本宠物；人工原文可无媒体）" value={referenceId} onChangeText={value => { contextRevision.current++; setReferenceId(value); setSourceTitle('手动行为引用'); }} />)}
        </>}
        <Background value={background} change={value => { contextRevision.current++; setBackground(value); }} /><Field label="补充背景（最多2000字）" value={notes} onChangeText={value => { contextRevision.current++; setNotes(value); }} multiline />
        <Submit key={conversation} title="创建问答任务" enabled={!!question.trim() && question.trim().length <= 4000 && notes.length <= 2000} run={async () => {
          const selected = conversationSequence.current, selectedMessage = messageSequence.current, draft = questionRevision.current, selectedContext = contextRevision.current;
          const saved = await api.post(`/assistant-conversations/${conversation}/messages`, { question: question.trim(), context: context() });
          if (!alive.current || selected !== conversationSequence.current) return;
          if (saved.pet_id !== pet.id || saved.conversation_id !== conversation) throw new Error('保存结果不属于当前宠物或会话');
          if (selectedMessage === messageSequence.current) selectMessage(saved.id);
          if (draft === questionRevision.current && selectedContext === contextRevision.current) setQuestion('');
          setMessageCursor(''); await messages.refresh();
        }} success="问答任务已受理，可刷新后续状态" />
      </Card>
      <Card title="会话消息历史"><State resource={messages} />
        {(messages.data?.items ?? []).map((row: Row) => <Card key={row.id}><Facts value={{ 问题: row.question, 状态: row.status, 模式: row.captured_mode, 来源: row.execution_source, 尝试: row.attempt, 未完成原因: row.error_code, 创建: row.created_at }} /><Button title="查看本条问题、结果和证据" onPress={() => selectMessage(row.id)} /></Card>)}
        <Button title="刷新本会话消息" onPress={messages.refresh} /><Pager data={messages.data} cursor={messageCursor} change={setMessageCursor} />
      </Card>
    </>}
    <Card title="问答任务详情">
      <Field label="重读本人已有任务ID（高级，当前会话）" value={messageId} onChangeText={selectMessage} /><State resource={message} /><Button title="刷新任务与会话" onPress={refresh} />
      {message.data && <><Facts value={message.data} />
        {['failed', 'cancelled'].includes(message.data.status) && <Action key={`${message.data.id}:retry`} title="重试当前失败 / 取消尝试" run={async () => { const selection = messageSequence.current; await api.post(`/assistant-messages/${message.data!.id}/retry`, { expected_attempt: message.data!.attempt }); if (alive.current && selection === messageSequence.current) await refresh(); }} />}
        {['pending', 'processing'].includes(message.data.status) && <Action key={`${message.data.id}:cancel`} title="取消尚未结束的问答" run={async () => { const selection = messageSequence.current; await api.post(`/assistant-messages/${message.data!.id}/cancel`, {}); if (alive.current && selection === messageSequence.current) await refresh(); }} />}
        <Notice text="来源撤回、媒体删除、内容撤审或证据到期后，旧证据与结果可能清空；失效来源不能通过重试恢复，请重新明确选择上下文。" />
      </>}
    </Card>
  </Page>;
}
