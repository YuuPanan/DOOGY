import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { loadSafetyRange } from '../lib/safetyHistory';
import { MediaCapture } from '../ui/MediaCapture';
import { MediaPreview } from '../ui/MediaPreview';
import { Asset } from './assets';
import { Body, Button, Caption, Card, Field, Heading, Notice, Page, Pill, Row, go } from './ui';

type Data = Record<string, any>;
type Props = { screenId: string; navigation: any; route?: { params?: Data } };
const query = (value: Data) => '?' + Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
const number = (value: string, nullable = false) => { if (!value.trim() && nullable) return null; const n = Number(value); if (!value.trim() || !Number.isFinite(n) || n < 0) throw new Error('请输入有效的非负数字。'); return n; };
const iso = (value: string) => { if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('记录时间须包含日期、时间和时区。'); return new Date(value).toISOString(); };
const status = (value: string) => ({ pending: 'Waiting', processing: 'Processing', succeeded: 'Complete', failed: 'Failed', cancelled: 'Cancelled' } as Data)[value] ?? value;
function useAlive() { const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); return alive; }
function State({ value, retry }: { value: { loading: boolean; error: string | null }; retry?: () => any }) { return <>{value.loading && <Caption>Loading…</Caption>}{value.error && <><Notice text={value.error} tone="error" />{retry && <Button title="Try again" secondary onPress={retry} />}</>}</>; }

export function PawchBehaviorScreen(props: Props) {
  const { api, user, pet, households } = useApp();
  const role = households.find(row => row.id === pet?.household_id)?.role;
  const params = props.route?.params ?? {};
  const key = `${api.baseUrl}:${user?.id}:${pet?.id}:${role}:${props.screenId}:${params.taskId ?? ''}:${params.recordId ?? ''}:${params.mediaId ?? ''}:${params.demo ?? ''}`;
  if (['44b', '44c', '44d', '44e'].includes(props.screenId)) return <VideoDemo key={key} {...props} />;
  if (props.route?.params?.demo === true && ['44a', '45'].includes(props.screenId)) return <AudioDemo key={key} {...props} />;
  if (!pet) return <Page screenId={props.screenId} navigation={props.navigation} title="Choose your companion" subtitle="A journal starts with a dog."><Notice text="先选择宠物；行为与媒体不会跨宠物共享。" /><Button title="Meet your dog" onPress={() => go(props.navigation, '03')} /></Page>;
  if (['40', '41'].includes(props.screenId)) return <Exercise key={key} {...props} pet={pet} canWrite={['owner', 'caregiver'].includes(role ?? '')} />;
  if (['44', '44a'].includes(props.screenId)) return <Capture key={key} {...props} pet={pet} canWrite={['owner', 'caregiver'].includes(role ?? '')} />;
  if (props.screenId === '47') return <Tips key={key} {...props} />;
  return <Journal key={key} {...props} pet={pet} canWrite={['owner', 'caregiver'].includes(role ?? '')} />;
}

