import type { VehicleList, VehicleRow } from '../api/driverContracts';

export type VehicleChoice = {
  vehicleId: string;
  title: string;
  subtitle: string | null;
  counts: string;
  phase: string;
};

const PHASE: Record<VehicleRow['phase'], string> = {
  idle: '대기',
  preparing: '준비 중',
  delivering: '배송 중',
  done: '운행 종료',
};

/** The rows of the vehicle choice. Vehicles with stops come first so the driver finds a loaded one at the top. */
export function vehicleChoices(list: VehicleList): VehicleChoice[] {
  const rows = list.vehicles.map((vehicle, index) => ({
    index,
    row: {
      vehicleId: vehicle.vehicleId,
      title: vehicle.label || vehicle.vehicleId,
      subtitle: [vehicle.plate ? `${vehicle.plate} (미검증)` : null, vehicle.region].filter(Boolean).join(' · ') || null,
      counts: `배송지 ${vehicle.stops}곳 · 주문 ${vehicle.orders}건`,
      phase: PHASE[vehicle.phase],
    } satisfies VehicleChoice,
    loaded: vehicle.stops > 0,
  }));
  return rows.sort((left, right) => Number(right.loaded) - Number(left.loaded) || left.index - right.index).map((entry) => entry.row);
}
