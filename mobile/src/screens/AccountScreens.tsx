import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, StyleSheet, Switch, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Choose, Facts, Field, Heading, Notice, Page } from '../ui';
import { AppScreenProps } from '../types';
import { contactDialUrl } from '../lib/contactPhone';

type Data = Record<string, any>;
const encode = encodeURIComponent;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error ?? '');
const nullable = (value: string) => value.trim() || null;
const roles = [{ label: '照护成员', value: 'caregiver' }, { label: '只读成员', value: 'viewer' }];
const consentOptions = [{ label: '未知', value: 'unknown' }, { label: '成员报告已同意', value: 'reported_granted' }, { label: '成员报告已撤回', value: 'reported_revoked' }];

function Toggle({ label, value, onChange, disabled = false }: { label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return <View style={styles.toggle}><Text style={styles.label}>{label}</Text><Switch value={value} onValueChange={onChange} disabled={disabled} /></View>;
}
function Submit({ title, run, onDone, enabled = true, success }: { title: string; run: () => Promise<any>; onDone?: (value: any) => void | Promise<void>; enabled?: boolean; success?: string }) {
  return enabled ? <Action title={title} run={run} onDone={onDone} success={success} /> : <Button title={title} onPress={() => {}} disabled />;
}
function ResourceState({ loading, error }: { loading: boolean; error: unknown }) {
  return <>{loading && <Notice text="正在读取…" />}{!!error && <Notice text={errorText(error)} tone="error" />}</>;
}
async function confirmRemoval(title: string, message: string) {
  return new Promise<boolean>(resolve => Alert.alert(title, message, [
    { text: '取消', style: 'cancel', onPress: () => resolve(false) },
    { text: '确认删除', style: 'destructive', onPress: () => resolve(true) },
  ], { cancelable: false }));
}

export function ProfileScreen({ navigation }: AppScreenProps) {
  const { api, user, pet, pets, refreshIdentity, selectPet, signOut } = useApp();
  const onboarding = useResource<Data>(() => api.get('/auth/onboarding'), [api, user?.id]);
  const [name, setName] = useState(''), [terms, setTerms] = useState(''), [privacy, setPrivacy] = useState(''), [accept, setAccept] = useState(false);
  useEffect(() => { setName(user?.display_name ?? ''); }, [user?.id, user?.profile_version]);
  useEffect(() => { setTerms(''); setPrivacy(''); setAccept(false); }, [api, user?.id]);
  const saveOnboarding = async (body: Data) => {
    await api.patch('/auth/onboarding', { ...body, expected_version: onboarding.data?.version ?? 0 });
    await onboarding.refresh(); await refreshIdentity();
  };
  return <Page title="个人资料与引导">
    <Card title="我的资料">
      <Facts value={{ 邮箱: user?.email, 资料版本: user?.profile_version ?? 0 }} />
      <Field label="显示名（清空可移除）" value={name} onChangeText={setName} />
      <Notice text="条款记录应对应你实际阅读的文件。当前没有发布条款正文的接口，不预填或代替你接受版本。" />
      <Facts value={{ 当前条款接受记录: user?.consent ?? '尚无记录' }} />
      <Toggle label="记录我本次实际阅读并接受的版本" value={accept} onChange={setAccept} />
      {accept && <><Field label="实际条款版本" value={terms} onChangeText={setTerms} /><Field label="实际隐私政策版本" value={privacy} onChangeText={setPrivacy} /></>}
      <Submit title="保存个人资料" enabled={!accept || !!(terms.trim() && privacy.trim())} run={async () => {
        await api.patch('/auth/me', { display_name: nullable(name), expected_version: user?.profile_version ?? 0,
          ...(accept ? { consent: { terms_version: terms.trim(), privacy_version: privacy.trim(), source: 'mobile_user_reported' } } : {}) });
        await refreshIdentity(); setAccept(false); setTerms(''); setPrivacy('');
      }} success="个人资料已保存" />
      <Button title="刷新本人资料" onPress={refreshIdentity} />
    </Card>
    <Card title="继续设置">
      <Button title="打开分步设置指南" onPress={() => navigation.navigate('Onboarding')} />
      <ResourceState {...onboarding} />
      {onboarding.data && <Facts value={onboarding.data} />}
      <Notice text="后端绑定、手机蓝牙连接和设备实际上报分别记录。完成引导不会伪造蓝牙成功。" />
      {!!pets.length && <Choose value={pet?.id ?? ''} options={pets.map((row: Data) => ({ label: row.name, value: row.id }))} onChange={selectPet} />}
      {onboarding.data?.pet_id && onboarding.data.pet_id !== pet?.id && <Button title="恢复引导所选宠物" onPress={() => selectPet(onboarding.data!.pet_id)} />}
      <Button title="建档或修改宠物" onPress={() => navigation.navigate('Pet')} />
      <Submit title="暂时跳过项圈并完成引导" enabled={!!pet && !!onboarding.data} run={() => saveOnboarding({ pet_id: pet!.id, collar_choice: 'skipped', completed: true })} />
      <Submit title="使用当前绑定完成引导" enabled={!!pet && !!onboarding.data} run={() => saveOnboarding({ pet_id: pet!.id, collar_choice: 'completed', completed: true })} />
      <Submit title="重新打开当前宠物引导" enabled={!!pet && !!onboarding.data} run={() => saveOnboarding({ pet_id: pet!.id, collar_choice: null, completed: false })} />
      <Button title="设备与连接帮助" onPress={() => navigation.navigate('Devices')} />
      <Button title="刷新引导状态" onPress={onboarding.refresh} />
    </Card>
    <Card title="账户操作">
      <Notice text="Apple / Google 登录暂不可用，当前使用邮箱和密码。" />
      <Button title="家庭与成员" onPress={() => navigation.navigate('Household')} />
      <Button title="通知" onPress={() => navigation.navigate('Notifications')} />
      <Button title="数据导出与隐私管理" onPress={() => navigation.navigate('Privacy')} />
      <Action title="退出登录" run={async () => { await signOut(); }} />
    </Card>
  </Page>;
}

export function PetScreen() {
  const { api, user, household, households, pet, pets, selectPet, refreshIdentity } = useApp();
  const [creating, setCreating] = useState(!pet), [householdId, setHouseholdId] = useState(household?.id ?? '');
  const [name, setName] = useState(''), [species, setSpecies] = useState('dog'), [breed, setBreed] = useState(''), [birth, setBirth] = useState(''), [timezone, setTimezone] = useState(''), [weight, setWeight] = useState('');
  const [image, setImage] = useState<ImagePicker.ImagePickerAsset | null>(null), [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [createdPet, setCreatedPet] = useState<Data | null>(null);
  const [savedReadError, setSavedReadError] = useState('');
  const mounted = useRef(true), scope = useRef({ api, user: user?.id, pet: pet?.id, creating, householdId });
  if (scope.current.api !== api || scope.current.user !== user?.id || scope.current.pet !== pet?.id || scope.current.creating !== creating || scope.current.householdId !== householdId)
    scope.current = { api, user: user?.id, pet: pet?.id, creating, householdId };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setHouseholdId(household?.id ?? ''); setImage(null); setAvatarUri(null);
    if (!creating && pet) { setName(pet.name); setSpecies(pet.species); setBreed(pet.breed ?? ''); setBirth(pet.birth_date ?? ''); setTimezone(pet.timezone ?? ''); }
    else { setName(''); setSpecies('dog'); setBreed(''); setBirth(''); setTimezone(''); }
    setWeight('');
  }, [api, user?.id, creating, pet?.id, pet?.updated_at, household?.id]);
  const targetHousehold = households.find((row: Data) => row.id === (creating ? householdId : pet?.household_id));
  const writable = !!targetHousehold && targetHousehold.role !== 'viewer';
  const body = () => ({ name: name.trim(), species, breed: nullable(breed), birth_date: nullable(birth), timezone: nullable(timezone), ...(weight.trim() ? { weight_kg: Number(weight) } : {}) });
  const readSavedPet = async (result: Data, submittedScope: typeof scope.current) => {
    if (!mounted.current || scope.current !== submittedScope) return;
    setSavedReadError('');
    try { await refreshIdentity(); }
    catch (error) { if (mounted.current && scope.current === submittedScope) setSavedReadError(error instanceof Error ? error.message : '档案列表读取失败，请重试'); throw error; }
    if (!mounted.current || scope.current !== submittedScope) return;
    selectPet(result.id); setCreatedPet(null); setCreating(false); setWeight('');
  };
  return <Page title="宠物档案">
    <Card title="选择档案">
      {!!pets.length && <Choose value={creating ? '' : pet?.id ?? ''} options={pets.map((row: Data) => ({ label: row.name, value: row.id }))} onChange={id => { setCreating(false); selectPet(id); }} />}
      <Button title="新建宠物" disabled={!!createdPet} onPress={() => setCreating(true)} />
      <Button title="刷新宠物档案" onPress={refreshIdentity} />
    </Card>
    {createdPet ? <Card title="档案已经保存"><Notice text="服务器已保存本次档案。若列表读取失败，请重试读取；不会再次提交建档或称重。" /><Notice text={savedReadError} tone="error" /><Facts value={{ 名称: createdPet.name, 档案ID: createdPet.id }} />
      <Action title="重新读取已保存宠物" run={() => readSavedPet(createdPet, scope.current)} /></Card> : <Card title={creating ? '新建档案' : `编辑 ${pet?.name ?? '宠物'}`}>
      {creating && <Choose value={householdId} options={households.filter((row: Data) => row.role !== 'viewer').map((row: Data) => ({ label: row.name, value: row.id }))} onChange={setHouseholdId} />}
      {!writable && <Notice text="当前家庭为只读，只有所有者和照护成员可以修改宠物。" />}
      <Field label="名称" value={name} onChangeText={setName} />
      <Choose value={species} options={[{ label: '狗', value: 'dog' }, { label: '猫', value: 'cat' }, { label: '其他', value: 'other' }]} onChange={setSpecies} />
      <Field label="品种（可空）" value={breed} onChangeText={setBreed} />
      <Field label="出生日期 YYYY-MM-DD（可空）" value={birth} onChangeText={setBirth} />
      <Field label="IANA 时区（空则跟随家庭）" value={timezone} onChangeText={setTimezone} placeholder="Asia/Shanghai" />
      <Facts value={{ 当前体重kg: creating ? null : pet?.weight_kg, 生效时区: creating ? targetHousehold?.timezone : pet?.effective_timezone }} />
      <Field label={creating ? '初始体重 kg（可空）' : '本次称重 kg（留空不新增称重）'} value={weight} onChangeText={setWeight} keyboardType="decimal-pad" />
      {!creating && <Notice text="修改体重会生成一条称重记录；历史体重在照护页面查看和撤回。" />}
      <Submit title={creating ? '建立宠物档案' : '保存档案'} enabled={writable && !!name.trim() && (!weight.trim() || Number(weight) > 0)} run={async () => {
        const submittedScope = scope.current;
        const result = creating ? await api.post('/pets', { ...body(), household_id: householdId }) : await api.patch(`/pets/${pet!.id}`, body());
        if (!mounted.current || scope.current !== submittedScope) return;
        setCreatedPet(result);
        await readSavedPet(result, submittedScope);
      }} success="宠物档案已保存" />
    </Card>}
    {!creating && pet && <Card title="宠物头像">
      <Notice text="头像支持 JPEG、PNG、WebP，最多 5 MiB；服务器仍会验证内容和版本。" />
      <Facts value={pet.avatar ?? '尚未设置头像'} />
      {avatarUri && <Image source={{ uri: avatarUri }} style={styles.avatar} />}
      {pet.avatar && <Action title="查看 / 分享当前头像" run={async () => {
        const suffix = pet.avatar.content_type === 'image/png' ? 'png' : pet.avatar.content_type === 'image/webp' ? 'webp' : 'jpg';
        await api.download(pet.avatar.content_path, `pet-avatar-${pet.id}.${suffix}`);
      }} />}
      {writable && <>
        <Action title="从相册选择头像" run={async () => {
          const submittedScope = scope.current;
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.9 });
          if (mounted.current && scope.current === submittedScope && !result.canceled) { setImage(result.assets[0]); setAvatarUri(result.assets[0].uri); }
        }} />
        <Submit title="确认替换头像" enabled={!!image} run={async () => {
          if (!image) return;
          if (image.fileSize && image.fileSize > 5 * 1024 * 1024) throw new Error('头像超过 5 MiB，请选择更小的图片');
          const extension = (image.fileName ?? image.uri).split('.').pop()?.toLowerCase();
          const mimeType = image.mimeType ?? (extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : ['jpg', 'jpeg'].includes(extension ?? '') ? 'image/jpeg' : '');
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('请选择 JPEG、PNG 或 WebP 图片');
          await api.upload(`/pets/${pet.id}/avatar`, { uri: image.uri, name: image.fileName ?? 'avatar.jpg', mimeType }, undefined,
            { method: 'PUT', fields: { expected_version: String(pet.avatar?.version ?? 0) } });
          setImage(null); setAvatarUri(null); await refreshIdentity();
        }} success="头像已替换" />
      </>}
    </Card>}
  </Page>;
}