function Exercise({ screenId, navigation, route, pet, canWrite }: Props & { pet: Data; canWrite: boolean }) {
  const { api } = useApp(), alive = useAlive(), timezone = pet.effective_timezone ?? pet.timezone ?? 'Asia/Shanghai';
  const data = useResource<Data>(async () => { const daily = await api.get(`/pets/${pet.id}/activity/daily${query({ timezone })}`); const goals = await api.get(`/pets/${pet.id}/goals${query({ date: daily.local_date, timezone })}`); return { daily, goals }; }, [api, pet.id, timezone]);
  const plans = useResource<Data>(() => screenId === '41' ? api.get('/content?kind=plan&category=exercise&limit=15') : Promise.resolve({ items: [] }), [api, screenId]);
  useEffect(() => navigation.addListener?.('focus', () => { void data.refresh(); }), [navigation, data.refresh]);
  const [base, setBase] = useState<Data | null>(null), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [receipt, setReceipt] = useState(false), [readError, setReadError] = useState('');
  const [form, setForm] = useState<Data>({ active: '', steps: '', kcal: '', enabled: false, name: '', contentVersion: '', walk: '', play: '', training: '' });
  const [customizing, setCustomizing] = useState(false), editSnapshot = useRef<{ form: Data; dirty: boolean; base: Data | null } | null>(null);
  const adopt = (goals: Data) => { const plan = goals.goals?.plan; setBase(goals); setDirty(false); setForm({ active: String(goals.goals?.targets?.active_minutes ?? ''), steps: String(goals.goals?.targets?.steps ?? ''), kcal: String(goals.goals?.targets?.intake_kcal ?? ''), enabled: !!plan, name: plan?.name ?? '', contentVersion: plan?.content_version ?? '', walk: String(plan?.walk_minutes ?? 0), play: String(plan?.play_minutes ?? 0), training: String(plan?.training_minutes ?? 0) }); };
  useEffect(() => { if (data.data?.goals && !dirty) adopt(data.data.goals); }, [data.data]);
  const edit = (values: Data) => { if (!canWrite || saving || receipt) return; setDirty(true); setForm(current => ({ ...current, ...values })); };
  const reload = async () => { const result = await api.get(`/pets/${pet.id}/goals${query({ date: base?.local_date ?? data.data?.daily.local_date, timezone })}`); if (alive.current) { adopt(result); setReceipt(false); setReadError(''); setCustomizing(false); await data.refresh(); } };
  const save = async () => {
    if (!base) return; setSaving(true);
    try {
      await api.put(`/pets/${pet.id}/goals`, { effective_date: base.local_date, expected_version: base.effective_date_version,
        targets: { active_minutes: number(form.active, true), steps: number(form.steps, true), intake_kcal: number(form.kcal, true) }, source: 'user_provided',
        plan: form.enabled ? { name: form.name.trim(), content_version: form.contentVersion.trim(), walk_minutes: number(form.walk), play_minutes: number(form.play), training_minutes: number(form.training) } : null });
      if (!alive.current) return; setReceipt(true);
      try { await reload(); } catch (error) { if (alive.current) setReadError(error instanceof Error ? error.message : '保存后的读取失败'); }
    } finally { if (alive.current) setSaving(false); }
  };
  const actual = data.data?.daily.active_minutes, target = data.data?.goals.goals?.targets?.active_minutes;
  const plan = data.data?.goals.goals?.plan;
  const field = (label: string, name: string, numeric = true) => <Field label={label} value={String(form[name] ?? '')} editable={canWrite && !saving && !receipt} keyboardType={numeric ? 'decimal-pad' : 'default'} onChangeText={(value: string) => edit({ [name]: value })} />;
  const selectedVersion = route?.params?.plan;
  useEffect(() => { if (selectedVersion && base && !dirty && canWrite) { setDirty(true); setForm(current => ({ ...current, enabled: true, name: selectedVersion.title, contentVersion: `${selectedVersion.id}@${selectedVersion.content_version}`, walk: String(selectedVersion.walk_minutes ?? ''), play: String(selectedVersion.play_minutes ?? ''), training: String(selectedVersion.training_minutes ?? '') })); } }, [selectedVersion, !!base]);
  return <Page screenId={screenId} navigation={navigation} title={screenId === '40' ? 'Made for little adventures.' : 'A plan with room to sniff.'} subtitle={screenId === '40' ? `EXERCISE / ${pet.name}’s daily movement` : 'TODAY’S PLAN / Confirm your own guide'} footer={<Button title={screenId === '40' ? `Make a plan for ${pet.name}` : receipt ? 'Read saved plan again' : 'Save today’s plan'} disabled={screenId === '41' && (!canWrite || !base || saving)} onPress={screenId === '40' ? () => go(navigation, '41') : undefined} run={screenId === '41' ? receipt ? reload : save : undefined} />}>
    <State value={data} retry={data.refresh} />
    {screenId === '40' ? <><Card tone="sage" title={`${actual ?? 'Unknown'} of ${target ?? 'unknown'} active minutes`}><Body>{actual === null || actual === undefined ? 'No measured activity yet. A missing value is not zero.' : target == null ? 'Activity recorded. No daily target has been set.' : 'Actual activity and your chosen target are shown separately.'}</Body><Caption>{timezone} · {data.data?.daily.data_status ?? 'Coverage unknown'} · {data.data?.daily.sources?.join(', ') ?? 'Source not available'}</Caption></Card>
      {plan ? <>{[['walk_minutes', 'Sniff walk'], ['play_minutes', 'Play together'], ['training_minutes', 'Gentle training']].map(([key, title]) => <Row key={key} title={title} subtitle={`${plan[key] ?? 'Unknown'} min · planned, not completed activity`} onPress={() => go(navigation, '41')} />)}</> : <Row title="Make room for your own routine" subtitle="No plan saved yet" onPress={() => go(navigation, '41')} />}
      <Row title="Notice, listen, learn" subtitle="Open the behavior journal" onPress={() => go(navigation, '42')} /></> : <>
      {form.enabled ? <><Caption>{form.name || 'Your chosen plan'} · {dirty ? 'Draft · save to confirm' : 'Saved plan'}</Caption>{[['walk', 'Sniff walk'], ['play', 'Play together'], ['training', 'Gentle training']].map(([key, title]) => <Row key={key} title={title} subtitle={`${form[key] === '' ? 'Unknown' : form[key]} min · planned, not completed activity`} />)}</> : <Caption>No plan selected. Choose a published guide or customize your own.</Caption>}
      {(!form.enabled || customizing) && <><State value={plans} retry={plans.refresh} />
        {(plans.data?.items ?? []).map((row: Data) => <Row key={row.id} title={row.title} subtitle={row.exercise_plan && canWrite ? 'Choose to fill a draft. Save separately.' : 'Read this published plan'} disabled={saving || receipt} onPress={() => row.exercise_plan && canWrite ? edit({ enabled: true, name: row.title, contentVersion: `${row.id}@${row.content_version}`, walk: String(row.exercise_plan.walk_minutes), play: String(row.exercise_plan.play_minutes), training: String(row.exercise_plan.training_minutes) }) : go(navigation, '49', { contentId: row.id })} />)}
        {!plans.loading && !plans.error && !plans.data?.items?.length && <Notice text="暂无已发布运动计划，可以自行填写目标和计划。" />}
      </>}
      {!canWrite && <Notice text="当前为只读成员，不能修改共享目标与计划。" />}
      <Card tone="sage" title="Follow their lead"><Body>A saved plan is a guide, never a record of activity completed. Adapt it to your companion and professional guidance.</Body></Card>
      {!customizing && <Button title="Customize plan" secondary disabled={!canWrite || !base || saving || receipt} onPress={() => { editSnapshot.current = { form: { ...form }, dirty, base }; setCustomizing(true); }} />}
      {customizing && <>{field('Active minutes goal (optional)', 'active')}{field('Steps goal (optional)', 'steps')}{field('Intake kcal goal (optional)', 'kcal')}
        <View style={s.pills}><Pill label="No plan" selected={!form.enabled} disabled={!canWrite || saving || receipt} onPress={() => edit({ enabled: false })} /><Pill label="Use a plan" selected={!!form.enabled} disabled={!canWrite || saving || receipt} onPress={() => edit({ enabled: true })} /></View>
        {form.enabled && <>{field('Plan name', 'name', false)}{field('Source version', 'contentVersion', false)}{field('Sniff walk · minutes', 'walk')}{field('Play · minutes', 'play')}{field('Training · minutes', 'training')}</>}
        <Button title="Cancel plan edits" secondary disabled={saving || receipt} onPress={() => { const snapshot = editSnapshot.current; if (snapshot && snapshot.base?.local_date === base?.local_date && snapshot.base?.effective_date_version === base?.effective_date_version) { setForm(snapshot.form); setDirty(snapshot.dirty); } setCustomizing(false); }} />
        <Button title="Read latest goals (discard draft)" secondary disabled={saving} run={reload} />
      </>}
      <Notice text="选用计划只填写草稿，不会自动保存或改写活动事实。留空目标保持未知。" />
      {receipt && <Notice text="计划已保存；请只重试读取，不要重复提交。" tone="success" />}{readError && <Notice text={readError} tone="error" />}
    </>}
  </Page>;
}

