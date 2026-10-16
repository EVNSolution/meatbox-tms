import { checkCapa, overText, reportNote, type CapaReport } from './capa-check.ts';
import { createDriverProfileClient, type DriverRow } from './driver-profile-client.ts';
import { createDriverAssignmentClient } from './driver-assignment-client.ts';

// 배차 확정 뒤 Capa 초과 배송원: a line under the dispatch workflow and a list popup. The popup opens by itself when this
// session publishes the dispatch and a vehicle is over; a click on a row moves the map to that vehicle's zone.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

export type CapaInputs = { assignments: Map<string, string>; profiles: Map<string, DriverRow> };
export type CapaSources = { load(): Promise<CapaInputs> };

export function createCapaSources(fetchImpl: typeof fetch = fetch): CapaSources {
  const profiles = createDriverProfileClient(fetchImpl);
  const assignments = createDriverAssignmentClient(fetchImpl);
  return {
    async load() {
      const [master, assigned] = await Promise.all([profiles.load(), assignments.load()]);
      return {
        profiles: new Map(master.drivers.map(row => [row.username, row])),
        assignments: new Map(assigned.assignments.map(item => [item.vehicleId, item.driver])),
      };
    },
  };
}

export function capaAlertMarkup(): string {
  return '<div class="capa-alert" data-capa-alert hidden role="status"><span data-capa-text></span> <button type="button" class="button subtle" data-capa-open hidden>초과 배송원 보기</button></div>'
    + '<dialog class="capa-dialog" data-capa-dialog aria-labelledby="capa-title"><h2 id="capa-title">Capa 초과 배송원</h2>'
    + '<p class="muted" data-capa-note></p><ul class="capa-list" data-capa-list></ul>'
    + '<div class="capa-actions"><button type="button" class="button" data-capa-close>닫기</button></div></dialog>';
}

export function overListHtml(report: CapaReport): string {
  return report.overs.map(row => `<li><button type="button" class="capa-row" data-capa-focus="${esc(row.vehicleId)}" data-capa-zone="${esc(row.zoneId ?? '')}"><strong>${esc(row.label)}</strong>`
    + `<span>${row.over.map(over => esc(overText(over))).join(' · ')}</span><small class="muted">${row.zoneLabel ? `${esc(row.zoneLabel)} 권역 중심 · ` : ''}눌러서 지도에서 보기</small></button></li>`).join('');
}

type Node = {
  hidden?: boolean; textContent: string; innerHTML: string; open?: boolean; showModal?(): void; close?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
};
type Order = { vehicleId?: string | null; [key: string]: unknown };

export function mountCapaAlert({ element, sources, onFocus }: {
  element: { querySelector(selector: string): Node | null }; sources: CapaSources; onFocus: (vehicleId: string) => void;
}) {
  const banner = element.querySelector('[data-capa-alert]')!;
  const text = element.querySelector('[data-capa-text]')!;
  const openButton = element.querySelector('[data-capa-open]')!;
  const dialog = element.querySelector('[data-capa-dialog]')!;
  const note = element.querySelector('[data-capa-note]')!;
  const list = element.querySelector('[data-capa-list]')!;
  let inputs: CapaInputs | null = null;
  let loadedKey = '';
  let lastPhase = '';
  let lastDate = '';
  let autoOpen = false;
  let latest: { vehicles: { id: string }[]; deliveries: Order[]; regions: unknown } | null = null;
  let report: CapaReport | null = null;
  let epoch = 0;

  function show(): void {
    if (!inputs || !latest) { banner.hidden = true; return; }
    report = checkCapa({ ...latest, ...inputs, vehicles: latest.vehicles });
    const overs = report.overs.length;
    const extra = reportNote(report);
    banner.hidden = !overs && !extra;
    text.textContent = overs ? `Capa 초과 배송원 ${overs}명이 있습니다. ${extra}` : extra;
    openButton.hidden = !overs;
    list.innerHTML = overListHtml(report);
    note.textContent = extra;
    if (autoOpen && overs && !dialog.open) { autoOpen = false; dialog.showModal?.(); }
    if (!overs && dialog.open) dialog.close?.();
  }

  async function load(key: string): Promise<void> {
    const mine = ++epoch;
    try {
      const next = await sources.load();
      if (mine !== epoch) return;
      inputs = next; loadedKey = key;
    } catch {
      if (mine !== epoch) return;
      // No driver master here (a Node-owned environment or a driver session): nothing to check, nothing to say.
      inputs = null; loadedKey = key;
    }
    show();
  }

  openButton.addEventListener('click', () => { void load(loadedKey).then(() => dialog.showModal?.()); });
  dialog.addEventListener('click', (event: { target: { closest(selector: string): { dataset: Record<string, string> } | null } }) => {
    if (event.target.closest('[data-capa-close]')) { dialog.close?.(); return; }
    const row = event.target.closest('[data-capa-focus]');
    if (!row?.dataset.capaFocus) return;
    dialog.close?.();
    onFocus(row.dataset.capaFocus);
  });

  return {
    update(next: { date: string; phase: string; vehicles: { id: string }[]; deliveries: Order[]; regions: unknown }): void {
      const confirmed = next.phase === 'published' || next.phase === 'amending';
      if (!confirmed) { lastPhase = next.phase; lastDate = next.date; banner.hidden = true; inputs = null; loadedKey = ''; epoch += 1; return; }
      // This session's own publish: the same date went from not confirmed to confirmed.
      if (lastDate === next.date && lastPhase && lastPhase !== next.phase && next.phase === 'published') autoOpen = true;
      lastPhase = next.phase; lastDate = next.date;
      latest = { vehicles: next.vehicles, deliveries: next.deliveries, regions: next.regions };
      const key = `${next.date}|${next.phase}`;
      if (key !== loadedKey) void load(key); else show();
    },
    destroy(): void { epoch += 1; },
  };
}
