// What drivers wrote at stops on the selected day (`GET /api/ops/driver-notes`), in the control record area. Reads only.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export type DriverNote = { vehicleId: string; driver: string; stopId: string; name: string; address: string; result: string; reasonCode: string; note: string; at: string };

const results: Record<string, string> = { completed: '완료', partially_completed: '일부 완료', failed: '미배송' };
const reasons: Record<string, string> = {
  ABSENT: '수령인 부재', ACCESS_DENIED: '출입 불가', ADDRESS_MISMATCH: '주소 불일치', REFUSED: '수령 거부', NO_STORAGE: '보관 불가', OTHER: '기타',
};
const messages: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  403: '운영자 계정만 기사 특이사항을 볼 수 있습니다.',
  404: '이 환경에는 기사 특이사항 기능이 없습니다.',
  503: '기사 특이사항을 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.',
};

export function parseNotes(payload: unknown): DriverNote[] {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) throw new TypeError('기사 특이사항 응답을 확인할 수 없습니다.');
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  return items.map((item: Record<string, unknown>) => ({
    vehicleId: text(item.vehicleId), driver: text(item.driver), stopId: text(item.stopId), name: text(item.name), address: text(item.address),
    result: text(item.result), reasonCode: text(item.reasonCode), note: text(item.note), at: text(item.at),
  }));
}

export async function fetchNotes(date: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<DriverNote[]> {
  const response = await fetchImpl(`/api/ops/driver-notes?date=${encodeURIComponent(date)}`, { credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(messages[response.status] ?? '기사 특이사항을 불러오지 못했습니다.');
  return parseNotes(await response.json());
}

const clock = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
};

export function notesMarkup(): string {
  return '<details class="control-driver-notes" data-driver-notes><summary>기사 특이사항 <span class="muted" data-driver-notes-count></span></summary>'
    + '<div data-driver-notes-body tabindex="0" aria-label="기사 특이사항 목록"></div></details>';
}

export function notesHtml(notes: DriverNote[]): string {
  if (!notes.length) return '<p class="muted">이 날짜에 기사가 남긴 특이사항이 없습니다.</p>';
  return `<ol class="control-note-list">${notes.map(item => `<li data-driver-note><div><strong>${esc(item.name || item.stopId || '배송지')}</strong>`
    + `<span class="badge ${item.result === 'failed' ? 'danger' : 'neutral'}">${esc(results[item.result] ?? item.result)}${item.reasonCode ? ` · ${esc(reasons[item.reasonCode] ?? item.reasonCode)}` : ''}</span></div>`
    + `<p>${esc(item.note)}</p><small class="muted">${esc(item.driver || item.vehicleId)}${item.address ? ` · ${esc(item.address)}` : ''} · ${esc(clock(item.at))}</small></li>`).join('')}</ol>`;
}

type Node = { innerHTML: string; textContent: string; open?: boolean; addEventListener(type: string, listener: () => void): void };
export function mountDriverNotes({ element, fetchImpl = fetch }: { element: { querySelector(selector: string): Node | null }; fetchImpl?: typeof fetch }) {
  const box = element.querySelector('[data-driver-notes]')!;
  const body = element.querySelector('[data-driver-notes-body]')!;
  const count = element.querySelector('[data-driver-notes-count]')!;
  let date = '';
  let epoch = 0;
  let controller: AbortController | undefined;

  async function load(): Promise<void> {
    controller?.abort();
    const mine = ++epoch;
    if (!date || !box.open) return;
    controller = new AbortController();
    body.innerHTML = '<p class="muted">불러오는 중입니다.</p>';
    try {
      const notes = await fetchNotes(date, fetchImpl, controller.signal);
      if (mine !== epoch) return;
      count.textContent = `${notes.length}건`;
      body.innerHTML = notesHtml(notes);
    } catch (cause) {
      if (mine !== epoch) return;
      count.textContent = '';
      body.innerHTML = `<p class="temperature-error" role="alert">${esc(cause instanceof Error ? cause.message : '기사 특이사항을 불러오지 못했습니다.')}</p>`;
    }
  }

  box.addEventListener('toggle', () => void load());
  return {
    update(next: { date: string }): void { if (next.date !== date) { date = next.date; count.textContent = ''; void load(); } },
    destroy(): void { epoch += 1; controller?.abort(); },
  };
}
