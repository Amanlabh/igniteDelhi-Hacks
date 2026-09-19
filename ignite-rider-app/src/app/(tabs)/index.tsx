import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';

import { fetchRoute, fetchZones, type RouteResult, type Zone } from '@/lib/api';
import { buildSegments, formatKm, formatMinutes, totalKm, type LatLng } from '@/lib/geo';

const API_BASE = 'https://ignite-api-hcuj.onrender.com';
const AQI_HOTSPOT = 300;

const INITIAL_REGION = {
  latitude: 28.6139,
  longitude: 77.209,
  latitudeDelta: 0.4,
  longitudeDelta: 0.4,
};

type RouteOption = {
  id: string;
  label: string;
  emoji: string;
  masked: boolean;
  route: RouteResult;
  km: number;
  spikes: Zone[];
};

function aqiColor(aqi: number) {
  if (aqi > 300) return '#D32F2F';
  if (aqi > 250) return '#F57C00';
  if (aqi > 200) return '#FBC02D';
  return '#7CB342';
}

function shortName(name: string) {
  const word = name.split(' ')[0];
  return word.length > 12 ? `${word.slice(0, 12)}…` : word;
}

function coordsOf(route: RouteResult, zoneById: Map<string, Zone>): LatLng[] {
  return route.path
    .map((id) => zoneById.get(id))
    .filter((z): z is Zone => !!z)
    .map((z) => ({ latitude: z.lat, longitude: z.lng }));
}

function spikesOf(path: string[], zoneById: Map<string, Zone>): Zone[] {
  const seen = new Set<string>();
  const spikes: Zone[] = [];
  for (const id of path) {
    const zone = zoneById.get(id);
    if (zone && zone.aqi > AQI_HOTSPOT && !seen.has(zone.id)) {
      seen.add(zone.id);
      spikes.push(zone);
    }
  }
  return spikes;
}

function routeKm(route: RouteResult, zoneById: Map<string, Zone>): number {
  return totalKm(buildSegments(coordsOf(route, zoneById)));
}

