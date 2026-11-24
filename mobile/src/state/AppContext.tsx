import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Alert, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { MobileApi } from '../lib/mobileApi';
import { readIdentity, restoreIdentity } from '../lib/restoreIdentity';
import { Region, Row } from '../types';

type Connection = { region: Region; urls: Record<Region, string> };
type State = { api: MobileApi; booting: boolean; authenticated: boolean; user: Row | null; households: Row[]; pets: Row[]; pet: Row | null; household: Row | null; onboarding: Row | null;
  region: Region; serverUrl: string; configurable: boolean; epoch: number; restoreError: string | null; canRetryRestore: boolean; retryRestore(): Promise<void>;
  configure(region: Region, url: string): Promise<MobileApi>; authenticate(kind: 'login' | 'register', body: Row): Promise<void>; signOut(): Promise<void>;
  refreshIdentity(): Promise<void>; selectPet(id: string): void };
const Context = createContext<State | null>(null);
let webRefresh: string | null = null;
const secret = { read: () => Platform.OS === 'web' ? Promise.resolve(webRefresh) : SecureStore.getItemAsync('doogy.refresh'),
  write: async (token: string | null) => { if (Platform.OS === 'web') webRefresh = token; else if (token) await SecureStore.setItemAsync('doogy.refresh', token); else await SecureStore.deleteItemAsync('doogy.refresh'); } };
const preview = process.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP === '1';
const local = (hostname: string) => /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(hostname);
const defaults: Connection = { region: 'cn', urls: { cn: process.env.EXPO_PUBLIC_CN_API_URL ?? process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? globalThis.location?.origin ?? '' : ''), global: process.env.EXPO_PUBLIC_GLOBAL_API_URL ?? '' } };

