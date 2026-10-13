import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { fetchDayState, fetchMessages, getSession, logout, sendCommand, sendMessage, type DriverCommand } from '../api/client';
import { ApiError, type DriverMessage, type SessionUser } from '../api/types';
import { POLL_INTERVAL_MS } from '../config';
import { buildRouteOrderCommand, groupStops, isDispatchOperable, seoulToday, stopProgress, vehicleDeliveries, vehiclePhase, type DayState, type Stop } from '../domain/dispatch';
import { registerPush, revokePush, subscribePush, subscribePushToken, type PushStatus } from '../platform/pushNotifications';
import { RequestGate } from '../platform/requestQueue';
import { readVehicleChoice, saveVehicleChoice } from '../storage';
import { BottomSheet } from '../ui/BottomSheet';
import { Button, Logo, T } from '../ui/common';
import { DeliveryRouteMap } from '../ui/DeliveryRouteMap';
import { DeliveryScreen } from '../ui/DeliveryScreen';
import { LoginScreen } from '../ui/LoginScreen';
import { PickupScreen } from '../ui/PickupScreen';
import { RouteOrderEditor } from '../ui/RouteOrderEditor';
import { StopDetails } from '../ui/StopDetails';
import { VehicleSelectScreen } from '../ui/VehicleSelectScreen';
import { colors, fontFamily, radius, TOUCH_MIN } from '../ui/theme';

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '로그인이 만료되었습니다. 다시 로그인해 주세요.';
    if (error.status === 409) return '배송 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.';
    if (error.status === 404) return '오늘 배차 정보를 찾을 수 없습니다.';
    if (error.status === 403) return '이 작업을 처리할 권한이 없습니다.';
    if (error.code === 'INVALID_RESPONSE') return '서버 응답을 확인할 수 없습니다. 다시 불러와 주세요.';
    return `서버에서 요청을 처리하지 못했습니다. (${error.status})`;
  }
  return '서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.';
}

export function AppRoot() {
  const [fontsLoaded, fontError] = useFonts({ Pretendard: require('../../assets/fonts/Pretendard.ttf') });
  return <GestureHandlerRootView style={styles.fill}><SafeAreaProvider>
    <StatusBar style="dark" />
    {fontsLoaded || fontError ? <SessionRoot /> : <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>}
  </SafeAreaProvider></GestureHandlerRootView>;
}

