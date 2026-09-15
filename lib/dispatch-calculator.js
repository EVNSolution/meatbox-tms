'use strict';

function invalid(message) {
  throw new TypeError(message);
}

function coordinateOf(order) {
  const coordinates = order?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  return Number.isFinite(longitude) && Number.isFinite(latitude)
    && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90
    ? [longitude, latitude]
    : null;
}

function centroid(points) {
  if (!points.length) return null;
  return points.reduce((sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length], [0, 0]);
}

function compareStable(left, right) {
  return left.index - right.index || left.id.localeCompare(right.id);
}

function balance(units, vehicleIds, assignments) {
  const loads = new Map(vehicleIds.map((id, index) => [id, { id, index, boxes: 0, units: 0 }]));
  const ordered = [...units].sort((left, right) => right.boxes - left.boxes || compareStable(left, right));
  for (const unit of ordered) {
    const target = [...loads.values()].sort((left, right) => left.boxes - right.boxes || left.units - right.units || left.index - right.index)[0];
    for (const orderId of unit.orderIds) assignments[orderId] = target.id;
    target.boxes += unit.boxes;
    target.units += 1;
  }
}

function calculateDispatch({ orders, vehicles, vehicleIds, units } = {}) {
  if (!Array.isArray(orders) || !Array.isArray(vehicles) || !Array.isArray(units)) invalid('주문, 차량, 배송지 묶음을 확인해 주세요.');
  if (!Array.isArray(vehicleIds) || vehicleIds.length === 0 || new Set(vehicleIds).size !== vehicleIds.length) invalid('계산할 차량을 한 대 이상 선택해 주세요.');

  const vehicleById = new Map();
  for (const vehicle of vehicles) {
    if (!vehicle?.id || vehicleById.has(vehicle.id)) invalid('차량 자료를 확인해 주세요.');
    vehicleById.set(vehicle.id, vehicle);
  }
  if (vehicleIds.some(id => !vehicleById.has(id))) invalid('선택한 차량을 차량 자료에서 찾을 수 없습니다.');

  const orderById = new Map();
  for (const [index, order] of orders.entries()) {
    if (!order?.id || orderById.has(order.id) || !Number.isFinite(order.boxes) || order.boxes < 0) invalid('주문 자료를 확인해 주세요.');
    orderById.set(order.id, { ...order, index });
  }

  const covered = new Set();
  const unitIds = new Set();
  const normalizedUnits = units.map((unit, index) => {
    if (!unit?.id || unitIds.has(unit.id) || !Array.isArray(unit.orderIds) || unit.orderIds.length === 0 || new Set(unit.orderIds).size !== unit.orderIds.length) invalid('배송지 묶음을 확인해 주세요.');
    unitIds.add(unit.id);
    const memberOrders = unit.orderIds.map(id => {
      const order = orderById.get(id);
      if (!order || covered.has(id)) invalid('배송지 묶음의 주문을 확인해 주세요.');
      covered.add(id);
      return order;
    });
    return {
      id: unit.id,
      index,
      orderIds: [...unit.orderIds],
      boxes: memberOrders.reduce((sum, order) => sum + order.boxes, 0),
      coordinate: centroid(memberOrders.map(coordinateOf).filter(Boolean)),
    };
  });
  if (covered.size !== orderById.size) invalid('모든 주문이 하나의 배송지 묶음에 포함되어야 합니다.');

  const vehicleOrder = new Map(vehicleIds.map((id, index) => [id, index]));
  const vehicleCentroids = new Map(vehicleIds.map(id => [id, centroid(orders
    .filter(order => order.groupId === id)
    .map(coordinateOf)
    .filter(Boolean))]));
  const assignments = {};

  function assign(unitList, selectedIds) {
    if (!unitList.length) return;
    if (selectedIds.length === 1) {
      for (const unit of unitList) for (const orderId of unit.orderIds) assignments[orderId] = selectedIds[0];
      return;
    }
    if (unitList.length === 1) {
      const point = unitList[0].coordinate;
      const target = point && selectedIds
        .map(id => ({ id, point: vehicleCentroids.get(id), index: vehicleOrder.get(id) }))
        .filter(item => item.point)
        .sort((left, right) => {
          const distance = item => (item.point[0] - point[0]) ** 2 + (item.point[1] - point[1]) ** 2;
          return distance(left) - distance(right) || left.index - right.index;
        })[0]?.id;
      for (const orderId of unitList[0].orderIds) assignments[orderId] = target ?? selectedIds[0];
      return;
    }

    const located = unitList.filter(unit => unit.coordinate);
    if (located.length < 2) {
      balance(unitList, selectedIds, assignments);
      return;
    }
    const meanLatitude = located.reduce((sum, unit) => sum + unit.coordinate[1], 0) / located.length;
    const xScale = Math.cos(meanLatitude * Math.PI / 180);
    const value = (point, axis) => axis === 0 ? point[0] * xScale : point[1];
    const ranges = [0, 1].map(axis => {
      const values = located.map(unit => value(unit.coordinate, axis));
      return Math.max(...values) - Math.min(...values);
    });
    const axis = ranges[0] >= ranges[1] ? 0 : 1;
    if (ranges[axis] === 0) {
      balance(unitList, selectedIds, assignments);
      return;
    }

    const orderedVehicles = [...selectedIds].sort((left, right) => {
      const leftPoint = vehicleCentroids.get(left);
      const rightPoint = vehicleCentroids.get(right);
      if (leftPoint && rightPoint) return value(leftPoint, axis) - value(rightPoint, axis) || vehicleOrder.get(left) - vehicleOrder.get(right);
      if (leftPoint) return -1;
      if (rightPoint) return 1;
      return vehicleOrder.get(left) - vehicleOrder.get(right);
    });
    const leftVehicleCount = Math.floor(orderedVehicles.length / 2);
    const leftIds = orderedVehicles.slice(0, leftVehicleCount);
    const rightIds = orderedVehicles.slice(leftVehicleCount);
    const orderedLocated = [...located].sort((left, right) => value(left.coordinate, axis) - value(right.coordinate, axis) || compareStable(left, right));
    const targetBoxes = orderedLocated.reduce((sum, unit) => sum + unit.boxes, 0) * leftIds.length / orderedVehicles.length;
    let runningBoxes = 0;
    let cut = 1;
    let bestDifference = Infinity;
    for (let index = 1; index < orderedLocated.length; index += 1) {
      runningBoxes += orderedLocated[index - 1].boxes;
      const difference = Math.abs(runningBoxes - targetBoxes);
      if (difference < bestDifference) {
        bestDifference = difference;
        cut = index;
      }
    }
    const leftUnits = orderedLocated.slice(0, cut);
    const rightUnits = orderedLocated.slice(cut);
    let leftBoxes = leftUnits.reduce((sum, unit) => sum + unit.boxes, 0);
    let rightBoxes = rightUnits.reduce((sum, unit) => sum + unit.boxes, 0);
    const missing = unitList.filter(unit => !unit.coordinate).sort((left, right) => right.boxes - left.boxes || compareStable(left, right));
    for (const unit of missing) {
      if (leftBoxes / leftIds.length <= rightBoxes / rightIds.length) {
        leftUnits.push(unit);
        leftBoxes += unit.boxes;
      } else {
        rightUnits.push(unit);
        rightBoxes += unit.boxes;
      }
    }
    assign(leftUnits, leftIds);
    assign(rightUnits, rightIds);
  }

  assign(normalizedUnits, vehicleIds);
  return assignments;
}

module.exports = { calculateDispatch };
