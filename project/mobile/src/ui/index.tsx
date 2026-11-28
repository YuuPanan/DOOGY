import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import designTokens from '../../assets/pawch/design-tokens.json';

export const colors = { ink: designTokens.palette.forest, muted: designTokens.palette.inkMuted, primary: designTokens.palette.forest, paper: designTokens.palette.canvas, card: designTokens.palette.white, border: designTokens.palette.sage, danger: '#a33235' };
type Input = React.ComponentRef<typeof TextInput>;
const FocusedInput = createContext<(input: Input | null, active: boolean) => void>(() => {});
export function Page({ title, subtitle, children, loading, onRefresh }: React.PropsWithChildren<{ title?: string; subtitle?: string; loading?: boolean; onRefresh?: () => any }>) {
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null), container = useRef<React.ComponentRef<typeof View>>(null), focused = useRef<Input | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollY = useRef(0), keyboardTop = useRef<number | null>(Keyboard.metrics?.()?.screenY ?? null), revision = useRef(0), alive = useRef(true);
  const [offset, setOffset] = useState(0);
  const invalidate = () => {
    revision.current++;
    if (timer.current) clearTimeout(timer.current);
  };
  const reveal = () => {
    invalidate();
    // KAV and the native keyboard resize on separate layout passes.
    timer.current = setTimeout(() => {
      const request = revision.current, input = focused.current, viewport = scroll.current, startY = scrollY.current;
      if (!input || !viewport || keyboardTop.current === null) return;
      const valid = () => alive.current && keyboardTop.current !== null && revision.current === request && focused.current === input && scroll.current === viewport;
      viewport.measureInWindow((_x, top, _width, height) => {
        if (!valid() || height <= 0) return;
        input.measureInWindow((_left, inputTop, _inputWidth, inputHeight) => {
          if (!valid()) return;
          const bottom = Math.min(top + height, keyboardTop.current ?? Infinity) - 24;
          const visibleHeight = bottom - top;
          if (visibleHeight <= 0 || inputHeight <= 0) return;
          const overlap = inputTop + Math.min(inputHeight, visibleHeight) - bottom;
          if (overlap > 0) viewport.scrollTo({ y: Math.max(0, startY + overlap), animated: true });
        });
      });
    }, 60);
  };
  const focus = useCallback((input: Input | null, active: boolean) => {
    if (active) { focused.current = input; reveal(); }
    else if (focused.current === input) { focused.current = null; invalidate(); }
  }, []);
  useEffect(() => {
    alive.current = true;
    const shown = Keyboard.addListener('keyboardDidShow', event => { keyboardTop.current = event.endCoordinates.screenY; reveal(); });
    const hidden = Keyboard.addListener('keyboardDidHide', () => { keyboardTop.current = null; invalidate(); });
    return () => { alive.current = false; invalidate(); shown.remove(); hidden.remove(); };
  }, []);
  return <SafeAreaView style={s.safe} edges={['bottom', 'left', 'right']}><View ref={container} style={s.safe} onLayout={() => { const view = container.current; view?.measureInWindow((_x, y) => { if (alive.current && view === container.current) { setOffset(y); reveal(); } }); }}><KeyboardAvoidingView style={s.safe} keyboardVerticalOffset={offset} behavior={Platform.OS === 'ios' ? 'padding' : Platform.OS === 'android' ? 'height' : undefined}>
    <ScrollView ref={scroll} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled" onLayout={reveal} onContentSizeChange={reveal} scrollEventThrottle={16}
      onScroll={event => { const y = event.nativeEvent.contentOffset.y; if (scrollY.current !== y) { scrollY.current = y; revision.current++; } }} refreshControl={onRefresh ? <RefreshControl refreshing={!!loading} onRefresh={onRefresh} /> : undefined}>
      <FocusedInput.Provider value={focus}>
      {title && <Text accessibilityRole="header" style={s.pageTitle}>{title}</Text>}{subtitle && <Text style={s.muted}>{subtitle}</Text>}{loading && <ActivityIndicator color={colors.primary} />}{children}
      </FocusedInput.Provider>
    </ScrollView></KeyboardAvoidingView></View></SafeAreaView>;
}
export function Heading({ children }: React.PropsWithChildren) { return <Text accessibilityRole="header" style={s.heading}>{children}</Text>; }
export function Card({ title, children }: React.PropsWithChildren<{ title?: string }>) { return <View style={s.card}>{title && <Heading>{title}</Heading>}{children}</View>; }
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const input = useRef<React.ComponentRef<typeof TextInput>>(null), focus = useContext(FocusedInput);
  useEffect(() => { const current = input.current; return () => focus(current, false); }, [focus]);
  return <View style={s.field}><Text style={s.label}>{label}</Text><TextInput ref={input} accessibilityLabel={label} placeholderTextColor="#85928c" autoCapitalize="none" {...props}
    onFocus={event => { focus(input.current, true); props.onFocus?.(event); }} onBlur={event => { focus(input.current, false); props.onBlur?.(event); }}
    style={[s.input, props.multiline && { minHeight: 86, textAlignVertical: 'top' }, props.style]} /></View>;
}
export function Button({ title, onPress, disabled, variant = 'primary' }: { title: string; onPress: () => any; disabled?: boolean; variant?: 'primary' | 'secondary' | 'danger' }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.button, variant === 'secondary' && s.secondary, variant === 'danger' && s.danger, (pressed || disabled) && { opacity: 0.55 }]}>
    <Text style={[s.buttonText, variant === 'secondary' && { color: colors.ink }]}>{title}</Text></Pressable>;
}
export function Action({ title, run, onDone, success, disabled = false }: { title: string; run: () => Promise<any>; onDone?: (value?: any) => any; success?: string; disabled?: boolean }) {
  const lock = useRef(false), disabledRef = useRef(disabled), [busy, setBusy] = useState(false), [failure, setFailure] = useState(''), [done, setDone] = useState('');
  disabledRef.current = disabled;
  return <View><Button title={busy ? '处理中…' : title} disabled={busy || disabled} onPress={async () => {
    if (disabledRef.current || lock.current) return; lock.current = true; setBusy(true); setFailure(''); setDone('');
    try { const value = await run(); await onDone?.(value); if (success) setDone(success); }
    catch (error) { setFailure(error instanceof Error ? error.message : '请稍后重试'); }
    finally { lock.current = false; setBusy(false); }
  }} /><Notice text={failure} tone="error" /><Notice text={done} tone="success" /></View>;
}
export function Notice({ text, tone = 'info' }: { text?: any; tone?: 'info' | 'error' | 'warning' | 'success' }) {
  if (!text) return null;
  return <View style={[s.notice, tone === 'error' && { backgroundColor: '#fff0ed' }]}><Text selectable style={{ color: tone === 'error' ? colors.danger : colors.ink, lineHeight: 21 }}>{String(text)}</Text></View>;
}
const labels: Record<string, string> = { name: '名称', status: '状态', created_at: '创建时间', updated_at: '更新时间', device_ts: '采样时间', received_at: '接收时间', source: '来源', execution_source: '执行来源', version: '版本', attempt: '尝试编号', error_code: '未完成原因', mode: '模式', data_status: '数据状态', steps: '步数', active_minutes: '活动分钟', sleep_minutes: '睡眠分钟', weight_kg: '体重(kg)', known_kcal: '已知摄入(kcal)', coverage: '覆盖', timezone: '时区', lat: '纬度', lon: '经度', accuracy_m: '精度(米)', expires_at: '到期时间', message: '文字', comment: '说明', notes: '备注', estimated: '估算', simulated: '模拟', is_demo: '演示', consent_verified: '已核验本人同意', method: '联系方式', assessment: '评价' };
Object.assign(labels, { value: '记录内容', recorded_at: '记录时间', type: '类型', withdrawn_at: '撤回时间', withdrawal_reason: '撤回原因', custom_type: '自定义类别', attachments: '附件', content_type: '文件类型', size_bytes: '文件大小(字节)', filename: '文件名', local_date: '当地日期', period_start: '时段起点', period_end: '时段终点', sample_count: '样本数', coverage_seconds: '覆盖秒数', metric_sample_counts: '各指标样本数', metric_coverage_seconds: '各指标覆盖秒数', distance_m: '距离(米)', sources: '来源', generated_at: '生成时间', read_at: '本人已阅时间', observations: '观察发现', comparisons: '比较', evidence: '依据', evidence_summary: '依据概况', finding_count: '发现数量', assessment_id: '评估编号', rule_version: '规则版本', superseded: '已被新版本替代', captured_mode: '受理时服务模式', error_message: '未完成说明', result: '结果', context: '明确上下文', question: '问题', answer: '回答', background: '补充背景', used_by_model: '已被模型使用', prepared_not_model_analyzed: '仅准备，模型未分析', content_version: '内容版本', current_version: '当前版本', progress: '本人学习记录', completed_step_ids: '已完成步骤', learned: '本人报告已学', applicability: '适用范围', review: '审核资料', step_count: '步骤数', battery_pct: '电量百分比', connection_status: '连接状态', serial_no: '设备编号', firmware_version: '固件版本', reporting: '上报策略', signal: '信号', signal_details: '信号依据', last_seen_at: '最近接收时间', reported_at: '最近上报时间', freshness: '新鲜度', usable_for_tracking: '可用于追踪', quality: '质量', quality_reasons: '质量说明', status_source: '状态来源', occurred_at: '发生时间', acknowledgement: '确认情况', recipients: '收件人结果', delivery_status: '投递状态', request_id: '申请编号', accepted: '已受理', counts: '数量', cutoffs: '清理边界', retained_counts: '保留数量', retained_related_counts: '相关保留数量', related_counts: '相关影响', enabled: '启用', telemetry_days: '原始遥测保留天数', activity_days: '活动保留天数', safety_days: '安全事件保留天数', last_run_at: '上次执行时间', from: '开始', to: '结束', items: '记录', details: '依据详情' });
const internal = /^(id|pet_id|household_id|created_by|updated_by|withdrawn_by|owner_user_id|content_path|request_hash|source_revision|aggregation_version|schema_version|next_cursor)$/;
const technical = /^(rule_version|allocation_method|comparison_basis|minimum_coverage_fraction|minimum_baseline_days|elapsed_seconds|model_output|input_digest|content_sha256|snapshot_at|format)$/;
function DetailedFacts({ value }: { value: Record<string, any> }) {
  const [open, setOpen] = useState(false);
  return <View><Button title={open ? '收起数据口径' : '查看数据口径与校验信息'} variant="secondary" onPress={() => setOpen(!open)} />{open && <Facts value={value} detailed />}</View>;
}
function NestedFacts({ value }: { value: any }) {
  const [open, setOpen] = useState(false);
  const entries = Array.isArray(value) ? value.length : Object.keys(value).length;
  if (!entries) return <Text style={s.muted}>暂无记录</Text>;
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return <Text selectable style={s.factValue}>{value.map(format).join('、')}</Text>;
  return <View style={{ paddingLeft: 8 }}><Button title={open ? '收起详细内容' : `查看详细内容（${entries}项）`} variant="secondary" onPress={() => setOpen(!open)} />{open && <Facts value={value} />}</View>;
}
function format(value: any): string { return value === null || value === undefined ? '未知' : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value); }
const stateNames: Record<string, string> = { pending: '等待处理', processing: '处理中', succeeded: '已完成', failed: '未完成', cancelled: '已取消', simulated: '已模拟', partial: '部分完成', not_configured: '尚未配置', unconfigured: '尚未配置', unknown: '未知', online: '在线', offline: '离线', fresh: '新鲜', stale: '已过期', missing: '暂无数据', available: '有覆盖', applied: '已执行', expired: '已到期', superseded: '已被替代', open: '待处理', in_progress: '处理中', resolved: '已解决', active: '有效', revoked: '已撤销', offline_demo: '离线演示', simulator: '模拟器回执', owner: '主人记录', vet: '兽医来源记录', reported_granted: '成员报告已同意', reported_revoked: '成员报告已撤回', helpful: '有帮助', incorrect: '不准确', other: '其他' };
Object.assign(stateNames, { insufficient_data: '输入不足', day_in_progress: '当天尚未结束', ready: '可比较', completed: '已完成', unavailable: '暂不可用' });
Object.assign(labels, { as_of: '本次比较时点', baseline_window: '比较基线时段', baseline: '个体基线', target: '当前观察时段', missing_context: '仍需结合的背景', values: '身体观察原文', observed_at: '实际观察时间', from_date: '开始日期', to_date: '结束日期', days: '每日明细', bucket: '分桶单位', toileting_record_status: '关联排便手记状态' });
function factText(key: string, value: any) {
  if (typeof value !== 'string' || !/(status|source|freshness|mode|assessment)$|状态$|来源$|新鲜度$|模式$|评价$/.test(key)) return format(value);
  if (/mode$|模式$/.test(key)) return ({ offline: '离线演示模式', api: '外部接入模式' } as Record<string, string>)[value] ?? stateNames[value] ?? value;
  if (key === 'data_status' && value === 'partial') return '部分覆盖';
  return stateNames[value] ?? value;
}
export function Facts({ value, detailed = false }: { value: any; detailed?: boolean }) {
  if (value === null || value === undefined) return <Text style={s.muted}>暂无记录</Text>;
  if (typeof value !== 'object') return <Text selectable style={s.body}>{format(value)}</Text>;
  const entries = Object.entries(value).filter(([key]) => !internal.test(key) && !/token|password|secret|content_base64/i.test(key));
  const details = entries.filter(([key]) => technical.test(key));
  return <View>{entries.filter(([key]) => detailed || !technical.test(key)).map(([key, item]) => <View style={s.fact} key={key}><Text style={s.factLabel}>{labels[key] ?? (/^\d+$/.test(key) ? `第 ${Number(key) + 1} 项` : key)}</Text>{item !== null && typeof item === 'object' ? <NestedFacts value={item} /> : <Text selectable style={s.factValue}>{factText(key, item)}</Text>}</View>)}{!detailed && details.length > 0 && <DetailedFacts value={Object.fromEntries(details)} />}</View>;
}
export function Choose({ value, options, onChange, disabled = false }: { value: string; options: { label: string; value: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  return <View style={s.choices}>{options.map(option => <Pressable accessibilityRole="radio" accessibilityState={{ checked: value === option.value, disabled }} disabled={disabled} key={option.value} onPress={() => { if (!disabledRef.current) onChange(option.value); }} style={[s.chip, value === option.value && s.selected]}><Text style={{ color: value === option.value ? '#fff' : colors.ink }}>{option.label}</Text></Pressable>)}</View>;
}
const s = StyleSheet.create({ safe: { flex: 1, backgroundColor: colors.paper }, page: { padding: 18, paddingBottom: 40, gap: 13, maxWidth: 780, width: '100%', alignSelf: 'center' }, pageTitle: { fontSize: 29, fontWeight: '700', color: colors.ink }, heading: { fontSize: 19, fontWeight: '700', color: colors.ink, marginBottom: 8 }, card: { backgroundColor: colors.card, borderRadius: 18, padding: 17, gap: 8, borderWidth: 1, borderColor: colors.border }, muted: { color: colors.muted, lineHeight: 21 }, body: { color: colors.ink, lineHeight: 22 }, field: { gap: 6, marginBottom: 7 }, label: { color: colors.ink, fontSize: 14, fontWeight: '600' }, input: { borderWidth: 1, borderColor: '#bdcec4', backgroundColor: '#fbfcf8', borderRadius: 11, paddingHorizontal: 12, paddingVertical: 11, color: colors.ink, fontSize: 16 }, button: { backgroundColor: colors.primary, padding: 13, borderRadius: designTokens.geometry.button.radius, alignItems: 'center', marginVertical: 3, minHeight: designTokens.geometry.button.height }, secondary: { backgroundColor: designTokens.palette.sage }, danger: { backgroundColor: colors.danger }, buttonText: { color: 'white', fontWeight: '600', fontSize: 15 }, notice: { padding: 13, borderRadius: 12, backgroundColor: '#e9f0e7' }, fact: { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#e0e7df' }, factLabel: { color: colors.muted, fontSize: 12 }, factValue: { color: colors.ink, lineHeight: 21, marginTop: 3 }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 6 }, chip: { paddingHorizontal: 13, paddingVertical: 10, borderRadius: 18, backgroundColor: '#e7eee5' }, selected: { backgroundColor: colors.primary } });
