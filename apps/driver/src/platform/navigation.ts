import { Linking } from 'react-native';

import { chooseApp, isNavApp, NAV_APPS, navigationLink, webFallbackLink, type NavApp, type NavChoice, type NavLink, type NavTarget } from '../domain/navigation';
import { readNavApp, saveNavApp } from '../storage';

const APPLICATION_ID = 'com.evnsolution.meatbox.driver';

async function installedApps(target: NavTarget): Promise<NavApp[]> {
  const probes = await Promise.all(NAV_APPS.map(async (app) => {
    // The link itself is the probe: canOpenURL needs the scheme in the manifest `queries` (plugins/withNavigationQueries.js).
    const seen = await Linking.canOpenURL(navigationLink(app.id, target, APPLICATION_ID).url).catch(() => false);
    return seen ? app.id : null;
  }));
  return probes.filter((id): id is NavApp => id !== null);
}

export type NavPlan = { choice: NavChoice; installed: NavApp[] };

/** Looks at which navigation apps are installed and which one the driver chose to use every time. */
export async function planNavigation(target: NavTarget, forceAsk = false): Promise<NavPlan> {
  const [installed, stored] = await Promise.all([installedApps(target), readNavApp()]);
  const remembered = isNavApp(stored) ? stored : null;
  return { choice: chooseApp(installed, remembered, forceAsk), installed };
}

/** Opens [app] on the target. Rejects when the system refuses, so the caller can fall back. */
export async function openNavigation(app: NavApp, target: NavTarget, remember: boolean): Promise<NavLink> {
  const link = navigationLink(app, target, APPLICATION_ID);
  await Linking.openURL(link.url);
  if (remember) await saveNavApp(app);
  return link;
}

/** No navigation app: the directions page of Google Maps in the browser (or its app). */
export async function openWebNavigation(target: NavTarget): Promise<NavLink> {
  const link = webFallbackLink(target);
  await Linking.openURL(link.url);
  return link;
}

export async function forgetNavApp(): Promise<void> {
  await saveNavApp(null);
}