export function HouseholdScreen({ navigation }: AppScreenProps) {
  const { api, user, household, households } = useApp();
  const [householdId, setHouseholdId] = useState(household?.id ?? '');
  const active = households.find((row: Data) => row.id === householdId) ?? household ?? households[0];
  if (!active) return <Page title="家庭与成员"><Notice text="当前没有可访问的家庭。" /></Page>;
  return <HouseholdBody key={`${api.baseUrl}:${user?.id}:${active.id}:${active.role}`} navigation={navigation} active={active} changeHousehold={setHouseholdId} />;
}
function HouseholdBody({ navigation, active, changeHousehold }: { navigation: any; active: Data; changeHousehold: (id: string) => void }) {
  const { api, user, households, refreshIdentity } = useApp();
  const householdId = active.id, owner = active.role === 'owner';
  const [name, setName] = useState(active.name ?? ''), [timezone, setTimezone] = useState(active.timezone ?? '');
  const [email, setEmail] = useState(''), [role, setRole] = useState('viewer'), [token, setToken] = useState(''), [invitation, setInvitation] = useState<Data | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setName(active.name ?? ''); setTimezone(active.timezone ?? ''); }, [active.name, active.timezone]);
  const members = useResource<Data>(() => householdId ? api.get(`/households/${householdId}/members`) : Promise.resolve({ items: [] }), [api, householdId]);
  return <Page title="家庭与成员">
    <Card title="当前管理的家庭">
      <Choose value={householdId} options={households.map((row: Data) => ({ label: `${row.name} · ${row.role}`, value: row.id }))} onChange={changeHousehold} />
      <Facts value={active ?? '暂无家庭'} />
      <Field label="家庭名称" value={name} onChangeText={setName} />
      <Field label="家庭 IANA 时区" value={timezone} onChangeText={setTimezone} />
      <Submit title="保存家庭设置" enabled={owner && !!name.trim() && !!timezone.trim()} run={async () => { await api.patch(`/households/${householdId}`, { name: name.trim(), timezone: timezone.trim() }); await refreshIdentity(); }} />
      <Button title="当前宠物家庭的联系人" onPress={() => navigation.navigate('Contacts')} />
    </Card>
    <Card title="家庭成员">
      <ResourceState {...members} />
      {(members.data?.items ?? []).map((member: Data) => <View key={member.user_id} style={styles.item}>
        <Facts value={{ 邮箱: member.email, 角色: member.role, 本人: member.user_id === user?.id, 加入时间: member.created_at }} />
        {owner && member.role !== 'owner' && <>
          <Action title={member.role === 'viewer' ? '允许照护编辑' : '改为只读'} run={async () => { await api.patch(`/households/${householdId}/members/${member.user_id}`, { role: member.role === 'viewer' ? 'caregiver' : 'viewer' }); await members.refresh(); }} />
          <Action title="移除这位成员" run={async () => { if (!await confirmRemoval('移除家庭成员', `移除 ${member.email} 后将撤销其家庭访问权限。`) || !mounted.current) return; await api.delete(`/households/${householdId}/members/${member.user_id}`); await members.refresh(); }} />
        </>}
      </View>)}
      <Button title="刷新成员" onPress={members.refresh} />
    </Card>
    {owner && <Card title="邀请成员">
      <Field label="被邀请人的邮箱" value={email} onChangeText={setEmail} keyboardType="email-address" />
      <Choose value={role} options={roles} onChange={setRole} />
      <Submit title="生成七天有效邀请" enabled={!!email.trim()} run={async () => { setInvitation(null); const value = await api.post(`/households/${householdId}/invitations`, { email: email.trim(), role }); if (mounted.current) setInvitation(value); }} />
      {invitation && <><Notice text="邀请未自动发送。请将邀请码交给被邀请人，并让其使用该邮箱登录后接受。" /><Text selectable style={styles.token}>{invitation.token}</Text><Facts value={{ 被邀请邮箱: invitation.email, 角色: invitation.role, 到期时间: invitation.expires_at }} /><Action title="复制邀请码" run={() => Clipboard.setStringAsync(invitation.token)} /></>}
    </Card>}
    <Card title="接受邀请">
      <Field label="邀请码" value={token} onChangeText={setToken} />
      <Submit title="使用本人邮箱接受邀请" enabled={!!token.trim()} run={async () => { await api.post(`/invitations/${encode(token.trim())}/accept`, {}); setToken(''); await refreshIdentity(); await members.refresh(); }} />
      <Notice text="所有权转移需要当前所有者密码，在隐私管理页面操作。" />
      <Button title="所有权与删除管理" onPress={() => navigation.navigate('Privacy')} />
    </Card>
  </Page>;
}

