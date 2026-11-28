import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Asset } from './assets';
import { Body, Button, Caption, Card, Field, Heading, Notice, Page, Pill, Row, palette, go } from './ui';

type Data = Record<string, any>;
type Props = { screenId: string; navigation: any; route?: { params?: Data } };
const query = (value: Data) => '?' + Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
function useAlive() { const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); return alive; }
function State({ value, retry }: { value: { loading: boolean; error: string | null }; retry?: () => any }) { return <>{value.loading && <Caption>Loading…</Caption>}{value.error && <><Notice text={value.error} tone="error" />{retry && <Button title="Try again" secondary onPress={retry} />}</>}</>; }

export function PawchLearnScreen(props: Props) {
  const { api, user, pet } = useApp();
  const params = props.route?.params ?? {};
  const key = `${api.baseUrl}:${user?.id}:${pet?.id}:${props.screenId}:${params.contentId ?? ''}:${params.contentVersion ?? ''}:${params.conversationId ?? ''}:${params.lessonId ?? ''}:${params.lessonVersion ?? ''}:${params.behaviorRecordId ?? ''}:${params.interpretationId ?? ''}`;
  if (props.screenId === '51') return <Conversation key={key} {...props} />;
  if (props.screenId === '49') return <Reading key={key} {...props} />;
  return <Catalog key={key} {...props} />;
}

function Catalog({ screenId, navigation }: Props) {
  const { api } = useApp();
  const [kind, setKind] = useState(screenId === '48' ? 'lesson' : ''), [search, setSearch] = useState(''), [filters, setFilters] = useState<Data>({ kind: screenId === '48' ? 'lesson' : '' }), [cursor, setCursor] = useState('');
  const [showFilters, setShowFilters] = useState(false), [showJournal, setShowJournal] = useState(false);
  const catalog = useResource<Data>(() => api.get(`/content${query({ ...filters, limit: 15, cursor })}`), [api, filters, cursor]);
  const progress = useResource<Data>(() => api.get('/learning-progress?limit=15'), [api]);
  useEffect(() => navigation.addListener?.('focus', () => { void catalog.refresh(); void progress.refresh(); }), [navigation, catalog.refresh, progress.refresh]);
  const featured = catalog.data?.items?.find((row: Data) => row.kind === 'lesson');
  const remaining = (catalog.data?.items ?? []).filter((row: Data) => screenId !== '48' || row.id !== featured?.id);
  const items = screenId === '48' ? remaining.slice(0, 1) : remaining;
  const open = (row: Data) => go(navigation, '49', { contentId: row.id, contentVersion: row.content_version });
  return <Page screenId={screenId} navigation={navigation} title={screenId === '48' ? 'Know them a little better.' : 'Your field library.'} subtitle={screenId === '48' ? 'LEARN / A field guide to life together' : 'LIBRARY / Practical, kind, curious'} footer={<Button title={screenId === '48' ? 'Start today’s lesson' : 'Back to featured learning'} disabled={screenId === '48' && !featured} onPress={() => screenId === '48' && featured ? open(featured) : go(navigation, '48')} />}>
    <State value={catalog} retry={catalog.refresh} />
    {screenId === '48' && featured && <Card tone="sage"><Caption>TODAY’S FIELD NOTE</Caption><Heading>{featured.title}</Heading><Body>{featured.summary || 'Read the published lesson and its sources.'}</Body><View style={s.featured}><Caption>Version {featured.content_version} · {featured.category}</Caption><Asset name="learn-baku" /></View></Card>}
    {screenId === '50' && <><Pressable accessibilityRole="button" accessibilityLabel="Search & filters" onPress={() => setShowFilters(!showFilters)}><Caption>{showFilters ? 'Hide search & filters −' : 'Search & filters +'}</Caption></Pressable>
      {showFilters && <><Field label="Search the library" value={search} onChangeText={setSearch} placeholder="Behavior, nutrition, everyday care" /><View style={s.pills}>{[['', 'All'], ['lesson', 'Lessons'], ['tip', 'Tips'], ['guidance', 'Guidance'], ['plan', 'Plans']].map(([value, label]) => <Pill key={value} label={label} selected={kind === value} onPress={() => { setKind(value); setCursor(''); setFilters({ kind: value, q: search.trim() }); }} />)}</View><Button title="Search published content" secondary onPress={() => { setCursor(''); setFilters({ kind, q: search.trim() }); }} /></>}
    </>}
    {items.map((row: Data, index: number) => <Row key={row.id} title={row.title} subtitle={`${row.category} · ${row.kind} · version ${row.content_version}`} tone={screenId === '50' && index === 0 ? 'sage' : 'white'} onPress={() => open(row)} />)}
    {!catalog.loading && !catalog.error && !catalog.data?.items?.length && <Card title="A little room to learn"><Body>No reviewed content has been published in this selection yet.</Body><Notice text="不会使用原型课程样例冒充已授权、已发布内容。" /></Card>}
    {screenId === '50' && <>{catalog.data?.next_cursor && <Button title="More from the library" secondary onPress={() => setCursor(catalog.data?.next_cursor ?? '')} />}{cursor && <Button title="First library page" secondary onPress={() => setCursor('')} />}</>}
    {screenId === '48' && <><Row title="Browse the library" subtitle="Behavior, nutrition and everyday care" onPress={() => go(navigation, '50')} /><Pressable accessibilityRole="button" accessibilityLabel="Learning history & options" onPress={() => setShowJournal(!showJournal)}><Caption>{showJournal ? 'Hide learning history −' : 'Learning history & options +'}</Caption></Pressable>
      {showJournal && <><Row title="Your learning journal" subtitle="Review progress you explicitly saved" onPress={() => navigation.navigate('Learning')} /><State value={progress} retry={progress.refresh} /><Caption>{progress.data?.counts?.learned_count != null ? `Current published lessons learned · ${progress.data.counts.learned_count} of ${progress.data.counts.available_count ?? 'unknown'}` : 'Learning count is unavailable. Learning is saved only when you choose to record it.'}</Caption></>}
    </>}
  </Page>;
}

