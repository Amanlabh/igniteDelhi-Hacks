import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { fetchRoute, fetchZones, type RouteResult, type Zone } from '@/lib/api';
import {
  buildSegments,
  formatKm,
  formatMinutes,
  haversineKm,
  projectPointOnRoute,
  totalKm,
  type LatLng,
  type SampledPoint,
  type Segment,
} from '@/lib/geo';

const CAMERA_PITCH = 60;
const CAMERA_ZOOM = 17;
const AQI_HOTSPOT = 300;
const AQI_CAUTION = 250;
const LINE_BLUE = '#3B82F6';
const LINE_YELLOW = '#F59E0B';
const LINE_RED = '#DC2626';

type NavParams = { from?: string; to?: string; masked?: string };

function countHotspots(path: string[], zoneById: Map<string, Zone>): number {
  const seen = new Set<string>();
  let count = 0;
  for (const id of path) {
    const zone = zoneById.get(id);
    if (zone && zone.aqi > AQI_HOTSPOT && !seen.has(id)) {
      seen.add(id);
      count++;
    }
  }
  return count;
}

function segmentColor(a: Zone, b: Zone): string {
  const worst = Math.max(a.aqi, b.aqi);
  if (worst > AQI_HOTSPOT) return LINE_RED;
  if (worst > AQI_CAUTION) return LINE_YELLOW;
  return LINE_BLUE;
}

type ColoredSegment = { from: LatLng; to: LatLng; color: string };

function coloredSegments(zones: Zone[]): ColoredSegment[] {
  const out: ColoredSegment[] = [];
  for (let i = 0; i + 1 < zones.length; i++) {
    out.push({
      from: { latitude: zones[i].lat, longitude: zones[i].lng },
      to: { latitude: zones[i + 1].lat, longitude: zones[i + 1].lng },
      color: segmentColor(zones[i], zones[i + 1]),
    });
  }
  return out;
}

