import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Region, Row as Data } from '../types';
import { Asset } from './assets';
import { Body, Button, Caption, Card, Field, Heading, Notice, Page, Pill, Row, go, palette } from './ui';

type Props = { screenId: string; navigation: any; route?: { params?: Data }; params?: Data };
const nullable = (value: string) => value.trim() || null;
const when = (value: unknown) => typeof value === 'string' && value ? new Date(value).toLocaleString() : 'Unknown';
const writable = (role?: string) => ['owner', 'caregiver'].includes(role ?? '');

function useWork() {
  const alive = useRef(true), locked = useRef(false), [busy, setBusy] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async (work: () => Promise<any>) => {
    if (locked.current) throw new Error('A request is still in progress. Please wait.');
    locked.current = true; setBusy(true);
    try { return await work(); } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return { alive, busy, run };
}
function enterToday(navigation: any) {
  if (navigation.reset) navigation.reset({ index: 0, routes: [{ name: 'Main', params: { screen: 'HomeTab' } }] });
  else navigation.navigate('Main', { screen: 'HomeTab' });
}
function returnFromProfile(navigation: any) {
  if (navigation.canGoBack?.()) navigation.goBack(); else enterToday(navigation);
}
function TextLink({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} hitSlop={8} disabled={disabled} onPress={onPress} style={[s.textLink, disabled && { opacity: 0.55 }]}><Text style={s.textLinkText}>{title}</Text></Pressable>;
}
function weightValue(value: string) {
  const weight = Number(value);
  if (!value.trim() || !Number.isFinite(weight) || weight <= 0 || weight > 300) throw new Error('Weight must be greater than 0 and at most 300 kg.');
  return weight;
}
export function PawchOnboardingScreen(props: Props) {
  const app = useApp();
  const roles = app.households.map(row => `${row.id}:${row.role}`).join('|');
  const scope = `${app.api.baseUrl}:${app.user?.id}:${roles}:${props.screenId}`;
  if (['01', '02', '06'].includes(props.screenId)) return <GuestFlow key={scope} {...props} />;
  if (props.screenId === '07') return <ProfileForm key={`${scope}:${app.pet?.id ?? ''}`} {...props} />;
  if (props.screenId === '08') return <CollarSettings key={`${scope}:${app.pet?.id ?? ''}`} {...props} />;
  return <SetupFlow key={scope} {...props} />;
}

function GuestFlow({ screenId, navigation }: Props) {
  const app = useApp(), task = useWork();
  const [region, setRegion] = useState<Region>(app.region), [url, setUrl] = useState(app.serverUrl);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [name, setName] = useState('');
  const [family, setFamily] = useState('我的家庭'), [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
  const [connectionOpen, setConnectionOpen] = useState(!app.serverUrl), [health, setHealth] = useState<Data | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false), [recovery, setRecovery] = useState<Data | null>(null), [requestId, setRequestId] = useState(''), [token, setToken] = useState(''), [resetDone, setResetDone] = useState(false);
  const revision = useRef(0), register = screenId === '02';
  const invalidate = () => { revision.current++; setHealth(null); setRecovery(null); setRequestId(''); setToken(''); setPassword(''); setResetDone(false); };
  const connect = async () => {
    if (!url.trim()) { setConnectionOpen(true); throw new Error('Choose a service region and enter its server address first.'); }
    try { return await app.configure(region, url.trim()); }
    catch (error) { setConnectionOpen(true); throw error; }
  };
  const sameConnection = region === app.region && url.trim().replace(/\/$/, '') === app.serverUrl.replace(/\/$/, '');
  const connection = <View style={s.advanced}>
    <TextLink title={connectionOpen ? 'Hide connection settings' : 'Connection & service region'} disabled={task.busy} onPress={() => setConnectionOpen(value => !value)} />
    {connectionOpen && <>
      <View style={s.pills}>{(['cn', 'global'] as const).map(value => <Pill key={value} title={value === 'cn' ? 'China mainland' : 'Global'} selected={region === value} disabled={task.busy} onPress={() => {
        if (task.busy) return; setRegion(value); setUrl(value === app.region ? app.serverUrl : (value === 'cn' ? process.env.EXPO_PUBLIC_CN_API_URL ?? process.env.EXPO_PUBLIC_API_URL : process.env.EXPO_PUBLIC_GLOBAL_API_URL) ?? ''); invalidate();
      }} />)}</View>
      {app.configurable ? <Field label="Server root address" value={url} editable={!task.busy} autoCorrect={false} onChangeText={value => { setUrl(value); invalidate(); }} placeholder="http://127.0.0.1:3000" /> : <Body>{url || 'This region is not configured.'}</Body>}
      <Caption>Use the region where your account was created. Changing regions does not copy accounts or pet data.</Caption>
      <Caption>Apple / Google sign-in is not configured. Email and password are available.</Caption>
      {register && <><Field label="Household name" value={family} onChangeText={setFamily} editable={!task.busy} /><Field label="Household time zone" value={timezone} onChangeText={setTimezone} editable={!task.busy} /></>}
      <Button title="Check connection" secondary disabled={task.busy} run={() => task.run(async () => {
        const version = revision.current, client = await connect(); if (!task.alive.current || version !== revision.current) return;
        const result = await client.get('/health'); if (task.alive.current && version === revision.current) setHealth(result);
      })} />
      {health && <Caption>Service: {health.status} · {health.mode} · {health.database}</Caption>}
      {health?.demo === true && health.mode === 'offline' && health.demo_accounts && <>
        <Notice text="Independent synthetic test environment. These controls only fill the server's published test accounts." />
        {(['owner', 'viewer'] as const).map(role => <Button key={role} title={role === 'owner' ? 'Fill synthetic owner account' : 'Fill synthetic viewer account'} secondary disabled={task.busy} onPress={() => {
          const account = health.demo_accounts[role]; if (typeof account?.email === 'string' && typeof account?.password === 'string') { setEmail(account.email); setPassword(account.password); }
        }} />)}
      </>}
    </>}
  </View>;
  const restore = app.restoreError ? <Card><Notice text={app.restoreError} tone="error" />{app.canRetryRestore && <Button title="Retry saved session" secondary disabled={task.busy || !sameConnection} run={() => task.run(app.retryRestore)} />}</Card> : null;
  if (screenId === '01') return <Page screenId={screenId} navigation={navigation} back={false} kicker="A LITTLE CLOSER, EVERY DAY" footer={<>
    <Button title="Meet your new everyday" onPress={() => go(navigation, app.authenticated ? '03' : '02')} />
    <Button title={app.authenticated ? 'Back to Today' : 'I already have an account'} secondary onPress={() => app.authenticated ? enterToday(navigation) : go(navigation, '06')} />
    <Text style={s.welcomeFootnote}>DOG WELLBEING, WITH A LITTLE WONDER</Text>
  </>}><Text accessibilityRole="header" style={s.welcomeTitle}>{'Life is better\nside by side.'}</Text><Text style={s.welcomeSubtitle}>More happy trails. Less second-guessing.</Text><View style={s.welcomeArtwork}><Asset name="welcome-baku" /></View>{restore}</Page>;
  if (app.authenticated) return <Page screenId={screenId} navigation={navigation} title="You're already signed in." subtitle={app.user?.email ?? ''}><Notice text="Sign out in account settings before using another account. Your current family and pet data stay separate." /><Button title="Continue to Today" onPress={() => enterToday(navigation)} /><Button title="Account settings" secondary onPress={() => navigation.navigate('Profile')} /></Page>;
  return <Page screenId={screenId} navigation={navigation} title={register ? 'Your journey starts\nhere.' : 'Welcome back.'} titleStyle={register ? { fontSize: 32, lineHeight: 38 } : undefined} subtitle={register ? 'A little closer to your everyday companion.' : 'Your favorite explorer is waiting.'} footer={<>
    <Button title={register ? 'Create account' : 'Log in'} disabled={task.busy || !email.trim() || password.length < 8} run={() => task.run(async () => {
      const version = revision.current; await connect(); if (!task.alive.current || version !== revision.current) return;
      await app.authenticate(register ? 'register' : 'login', { email: email.trim(), password, ...(register ? { household_name: family.trim(), timezone, ...(name.trim() ? { display_name: name.trim() } : {}) } : {}) });
      if (task.alive.current) setPassword('');
    })} />
    <Button title={register ? 'Log in instead' : 'Create an account'} secondary disabled={task.busy} onPress={() => go(navigation, register ? '06' : '02')} />
  </>}>
    {!register && <View style={s.loginArtwork}><Asset name="login-baku" style={{ alignSelf: 'flex-end' }} /></View>}
    {restore}
    <View style={s.form}>
      {register && <Field label="YOUR NAME" value={name} onChangeText={setName} editable={!task.busy} autoComplete="name" />}
      <Field label="EMAIL" value={email} onChangeText={setEmail} editable={!task.busy} keyboardType="email-address" autoComplete="email" />
      <Field label="PASSWORD" value={password} onChangeText={setPassword} editable={!task.busy} secureTextEntry autoComplete={register ? 'new-password' : 'current-password'} maxLength={128} />
    </View>
    <Caption>{register ? 'Creates an account on your selected server. No terms are accepted on your behalf.' : 'Your credentials are sent only when you choose Log in.'}</Caption>
    {!register && <TextLink title={recoveryOpen ? 'Close password recovery' : 'Forgot password?'} disabled={task.busy} onPress={() => setRecoveryOpen(value => !value)} />}
    {recoveryOpen && <Card title="Password recovery">
      <Button title="Request password recovery" disabled={task.busy || !email.trim()} run={() => task.run(async () => {
        const version = revision.current, client = await connect(); if (!task.alive.current || version !== revision.current) return;
        const result = await client.post('/auth/password-recovery', { email: email.trim() }); if (task.alive.current && version === revision.current) { setRecovery(result); setRequestId(result.request_id); }
      })} />
      {recovery && <Caption>Recovery request accepted. Acceptance does not confirm email delivery.</Caption>}
      <Notice text="No real email channel is configured in offline mode. A reset token must be provided through the existing authorized local delivery process." />
      <Field label="Recovery request ID" value={requestId} onChangeText={setRequestId} editable={!task.busy} /><Field label="Received reset token" value={token} onChangeText={setToken} editable={!task.busy} secureTextEntry />
      <Field label="New password" value={password} onChangeText={setPassword} editable={!task.busy} secureTextEntry />
      <Button title="Confirm password reset" disabled={task.busy || !requestId || !token || password.length < 8} run={() => task.run(async () => {
        const version = revision.current, client = await connect(); if (!task.alive.current || version !== revision.current) return;
        await client.post('/auth/password-reset', { request_id: requestId.trim(), token: token.trim(), new_password: password });
        if (task.alive.current && version === revision.current) { setRecovery(null); setRequestId(''); setToken(''); setPassword(''); setResetDone(true); setRecoveryOpen(false); }
      })} />
    </Card>}
    {resetDone && <Notice text="Password reset. Sign in using your new password." tone="success" />}
    {connection}
  </Page>;
}

function SetupFlow({ screenId, navigation, route, params }: Props) {
  const app = useApp(), task = useWork(), input = params ?? route?.params ?? {};
  const selection = useRef({ api: app.api, user: app.user?.id, pet: app.pet?.id });
  selection.current = { api: app.api, user: app.user?.id, pet: app.pet?.id };
  const inScope = (before: typeof selection.current, acceptedPet?: string) => task.alive.current && selection.current.api === before.api && selection.current.user === before.user && (selection.current.pet === before.pet || (!!acceptedPet && selection.current.pet === acceptedPet));
  const guide = useResource<Data>(() => app.api.get('/auth/onboarding'), [app.api, app.user?.id]);
  const [confirmedGuide, setConfirmedGuide] = useState<Data | null>(null), current = confirmedGuide ?? guide.data;
  const [selected, setSelected] = useState(app.onboarding?.pet_id ?? app.pet?.id ?? ''), [newPet, setNewPet] = useState(input.newPet === true || !app.pets.length), [detailsOpen, setDetailsOpen] = useState(false);
  const writers = app.households.filter(row => writable(row.role));
  const [householdId, setHouseholdId] = useState(writers.find(row => row.id === app.household?.id)?.id ?? writers[0]?.id ?? '');
  const [name, setName] = useState(''), [breed, setBreed] = useState(''), [birth, setBirth] = useState(''), [weight, setWeight] = useState(''), [species, setSpecies] = useState('dog');
  const [created, setCreated] = useState<Data | null>(null), [createNeedsRead, setCreateNeedsRead] = useState(false);
  const [deviceId, setDeviceId] = useState(''), [claimCode, setClaimCode] = useState(''), [claimReceipt, setClaimReceipt] = useState(false), [completionReceipt, setCompletionReceipt] = useState(false);
  const fromSettings = input.from === '08';
  const target = app.pets.find(row => row.id === (fromSettings ? input.petId ?? app.pet?.id : current?.pet_id)) ?? (created?.id === current?.pet_id ? created : null);
  const targetRole = app.households.find(row => row.id === target?.household_id)?.role;
  const alreadyBound = !fromSettings && !!current?.binding;
  const readGuide = async () => { const value = await app.api.get('/auth/onboarding'); if (task.alive.current) setConfirmedGuide(value); return value; };
  const continuePet = async (id: string) => {
    const scope = selection.current, before = await readGuide(); if (!inScope(scope, id)) return;
    if (before.pet_id !== id) await app.api.patch('/auth/onboarding', { pet_id: id, expected_version: before.version });
    if (!inScope(scope, id)) return; await app.refreshIdentity(); if (!inScope(scope, id)) return;
    app.selectPet(id); go(navigation, '04');
  };
  const readCreation = async () => { await app.refreshIdentity(); if (!task.alive.current) return; setCreateNeedsRead(false); };
  const readBinding = async () => {
    if (fromSettings && target) {
      const result = await app.api.get(`/pets/${target.id}/overview`); if (!task.alive.current) return;
      if (!result.device) throw new Error('The saved binding cannot be read yet. Retry reading; do not submit the claim code again.');
      await app.refreshIdentity(); if (task.alive.current) go(navigation, '08');
    } else {
      const value = await readGuide(); if (!task.alive.current) return;
      if (!value.binding) throw new Error('The saved binding cannot be read yet. Retry reading; do not submit the claim code again.');
      await app.refreshIdentity(); if (task.alive.current) go(navigation, '05');
    }
  };
  const finish = async () => {
    const value = await readGuide(); if (!task.alive.current) return;
    if (completionReceipt && value.next_step !== 'done') throw new Error('The completed setup is no longer current. Review the saved collar choice; this retry only reads.');
    if (value.next_step !== 'done') {
      if (!value.pet_id || (!value.binding && value.collar_choice !== 'skipped')) throw new Error('First bind a collar or explicitly choose to skip it.');
      await app.api.patch('/auth/onboarding', { pet_id: value.pet_id, collar_choice: value.binding ? 'completed' : 'skipped', completed: true, expected_version: value.version });
      if (!task.alive.current) return; setCompletionReceipt(true);
    }
    await app.refreshIdentity(); if (task.alive.current) enterToday(navigation);
  };
  const status = <>{guide.loading && <Caption>Reading your saved setup…</Caption>}{guide.error && <><Notice text={guide.error} tone="error" />
    <Button title="Refresh saved setup" secondary disabled={task.busy || guide.loading} run={() => task.run(async () => { await readGuide(); if (task.alive.current) await app.refreshIdentity(); })} /></>}</>;
  if (screenId === '03') return <Page screenId={screenId} navigation={navigation} title="Meet Your Dog" subtitle="Big ears. Bigger personality." footer={<>
    {created ? createNeedsRead ? <Button title="Reread the created profile" disabled={task.busy} run={() => task.run(readCreation)} /> : <Button title={`Continue with ${created.name}`} disabled={task.busy} run={() => task.run(() => continuePet(created.id))} />
      : newPet ? <Button title="Looks like my best friend" disabled={task.busy || !name.trim() || !writers.some(row => row.id === householdId)} run={() => task.run(async () => {
        const scope = selection.current;
        const result = await app.api.post('/pets', { household_id: householdId, name: name.trim(), species, breed: nullable(breed), birth_date: nullable(birth), ...(weight.trim() ? { weight_kg: weightValue(weight) } : {}) });
        if (!inScope(scope)) return; setCreated(result); setCreateNeedsRead(true);
        await readCreation(); if (inScope(scope, result.id)) await continuePet(result.id);
      })} /> : <Button title="Continue with this companion" disabled={task.busy || !selected} run={() => task.run(() => continuePet(selected))} />}
    <Caption>Actual profile · edit any time in settings</Caption>
  </>}>
    <View style={s.meetArtwork}><Asset name="meet-your-dog-baku" /></View>
    {created ? <Card tone="sage"><Heading>{created.name}'s profile has been saved.</Heading><Body>{createNeedsRead ? 'The next read has not completed. Retry reading; this will not create another pet.' : 'Continue using this saved profile.'}</Body></Card> : <>
      {!!app.pets.length && !newPet && <View style={s.form}><Caption>USE A SAVED PROFILE</Caption>{app.pets.map(row => <Row key={row.id} title={row.name} subtitle={row.breed || 'Breed not recorded'} value={selected === row.id ? '✓' : undefined} onPress={() => { if (!task.busy) { setSelected(row.id); setNewPet(false); } }} disabled={task.busy} />)}
        <Button title="Create another profile" secondary disabled={task.busy} onPress={() => setNewPet(true)} /></View>}
      {(newPet || !app.pets.length) && <View style={s.form}>
        {!writers.length && <Notice text="Your current households are read-only. Choose an existing companion or ask an owner/caregiver to create a profile." />}
        <Field label="DOG'S NAME" value={name} onChangeText={setName} editable={!task.busy && !!writers.length} maxLength={100} />
        <Field label="BREED" value={breed} onChangeText={setBreed} editable={!task.busy && !!writers.length} maxLength={100} />
        <View style={s.pair}><View style={s.half}><Field label="BIRTH DATE (OPTIONAL)" value={birth} onChangeText={setBirth} editable={!task.busy && !!writers.length} placeholder="YYYY-MM-DD" /></View><View style={s.half}><Field label="WEIGHT kg (OPTIONAL)" value={weight} onChangeText={setWeight} editable={!task.busy && !!writers.length} keyboardType="decimal-pad" /></View></View>
        <TextLink title={detailsOpen ? 'Hide pet type & household' : 'Pet type & household'} disabled={task.busy} onPress={() => setDetailsOpen(value => !value)} />
        {detailsOpen && <><View style={s.pills}>{[['dog', 'Dog'], ['cat', 'Cat'], ['other', 'Other']].map(([value, title]) => <Pill key={value} title={title} selected={species === value} disabled={task.busy || !writers.length} onPress={() => setSpecies(value)} />)}</View>
          {writers.length > 1 && <View style={s.pills}>{writers.map(row => <Pill key={row.id} title={row.name} selected={householdId === row.id} disabled={task.busy} onPress={() => setHouseholdId(row.id)} />)}</View>}</>}
        {!!app.pets.length && <TextLink title="Use a saved profile instead" disabled={task.busy} onPress={() => setNewPet(false)} />}
      </View>}
    </>}{status}
  </Page>;
  if (screenId === '04') return <Page screenId={screenId} navigation={navigation} title={'A small collar.\nA closer connection.'} titleStyle={{ fontSize: 32, lineHeight: 38 }} subtitle={target ? `A secure link for ${target.name}.` : 'Choose a saved companion first.'} footer={<>
    {alreadyBound ? <Button title="Continue with saved binding" disabled={task.busy || !target} run={() => task.run(readBinding)} /> : claimReceipt ? <Button title="Reread saved binding" disabled={task.busy} run={() => task.run(readBinding)} /> : <Button title="Bind this collar" disabled={task.busy || !target || !writable(targetRole) || !deviceId.trim() || !claimCode.trim()} run={() => task.run(async () => {
      await app.api.post('/devices/claim', { pet_id: target!.id, device_id: deviceId.trim(), claim_code: claimCode.trim() });
      if (!task.alive.current) return; setClaimReceipt(true); setClaimCode(''); await readBinding();
    })} />}
    <Button title={fromSettings ? 'Back to collar settings' : alreadyBound ? 'Review saved collar settings' : 'Skip collar for now'} secondary disabled={task.busy || !!claimReceipt || !target} run={() => task.run(async () => {
      if (fromSettings) { go(navigation, '08'); return; }
      if (alreadyBound) { app.selectPet(target!.id); go(navigation, '08'); return; }
      const value = await readGuide(); if (!task.alive.current) return;
      await app.api.patch('/auth/onboarding', { pet_id: target!.id, collar_choice: 'skipped', expected_version: value.version });
      if (!task.alive.current) return; await app.refreshIdentity(); if (task.alive.current) go(navigation, '05');
    })} />
    <Caption>Backend binding, Bluetooth and actual reporting are separate.</Caption>
  </>}>
    <View style={s.collarArtwork}><Asset name="pair-collar" /></View>
    <Row title="01  Bluetooth" subtitle="Not configured · no scan is performed" value="—" disabled />
    {alreadyBound ? <Row title="02  Saved collar binding" subtitle="Saved link · Bluetooth unknown" value="✓" /> : <Card title="02  Secure device identity"><Caption>Use the pre-provisioned device ID and a valid short-lived claim code from an authorized owner.</Caption>
      <Field label="Device ID" value={deviceId} onChangeText={setDeviceId} editable={!task.busy && !claimReceipt && writable(targetRole)} autoCorrect={false} />
      <Field label="Short-lived claim code" value={claimCode} onChangeText={setClaimCode} editable={!task.busy && !claimReceipt && writable(targetRole)} secureTextEntry autoCorrect={false} />
    </Card>}
    {!target && <Button title="Choose a companion" secondary onPress={() => go(navigation, '03')} />}
    {target && !writable(targetRole) && <Notice text="Binding needs owner or caregiver permission. You may still explicitly skip the collar and begin care." />}
    {claimReceipt && <Notice text="The server accepted this binding. Only reread its result; do not resubmit the claim code." tone="success" />}
    <Button title="Device ownership and connection help" secondary onPress={() => navigation.navigate('Devices')} />{status}
  </Page>;
  const savedPet = app.pets.find(row => row.id === current?.pet_id), bound = !!current?.binding, skipped = current?.collar_choice === 'skipped';
  return <Page screenId="05" navigation={navigation} title="Hello, everyday life." subtitle={`${savedPet?.name ?? 'Your companion'}'s next chapter starts here.`} footer={<>
    <Button title={completionReceipt ? 'Reread completed setup' : `Explore ${savedPet?.name ?? 'your companion'}'s Today`} disabled={task.busy || !current?.pet_id || (!bound && !skipped)} run={() => task.run(finish)} />
    <Caption>Setup state comes from your saved account.</Caption>
  </>}>
    <View style={s.connectedArtwork}><Asset name="connected-baku" /></View>
    <Card tone="sage"><Heading>{bound ? '✓  Collar binding saved' : skipped ? '✓  Start without a collar' : 'Collar choice is still needed'}</Heading>
      <Body>{bound ? 'Bluetooth connection is unknown. Binding alone does not prove the device is online.' : skipped ? 'You can record daily care now and bind a collar later.' : 'Bind a device or explicitly choose to skip it.'}</Body>
      {bound && <Caption>Last received: {when(current?.device_report?.received_at)}</Caption>}
    </Card>
    <Button title="Review collar choice" secondary disabled={task.busy} onPress={() => go(navigation, '04')} />{status}
  </Page>;
}

function ProfileForm({ navigation }: Props) {
  const app = useApp(), task = useWork(), pet = app.pet;
  const role = app.households.find(row => row.id === pet?.household_id)?.role, canWrite = writable(role);
  const [name, setName] = useState(pet?.name ?? ''), [breed, setBreed] = useState(pet?.breed ?? ''), [birth, setBirth] = useState(pet?.birth_date ?? '');
  const [weight, setWeight] = useState(pet?.weight_kg == null ? '' : String(pet.weight_kg)), [weightTouched, setWeightTouched] = useState(false);
  const [saved, setSaved] = useState<Data | null>(null), [readConfirmed, setReadConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false), [advanced, setAdvanced] = useState(false), [focusError, setFocusError] = useState('');
  const focusRead = useRef(app.refreshIdentity); focusRead.current = app.refreshIdentity;
  useEffect(() => navigation?.addListener?.('focus', () => { void focusRead.current().then(() => { if (task.alive.current) setFocusError(''); }, error => { if (task.alive.current) setFocusError(error instanceof Error ? error.message : 'Profile could not be reread.'); }); }), [navigation]);
  useEffect(() => {
    if (dirty || saved) return;
    setName(pet?.name ?? ''); setBreed(pet?.breed ?? ''); setBirth(pet?.birth_date ?? ''); setWeight(pet?.weight_kg == null ? '' : String(pet.weight_kg)); setWeightTouched(false);
  }, [pet?.id, pet?.name, pet?.breed, pet?.birth_date, pet?.weight_kg, dirty, saved]);
  const readSaved = async (value: Data) => {
    const actual = await app.api.get(`/pets/${value.id}`); if (!task.alive.current) return;
    if (actual.id !== value.id) throw new Error('The saved profile could not be confirmed.');
    await app.refreshIdentity(); if (!task.alive.current) return; setReadConfirmed(true); returnFromProfile(navigation);
  };
  if (!pet) return <Page screenId="07" navigation={navigation} title="Your companion's profile"><Notice text="Select or create a companion before editing a profile." /><Button title="Meet your companion" onPress={() => go(navigation, '03')} /></Page>;
  return <Page screenId="07" navigation={navigation} title={`${pet.name}'s profile`} subtitle="The little details that make them, them." footer={<>
    {saved ? <Button title="Reread saved profile" disabled={task.busy} run={() => task.run(() => readSaved(saved))} /> : <Button title="Save profile" disabled={task.busy || !canWrite || !name.trim()} run={() => task.run(async () => {
      const value = await app.api.patch(`/pets/${pet.id}`, { name: name.trim(), breed: nullable(breed), birth_date: nullable(birth), ...(weightTouched ? { weight_kg: weightValue(weight) } : {}) });
      if (!task.alive.current) return; setSaved(value); await readSaved(value);
    })} />}
  </>}>
    <View style={s.form}>
      <Field label="NAME" value={name} onChangeText={value => { setName(value); setDirty(true); }} editable={canWrite && !task.busy && !saved} maxLength={100} />
      <Field label="BREED" value={breed} onChangeText={value => { setBreed(value); setDirty(true); }} editable={canWrite && !task.busy && !saved} maxLength={100} />
      <Field label="BIRTH DATE" value={birth} onChangeText={value => { setBirth(value); setDirty(true); }} editable={canWrite && !task.busy && !saved} placeholder="YYYY-MM-DD" />
      <Field label="WEIGHT kg" value={weight} onChangeText={value => { setWeight(value); setWeightTouched(true); setDirty(true); }} editable={canWrite && !task.busy && !saved} keyboardType="decimal-pad" placeholder="Not recorded" />
    </View>
    <Row title="Collar settings" subtitle="Current binding, reporting and capabilities" onPress={() => go(navigation, '08')} />
    {!canWrite && <Notice text="Read-only family access. Only owners and caregivers may edit shared profile data." />}
    {saved && <Notice tone={readConfirmed ? 'success' : 'info'} text={readConfirmed ? 'Profile saved and reread.' : 'Profile has been saved. If the next read fails, retry reading only; saving again could create another weigh-in.'} />}
    {!!focusError && <><Notice text={focusError} tone="error" /><Button title="Retry profile read" secondary disabled={task.busy} run={() => task.run(async () => { await app.refreshIdentity(); if (task.alive.current) setFocusError(''); })} /></>}
    <TextLink title={advanced ? 'Hide profile options' : 'More profile options'} disabled={task.busy} onPress={() => setAdvanced(value => !value)} />
    {advanced && <><Caption>Time zone: {pet.effective_timezone ?? pet.timezone ?? 'Unknown'}. Changing weight records a new weigh-in; unchanged weight is not submitted again.</Caption>
      <Row title="Care journal" subtitle="Write a care note and reread saved records" onPress={() => go(navigation, '26', { returnTo: '07' })} />
      <Button title="Refresh profile without replacing my draft" secondary disabled={task.busy} run={() => task.run(app.refreshIdentity)} />
      <Button title="Cancel profile changes" secondary disabled={task.busy} onPress={() => returnFromProfile(navigation)} />
      <Button title="Photo, species and full profile settings" secondary onPress={() => navigation.navigate('Pet')} />
      <Button title="Family permissions" secondary onPress={() => navigation.navigate('Household')} /></>}
  </Page>;
}

function CollarSettings({ navigation }: Props) {
  const app = useApp(), overview = useResource<Data>(() => app.pet ? app.api.get(`/pets/${app.pet.id}/overview`) : Promise.resolve({}), [app.api, app.pet?.id]);
  const device = overview.data?.device, pet = app.pet, ready = !!overview.data && !overview.error;
  return <Page screenId="08" navigation={navigation} title="Ready for the trail." subtitle={`${pet?.name ?? 'Your companion'}'s collar · ${device?.serial_no ?? (ready ? 'Not bound' : 'Status not yet read')}`}>
    <Card tone="forest"><Text style={s.forestCaption}>{device ? device.connection_status ?? 'CONNECTION UNKNOWN' : ready ? 'NO COLLAR BOUND' : 'COLLAR STATUS UNKNOWN'}</Text><Text style={s.battery}>{device?.battery_pct == null ? 'Battery unknown' : `${device.battery_pct}% battery`}</Text><Text style={s.forestCaption}>Last received: {when(device?.last_seen_at)}</Text></Card>
    <Row title="Battery & charging" subtitle={device?.battery_pct == null ? 'No battery reading' : `${device.battery_pct}% reported · remaining duration unknown`} onPress={() => go(navigation, '33')} />
    <Row title="Location & GPS" subtitle="Review quality and freshness" onPress={() => go(navigation, '30')} />
    <Row title="Power settings" subtitle={device?.reporting?.desired?.mode ?? 'No reporting policy received'} onPress={() => go(navigation, '34')} />
    <Row title="Home boundary" subtitle="Your saved boundary and notification choices" onPress={() => go(navigation, '31')} />
    <Caption>Firmware {device?.firmware_version ?? 'unknown'} · Bluetooth not configured</Caption>
    {overview.loading && <Caption>Reading collar status…</Caption>}{overview.error && <Notice text={overview.error} tone="error" />}
    <Button title="Refresh collar status" secondary disabled={overview.loading} run={overview.refresh} />
    {ready && !device && pet && <Button title="Bind a pre-provisioned collar" onPress={() => go(navigation, '04', { from: '08', petId: pet.id })} />}
    <Button title="Ownership, commands and advanced settings" secondary onPress={() => navigation.navigate('Devices')} />
    <Button title="Connection help" secondary onPress={() => navigation.navigate('Support')} />
  </Page>;
}

const s = StyleSheet.create({
  welcomeTitle: { fontSize: 40, lineHeight: 48, fontWeight: '700', color: palette.forest }, welcomeSubtitle: { fontSize: 15, lineHeight: 21, color: palette.inkMuted, marginTop: -6 },
  welcomeArtwork: { alignItems: 'center', justifyContent: 'center', minHeight: 270, marginTop: 6 }, welcomeFootnote: { color: palette.inkMuted, fontSize: 10, lineHeight: 14, textAlign: 'center' },
  loginArtwork: { alignItems: 'flex-end', marginBottom: 8 }, meetArtwork: { alignItems: 'center', marginBottom: 0 },
  collarArtwork: { alignItems: 'center', marginVertical: 22 }, connectedArtwork: { alignItems: 'center', marginVertical: 12 },
  form: { gap: 12 }, pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, advanced: { gap: 12, marginTop: 8 },
  pair: { flexDirection: 'row', backgroundColor: palette.white, borderRadius: 16 }, half: { flex: 1 },
  battery: { color: palette.white, fontSize: 30, fontWeight: '700', lineHeight: 38 },
  forestCaption: { color: palette.sage, fontSize: 13, lineHeight: 18 },
  textLink: { minHeight: 28, justifyContent: 'center', alignItems: 'center' }, textLinkText: { color: palette.forest, fontSize: 13, lineHeight: 18, textDecorationLine: 'underline' },
});
