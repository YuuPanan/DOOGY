import { useEffect, useRef } from 'react';
import { DependencyList } from 'react';
import { Text, View } from 'react-native';
import { useResource } from '../hooks/useResource';
import { Button, Caption, Loading, Notice, palette } from './ui';

export type Data = Record<string, any>;
export type FlowProps = { screenId: string; navigation: any; route?: { params?: Data }; params?: Data };
export const query = (values: Data) => '?' + Object.entries(values).filter(([, value]) => value !== '' && value != null).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
export const amount = (value: unknown, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100) / 100}${unit}` : 'Unknown';
export const dayAt = (timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key)?.value).join('-');
};
export const shiftDay = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
export function finite(value: string, name: string, optional = false) { if (!value.trim()) { if (optional) return null; throw new Error(`请填写${name}`); } const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${name}必须是有效数字`); return result; }
export function instant(value: string) { if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('请填写含时区的实际记录时间'); return new Date(value).toISOString(); }
export function useRead<T = any>(load: () => Promise<T>, deps: DependencyList, navigation: any) {
  const resource = useResource<T>(load, deps);
  useEffect(() => navigation?.addListener?.('focus', () => { void resource.refresh(); }), [navigation, resource.refresh]);
  return resource;
}
export function ReadState({ resource, title = 'Retry reading' }: { resource: { loading: boolean; error: any; refresh(): any }; title?: string }) { return <>{resource.loading && <Loading />}{!!resource.error && <><Notice tone="error" text={resource.error} /><Button secondary title={title} onPress={resource.refresh} /></>}</>; }
export function useAlive() { const alive = useRef(true); useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); return alive; }
export function Bars({ items, unit }: { items: Data[]; unit: string }) {
  const visible = items.slice(-7), known = visible.map(row => row.value).filter(value => typeof value === 'number' && Number.isFinite(value)), maximum = Math.max(1, ...known);
  return <View accessibilityLabel={`${unit} chart`} style={{ backgroundColor: palette.white, borderRadius: 20, padding: 16, gap: 12 }}><View style={{ height: 150, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', gap: 12, borderBottomWidth: 1, borderColor: palette.sage }}>
    {visible.map((row, index) => <View key={row.local_date ?? index} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>{typeof row.value === 'number' && Number.isFinite(row.value) ? <View accessibilityLabel={`${row.local_date}: ${row.value} ${unit}`} style={{ height: Math.max(row.value === 0 ? 0 : 3, row.value / maximum * 130), width: '80%', borderRadius: 5, backgroundColor: index === visible.length - 1 ? palette.citron : palette.forest }} /> : <Text style={{ color: palette.inkMuted }}>—</Text>}</View>)}
  </View><View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>{visible.map((row, index) => <Text key={row.local_date ?? index} style={{ fontSize: 10, color: palette.inkMuted }}>{String(row.local_date ?? '').slice(5)}</Text>)}</View><Caption>{unit} · 实际记录；缺失保持未知</Caption>{!visible.length && <Caption>No observations in this range.</Caption>}</View>;
}