export default function NavigationScreen() {
  const params = useLocalSearchParams<NavParams>();
  const insets = useSafeAreaInsets();

  const [zones, setZones] = useState<Zone[]>([]);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [altRoute, setAltRoute] = useState<RouteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [position, setPosition] = useState<LatLng | null>(null);
  const [heading, setHeading] = useState(0);
  const [leg, setLeg] = useState<SampledPoint | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [arrived, setArrived] = useState(false);

  const mapRef = useRef<MapView>(null);
  const segmentsRef = useRef<Segment[]>([]);

  const zoneById = useMemo(() => new Map(zones.map((z) => [z.id, z])), [zones]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const masked = (params.masked ?? '0') === '1';
        const [zoneData, routeData, altData] = await Promise.all([
          fetchZones(),
          fetchRoute(params.from ?? '', params.to ?? '', masked),
          fetchRoute(params.from ?? '', params.to ?? '', !masked).catch(() => null),
        ]);
        if (cancelled) return;
        setZones(zoneData);
        setRoute(routeData);
        setAltRoute(altData);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load route');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.from, params.to, params.masked]);

  const coords = useMemo<LatLng[]>(() => {
    if (!route) return [];
    return route.path
      .map((id) => zoneById.get(id))
      .filter((z): z is Zone => !!z)
      .map((z) => ({ latitude: z.lat, longitude: z.lng }));
  }, [route, zoneById]);

  const segments = useMemo(() => buildSegments(coords), [coords]);
  const total = useMemo(() => totalKm(segments), [segments]);

  const altCoords = useMemo<LatLng[]>(() => {
    if (!altRoute) return [];
    return altRoute.path
      .map((id) => zoneById.get(id))
      .filter((z): z is Zone => !!z)
      .map((z) => ({ latitude: z.lat, longitude: z.lng }));
  }, [altRoute, zoneById]);

  const chosenZones = useMemo<Zone[]>(
    () =>
      route
        ? route.path.map((id) => zoneById.get(id)).filter((z): z is Zone => !!z)
        : [],
    [route, zoneById],
  );

  const altZones = useMemo<Zone[]>(() => {
    if (!altRoute) return [];
    return altRoute.path.map((id) => zoneById.get(id)).filter((z): z is Zone => !!z);
  }, [altRoute, zoneById]);

  const chosenSegs = useMemo(() => coloredSegments(chosenZones), [chosenZones]);
  const altSegs = useMemo(() => coloredSegments(altZones), [altZones]);

  const showAlt =
    !!altRoute &&
    altCoords.length > 1 &&
    route !== null &&
    altRoute.path.join('|') !== route.path.join('|');

  const isFast = (params.masked ?? '0') === '1';

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    if (!route || segments.length === 0) return;

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (cancelled) return;
        if (status !== 'granted') {
          setGpsError('Location permission is required to navigate your ride.');
          return;
        }
        subscription = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 3 },
          (update) => {
            if (cancelled) return;
            const point: LatLng = {
              latitude: update.coords.latitude,
              longitude: update.coords.longitude,
            };
            if (typeof update.coords.heading === 'number' && update.coords.heading >= 0) {
              setHeading(update.coords.heading);
            }
            const segs = segmentsRef.current;
            const projected = projectPointOnRoute(segs, point);
            setPosition(point);
            if (projected) {
              setLeg(projected);
              const end = segs[segs.length - 1]?.to;
              const nearDest = end ? haversineKm(point, end) <= 0.05 : false;
              if (nearDest || projected.traveledFraction >= 1) setArrived(true);
            }
          },
          (err) => {
            if (!cancelled) setGpsError(err);
          },
        );
      } catch (e) {
        if (!cancelled) setGpsError(e instanceof Error ? e.message : 'GPS unavailable');
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [route, segments]);

  const progress = leg ? Math.max(0, Math.min(1, leg.traveledFraction)) : 0;

  useEffect(() => {
    const center = leg?.point ?? position ?? coords[0];
    if (!center) return;
    mapRef.current?.animateCamera(
      {
        center,
        pitch: CAMERA_PITCH,
        heading: position ? heading : 0,
        zoom: CAMERA_ZOOM,
      },
      { duration: 600 },
    );
  }, [position, leg, heading, coords]);

  const exit = useCallback(() => {
    router.back();
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>Route unavailable</Text>
        <Text style={styles.errorMessage}>{error}</Text>
        <TouchableOpacity onPress={exit} style={styles.doneButton}>
          <Text style={styles.doneText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (gpsError) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>GPS unavailable</Text>
        <Text style={styles.errorMessage}>{gpsError}</Text>
        <TouchableOpacity onPress={exit} style={styles.doneButton}>
          <Text style={styles.doneText}>Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!route || coords.length === 0) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#0066cc" />
        <Text style={{ marginTop: 12 }}>Calculating route…</Text>
      </View>
    );
  }

  const remainingMin = route.minutes * (1 - progress);
  const remainingKm = total * (1 - progress);
  const destName = zoneById.get(route.to_zone)?.name ?? route.to_zone;

  const nextZoneName =
    leg && leg.segmentIndex < route.path.length - 1
      ? zoneById.get(route.path[leg.segmentIndex + 1])?.name
      : destName;

  const altKm = altRoute ? totalKm(buildSegments(altCoords)) : 0;
  const chosenSpikes = countHotspots(route.path, zoneById);
  const altSpikes = altRoute ? countHotspots(altRoute.path, zoneById) : 0;
  const chosenLabel = isFast ? 'Fast · masked' : 'Safe · unmasked';
  const altLabel = isFast ? 'Safe · unmasked' : 'Fast · masked';
  const chosenColor = isFast ? '#F59E0B' : '#16A34A';
  const altColor = isFast ? '#16A34A' : '#F59E0B';

  const initialCam = coords[0];

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialCamera={{
          center: initialCam,
          pitch: CAMERA_PITCH,
          heading: 0,
          zoom: CAMERA_ZOOM,
          altitude: 500,
        }}
        showsUserLocation={false}
        showsCompass
        showsBuildings
        toolbarEnabled
      >
        {coords.length > 1 && (
          <>
            <Polyline
              coordinates={coords}
              strokeColor="#ffffff"
              strokeWidth={9}
              lineCap="round"
              lineJoin="round"
              zIndex={2}
            />
            {chosenSegs.map((seg, i) => (
              <Polyline
                key={`c${i}`}
                coordinates={[seg.from, seg.to]}
                strokeColor={seg.color}
                strokeWidth={7}
                lineCap="round"
                lineJoin="round"
                zIndex={3}
              />
            ))}
          </>
        )}
        {altSegs.length > 1 ? (
          <>
            {altSegs.map((seg, i) => (
              <Polyline
                key={`a${i}`}
                coordinates={[seg.from, seg.to]}
                strokeColor={seg.color}
                strokeWidth={5}
                lineCap="round"
                lineJoin="round"
                lineDashPattern={[6, 6]}
                zIndex={1}
              />
            ))}
          </>
        ) : null}
        <Marker
          coordinate={coords[0]}
          pinColor="#22C55E"
          title="Start"
          anchor={{ x: 0.5, y: 0.5 }}
        />
        {arrived ? (
          <Marker
            coordinate={coords[coords.length - 1]}
            pinColor="#EF4444"
            title={destName}
            anchor={{ x: 0.5, y: 0.5 }}
          />
        ) : null}
        <Marker
          coordinate={position ? (leg ? leg.point : position) : coords[0]}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
          zIndex={10}
        >
          <View style={styles.bikeView}>
            <Text style={[styles.bikeEmoji, { transform: [{ rotate: `${heading}deg` }] }]}>
              🏍️
            </Text>
          </View>
        </Marker>
      </MapView>

      <View style={[styles.header, { top: insets.top + 8 }]}>
        <View style={styles.tripCard}>
          {arrived ? (
            <>
              <Text style={styles.tripTime}>Arrived</Text>
              <Text style={styles.tripDist}>{destName}</Text>
            </>
          ) : (
            <>
              <Text style={styles.tripTime}>{formatMinutes(remainingMin)}</Text>
              <Text style={styles.tripDist}>{formatKm(remainingKm)}</Text>
              <Text style={styles.nextText}>Next · {nextZoneName}</Text>
            </>
          )}
        </View>
        <TouchableOpacity onPress={exit} style={styles.endButton}>
          <Text style={styles.endText}>✕ End</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.compareCard, { top: insets.top + 100 }]}>
        <View style={styles.compareLegend}>
          <Text style={styles.compareTitle}>Line colours · AQI</Text>
          <View style={styles.legendChip}>
            <View style={[styles.compareDot, { backgroundColor: LINE_BLUE }]} />
            <Text style={styles.legendText}>safe</Text>
          </View>
          <View style={styles.legendChip}>
            <View style={[styles.compareDot, { backgroundColor: LINE_YELLOW }]} />
            <Text style={styles.legendText}>caution</Text>
          </View>
          <View style={styles.legendChip}>
            <View style={[styles.compareDot, { backgroundColor: LINE_RED }]} />
            <Text style={styles.legendText}>hotspot</Text>
          </View>
        </View>
        {showAlt && altRoute ? (
          <>
            <View style={[styles.compareRow, styles.compareRowChosen]}>
              <View style={[styles.compareDot, { backgroundColor: chosenColor }]} />
              <Text style={styles.compareName}>You · {chosenLabel}</Text>
              <Text style={styles.compareMeta}>
                {formatMinutes(route.minutes)} · {formatKm(total)} · 💨{Math.round(route.exposure)}
              </Text>
              {chosenSpikes > 0 ? (
                <Text style={styles.compareWarn}>
                  ⚠️ {chosenSpikes} hotspot{chosenSpikes > 1 ? 's' : ''}
                </Text>
              ) : (
                <Text style={styles.compareOk}>✅ no hotspots</Text>
              )}
            </View>
            <View style={styles.compareRow}>
              <View style={[styles.compareDot, { backgroundColor: altColor }]} />
              <Text style={[styles.compareName, styles.compareNameAlt]}>Alt · {altLabel}</Text>
              <Text style={[styles.compareMeta, styles.compareMetaAlt]}>
                {formatMinutes(altRoute.minutes)} · {formatKm(altKm)} · 💨{Math.round(altRoute.exposure)}
              </Text>
              {altSpikes > 0 ? (
                <Text style={styles.compareWarn}>
                  ⚠️ {altSpikes} hotspot{altSpikes > 1 ? 's' : ''}
                </Text>
              ) : (
                <Text style={[styles.compareOk, styles.compareMetaAlt]}>✅ no hotspots</Text>
              )}
            </View>
          </>
        ) : null}
      </View>

      {!arrived && !position && !gpsError ? (
        <View style={[styles.gpsBanner, { bottom: insets.bottom + 84 }]}>
          <ActivityIndicator size="small" color="#60A5FA" />
          <Text style={styles.gpsText}>Waiting for GPS signal…</Text>
        </View>
      ) : null}

      {arrived && route ? (
        <View style={styles.arrivedWrap}>
          <View style={styles.arrivedCard}>
            <Text style={styles.arrivedEmoji}>🏁</Text>
            <Text style={styles.arrivedTitle}>You've arrived</Text>
            <Text style={styles.arrivedSub}>{destName}</Text>
            <View style={styles.arrivedStats}>
              <Text style={styles.arrivedStat}>⏱️ {formatMinutes(route.minutes)}</Text>
              <Text style={styles.arrivedStat}>🛣️ {formatKm(total)}</Text>
              <Text style={styles.arrivedStat}>💨 {Math.round(route.exposure)}</Text>
            </View>
            <TouchableOpacity onPress={exit} style={[styles.doneButton, styles.doneButtonFlex]}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={[styles.bottomCard, { bottom: insets.bottom + 8 }]}>
          <View style={styles.routeHeader}>
            <Text style={styles.routeTitle} numberOfLines={1}>
              {'To '}
              {destName}
            </Text>
            <Text style={styles.routePct}>{Math.round(progress * 100)}%</Text>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020' },
  map: { flex: 1, width: '100%' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  errorTitle: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  errorMessage: { color: '#555', textAlign: 'center', marginBottom: 16 },

  header: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  tripCard: {
    flex: 1,
    backgroundColor: '#141B2D',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  tripTime: { color: '#FFFFFF', fontSize: 32, fontWeight: '800' },
  tripDist: { color: '#E2E8F0', fontSize: 15, fontWeight: '600', marginTop: 2 },
  nextText: { color: '#94A3B8', fontSize: 13, marginTop: 6 },
  endButton: {
    backgroundColor: '#EF4444',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  endText: { color: '#fff', fontSize: 13, fontWeight: '800' },

  compareCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#141B2D',
    borderRadius: 14,
    padding: 12,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  compareLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  legendChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendText: { color: '#E2E8F0', fontSize: 11, fontWeight: '700' },
  compareTitle: { color: '#94A3B8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  compareRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  compareRowChosen: {
    backgroundColor: '#1B2537',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginHorizontal: -8,
  },
  compareDot: { width: 10, height: 10, borderRadius: 5 },
  compareName: { color: '#FFFFFF', fontSize: 13, fontWeight: '800', flexShrink: 1 },
  compareNameAlt: { color: '#A8B3C5' },
  compareMeta: { color: '#E2E8F0', fontSize: 12, fontWeight: '600' },
  compareMetaAlt: { color: '#94A3B8' },
  compareWarn: { color: '#F87171', fontSize: 11, fontWeight: '700' },
  compareOk: { color: '#4ADE80', fontSize: 11, fontWeight: '700' },

  gpsBanner: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#141B2D',
    borderRadius: 12,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 5,
  },
  gpsText: { color: '#E2E8F0', fontSize: 14, fontWeight: '600' },

  bottomCard: {
    position: 'absolute',
    left: 12,
    right: 12,
    backgroundColor: '#141B2D',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  routeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  routeTitle: { color: '#E2E8F0', fontSize: 13, fontWeight: '600', flex: 1, marginRight: 8 },
  routePct: { color: '#60A5FA', fontSize: 13, fontWeight: '800' },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: '#2D3A52', overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: '#3B82F6' },

  bikeView: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    borderColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 8,
  },
  bikeEmoji: { fontSize: 24 },

  arrivedWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 80,
    alignItems: 'center',
  },
  arrivedCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    padding: 22,
    width: '86%',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  arrivedEmoji: { fontSize: 34 },
  arrivedTitle: { fontSize: 20, fontWeight: '800', marginTop: 6 },
  arrivedSub: { color: '#555', fontSize: 14, marginTop: 2 },
  arrivedStats: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    marginBottom: 16,
  },
  arrivedStat: { fontSize: 12, fontWeight: '700', color: '#333' },
  doneButton: {
    backgroundColor: '#1976D2',
    borderRadius: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: 'center',
  },
  doneButtonFlex: { flex: 1 },
  doneText: { color: '#fff', fontWeight: 'bold', fontSize: 15 },
});