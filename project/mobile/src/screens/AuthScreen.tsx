import { useRef, useState } from 'react';
import { Text } from 'react-native';
import { useApp } from '../state/AppContext';
import { Action, Button, Card, Choose, Facts, Field, Notice, Page } from '../ui';
import { Region, Row } from '../types';

export function AuthScreen() {
  const { region: currentRegion, serverUrl, configurable, configure, authenticate, restoreError, canRetryRestore, retryRestore } = useApp();
  const [region, setRegion] = useState<Region>(currentRegion), [url, setUrl] = useState(serverUrl), [mode, setMode] = useState('login');
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState(''), [family, setFamily] = useState('我的家庭');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  const [health, setHealth] = useState<Row | null>(null), [recovery, setRecovery] = useState<Row | null>(null), [requestId, setRequestId] = useState(''), [token, setToken] = useState('');
  const [connectionOpen, setConnectionOpen] = useState(!serverUrl.trim());
  const [resetDone, setResetDone] = useState(false);
  const connectionRevision = useRef(0), operationLock = useRef(false);
  const [busy, setBusy] = useState(false);
  const sameConnection = region === currentRegion && url.trim().replace(/\/$/, '') === serverUrl.replace(/\/$/, '');
  async function operate<T>(work: () => Promise<T>): Promise<T> {
    if (operationLock.current) throw new Error('上一项请求仍在处理中，请稍候');
    operationLock.current = true; setBusy(true);
    try { return await work(); } finally { operationLock.current = false; setBusy(false); }
  }
  const edit = (set: (value: string) => void) => (value: string) => { if (!operationLock.current) set(value); };
  const clearRecovery = () => { connectionRevision.current++; setRecovery(null); setRequestId(''); setToken(''); setPassword(''); setResetDone(false); };
  const clearConnectionFeedback = () => { setHealth(null); clearRecovery(); };
  const connect = async () => {
    const address = url.trim();
    if (!address) { setConnectionOpen(true); throw new Error('此服务区域尚未配置服务器，请先在下方“连接与服务区域”设置连接。'); }
    try {
      const parsed = new URL(address);
      if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname) throw new Error();
    } catch { setConnectionOpen(true); throw new Error('服务器地址不完整，请填写以 https:// 开头的服务器地址；本地内测地址可按开发配置使用 http://。'); }
    return configure(region, address);
  };
  return <Page title="欢迎来到 DOOGY" subtitle="记录照护，也安心陪伴。">
    {restoreError && <Card title="上次会话恢复">
      <Notice text={restoreError} tone="error" />
      {canRetryRestore && <><Action title="重试恢复上次会话" disabled={busy || !sameConnection} run={() => operate(retryRestore)} />
        {!sameConnection && <Notice text="恢复适用于上次使用的服务区域和地址。当前连接表单已更改，请改回原连接后恢复，或登录新的服务器。" />}</>}
    </Card>}
    <Card title={mode === 'register' ? '创建账户' : mode === 'recovery' ? '找回密码' : '登录账户'}>
      <Choose value={mode} disabled={busy} options={[{ value: 'login', label: '登录' }, { value: 'register', label: '注册' }, { value: 'recovery', label: '找回密码' }]} onChange={value => { if (operationLock.current) return; setMode(value); clearRecovery(); }} />
      {busy && <Notice text="正在处理本次请求，请稍候。完成前不能切换模式、服务区域或修改表单。" />}
      <Text>当前服务区域：{region === 'cn' ? '中国大陆' : '海外'}。</Text>
      {!url.trim() && <Notice text="尚未配置此区域的服务器。请先展开下方“连接与服务区域”完成设置，再登录或创建账户。" />}
      <Field label="邮箱" value={email} onChangeText={edit(setEmail)} editable={!busy} keyboardType="email-address" autoComplete="email" />
      {mode !== 'recovery' && <Field label="密码（8 至 128 字符）" value={password} onChangeText={edit(setPassword)} editable={!busy} secureTextEntry autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />}
      {mode === 'register' && <><Field label="显示名（可选）" value={name} onChangeText={edit(setName)} editable={!busy} /><Field label="家庭名称" value={family} onChangeText={edit(setFamily)} editable={!busy} /><Field label="家庭 IANA 时区" value={timezone} onChangeText={edit(setTimezone)} editable={!busy} placeholder="Asia/Shanghai" /></>}
      {mode !== 'recovery' ? <Action title={mode === 'register' ? '创建账户并登录' : '登录'} disabled={busy} run={() => operate(async () => {
        const revision = connectionRevision.current; await connect();
        if (revision !== connectionRevision.current) throw new Error('连接或登录模式已改变，请重新确认后提交');
        await authenticate(mode as 'login' | 'register', { email: email.trim(), password, ...(mode === 'register' ? { household_name: family, timezone, ...(name.trim() ? { display_name: name.trim() } : {}) } : {}) }); setPassword('');
      })} /> : <>
        <Action title="申请找回密码" disabled={busy} run={() => operate(async () => { const revision = connectionRevision.current; const value = await (await connect()).post('/auth/password-recovery', { email: email.trim() }); return { revision, value }; })} onDone={({ revision, value }) => { if (revision !== connectionRevision.current) return; setRecovery(value); setRequestId(value.request_id); }} />
        {recovery && <Facts value={recovery} />}
        <Notice text="申请成功不代表邮件已发送。当前离线模式需要管理员通过本地交付流程提供重置令牌；未配置真实渠道时不能自动取回令牌。" />
        <Field label="申请编号" value={requestId} onChangeText={edit(setRequestId)} editable={!busy} /><Field label="已获得的重置令牌" value={token} onChangeText={edit(setToken)} editable={!busy} secureTextEntry /><Field label="新密码" value={password} onChangeText={edit(setPassword)} editable={!busy} secureTextEntry />
        <Action title="确认重置密码" disabled={busy} run={() => operate(async () => { const revision = connectionRevision.current; await (await connect()).post('/auth/password-reset', { request_id: requestId.trim(), token: token.trim(), new_password: password }); return revision; })} onDone={revision => { if (revision !== connectionRevision.current) return; clearRecovery(); setMode('login'); setResetDone(true); }} />
      </>}
      {resetDone && <Notice tone="success" text="密码已重置，请使用新密码登录。" />}
      <Text>当前使用邮箱与密码。Apple / Google 登录尚未接入。</Text>
    </Card>
    <Card title="连接与服务区域">
      <Button title={connectionOpen ? '收起连接设置' : '展开连接与服务区域'} disabled={busy} variant="secondary" onPress={() => { if (!operationLock.current) setConnectionOpen(value => !value); }} />
      {connectionOpen && <>
        <Choose value={region} disabled={busy} options={[{ value: 'cn', label: '中国大陆' }, { value: 'global', label: '海外' }]} onChange={value => {
          if (operationLock.current) return;
          const next = value as Region, address = next === currentRegion ? serverUrl : (next === 'cn' ? process.env.EXPO_PUBLIC_CN_API_URL ?? process.env.EXPO_PUBLIC_API_URL : process.env.EXPO_PUBLIC_GLOBAL_API_URL) ?? '';
          setRegion(next); setUrl(address); clearConnectionFeedback(); if (!address.trim()) setConnectionOpen(true);
        }} />
        {configurable ? <Field label="开发服务器根地址" value={url} editable={!busy} onChangeText={value => { if (operationLock.current) return; setUrl(value); clearConnectionFeedback(); }} placeholder="http://192.168.1.10:3000" autoCorrect={false} /> : <Notice text={url || '此服务区域尚未配置服务器，请联系应用提供方配置对应连接。'} />}
        <Notice text="请选择创建账户时使用的服务区域。切换区域会退出当前会话，不会复制账号、家庭或宠物数据。" />
        <Action title="检查连接" disabled={busy} run={() => operate(async () => { setHealth(null); const revision = connectionRevision.current; const value = await (await connect()).get('/health'); return { revision, value }; })} onDone={({ revision, value }) => { if (revision === connectionRevision.current) setHealth(value); }} />
        {health && <Facts value={{ 状态: health.status, 数据模式: health.mode, 数据库: health.database, 服务器时间: health.time }} />}
        {health?.demo === true && health.mode === 'offline' && health.demo_accounts && <>
          <Notice text="当前是独立合成演示环境。以下入口只填入该环境公开的测试账号，不使用你的普通业务库账户。" />
          {(['owner', 'viewer'] as const).map(role => <Button key={role} title={role === 'owner' ? '填入合成演示主人账号' : '填入合成演示只读账号'} disabled={busy} variant="secondary" onPress={() => {
            if (operationLock.current) return;
            const account = health.demo_accounts[role];
            if (typeof account?.email !== 'string' || typeof account?.password !== 'string') return;
            setMode('login'); clearRecovery(); setEmail(account.email); setPassword(account.password);
          }} />)}
        </>}
      </>}
    </Card>
  </Page>;
}