function SessionRoot() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(seoulToday);
  const signedOut = useCallback(() => setUser(null), []);
  const restore = useCallback(() => getSession()
    .then((restored) => setUser(restored))
    .catch((cause: unknown) => setError(errorText(cause)))
    .finally(() => setRestoring(false)), []);
  useEffect(() => { void restore(); }, [restore]);
  useEffect(() => {
    const tick = () => setDate(seoulToday());
    const timer = setInterval(tick, 30_000);
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') tick(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, []);
  if (restoring || error) return <SafeAreaView style={styles.center}>
    <Logo /><T style={styles.notice}>{error ?? '로그인을 확인하는 중입니다.'}</T>
    {error ? <Button label="다시 연결" onPress={() => { setRestoring(true); setError(null); void restore(); }} /> : <ActivityIndicator color={colors.brand} />}
  </SafeAreaView>;
  if (!user) return <LoginScreen onLogin={setUser} />;
  return <DriverWorkspace date={date} key={`${user.username}:${date}`} onSignedOut={signedOut} />;
}

function DriverWorkspace({ date, onSignedOut }: { date: string; onSignedOut(): void }) {
  const [state, setState] = useState<DayState | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [choiceReady, setChoiceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'delivery' | 'map'>('delivery');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<DayState | null>(null);
  const [messages, setMessages] = useState<DriverMessage[]>([]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ title: string; body: string } | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus>('registering');
  const stateRef = useRef<DayState | null>(null);
  const selectedVehicle = useRef<string | null>(null);
  const etag = useRef<string | null>(null);
  const mutating = useRef(false);
  const generation = useRef(0);
  const requests = useRef(new RequestGate());
  const messageGeneration = useRef(0);
  const active = useRef(true);
  const seenMessages = useRef(new Set<string>());
  const pushWork = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => { active.current = true; return () => { active.current = false; generation.current += 1; messageGeneration.current += 1; }; }, []);
  useEffect(() => {
    void readVehicleChoice(date).then((choice) => {
      if (active.current) { selectedVehicle.current = choice; setVehicleId(choice); setChoiceReady(true); }
    });
  }, [date]);

  const fail = useCallback((cause: unknown) => {
    if (!active.current) return;
    if (cause instanceof ApiError && cause.status === 401) onSignedOut();
    else setError(errorText(cause));
  }, [onSignedOut]);
  const applyState = useCallback((next: DayState) => { stateRef.current = next; setState(next); }, []);
  const refresh = useCallback(async (force = false) => {
    if (mutating.current) return;
    return requests.current.run(`state:${date}`, async () => {
      if (!active.current || mutating.current) return;
      const requestGeneration = ++generation.current;
      try {
        const result = await fetchDayState(date, force ? null : etag.current);
        if (!active.current || requestGeneration !== generation.current) return;
        if (!result.notModified) { etag.current = result.etag; applyState(result.state); }
        setError(null);
      } catch (cause) { if (requestGeneration === generation.current) fail(cause); }
      finally { if (active.current && requestGeneration === generation.current) setRefreshing(false); }
    }, force);
  }, [applyState, date, fail]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, POLL_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (value) => { if (value === 'active') void refresh(true); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [refresh]);

  const loadMessages = useCallback(async (force = false) => {
    if (!vehicleId || vehicleId !== selectedVehicle.current) return;
    return requests.current.run(`messages:${date}:${vehicleId}`, async () => {
      if (!active.current || vehicleId !== selectedVehicle.current) return;
      const requestGeneration = ++messageGeneration.current;
      try {
        const next = await fetchMessages(date, vehicleId);
        if (!active.current || vehicleId !== selectedVehicle.current || requestGeneration !== messageGeneration.current) return;
        const latest = next.filter((message) => message.from === 'ops' && !seenMessages.current.has(message.id)).at(-1);
        next.forEach((message) => seenMessages.current.add(message.id));
        if (latest) setBanner({ title: '운영팀 메시지', body: latest.body });
        setMessages(next); setMessageError(null);
      } catch (cause) {
        if (!active.current || vehicleId !== selectedVehicle.current || requestGeneration !== messageGeneration.current) return;
        if (cause instanceof ApiError && cause.status === 401) fail(cause);
        else setMessageError(errorText(cause));
      }
    }, force);
  }, [date, fail, vehicleId]);
  useEffect(() => {
    let live = true;
    messageGeneration.current += 1;
    seenMessages.current.clear();
    if (!vehicleId) return;
    void loadMessages();
    const timer = setInterval(() => { if (AppState.currentState === 'active') void loadMessages(); }, POLL_INTERVAL_MS);
    const reconnectPush = (options: { token?: string; requestPermission?: boolean } = {}) => {
      pushWork.current = pushWork.current.then(() => live
        ? registerPush(date, vehicleId, () => live && active.current, options)
        : 'unavailable').then((status) => {
        if (live) setPushStatus(status as PushStatus);
      });
    };
    reconnectPush();
    const unsubscribeToken = subscribePushToken((token) => reconnectPush({ token, requestPermission: false }));
    const foreground = AppState.addEventListener('change', (value) => {
      if (value === 'active') reconnectPush({ requestPermission: false });
    });
    const unsubscribe = subscribePush((push) => {
      if (!live || push.date !== date || push.vehicleId !== vehicleId) return;
      if (push.kind === 'ops_message') {
        seenMessages.current.add(push.messageId); setBanner({ title: push.title, body: push.body });
        if (push.tapped) setMessagesOpen(true);
        void loadMessages();
      } else void refresh(true);
    });
    return () => { live = false; messageGeneration.current += 1; clearInterval(timer); unsubscribe(); unsubscribeToken(); foreground.remove(); };
  }, [date, loadMessages, refresh, vehicleId]);

  async function chooseVehicle(next: string | null) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true);
    try {
      await pushWork.current; await revokePush(date, vehicleId); await saveVehicleChoice(date, next);
      setMessages([]); setMessageError(null); setPushStatus('registering');
      selectedVehicle.current = next;
      setVehicleId(next); setSelectedKey(null); setEditing(null); setBanner(null); setTab('delivery');
    } catch (cause) { fail(cause); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function signOut() {
    if (mutating.current) return;
    mutating.current = true; setBusy(true);
    try {
      await pushWork.current; await revokePush(date, vehicleId); await logout(); await saveVehicleChoice(date, null); onSignedOut();
    } catch (cause) { fail(cause); }
    finally { mutating.current = false; if (active.current) setBusy(false); }
  }
  async function command(value: DriverCommand, basis = stateRef.current) {
    if (!basis || mutating.current) return;
    mutating.current = true; generation.current += 1; setBusy(true); setRefreshing(false); setError(null);
    try {
      const result = await sendCommand(date, basis, value);
      if (active.current && result) applyState(result);
      etag.current = null; setEditing(null);
    } catch (cause) { fail(cause); setEditing(null); }
    finally {
      mutating.current = false;
      if (active.current) { setBusy(false); void refresh(true); }
    }
  }
  function act(action: 'arrive' | 'complete', stop: Stop) {
    if (vehicleId) void command({ type: action === 'arrive' ? 'arrive_stop' : 'complete_stop', vehicleId, orderId: stop.orders[0].id });
  }
  function reorder(keys: string[]) {
    if (!editing || !vehicleId) return;
    try { void command(buildRouteOrderCommand({ vehicleId, deliveries: vehicleDeliveries(editing, vehicleId), pendingStopKeys: keys, phase: vehiclePhase(editing, vehicleId) }), editing); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '배송 순서를 확인해 주세요.'); }
  }

  const chosenVehicle = state?.fleetVehicles.find((vehicle) => vehicle.id === vehicleId);
  if (!choiceReady) return <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>;
  if (!vehicleId || (state && !chosenVehicle)) return <VehicleSelectScreen date={date} error={error} onLogout={() => void signOut()} onRetry={() => void refresh(true)} onSelect={(id) => void chooseVehicle(id)} state={state} />;
  const deliveries = state ? vehicleDeliveries(state, vehicleId) : [];
  const stops = groupStops(deliveries);
  const phase = state ? vehiclePhase(state, vehicleId) : 'idle';
  const operable = !!state && isDispatchOperable(state);
  const pickup = phase === 'idle' || phase === 'preparing';
  const selectedStop = stops.find((stop) => stop.key === selectedKey) ?? null;
  const progress = stopProgress(stops);
  const pushLabel = { registering: '알림 연결 중', ready: '알림 연결됨', denied: '알림 권한이 꺼져 있습니다', unavailable: '푸시 알림 연결 안 됨 · 앱에서 메시지를 확인하세요' }[pushStatus];

  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><Logo /><View style={styles.headerButtons}>
      <Button disabled={busy} label="메시지" onPress={() => setMessagesOpen(true)} style={styles.headerButton} tone="secondary" />
      <Button disabled={busy} label="차량 변경" onPress={() => void chooseVehicle(null)} style={styles.headerButton} tone="secondary" />
    </View></View>
    <View style={styles.summary}><T style={styles.driver}>{chosenVehicle?.driver ?? vehicleId}</T><T style={styles.caption}>{date} · 완료 {progress.done}/{progress.total}곳</T></View>
    <T style={[styles.pushStatus, pushStatus !== 'ready' && styles.warning]}>{pushLabel}</T>
    {error ? <View style={styles.errorBox}><T accessibilityRole="alert" style={styles.error}>{error}</T><Button label="새로고침" onPress={() => void refresh(true)} tone="secondary" /></View> : null}
    {banner ? <Pressable accessibilityRole="button" onPress={() => { setMessagesOpen(true); setBanner(null); }} style={styles.banner}><T style={styles.bannerTitle}>{banner.title}</T><T numberOfLines={2} style={styles.bannerBody}>{banner.body}</T></Pressable> : null}
    {!state ? <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>
      : !operable ? <View style={styles.center}><T>오늘 배차가 확정되면 배송을 시작할 수 있습니다.</T><Button label="새로고침" onPress={() => void refresh(true)} /></View>
      : editing ? <RouteOrderEditor isSaving={busy} onCancel={() => setEditing(null)} onSave={reorder} stops={groupStops(vehicleDeliveries(editing, vehicleId)).filter((stop) => stop.status === 'pending')} />
      : tab === 'delivery' && pickup ? <PickupScreen allOrderIds={new Set(state.fleetDeliveries.map((order) => order.id))} date={date} deliveries={deliveries} key={`${date}:${vehicleId}`} onEditOrder={() => setEditing(state)} onStart={() => void command({ type: 'start_route', vehicleId })} starting={busy || !!error} vehicleId={vehicleId} />
      : tab === 'delivery' ? <DeliveryScreen busy={busy || !!error} onAction={act} onEditOrder={() => setEditing(state)} onRefresh={() => { setRefreshing(true); void refresh(true); }} refreshing={refreshing} stops={stops} />
      : <View style={styles.fill}><DeliveryRouteMap onMapPress={() => setSelectedKey(null)} onSelect={setSelectedKey} selectedKey={selectedKey} stops={stops} />
        <BottomSheet onDismiss={() => setSelectedKey(null)} open={!!selectedStop}>{selectedStop ? <ScrollView style={styles.stopSheet}><StopDetails busy={busy || !!error} onAction={act} stop={selectedStop} /><Button label="닫기" onPress={() => setSelectedKey(null)} tone="secondary" /></ScrollView> : null}</BottomSheet>
      </View>}
    {!editing ? <View style={styles.tabs}>{(['delivery', 'map'] as const).map((value) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === value }} key={value} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabSelected]}><T style={[styles.tabLabel, tab === value && styles.tabLabelSelected]}>{value === 'delivery' ? '배송' : '지도'}</T></Pressable>)}</View> : null}
    {messagesOpen ? <MessagesModal error={messageError} messages={messages} onClose={() => { setMessagesOpen(false); setBanner(null); }} onRefresh={() => loadMessages(true)} onSend={async (body) => { await sendMessage(date, vehicleId, body); await loadMessages(true); }} /> : null}
  </SafeAreaView>;
}