function Journal({ screenId, navigation, route, pet, canWrite }: Props & { pet: Data; canWrite: boolean }) {
  const { api } = useApp(), alive = useAlive(), timezone = pet.effective_timezone ?? pet.timezone ?? 'Asia/Shanghai';
  const [recordCursor, setRecordCursor] = useState(''), [taskCursor, setTaskCursor] = useState(''), [recordId, setRecordId] = useState(route?.params?.recordId ?? ''), [taskId, setTaskId] = useState(route?.params?.taskId ?? '');
  const range = useResource(() => loadSafetyRange(api, pet.id, 'week', timezone), [api, pet.id, timezone]);
  const records = useResource<Data>(() => range.data ? api.get(`/pets/${pet.id}/behavior-records${query({ from: range.data.from, to: range.data.to, limit: 15, cursor: recordCursor })}`) : Promise.resolve({ items: [] }), [api, pet.id, range.data, recordCursor]);
  const tasks = useResource<Data>(() => range.data ? api.get(`/pets/${pet.id}/interpretations${query({ from: range.data.from, to: range.data.to, limit: 15, cursor: taskCursor })}`) : Promise.resolve({ items: [] }), [api, pet.id, range.data, taskCursor]);
  const media = useResource<Data>(() => api.get(`/pets/${pet.id}/media?limit=15`), [api, pet.id]);
  const scoped = async (url: string) => { const row = await api.get(url); if (row.pet_id !== pet.id) throw new Error('来源不属于当前宠物。'); return row; };
  const record = useResource<Data | null>(() => recordId ? scoped(`/behavior-records/${encodeURIComponent(recordId)}`) : Promise.resolve(null), [api, pet.id, recordId]);
  const task = useResource<Data | null>(() => taskId ? scoped(`/interpretations/${encodeURIComponent(taskId)}`) : Promise.resolve(null), [api, pet.id, taskId]);
  const [labels, setLabels] = useState(''), [notes, setNotes] = useState(''), [start, setStart] = useState(() => new Date(Date.now() - 60000).toISOString()), [end, setEnd] = useState(() => new Date().toISOString()), [mediaId, setMediaId] = useState(route?.params?.mediaId ?? ''), [saving, setSaving] = useState(false);
  const [recordingForm, setRecordingForm] = useState(false);
  const taskSelection = useRef(0);
  const chooseTask = (id: string) => { taskSelection.current++; setTaskId(id); };
  const selected = record.data?.id === recordId ? record.data : null, interpretation = task.data?.id === taskId ? task.data : null;
  const refresh = async () => { await Promise.all([range.refresh(), record.refresh(), task.refresh(), media.refresh()]); };
  useEffect(() => navigation.addListener?.('focus', () => { void refresh(); }), [navigation]);
  const saveRecord = async () => { setSaving(true); try { const row = await api.post(`/pets/${pet.id}/behavior-records`, { labels: labels.split(',').map(item => item.trim()).filter(Boolean), start_at: iso(start), end_at: iso(end), notes, media_id: mediaId || null }); if (alive.current) go(navigation, '43', { recordId: row.id }); } finally { if (alive.current) setSaving(false); } };
  const createTask = async () => { if (!mediaId) throw new Error('请先选择当前宠物的真实媒体。'); setSaving(true); try { const row = await api.post(`/pets/${pet.id}/interpretations`, { media_id: mediaId, behavior_record_id: selected && selected.media_id === mediaId ? selected.id : null, background: [], notes }); if (alive.current) go(navigation, '45', { taskId: row.id }); } finally { if (alive.current) setSaving(false); } };
  const title = screenId === '42' ? 'Understand their world.' : screenId === '43' ? 'What was happening?' : screenId === '45' ? 'Possible interpretation' : 'Patterns over time.';
  const subtitle = screenId === '42' ? 'BEHAVIOR / Listen, notice, learn' : screenId === '43' ? 'BEHAVIOR DETAIL / Owner observations' : screenId === '45' ? 'INTERPRETATION / Evidence and uncertainty' : 'BEHAVIOR HISTORY / Your saved journal';
  return <Page screenId={screenId} navigation={navigation} title={title} titleStyle={screenId === '42' ? { fontSize: 26, lineHeight: 32 } : undefined} subtitle={subtitle} footer={<Button title={screenId === '42' ? 'Record or import a moment' : screenId === '46' ? 'Explore helpful tips' : screenId === '45' ? 'What could help?' : 'Record another observation'} onPress={() => screenId === '42' ? go(navigation, '44') : screenId === '46' || screenId === '45' ? go(navigation, '47') : setRecordingForm(true)} />}>
    <State value={range} retry={range.refresh} />
    {screenId === '42' && <><Card tone="sage" title="A bark is only one clue."><Body>Look at {pet.name}’s posture, the setting and what happened just before.</Body></Card><Row title="Today’s behavior" subtitle="Open observations from your journal" onPress={() => go(navigation, '43')} /><Row title="Record or import a moment" subtitle="Choose an actual clip, or keep a written observation" onPress={() => go(navigation, '44')} /><Row title="Behavior history" subtitle="Look for patterns, not labels" onPress={() => go(navigation, '46')} /><Row title="Helpful tips" subtitle="Published guidance and its sources" onPress={() => go(navigation, '47')} /><Row title="Daily movement" subtitle="Actual activity and your own plan" onPress={() => go(navigation, '40')} /></>}
    {['43', '46'].includes(screenId) && <><State value={records} retry={records.refresh} />
      {!recordId && (records.data?.items ?? []).map((row: Data) => <Row key={row.id} title={row.labels?.join(' · ') || 'Written observation'} subtitle={`${row.start_at} · ${row.notes || 'No notes'}`} onPress={() => screenId === '46' ? go(navigation, '43', { recordId: row.id }) : setRecordId(row.id)} />)}
      {!recordId && !records.loading && !records.error && !records.data?.items?.length && <Notice text="本时间窗暂无记录。可以保存人工观察，不要求媒体或项圈。" />}
      {records.data?.next_cursor && <Button title="More observations" secondary onPress={() => setRecordCursor(records.data?.next_cursor ?? '')} />}
      <State value={record} retry={record.refresh} />
      {selected && <>{selected.media_id ? <><MediaPreview id={selected.media_id} petId={pet.id} /><Caption>Actual saved media · playback requires authorization</Caption></> : <Card tone="sage" title="A written moment"><Body>No audio or video is attached to this observation.</Body></Card>}
        <Row title="Context" subtitle={`${selected.start_at} → ${selected.end_at}`} /><Row title="What you noticed" subtitle={selected.labels?.join(' · ') || 'No labels'} /><Card tone="sage" title="Context comes first"><Body>{selected.notes || 'No additional notes were recorded.'}</Body></Card>
        <Button title="Ask about this observation" secondary disabled={!!selected.media_deleted_at} onPress={() => go(navigation, '51', { kind: 'behavior', behaviorRecordId: selected.id, referenceTitle: selected.labels?.join(', ') || 'Written observation' })} />
        {!!selected.media_id && <Button title="Choose this media for an interpretation" secondary onPress={() => { setMediaId(selected.media_id); go(navigation, '45', { mediaId: selected.media_id, recordId: selected.id }); }} />}</>}
      <Button title="Write an observation" secondary disabled={!canWrite} onPress={() => setRecordingForm(!recordingForm)} />
      {recordingForm && <Card title="What did you notice?">{!canWrite && <Notice text="只读成员不能保存共享观察。" />}
        <Field label="Labels (comma separated)" value={labels} editable={canWrite && !saving} onChangeText={setLabels} /><Field label="Context and observations" value={notes} editable={canWrite && !saving} multiline onChangeText={setNotes} /><Field label="Moment started (time with timezone)" value={start} editable={canWrite && !saving} onChangeText={setStart} /><Field label="Moment ended (time with timezone)" value={end} editable={canWrite && !saving} onChangeText={setEnd} /><Button title="Save observation" disabled={!canWrite || saving} run={saveRecord} /></Card>}
      {screenId === '46' && <Card tone="sage" title="Notice what helps"><Body>Read your saved context over time. No emotion, health label or score is inferred here.</Body></Card>}
    </>}
    {screenId === '45' && <><Pill label="UNCERTAIN · Not a translation" />
      <State value={task} retry={task.refresh} />
      {interpretation ? <><Card tone="sage" title={status(interpretation.status)}><Body>{interpretation.result?.text ?? interpretation.error_code ?? 'Your request has not produced a result yet.'}</Body><Caption>Attempt {interpretation.attempt} · {interpretation.execution_source ?? interpretation.captured_mode}</Caption></Card>
        {interpretation.execution_source === 'offline_demo' && <Notice text="合成固定演示：未分析音视频，不是真实AI，不构成健康或情绪结论。" />}
        <Button title="Read current result" secondary run={task.refresh} />
        {canWrite && ['pending', 'processing'].includes(interpretation.status) && <Button title="Cancel this interpretation" secondary run={async () => { const selection = taskSelection.current; await api.post(`/interpretations/${interpretation.id}/cancel`, {}); if (alive.current && selection === taskSelection.current) await task.refresh(); }} />}
        {canWrite && ['failed', 'cancelled'].includes(interpretation.status) && interpretation.media_id && <Button title="Retry this attempt" run={async () => { const selection = taskSelection.current; await api.post(`/interpretations/${interpretation.id}/retry`, { expected_attempt: interpretation.attempt }); if (alive.current && selection === taskSelection.current) await task.refresh(); }} />}
        {interpretation.status === 'succeeded' && !interpretation.error_code && interpretation.media_id && <><Row title="Check the rest of the story" subtitle="View the actual source and prepared evidence" onPress={() => navigation.navigate('Behavior')} /><Button title="Ask about this result" secondary onPress={() => go(navigation, '51', { kind: 'behavior', interpretationId: interpretation.id, referenceTitle: 'Interpretation result' })} /><InterpretationFeedback key={`${interpretation.id}:${interpretation.attempt}`} task={interpretation} canWrite={canWrite} /></>}
      </> : <><Card tone="sage" title="Choose a saved source"><Body>A real interpretation request needs an authorized clip. It is separate from recording or uploading.</Body></Card><State value={media} retry={media.refresh} />
        {(media.data?.items ?? []).map((row: Data) => <Row key={row.id} title={row.filename} subtitle={`${row.duration_seconds ?? 'Unknown'} seconds · ${row.captured_at}`} tone={mediaId === row.id ? 'sage' : 'white'} onPress={() => setMediaId(row.id)} />)}
        {!media.loading && !media.error && !media.data?.items?.length && <Notice text="暂无可用媒体，请先录音或导入；这里不制造示例文件。" />}
        <Field label="Interpretation context (optional)" value={notes} editable={!saving} onChangeText={setNotes} multiline /><Button title="Request interpretation" disabled={!canWrite || !mediaId || saving} run={createTask} /><Button title="Record or import first" secondary onPress={() => go(navigation, '44')} /></>}
      <State value={tasks} retry={tasks.refresh} />{(tasks.data?.items ?? []).map((row: Data) => <Row key={row.id} title={`${status(row.status)} · attempt ${row.attempt}`} subtitle={row.created_at} onPress={() => chooseTask(row.id)} />)}
      {tasks.data?.next_cursor && <Button title="More interpretations" secondary onPress={() => setTaskCursor(tasks.data?.next_cursor ?? '')} />}
      <Body>A clip alone cannot reliably tell an emotion. Source deletion or permission changes invalidate old results.</Body>
    </>}
  </Page>;
}

