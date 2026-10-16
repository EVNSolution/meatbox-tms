import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { Stop } from './dispatch';
import { chooseApp, isNavApp, navigationLink, navigationStop, NAV_APPS, NAV_SCHEMES, targetOf, webFallbackLink, type NavTarget } from './navigation';

const APP = 'com.evnsolution.meatbox.driver';
const here: NavTarget = { name: '합성 정육점 A', address: '서울 강서구 공항대로 1', coordinates: [126.8495, 37.5509] };
const noPosition: NavTarget = { ...here, coordinates: null };

test('with a position every app gets a guidance link, with latitude and longitude in the order that app expects', () => {
  assert.deepEqual(navigationLink('google', here, APP), { url: 'google.navigation:q=37.5509,126.8495&mode=d', guided: true });
  assert.deepEqual(navigationLink('kakaomap', here, APP), { url: 'kakaomap://route?ep=37.5509,126.8495&by=CAR', guided: true });
  assert.deepEqual(navigationLink('tmap', here, APP), {
    url: `tmap://route?goalx=126.8495&goaly=37.5509&goalname=${encodeURIComponent('합성 정육점 A')}`, guided: true,
  });
  assert.deepEqual(navigationLink('naver', here, APP), {
    url: `nmap://navigation?dlat=37.5509&dlng=126.8495&dname=${encodeURIComponent('합성 정육점 A')}&appname=${APP}`, guided: true,
  });
});

test('names with spaces, ampersands and Korean letters are encoded so that they cannot break the link', () => {
  const tricky: NavTarget = { name: 'A&B 상회 #1', address: 'x', coordinates: [127, 37.5] };
  const url = navigationLink('tmap', tricky, APP).url;
  assert.equal(url, 'tmap://route?goalx=127&goaly=37.5&goalname=A%26B%20%EC%83%81%ED%9A%8C%20%231');
  assert.equal(new URL(url).searchParams.get('goalname'), 'A&B 상회 #1');
});

test('without a position the address is searched, and the link says it will not start guidance', () => {
  const q = encodeURIComponent('서울 강서구 공항대로 1');
  assert.deepEqual(navigationLink('google', noPosition, APP), { url: `google.navigation:q=${q}`, guided: false });
  assert.deepEqual(navigationLink('kakaomap', noPosition, APP), { url: `kakaomap://search?q=${q}`, guided: false });
  assert.deepEqual(navigationLink('tmap', noPosition, APP), { url: `tmap://search?name=${q}`, guided: false });
  assert.deepEqual(navigationLink('naver', noPosition, APP), { url: `nmap://search?query=${q}&appname=${APP}`, guided: false });
});

test('a position that is out of range or not a number counts as no position', () => {
  for (const coordinates of [[181, 37], [127, 91], [Number.NaN, 37], [127, Number.POSITIVE_INFINITY]] as const) {
    assert.equal(navigationLink('google', { ...here, coordinates }, APP).guided, false);
  }
  assert.equal(navigationLink('google', { name: '', address: '', coordinates: null }, APP).url, 'google.navigation:q=');
});

test('the web fallback needs no app: a position or the address in a Google Maps directions link', () => {
  assert.deepEqual(webFallbackLink(here), { url: 'https://www.google.com/maps/dir/?api=1&destination=37.5509,126.8495&travelmode=driving', guided: true });
  assert.deepEqual(webFallbackLink(noPosition), {
    url: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent('서울 강서구 공항대로 1')}&travelmode=driving`, guided: false,
  });
});

test('the remembered app is used while installed, one installed app is used directly, several are asked, none falls back', () => {
  assert.deepEqual(chooseApp([], null), { kind: 'none' });
  assert.deepEqual(chooseApp([], 'tmap'), { kind: 'none' });
  assert.deepEqual(chooseApp(['naver'], null), { kind: 'use', app: 'naver' });
  assert.deepEqual(chooseApp(['google', 'tmap'], null), { kind: 'ask', apps: ['tmap', 'google'] });
  assert.deepEqual(chooseApp(['google', 'tmap'], 'google'), { kind: 'use', app: 'google' });
  assert.deepEqual(chooseApp(['google', 'tmap'], 'kakaomap'), { kind: 'ask', apps: ['tmap', 'google'] });
  assert.deepEqual(chooseApp(['naver'], 'tmap'), { kind: 'use', app: 'naver' });
  assert.deepEqual(chooseApp(['google', 'tmap'], 'google', true), { kind: 'ask', apps: ['tmap', 'google'] });
  assert.deepEqual(chooseApp(['naver'], 'naver', true), { kind: 'use', app: 'naver' });
});

test('only the four known app IDs are accepted from storage, and each app has a scheme the manifest declares', () => {
  assert.equal(isNavApp('tmap'), true);
  assert.equal(isNavApp('kakaonavi'), false);
  assert.equal(isNavApp(null), false);
  assert.deepEqual(NAV_APPS.map((app) => app.id), ['tmap', 'kakaomap', 'naver', 'google']);
  const schemeOf = { tmap: 'tmap', kakaomap: 'kakaomap', naver: 'nmap', google: 'google.navigation' } as const;
  for (const app of NAV_APPS) {
    assert.equal(navigationLink(app.id, here, APP).url.startsWith(schemeOf[app.id]), true);
    assert.equal((NAV_SCHEMES as readonly string[]).includes(schemeOf[app.id]), true);
  }
  assert.deepEqual([...NAV_SCHEMES], ['tmap', 'kakaomap', 'nmap', 'google.navigation']);
});

const stop = (key: string, status: Stop['status'], over: Partial<Stop> = {}): Stop => ({
  key, sequence: 1, name: key, address: `${key} 주소`, detailAddress: '', orders: [], boxes: 0, status, arrived: false, coordinates: [127, 37.5], ...over,
});

test('guidance goes to the stop in progress, else the first waiting one, else nowhere', () => {
  assert.equal(navigationStop([stop('a', 'done'), stop('b', 'current'), stop('c', 'pending')])?.key, 'b');
  assert.equal(navigationStop([stop('a', 'done'), stop('c', 'pending'), stop('d', 'pending')])?.key, 'c');
  assert.equal(navigationStop([stop('a', 'done'), stop('b', 'skipped')]), null);
  assert.equal(navigationStop([]), null);
});

test('the target joins address and detail address, and keeps the position', () => {
  const target = targetOf(stop('x', 'current', { address: '서울 1', detailAddress: '2층', coordinates: null }));
  assert.deepEqual(target, { name: 'x', address: '서울 1 2층', coordinates: null });
});

test('the schemes the manifest plugin declares are exactly the ones the app probes', () => {
  const source = readFileSync(new URL('../../plugins/withNavigationQueries.js', import.meta.url), 'utf8');
  const declared = /const SCHEMES = \[(.*?)\];/su.exec(source)?.[1].split(',').map((entry) => entry.trim().replace(/'/gu, '')) ?? [];
  assert.deepEqual(declared, [...NAV_SCHEMES]);
  const config = JSON.parse(readFileSync(new URL('../../app.json', import.meta.url), 'utf8')) as { expo: { plugins: unknown[] } };
  assert.equal(config.expo.plugins.includes('./plugins/withNavigationQueries'), true);
});