export function ContactsScreen() {
  const { api, user, household, households } = useApp();
  const [householdId, setHouseholdId] = useState(household?.id ?? '');
  const selected = households.find((row: Data) => row.id === householdId) ?? household ?? households[0];
  if (!selected) return <Page title="联系人与文字通知"><Notice text="当前没有可访问的家庭。" /></Page>;
  return <ContactsBody key={`${api.baseUrl}:${user?.id}:${selected.id}:${selected.role}`} household={selected} changeHousehold={setHouseholdId} />;
}
function ContactsBody({ household, changeHousehold }: { household: Data; changeHousehold: (id: string) => void }) {
  const { api, user, households, pet, pets } = useApp();
  const roleLabels: Record<string, string> = { owner: '所有者', caregiver: '照护成员', viewer: '只读成员' };
  const [cursor, setCursor] = useState(''), [editing, setEditing] = useState<Data | null>(null);
  const [readRevision, setReadRevision] = useState(0), [editingRevision, setEditingRevision] = useState(0), [knownContacts, setKnownContacts] = useState<Record<string, Data>>({});
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [purpose, setPurpose] = useState(''), [phone, setPhone] = useState(''), [email, setEmail] = useState('');
  const [primary, setPrimary] = useState(false), [report, setReport] = useState(false), [consent, setConsent] = useState('unknown'), [note, setNote] = useState('');
  const [selection, setSelection] = useState<Record<string, { contact_id: string; expected_version: number; method: string; name: string; read_revision: number }>>({});
  const [message, setMessage] = useState(''), [alertConsent, setAlertConsent] = useState(false), [minutes, setMinutes] = useState('15');
  const [createdAlert, setCreatedAlert] = useState<{ id: string; pet_id: string } | null>(null);
  const familyPets = pets.filter((row: Data) => row.household_id === household.id);
  const [alertPetId, setAlertPetId] = useState(pet && pet.household_id === household.id ? pet.id : '');
  const alertPet = familyPets.find((row: Data) => row.id === alertPetId), alertScope = useRef({ petId: alertPet?.id ?? null }), alertMounted = useRef(true);
  if (alertScope.current.petId !== (alertPet?.id ?? null)) alertScope.current = { petId: alertPet?.id ?? null };
  useEffect(() => { alertMounted.current = true; return () => { alertMounted.current = false; }; }, []);
  const writable = ['owner', 'caregiver'].includes(household.role);
  const contacts = useResource<Data>(() => api.get(`/households/${household.id}/contacts?limit=25${cursor ? `&cursor=${encode(cursor)}` : ''}`), [api, household.id, cursor]);
  useEffect(() => { if (contacts.data) setKnownContacts(previous => ({ ...previous, ...Object.fromEntries(contacts.data!.items.map((row: Data) => [row.id, { version: row.version, email: !!row.email, phone: !!row.phone }])) })); }, [contacts.data]);
  const latestContacts = { ...knownContacts, ...Object.fromEntries((contacts.data?.items ?? []).map((row: Data) => [row.id, row])) };
  const editingCurrent = !editing || (editingRevision === readRevision && latestContacts[editing.id]?.version === editing.version);
  const selectionCurrent = (row: typeof selection[string]) => row.read_revision === readRevision && latestContacts[row.contact_id]?.version === row.expected_version && !!latestContacts[row.contact_id]?.[row.method];
  const staleSelection = Object.values(selection).some(row => !selectionCurrent(row));
  function resetForm() { setEditing(null); setName(''); setDescription(''); setPurpose(''); setPhone(''); setEmail(''); setPrimary(false); setReport(false); setConsent('unknown'); setNote(''); }
  const edit = (row: Data) => { setEditing(row); setEditingRevision(readRevision); setName(row.name); setDescription(row.role_description); setPurpose(row.purpose); setPhone(row.phone ?? ''); setEmail(row.email ?? ''); setPrimary(row.is_primary); setReport(false); setConsent(row.consent.status); setNote(''); };
  const refreshContacts = async () => { setReadRevision(value => value + 1); setAlertConsent(false); await contacts.refresh(); };
  return <Page title="联系人与文字通知">
    <Card title="管理家庭"><Choose value={household.id} options={households.map((row: Data) => ({ label: `${row.name} · ${roleLabels[row.role] ?? row.role}`, value: row.id }))} onChange={changeHousehold} /><Notice text="切换家庭会清除本页草稿、收件人选择及已读取的通知。家庭没有宠物时仍可管理联系人。" /></Card>
    <Notice text={`管理家庭：${household.name}。联系方式与同意由家庭成员报告，未经收件人核验。`} />
    <Card title="家庭联系人">
      <ResourceState {...contacts} />
      <Notice text={contacts.data?.primary_contact_id ? '已设置主联系人，姓名会在对应联系人旁标注。' : '尚未设置主联系人。'} />
      {(contacts.data?.items ?? []).map((row: Data) => <View key={row.id} style={styles.item}>
        <Heading>{row.name}{row.is_primary ? ' · 主联系人' : ''}</Heading>
        <Facts value={{ 电话: row.phone, 邮箱: row.email, 关系说明: row.role_description, 用途: row.purpose, 版本: row.version, 同意报告: row.consent }} />
        {!!row.phone && <><Action title={`打开拨号器联系 ${row.name}`} run={async () => { const uri = contactDialUrl(row.phone); try { await Linking.openURL(uri); } catch { throw new Error('本机未能打开拨号器；可以复制原始号码后在电话应用中使用。'); } }} />
          <Action title="复制原始电话号码" run={() => Clipboard.setStringAsync(row.phone)} success="号码已复制，请在电话应用中核对后使用。" /></>}
        {writable && <>
          <Button title="编辑联系人或报告同意" disabled={contacts.loading} onPress={() => edit(row)} />
          <Action title={row.is_primary ? '取消主联系人' : '设为唯一主联系人'} run={async () => { await api.patch(`/contacts/${row.id}`, { expected_version: row.version, is_primary: !row.is_primary }); await refreshContacts(); }} />
          <Action title="删除联系人" run={async () => {
            if (!await confirmRemoval('删除联系人', `删除 ${row.name} 并使其旧通知选择失效？已模拟历史仍会保留状态。`) || !alertMounted.current) return;
            await api.delete(`/contacts/${row.id}`, { expected_version: row.version }); await refreshContacts();
          }} />
          <Text style={styles.label}>本次通知的联系方式</Text>
          {selection[row.id] && !selectionCurrent(selection[row.id]) && <Notice tone="warning" text="原收件选择已失效，请核对最新联系方式及同意报告后重新点选；不会自动采用新版本。" />}
          {!contacts.loading && <Choose value={selection[row.id] && selectionCurrent(selection[row.id]) ? selection[row.id].method : ''} options={[{ label: '不选择', value: '' }, ...(row.email ? [{ label: '邮箱', value: 'email' }] : []), ...(row.phone ? [{ label: '电话', value: 'phone' }] : [])]} onChange={method => { setAlertConsent(false); setSelection(previous => {
            const next = { ...previous }; if (!method) delete next[row.id]; else next[row.id] = { contact_id: row.id, expected_version: row.version, method, name: row.name, read_revision: readRevision }; return next;
          }); }} />}
        </>}
      </View>)}
      {!contacts.loading && !contacts.error && contacts.data && !contacts.data.items.length && <Notice text="暂无联系人。" />}
      <Notice text="拨号入口交给本机电话应用处理，不记录已接通；与下方的文字通知请求分别操作。" />
      <Button title="刷新本页并重新核对草稿和收件人" onPress={refreshContacts} disabled={contacts.loading} />
      {!!cursor && <Button title="返回第一页" onPress={() => setCursor('')} />}
      {contacts.data?.next_cursor && <Button title="下一页" onPress={() => setCursor(contacts.data!.next_cursor)} />}
    </Card>
    {writable && <Card title={editing ? `编辑 ${editing.name} · 版本 ${editing.version}` : '添加联系人'}>
      {!editingCurrent && <><Notice tone="warning" text="旧草稿已失效并暂停保存。请先在最新列表重新打开该联系人，旧输入不会自动合并到新版本。" /><Button title="放弃旧草稿并重新选择联系人" onPress={resetForm} /></>}
      <Field label="姓名" value={name} onChangeText={setName} />
      <Field label="关系说明" value={description} onChangeText={setDescription} />
      <Field label="联系用途" value={purpose} onChangeText={setPurpose} />
      <Field label="电话（按原样填写，不自动猜测区号）" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
      <Field label="邮箱（至少保留一种联系方式）" value={email} onChangeText={setEmail} keyboardType="email-address" />
      <Toggle label="设为本家庭唯一主联系人" value={primary} onChange={setPrimary} />
      <Toggle label="本次显式记录一条收件同意报告" value={report} onChange={setReport} />
      {report && <><Choose value={consent} options={consentOptions} onChange={setConsent} /><Field label="报告备注（可空）" value={note} onChangeText={setNote} multiline /></>}
      <Notice text="修改联系方式会重置旧同意报告；只有本次显式报告才保存新状态。切换主联系人也会升版并使旧通知选择失效，删除不自动递补。" />
      <Submit title={editing ? '保存联系人修改' : '添加联系人'} enabled={editingCurrent && !contacts.loading && !!contacts.data && !!name.trim() && !!(phone.trim() || email.trim())} run={async () => {
        const input = { name: name.trim(), role_description: description.trim(), purpose: purpose.trim(), phone: nullable(phone), email: nullable(email), is_primary: primary,
          ...(report ? { consent: { status: consent, note: note.trim() } } : {}) };
        if (editing) await api.patch(`/contacts/${editing.id}`, { ...input, expected_version: editing.version });
        else await api.post(`/households/${household.id}/contacts`, input);
        resetForm(); await refreshContacts();
      }} />
      <Button title="清空表单 / 新建" onPress={resetForm} />
    </Card>}
    <Card title="文字通知请求">
      <Notice text="只包含你填写的文字，不自动附加位置链接。offline 为本地模拟；api 渠道未配置会失败，均不代表手机真实送达。" />
      <Choose value={alertPet?.id ?? ''} options={[{ label: '请选择本家庭宠物', value: '' }, ...familyPets.map((row: Data) => ({ label: row.name, value: row.id }))]} onChange={id => { alertScope.current = { petId: id || null }; setAlertPetId(id); setMessage(''); setAlertConsent(false); setCreatedAlert(null); }} />
      {!familyPets.length && <Notice text="本家庭尚无宠物，可以继续管理联系人；添加宠物后才能创建文字通知请求。" />}
      {!!familyPets.length && !alertPet && <Notice text="选择本家庭宠物后，可查看其通知请求历史和逐人结果。" />}
      <Facts value={{ 本次通知宠物: alertPet?.name ?? '未选择', 已选: Object.values(selection).map(row => ({ 姓名: row.name, 方式: row.method, 状态: selectionCurrent(row) ? '已选，待本次确认' : '已失效，需重新选择' })) }} />
      {staleSelection && <><Notice tone="warning" text="有旧收件选择已失效，暂不能创建请求。请在联系人列表重新核对并选择；不在本页的联系人可翻页重新选择。" /><Button title="清除全部收件选择" onPress={() => { setSelection({}); setAlertConsent(false); }} /></>}
      {writable && <>
        <Field label="给所选联系人的文字（1–1000字）" value={message} onChangeText={setMessage} multiline />
        <Field label="请求有效分钟（1–60）" value={minutes} onChangeText={setMinutes} keyboardType="number-pad" />
        <Toggle label="我确认本次文字及所选收件人" value={alertConsent} onChange={setAlertConsent} />
        <Submit key={alertPet?.id ?? ''} title="创建文字通知请求" enabled={!!alertPet && !contacts.loading && !!contacts.data && !staleSelection && alertConsent && message.trim().length > 0 && message.trim().length <= 1000 && Object.keys(selection).length > 0 && Object.keys(selection).length <= 10 && Number.isInteger(Number(minutes) * 60) && Number(minutes) >= 1 && Number(minutes) <= 60} run={async () => {
          const scope = alertScope.current, petId = alertPet!.id;
          const result = await api.post(`/pets/${petId}/contact-alerts`, { message: message.trim(), consent: true, recipients: Object.values(selection).map(row => ({ contact_id: row.contact_id, expected_version: row.expected_version, method: row.method })), expires_in_seconds: Number(minutes) * 60 });
          if (!alertMounted.current || alertScope.current !== scope) return;
          if (!result.id || result.pet_id !== petId) throw new Error('通知请求与当前宠物不匹配，请重新读取');
          setCreatedAlert({ id: result.id, pet_id: petId }); setAlertConsent(false);
        }} success="请求已受理，请读取逐人处理结果" />
      </>}
    </Card>
    {alertPet && <ContactAlertHistory key={`${api.baseUrl}:${user?.id}:${household.id}:${alertPet.id}:${household.role}`} petId={alertPet.id} canWrite={writable} initialSelection={createdAlert?.pet_id === alertPet.id ? createdAlert : null} />}
  </Page>;
}

