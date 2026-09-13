// ETA 엔진 — 남은 구간 이동시간(교통 계수 반영) + 중간 정차지 서비스타임.
// 순수 함수로 유지해 단위 테스트 가능하게 한다.

const BASE_ROAD_FACTOR = 1.25; // OSRM 이상치 보정(도심 신호/혼잡 기본 반영)

/**
 * 특정 정차지 도착까지 남은 초를 계산한다.
 *
 * @param {object} p
 * @param {string} p.targetStopId    도착 시간을 구할 정차지
 * @param {string[]} p.remaining     현재 목적지부터의 배송 순서 (예: ['S3','S5','S6'])
 * @param {string} p.fromId          현재 leg의 출발점 id (MFC 또는 직전 정차지)
 * @param {number} p.legProgress     현재 leg 진행률 0~1 (dwelling 중이면 1)
 * @param {number} p.dwellRemaining  현재 정차 중이면 남은 하차 시간(초), 아니면 0
 * @param {object} p.legs            route-data legs ('A>B' -> {duration,...})
 * @param {number} p.serviceTimeSec  정차지당 하차 서비스타임(초)
 * @param {object} p.legFactors      leg별 교통 계수 ('A>B' -> factor), 없으면 1
 * @param {number} p.globalFactor    잔여 전 구간 공통 혼잡 계수
 * @returns {number} 도착까지 남은 초
 */
function secondsUntilArrival(p) {
  const {
    targetStopId, remaining, fromId, legProgress, dwellRemaining,
    legs, serviceTimeSec, legFactors = {}, globalFactor = 1,
  } = p;

  const legTime = (a, b) => {
    const leg = legs[`${a}>${b}`];
    if (!leg) throw new Error(`unknown leg ${a}>${b}`);
    const f = (legFactors[`${a}>${b}`] || 1) * globalFactor;
    return leg.duration * BASE_ROAD_FACTOR * f;
  };

  let total = dwellRemaining || 0;
  let prev = fromId;
  for (let i = 0; i < remaining.length; i++) {
    const stopId = remaining[i];
    let travel = legTime(prev, stopId);
    if (i === 0) travel *= 1 - legProgress; // 현재 leg는 남은 비율만
    total += travel;
    if (stopId === targetStopId) return total;
    total += serviceTimeSec; // 중간 정차지 하차 시간
    prev = stopId;
  }
  throw new Error(`target ${targetStopId} not in remaining`);
}

/**
 * 도착 예정 시각을 5분 단위로 반올림해 단일 시각으로 만든다.
 * @param {number} arrivalMs 예상 도착 ms
 * @returns {number} 5분 단위로 반올림된 ms
 */
function roundTo5Min(arrivalMs) {
  const FIVE = 5 * 60 * 1000;
  return Math.round(arrivalMs / FIVE) * FIVE;
}

module.exports = { secondsUntilArrival, roundTo5Min, BASE_ROAD_FACTOR };
