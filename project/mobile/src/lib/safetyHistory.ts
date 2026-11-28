export type SafetyPeriod = 'all' | 'today' | 'week';
export type SafetyRange = { period: SafetyPeriod; timezone: string; from: string | null; to: string | null; from_date?: string; to_date?: string };

// Reuse the backend's natural-day boundaries, including DST. Do not infer them
// from a phone's clock or subtract a fixed 24 hours from local midnight.
export async function loadSafetyRange(api: { get(path: string): Promise<any> }, petId: string, period: SafetyPeriod, timezone: string): Promise<SafetyRange> {
  if (period === 'all') return { period, timezone, from: null, to: null };
  const path = period === 'today' ? 'daily' : 'weekly';
  const value = await api.get(`/pets/${encodeURIComponent(petId)}/activity/${path}?timezone=${encodeURIComponent(timezone)}`);
  const days = period === 'today' ? [value] : value.days;
  if (!Array.isArray(days) || days.length !== (period === 'today' ? 1 : 7) || value.pet_id !== petId || value.timezone !== timezone) throw new Error('未取得当前宠物的日期边界，请重试');
  const from = days[0].period_start, to = days[days.length - 1].period_end;
  if (typeof from !== 'string' || typeof to !== 'string' || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(from) >= Date.parse(to)) throw new Error('日期边界无效，未更改安全历史筛选');
  return { period, timezone, from, to, from_date: days[0].local_date, to_date: days[days.length - 1].local_date };
}