function ContactAlertHistory({ petId, canWrite, initialSelection }: { petId: string; canWrite: boolean; initialSelection: { id: string; pet_id: string } | null }) {
  const { api } = useApp();
  const [cursor, setCursor] = useState(''), [revision, setRevision] = useState(0), [manualId, setManualId] = useState('');
  const [selected, setSelected] = useState<{ id: string; revision: number } | null>(null), selectionSequence = useRef(0);
  const history = useResource<Data>(async () => {
    const result = await api.get(`/pets/${petId}/contact-alerts?limit=10${cursor ? `&cursor=${encode(cursor)}` : ''}`);
    if (result.pet_id !== petId || !Array.isArray(result.items) || result.items.some((row: Data) => row.pet_id !== petId)) throw new Error('通知历史与当前宠物不匹配，请刷新');
    return result;
  }, [api, petId, cursor, revision]);
  const selectRequest = (id: string) => { setManualId(id); setSelected({ id, revision: ++selectionSequence.current }); };
  const resetHistory = (nextCursor = '') => { setSelected(null); setManualId(''); setCursor(nextCursor); setRevision(value => value + 1); };
  useEffect(() => {
    if (!initialSelection || initialSelection.pet_id !== petId) return;
    setCursor(''); setRevision(value => value + 1); selectRequest(initialSelection.id);
  }, [initialSelection, petId]);
  if (selected) return <>
    <Button title="返回通知请求历史" onPress={() => { setSelected(null); setManualId(''); }} />
    <ContactAlertDetail key={`${selected.id}:${selected.revision}`} petId={petId} id={selected.id} canWrite={canWrite} onChanged={() => {
      setCursor(''); setRevision(value => value + 1); selectRequest(selected.id);
    }} />
  </>;
  const statusLabels: Record<string, string> = { pending: '待处理', simulated: '已模拟', partial: '部分完成', failed: '失败', cancelled: '已取消' };
  return <Card title="通知请求历史">
      <Notice text="显示当前宠物的全部请求历史，按创建时间从新到旧排列。模拟状态不代表真实送达，点选后读取当前逐人结果。" />
      <ResourceState {...history} />
      <Button title="刷新历史并返回第一页" onPress={() => resetHistory()} disabled={history.loading} />
      {!!cursor && <Button title="返回历史第一页" onPress={() => resetHistory()} disabled={history.loading} />}
      {!!history.data?.next_cursor && <Button title="下一页通知请求" onPress={() => resetHistory(history.data!.next_cursor)} disabled={history.loading} />}
      {(history.data?.items ?? []).map((row: Data) => <View key={row.id} style={styles.item}>
        <Text numberOfLines={2} style={styles.label}>{row.message}</Text>
        <Text>{row.created_at} · {statusLabels[row.status] ?? row.status}</Text>
        <Text>收件人{row.counts.total} · 待处理{row.counts.pending} · 已模拟{row.counts.simulated} · 失败{row.counts.failed} · 已取消{row.counts.cancelled}</Text>
        <Button title="查看此请求的逐人结果" onPress={() => selectRequest(row.id)} disabled={history.loading} />
      </View>)}
      {!history.loading && !history.error && history.data && !history.data.items.length && <Notice text="此宠物暂无文字通知请求。" />}
      <Field label="按请求ID读取（可选，须属于当前宠物）" value={manualId} onChangeText={setManualId} />
      <Button title="读取指定请求的逐人结果" onPress={() => selectRequest(manualId.trim())} disabled={!manualId.trim()} />
      {!canWrite && <Notice text="当前为只读成员，可查看历史与结果。" />}
    </Card>;
}

