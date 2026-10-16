import { buildGraph, graphSvg, nearestPoint, statsText, type Graph, type Range } from './temperature-graph.ts';
import { TemperatureError, type TemperatureClient, type TemperatureHistory, dayWindow } from './temperature-client.ts';
import { clockText, formatCelsius, temperatureView, type TemperatureReading } from './temperature-model.ts';

// The "온도" tab of the selected vehicle: the current value and the readings of the selected day as a line graph.

const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

type Vehicle = { id: string; plate?: string; driver?: string };
type Line = { setAttribute(name: string, value: string): void; hidden?: boolean };
type Svg = { querySelector?(selector: string): Line | null };
type Node = {
  innerHTML: string; textContent: string; hidden?: boolean;
  addEventListener(type: string, listener: (event: any) => void): void;
  getBoundingClientRect?(): { left: number; width: number };
  querySelector?(selector: string): Svg | null;
};
type Finder = { querySelector(selector: string): Node | null };

export function temperaturePanelMarkup(): string {
  return '<div class="temperature-panel" data-temp-panel>'
    + '<div class="temperature-now" data-temp-now></div>'
    + '<div class="temperature-chart" data-temp-chart tabindex="0" aria-label="온도 그래프. 좌우 방향키로 값을 읽을 수 있습니다."></div>'
    + '<p class="temperature-tip" data-temp-tip role="status"></p>'
    + '<p class="temperature-stats" data-temp-stats></p>'
    + '<p class="temperature-note muted" data-temp-note></p></div>';
}

