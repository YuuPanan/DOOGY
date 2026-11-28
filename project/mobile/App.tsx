import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/state/AppContext';
import { AuthScreen } from './src/screens/AuthScreen';
import { SafetyHubScreen } from './src/screens/SafetyHubScreen';
import { PetPickerScreen } from './src/screens/PetPickerScreen';
import { CareScreen, WellnessScreen, HealthScreen } from './src/screens/CareScreens';
import { DevicesScreen, SafetyScreen, SupportScreen } from './src/screens/DeviceScreens';
import { ProfileScreen, PetScreen, HouseholdScreen, ContactsScreen, NotificationsScreen, PrivacyScreen } from './src/screens/AccountScreens';
import { LearningScreen, BehaviorScreen, AssistantScreen } from './src/screens/LearningScreens';
import { colors } from './src/ui';
import { Asset } from './src/pawch/assets';
import { geometry, palette } from './src/pawch/ui';
import { isScreenId, PawchRouter, publicScreenIds } from './src/pawch/Router';

const Stack = createNativeStackNavigator(), Tabs = createBottomTabNavigator(), navigationRef = createNavigationContainerRef<any>();
const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: palette.forest, background: palette.canvas, card: palette.canvas, text: palette.forest, border: palette.sage } };
const pages: [string, string, React.ComponentType<any>][] = [ ['Onboarding', '开始照护', SetupRoute], ['SafetyHub', '安全与寻找', SafetyHubScreen], ['PetPicker', '切换宠物', PetPickerScreen], ['Profile', '个人资料', ProfileScreen], ['Pet', '宠物档案', PetScreen], ['Household', '家庭与成员', HouseholdScreen], ['Contacts', '紧急联系人', ContactsScreen], ['Notifications', '通知', NotificationsScreen], ['Privacy', '数据与隐私', PrivacyScreen], ['Care', '日常照护', CareScreen], ['Wellness', '活动与营养', WellnessScreen], ['Health', '健康观察', HealthScreen], ['Devices', '项圈与位置', DevicesScreen], ['Safety', '安全事件', SafetyScreen], ['Support', '帮助与支持', SupportScreen], ['Learning', '学习中心', LearningScreen], ['Behavior', '行为记录', BehaviorScreen], ['Assistant', '照护问答', AssistantScreen] ];
const petPages = new Set(['Pet', 'Care', 'Wellness', 'Health', 'Devices', 'SafetyHub', 'Safety', 'Behavior', 'Assistant']);
const destinations = [['HomeTab', 'Today', 'nav-today', '09'], ['SafetyTab', 'Safety', 'nav-safety', '28'], ['UnderstandTab', 'Understand', 'nav-understand', '42'], ['LearnTab', 'Learn', 'nav-learn', '48'], ['AskTab', 'Ask AI', 'nav-ask-ai', '51']] as const;
function requestedPage(): Record<string, any> | null {
  if (Platform.OS !== 'web') return null;
  const match = globalThis.location?.hash?.match(/^#pawch\/([0-9]{2}[a-e]?)(?:\?(.*))?$/), id = match?.[1];
  if (!isScreenId(id)) return null;
  const params: Record<string, any> = { screenId: id }, allowed = new Set(['recordId', 'taskId', 'mediaId', 'contentId', 'contentVersion', 'conversationId', 'interpretationId', 'behaviorRecordId', 'observationId', 'evidenceId', 'lessonId', 'lessonVersion', 'from', 'returnTo', 'petId', 'date', 'newPet', 'demo']);
  for (const [name, value] of new URLSearchParams(match?.[2] ?? '')) if (allowed.has(name) && value.length <= 400) {
    if (['contentVersion', 'lessonVersion'].includes(name)) { if (/^[1-9]\d*$/.test(value)) params[name] = Number(value); }
    else params[name] = ['newPet', 'demo'].includes(name) ? value === 'true' : value;
  }
  return params;
}
function BottomNavigation({ active, select }: { active: string; select: (name: string) => void }) {
  const insets = useSafeAreaInsets();
  return <View style={{ backgroundColor: palette.canvas }}><View style={[s.tabs, { paddingBottom: Math.max(25, insets.bottom) }]}>{destinations.map(([name, label, asset]) => <Pressable key={name} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: active === name }} onPress={() => select(name)} style={[s.tab, active === name && { backgroundColor: palette.sage }]}><Asset name={asset} /><Text style={[s.tabLabel, active === name && { fontWeight: '700' }]}>{label}</Text></Pressable>)}</View></View>;
}
const activeTab = (id: string) => { const n = parseInt(id, 10); return n >= 48 ? 'LearnTab' : n >= 40 ? 'UnderstandTab' : n >= 28 ? 'SafetyTab' : 'HomeTab'; };
function ScreenRoute({ navigation, route }: any) {
  const { authenticated } = useApp(), screenId = route.params?.screenId ?? '09';
  return <View style={{ flex: 1, backgroundColor: palette.canvas }}><PawchRouter screenId={screenId} navigation={navigation} route={route} />{authenticated && !['01', '02', '03', '04', '05', '06'].includes(screenId) && <BottomNavigation active={screenId === '51' ? 'AskTab' : activeTab(screenId)} select={name => navigation.popTo('Main', { screen: name })} />}</View>;
}
function SetupRoute({ navigation, route }: any) {
  const { onboarding } = useApp(), id = onboarding?.next_step === 'connect_collar' ? '04' : onboarding?.next_step === 'finish' || onboarding?.next_step === 'done' ? '05' : '03';
  return <PawchRouter screenId={id} navigation={navigation} route={route} />;
}
function HeaderActions({ navigation }: { navigation: any }) {
  const { pet } = useApp();
  return <View style={{ flexDirection: 'row', gap: 15, alignItems: 'center' }}>
    <Pressable accessibilityRole="button" accessibilityLabel="切换当前宠物" hitSlop={8} onPress={() => navigation.navigate('PetPicker')}><Text numberOfLines={1} style={{ maxWidth: 105, color: colors.primary }}>{pet?.name ?? '选择宠物'} ▾</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="打开我的资料" hitSlop={8} onPress={() => navigation.navigate('Profile')}><Text style={{ color: colors.primary }}>我的</Text></Pressable>
  </View>;
}
function MainTabs() {
  return <Tabs.Navigator screenOptions={{ headerShown: false }} tabBar={({ state, navigation }) => <BottomNavigation active={state.routes[state.index].name} select={name => navigation.navigate(name)} />}>
    {destinations.map(([name, title, _asset, screenId]) => <Tabs.Screen key={name} name={name} options={{ title }}>{props => <PawchRouter screenId={screenId} {...props} />}</Tabs.Screen>)}
  </Tabs.Navigator>;
}
function Root() {
  const { booting, authenticated, api, user, pet, epoch, onboarding } = useApp();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const open = () => { const page = requestedPage(); if (page && navigationRef.isReady()) navigationRef.navigate('Pawch', !authenticated && !publicScreenIds.has(page.screenId) ? { screenId: '06' } : page); };
    globalThis.addEventListener?.('hashchange', open); return () => globalThis.removeEventListener?.('hashchange', open);
  }, [authenticated]);
  if (booting) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.paper }}><ActivityIndicator color={colors.primary} /><Text>正在恢复会话…</Text></View>;
  const requested = requestedPage(), initial = authenticated ? onboarding?.next_step === 'done' ? requested && !publicScreenIds.has(requested.screenId) ? 'Pawch' : 'Main' : 'Onboarding' : 'Pawch';
  return <NavigationContainer ref={navigationRef} theme={theme} key={authenticated ? `${api.origin}:${user?.id}:${epoch}` : 'guest'}><Stack.Navigator initialRouteName={initial} screenOptions={({ navigation }) => ({ headerTintColor: colors.ink, ...(authenticated ? { headerRight: () => <HeaderActions navigation={navigation} /> } : {}) })}>
    <Stack.Screen name="Pawch" component={ScreenRoute} initialParams={requested && (authenticated || publicScreenIds.has(requested.screenId)) ? requested : { screenId: '01' }} options={{ headerShown: false }} />
    {authenticated ? <><Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />{pages.map(([name, title, Screen]) => <Stack.Screen key={name} name={name} options={{ title, ...(name === 'Onboarding' ? { headerShown: false } : {}) }}>{props => <Screen key={`${api.origin}:${user?.id}:${petPages.has(name) ? pet?.id ?? '' : name}`} {...props} />}</Stack.Screen>)}</> : <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'DOOGY' }} />}
  </Stack.Navigator></NavigationContainer>;
}
export default function App() { return <SafeAreaProvider><AppProvider><StatusBar style="dark" /><Root /></AppProvider></SafeAreaProvider>; }
const s = StyleSheet.create({ tabs: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 3, width: '100%', maxWidth: 390, alignSelf: 'center', paddingTop: 0, paddingBottom: 25 }, tab: { flex: 1, maxWidth: geometry.navigationTab.width, height: geometry.navigationTab.height, borderRadius: geometry.navigationTab.activeRadius, alignItems: 'center', justifyContent: 'center', gap: 5 }, tabLabel: { fontSize: 10, color: palette.forest } });
