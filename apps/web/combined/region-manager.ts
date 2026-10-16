import { MAX_VERTICES, MAX_ZONES, importInto, parseImport, problem, remove, rename, toCollection, toZones, vertexCount, type Mode, type Zone } from './region-model.ts';

// "배송 권역" under the resource list (requirement 8): import a GeoJSON, rename and delete zones, save once. The zones that
// are saved here replace the prepared ones for the map and the zone volumes of every date.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const byCode: Record<string, string> = {
  REGIONS_REVISION_CONFLICT: '다른 변경이 먼저 저장됐습니다. 최신 권역을 다시 불러왔으니 확인한 뒤 다시 저장해 주세요.',
  INVALID_REGIONS: '서버가 권역을 받아들이지 못했습니다. 코드(영문·숫자·._-, 64자 이하)가 겹치지 않고 닫힌 다각형인지 확인해 주세요.',
  ORIGIN_REQUIRED: '같은 출처에서 다시 시도해 주세요.',
  REGIONS_CUSTOM_INVALID: '저장된 권역 파일이 손상돼 읽을 수 없습니다. 지도에는 준비된 권역이 쓰이고 있습니다. 운영 절차에 따라 복구해 주세요.',
  REGIONS_WRITE_FAILED: '권역을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.',
};
const byStatus: Record<number, string> = {
  401: '로그인이 만료되었습니다. 새로고침해 다시 로그인해 주세요.',
  403: '운영자 계정만 권역을 관리할 수 있습니다.',
  404: '이 환경에는 권역 관리 기능이 없습니다.',
};

export class RegionError extends Error {
  readonly conflict: boolean;
  constructor(message: string, code = '') { super(message); this.conflict = code === 'REGIONS_REVISION_CONFLICT'; }
}

export const REGIONS_CHANGED = 'meatbox:regions-changed';

export type RegionsState = { revision: number; custom: boolean; zones: Zone[] };

export function createRegionClient(fetchImpl: typeof fetch = fetch) {
  async function request(method: 'GET' | 'PUT', body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetchImpl('/api/ops/regions', {
      method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    }).catch(() => { throw new RegionError('권역 요청을 보내지 못했습니다. 연결 상태를 확인해 주세요.'); });
    const payload: unknown = await response.json().catch(() => ({}));
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    if (!response.ok) {
      const code = String(record.code ?? record.error ?? '');
      throw new RegionError(byCode[code] ?? byStatus[response.status] ?? '권역 요청을 처리하지 못했습니다. 다시 시도해 주세요.', code);
    }
    return record;
  }
  return {
    async load(): Promise<RegionsState> {
      const reply = await request('GET');
      if (typeof reply.revision !== 'number') throw new RegionError('권역 응답을 확인할 수 없습니다.');
      return { revision: reply.revision, custom: reply.custom === true, zones: toZones(reply.regions) };
    },
    /** Saves [zones] over the current revision, or removes the operator's zones with null. Reads the result back. */
    async save(revision: number, zones: Zone[] | null): Promise<RegionsState> {
      await request('PUT', { revision, regions: zones === null ? null : toCollection(zones) });
      return this.load();
    },
  };
}
export type RegionClient = ReturnType<typeof createRegionClient>;

export function regionMarkup(): string {
  return `<section class="region-manager" aria-labelledby="region-manager-heading" data-region-manager><h2 id="region-manager-heading">배송 권역</h2>
    <p class="muted" data-region-status></p><p class="resource-message" role="status" data-region-message></p>
    <div data-region-list></div>
    <form class="region-import" data-region-import><h3>권역 가져오기</h3>
      <label class="field"><span>GeoJSON 파일</span><input type="file" accept=".geojson,.json,application/geo+json,application/json" data-region-file></label>
      <label class="field"><span>또는 GeoJSON 붙여넣기</span><textarea rows="4" data-region-text placeholder='{"type":"FeatureCollection","features":[…]}'></textarea></label>
      <div class="region-import-mode" role="group" aria-label="가져오기 방식"><label><input type="radio" name="region-mode" value="merge" data-region-mode checked> 현재 권역에 추가(같은 코드는 덮어씀)</label><label><input type="radio" name="region-mode" value="replace" data-region-mode> 전체 교체</label></div>
      <button type="submit" class="button" data-region-add>목록에 반영</button>
      <p class="muted">경도·위도의 닫힌 Polygon/MultiPolygon만 가져옵니다. 권역 코드는 속성 <code>zoneId</code>(없으면 <code>id</code>·<code>code</code>·<code>name</code>), 이름은 <code>label</code>(없으면 <code>name</code>)에서 읽고 코드가 없으면 R1, R2…를 붙입니다. 최대 ${MAX_ZONES}개, 꼭짓점 ${MAX_VERTICES.toLocaleString('ko-KR')}개.</p></form>
    <div class="region-actions"><button type="button" class="button primary" data-region-save disabled>저장</button><button type="button" class="button subtle" data-region-discard disabled>변경 취소</button><button type="button" class="button subtle" data-region-reset disabled>준비된 권역으로 되돌리기</button></div>
    <p class="muted region-caveat">저장하면 지도와 권역별 물량에 바로 적용됩니다. 준비된 CSV 날짜의 주문은 원래 권역 코드를 갖고 있어서, 지운 권역의 주문은 권역 없음으로 보이고 새 권역에는 들어가지 않습니다. 미트박스 주문은 좌표로 새 권역에 들어갑니다.</p></section>`;
}