export function mountTemperaturePanel({ element, client, isActive = () => true, pollMs = 60_000, now = () => Date.now() }: {
  element: Finder; client: Pick<TemperatureClient, 'history' | 'latest'>; isActive?: () => boolean; pollMs?: number; now?: () => number;
}) {
  const nowBox = element.querySelector('[data-temp-now]')!;
  const chart = element.querySelector('[data-temp-chart]')!;
  const tip = element.querySelector('[data-temp-tip]')!;
  const statsBox = element.querySelector('[data-temp-stats]')!;
  const note = element.querySelector('[data-temp-note]')!;
  let vehicle: Vehicle | null = null;
  let date = '';
  let today = '';
  let reading: TemperatureReading | null = null;
  let graph: Graph | null = null;
  let loading = false;
  let error = '';
  let wasActive = false;
  let epoch = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let halted = false;
  let cursor = -1;

  const title = (): string => `${vehicle?.driver || vehicle?.plate || vehicle?.id || '차량'} ${date} 온도: ${statsText(graph?.stats ?? null)}`;

  function renderNow(): void {
    if (!vehicle) { nowBox.innerHTML = '<p class="muted">차량을 선택하면 온도를 보여 줍니다.</p>'; return; }
    if (date !== today) {
      nowBox.innerHTML = '<p class="muted">현재값은 오늘 날짜에만 표시됩니다. 아래는 선택한 날짜의 이력입니다.</p>';
      return;
    }
    const view = temperatureView(reading);
    nowBox.innerHTML = reading
      ? `<span class="badge ${view.tone}">${esc(view.label)}</span> <strong>${esc(view.valueText)}</strong> <span class="muted">마지막 수신 ${esc(clockText(reading.measuredAt))}</span>`
      : '<span class="badge neutral">정보 없음</span> <span class="muted">오늘 이 차량이 보낸 온도가 없습니다.</span>';
  }

  function render(): void {
    renderNow();
    if (!vehicle) { chart.innerHTML = ''; statsBox.textContent = ''; note.textContent = ''; return; }
    if (error) {
      chart.innerHTML = `<p class="temperature-error" role="alert">${esc(error)}</p><button type="button" class="button" data-temp-retry>다시 불러오기</button>`;
      statsBox.textContent = ''; note.textContent = '';
      return;
    }
    if (!graph) {
      chart.innerHTML = `<p class="muted">${loading ? '온도 이력을 불러오고 있습니다.' : '온도 이력을 확인하지 못했습니다.'}</p>`;
      statsBox.textContent = ''; note.textContent = '';
      return;
    }
    chart.innerHTML = graph.stats ? graphSvg(graph, title()) : '<p class="muted">이 날짜에 수신된 온도가 없습니다.</p>';
    statsBox.textContent = statsText(graph.stats);
    note.textContent = [
      graph.stats ? '1분 평균 선과 최저·최고 띠입니다. 5분 넘게 받지 못한 구간은 이어 그리지 않고 비워 둡니다.' : '',
      graph.decimated ? '점이 많아 일부를 건너뛰어 그렸습니다.' : '',
      date === today ? '오늘 값은 60초마다 다시 읽습니다.' : '',
    ].filter(Boolean).join(' ');
  }

  async function load(): Promise<void> {
    clearTimeout(timer);
    controller?.abort();
    if (!vehicle || !date) { render(); return; }
    const mine = ++epoch;
    const target = vehicle;
    controller = new AbortController();
    loading = true;
    if (!graph) render();
    try {
      const at = now();
      const [history, ranges] = await Promise.all([
        client.history(target.id, date, controller.signal, at),
        client.latest(controller.signal).then(rows => rows.filter(row => row.vehicleId === target.id).map((row): Range => row.range ?? { min: null, max: null }), () => [] as Range[]),
      ]);
      if (mine !== epoch) return;
      const window = dayWindow(date, at);
      graph = buildGraph({ measurements: history.measurements, from: window.from, to: window.to, ranges });
      error = ''; halted = false; cursor = -1; tip.textContent = '';
      noteTruncated(history);
    } catch (cause) {
      if (mine !== epoch) return;
      graph = null;
      error = cause instanceof Error ? cause.message : '온도 이력을 불러오지 못했습니다.';
      halted = cause instanceof TemperatureError && cause.unavailable;
    } finally {
      if (mine === epoch) { loading = false; render(); }
    }
    if (mine === epoch && date === today && isActive() && !halted) timer = setTimeout(() => void load(), pollMs);
  }

  function noteTruncated(history: TemperatureHistory): void {
    if (history.truncated && graph) graph.decimated = true;
  }

  function show(point: { x: number; celsius: number; t: number; sensorId: string } | null, svg: Svg | null): void {
    const line = svg?.querySelector?.('[data-temp-cursor]');
    if (!point || !line) { tip.textContent = ''; return; }
    line.setAttribute('x1', String(point.x)); line.setAttribute('x2', String(point.x)); line.hidden = false;
    tip.textContent = `${clockText(new Date(point.t).toISOString())} ${formatCelsius(point.celsius)} (센서 ${point.sensorId})`;
  }

  chart.addEventListener('click', (event: { target: { closest(selector: string): unknown } }) => {
    if (event.target.closest('[data-temp-retry]')) void load();
  });
  chart.addEventListener('pointermove', (event: { clientX: number; currentTarget?: Node }) => {
    if (!graph) return;
    const box = chart.getBoundingClientRect?.();
    if (!box || !box.width) return;
    show(nearestPoint(graph, ((event.clientX - box.left) / box.width) * graph.width), chart.querySelector?.('svg') ?? null);
  });
  chart.addEventListener('keydown', (event: { key: string; preventDefault(): void }) => {
    if (!graph?.points.length || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    cursor = Math.min(graph.points.length - 1, Math.max(0, (cursor < 0 ? graph.points.length - 1 : cursor) + (event.key === 'ArrowRight' ? 1 : -1)));
    show(graph.points[cursor]!, chart.querySelector?.('svg') ?? null);
  });

  render();
  return {
    /** Called with every state of the control screen: the reading changes often, the graph only when the choice changes. */
    update(next: { date: string; today: string; vehicle: Vehicle | null; reading: TemperatureReading | null }): void {
      const changed = next.vehicle?.id !== vehicle?.id || next.date !== date;
      vehicle = next.vehicle; date = next.date; today = next.today; reading = next.reading;
      const active = isActive();
      renderNow();
      if (changed) { graph = null; error = ''; halted = false; }
      if (active && (changed || !wasActive)) void load();
      else if (!active) { clearTimeout(timer); epoch += 1; controller?.abort(); }
      if (changed && !active) render();
      wasActive = active;
    },
    clear(): void { vehicle = null; date = ''; reading = null; graph = null; error = ''; epoch += 1; controller?.abort(); clearTimeout(timer); wasActive = false; render(); },
    destroy(): void { epoch += 1; controller?.abort(); clearTimeout(timer); },
  };
}
