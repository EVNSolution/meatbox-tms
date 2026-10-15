import QRCode from 'qrcode';
import { seoulToday, validOperatingDate } from './operating-date.mjs';

export const messageLimit = 1000;
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

type Order = { id: string; vehicleId?: string; name?: string; address?: string; boxes?: number; orders?: Order[] };
type Vehicle = { id: string; plate?: string; driver?: string };
type Data = { sourceData?: { date?: string }; sourceOrders?: Order[]; dispatch?: { readOnly?: boolean }; connected?: boolean };
type Row = { vehicle: Vehicle; deliveries: Order[] };
export type DriverMessage = { id: string; from: 'ops' | 'driver'; body: string; createdAt: string };
type PushResult = { status: string };
type SendResult = { message: DriverMessage; push: PushResult };
type Context = { date: string; vehicle: Vehicle; orders: Order[]; readOnly: boolean; connected: boolean };

export function pickupOrders(data: Data, row: Row): Order[] {
  const orders = data.sourceOrders ?? row.deliveries.flatMap(stop => stop.orders ?? [stop]);
  const seen = new Set<string>();
  return orders.filter(order => order.vehicleId === row.vehicle.id && !seen.has(order.id) && Boolean(seen.add(order.id)));
}

export function pickupPayload(date: string, orderId: string): string {
  if (!validOperatingDate(date) || !orderId || orderId.length > 200 || [...orderId].some(char => char.codePointAt(0)! < 32)) {
    throw new Error('QR에 사용할 날짜와 주문 번호를 확인해 주세요.');
  }
  return `meatbox:${date}:${orderId}`;
}

export function pushResultText(push: PushResult | undefined): string {
  const labels: Record<string, string> = {
    sent: '알림 요청이 FCM에 접수되었습니다. 기기 수신 여부는 확인되지 않았습니다.',
    partial: '일부 기기의 알림 요청만 FCM에 접수되었습니다. 기기 수신 여부는 확인되지 않았습니다.',
    failed: '알림 요청이 실패했습니다. 메시지 기록은 저장되었습니다.',
    unconfigured: '알림 설정이 준비되지 않아 푸시를 보내지 않았습니다.',
    'no-device': '등록된 배송원 기기가 없어 푸시를 보내지 않았습니다.',
    'not-requested': '푸시를 요청하지 않았습니다.',
  };
  return labels[push?.status ?? ''] ?? '푸시 처리 결과를 확인하지 못했습니다.';
}

function isMessage(value: unknown): value is DriverMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<DriverMessage>;
  return typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 200
    && (message.from === 'ops' || message.from === 'driver')
    && typeof message.body === 'string' && message.body.length <= messageLimit
    && typeof message.createdAt === 'string' && Number.isFinite(Date.parse(message.createdAt));
}

export function createDriverMessageClient(fetchImpl: typeof fetch = fetch) {
  async function request(date: string, vehicleId: string, body?: string): Promise<unknown> {
    if (!validOperatingDate(date) || !vehicleId) throw new Error('조회 날짜와 차량을 확인해 주세요.');
    const sending = body !== undefined;
    if (sending && (!body.trim() || body.length > messageLimit)) throw new Error(`메시지는 1~${messageLimit}자로 입력해 주세요.`);
    if (sending && date < seoulToday()) throw new Error('과거 날짜는 이력 조회만 가능합니다.');
    const path = `/api/dispatch-data/days/${date}/driver/messages`;
    const response = await fetchImpl(sending ? path : `${path}?${new URLSearchParams({ vehicleId })}`, {
      method: sending ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(sending ? { 'content-type': 'application/json' } : {}) },
      ...(sending ? { body: JSON.stringify({ vehicleId, body: body.trim(), from: 'ops' }) } : {}),
      signal: AbortSignal.timeout(15000),
    }).catch(() => { throw new Error(sending
      ? '전송 결과를 확인하지 못했습니다. 새로고침으로 메시지 기록을 확인해 주세요.'
      : '메시지를 불러오지 못했습니다. 연결 상태를 확인해 주세요.'); });
    if (!response.ok) {
      const labels: Record<number, string> = {
        401: '로그인이 만료되었습니다. 다시 로그인해 주세요.',
        403: '이 차량의 메시지를 처리할 권한이 없습니다.',
        404: '선택 날짜의 배차 또는 차량을 찾지 못했습니다.',
        409: '이 날짜는 메시지를 보낼 수 없습니다. 배차 상태를 확인해 주세요.',
        400: '메시지와 차량 정보를 확인해 주세요.',
      };
      throw new Error(labels[response.status] ?? (sending
        ? '전송 결과를 확인하지 못했습니다. 새로고침으로 메시지 기록을 확인해 주세요.'
        : '메시지를 불러오지 못했습니다. 다시 시도해 주세요.'));
    }
    return response.json();
  }
  return {
    async load(date: string, vehicleId: string): Promise<DriverMessage[]> {
      const payload = await request(date, vehicleId) as { messages?: unknown };
      if (!Array.isArray(payload?.messages) || !payload.messages.every(isMessage)) throw new Error('메시지 응답 형식을 확인할 수 없습니다.');
      return payload.messages;
    },
    async send(date: string, vehicleId: string, body: string): Promise<SendResult> {
      const payload = await request(date, vehicleId, body) as Partial<SendResult>;
      if (!isMessage(payload?.message)) throw new Error('저장 응답을 확인하지 못했습니다. 새로고침으로 메시지 기록을 확인해 주세요.');
      return { message: payload.message, push: { status: typeof payload.push?.status === 'string' ? payload.push.status : 'unknown' } };
    },
  };
}