export function listHtml(zones: Zone[], changed: Set<string>): string {
  if (!zones.length) return '<p class="muted">권역이 없습니다. 아래에서 GeoJSON을 가져와 주세요.</p>';
  return `<div class="resource-table-scroll"><table class="resource-table region-table"><thead><tr><th scope="col">코드</th><th scope="col">이름</th><th scope="col">꼭짓점</th><th scope="col"><span class="sr-only">삭제</span></th></tr></thead><tbody>${zones.map(zone => `<tr data-region-row="${esc(zone.zoneId)}" data-changed="${changed.has(zone.zoneId)}"><th scope="row">${esc(zone.zoneId)}</th><td><input class="region-label" data-region-label="${esc(zone.zoneId)}" value="${esc(zone.label)}" maxlength="100" aria-label="${esc(zone.zoneId)} 이름"></td><td>${vertexCount(zone.geometry).toLocaleString('ko-KR')}</td><td><button type="button" class="button subtle" data-region-remove="${esc(zone.zoneId)}">삭제</button></td></tr>`).join('')}</tbody></table></div>`;
}

type Node = {
  innerHTML: string; textContent: string; value: string; disabled: boolean; checked?: boolean; files?: { text(): Promise<string> }[];
  addEventListener(type: string, listener: (event: any) => void): void;
};

