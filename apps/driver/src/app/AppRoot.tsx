import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { fetchMessages, getSession, logout, sendMessage } from '../api/client';
import { newEventStamp, sendDeparted, sendRouteReordered, suggestRoute } from '../api/driverApi';
import type { DriverRoute } from '../api/driverContracts';
import { ApiError, type DriverMessage, type SessionUser } from '../api/types';
import { useDriverRoute } from './useDriverRoute';
import { useOutbox } from './useOutbox';
import { OPS_PHONE, POLL_INTERVAL_MS } from '../config';
import { seoulToday, stopProgress, type Stop } from '../domain/dispatch';
import { editBlock } from '../domain/routeEditing';
import { routeStops } from '../domain/routeStops';
import { serverStopOrder, suggestedKeys, suggestionSummary } from '../domain/routeDraft';
import { RetryAttempt } from '../domain/retryAttempt';
import { departureLocation } from '../platform/location';
import { ensureTracking, flushTracking, showTrackingGuides, stopTracking } from '../platform/tracking';
import { registerPush, revokePush, subscribePush, subscribePushToken, type PushStatus } from '../platform/pushNotifications';
import { applyOutbox } from '../domain/outboxView';
import { telUrl } from '../domain/phone';
import { pushEffect } from '../domain/pushEffect';
import { dimmedStopKeys, etaLabel, serverStop } from '../domain/routeView';
import { RequestGate } from '../platform/requestQueue';
import { readVehicleChoice, saveVehicleChoice } from '../storage';
import { BottomSheet } from '../ui/BottomSheet';
import { CompletionScreen } from '../ui/CompletionScreen';
import { OutboxSheet } from '../ui/OutboxSheet';
import { Button, Logo, T } from '../ui/common';
import { DeliveryRouteMap } from '../ui/DeliveryRouteMap';
import { DeliveryScreen } from '../ui/DeliveryScreen';
import { LoginScreen } from '../ui/LoginScreen';
import { PickupScreen } from '../ui/PickupScreen';
import { RouteOrderEditor } from '../ui/RouteOrderEditor';
import { StopDetails } from '../ui/StopDetails';
import { HistoryScreen } from '../ui/HistoryScreen';
import { StopInfo } from '../ui/StopInfo';
import { VehicleSelectScreen } from '../ui/VehicleSelectScreen';
import { colors, fontFamily, radius, TOUCH_MIN } from '../ui/theme';

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'REVISION_CONFLICT') return '다른 곳에서 배송 순서가 바뀌어 최신 순서를 다시 불러왔습니다. 다시 편집해 주세요.';
    if (error.code === 'ROUTE_LOCKED') return '이미 시작했거나 끝난 배송지의 순서는 바꿀 수 없습니다.';
    if (error.code === 'SOURCE_CHANGED') return '배차 원본이 바뀌어 확인 중입니다. 관제에서 확인한 뒤 다시 불러와 주세요.';
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
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [choiceReady, setChoiceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'delivery' | 'map'>('delivery');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<DriverRoute | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [outboxOpen, setOutboxOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [messages, setMessages] = useState<DriverMessage[]>([]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ title: string; body: string } | null>(null);
  const [pushStatus, setPushStatus] = useState<PushStatus>('registering');
  const selectedVehicle = useRef<string | null>(null);
  const mutating = useRef(false);
  const requests = useRef(new RequestGate());
  const messageGeneration = useRef(0);
  const active = useRef(true);
  const seenMessages = useRef(new Set<string>());
  const pushWork = useRef<Promise<unknown>>(Promise.resolve());
  const attempts = useRef(new RetryAttempt<ReturnType<typeof newEventStamp> & { problem: 'denied' | 'unavailable' | null }>());

  useEffect(() => { active.current = true; return () => { active.current = false; messageGeneration.current += 1; }; }, []);
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

  // The whole day of the chosen vehicle comes from one place: the server's driver route.
  const { route, failure, reload: reloadRoute } = useDriverRoute(date, vehicleId, onSignedOut);
  const pollError = failure && !(failure instanceof ApiError && failure.status === 401) ? errorText(failure) : null;
  // Location collection follows the vehicle's run: on while it is delivering, off once the route is done.
  const runPhase = route?.phase ?? null;
  useEffect(() => {
    if (!vehicleId || !runPhase) return;
    if (runPhase === 'delivering') void ensureTracking(date, vehicleId).catch(() => undefined);
    else if (runPhase === 'done') void stopTracking();
  }, [date, runPhase, vehicleId]);
  useEffect(() => {
    const foreground = AppState.addEventListener('change', (value) => { if (value === 'active') void flushTracking(); });
    return () => foreground.remove();
  }, []);
  const outbox = useOutbox({
    // Rereads the day after the server confirmed a report; true when the screen shows the server's state again.
    onConfirmed: async () => (await reloadRoute()) !== null,
    onConflict: () => { void reloadRoute(); },
    onSessionLost: onSignedOut,
  });

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
      const effect = live ? pushEffect(push, { date, vehicleId }) : null;
      if (!effect) return;
      if (effect.seenMessageId) seenMessages.current.add(effect.seenMessageId);
      if (effect.banner) setBanner(effect.banner);
      if (effect.openMessages) setMessagesOpen(true);
      if (effect.reloadMessages) void loadMessages();
      if (effect.refreshDay) void reloadRoute();
    });
    return () => { live = false; messageGeneration.current += 1; clearInterval(timer); unsubscribe(); unsubscribeToken(); foreground.remove(); };
  }, [date, loadMessages, reloadRoute, vehicleId]);

  async function chooseVehicle(next: string | null) {
    if (mutating.current) return;
    mutating.current = true; setBusy(true);
    try {
      await pushWork.current; await stopTracking(); await revokePush(date, vehicleId); await saveVehicleChoice(date, next);
      setMessages([]); setMessageError(null); setPushStatus('registering');
      selectedVehicle.current = next;
      setVehicleId(next); setSelectedKey(null); setEditing(null); setBanner(null); setTab('delivery'); setError(null);
    } catch (cause) { fail(cause); }
    finally { mutating.current = false; setBusy(false); }
  }
  async function signOut() {
    if (mutating.current) return;
    mutating.current = true; setBusy(true);
    try {
      await pushWork.current; await stopTracking(); await revokePush(date, vehicleId); await logout(); await saveVehicleChoice(date, null); onSignedOut();
    } catch (cause) { fail(cause); }
    finally { mutating.current = false; if (active.current) setBusy(false); }
  }
  // The chosen vehicle is not in today's plan (the plan was rebuilt): the vehicle choice is shown again.
  const vehicleGone = failure instanceof ApiError && failure.status === 404 && failure.code === 'DRIVER_VEHICLE_NOT_FOUND';

  function act(_action: 'arrive' | 'complete', stop: Stop) { setReporting(stop.key); }
  // Order edits, the departure and the stop reports are driver events; the reports go through the device queue.
  // Closed stops (current, done, skipped) keep their place, so the editor only moves the waiting ones.
  async function openEditor() {
    if (!vehicleId || mutating.current) return;
    setError(null);
    const fresh = await reloadRoute();
    if (!fresh) { setError('최신 경로를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); return; }
    const blocked = editBlock(fresh.phase, outbox.waiting);
    if (blocked) { setError(blocked); return; }
    setEditing(fresh);
  }
  async function suggestOrder(): Promise<{ keys: string[]; summary: string }> {
    if (!vehicleId || !editing) throw new Error('순서 편집을 다시 열어 주세요.');
    const suggestion = await suggestRoute(date, vehicleId).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) fail(cause);
      throw new Error(errorText(cause));
    });
    if (suggestion.revision !== editing.revision) {
      void reloadRoute();
      throw new Error(errorText(new ApiError(409, 'REVISION_CONFLICT')));
    }
    const editable = routeStops(editing).filter((stop) => stop.status === 'pending');
    const keys = suggestedKeys(editable, suggestion, editing);
    if (!keys) throw new Error('서버가 제안한 순서를 이 화면과 맞출 수 없습니다. 새로고침해 주세요.');
    return { keys, summary: suggestionSummary(suggestion) };
  }
  async function saveOrder(keys: string[]) {
    const basis = editing;
    if (!basis || !vehicleId || mutating.current) return;
    mutating.current = true; setBusy(true); setError(null);
    try {
      const order = serverStopOrder(keys, routeStops(basis), basis);
      const stamp = await attempts.current.get(
        `reorder:${basis.revision}:${order.join(',')}`,
        () => ({ ...newEventStamp(), problem: null }),
      );
      await sendRouteReordered({ ...stamp, date, vehicleId }, order, basis.revision);
      attempts.current.settle();
      if (active.current) setEditing(null);
    } catch (cause) {
      // A network failure keeps the ID for a resend; any answer from the server settles it.
      if (cause instanceof ApiError) { attempts.current.settle(); setEditing(null); }
      fail(cause);
    } finally {
      mutating.current = false;
      if (active.current) { setBusy(false); void reloadRoute(); }
    }
  }
  async function depart() {
    if (!vehicleId || mutating.current) return;
    mutating.current = true; setBusy(true); setError(null);
    try {
      // A resend after a lost response must be the same request, so the stamp keeps its time and location.
      const stamp = await attempts.current.get('departed', async () => {
        const { location, problem: reason } = await departureLocation();
        return { ...newEventStamp(location), problem: reason };
      });
      await sendDeparted({ ...stamp, date, vehicleId });
      attempts.current.settle();
      const problem = stamp.problem;
      void showTrackingGuides();
      if (problem && active.current) {
        setBanner({ title: '출발 위치 없음', body: problem === 'denied' ? '위치 권한이 없어 출발 위치를 보내지 않았습니다.' : '현재 위치를 읽지 못해 출발 위치를 보내지 않았습니다.' });
      }
    } catch (cause) {
      if (cause instanceof ApiError) attempts.current.settle();
      fail(cause);
    } finally {
      mutating.current = false;
      if (active.current) { setBusy(false); void reloadRoute(); }
    }
  }

  if (!choiceReady) return <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>;
  if (!vehicleId || vehicleGone) return <VehicleSelectScreen date={date} onLogout={() => void signOut()} onSelect={(id) => void chooseVehicle(id)} onSessionLost={onSignedOut} />;
  const { stops, queued } = applyOutbox(route ? routeStops(route) : [], outbox.items);
  const orders = stops.flatMap((stop) => stop.orders);
  const reportingStop = stops.find((stop) => stop.key === reporting && stop.status === 'current') ?? null;
  const labelFor = (item: { stopId: string }) => stops.find((stop) => stop.orders.some((order) => order.id === item.stopId))?.name ?? item.stopId;
  const phase = route?.phase ?? 'idle';
  const pickup = phase === 'idle' || phase === 'preparing';
  const selectedStop = stops.find((stop) => stop.key === selectedKey) ?? null;
  const progress = stopProgress(stops);
  const opsCall = telUrl(OPS_PHONE);
  const shownError = error ?? pollError;
  const etaFor = (stop: Stop) => etaLabel(stop, route);
  const infoFor = (stop: Stop) => {
    const entry = serverStop(stop, route);
    return entry ? <StopInfo date={date} key={entry.stopId} onTipSaved={() => { void reloadRoute(); }} stopId={entry.stopId} tipEditable={stop.status === 'pending' || stop.status === 'current'} vehicleId={vehicleId} /> : null;
  };
  const pushLabel = { registering: '알림 연결 중', ready: '알림 연결됨', denied: '알림 권한이 꺼져 있습니다', unavailable: '푸시 알림 연결 안 됨 · 앱에서 메시지를 확인하세요' }[pushStatus];
  const editingStops = editing ? routeStops(editing) : [];

  return <SafeAreaView style={styles.screen}>
    <View style={styles.header}><Logo /><View style={styles.headerButtons}>
      <Button disabled={busy} label="메시지" onPress={() => setMessagesOpen(true)} style={styles.headerButton} tone="secondary" />
      <Button disabled={busy} label="차량 변경" onPress={() => void chooseVehicle(null)} style={styles.headerButton} tone="secondary" />
    </View></View>
    <View style={styles.summary}><T style={styles.driver}>{route?.vehicle.label ?? vehicleId}</T><T style={styles.caption}>{date} · 완료 {progress.done}/{progress.total}곳</T></View>
    {outbox.waiting > 0 ? <Pressable accessibilityRole="button" onPress={() => setOutboxOpen(true)} style={[styles.outboxBadge, outbox.rejected > 0 && styles.outboxBadgeRejected]}>
      <T style={styles.outboxBadgeText}>{outbox.rejected > 0 ? `전송 실패 ${outbox.rejected}건 · 확인이 필요합니다` : `전송 대기 ${outbox.waiting}건`}</T>
    </Pressable> : null}
    <View style={styles.actionsRow}>
      <Button label="오늘 이력" onPress={() => setHistoryOpen(true)} style={styles.headerButton} tone="secondary" />
      {opsCall ? <Button label="운영팀 전화" onPress={() => { void Linking.openURL(opsCall).catch(() => setError('전화 앱을 열지 못했습니다.')); }} style={styles.headerButton} tone="secondary" /> : null}
    </View>
    <T style={[styles.pushStatus, pushStatus !== 'ready' && styles.warning]}>{pushLabel}</T>
    {shownError ? <View style={styles.errorBox}><T accessibilityRole="alert" style={styles.error}>{shownError}</T><Button label="새로고침" onPress={() => { setError(null); void reloadRoute(); }} tone="secondary" /></View> : null}
    {banner ? <Pressable accessibilityRole="button" onPress={() => { setMessagesOpen(true); setBanner(null); }} style={styles.banner}><T style={styles.bannerTitle}>{banner.title}</T><T numberOfLines={2} style={styles.bannerBody}>{banner.body}</T></Pressable> : null}
    {!route ? <View style={styles.center}><ActivityIndicator color={colors.brand} /></View>
      : !route.operable ? <View style={styles.center}><T>오늘 배차가 확정되면 배송을 시작할 수 있습니다.</T><Button label="새로고침" onPress={() => void reloadRoute()} /></View>
      : editing ? <RouteOrderEditor fixedStops={editingStops.filter((stop) => stop.status !== 'pending')} isSaving={busy} onCancel={() => setEditing(null)} onSave={(keys) => void saveOrder(keys)} onSuggest={suggestOrder} stops={editingStops.filter((stop) => stop.status === 'pending')} />
      : tab === 'delivery' && pickup ? <PickupScreen date={date} deliveries={orders} key={`${date}:${vehicleId}`} onEditOrder={() => void openEditor()} onStart={() => void depart()} starting={busy || !!shownError} vehicleId={vehicleId} />
      : tab === 'delivery' ? <DeliveryScreen busy={busy || !!shownError} canEditOrder={phase === 'delivering'} etaFor={etaFor} queued={queued} infoFor={infoFor} onAction={act} onEditOrder={() => void openEditor()} onRefresh={() => { void reloadRoute(); }} refreshing={false} stops={stops} />
      : <View style={styles.fill}><DeliveryRouteMap dimmedKeys={dimmedStopKeys(stops, route)} onMapPress={() => setSelectedKey(null)} onSelect={setSelectedKey} selectedKey={selectedKey} stops={stops} />
        <BottomSheet onDismiss={() => setSelectedKey(null)} open={!!selectedStop}>{selectedStop ? <ScrollView style={styles.stopSheet}><StopDetails busy={busy || !!shownError} eta={etaFor(selectedStop)} info={infoFor(selectedStop)} onAction={act} stop={selectedStop} /><Button label="닫기" onPress={() => setSelectedKey(null)} tone="secondary" /></ScrollView> : null}</BottomSheet>
      </View>}
    {!editing ? <View style={styles.tabs}>{(['delivery', 'map'] as const).map((value) => <Pressable accessibilityRole="tab" accessibilityState={{ selected: tab === value }} key={value} onPress={() => setTab(value)} style={[styles.tab, tab === value && styles.tabSelected]}><T style={[styles.tabLabel, tab === value && styles.tabLabelSelected]}>{value === 'delivery' ? '배송' : '지도'}</T></Pressable>)}</View> : null}
    {historyOpen ? <HistoryScreen date={date} onClose={() => setHistoryOpen(false)} stops={stops} vehicleId={vehicleId} waiting={outbox.waiting} /> : null}
    {reportingStop ? <CompletionScreen date={date} onClose={() => setReporting(null)} onSubmit={outbox.enqueue} queuedPhotos={outbox.photos} stop={reportingStop} stopId={serverStop(reportingStop, route)?.stopId ?? reportingStop.orders[0].id} vehicleId={vehicleId} /> : null}
    {outboxOpen ? <OutboxSheet items={outbox.items} labelFor={labelFor} onClose={() => setOutboxOpen(false)} onDiscard={(id) => { void outbox.discard(id).then(() => { void reloadRoute(); }); }} onRetry={(id) => void outbox.retryNow(id)} /> : null}
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
  headerButtons: { flexDirection: 'row', gap: 6 },
  actionsRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 6 }, headerButton: { minHeight: TOUCH_MIN, paddingHorizontal: 10 },
  summary: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 8 },
  driver: { fontSize: 17, fontWeight: '800' }, caption: { color: colors.muted, fontSize: 13 },
  pushStatus: { color: colors.green, fontSize: 12, paddingHorizontal: 12, paddingBottom: 6 }, warning: { color: colors.amber },
  errorBox: { backgroundColor: colors.surface, gap: 8, padding: 12 }, error: { color: colors.error, fontSize: 14 },
  banner: { backgroundColor: colors.action, gap: 3, padding: 12 }, bannerTitle: { color: colors.surface, fontSize: 13, fontWeight: '800' }, bannerBody: { color: colors.surface, fontSize: 15 },
  tabs: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1, flexDirection: 'row' },
  tab: { alignItems: 'center', borderTopWidth: 3, borderTopColor: 'transparent', flex: 1, justifyContent: 'center', minHeight: 58 },
  tabSelected: { borderTopColor: colors.brand }, tabLabel: { color: colors.muted, fontSize: 17, fontWeight: '700' }, tabLabelSelected: { color: colors.brand },
  stopSheet: { maxHeight: 420 },
  outboxBadge: { backgroundColor: colors.action, paddingHorizontal: 12, paddingVertical: 8 },
  outboxBadgeRejected: { backgroundColor: colors.error },
  outboxBadgeText: { color: colors.surface, fontSize: 14, fontWeight: '700' }, messageList: { gap: 10, padding: 12 }, message: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: radius.card, gap: 4, maxWidth: '90%', padding: 12 },
  ownMessage: { alignSelf: 'flex-end', borderColor: colors.border, borderWidth: 1 }, messageMeta: { color: colors.muted, fontSize: 12 }, messageBody: { fontSize: 16 },
  composer: { backgroundColor: colors.surface, gap: 8, padding: 12 }, messageInput: { borderColor: colors.border, borderRadius: radius.control, borderWidth: 1, color: colors.text, fontFamily, fontSize: 16, maxHeight: 120, minHeight: 60, padding: 12 },
});