export function AppProvider({ children }: React.PropsWithChildren) {
  const [connection, setConnection] = useState<Connection>(defaults), [booting, setBooting] = useState(true), [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<Row | null>(null), [households, setHouseholds] = useState<Row[]>([]), [pets, setPets] = useState<Row[]>([]), [selected, setSelected] = useState(''), [epoch, setEpoch] = useState(0);
  const [onboarding, setOnboarding] = useState<Row | null>(null);
  const [restoreFailure, setRestoreFailure] = useState<{ message: string; retry: boolean } | null>(null);
  const active = useRef<MobileApi | null>(null);
  const authSequence = useRef(0);
  const identitySequence = useRef(0);
  const resetView = () => { authSequence.current++; identitySequence.current++; setRestoreFailure(null); setAuthenticated(false); setUser(null); setOnboarding(null); setHouseholds([]); setPets([]); setSelected(''); setEpoch(n => n + 1); };
  const build = (config: Connection) => {
    let client: MobileApi;
    client = new MobileApi(config.urls[config.region] || 'https://unconfigured.invalid', secret, () => { if (active.current === client) { resetView(); setRestoreFailure({ message: '上次登录已失效，请重新登录。', retry: false }); } }); return client;
  };
  const [api, setApi] = useState(() => build(defaults)); if (!active.current) active.current = api;
  const applyIdentity = ({ profile, families, animals, guide }: Awaited<ReturnType<typeof readIdentity>>) => {
    setRestoreFailure(null); setUser(profile); setHouseholds(families.items); setPets(animals.items); setOnboarding(guide); setSelected(old => animals.items.some((p: Row) => p.id === old) ? old : animals.items.some((p: Row) => p.id === guide.pet_id) ? guide.pet_id : animals.items[0]?.id ?? ''); setAuthenticated(true);
  };
  const load = async (client: MobileApi) => {
    const attempt = ++identitySequence.current;
    const identity = await readIdentity(client);
    if (active.current !== client || attempt !== identitySequence.current) return;
    applyIdentity(identity);
  };
  const recover = async (client: MobileApi, alive: () => boolean = () => true) => {
    const attempt = ++authSequence.current, identityAttempt = ++identitySequence.current;
    const current = () => alive() && active.current === client && attempt === authSequence.current && identityAttempt === identitySequence.current;
    setRestoreFailure(null);
    try { const identity = await restoreIdentity(client, current); if (current() && identity) applyIdentity(identity); }
    catch { if (current()) setRestoreFailure({ message: '上次会话暂时无法恢复。请检查连接或本机安全存储后重试，也可以重新登录。', retry: true }); }
  };
  const validate = (region: Region, url: string) => {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'https:' && !(local(parsed.hostname) && parsed.protocol === 'http:' && (preview || Platform.OS === 'web'))) throw new Error('正式服务器必须使用 HTTPS；本地 HTTP 仅供内测开发网络');
    if (!preview && Platform.OS !== 'web' && url.trim().replace(/\/$/, '') !== defaults.urls[region].replace(/\/$/, '')) throw new Error('正式包只能连接构建时配置的区域服务器');
    return parsed.origin;
  };
  useEffect(() => { let alive = true; (async () => {
    try {
      let saved: string | null | undefined;
      try { saved = Platform.OS === 'web' ? globalThis.sessionStorage?.getItem('doogy.connection') : await SecureStore.getItemAsync('doogy.connection'); }
      catch { if (alive) setRestoreFailure({ message: '暂时无法读取本机连接设置，请检查本机安全存储后重试登录。', retry: false }); return; }
      if (!alive) return;
      let config = defaults;
      let client: MobileApi;
      try {
        if (saved) { const parsed = JSON.parse(saved); if (!['cn', 'global'].includes(parsed?.region) || !parsed?.urls || typeof parsed.urls.cn !== 'string' || typeof parsed.urls.global !== 'string') throw new Error('Invalid saved connection'); config = parsed; }
        if (config.urls[config.region]) validate(config.region, config.urls[config.region]);
        client = build(config);
      } catch {
        try {
          await secret.write(null);
          if (Platform.OS === 'web') globalThis.sessionStorage?.removeItem('doogy.connection'); else await SecureStore.deleteItemAsync('doogy.connection');
        } catch {}
        if (alive) setRestoreFailure({ message: '本机连接设置无效，请重新确认服务区域和服务器地址后登录。', retry: false });
        return;
      }
      if (!alive) return; active.current = client; setApi(client); setConnection(config);
      if (config.urls[config.region]) await recover(client, () => alive);
    }
    finally { if (alive) setBooting(false); }
  })(); return () => { alive = false; }; }, []);
  const configure = async (region: Region, raw: string) => {
    const url = validate(region, raw), next = { region, urls: { ...connection.urls, [region]: url } };
    if (api.origin === url && connection.region === region) return api;
    resetView(); await active.current?.clear(); const client = build(next); active.current = client; setApi(client); setConnection(next);
    const saved = JSON.stringify(next); if (Platform.OS === 'web') globalThis.sessionStorage?.setItem('doogy.connection', saved); else await SecureStore.setItemAsync('doogy.connection', saved);
    return client;
  };
  const authenticate = async (kind: 'login' | 'register', body: Row) => {
    setRestoreFailure(null);
    const client = active.current!, attempt = ++authSequence.current; const result = await client.post(`/auth/${kind}`, body); if (active.current !== client || attempt !== authSequence.current) return;
    await client.setSession(result); if (active.current !== client || attempt !== authSequence.current) return;
    try { await load(client); }
    catch (error) {
      if (active.current === client && attempt === authSequence.current) setRestoreFailure({ message: '登录已成功，但账户资料暂时无法读取。请重试恢复，无需重复创建账户或输入密码。', retry: true });
      throw error;
    }
  };
  const signOut = async () => { resetView(); try { await api.logout(); } catch { Alert.alert('已退出本机', '服务器会话撤销尚未确认；联网后可检查会话或重置密码。'); } };
  const pet = pets.find(p => p.id === selected) ?? null, household = households.find(h => h.id === pet?.household_id) ?? households[0] ?? null;
  return <Context.Provider value={{ api, user, pets, households, pet, household, onboarding, booting, authenticated, epoch, restoreError: restoreFailure?.message ?? null, canRetryRestore: restoreFailure?.retry ?? false, retryRestore: () => restoreFailure?.retry ? recover(active.current!) : Promise.resolve(), region: connection.region, serverUrl: connection.urls[connection.region], configurable: preview || Platform.OS === 'web', configure, authenticate, signOut, refreshIdentity: () => load(active.current!), selectPet: setSelected }}>{children}</Context.Provider>;
}
export function useApp() { const value = useContext(Context); if (!value) throw new Error('AppProvider missing'); return value; }