export function mountRegionManager({ element, client = createRegionClient() }: { element: { querySelector(selector: string): Node | null }; client?: RegionClient }) {
  const root = element.querySelector('[data-region-manager]')!;
  const list = element.querySelector('[data-region-list]')!;
  const status = element.querySelector('[data-region-status]')!;
  const message = element.querySelector('[data-region-message]')!;
  const file = element.querySelector('[data-region-file]')!;
  const text = element.querySelector('[data-region-text]')!;
  const save = element.querySelector('[data-region-save]')!;
  const discard = element.querySelector('[data-region-discard]')!;
  const reset = element.querySelector('[data-region-reset]')!;
  let saved: RegionsState | null = null;
  let draft: Zone[] = [];
  let busy = false;
  let confirmReset = false;
  let destroyed = false;

  const changedIds = (): Set<string> => {
    const before = new Map((saved?.zones ?? []).map(zone => [zone.zoneId, JSON.stringify([zone.label, zone.geometry])]));
    return new Set(draft.filter(zone => before.get(zone.zoneId) !== JSON.stringify([zone.label, zone.geometry])).map(zone => zone.zoneId));
  };
  const dirty = (): boolean => !saved || JSON.stringify(draft.map(zone => [zone.zoneId, zone.label, zone.geometry])) !== JSON.stringify(saved.zones.map(zone => [zone.zoneId, zone.label, zone.geometry]));

  function render(): void {
    if (!saved) { list.innerHTML = '<p class="muted">권역을 불러오고 있습니다.</p>'; return; }
    const changed = changedIds();
    list.innerHTML = listHtml(draft, changed);
    const removed = saved.zones.filter(zone => !draft.some(item => item.zoneId === zone.zoneId)).length;
    status.textContent = `${saved.custom ? '운영자가 저장한 권역' : '준비된 권역(아직 저장한 권역이 없음)'} ${saved.zones.length}개를 쓰고 있습니다.${dirty() ? ` 저장하지 않은 변경: 바뀐 권역 ${changed.size}개, 지운 권역 ${removed}개.` : ''}`;
    const unsaved = dirty();
    save.disabled = busy || !unsaved || problem(draft) !== '';
    discard.disabled = busy || !unsaved;
    reset.disabled = busy || !saved.custom;
    reset.textContent = confirmReset ? '정말 되돌립니다(다시 누르면 실행)' : '준비된 권역으로 되돌리기';
  }

  async function load(): Promise<void> {
    try { saved = await client.load(); draft = saved.zones; message.textContent = ''; } catch (cause) {
      saved = null; list.innerHTML = '';
      message.textContent = cause instanceof Error ? cause.message : '권역을 불러오지 못했습니다.';
      return;
    } finally { if (!destroyed && saved) render(); }
  }

  async function commit(zones: Zone[] | null, done: string): Promise<void> {
    if (!saved || busy) return;
    busy = true; message.textContent = '저장하고 있습니다.'; render();
    try {
      saved = await client.save(saved.revision, zones);
      draft = saved.zones; message.textContent = done;
      // The dispatch page keeps the zones it read once; it reads them again on this signal.
      globalThis.dispatchEvent?.(new Event(REGIONS_CHANGED));
    } catch (cause) {
      if (cause instanceof RegionError && cause.conflict) await load();
      message.textContent = cause instanceof Error ? cause.message : '저장하지 못했습니다.';
    } finally { busy = false; confirmReset = false; if (!destroyed) render(); }
  }

  async function addImport(mode: Mode): Promise<void> {
    const source = file.files?.[0] ? await file.files[0].text() : text.value;
    if (!source.trim()) { message.textContent = 'GeoJSON 파일을 고르거나 내용을 붙여넣어 주세요.'; return; }
    const parsed = parseImport(source);
    if ('error' in parsed) { message.textContent = parsed.error; return; }
    draft = importInto(draft, parsed.zones, mode);
    text.value = '';
    message.textContent = `${parsed.zones.length}개 권역을 목록에 반영했습니다.${parsed.skipped ? ` 다각형이 아니거나 닫히지 않은 ${parsed.skipped}개는 건너뛰었습니다.` : ''} 저장해야 적용됩니다. ${problem(draft)}`.trim();
    render();
  }

  root.addEventListener('submit', (event: { preventDefault(): void }) => {
    event.preventDefault();
    void addImport(element.querySelector('[data-region-mode]:checked')?.value === 'replace' ? 'replace' : 'merge');
  });
  // A name is edited in place: the list is not redrawn, so the caret stays where it is.
  root.addEventListener('input', (event: { target: { dataset?: Record<string, string>; value: string } }) => {
    const id = event.target.dataset?.regionLabel;
    if (id === undefined) return;
    draft = rename(draft, id, event.target.value);
    renderStatusOnly();
  });
  function renderStatusOnly(): void {
    if (!saved) return;
    const unsaved = dirty();
    save.disabled = busy || !unsaved || problem(draft) !== '';
    discard.disabled = busy || !unsaved;
    status.textContent = `${saved.custom ? '운영자가 저장한 권역' : '준비된 권역(아직 저장한 권역이 없음)'} ${saved.zones.length}개를 쓰고 있습니다.${unsaved ? ' 저장하지 않은 변경이 있습니다.' : ''}`;
  }
  root.addEventListener('click', (event: { target: { closest(selector: string): { dataset: Record<string, string> } | null } }) => {
    const del = event.target.closest('[data-region-remove]');
    if (del) { draft = remove(draft, del.dataset.regionRemove ?? ''); message.textContent = problem(draft); render(); return; }
    if (event.target.closest('[data-region-save]')) {
      const why = problem(draft);
      if (why) { message.textContent = why; return; }
      void commit(draft, '저장했습니다. 지도와 권역별 물량에 적용됩니다.');
      return;
    }
    if (event.target.closest('[data-region-discard]')) { draft = saved?.zones ?? []; message.textContent = ''; render(); return; }
    if (event.target.closest('[data-region-reset]')) {
      if (!confirmReset) { confirmReset = true; render(); return; }
      void commit(null, '준비된 권역으로 되돌렸습니다.');
    }
  });

  void load();
  return { reload: load, destroy(): void { destroyed = true; } };
}