function InterpretationFeedback({ task, canWrite }: { task: Data; canWrite: boolean }) {
  const { api } = useApp(), alive = useAlive();
  const [feedback, setFeedback] = useState(''), [acknowledged, setAcknowledged] = useState(false), [saving, setSaving] = useState(false);
  const history = useResource<Data>(() => api.get(`/interpretations/${task.id}/feedback${query({ expected_attempt: task.attempt, limit: 15 })}`), [api, task.id, task.attempt]);
  return <><State value={history} retry={history.refresh} />{(history.data?.items ?? []).map((row: Data) => <Row key={row.id} title={row.assessment} subtitle={`${row.comment} · ${row.created_at}`} />)}
    {acknowledged && <Notice text={history.loading ? '反馈已保存，正在重新读取…' : history.error ? '反馈已保存，但读取失败；请只重试读取。' : '反馈已保存，已重新读取本人当前尝试的反馈。'} tone="success" />}
    {canWrite && <><Field label="Your feedback on this attempt" value={feedback} editable={!saving && !acknowledged} onChangeText={setFeedback} multiline /><Button title="Save feedback" disabled={saving || acknowledged || !feedback.trim()} run={async () => {
      setSaving(true);
      try { await api.post(`/interpretations/${task.id}/feedback`, { expected_attempt: task.attempt, assessment: 'other', comment: feedback.trim() }); if (!alive.current) return; setAcknowledged(true); await history.refresh(); }
      finally { if (alive.current) setSaving(false); }
    }} />{acknowledged && <Button title="Write another feedback" secondary disabled={saving} onPress={() => { setFeedback(''); setAcknowledged(false); }} />}</>}
  </>;
}