function ContactAlertDetail({ petId, id, canWrite, onChanged }: { petId: string; id: string; canWrite: boolean; onChanged: () => void }) {
  const { api } = useApp(), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const detail = useResource<Data>(async () => {
    const result = await api.get(`/contact-alerts/${encode(id)}`);
    if (result.pet_id !== petId || result.id !== id) throw new Error('此通知不属于当前宠物，请从本宠物历史重新选择');
    return result;
  }, [api, petId, id]);
  const alert = detail.data;
  const change = async (action: 'retry' | 'cancel') => {
    const result = await api.post(`/contact-alerts/${encode(id)}/${action}`, { expected_attempt: alert!.attempt });
    if (result.pet_id !== petId || result.id !== id) throw new Error('通知结果与当前宠物不匹配，请重新读取');
    if (alive.current) onChanged();
  };
  return <Card title="所选请求与逐人结果">
    <ResourceState {...detail} />
    <Button title="刷新所选结果与历史" onPress={onChanged} disabled={detail.loading} />
    {alert && <>
      <Facts value={{ 请求ID: alert.id, 宠物ID: alert.pet_id, 状态: alert.status, 模式: alert.captured_mode, 尝试: alert.attempt, 文字: alert.message, 有效期: alert.expires_at, 统计: alert.counts, 位置链接: alert.location_link_included ? '包含' : '不包含' }} />
      {(alert.recipients ?? []).map((row: Data) => <Facts key={row.id} value={{ 收件行ID: row.id, 联系人ID: row.contact_id, 所选版本: row.contact_version, 方式: row.method, 状态: row.status, 原因: row.error_code, 来源: row.execution_source, 尝试: row.attempt, 排队时间: row.queued_at, 处理时间: row.processed_at }} />)}
      {canWrite && <>
        <Submit title="只重试失败收件人" enabled={alert.counts?.failed > 0 && alert.counts?.pending === 0} run={() => change('retry')} />
        <Submit title="取消尚待处理的收件人" enabled={alert.counts?.pending > 0} run={() => change('cancel')} />
      </>}
    </>}
  </Card>;
}

