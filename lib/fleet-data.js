'use strict';

const LIVE_BOXES = [8, 7, 8, 6, 10, 7, 8, 6];

function makeFleetData(liveVehicle) {
  const vehicles = [{
    ...liveVehicle,
    status: '출고 준비',
    planned: { stops: 8, boxes: 60 },
    capacityBoxes: 60,
  }];
  const deliveries = [];

  for (let number = 2; number <= 130; number++) {
    const vehicleId = `V${number}`;
    const padded = String(number).padStart(3, '0');
    const vehicle = {
      id: vehicleId,
      plate: `예시 차량 ${padded}`,
      driver: `예시 배송원 ${padded}`,
      region: '권역 데이터 대기',
      live: false,
      status: '배차 예시',
      planned: { stops: 3, boxes: 60 },
      capacityBoxes: 60,
    };
    vehicles.push(vehicle);
    for (let sequence = 1; sequence <= 3; sequence++) {
      deliveries.push({
        id: `${vehicleId}-S${sequence}`,
        vehicleId,
        sequence,
        name: `예시 배송지 ${padded}-${sequence}`,
        address: '위치 데이터 대기',
        boxes: 20,
        eta: null,
        status: 'pending',
        ordered: true,
        items: [],
      });
    }
  }

  return { vehicles, deliveries };
}

module.exports = { LIVE_BOXES, makeFleetData };