function Reading({ screenId, navigation, route }: Props) {
  const { api } = useApp(), alive = useAlive();
  const id = route?.params?.contentId, version = route?.params?.contentVersion;
  const detail = useResource<Data | null>(async () => {
    if (!id) return null;
    const row = await api.get(`/content/${encodeURIComponent(id)}${query({ version })}`);
    if (row.id !== id) throw new Error('内容版本与选择不一致，请重读。'); return row;
  }, [api, id, version]);
  useEffect(() => navigation.addListener?.('focus', () => { void detail.refresh(); }), [navigation, detail.refresh]);
  const [completed, setCompleted] = useState<string[]>([]), [learned, setLearned] = useState(false), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false), [baseVersion, setBaseVersion] = useState(0);
  const current = detail.data;
  useEffect(() => { if (current && !dirty && !saved) { setCompleted(current.progress?.completed_step_ids ?? []); setLearned(!!current.progress?.learned); setBaseVersion(current.progress?.version ?? 0); } }, [current, dirty, saved]);
  const isLesson = current?.kind === 'lesson', historical = current && current.content_version !== current.current_version;
  const save = async () => {
    if (!current || !isLesson || historical) return; setSaving(true);
    try {
      const receipt = await api.put(`/lessons/${current.id}/progress`, { content_version: current.content_version, completed_step_ids: completed, learned, expected_version: baseVersion });
      if (!alive.current) return; setBaseVersion(receipt.version); setDirty(false); setSaved(true); await detail.refresh();
    } finally { if (alive.current) setSaving(false); }
  };
  const readLatest = async () => { if (!id) return; go(navigation, '49', { contentId: id }); };
  const ask = () => current && go(navigation, '51', current.kind === 'lesson' ? { kind: 'lesson', lessonId: current.id, lessonVersion: current.content_version, lessonTitle: current.title } : { kind: 'activity' });
  const changeLearned = (value: boolean) => { if (saving) return; setLearned(value); setDirty(true); setSaved(false); };
  return <Page screenId={screenId} navigation={navigation} title={current?.title ?? 'Reading together'} subtitle={current ? `${current.kind.toUpperCase()} / Version ${current.content_version} / ${current.category}` : 'PUBLISHED CONTENT / Sources matter'} footer={<Button title={isLesson ? 'Ask Pawch AI about this' : 'Choose a context and ask'} disabled={!current} onPress={ask} />}>
    <State value={detail} retry={detail.refresh} />
    {saved && <Notice text={detail.error ? '学习记录已保存，但读取暂时失败；请只重试读取。' : '本人学习记录已保存；不会把阅读打开次数当作完成。'} tone="success" />}
    {!id && <><Notice text="请先选择已发布内容，不预填原型正文为正式课程。" /><Button title="Choose from the library" onPress={() => go(navigation, '50')} /></>}
    {current && <><View style={s.progressTrack}><View style={[s.progressFill, { width: `${current.lesson?.steps?.length ? Math.min(100, completed.length / current.lesson.steps.length * 100) : 0}%` }]} /></View>{isLesson && <Caption>{completed.length} of {current.lesson?.steps?.length ?? 0} steps explicitly marked complete</Caption>}
      {historical && <Notice text="正在阅读历史版本；只读本人当时进度。新版本不会继承旧进度。" tone="warning" />}
      <Text selectable style={s.article}>{current.body}</Text>
      {(current.lesson?.steps ?? []).map((step: Data) => <Card key={step.id} tone="sage" title={step.title}><Body>{step.body}</Body><View style={s.toggle}><Caption>I completed this step</Caption><Switch accessibilityLabel={`Complete step: ${step.title}`} value={completed.includes(step.id)} disabled={!!historical || saving} onValueChange={value => { setDirty(true); setSaved(false); setCompleted(previous => value ? [...previous, step.id] : previous.filter(id => id !== step.id)); }} /></View></Card>)}
      {isLesson && <><View style={s.toggle}><Body>I have learned this version</Body><Switch accessibilityLabel="I have learned this version" value={learned} onValueChange={changeLearned} disabled={!!historical || saving} /></View>
        <Button title={saved && detail.error ? 'Read saved progress again' : 'Save my learning progress'} secondary disabled={!!historical || saving || (saved && !dirty && !detail.error)} run={saved && detail.error ? detail.refresh : save} />
      </>}
      {current.exercise_plan && <><Card tone="sage" title="A guide, not completed activity"><Body>Walk {current.exercise_plan.walk_minutes} min · play {current.exercise_plan.play_minutes} min · training {current.exercise_plan.training_minutes} min</Body></Card><Button title="Use this plan as a draft" secondary onPress={() => go(navigation, '41', { plan: { id: current.id, title: current.title, content_version: current.content_version, ...current.exercise_plan } })} /></>}
      <Card tone="sage" title="Source & scope"><Body>{current.applicability}</Body>{(current.sources ?? []).map((source: Data, index: number) => <Caption key={index}>{source.title} · {source.reference}</Caption>)}<Caption>{current.review?.status === 'reviewed' ? `Reviewed · ${current.review.reviewer} · ${current.review.reviewed_at}` : 'Review information unavailable'}</Caption></Card>
      <Button title="Read latest published version" secondary run={readLatest} />
      <Notice text="正文、来源和版本均来自已发布内容。外部视频如有提供，仍通过既有明确确认入口；本页不自动联网播放。" /><Button title="More content and video options" secondary onPress={() => navigation.navigate('Learning')} />
    </>}
  </Page>;
}

