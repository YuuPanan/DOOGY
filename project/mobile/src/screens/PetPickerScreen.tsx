import { useApp } from '../state/AppContext';
import { Button, Card, Notice, Page } from '../ui';
import { AppScreenProps } from '../types';

export function PetPickerScreen({ navigation }: AppScreenProps) {
  const { pets, households, pet, selectPet } = useApp();
  return <Page title="切换当前宠物" subtitle="切换后将显示新宠物的数据，未保存的宠物表单会清除；当前导航、本人课程及家庭选择保留。">
    {!pets.length && <Notice text="还没有宠物档案，可以先完成建档；家庭联系人不要求先有宠物。" />}
    {pets.map(item => <Card key={item.id} title={item.name}><Notice text={`${households.find(h => h.id === item.household_id)?.name ?? '家庭'}${pet?.id === item.id ? ' · 当前选择' : ''}`} />
      <Button title={pet?.id === item.id ? `继续查看 ${item.name}` : `切换到 ${item.name}`} onPress={() => { selectPet(item.id); navigation.goBack(); }} />
    </Card>)}
    <Button title="建档或管理宠物" onPress={() => navigation.navigate('Pet')} variant="secondary" />
    <Button title="家庭与成员" onPress={() => navigation.navigate('Household')} variant="secondary" />
    <Button title="家庭联系人" onPress={() => navigation.navigate('Contacts')} variant="secondary" />
  </Page>;
}