export function NotificationsScreen({ navigation }: AppScreenProps) {
  const { api, user, selectPet } = useApp();
  const [filter, setFilter] = useState('all'), [cursor, setCursor] = useState('');
  const [preferences, setPreferences] = useState<Data>({ geofence: true, battery: true, offline: true, location: true });
  const resource = useResource<Data>(async () => {
    const [list, saved] = await Promise.all([api.get(`/notifications?limit=25${filter === 'all' ? '' : `&unread=${filter === 'unread' ? 'true' : 'false'}`}${cursor ? `&cursor=${encode(cursor)}` : ''}`), api.get('/notification-preferences')]);
    return { ...list, preferences: saved };
  }, [api, user?.id, filter, cursor]);
  useEffect(() => { if (resource.data?.preferences) setPreferences(resource.data.preferences); }, [resource.data?.preferences]);
  return <Page title="通知中心">
    <Card title="通知偏好">
      <ResourceState {...resource} />
      {(['geofence', 'battery', 'offline', 'location'] as const).map((key, index) => <Toggle key={key} label={['围栏进出', '低电提醒', '设备离线', '位置过期'][index]} value={!!preferences[key]} onChange={value => setPreferences(previous => ({ ...previous, [key]: value }))} />)}
      <Submit title="保存本人偏好" enabled={!!resource.data} run={async () => { await api.patch('/notification-preferences', preferences); await resource.refresh(); }} />
      <Notice text="偏好控制新的站内通知；关闭不会删除历史。真实手机推送仍需供应商和终端接入。投递结果、本人已读与家庭事件确认分别记录。" />
    </Card>
    <Card title="本人通知">
      <Choose value={filter} options={[{ label: '全部', value: 'all' }, { label: '未读', value: 'unread' }, { label: '已读', value: 'read' }]} onChange={value => { setFilter(value); setCursor(''); }} />
      {(resource.data?.items ?? []).map((row: Data) => <View key={row.id} style={styles.item}>
        <Facts value={{ 通知ID: row.id, 事件类型: row.type, 宠物ID: row.pet_id, 投递任务状态: row.status, 手机真实送达: '未知', 重试次数: row.retry_count, 错误: row.error, 创建时间: row.created_at, 适配接受时间: row.sent_at, 本人已读: row.read_at ?? '未读' }} />
        {!row.read_at && <Action title="标记本人已读" run={async () => { await api.patch(`/notifications/${row.id}/read`, {}); await resource.refresh(); }} />}
        {row.status === 'dead' && <Action title="重新排队本人失败通知" run={async () => { await api.post(`/notifications/${row.id}/retry`, {}); await resource.refresh(); }} />}
        <Button title="查看安全事件" onPress={() => { selectPet(row.pet_id); navigation.navigate('Safety', { eventId: row.event_id, petId: row.pet_id }); }} />
      </View>)}
      {!resource.loading && !resource.data?.items?.length && <Notice text="当前筛选下没有通知。" />}
      <Button title="刷新通知" onPress={resource.refresh} />
      {!!cursor && <Button title="返回第一页" onPress={() => setCursor('')} />}
      {resource.data?.next_cursor && <Button title="下一页" onPress={() => setCursor(resource.data!.next_cursor)} />}
    </Card>
  </Page>;
}