export function driverToolsMarkup(): string {
  return `<div class="control-driver-tools"><button type="button" class="button" data-driver-pickup disabled>수령 QR 출력</button><button type="button" class="button" data-driver-messages disabled>배송원 메시지</button></div>
  <dialog class="driver-dialog driver-pickup-dialog" data-pickup-dialog aria-labelledby="pickup-dialog-title"><div class="driver-dialog-heading"><h2 id="pickup-dialog-title">차량별 수령 QR</h2><button type="button" class="button" data-pickup-close>닫기</button></div><p data-pickup-context></p><p class="muted">각 주문의 QR을 배송원 앱으로 스캔하세요. QR에는 배송일과 주문 번호만 포함합니다.</p><p data-pickup-status role="status"></p><div data-pickup-sheet></div><div class="driver-dialog-actions"><button type="button" class="button primary" data-pickup-print disabled>인쇄</button></div></dialog>
  <dialog class="driver-dialog driver-message-dialog" data-message-dialog aria-labelledby="message-dialog-title"><div class="driver-dialog-heading"><h2 id="message-dialog-title">배송원 메시지</h2><button type="button" class="button" data-message-close>닫기</button></div><p data-message-context></p><p class="muted">메시지를 저장하고 배송원 앱에 알림을 요청합니다. 기기 수신과 읽음 여부는 확인되지 않습니다.</p><div class="driver-message-toolbar"><span class="muted">열려 있는 동안 5초마다 갱신</span><button type="button" class="button" data-message-refresh>새로고침</button></div><p data-message-load-status role="status"></p><ol class="driver-message-list" data-message-list aria-label="운영자와 배송원 메시지"></ol><form data-message-form><label class="field"><span>배송원에게 보낼 메시지</span><textarea data-message-body maxlength="${messageLimit}" rows="3" required placeholder="배송원에게 전달할 내용을 입력하세요."></textarea></label><p data-message-readonly class="muted" hidden>이력 조회 (읽기 전용)</p><p data-message-send-status role="status" aria-live="polite"></p><div class="driver-dialog-actions"><span class="muted">최대 ${messageLimit.toLocaleString('ko-KR')}자</span><button type="submit" class="button primary" data-message-send>메시지 전송</button></div></form></dialog>`;
}

