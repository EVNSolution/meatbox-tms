'use strict';

// Synthetic load input, not a production importer or a business capacity limit.
function capacityFixture({ vehicles = 130, stopsPerVehicle = 35, boxesPerVehicle = 70 } = {}) {
  for (const value of [vehicles, stopsPerVehicle]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Load counts must be positive integers');
  }
  if (!Number.isSafeInteger(boxesPerVehicle) || boxesPerVehicle < 0) throw new TypeError('Boxes must be a non-negative integer');
  const fleet = { vehicles: [], deliveries: [] };
  for (let v = 1; v <= vehicles; v++) {
    const id = `load-vehicle-${v}`;
    fleet.vehicles.push({ id, plate: `서울87바 ${1000 + v}`, driver: `예시 배송원 ${v}`, region: '부하 검증 예시', live: false, status: '배차 예시', planned: { stops: stopsPerVehicle, boxes: boxesPerVehicle }, capacityBoxes: null });
    for (let stop = 1; stop <= stopsPerVehicle; stop++) {
      fleet.deliveries.push({
        id: `load-stop-${v}-${stop}`, vehicleId: id, sequence: stop,
        name: `부하 검증 매장 ${v}-${stop}`, address: `서울 송파구 부하 검증용 주소 ${v}-${stop}`,
        boxes: Math.floor(boxesPerVehicle / stopsPerVehicle) + (stop <= boxesPerVehicle % stopsPerVehicle ? 1 : 0),
        eta: null, status: 'pending', ordered: true, tip: null,
        items: [{ name: '부하 검증 상품 1', qty: 1 }, { name: '부하 검증 상품 2', qty: 1 }],
      });
    }
  }
  return { phase: 'idle', simClock: '06:30', order: [], customers: {}, fleet, vehicles: fleet.vehicles, kpi: {}, events: [], notifications: [] };
}
module.exports = { capacityFixture };
