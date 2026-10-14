export type DeliveryOrderPositions = Record<string, number>;

const DEFAULT_HYSTERESIS_RATIO = 0.58;

export function createDeliveryOrderPositions(
  orderIds: readonly string[],
): DeliveryOrderPositions {
  return Object.fromEntries(orderIds.map((orderId, index) => [orderId, index]));
}

export function moveDeliveryOrderPosition(
  positions: DeliveryOrderPositions,
  orderId: string,
  requestedIndex: number,
): DeliveryOrderPositions {
  'worklet';

  const sourceIndex = positions[orderId];

  if (sourceIndex === undefined) {
    return positions;
  }

  const lastIndex = Object.keys(positions).length - 1;
  const targetIndex = Math.max(
    0,
    Math.min(lastIndex, Math.trunc(requestedIndex)),
  );

  if (sourceIndex === targetIndex) {
    return positions;
  }

  const movedPositions: DeliveryOrderPositions = {};

  for (const [candidateId, candidateIndex] of Object.entries(positions)) {
    if (candidateId === orderId) {
      movedPositions[candidateId] = targetIndex;
      continue;
    }

    if (
      sourceIndex < targetIndex &&
      candidateIndex > sourceIndex &&
      candidateIndex <= targetIndex
    ) {
      movedPositions[candidateId] = candidateIndex - 1;
      continue;
    }

    if (
      sourceIndex > targetIndex &&
      candidateIndex >= targetIndex &&
      candidateIndex < sourceIndex
    ) {
      movedPositions[candidateId] = candidateIndex + 1;
      continue;
    }

    movedPositions[candidateId] = candidateIndex;
  }

  return movedPositions;
}

export function resolveDeliveryOrderDragTarget(input: {
  absoluteTop: number;
  currentIndex: number;
  rowCount: number;
  rowStep: number;
  hysteresisRatio?: number;
}): number {
  'worklet';

  const {
    absoluteTop,
    currentIndex,
    rowCount,
    rowStep,
    hysteresisRatio = DEFAULT_HYSTERESIS_RATIO,
  } = input;
  const lastIndex = Math.max(0, rowCount - 1);
  let targetIndex = Math.max(0, Math.min(lastIndex, currentIndex));

  while (
    targetIndex < lastIndex &&
    absoluteTop >= (targetIndex + hysteresisRatio) * rowStep
  ) {
    targetIndex += 1;
  }

  while (
    targetIndex > 0 &&
    absoluteTop <= (targetIndex - hysteresisRatio) * rowStep
  ) {
    targetIndex -= 1;
  }

  return targetIndex;
}