function retentionSignature(policy: Data) {
  return JSON.stringify({ household_id: policy.household_id, enabled: Boolean(policy.enabled), telemetry_days: policy.telemetry_days,
    activity_days: policy.activity_days, safety_days: policy.safety_days, updated_at: policy.updated_at, last_run_at: policy.last_run_at });
}
function RetentionControls({ household }: { household: Data }) {
  const { api, user } = useApp(), owner = household.role === 'owner';
  const path = `/households/${household.id}/retention`, scopeKey = `${api.baseUrl}:${user?.id}:${household.id}`;
  const [policy, setPolicy] = useState<Data | null>(null), [enabled, setEnabled] = useState(false);
  const [telemetry, setTelemetry] = useState(''), [activity, setActivity] = useState(''), [safety, setSafety] = useState('');
  const [password, setPassword] = useState(''), [changeConfirmed, setChangeConfirmed] = useState(false), [runConfirmation, setRunConfirmation] = useState('');
  const [preview, setPreview] = useState<{ scope: string; signature: string; value: Data } | null>(null), [result, setResult] = useState<Data | null>(null);
  const numbers = [telemetry, activity, safety].map(Number), validDays = numbers.every(value => Number.isInteger(value) && value >= 1 && value <= 3650);
  const draftMatches = !!policy && enabled === policy.enabled && numbers[0] === policy.telemetry_days && numbers[1] === policy.activity_days && numbers[2] === policy.safety_days;
  const savedSignature = policy ? retentionSignature(policy) : '';
  const boundPreview = preview?.scope === scopeKey && preview.signature === savedSignature && draftMatches ? preview.value : null;
  const confirmation = `清理 ${household.id}`;
  function clearPreview() { setPreview(null); setRunConfirmation(''); }
  function editDays(set: (value: string) => void, value: string) { set(value); setChangeConfirmed(false); clearPreview(); setResult(null); }
  async function matchingPolicy() {
    if (!policy) throw new Error('请先读取已保存的策略');
    const latest = await api.get(path);
    if (retentionSignature(latest) !== savedSignature) { setPolicy(null); clearPreview(); throw new Error('策略或最近执行时间已改变，请重新读取、预览并确认'); }
    return latest;
  }
  return <Card title={`${household.name} · 家庭数据保留`}>
    <Notice text="此页管理所选家庭。启用并保存后，服务器 Worker 会自动按期限清理，无需等待你手工执行；关闭不会恢复已清理的数据。只有家庭所有者可以修改、预览或执行。" />
    <Action title="重新读取已保存的保留策略" run={async () => {
      setPolicy(null); clearPreview(); setResult(null); setChangeConfirmed(false); setPassword('');
      const saved = await api.get(path); setPolicy(saved); setEnabled(saved.enabled); setTelemetry(String(saved.telemetry_days)); setActivity(String(saved.activity_days)); setSafety(String(saved.safety_days));
    }} />
    {policy && <>
      <Facts value={{ 已保存策略: policy }} />
      {!policy.updated_at && <Notice text="当前显示服务端默认值，还没有保存策略。请确认并保存，再重新读取后预览。" />}
      <Toggle label="启用服务器自动清理" value={enabled} disabled={!owner} onChange={value => { setEnabled(value); setChangeConfirmed(false); clearPreview(); setResult(null); }} />
      <Field label="遥测保留天数（1–3650）" value={telemetry} onChangeText={value => editDays(setTelemetry, value)} keyboardType="number-pad" editable={owner} />
      <Field label="活动保留天数（1–3650）" value={activity} onChangeText={value => editDays(setActivity, value)} keyboardType="number-pad" editable={owner} />
      <Field label="安全事件保留天数（1–3650）" value={safety} onChangeText={value => editDays(setSafety, value)} keyboardType="number-pad" editable={owner} />
      <Notice text="期限影响遥测位置/原始信号、活动样本、安全事件及关联通知等；执行时也会清理到期或撤销的分享、诊断快照。照护记录与附件、宠物媒体和人工行为不按这三个期限删除。活动来源到期可能使观察、解释/问答结果和反馈证据失效；保留历史行不代表旧正文仍有效。以预览逐项计数为准。" />
      {owner && <>
        <Field label="本人当前密码（保留策略专用）" value={password} onChangeText={setPassword} secureTextEntry />
        <Toggle label="我理解保存启用后 Worker 会自动清理，缩短期限可能造成不可恢复的历史和证据清除" value={changeConfirmed} onChange={setChangeConfirmed} />
        <Submit title="确认保存保留策略" enabled={validDays && password.length >= 8 && password.length <= 128 && changeConfirmed} run={async () => {
          clearPreview(); setResult(null); await matchingPolicy();
          await api.patch(path, { password, enabled, telemetry_days: numbers[0], activity_days: numbers[1], safety_days: numbers[2] });
          setPolicy(null); setPassword(''); setChangeConfirmed(false);
        }} success="策略已保存。启用的策略会由 Worker 自动执行；请重新读取已保存策略后再预览。" />
        {!draftMatches && <Notice text="有未保存的修改，不能预览或执行；请保存后重新读取，或重新读取放弃草稿。" />}
        <Submit title="预览已保存策略的当前影响" enabled={draftMatches && !!policy.updated_at} run={async () => {
          clearPreview(); setResult(null); await matchingPolicy();
          const value = await api.post(`${path}/preview`, {}); await matchingPolicy();
          setPreview({ scope: scopeKey, signature: savedSignature, value });
        }} />
      </>}
    </>}
    {boundPreview && <>
      <Facts value={boundPreview} />
      <Notice text="预览只读，不会清理。计数随时间、数据或 Worker 执行变化；手工执行前会再次核对策略及最近执行时间，最终结果以服务端本次事务为准。关闭的策略可预览，但不能在此手工执行。" />
      {owner && <>
        <Text selectable style={styles.label}>本次手工执行确认文本：{confirmation}</Text>
        <Field label="逐字输入本次清理确认文本" value={runConfirmation} onChangeText={setRunConfirmation} />
        <Submit title="按已预览策略执行一次保留清理" enabled={!!policy?.enabled && password.length >= 8 && password.length <= 128 && runConfirmation === confirmation} run={async () => {
          clearPreview(); await matchingPolicy();
          const executed = await api.post(`${path}/run`, { password }); setResult(executed); setPolicy(null); setPassword(''); setChangeConfirmed(false);
        }} />
      </>}
    </>}
    {result && <Facts value={{ 本次实际执行结果: result }} />}
  </Card>;
}

