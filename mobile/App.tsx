import React from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from './src/state/AppContext';
import { AuthScreen } from './src/screens/AuthScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { SafetyHubScreen } from './src/screens/SafetyHubScreen';
import { PetPickerScreen } from './src/screens/PetPickerScreen';
import { CareScreen, WellnessScreen, HealthScreen } from './src/screens/CareScreens';
import { DevicesScreen, SafetyScreen, SupportScreen } from './src/screens/DeviceScreens';
import { ProfileScreen, PetScreen, HouseholdScreen, ContactsScreen, NotificationsScreen, PrivacyScreen } from './src/screens/AccountScreens';
import { LearningScreen, BehaviorScreen, AssistantScreen } from './src/screens/LearningScreens';
import { colors } from './src/ui';

const Stack = createNativeStackNavigator(), Tabs = createBottomTabNavigator();
const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: colors.primary, background: colors.paper, card: '#fff', text: colors.ink, border: colors.border } };
const pages: [string, string, React.ComponentType<any>][] = [ ['Onboarding', '开始照护', OnboardingScreen], ['SafetyHub', '安全与寻找', SafetyHubScreen], ['PetPicker', '切换宠物', PetPickerScreen], ['Profile', '个人资料', ProfileScreen], ['Pet', '宠物档案', PetScreen], ['Household', '家庭与成员', HouseholdScreen], ['Contacts', '紧急联系人', ContactsScreen], ['Notifications', '通知', NotificationsScreen], ['Privacy', '数据与隐私', PrivacyScreen], ['Care', '日常照护', CareScreen], ['Wellness', '活动与营养', WellnessScreen], ['Health', '健康观察', HealthScreen], ['Devices', '项圈与位置', DevicesScreen], ['Safety', '安全事件', SafetyScreen], ['Support', '帮助与支持', SupportScreen], ['Learning', '学习中心', LearningScreen], ['Behavior', '行为记录', BehaviorScreen], ['Assistant', '照护问答', AssistantScreen] ];
const petPages = new Set(['Pet', 'Care', 'Wellness', 'Health', 'Devices', 'SafetyHub', 'Safety', 'Behavior', 'Assistant']);
function HeaderActions({ navigation }: { navigation: any }) {
  const { pet } = useApp();
  return <View style={{ flexDirection: 'row', gap: 15, alignItems: 'center' }}>
    <Pressable accessibilityRole="button" accessibilityLabel="切换当前宠物" hitSlop={8} onPress={() => navigation.navigate('PetPicker')}><Text numberOfLines={1} style={{ maxWidth: 105, color: colors.primary }}>{pet?.name ?? '选择宠物'} ▾</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="打开我的资料" hitSlop={8} onPress={() => navigation.navigate('Profile')}><Text style={{ color: colors.primary }}>我的</Text></Pressable>
  </View>;
}
function MainTabs() {
  return <Tabs.Navigator screenOptions={({ navigation }) => ({ tabBarActiveTintColor: colors.primary, tabBarLabelStyle: { fontSize: 12 }, headerStyle: { backgroundColor: '#fff' }, headerTintColor: colors.ink, headerRight: () => <HeaderActions navigation={navigation} /> })}>
    {([['HomeTab', '今天', '⌂', HomeScreen], ['SafetyTab', '安全', '◇', SafetyHubScreen], ['UnderstandTab', '读懂', '♧', BehaviorScreen], ['LearnTab', '学习', '▤', LearningScreen], ['AskTab', '问答', '◌', AssistantScreen]] as const).map(([name, title, icon, component]) => <Tabs.Screen key={name} name={name} component={component} options={{ title, tabBarAccessibilityLabel: title, tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 24 }}>{icon}</Text> }} />)}
  </Tabs.Navigator>;
}
function Root() {
  const { booting, authenticated, api, user, pet, epoch, onboarding } = useApp();
  if (booting) return <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.paper }}><ActivityIndicator color={colors.primary} /><Text>正在恢复会话…</Text></View>;
  return <NavigationContainer theme={theme} key={authenticated ? `${api.origin}:${user?.id}:${epoch}` : 'guest'}><Stack.Navigator initialRouteName={authenticated ? onboarding?.next_step === 'done' ? 'Main' : 'Onboarding' : 'Auth'} screenOptions={({ navigation }) => ({ headerTintColor: colors.ink, ...(authenticated ? { headerRight: () => <HeaderActions navigation={navigation} /> } : {}) })}>
    {authenticated ? <><Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />{pages.map(([name, title, Screen]) => <Stack.Screen key={name} name={name} options={{ title }}>{props => <Screen key={`${api.origin}:${user?.id}:${petPages.has(name) ? pet?.id ?? '' : name}`} {...props} />}</Stack.Screen>)}</> : <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'DOOGY' }} />}
  </Stack.Navigator></NavigationContainer>;
}
export default function App() { return <SafeAreaProvider><AppProvider><StatusBar style="dark" /><Root /></AppProvider></SafeAreaProvider>; }
