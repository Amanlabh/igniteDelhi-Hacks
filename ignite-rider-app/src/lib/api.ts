export const API_BASE = 'https://ignite-api-hcuj.onrender.com';

export interface Zone {
  id: string;
  name: string;
  lat: number;
  lng: number;
  aqi: number;
  aqi_updated?: string | null;
  safe: boolean;
}

export interface RouteResult {
  from_zone: string;
  to_zone: string;
  masked: boolean;
  path: string[];
  minutes: number;
  exposure: number;
}

export async function fetchZones(): Promise<Zone[]> {
  const res = await fetch(`${API_BASE}/zones`);
  if (!res.ok) throw new Error('Failed to load zones');
  const data = await res.json();
  return data.zones as Zone[];
}

export async function fetchRoute(fromZone: string, toZone: string, masked: boolean): Promise<RouteResult> {
  const res = await fetch(`${API_BASE}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_zone: fromZone, to_zone: toZone, masked }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.detail ?? 'No route found');
  return data as RouteResult;
}