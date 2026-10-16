import { agoText, clockText, overviewRows, rangeText, type LatestRow, type OverviewRow } from './temperature-model.ts';
import { TemperatureError, type TemperatureClient } from './temperature-client.ts';

// "온도 현황": the dialog that lists every vehicle's latest value, the ones to look at first on top.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

type Vehicle = { id: string; plate?: string; driver?: string };
type Node = {
  innerHTML: string; open?: boolean; disabled?: boolean;
  addEventListener(type: string, listener: (event: any) => void): void; showModal?(): void; close?(): void; focus?(): void;
};
type Finder = { querySelector(selector: string): Node | null };

export function temperatureOverviewMarkup(): string {
  return '<dialog class="temperature-dialog" data-temp-dialog aria-labelledby="temperature-title">'
    + '<div class="support-heading"><h2 id="temperature-title">온도 현황</h2><button type="button" class="button" data-temp-close aria-label="온도 현황 닫기">닫기</button></div>'
    + '<p class="muted">지금 수신된 값입니다. 선택한 날짜와 관계없이 30초마다 다시 읽습니다. 범위 밖과 미수신 차량이 위에 옵니다.</p>'
    + '<div class="temperature-data" data-temp-data aria-live="polite"></div></dialog>';
}

export const overviewTable = (rows: OverviewRow[]): string => `<div class="support-table-scroll"><table class="temperature-table"><thead><tr><th>차량</th><th>현재값</th><th>상태</th><th>마지막 수신</th><th>허용 범위</th></tr></thead><tbody>${rows.map(row => {
  const name = row.vehicle?.driver || row.vehicle?.plate || row.vehicleId;
  const latest = row.latest;
  return `<tr data-temp-kind="${row.view.kind}"><th scope="row"><button type="button" class="temperature-vehicle" data-temp-vehicle="${esc(row.vehicleId)}">${esc(name)}</button></th>`
    + `<td>${esc(latest ? row.view.valueText : '-')}${row.sensors > 1 ? `<small>센서 ${row.sensors}개 중 가장 주의할 값</small>` : ''}</td>`
    + `<td><span class="badge ${row.view.tone}">${esc(row.view.label)}</span></td>`
    + `<td>${latest ? `${esc(clockText(latest.measuredAt))}<small>${esc(agoText(latest.ageSeconds))}</small>` : '-'}</td>`
    + `<td>${esc(latest ? rangeText(latest.range) : '-')}</td></tr>`;
}).join('')}</tbody></table></div>`;

export function mountTemperatureOverview({ element, client, onSelectVehicle, pollMs = 30_000 }: {
  element: Finder; client: Pick<TemperatureClient, 'latest'>; onSelectVehicle(vehicleId: string): void; pollMs?: number;
}) {
  const dialog = element.querySelector('[data-temp-dialog]')!;
  const body = element.querySelector('[data-temp-data]')!;
  const opener = element.querySelector('[data-control-temperature]')!;
  const closer = element.querySelector('[data-temp-close]')!;
  let fleet: Vehicle[] = [];
  let latest: LatestRow[] | null = null;
  let error = '';
  let loading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let controller: AbortController | undefined;
  let destroyed = false;
  let halted = false;

  function render(): void {
    if (error) {
      body.innerHTML = `<p class="temperature-error" role="alert">${esc(error)}</p><button type="button" class="button" data-temp-retry>다시 불러오기</button>`;
    } else if (!latest) {
      body.innerHTML = `<p class="muted">${loading ? '온도를 불러오고 있습니다.' : '온도를 확인하지 못했습니다.'}</p>`;
    } else {
      const rows = overviewRows(fleet, latest);
      body.innerHTML = rows.length ? overviewTable(rows) : '<p class="muted">등록된 차량이 없습니다.</p>';
    }
  }

  async function load(): Promise<void> {
    clearTimeout(timer);
    controller?.abort();
    const mine = ++epoch;
    controller = new AbortController();
    loading = true;
    if (!latest) render();
    try {
      const rows = await client.latest(controller.signal);
      if (mine !== epoch) return;
      latest = rows; error = ''; halted = false;
    } catch (cause) {
      if (mine !== epoch) return;
      // An older list is never shown as current: a failure replaces it with the reason.
      latest = null; error = cause instanceof Error ? cause.message : '온도를 불러오지 못했습니다.';
      halted = cause instanceof TemperatureError && cause.unavailable;
    } finally {
      if (mine === epoch) { loading = false; render(); }
    }
    if (mine === epoch && dialog.open && !destroyed && !halted) timer = setTimeout(() => void load(), pollMs);
  }

  opener.addEventListener('click', () => { if (destroyed) return; dialog.showModal?.(); void load(); });
  closer.addEventListener('click', () => dialog.close?.());
  dialog.addEventListener('close', () => { epoch += 1; controller?.abort(); clearTimeout(timer); loading = false; opener.focus?.(); });
  body.addEventListener('click', (event: { target: { closest(selector: string): { dataset: Record<string, string> } | null } }) => {
    if (event.target.closest('[data-temp-retry]')) { void load(); return; }
    const button = event.target.closest('[data-temp-vehicle]');
    if (!button) return;
    dialog.close?.();
    onSelectVehicle(button.dataset.tempVehicle!);
  });

  return {
    /** The vehicles of the selected day, for the names; the list itself comes from the server. */
    update(vehicles: Vehicle[]): void { fleet = vehicles; if (latest && dialog.open) render(); },
    setEnabled(enabled: boolean): void { opener.disabled = !enabled; },
    destroy(): void { destroyed = true; epoch += 1; controller?.abort(); clearTimeout(timer); if (dialog.open) dialog.close?.(); },
  };
}