export function mountDriverTools({ element, client = createDriverMessageClient(), qrCode = QRCode.toDataURL,
  today = seoulToday, print = () => window.print(), pollMs = 5000,
}: { element: HTMLElement; client?: ReturnType<typeof createDriverMessageClient>; qrCode?: typeof QRCode.toDataURL; today?: () => string; print?: () => void; pollMs?: number }) {
  const find = <T extends HTMLElement>(selector: string) => element.querySelector<T>(selector)!;
  const pickupButton = find<HTMLButtonElement>('[data-driver-pickup]');
  const messageButton = find<HTMLButtonElement>('[data-driver-messages]');
  const pickupDialog = find<HTMLDialogElement>('[data-pickup-dialog]');
  const messageDialog = find<HTMLDialogElement>('[data-message-dialog]');
  const messageList = find<HTMLOListElement>('[data-message-list]');
  const body = find<HTMLTextAreaElement>('[data-message-body]');
  const sendButton = find<HTMLButtonElement>('[data-message-send]');
  const refreshButton = find<HTMLButtonElement>('[data-message-refresh]');
  const printButton = find<HTMLButtonElement>('[data-pickup-print]');
  const sheet = find<HTMLElement>('[data-pickup-sheet]');
  let context: Context | null = null, epoch = 0, loading = false, sending = false, destroyed = false;
  let pickupEpoch = 0, pickupSignature = '';
  let messages: DriverMessage[] = [], messageRevision = 0, timer: ReturnType<typeof setTimeout> | undefined;

  function contextLabel(current: Context) { return `${current.date} / ${current.vehicle.plate || current.vehicle.id} / ${current.vehicle.driver || '배송원 미등록'}`; }
  function setSendAvailability() {
    const readOnly = !context || context.readOnly || context.date < today();
    body.disabled = readOnly || sending || !context?.connected;
    sendButton.disabled = body.disabled;
    find('[data-message-readonly]').hidden = !readOnly;
  }
  function stopPolling() { clearTimeout(timer); timer = undefined; }
  function renderMessages() {
    const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 50;
    const markup = messages.map(message => `<li class="driver-message ${message.from === 'ops' ? 'from-ops' : 'from-driver'}"><div><strong>${message.from === 'ops' ? '운영자' : '배송원'}</strong><time datetime="${esc(message.createdAt)}">${esc(new Date(message.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }))}</time></div><p>${esc(message.body)}</p></li>`).join('') || '<li class="muted">저장된 메시지가 없습니다.</li>';
    if (messageList.innerHTML !== markup) { messageList.innerHTML = markup; if (nearBottom) messageList.scrollTop = messageList.scrollHeight; }
  }
  async function loadMessages() {
    if (!context || !messageDialog.open || destroyed || loading) return;
    stopPolling(); loading = true; refreshButton.disabled = true;
    const current = context, requestEpoch = epoch, requestRevision = messageRevision;
    try {
      const result = await client.load(current.date, current.vehicle.id);
      if (requestEpoch !== epoch || requestRevision !== messageRevision || destroyed || !messageDialog.open) return;
      messages = result; renderMessages();
      find('[data-message-load-status]').textContent = '';
    } catch (error) {
      if (requestEpoch === epoch && !destroyed && messageDialog.open) find('[data-message-load-status]').textContent = error instanceof Error ? error.message : '메시지를 불러오지 못했습니다.';
    } finally {
      if (requestEpoch === epoch && !destroyed) {
        loading = false; refreshButton.disabled = false;
        if (messageDialog.open) timer = setTimeout(() => { void loadMessages(); }, pollMs);
      }
    }
  }
  async function openPickup() {
    if (!context || !context.orders.length) return;
    const current = context, requestEpoch = ++pickupEpoch;
    sheet.innerHTML = ''; printButton.disabled = true;
    find('[data-pickup-context]').textContent = contextLabel(current);
    find('[data-pickup-status]').textContent = '수령 QR을 준비하고 있습니다.';
    pickupDialog.showModal();
    try {
      const cards = await Promise.all(current.orders.map(async (order, index) => {
        const payload = pickupPayload(current.date, order.id);
        const image = await qrCode(payload, { errorCorrectionLevel: 'M', margin: 4, width: 200 });
        return `<article class="pickup-card"><img src="${esc(image)}" width="160" height="160" alt="${esc(`주문 ${order.id} 수령 QR`)}"><div><strong>${index + 1}. ${esc(order.name || '배송지')}</strong><p>${esc(order.id)}</p><p>${esc(order.address || '주소 미등록')}</p><p>${Number.isFinite(order.boxes) ? esc(order.boxes) : '미확인'} 박스</p></div></article>`;
      }));
      if (requestEpoch !== pickupEpoch || destroyed || !pickupDialog.open) return;
      sheet.innerHTML = `<div class="pickup-grid">${cards.join('')}</div>`;
      find('[data-pickup-status]').textContent = `주문 ${current.orders.length}건 / QR ${cards.length}개`;
      printButton.disabled = false;
    } catch {
      if (requestEpoch === pickupEpoch && !destroyed && pickupDialog.open) find('[data-pickup-status]').textContent = '수령 QR을 만들지 못했습니다. 닫은 뒤 다시 시도해 주세요.';
    }
  }
  function invalidatePickup() {
    pickupEpoch += 1; sheet.innerHTML = ''; printButton.disabled = true;
    document.body.classList.remove('driver-pickup-print');
  }
  pickupButton.addEventListener('click', () => { void openPickup(); });
  find('[data-pickup-close]').addEventListener('click', () => pickupDialog.close());
  pickupDialog.addEventListener('close', () => {
    // Native close events are queued; an earlier close must not invalidate a newly opened sheet.
    if (!pickupDialog.open) { invalidatePickup(); pickupButton.focus(); }
  });
  printButton.addEventListener('click', () => {
    if (printButton.disabled || !pickupDialog.open) return;
    document.body.classList.add('driver-pickup-print');
    print();
  });
  messageButton.addEventListener('click', () => {
    if (!context) return;
    messages = []; renderMessages();
    find('[data-message-context]').textContent = contextLabel(context);
    find('[data-message-load-status]').textContent = '메시지를 불러오고 있습니다.';
    find('[data-message-send-status]').textContent = '';
    setSendAvailability(); messageDialog.showModal(); void loadMessages();
  });
  find('[data-message-close]').addEventListener('click', () => messageDialog.close());
  messageDialog.addEventListener('close', () => { stopPolling(); epoch += 1; loading = false; messageButton.focus(); });
  refreshButton.addEventListener('click', () => { void loadMessages(); });
  find<HTMLFormElement>('[data-message-form]').addEventListener('submit', async event => {
    event.preventDefault();
    setSendAvailability();
    if (!context || sendButton.disabled) return;
    const text = body.value.trim();
    const status = find('[data-message-send-status]');
    if (!text || text.length > messageLimit) { status.textContent = `메시지는 1~${messageLimit}자로 입력해 주세요.`; return; }
    const current = context, requestEpoch = epoch;
    sending = true; setSendAvailability(); status.textContent = '메시지를 저장하고 있습니다.';
    try {
      const result = await client.send(current.date, current.vehicle.id, text);
      if (requestEpoch !== epoch || destroyed) return;
      messageRevision += 1;
      messages = [...messages.filter(message => message.id !== result.message.id), result.message];
      renderMessages(); messageList.scrollTop = messageList.scrollHeight; body.value = '';
      status.textContent = `메시지가 저장되었습니다. ${pushResultText(result.push)}`;
    } catch (error) {
      if (requestEpoch === epoch && !destroyed) status.textContent = error instanceof Error ? error.message : '전송 결과를 확인하지 못했습니다. 새로고침으로 메시지 기록을 확인해 주세요.';
    } finally { sending = false; if (!destroyed) setSendAvailability(); }
  });
  function reset() {
    epoch += 1; loading = false; stopPolling();
    if (pickupDialog.open) pickupDialog.close();
    if (messageDialog.open) messageDialog.close();
    messages = []; body.value = ''; sheet.innerHTML = ''; messageList.innerHTML = '';
  }
  return {
    update(data: Data | null, row: Row | null) {
      const date = data?.sourceData?.date;
      const next = data && row && validOperatingDate(date) ? {
        date: date!, vehicle: row.vehicle, orders: pickupOrders(data, row),
        readOnly: Boolean(data.dispatch?.readOnly), connected: data.connected !== false,
      } : null;
      const nextPickupSignature = next ? JSON.stringify([next.date, next.vehicle.id, next.vehicle.plate, next.vehicle.driver,
        next.orders.map(order => [order.id, order.name, order.address, order.boxes])]) : '';
      if (pickupSignature !== nextPickupSignature && pickupDialog.open) {
        invalidatePickup(); pickupDialog.close();
      }
      if (context?.date !== next?.date || context?.vehicle.id !== next?.vehicle.id) reset();
      context = next; pickupSignature = nextPickupSignature;
      pickupButton.disabled = !next?.orders.length;
      messageButton.disabled = !next;
      setSendAvailability();
    },
    destroy() { destroyed = true; reset(); context = null; },
  };
}
