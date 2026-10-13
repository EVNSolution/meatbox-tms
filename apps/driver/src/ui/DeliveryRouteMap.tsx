import {
  Camera,
  GeoJSONSource,
  Images,
  Layer,
  LocationManager,
  Map as MapLibreMap,
  UserLocation,
  type CameraRef,
  type SymbolLayerSpecification,
} from '@maplibre/maplibre-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Stop } from '../domain/dispatch';
import { T } from './common';
import { colors, radius, TOUCH_MIN } from './theme';

const DESTINATION_PIN_IMAGE = require('../../assets/map/destination-pin.png') as number;
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MAP_PADDING = { bottom: 60, left: 40, right: 40, top: 60 } as const;
const FALLBACK_BOUNDS: [number, number, number, number] = [126.91, 37.48, 127.16, 37.66];

const MARKER_LAYOUT = {
  'icon-allow-overlap': true,
  'icon-anchor': 'bottom',
  'icon-ignore-placement': true,
  'icon-image': 'stop-pin',
  'icon-size': ['case', ['get', 'selected'], 0.86, 0.66],
  'symbol-sort-key': ['get', 'sortKey'],
  'text-allow-overlap': true,
  'text-field': ['get', 'label'],
  'text-font': ['Noto Sans Bold'],
  'text-ignore-placement': true,
  'text-offset': [0, -2],
  'text-size': 11,
} satisfies SymbolLayerSpecification['layout'];

const MARKER_PAINT = {
  'icon-color': [
    'match', ['get', 'tone'],
    'current', colors.brand,
    'done', colors.done,
    colors.action,
  ],
  'icon-halo-color': colors.surface,
  'icon-halo-width': 1,
  'text-color': colors.surface,
} satisfies SymbolLayerSpecification['paint'];

type LocationPermission = 'requesting' | 'granted' | 'denied';

export function DeliveryRouteMap({
  stops,
  selectedKey,
  onSelect,
  onMapPress,
}: {
  stops: Stop[];
  selectedKey: string | null;
  onSelect(stopKey: string): void;
  onMapPress(): void;
}) {
  const camera = useRef<CameraRef>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [permission, setPermission] = useState<LocationPermission>('requesting');
  const located = useMemo(() => stops.filter((stop) => stop.coordinates !== null), [stops]);
  const bounds = useMemo(() => readBounds(located.map((stop) => stop.coordinates as [number, number])), [located]);
  const markers = useMemo<GeoJSON.FeatureCollection<GeoJSON.Point>>(() => ({
    type: 'FeatureCollection',
    features: located.map((stop) => ({
      type: 'Feature',
      id: stop.key,
      geometry: { type: 'Point', coordinates: stop.coordinates as [number, number] },
      properties: {
        key: stop.key,
        label: String(stop.sequence),
        tone: stop.status === 'current' ? 'current' : stop.status === 'pending' ? 'pending' : 'done',
        selected: stop.key === selectedKey,
        // Current stop on top, then pending, then done.
        sortKey: stop.status === 'current' ? 10_000 : stop.status === 'pending' ? 5_000 - stop.sequence : -stop.sequence,
      },
    })),
  }), [located, selectedKey]);

  useEffect(() => {
    if (permission !== 'requesting') return undefined;
    let active = true;
    void LocationManager.requestPermissions()
      .then((granted) => {
        if (active) setPermission(granted ? 'granted' : 'denied');
      })
      .catch(() => {
        if (active) setPermission('denied');
      });
    return () => {
      active = false;
    };
  }, [permission]);

  return (
    <View style={styles.container}>
      <MapLibreMap
        androidView="texture"
        attribution
        compass={false}
        logo={false}
        mapStyle={MAP_STYLE_URL}
        onDidFailLoadingMap={() => setLoadState('error')}
        onDidFinishLoadingStyle={() => setLoadState('ready')}
        onPress={onMapPress}
        scaleBar={false}
        style={styles.map}
        touchPitch={false}
        touchRotate={false}
      >
        <Camera initialViewState={{ bounds, padding: MAP_PADDING }} maxZoom={17} minZoom={4} ref={camera} />
        <Images images={{ 'stop-pin': { sdf: true, source: DESTINATION_PIN_IMAGE } }} />
        <GeoJSONSource
          data={markers}
          id="stop-source"
          onPress={(event) => {
            event.stopPropagation();
            const key = event.nativeEvent.features[0]?.properties?.key;
            if (typeof key === 'string') onSelect(key);
          }}
        >
          <Layer id="stop-marker" layout={MARKER_LAYOUT} paint={MARKER_PAINT} source="stop-source" type="symbol" />
        </GeoJSONSource>
        {permission === 'granted' ? <UserLocation animated accuracy heading minDisplacement={5} /> : null}
      </MapLibreMap>

      {located.length < stops.length ? <View style={styles.noCoordinates}><T style={styles.toolText}>좌표 없음 {stops.length - located.length}곳 · 배송 탭에서 확인</T></View> : null}
      <View style={styles.tools}>
        <Pressable
          accessibilityRole="button"
          onPress={() => camera.current?.fitBounds(bounds, { padding: MAP_PADDING, duration: 400 })}
          style={styles.tool}
        >
          <T style={styles.toolText}>전체 보기</T>
        </Pressable>
        {permission === 'denied' ? (
          <Pressable accessibilityRole="button" onPress={() => setPermission('requesting')} style={styles.tool}>
            <T style={styles.toolText}>내 위치 허용</T>
          </Pressable>
        ) : null}
      </View>

      {loadState !== 'ready' ? (
        <View pointerEvents="none" style={styles.overlay}>
          <T style={styles.overlayText}>
            {loadState === 'error' ? '지도를 불러오지 못했습니다. 네트워크를 확인해 주세요.' : '지도를 불러오는 중입니다.'}
          </T>
        </View>
      ) : null}
    </View>
  );
}

function readBounds(coordinates: [number, number][]): [number, number, number, number] {
  if (coordinates.length === 0) return FALLBACK_BOUNDS;
  const lngs = coordinates.map(([lng]) => lng);
  const lats = coordinates.map(([, lat]) => lat);
  const pad = coordinates.length === 1 ? 0.01 : 0;
  return [Math.min(...lngs) - pad, Math.min(...lats) - pad, Math.max(...lngs) + pad, Math.max(...lats) + pad];
}

const styles = StyleSheet.create({
  noCoordinates: { backgroundColor: colors.surface, bottom: 32, left: 12, padding: 8, position: 'absolute' },
  container: { backgroundColor: colors.background, flex: 1, overflow: 'hidden' },
  map: { flex: 1 },
  tools: { gap: 8, position: 'absolute', right: 12, top: 12 },
  tool: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.control,
    borderWidth: 1,
    elevation: 2,
    justifyContent: 'center',
    minHeight: TOUCH_MIN,
    paddingHorizontal: 12,
  },
  toolText: { color: colors.action, fontSize: 13, fontWeight: '700' },
  overlay: {
    alignItems: 'center',
    backgroundColor: colors.background,
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    padding: 20,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  overlayText: { color: colors.muted, fontSize: 14, textAlign: 'center' },
});