function Capture({ screenId, navigation, pet, canWrite }: Props & { pet: Data; canWrite: boolean }) {
  return <Page screenId={screenId} navigation={navigation} title={screenId === '44' ? 'Record a bark' : 'Audio recording'} subtitle={screenId === '44' ? 'AUDIO OR VIDEO / Your choice' : 'FOREGROUND AUDIO / Confirm before upload'} footer={<Button title="Back to the journal" secondary onPress={() => go(navigation, '42')} />}>
    {screenId === '44' ? <><Asset name="record-bark-waveform" /><Caption>STATIC SAMPLE · Not your recording</Caption><Body>Keep a short moment and its context. Recording, uploading and interpretation are separate choices.</Body><Button title="Record audio or import a clip" secondary disabled={!canWrite} onPress={() => go(navigation, '44a')} /><Button title="Explore the video demo" onPress={() => go(navigation, '44b')} /><Button title="Try a sample bark" onPress={() => go(navigation, '44a', { demo: true })} /><Button title="Choose existing media" secondary onPress={() => go(navigation, '45')} /><Notice text="原生相机与录像未接入；视频只可系统导入，或查看明确标记的本地演示。" /></> : <><Card tone="sage" title="One moment, with context"><Body>No waveform is invented for your clip. Actual recording controls and elapsed time appear only when the native recorder runs.</Body></Card>{canWrite ? <MediaCapture petId={pet.id} onSaved={media => go(navigation, '45', { mediaId: media.id })} /> : <Notice text="当前为只读成员，不能录音或上传。" />}<Notice text="本地Web回归不代表Android麦克风、文件选择器或播放验收。媒体仍限60秒/20MiB，前台录音约59秒停止。" /></>}
  </Page>;
}

