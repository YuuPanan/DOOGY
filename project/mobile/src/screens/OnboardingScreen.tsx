import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useResource } from '../hooks/useResource';
import { Action, Button, Card, Choose, Field, Notice, Page, colors } from '../ui';
import { AppScreenProps, Row } from '../types';

function Continue({ title, enabled, run }: { title: string; enabled: boolean; run: () => Promise<any> }) {
  return enabled ? <Action title={title} run={run} /> : <Button title={title} disabled onPress={() => {}} />;
}
const when = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '暂无';

export function OnboardingScreen(props: AppScreenProps) {
  const { api, user } = useApp();
  return <OnboardingBody key={`${api.baseUrl}:${user?.id}`} {...props} />;
}
function OnboardingBody({ navigation }: AppScreenProps) {
  const { api, user, household, households, pet, pets, refreshIdentity, selectPet } = useApp();
  const guide = useResource<Row>(() => api.get('/auth/onboarding'), [api, user?.id]);
  const [selectedId, setSelectedId] = useState(''), [selectionTouched, setSelectionTouched] = useState(false), [newPet, setNewPet] = useState(false);
  const [name, setName] = useState(''), [species, setSpecies] = useState('dog'), [breed, setBreed] = useState('');
  const writableHouseholds = households.filter(row => ['owner', 'caregiver'].includes(row.role));
  const [householdId, setHouseholdId] = useState(household && household.role !== 'viewer' ? household.id : writableHouseholds[0]?.id ?? '');
  const [created, setCreated] = useState<Row | null>(null), [deviceId, setDeviceId] = useState(''), [claimCode, setClaimCode] = useState('');
  const writing = useRef(false);
  const availablePets = created && !pets.some(row => row.id === created.id) ? [...pets, created] : pets;
  useEffect(() => {
    if (!selectionTouched) {
      const preferred = guide.data?.pet_id ?? pet?.id;
      setSelectedId(availablePets.some(row => row.id === preferred) ? preferred : availablePets[0]?.id ?? '');
    } else if (selectedId && !availablePets.some(row => row.id === selectedId)) { setSelectedId(''); setSelectionTouched(false); }
  }, [guide.data?.pet_id, pets, created, pet?.id, selectionTouched, selectedId]);
  const selected = availablePets.find(row => row.id === selectedId), savedPet = availablePets.find(row => row.id === guide.data?.pet_id);
  const ready = !!guide.data && !guide.loading && !guide.error, completed = guide.data?.next_step === 'done';
  const savedSelection = !!selected && selected.id === guide.data?.pet_id;
  const canBind = !!savedPet && households.some(row => row.id === savedPet.household_id && ['owner', 'caregiver'].includes(row.role));
  const bound = !!guide.data?.binding, skipped = guide.data?.collar_choice === 'skipped';
  const step = !guide.data?.pet_id ? 1 : bound || skipped ? 3 : 2;
  const householdName = (id: string) => households.find(row => row.id === id)?.name ?? '家庭';
  async function serial(work: () => Promise<any>) {
    if (writing.current) throw new Error('上一项设置正在保存，请稍候再继续');
    writing.current = true;
    try { return await work(); } finally { writing.current = false; }
  }
  async function reload() { await Promise.all([guide.refresh(), refreshIdentity()]); }
  async function saveGuide(body: Row) {
    if (!guide.data) throw new Error('请先读取引导状态');
    await api.patch('/auth/onboarding', { ...body, expected_version: guide.data.version });
    await reload();
  }
  function enterApp() {
    navigation.reset({ index: 0, routes: [{ name: 'Main' }] });
  }
  return <Page title={completed ? '设置已经完成' : '认识你的伙伴'} subtitle={`${user?.display_name || '欢迎'}，从宠物档案开始。`}>
    <View style={styles.steps}>{['宠物档案', '项圈选择', '完成'].map((label, index) => <View key={label} style={[styles.step, step === index + 1 && styles.active]}><Text style={styles.stepText}>{index + 1} · {label}</Text></View>)}</View>
    {guide.loading && <Notice text="正在读取你的设置…" />}
    {!!guide.error && <Notice tone="error" text={guide.error} />}
    <Action title="重新读取设置与已有宠物" run={reload} disabled={guide.loading} />
    {completed && <Card title="可以继续照护了">
      <Text style={styles.body}>已为{savedPet?.name ?? '你的宠物'}完成设置，完成时间：{when(guide.data?.completed_at)}。</Text>
      <Notice text="重新查看本页不会撤销已完成状态。选择其他宠物并保存时，会为所选宠物重新继续引导，不会删除已有档案。" />
      <Button title="进入 DOOGY" onPress={enterApp} />
    </Card>}
    <Card title="1 · 选择或建立宠物档案">
      {!!availablePets.length && <>
        <Text style={styles.body}>已有档案可直接继续，无需重复建立。</Text>
        <Choose value={selectedId} options={availablePets.map(row => ({ label: `${row.name} · ${householdName(row.household_id)}`, value: row.id }))} onChange={id => { setSelectedId(id); setSelectionTouched(true); }} />
        <Continue title={savedSelection ? '继续使用这份档案' : '使用所选宠物继续'} enabled={ready && !!selected} run={() => serial(async () => {
          await saveGuide({ pet_id: selected!.id }); selectPet(selected!.id); setNewPet(false); setClaimCode('');
        })} />
      </>}
      <Button title={newPet ? '收起新建档案' : availablePets.length ? '为另一位伙伴新建档案' : '建立第一份宠物档案'} onPress={() => setNewPet(value => !value)} variant="secondary" />
      {(newPet || !availablePets.length) && <>
        {!writableHouseholds.length && <Notice text="目前加入的家庭均为只读。可以选择已有宠物继续，或请家庭所有者/照护成员建立档案后重新读取。" />}
        <Choose value={householdId} options={writableHouseholds.map(row => ({ label: row.name, value: row.id }))} onChange={setHouseholdId} />
        <Field label="宠物名字" value={name} onChangeText={setName} maxLength={100} />
        <Choose value={species} options={[{ label: '狗', value: 'dog' }, { label: '猫', value: 'cat' }, { label: '其他', value: 'other' }]} onChange={setSpecies} />
        <Field label="品种（可稍后填写）" value={breed} onChangeText={setBreed} maxLength={100} />
        <Continue title="建立档案" enabled={ready && !!name.trim() && writableHouseholds.some(row => row.id === householdId)} run={() => serial(async () => {
          const result = await api.post('/pets', { household_id: householdId, name: name.trim(), species, ...(breed.trim() ? { breed: breed.trim() } : {}) });
          setCreated(result); setSelectedId(result.id); setSelectionTouched(true); setNewPet(false); setName(''); setBreed(''); selectPet(result.id);
          await refreshIdentity();
        })} />
        <Notice text="只保存你填写的档案；生日、头像和体重可以稍后补充。建档成功后选择这份档案继续即可。" />
      </>}
      {created && <Notice tone="success" text={`${created.name} 的档案已经建立。即使后续连接失败，也不需要重新建档。`} />}
      <Button title="打开完整宠物档案" variant="secondary" onPress={() => navigation.navigate('Pet')} />
    </Card>
    <Card title="2 · 项圈可以现在绑定，也可以稍后再说">
      {!guide.data?.pet_id ? <Notice text="先选择一份宠物档案并继续。" /> : <>
        <Text style={styles.body}>本次设置的宠物：{savedPet?.name ?? '请重新读取档案'}。</Text>
        {bound ? <Notice tone="success" text={`后端已记录有效项圈绑定，绑定时间：${when(guide.data?.binding?.bound_at)}。`} /> : <Notice text={skipped ? '你已明确选择暂时跳过项圈。' : '尚未记录有效项圈绑定。'} />}
        <Notice text="手机蓝牙功能尚未接入，连接状态未知。后端绑定、手机蓝牙与设备实际上报分别表示；此页不扫描、不伪造连接，也不获取设备长期密钥。" />
        <Text style={styles.body}>{guide.data?.device_report?.status === 'received'
          ? `后端最近收到上报：${when(guide.data.device_report.received_at)}；设备采样时间：${when(guide.data.device_report.sampled_at)}。历史上报不代表此刻在线。`
          : bound ? '已绑定，等待设备实际上报。尚无上报也可以完成引导。' : '未绑定，暂无这份引导关联设备的上报。'}</Text>
        {!savedSelection && <Notice text="上方所选宠物与当前保存的引导不同，请先使用所选档案继续，再绑定或跳过。" />}
        {!bound && canBind && savedSelection && <>
          <Field label="已预置的设备 ID" value={deviceId} onChangeText={setDeviceId} autoCorrect={false} />
          <Field label="有效的短期绑定码" value={claimCode} onChangeText={setClaimCode} autoCorrect={false} secureTextEntry maxLength={200} />
          <Continue title="绑定这份档案与项圈" enabled={ready && !!deviceId.trim() && !!claimCode.trim()} run={() => serial(async () => {
            await api.post('/devices/claim', { pet_id: savedPet!.id, device_id: deviceId.trim(), claim_code: claimCode.trim() });
            setClaimCode(''); await reload();
          })} />
          <Notice text="设备 ID 与绑定码由设备所有者或授权配置人员提供。若请求中断，请先重新读取状态，避免重复尝试绑定码。" />
        </>}
        {!bound && !canBind && <Notice text="当前宠物的家庭为只读。绑定需要所有者或照护成员处理；你仍可明确跳过并开始使用照护功能。" />}
        {!completed && <Continue title="跳过项圈并完成引导" enabled={ready && savedSelection} run={() => serial(async () => { await saveGuide({ pet_id: savedPet!.id, collar_choice: 'skipped', completed: true }); enterApp(); })} />}
        <Button title="设备设置" variant="secondary" onPress={() => { if (savedPet) selectPet(savedPet.id); navigation.navigate('Devices'); }} />
        <Button title="连接遇到问题？查看帮助" variant="secondary" onPress={() => navigation.navigate('Support')} />
      </>}
    </Card>
    {guide.data?.pet_id && (bound || skipped) && !completed && <Card title="3 · 开始陪伴与照护">
      <Text style={styles.body}>{bound ? '后端已确认有效绑定，可以完成设置。' : '没有项圈也能开始记录喂食、体重和日常照护。'}</Text>
      <Continue title="完成设置，开始使用" enabled={ready && savedSelection} run={() => serial(async () => { await saveGuide({ pet_id: savedPet!.id, collar_choice: bound ? 'completed' : 'skipped', completed: true }); enterApp(); })} />
    </Card>}
  </Page>;
}

const styles = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 8 }, step: { flex: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center', backgroundColor: '#e8efe7' },
  active: { borderWidth: 1, borderColor: colors.primary }, stepText: { color: colors.ink, fontSize: 12 }, body: { color: colors.ink, lineHeight: 23 },
});