export default function HomeScreen() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(false);
  const [selectedFrom, setSelectedFrom] = useState<Zone | null>(null);
  const [selectedTo, setSelectedTo] = useState<Zone | null>(null);
  const [options, setOptions] = useState<RouteOption[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [masked, setMasked] = useState(false);

  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);
  const hotspots = useMemo(() => zones.filter((z) => z.aqi > AQI_HOTSPOT), [zones]);

  const loadOptions = useCallback(
    async (from: Zone, to: Zone): Promise<RouteOption[]> => {
      const [safeResult, fastResult] = await Promise.all([
        fetchRoute(from.id, to.id, false).catch(() => null),
        fetchRoute(from.id, to.id, true).catch(() => null),
      ]);

      const buildOption = (
        id: string,
        label: string,
        emoji: string,
        maskedFlag: boolean,
        route: RouteResult,
      ): RouteOption => ({
        id,
        label,
        emoji,
        masked: maskedFlag,
        route,
        km: routeKm(route, zoneById),
        spikes: spikesOf(route.path, zoneById),
      });

      const result: RouteOption[] = [];
      if (safeResult) result.push(buildOption('safe', 'Safe', '🌿', false, safeResult));
      if (fastResult) result.push(buildOption('fast', 'Fast', '⚡', true, fastResult));

      if (result.length === 2 && result[0].route.path.join('|') === result[1].route.path.join('|')) {
        result.pop();
      }

      setOptions(result);
      setSelectedOptionId((current) => {
        if (current && result.some((o) => o.id === current)) return current;
        const preferred = result.find((o) => o.id === 'safe') ?? result[0];
        return preferred?.id ?? null;
      });
      return result;
    },
    [zoneById],
  );

  const pickDefaults = useCallback(
    async (zoneList: Zone[]) => {
      const safe = zoneList.filter((z) => z.safe);
      if (safe.length === 0) {
        setSelectedFrom(zoneList[0] ?? null);
        setSelectedTo(zoneList[zoneList.length - 1] ?? null);
        return;
      }

      const candidates: Array<[Zone, Zone]> = [
        [safe[0], safe[safe.length - 1]],
        [safe[0], safe[1]],
        [safe[1], safe[safe.length - 1]],
        [safe[safe.length - 2], safe[safe.length - 1]],
      ];

      for (const [a, b] of candidates) {
        if (!a || !b) continue;
        // eslint-disable-next-line no-await-in-loop
        const result = await loadOptions(a, b);
        // eslint-disable-next-line no-await-in-loop
        if (result.length > 0) {
          setSelectedFrom(a);
          setSelectedTo(b);
          return;
        }
      }

      setSelectedFrom(safe[0] ?? zoneList[0]);
      setSelectedTo(safe[1] ?? safe[safe.length - 1] ?? zoneList[zoneList.length - 1]);
    },
    [loadOptions],
  );

  const loadZones = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchZones();
      setZones(data);
      await pickDefaults(data);
    } catch {
      Alert.alert('Error', 'Failed to load zones from the server');
    } finally {
      setLoading(false);
    }
  }, [pickDefaults]);

  useEffect(() => {
    loadZones();
  }, []);

  const selectFrom = useCallback((zone: Zone) => {
    setSelectedFrom(zone);
    setOptions([]);
    setSelectedOptionId(null);
  }, []);

  const selectTo = useCallback((zone: Zone) => {
    setSelectedTo(zone);
    setOptions([]);
    setSelectedOptionId(null);
  }, []);

  const handleFindRoute = useCallback(async () => {
    if (!selectedFrom || !selectedTo) return;
    setRouteLoading(true);
    try {
      const result = await loadOptions(selectedFrom, selectedTo);
      if (result.length === 0) {
        Alert.alert(
          'No Route',
          'No path exists between these zones, even for masked riders.',
        );
      }
    } catch {
      Alert.alert('Error', 'Failed to fetch route');
    } finally {
      setRouteLoading(false);
    }
  }, [loadOptions, selectedFrom, selectedTo]);

  const handleSpike = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/aqi/spike`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zone_id: 'z_sector_62', aqi: 500 }),
      });
      const data = await fetchZones();
      setZones(data);
      if (selectedFrom && selectedTo) {
        await loadOptions(selectedFrom, selectedTo);
      } else {
        await pickDefaults(data);
      }
      Alert.alert('Spiked!', 'Sector 62 AQI → 500. Routes updated!');
    } catch {
      Alert.alert('Error', 'Failed to spike');
    }
  }, [loadOptions, pickDefaults, selectedFrom, selectedTo]);

  const selectedOption = useMemo(
    () => options.find((o) => o.id === selectedOptionId) ?? null,
    [options, selectedOptionId],
  );

  const startNavigation = useCallback(() => {
    if (!selectedOption || !selectedFrom || !selectedTo) return;
    router.push({
      pathname: '/navigation',
      params: {
        from: selectedFrom.id,
        to: selectedTo.id,
        masked: selectedOption.masked ? '1' : '0',
      },
    });
  }, [selectedFrom, selectedOption, selectedTo]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0066cc" />
        <Text>Loading zones…</Text>
      </View>
    );
  }

  const hotspotLabel = (list: Zone[]) =>
    list.length === 0 ? 'No hotspots on route' : `Passes ${list.length} hotspot${list.length > 1 ? 's' : ''}: ${list.map((z) => shortName(z.name)).join(', ')}`;

  return (
    <View style={styles.container}>
      <MapView style={styles.map} initialRegion={INITIAL_REGION}>
        {hotspots.map((zone) => (
          <Marker
            key={zone.id}
            coordinate={{ latitude: zone.lat, longitude: zone.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            title={`${zone.name} (HOTSPOT)`}
            description={`AQI: ${zone.aqi}`}
          >
            <View style={styles.hotspotPin}>
              <Text style={styles.hotspotPinText}>💨</Text>
            </View>
          </Marker>
        ))}
        {zones
          .filter((z) => z.aqi <= AQI_HOTSPOT)
          .map((zone) => (
            <Marker
              key={zone.id}
              coordinate={{ latitude: zone.lat, longitude: zone.lng }}
              pinColor={aqiColor(zone.aqi)}
              title={zone.name}
              description={`AQI: ${zone.aqi}`}
            />
          ))}

        {options.map((option) => {
          const coords = coordsOf(option.route, zoneById);
          if (coords.length < 2) return null;
          const isSelected = option.id === selectedOptionId;
          const color = option.id === 'safe' ? '#16A34A' : '#F59E0B';
          return (
            <React.Fragment key={option.id}>
              <Polyline
                coordinates={coords}
                strokeColor="#ffffff"
                strokeWidth={isSelected ? 8 : 5}
                lineCap="round"
                lineJoin="round"
                zIndex={isSelected ? 2 : 1}
                lineDashPattern={isSelected ? undefined : [2, 4]}
              />
              <Polyline
                coordinates={coords}
                strokeColor={color}
                strokeWidth={isSelected ? 6 : 3}
                lineCap="round"
                lineJoin="round"
                zIndex={isSelected ? 3 : 1}
                lineDashPattern={isSelected ? undefined : [2, 4]}
              />
            </React.Fragment>
          );
        })}
      </MapView>

      <ScrollView style={styles.controls}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>🗺️ Ignite Routing</Text>
          {hotspots.length > 0 && (
            <View style={styles.legend}>
              <Text style={styles.legendText}>
                <Text style={styles.legendGreen}>● safe</Text> ·{' '}
                <Text style={styles.legendAmber}>● fast</Text>
              </Text>
            </View>
          )}
        </View>

        {hotspots.length > 0 && (
          <View style={styles.hotspotBanner}>
            <Text style={styles.hotspotBannerText}>
              ⚠️ {hotspots.length} hotspot{hotspots.length > 1 ? 's' : ''} active right now:{' '}
              {hotspots.map((z) => `${shortName(z.name)} (${z.aqi})`).join(', ')}
            </Text>
          </View>
        )}

        <Text style={styles.label}>From Zone</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {zones.map((z) => (
            <TouchableOpacity
              key={z.id}
              onPress={() => selectFrom(z)}
              style={[styles.chip, selectedFrom?.id === z.id && styles.chipActive]}
            >
              <View style={[styles.chipDot, { backgroundColor: aqiColor(z.aqi) }]} />
              <Text style={styles.chipText}>{shortName(z.name)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <Text style={styles.label}>To Zone</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {zones.map((z) => (
            <TouchableOpacity
              key={z.id}
              onPress={() => selectTo(z)}
              style={[styles.chip, selectedTo?.id === z.id && styles.chipActive]}
            >
              <View style={[styles.chipDot, { backgroundColor: aqiColor(z.aqi) }]} />
              <Text style={styles.chipText}>{shortName(z.name)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={styles.toggleRow}>
          <TouchableOpacity
            onPress={() => setMasked(!masked)}
            style={[styles.toggle, masked && styles.toggleActive]}
          >
            <Text style={[styles.toggleText, masked && styles.toggleTextActive]}>
              {masked ? '😷 Masked rider' : '😷 Unmasked rider'}
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity onPress={handleFindRoute} style={styles.button} disabled={routeLoading}>
          {routeLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Find Route</Text>
          )}
        </TouchableOpacity>

        {options.length > 0 && (
          <View style={styles.optionsCard}>
            <Text style={styles.cardTitle}>Choose your route</Text>
            {options.map((option) => {
              const isSelected = option.id === selectedOptionId;
              const safe = option.id === 'safe';
              return (
                <TouchableOpacity
                  key={option.id}
                  onPress={() => setSelectedOptionId(option.id)}
                  style={[
                    styles.optionCard,
                    isSelected && (safe ? styles.optionCardSelectedSafe : styles.optionCardSelectedFast),
                  ]}
                >
                  <View style={styles.optionHeader}>
                    <View style={styles.radio}>
                      {isSelected && <View style={styles.radioCheck} />}
                    </View>
                    <Text style={styles.optionEmoji}>{option.emoji}</Text>
                    <Text style={styles.optionLabel}>{option.label}</Text>
                    <Text style={styles.optionTag}>{option.masked ? 'Masked' : 'Unmasked'}</Text>
                  </View>
                  <Text style={styles.optionMeta}>
                    🛣️ {formatKm(option.km)} · ⏱️ {formatMinutes(option.route.minutes)} · 💨{' '}
                    {Math.round(option.route.exposure)}
                  </Text>
                  <Text
                    style={
                      option.spikes.length > 0 ? styles.optionWarn : styles.optionOk
                    }
                  >
                    {option.spikes.length > 0 ? '⚠️ ' : '✅ '}
                    {hotspotLabel(option.spikes)}
                  </Text>
                </TouchableOpacity>
              );
            })}

            {selectedOption && (
              <TouchableOpacity onPress={startNavigation} style={styles.navButton}>
                <Text style={styles.navButtonText}>
                  ▶ Start navigation ({selectedOption.label.toLowerCase()})
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <TouchableOpacity onPress={handleSpike} style={[styles.button, styles.spikeButton]}>
          <Text style={styles.buttonText}>⚡ Spike Sector 62 (demo)</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 0.55, width: '100%' },
  controls: { flex: 0.45, backgroundColor: '#f5f5f5', padding: 12 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 18, fontWeight: 'bold' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  legend: { backgroundColor: '#fff', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  legendText: { fontSize: 11, color: '#444' },
  legendGreen: { color: '#16A34A', fontWeight: 'bold' },
  legendAmber: { color: '#F59E0B', fontWeight: 'bold' },

  hotspotBanner: {
    backgroundColor: '#FEE2E2',
    borderLeftWidth: 4,
    borderLeftColor: '#DC2626',
    borderRadius: 6,
    padding: 8,
    marginVertical: 8,
  },
  hotspotBannerText: { color: '#7F1D1D', fontSize: 12, fontWeight: '600' },

  label: { fontSize: 12, fontWeight: 'bold', marginTop: 10 },
  chip: {
    backgroundColor: '#ddd',
    padding: 6,
    marginRight: 6,
    borderRadius: 14,
    marginVertical: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  chipActive: { backgroundColor: '#1976D2' },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { color: '#000', fontSize: 10, fontWeight: '600' },
  toggleRow: { flexDirection: 'row', marginVertical: 10 },
  toggle: { flex: 1, padding: 8, backgroundColor: '#ddd', borderRadius: 6 },
  toggleActive: { backgroundColor: '#1976D2' },
  toggleText: { color: '#000', textAlign: 'center', fontWeight: 'bold', fontSize: 12 },
  toggleTextActive: { color: '#fff' },
  button: { backgroundColor: '#1976D2', padding: 10, borderRadius: 6, marginVertical: 6 },
  buttonText: { color: '#fff', textAlign: 'center', fontWeight: 'bold', fontSize: 14 },
  spikeButton: { backgroundColor: '#D32F2F' },

  optionsCard: { backgroundColor: '#fff', padding: 12, borderRadius: 8, marginVertical: 6 },
  cardTitle: { fontWeight: 'bold', marginBottom: 8 },
  optionCard: {
    borderWidth: 2,
    borderColor: '#E5E7EB',
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
    backgroundColor: '#FAFAFA',
  },
  optionCardSelectedSafe: { backgroundColor: '#F0FDF4', borderColor: '#16A34A' },
  optionCardSelectedFast: { backgroundColor: '#FFFBEB', borderColor: '#F59E0B' },
  optionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#9CA3AF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCheck: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#1976D2' },
  optionEmoji: { fontSize: 16 },
  optionLabel: { fontSize: 15, fontWeight: '800', flex: 1, textTransform: 'capitalize' },
  optionTag: { fontSize: 11, color: '#6B7280', fontWeight: '600' },
  optionMeta: { color: '#4B5563', fontSize: 12.5, marginTop: 6 },
  optionWarn: { color: '#B91C1C', fontSize: 12, fontWeight: '600', marginTop: 4 },
  optionOk: { color: '#15803D', fontSize: 12, fontWeight: '600', marginTop: 4 },
  navButton: {
    backgroundColor: '#16A34A',
    borderRadius: 6,
    padding: 12,
    marginTop: 4,
    alignItems: 'center',
  },
  navButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },

  hotspotPin: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#DC2626',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hotspotPinText: { fontSize: 13 },
});