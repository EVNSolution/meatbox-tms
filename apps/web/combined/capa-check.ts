import { zoneVolumes } from './zone-volume.mjs';
import type { Capa, DriverRow } from './driver-profile-client.ts';

// 배차 확정 뒤 Capa 점검: per vehicle the stops (착지), boxes and weight of its orders against the largest load of the
// driver who is assigned to it. A figure that is unknown (a weight the orders never carried) is never compared as zero.

type Vehicle = { id: string; plate?: string; driver?: string };
type Order = { vehicleId?: string | null; zoneIds?: string[]; boxes?: number; weightKg?: number | null; [key: string]: unknown };
export type Over = { kind: 'stops' | 'boxes' | 'weightKg'; value: number; limit: number };
export type CapaRow = {
  vehicleId: string; label: string; username: string | null; stops: number; boxes: number | null; weightKg: number | null;
  capa: Capa | null; over: Over[]; weightUnchecked: boolean; zoneId: string | null; zoneLabel: string;
};
export type CapaReport = { overs: CapaRow[]; unset: CapaRow[]; checked: number; weightUnchecked: boolean };

const KINDS: [Over['kind'], string, string][] = [['stops', '착지', '곳'], ['boxes', '박스', '박스'], ['weightKg', '중량', 'kg']];
const hasCapa = (capa: Capa | null): capa is Capa => capa !== null && Object.values(capa).some(value => value !== null);

export function checkCapa({ vehicles, deliveries, regions, assignments, profiles }: {
  vehicles: Vehicle[]; deliveries: Order[]; regions: unknown; assignments: Map<string, string>; profiles: Map<string, DriverRow>;
}): CapaReport {
  const report: CapaReport = { overs: [], unset: [], checked: 0, weightUnchecked: false };
  for (const vehicle of vehicles) {
    const own = deliveries.filter(order => order.vehicleId === vehicle.id);
    if (!own.length) continue;
    const volume = zoneVolumes(regions, own);
    const username = assignments.get(vehicle.id) ?? null;
    const capa = username ? profiles.get(username)?.capa ?? null : null;
    const top = volume.rows[0];
    const row: CapaRow = {
      vehicleId: vehicle.id, label: vehicle.driver || vehicle.plate || vehicle.id, username,
      stops: volume.totals.destinations, boxes: volume.totals.boxes, weightKg: volume.totals.weightKg,
      capa: hasCapa(capa) ? capa : null, over: [], weightUnchecked: false, zoneId: top?.zoneId ?? null, zoneLabel: top?.label ?? '',
    };
    if (!row.capa) { report.unset.push(row); continue; }
    report.checked += 1;
    const figures = { stops: row.stops, boxes: row.boxes, weightKg: row.weightKg };
    for (const [kind] of KINDS) {
      const limit = row.capa[kind];
      if (limit === null) continue;
      const value = figures[kind];
      if (value === null) { if (kind === 'weightKg') { row.weightUnchecked = true; report.weightUnchecked = true; } continue; }
      if (value > limit) row.over.push({ kind, value, limit });
    }
    if (row.over.length) report.overs.push(row);
  }
  return report;
}

export const overText = (over: Over): string => {
  const [, label, unit] = KINDS.find(([kind]) => kind === over.kind)!;
  return `${label} ${over.value.toLocaleString('ko-KR')}${unit} / 최대 ${over.limit.toLocaleString('ko-KR')}${unit}`;
};

export function reportNote(report: CapaReport): string {
  const parts: string[] = [];
  if (report.unset.length) parts.push(`Capa를 설정하지 않은 차량 ${report.unset.length}대는 점검하지 못했습니다(자원 관리의 기사 기준정보에서 설정).`);
  if (report.weightUnchecked) parts.push('중량이 없는 주문이 있어 그 차량의 중량은 비교하지 못했습니다.');
  return parts.join(' ');
}