function Conversation({ screenId, navigation, route }: Props) {
  const { api, pet } = useApp(), alive = useAlive();
  const [conversation, setConversation] = useState(route?.params?.conversationId ?? ''), [cursor, setCursor] = useState(''), [messageCursor, setMessageCursor] = useState('');
  const [question, setQuestion] = useState(''), [contextKind, setContextKind] = useState(route?.params?.kind ?? 'activity'), [date, setDate] = useState(''), [timezone, setTimezone] = useState(pet?.effective_timezone ?? 'Asia/Shanghai');
  const [messageId, setMessageId] = useState(''), [saving, setSaving] = useState(false), [showConversations, setShowConversations] = useState(false), [showOptions, setShowOptions] = useState(false);
  const conversationSequence = useRef(0), questionRevision = useRef(0), messageSequence = useRef(0);
  const conversations = useResource<Data>(() => pet ? api.get(`/pets/${pet.id}/assistant-conversations${query({ limit: 15, cursor })}`) : Promise.resolve({ items: [] }), [api, pet?.id, cursor]);
  const messages = useResource<Data>(() => conversation ? api.get(`/assistant-conversations/${conversation}/messages${query({ limit: 15, cursor: messageCursor })}`).then(page => { if (page.items.some((row: Data) => row.pet_id !== pet?.id || row.conversation_id !== conversation)) throw new Error('消息不属于当前宠物或会话。'); return page; }) : Promise.resolve({ items: [] }), [api, pet?.id, conversation, messageCursor]);
  const selected = useResource<Data | null>(async () => { if (!messageId || !conversation) return null; const row = await api.get(`/assistant-messages/${messageId}`); if (row.pet_id !== pet?.id || row.conversation_id !== conversation || row.id !== messageId) throw new Error('问答来源不属于当前会话。'); return row; }, [api, pet?.id, conversation, messageId]);
  const selectConversation = (id: string) => { conversationSequence.current++; messageSequence.current++; setConversation(id); setMessageCursor(''); setMessageId(''); setShowConversations(false); };
  const refresh = async () => { await Promise.all([messages.refresh(), selected.refresh(), conversations.refresh()]); };
  useEffect(() => navigation.addListener?.('focus', () => { void refresh(); }), [navigation]);
  const lesson = route?.params?.kind === 'lesson' ? { id: route.params.lessonId, version: route.params.lessonVersion, title: route.params.lessonTitle } : null;
  const behavior = route?.params?.kind === 'behavior' ? { id: route.params.interpretationId ?? route.params.behaviorRecordId, key: route.params.interpretationId ? 'interpretation_id' : 'behavior_record_id', title: route.params.referenceTitle } : null;
  const context = () => {
    if (contextKind === 'lesson') { if (!lesson?.id || !Number.isInteger(Number(lesson.version)) || Number(lesson.version) <= 0) throw new Error('请先选择真实课程及版本。'); return { kind: 'lesson', lesson_id: lesson.id, lesson_version: Number(lesson.version), background: [], notes: '' }; }
    if (contextKind === 'behavior') { if (!behavior?.id) throw new Error('请先选择本宠物的有效行为或解释来源。'); return { kind: 'behavior', [behavior.key]: behavior.id, background: [], notes: '' }; }
    if (!['activity', 'body_check_in', 'nutrition'].includes(contextKind)) throw new Error('请重新选择明确上下文。');
    return { kind: contextKind, ...(date.trim() ? { date: date.trim() } : {}), ...(timezone.trim() ? { timezone: timezone.trim() } : {}), background: [], notes: '' };
  };
  const send = async () => {
    if (!pet || !question.trim()) return;
    const chosen = conversationSequence.current, revision = questionRevision.current, selectedMessage = messageSequence.current, chosenContext = context();
    setSaving(true);
    try {
      let id = conversation;
      if (!id) { const row = await api.post(`/pets/${pet.id}/assistant-conversations`, { title: question.trim().slice(0, 80) }); if (!alive.current || chosen !== conversationSequence.current) return; if (row.pet_id !== pet.id) throw new Error('新会话不属于当前宠物。'); id = row.id; setConversation(id); }
      const row = await api.post(`/assistant-conversations/${id}/messages`, { question: question.trim(), context: chosenContext });
      if (!alive.current || chosen !== conversationSequence.current) return;
      if (row.pet_id !== pet.id || row.conversation_id !== id) throw new Error('保存结果不属于当前宠物或会话。');
      if (messageSequence.current === selectedMessage) setMessageId(row.id);
      if (questionRevision.current === revision) setQuestion('');
      await Promise.all([conversations.refresh(), messages.refresh()]);
    } finally { if (alive.current) setSaving(false); }
  };
  const current = selected.data?.id === messageId && selected.data?.conversation_id === conversation ? selected.data : null;
  const list = messages.data?.items ?? [];
  return <Page screenId={screenId} navigation={navigation} title="Ask Pawch AI" subtitle="EXPLICIT CONTEXT / Not veterinary advice" footer={<><Field label="Your question" placeholder="How can I help my companion settle?" value={question} multiline editable={!saving && !!pet} onChangeText={value => { questionRevision.current++; setQuestion(value); }} /><Button title="Send message" disabled={!pet || saving || !question.trim() || question.trim().length > 4000} run={send} /></>}>
    {!pet ? <><Notice text="先选择宠物；本人会话不会跨宠物或家庭成员共享。" /><Button title="Choose your companion" onPress={() => go(navigation, '07')} /></> : <>
      <Caption>真实模型未配置 · offline为合成固定演示，未分析音视频；api模式无模型会明确失败。</Caption>
      <State value={messages} retry={messages.refresh} />
      {list.map((row: Data) => <View key={row.id} style={s.exchange}><View style={s.question}><Text style={s.questionText}>{row.question}</Text></View><View style={s.answer}><Body>{row.result?.text ?? (row.error_code ? `Unable to answer: ${row.error_code}` : `${row.status} · no answer yet`)}</Body><Caption>{row.execution_source === 'offline_demo' ? 'SYNTHETIC FIXED DEMO · no model inference' : `${row.status} · attempt ${row.attempt}`}</Caption><Pressable accessibilityRole="button" accessibilityLabel="Read this message" onPress={() => { messageSequence.current++; setMessageId(row.id); }}><Caption>View request status ›</Caption></Pressable></View></View>)}
      {conversation && !messages.loading && !messages.error && !list.length && <Body>Your conversation is ready. Choose a context before asking.</Body>}
      {messages.data?.next_cursor && <Button title="Older messages" secondary onPress={() => setMessageCursor(messages.data?.next_cursor ?? '')} />}
      {lesson && <Row title="Read the selected lesson" subtitle={`${lesson.title} · version ${lesson.version}`} onPress={() => go(navigation, '49', { contentId: lesson.id, contentVersion: lesson.version })} />}
      <Caption>For {pet.name} · {contextKind === 'lesson' ? `${lesson?.title ?? 'Course'} · version ${lesson?.version ?? 'unknown'}` : contextKind === 'behavior' ? behavior?.title ?? 'Selected observation' : `${contextKind} · ${date.trim() || 'current server day'} · ${timezone}`}</Caption>
      <Button title="Context & conversations" secondary disabled={saving} onPress={() => setShowOptions(!showOptions)} />
      {showOptions && <><View style={s.pills}>{[['activity', 'Activity'], ['body_check_in', 'Body check-in'], ['nutrition', 'Nutrition'], ...(lesson ? [['lesson', 'This lesson']] : []), ...(behavior ? [['behavior', 'This observation']] : [])].map(([value, label]) => <Pill key={value} label={label} selected={contextKind === value} disabled={saving} onPress={() => setContextKind(value)} />)}</View>
        {!['lesson', 'behavior'].includes(contextKind) && <><Field label="Context date (optional YYYY-MM-DD)" value={date} editable={!saving} onChangeText={setDate} /><Field label="Context timezone" value={timezone} editable={!saving} onChangeText={setTimezone} /></>}
        <Button title={showConversations ? 'Hide conversations' : 'Choose a conversation'} secondary disabled={saving} onPress={() => setShowConversations(!showConversations)} />
        {showConversations && <><State value={conversations} retry={conversations.refresh} />{(conversations.data?.items ?? []).map((row: Data) => <Row key={row.id} title={row.title} subtitle={row.updated_at} tone={conversation === row.id ? 'sage' : 'white'} onPress={() => selectConversation(row.id)} />)}{conversations.data?.next_cursor && <Button title="More conversations" secondary onPress={() => setCursor(conversations.data?.next_cursor ?? '')} />}</>}
        {conversation && <Button title="Start a new conversation" secondary disabled={saving} onPress={() => selectConversation('')} />}
        <Row title="More sources and evidence" subtitle="Choose other authorized contexts or review task evidence" onPress={() => navigation.navigate('Assistant')} />
      </>}
      <State value={selected} retry={selected.refresh} />
      {current && current.status !== 'succeeded' && <Card tone="sage" title={`Current request · attempt ${current.attempt}`}><Body>{current.result?.text ?? current.error_code ?? current.status}</Body>
        {['pending', 'processing'].includes(current.status) && <Button title="Cancel pending answer" secondary run={async () => { const choice = messageSequence.current; await api.post(`/assistant-messages/${current.id}/cancel`, {}); if (alive.current && choice === messageSequence.current) await refresh(); }} />}
        {['failed', 'cancelled'].includes(current.status) && <Button title="Retry this answer" run={async () => { const choice = messageSequence.current; await api.post(`/assistant-messages/${current.id}/retry`, { expected_attempt: current.attempt }); if (alive.current && choice === messageSequence.current) await refresh(); }} />}
      </Card>}
      {conversation && <Button title="Read latest messages" secondary run={refresh} />}
    </>}
  </Page>;
}

const s = StyleSheet.create({ pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, featured: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }, progressTrack: { height: 5, borderRadius: 3, backgroundColor: '#DFE5D6', marginBottom: 14 }, progressFill: { height: 5, borderRadius: 3, backgroundColor: palette.forest }, article: { color: palette.forest, fontSize: 17, lineHeight: 25, marginBottom: 18 }, toggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 }, exchange: { gap: 16 }, question: { backgroundColor: palette.forest, borderRadius: 20, padding: 18, marginLeft: 30 }, questionText: { color: palette.white, fontSize: 15, lineHeight: 21 }, answer: { backgroundColor: palette.sage, borderRadius: 20, padding: 18, gap: 10 } });
