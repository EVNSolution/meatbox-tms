import type { Stop } from './dispatch';

// Hand-over to a navigation app (requirement 63, first step). The app opens the installed navigation app with the
// stop's position; there is no route API, and no road data to choose a stopping place, so the destination is the
// stop's own coordinate. Kakao Navi has no URL scheme (Kakao Mobility says so), so Kakao Map stands in for it.
//
// Evidence for each scheme (none could be tried on a device yet):
//   google   official: google.navigation:q=<lat>,<lng>&mode=d
//   kakaomap not documented; Kakao staff confirmed kakaomap://route?ep=<lat>,<lng>&by=CAR works on Android
//   tmap     not documented officially; blogs use tmap://route?goalx=<lng>&goaly=<lat>&goalname=
//   naver    documented: nmap://navigation?dlat&dlng&dname&appname (appname = the app's applicationId)
// Latitude comes first for Kakao Map and Google, longitude first for T map's goalx.

export type NavApp = 'tmap' | 'kakaomap' | 'naver' | 'google';

/** In the order they are offered. */
export const NAV_APPS: readonly { id: NavApp; label: string }[] = [
  { id: 'tmap', label: '티맵' },
  { id: 'kakaomap', label: '카카오맵' },
  { id: 'naver', label: '네이버지도' },
  { id: 'google', label: '구글맵' },
];

/** The URL schemes the manifest must declare so that `canOpenURL` can see the apps (plugins/withNavigationQueries.js). */
export const NAV_SCHEMES = ['tmap', 'kakaomap', 'nmap', 'google.navigation'] as const;

export type NavTarget = { name: string; address: string; coordinates: readonly [lng: number, lat: number] | null };

export type NavLink = {
  url: string;
  /** False when only an address search opens: the app shows the place but does not start guidance. */
  guided: boolean;
};

const enc = encodeURIComponent;

function position(target: NavTarget): { lat: number; lng: number } | null {
  const point = target.coordinates;
  if (!point || point.length !== 2) return null;
  const [lng, lat] = point;
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? { lat, lng } : null;
}

/** The deep link that starts guidance to [target] in [app], or searches its address when it has no position. */
export function navigationLink(app: NavApp, target: NavTarget, appName: string): NavLink {
  const point = position(target);
  const name = target.name.trim() || target.address.trim();
  const address = target.address.trim() || target.name.trim();
  if (point) {
    const { lat, lng } = point;
    switch (app) {
      case 'google': return { url: `google.navigation:q=${lat},${lng}&mode=d`, guided: true };
      case 'kakaomap': return { url: `kakaomap://route?ep=${lat},${lng}&by=CAR`, guided: true };
      case 'tmap': return { url: `tmap://route?goalx=${lng}&goaly=${lat}&goalname=${enc(name)}`, guided: true };
      case 'naver':
        return { url: `nmap://navigation?dlat=${lat}&dlng=${lng}&dname=${enc(name)}&appname=${enc(appName)}`, guided: true };
    }
  }
  switch (app) {
    case 'google': return { url: `google.navigation:q=${enc(address)}`, guided: false };
    case 'kakaomap': return { url: `kakaomap://search?q=${enc(address)}`, guided: false };
    case 'tmap': return { url: `tmap://search?name=${enc(address)}`, guided: false };
    case 'naver': return { url: `nmap://search?query=${enc(address)}&appname=${enc(appName)}`, guided: false };
  }
}

/** Works without any navigation app: Google Maps in the browser or its app. */
export function webFallbackLink(target: NavTarget): NavLink {
  const point = position(target);
  const destination = point ? `${point.lat},${point.lng}` : enc(target.address.trim() || target.name.trim());
  return { url: `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`, guided: point !== null };
}

export type NavChoice =
  | { kind: 'none' }
  | { kind: 'use'; app: NavApp }
  | { kind: 'ask'; apps: NavApp[] };

/**
 * Which app to open. The remembered app is used if it is still installed; one installed app is used directly;
 * several installed apps without a (valid) remembered one are asked about; none means the web fallback.
 */
export function chooseApp(installed: readonly NavApp[], remembered: NavApp | null, forceAsk = false): NavChoice {
  const available = NAV_APPS.map((app) => app.id).filter((id) => installed.includes(id));
  if (available.length === 0) return { kind: 'none' };
  if (!forceAsk && remembered && available.includes(remembered)) return { kind: 'use', app: remembered };
  if (available.length === 1) return { kind: 'use', app: available[0] };
  return { kind: 'ask', apps: available };
}

export function isNavApp(value: unknown): value is NavApp {
  return NAV_APPS.some((app) => app.id === value);
}

/** The stop to guide to: the one in progress, else the first waiting one, else none. */
export function navigationStop(stops: readonly Stop[]): Stop | null {
  return stops.find((stop) => stop.status === 'current') ?? stops.find((stop) => stop.status === 'pending') ?? null;
}

export function targetOf(stop: Stop): NavTarget {
  return {
    name: stop.name,
    address: [stop.address, stop.detailAddress].filter(Boolean).join(' ').trim() || stop.address,
    coordinates: stop.coordinates,
  };
}
