export type TrajectorySample = {
  id: string;
  device_ts: string;
  lat: number;
  lon: number;
  accuracy_m?: number | null;
  source: string;
  quality_flags?: readonly string[] | null;
  device_id?: string | null;
  binding_id?: string | null;
};
export type TrajectoryLayout = {
  points: (TrajectorySample & { x: number; y: number })[];
  segments: { from: number; to: number }[];
};

// Same historical-quality rule as web/history.mjs. Current freshness is separate.
function historicalPoint(point: TrajectorySample) {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && point.source === 'gnss'
    && point.accuracy_m != null && point.accuracy_m <= 100 && (point.quality_flags ?? []).length === 0;
}

// Local coordinate illustration, not a map projection or distance calculation.
// Normalize positions for the measured viewport while preserving local aspect.
export function trajectoryLayout(items: readonly TrajectorySample[], width = 320, height = 200): TrajectoryLayout {
  const ordered = [...items].sort((a, b) => a.device_ts.localeCompare(b.device_ts) || a.id.localeCompare(b.id));
  const valid = ordered.filter(historicalPoint);
  if (!valid.length) return { points: [], segments: [] };
  const minLat = Math.min(...valid.map(point => point.lat)), maxLat = Math.max(...valid.map(point => point.lat));
  const minLon = Math.min(...valid.map(point => point.lon)), maxLon = Math.max(...valid.map(point => point.lon));
  const horizontal = Math.max(0.01, Math.cos((minLat + maxLat) / 2 * Math.PI / 180));
  const viewportWidth = Math.max(1, width), viewportHeight = Math.max(1, height);
  const scale = Math.max((maxLon - minLon) * horizontal / Math.max(1, viewportWidth - 32), (maxLat - minLat) / Math.max(1, viewportHeight - 32), 1e-9);
  const points: TrajectoryLayout['points'] = [], segments: TrajectoryLayout['segments'] = [];
  let previous: number | null = null;
  for (const point of ordered) {
    if (!historicalPoint(point)) { previous = null; continue; }
    const current = points.length;
    points.push({ ...point,
      x: 0.5 + (point.lon - (minLon + maxLon) / 2) * horizontal / scale / viewportWidth,
      y: 0.5 - (point.lat - (minLat + maxLat) / 2) / scale / viewportHeight });
    if (previous !== null && point.device_id && point.binding_id
      && point.device_id === points[previous].device_id && point.binding_id === points[previous].binding_id)
      segments.push({ from: previous, to: current });
    previous = current;
  }
  return { points, segments };
}