export function PrivacyScreen() {
  const { api, user, pet, household, households, refreshIdentity, signOut } = useApp();
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [target, setTarget] = useState('');
  const [scope, setScope] = useState('account'), [preview, setPreview] = useState<Data | null>(null), [previewFor, setPreviewFor] = useState(''), [manifest, setManifest] = useState<Data | null>(null), [exportResult, setExportResult] = useState<Data | null>(null);
  const [managedHouseholdId, setManagedHouseholdId] = useState(household?.id ?? '');
  const managed = households.find((row: Data) => row.id === managedHouseholdId), owner = managed?.role === 'owner';
  const petOwner = households.find((row: Data) => row.id === pet?.household_id)?.role === 'owner';
  const members = useResource<Data>(() => owner ? api.get(`/households/${managedHouseholdId}/members`) : Promise.resolve({ items: [] }), [api, managedHouseholdId, owner]);
  useEffect(() => { setManagedHouseholdId(household?.id ?? ''); }, [household?.id]);
  useEffect(() => { setPreview(null); setConfirmation(''); setTarget(''); setPassword(''); }, [scope, managedHouseholdId, pet?.id, user?.id]);
  useEffect(() => { setManifest(null); setExportResult(null); }, [api, user?.id]);
  const requiredConfirmation = scope === 'account' ? 'DELETE' : scope === 'pet' ? pet?.id : managedHouseholdId;
  const previewPath = scope === 'account' ? '/auth/account-deletion' : scope === 'pet' ? `/pets/${pet?.id}/deletion-preview` : `/households/${managedHouseholdId}/deletion-preview`;
  const previewKey = `${api.baseUrl}:${user?.id}:${previewPath}`, currentPreview = previewFor === previewKey ? preview : null;
  const deletionAllowed = scope === 'account' ? currentPreview?.can_close === true : scope === 'pet' ? !!pet && petOwner : owner;
  return <Page title="隐私与所有权">
    <Card title="本人授权数据导出">
      <Notice text="导出包含当前权限下的个人和共享家庭数据，附件可能包含敏感内容。导出过程逐页重新鉴权，不是数据库快照；请谨慎选择分享目标。临时分享文件在30分钟后随下次启动或导出清理，退出登录或切换服务也会清理；系统分享菜单返回不代表对方已收到文件。" />
      <Action title="读取导出范围" run={async () => { setManifest(null); setManifest(await api.get('/auth/data-export')); }} />
      {manifest && <Facts value={manifest} />}
      <Action title="生成账户文件并打开系统分享" run={async () => { setExportResult(null); setExportResult(await api.exportAccount()); }} />
      {exportResult && <Facts value={{ 本次导出统计: exportResult }} />}
    </Card>
    <Card title="家庭所有权转移">
      <Choose value={managedHouseholdId} options={households.map((row: Data) => ({ label: `${row.name} · ${row.role}`, value: row.id }))} onChange={setManagedHouseholdId} />
      <ResourceState {...members} />
      {!owner && <Notice text="只有当前家庭所有者可以转移所有权或删除家庭。" />}
      {owner && <>
        <Notice text="转移后你变为照护成员。此家庭中由你所有且仍绑定的设备会一并转移；新所有者必须已是家庭成员。" />
        <Choose value={target} options={(members.data?.items ?? []).filter((row: Data) => row.user_id !== user?.id).map((row: Data) => ({ label: `${row.email} · ${row.role}`, value: row.user_id }))} onChange={setTarget} />
      </>}
      <Field label="本人当前密码（转移或删除使用）" value={password} onChangeText={setPassword} secureTextEntry />
      <Submit title="确认将家庭所有权转移给所选成员" enabled={owner && !!target && password.length >= 8} run={async () => {
        await api.post(`/households/${managedHouseholdId}/owner`, { password, new_owner_user_id: target }); setPassword(''); setTarget(''); setPreview(null); await refreshIdentity(); await members.refresh();
      }} success="家庭所有权已转移" />
    </Card>
    {managed && <RetentionControls key={`${api.baseUrl}:${user?.id}:${managed.id}:${managed.role}`} household={managed} />}
    <Card title="删除与注销">
      <Choose value={scope} options={[{ label: '注销本人账号', value: 'account' }, { label: '删除当前宠物', value: 'pet' }, { label: '删除所选家庭', value: 'household' }]} onChange={setScope} />
      <Facts value={{ 账号: user?.email, 当前宠物: pet?.name, 所选家庭: managed?.name }} />
      <Submit title="读取本次影响预览" enabled={scope === 'account' || (scope === 'pet' ? !!pet && petOwner : owner)} run={async () => { setPreview(null); setConfirmation(''); const result = await api.get(previewPath); setPreview(result); setPreviewFor(previewKey); }} />
      {currentPreview && <Facts value={currentPreview} />}
      {scope === 'account' && currentPreview?.blockers?.length > 0 && <Notice text="请先转移共享家庭所有权、处理设备归属，再重新读取注销预览。" />}
      <Notice text={scope === 'account' ? '注销会撤销本人会话并删除个人数据；独有家庭会删除，共享事实按服务端规则匿名保留。' : scope === 'pet' ? '删除宠物会移除其共享业务数据、附件和媒体，并使当前设备解绑。' : '删除家庭会删除家庭内全部宠物和共享业务数据，其他成员账号与硬件库存保留。'} />
      <Text selectable style={styles.label}>确认文本：{requiredConfirmation ?? '请先选择对象'}</Text>
      <Field label="逐字输入上面的确认文本" value={confirmation} onChangeText={setConfirmation} />
      <Submit title={scope === 'account' ? '永久注销本人账号' : scope === 'pet' ? '永久删除当前宠物' : '永久删除所选家庭'} enabled={!!currentPreview && deletionAllowed && password.length >= 8 && !!requiredConfirmation && confirmation === requiredConfirmation} run={async () => {
        const path = scope === 'account' ? '/auth/account' : scope === 'pet' ? `/pets/${pet!.id}` : `/households/${managedHouseholdId}`;
        await api.delete(path, { password, confirmation }); setPassword(''); setConfirmation(''); setPreview(null);
        if (scope === 'account') { await api.clear(); await signOut(); } else await refreshIdentity();
      }} />
    </Card>
  </Page>;
}

const styles = StyleSheet.create({
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  label: { flex: 1, fontSize: 14, color: '#253841' }, item: { borderTopWidth: 1, borderTopColor: '#e3e9e8', paddingVertical: 12, gap: 8 },
  avatar: { width: 144, height: 144, borderRadius: 30, alignSelf: 'center' }, token: { fontSize: 14, color: '#263b41', padding: 12, backgroundColor: '#f0f5f3' },
});
