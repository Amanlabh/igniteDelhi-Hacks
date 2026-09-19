export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Segment {
  from: LatLng;
  to: LatLng;
  km: number;
  startKm: number;
  endKm: number;
}

export interface SampledPoint {
  point: LatLng;
  heading: number;
  segmentIndex: number;
  traveledKm: number;
  traveledFraction: number;
}

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return {
    latitude: a.latitude + (b.latitude - a.latitude) * t,
    longitude: a.longitude + (b.longitude - a.longitude) * t,
  };
}

export function buildSegments(coords: LatLng[]): Segment[] {
  const segments: Segment[] = [];
  let acc = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const from = coords[i];
    const to = coords[i + 1];
    const km = haversineKm(from, to);
    acc += km;
    segments.push({ from, to, km, startKm: acc - km, endKm: acc });
  }
  return segments;
}

export function totalKm(segments: Segment[]): number {
  return segments.length > 0 ? segments[segments.length - 1].endKm : 0;
}

export function sampleAt(segments: Segment[], progress: number): SampledPoint {
  const total = totalKm(segments);
  if (segments.length === 0 || total <= 0) {
    return {
      point: segments[0]?.from ?? { latitude: 0, longitude: 0 },
      heading: 0,
      segmentIndex: 0,
      traveledKm: 0,
      traveledFraction: progress,
    };
  }

  const p = Math.max(0, Math.min(1, progress));
  const target = p * total;

  let idx = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    if (target >= segments[i].startKm && target <= segments[i].endKm) {
      idx = i;
      break;
    }
  }

  const seg = segments[idx];
  const t = seg.km > 0 ? (target - seg.startKm) / seg.km : 1;

  return {
    point: interpolate(seg.from, seg.to, Math.max(0, Math.min(1, t))),
    heading: bearingDeg(seg.from, seg.to),
    segmentIndex: idx,
    traveledKm: target,
    traveledFraction: p,
  };
}

export function projectPointOnRoute(segments: Segment[], point: LatLng): SampledPoint | null {
  if (segments.length === 0) return null;

  let bestIdx = 0;
  let bestT = 0;
  let bestD = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const dLat = seg.to.latitude - seg.from.latitude;
    const dLng = seg.to.longitude - seg.from.longitude;
    const len2 = dLat * dLat + dLng * dLng;
    let t = 0;
    if (len2 > 0) {
      t =
        ((point.latitude - seg.from.latitude) * dLat +
          (point.longitude - seg.from.longitude) * dLng) /
        len2;
    }
    t = Math.max(0, Math.min(1, t));
    const d = haversineKm(point, {
      latitude: seg.from.latitude + dLat * t,
      longitude: seg.from.longitude + dLng * t,
    });
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
      bestT = t;
    }
  }

  const seg = segments[bestIdx];
  const traveledKm = seg.startKm + seg.km * bestT;
  const total = totalKm(segments);
  return {
    point: {
      latitude: seg.from.latitude + (seg.to.latitude - seg.from.latitude) * bestT,
      longitude: seg.from.longitude + (seg.to.longitude - seg.from.longitude) * bestT,
    },
    heading: bearingDeg(seg.from, seg.to),
    segmentIndex: bestIdx,
    traveledKm,
    traveledFraction: total > 0 ? traveledKm / total : 0,
  };
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

export function formatMinutes(min: number): string {
  const safe = Math.max(0, Math.round(min));
  if (safe >= 60) {
    const h = Math.floor(safe / 60);
    const m = safe % 60;
    return `${h} hr ${m} min`;
  }
  return `${safe} min`;
}