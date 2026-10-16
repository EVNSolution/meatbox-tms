import { TEXT_FIELDS, isEmptyProfile, ProfileError, type DriverProfile, type DriverProfileClient, type DriverRow } from './driver-profile-client.ts';

// "기사 기준정보" under the resource list: the operator's driver master (region, skill, contact, address, contract, vehicle
// type, top spec) and each driver's largest load (Capa: stops, boxes, weight). One driver is edited at a time.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const CAPA = [['stops', '착지수', '곳', '1'], ['boxes', 'Box 수량', '박스', 'any'], ['weightKg', '중량', 'kg', 'any']] as const;
const CAPA_TEXT = (row: DriverRow): string => CAPA.map(([key, label, unit]) => `${label} ${row.capa[key] === null ? '미설정' : `${row.capa[key]!.toLocaleString('ko-KR')}${unit}`}`).join(' · ');

export const PRIVACY_NOTE = '연락처·주소·계약정보는 개인정보입니다. 운영자 계정만 보고 고칠 수 있고, 서버 로그에는 기사 계정과 수정자만 남으며, 계약 종료 때의 데이터 내보내기 파일(resources/driver-profiles.json)에 포함됩니다.';

type Values = Record<string, string>;

/** The values of the form as a profile; a blank box means "not set", and an unreadable number is an error. */
export function profileFromValues(values: Values): { profile: DriverProfile } | { error: string } {
  const profile = { capa: { stops: null, boxes: null, weightKg: null } } as unknown as DriverProfile;
  for (const [key] of TEXT_FIELDS) profile[key] = (values[key] ?? '').trim() || null;
  for (const [key, label] of CAPA) {
    const raw = (values[`capa-${key}`] ?? '').trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || (key === 'stops' && !Number.isInteger(value))) return { error: `${label}은(는) 0 이상의 ${key === 'stops' ? '정수' : '숫자'}로 입력해 주세요.` };
    profile.capa[key] = value;
  }
  return { profile };
}

export function masterMarkup(): string {
  return `<section class="driver-master" aria-labelledby="driver-master-heading" data-driver-master><h2 id="driver-master-heading">기사 기준정보</h2>
    <p class="muted driver-master-privacy">${esc(PRIVACY_NOTE)}</p><p class="resource-message" role="status" data-master-message></p>
    <div data-master-list></div><div data-master-form-host></div></section>`;
}