function MessagesModal({ messages, error, onClose, onRefresh, onSend }: {
  messages: DriverMessage[]; error: string | null; onClose(): void; onRefresh(): Promise<void>; onSend(body: string): Promise<void>;
}) {
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const locked = useRef(false);
  async function submit() {
    if (locked.current || !body.trim()) return;
    locked.current = true; setSending(true); setSendError(null);
    try { await onSend(body.trim()); setBody(''); } catch (cause) { setSendError(errorText(cause)); }
    finally { locked.current = false; setSending(false); }
  }
  return <Modal animationType="slide" onRequestClose={onClose} visible><SafeAreaView style={styles.screen}>
    <View style={styles.header}><T style={styles.driver}>운영팀 메시지</T><Button label="닫기" onPress={onClose} tone="secondary" /></View>
    {error || sendError ? <T accessibilityRole="alert" style={styles.errorBox}>{sendError ?? error}</T> : null}
    <ScrollView contentContainerStyle={styles.messageList}>
      {messages.length === 0 ? <T style={styles.caption}>아직 메시지가 없습니다.</T> : messages.map((message) => <View key={message.id} style={[styles.message, message.from === 'driver' && styles.ownMessage]}><T style={styles.messageMeta}>{message.from === 'ops' ? '운영팀' : '나'} · {new Date(message.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}</T><T style={styles.messageBody}>{message.body}</T></View>)}
    </ScrollView>
    <View style={styles.composer}><Button label="새로고침" onPress={() => void onRefresh()} tone="secondary" /><TextInput accessibilityLabel="운영팀에 보낼 메시지" editable={!sending} maxLength={1000} multiline onChangeText={setBody} placeholder="운영팀에 메시지 보내기" placeholderTextColor={colors.muted} style={styles.messageInput} value={body} /><Button busy={sending} disabled={!body.trim()} label="전송" onPress={() => void submit()} /></View>
  </SafeAreaView></Modal>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 }, screen: { backgroundColor: colors.background, flex: 1 },
  center: { alignItems: 'center', backgroundColor: colors.background, flex: 1, gap: 16, justifyContent: 'center', padding: 24 },
  notice: { textAlign: 'center' }, header: { alignItems: 'center', backgroundColor: colors.surface, flexDirection: 'row', justifyContent: 'space-between', padding: 12 },
  headerButtons: { flexDirection: 'row', gap: 6 }, headerButton: { minHeight: TOUCH_MIN, paddingHorizontal: 10 },
  summary: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  driver: { fontSize: 17, fontWeight: '800' }, caption: { color: colors.muted, fontSize: 13 },
  pushStatus: { color: colors.green, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 }, warning: { color: colors.amber },
  errorBox: { backgroundColor: colors.surface, gap: 8, padding: 12 }, error: { color: colors.error, fontSize: 14 },
  banner: { backgroundColor: colors.action, gap: 3, padding: 12 }, bannerTitle: { color: colors.surface, fontSize: 13, fontWeight: '800' }, bannerBody: { color: colors.surface, fontSize: 15 },
  tabs: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row' },
  tab: { alignItems: 'center', borderTopWidth: 3, borderTopColor: 'transparent', flex: 1, justifyContent: 'center', minHeight: 58 },
  tabSelected: { borderTopColor: colors.brand }, tabLabel: { color: colors.muted, fontSize: 17, fontWeight: '700' }, tabLabelSelected: { color: colors.brand },
  stopSheet: { maxHeight: 420 }, messageList: { gap: 10, padding: 12 }, message: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.card, gap: 4, maxWidth: '90%', padding: 12 },
  ownMessage: { alignSelf: 'flex-end', borderColor: colors.border, borderWidth: 1 }, messageMeta: { color: colors.muted, fontSize: 12 }, messageBody: { fontSize: 16 },
  composer: { backgroundColor: colors.surface, gap: 8, padding: 12 }, messageInput: { borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, color: colors.text, fontFamily, fontSize: 16, maxHeight: 120, minHeight: 60, padding: 12 },
});