function AudioDemo({ screenId, navigation }: Props) {
  const recording = screenId === '44a';
  return <Page screenId={screenId} navigation={navigation} title={recording ? 'Audio recording' : 'Possibly: alert or curious.'} subtitle={recording ? 'SIMULATED AUDIO / No microphone access' : 'ILLUSTRATIVE INTERPRETATION / Not a model result'} footer={<><Button title={recording ? 'Stop and explore the sample' : 'What could help?'} onPress={() => go(navigation, recording ? '45' : '47', { demo: true })} />{recording && <Button title="Cancel demo" secondary onPress={() => go(navigation, '44')} />}</>}>
    {recording ? <><Asset name="audio-recording-waveform" /><Heading>00:06 · A preset sample illustration</Heading><Body>This demo uses an exported waveform. No audio is recorded, played or uploaded.</Body></> : <><Pill label="LOW CERTAINTY · Not a translation" /><Card tone="sage" title="“Something caught my attention.”"><Body>Short, repeated barks can happen when a dog notices a new sound or visitor. This is only one illustrative explanation from the prototype.</Body></Card><Row title="Check the rest of the story" subtitle="A real clip needs posture, context and an authorized source" onPress={() => go(navigation, '43')} /><Body>A bark alone cannot reliably tell an emotion. This sample was not produced by an AI model and is not a diagnosis or validated prediction.</Body></>}
    <Notice text="仅本地原型演示；未申请麦克风、未录音上传、未调用模型、未保存解释。实际媒体与任务请使用独立入口。" />
    <Button title="Use an actual saved clip" secondary onPress={() => go(navigation, '45')} />
  </Page>;
}