export function listHtml(rows: DriverRow[], vehiclesOf: (username: string) => string[], editing: string | null): string {
  if (!rows.length) return '<p class="muted">기사 계정이 없습니다. 운영 절차의 기사 초대로 계정을 만든 뒤 다시 불러와 주세요.</p>';
  return `<div class="resource-table-scroll"><table class="resource-table driver-master-table"><thead><tr><th scope="col">기사</th><th scope="col">권역</th><th scope="col">숙련도</th><th scope="col">차종</th><th scope="col">최대 Capa</th><th scope="col">배정 차량</th><th scope="col"><span class="sr-only">수정</span></th></tr></thead><tbody>${rows.map(row => {
    const vehicles = vehiclesOf(row.username);
    return `<tr data-master-row="${esc(row.username)}"><th scope="row">${esc(row.displayName)} <small class="muted">${esc(row.username)}${row.known ? (row.disabled ? ' · 비활성' : '') : ' · 계정 없음'}</small></th><td>${esc(row.region ?? '미등록')}</td><td>${esc(row.skill ?? '미등록')}</td><td>${esc(row.vehicleType ?? '미등록')}</td><td>${esc(CAPA_TEXT(row))}</td><td>${esc(vehicles.join(', ') || '없음')}</td><td><button type="button" class="button subtle" data-master-edit="${esc(row.username)}" aria-pressed="${editing === row.username}">수정</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

export function formHtml(row: DriverRow): string {
  const field = ([key, label]: readonly [string, string]) => `<label class="field"><span>${esc(label)}</span><input name="${key}" value="${esc(row[key as keyof DriverRow] ?? '')}" maxlength="${key === 'address' || key === 'contract' ? 300 : key === 'topSpec' ? 200 : 100}" autocomplete="off"></label>`;
  const capa = CAPA.map(([key, label, unit, step]) => `<label class="field"><span>${esc(label)} (${unit})</span><input name="capa-${key}" type="number" min="0" step="${step}" inputmode="decimal" value="${row.capa[key] ?? ''}"></label>`).join('');
  return `<form class="driver-master-form" data-master-form="${esc(row.username)}" aria-label="${esc(row.displayName)} 기준정보"><h3>${esc(row.displayName)} 기준정보 수정</h3>
    <div class="driver-master-grid">${TEXT_FIELDS.map(field).join('')}</div>
    <h4>최대 Capa</h4><div class="driver-master-grid">${capa}</div>
    <p class="muted">모든 칸을 비우고 저장하면 이 기사의 기준정보가 삭제됩니다. 비워 둔 Capa는 "미설정"이며 Capa 초과 점검에서 제외됩니다.</p>
    <div class="driver-master-actions"><button type="submit" class="button primary" data-master-save>저장</button><button type="button" class="button subtle" data-master-cancel>취소</button></div></form>`;
}

type Node = { innerHTML: string; textContent: string; value?: string; addEventListener(type: string, listener: (event: any) => void): void; querySelector?(selector: string): Node | null };

export function mountDriverMaster({ element, client, assignedVehicles = () => [], refreshAssignments = async () => undefined }: {
  element: { querySelector(selector: string): Node | null }; client: DriverProfileClient; assignedVehicles?: (username: string) => string[];
  /** Reads the vehicle assignments again so that the list shows who drives which vehicle now. A failure only leaves the column empty. */
  refreshAssignments?: () => Promise<unknown>;
}) {
  const root = element.querySelector('[data-driver-master]')!;
  const list = element.querySelector('[data-master-list]')!;
  const host = element.querySelector('[data-master-form-host]')!;
  const message = element.querySelector('[data-master-message]')!;
  let editing: string | null = null;
  let state: 'loading' | 'ready' | 'error' = 'loading';
  let busy = false;
  let destroyed = false;

  const rows = (): DriverRow[] => client.snapshot?.drivers ?? [];
  function render(): void {
    if (state === 'loading') { list.innerHTML = '<p class="muted">기사 기준정보를 불러오고 있습니다.</p>'; host.innerHTML = ''; return; }
    if (state === 'error') { list.innerHTML = '<button type="button" class="button subtle" data-master-reload>다시 불러오기</button>'; host.innerHTML = ''; return; }
    list.innerHTML = listHtml(rows(), assignedVehicles, editing);
    const row = rows().find(item => item.username === editing);
    host.innerHTML = row ? formHtml(row) : '';
  }
  async function load(): Promise<void> {
    state = 'loading'; message.textContent = ''; render();
    try {
      const [master] = await Promise.allSettled([client.load(), refreshAssignments().catch(() => undefined)]);
      if (master.status === 'rejected') throw master.reason;
      state = 'ready';
    } catch (cause) {
      state = 'error';
      message.textContent = cause instanceof Error ? cause.message : '기사 기준정보를 불러오지 못했습니다.';
    }
    if (!destroyed) render();
  }
  async function save(username: string, values: Values): Promise<void> {
    if (busy) return;
    const parsed = profileFromValues(values);
    if ('error' in parsed) { message.textContent = parsed.error; return; }
    const had = rows().find(item => item.username === username);
    busy = true; message.textContent = '저장하고 있습니다.';
    try {
      if (isEmptyProfile(parsed.profile) && had && !isEmptyProfile(had)) await client.save(username, null);
      else if (!isEmptyProfile(parsed.profile)) await client.save(username, parsed.profile);
      editing = null;
      message.textContent = '저장했습니다.';
    } catch (cause) {
      message.textContent = cause instanceof ProfileError || cause instanceof Error ? cause.message : '저장하지 못했습니다.';
      if (cause instanceof ProfileError && cause.conflict) editing = null;
    } finally { busy = false; if (!destroyed) render(); }
  }

  root.addEventListener('click', (event: { target: { closest(selector: string): { dataset: Record<string, string> } | null } }) => {
    const edit = event.target.closest('[data-master-edit]');
    if (edit) { editing = edit.dataset.masterEdit ?? null; message.textContent = ''; render(); return; }
    if (event.target.closest('[data-master-cancel]')) { editing = null; message.textContent = ''; render(); return; }
    if (event.target.closest('[data-master-reload]')) void load();
  });
  root.addEventListener('submit', (event: { preventDefault(): void; target: { dataset: Record<string, string>; querySelector(selector: string): { value: string } | null } }) => {
    event.preventDefault();
    const username = event.target.dataset.masterForm;
    if (!username) return;
    const values: Values = {};
    for (const name of [...TEXT_FIELDS.map(([key]) => key), ...CAPA.map(([key]) => `capa-${key}`)]) values[name] = event.target.querySelector(`[name="${name}"]`)?.value ?? '';
    void save(username, values);
  });

  void load();
  return { reload: load, destroy(): void { destroyed = true; } };
}