function VideoDemo({ screenId, navigation }: Props) {
  const index = ['44b', '44c', '44d', '44e'].indexOf(screenId);
  const title = ['Record video', 'Video recording', 'Review sample video', 'Possible interpretation'][index];
  const action = ['Start video demo', 'Stop video demo', 'Read illustrative interpretation', 'Record another'][index];
  const asset = ['video-preview', 'video-recording', 'video-review'][index];
  return <Page screenId={screenId} navigation={navigation} title={title} subtitle={index === 3 ? 'LOCAL DEMO / Not a model result' : 'SIMULATED VIDEO / No camera access'} footer={<><Button title={action} onPress={() => go(navigation, ['44c', '44d', '44e', '44'][index])} /><Button title={index === 2 ? 'Retake demo' : index === 3 ? 'Helpful tips' : 'Cancel'} secondary onPress={() => go(navigation, index === 2 ? '44b' : index === 3 ? '47' : '44')} /></>}>
    {index < 3 ? <><Asset name={asset} /><Body>{index === 2 ? 'This illustration is a sample scene, not a recording. No audio or video was captured.' : 'This local walkthrough uses the exported sample illustration. No camera, microphone, recording or upload is used.'}</Body></> : <><Card tone="sage" title="Observed in this sample"><Body>Illustration only: a seated dog looks toward a sound. Sound, movement and posture would need actual evidence before any interpretation.</Body></Card><Body>No model was run, no clip was recorded and no result was saved. This is not a diagnosis or validated prediction.</Body></>}
    <Notice text="仅本地原型演示；按钮只切换说明状态，不会录制、上传、调用AI或对外发送。" />
  </Page>;
}

function Tips({ screenId, navigation }: Props) {
  const { api } = useApp();
  const tips = useResource<Data>(() => api.get('/content?kind=tip&category=behavior&limit=15'), [api]);
  return <Page screenId={screenId} navigation={navigation} title="A little more understanding." subtitle="HELPFUL TIPS / Start small" footer={<Button title="Learn to read the whole story" onPress={() => go(navigation, '48')} />}>
    <State value={tips} retry={tips.refresh} />{(tips.data?.items ?? []).map((row: Data, i: number) => <Row key={row.id} title={`${String(i + 1).padStart(2, '0')}  ${row.title}`} subtitle={row.summary} onPress={() => go(navigation, '49', { contentId: row.id })} />)}
    {!tips.loading && !tips.error && !tips.data?.items?.length && <Card title="No published tips yet"><Body>This space stays empty until reviewed guidance is available. No sample advice is presented as a published source.</Body></Card>}
    <Card tone="sage" title="When to ask for help"><Body>Read the source, its intended scope and review information. Persistent or sudden changes need appropriate professional support.</Body></Card>
  </Page>;
}

const s = StyleSheet.create({ pills: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' } });
