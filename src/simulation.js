// 배송 시뮬레이션 엔진 — 서버가 단일 상태를 소유하고 모든 화면이 구독한다.
const routeData = require('./route-data');
const { secondsUntilArrival, roundTo5Min, BASE_ROAD_FACTOR } = require('./eta');

const MIN = 60 * 1000;
const SERVICE_TIME_SEC = 240;      // 정차지당 하차·검수 4분
const TICK_REAL_MS = 500;
const CUSTOMER_STOP = 'S5';

const STOP_INFO = {
  S1: { boxes: 10, address: '서울 송파구 법원로 128' },
  S2: { boxes: 8,  address: '서울 송파구 충민로 66 가든파이브' },
  S3: { boxes: 9,  address: '서울 송파구 위례성대로 22' },
  S4: { boxes: 7,  address: '서울 송파구 백제고분로 45길 19' },
  S5: { boxes: 12, address: '서울 송파구 석촌호수로 268' },
  S6: { boxes: 8,  address: '서울 강남구 봉은사로 524' },
  S7: { boxes: 9,  address: '서울 강남구 테헤란로 151' },
  S8: { boxes: 7,  address: '서울 강남구 학동로 305' },
};
const DEFAULT_ORDER = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'];

// 관제 차량 목록 — V1만 라이브 시뮬레이션, 나머지는 배차 대기 차량(정적)
const VEHICLES = [
  { id: 'V1', plate: '서울87바 1234', driver: '김민수', region: '송파·강남 4권역', live: true },
  { id: 'V2', plate: '서울85아 5678', driver: '박정호', region: '강동 2권역', live: false, status: '상차 중', planned: { stops: 6, boxes: 54 } },
  { id: 'V3', plate: '인천91바 3456', driver: '이수진', region: '성남·분당 7권역', live: false, status: '배차 대기', planned: { stops: 7, boxes: 61 } },
];

const PREP_STEPS = [
  { key: 'picking',  label: '피킹 중',   simMin: 5 * 60 + 50 },
  { key: 'labeling', label: '라벨 부착', simMin: 6 * 60 + 5 },
  { key: 'staged',   label: '상차 대기', simMin: 6 * 60 + 20 },
  { key: 'departed', label: '배송 출발', simMin: 6 * 60 + 30 },
];

const fmtTime = (ms) => {
  const t = Math.round(ms / MIN);
  const h = Math.floor(t / 60) % 24;
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

class Simulation {
  constructor(broadcast) {
    this.broadcast = broadcast; // (state) => void
    this.timer = null;
    this.reset();
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { console.error('tick error:', e); }
    }, TICK_REAL_MS);
  }

  reset() {
    this.phase = 'idle';                    // idle | preparing | delivering | done
    this.simTime = (5 * 60 + 45) * MIN;     // 05:45
    this.speed = 5;
    this.order = [...DEFAULT_ORDER];
    this.stops = {};
    for (const id of DEFAULT_ORDER) {
      const p = routeData.points.find((x) => x.id === id);
      this.stops[id] = { id, name: p.name, ...STOP_INFO[id], status: 'pending', deliveredAt: null };
    }
    this.prepDone = [];                      // 완료된 출고 전 단계
    this.truck = this.makeIdleTruck();
    this.legFactors = {};
    this.globalFactor = 1;
    this.extraDwellQueued = 0;
    this.incidents = [];
    this.events = [];
    this.notifications = [];
    this.eta = null;
    this.notifiedNearby = false;
    this.logEvent('시나리오 대기 — 가락 MFC 상차 완료 70박스 / 8개 착지', 'system');
    this.recalcEta('초기 산출', { silent: true });
    this.emit();
  }

  makeIdleTruck() {
    const mfc = routeData.points.find((p) => p.id === 'MFC');
    return { lat: mfc.lat, lng: mfc.lng, fromId: 'MFC', toId: null, progress: 0, dwellRemaining: 0, atStopId: 'MFC' };
  }

  // ---------- 조회 헬퍼 ----------
  currentIndex() {
    // order 상에서 아직 완료되지 않은 첫 정차지 index
    return this.order.findIndex((id) => this.stops[id].status !== 'done');
  }

  remainingIds() {
    const i = this.currentIndex();
    return i === -1 ? [] : this.order.slice(i);
  }

  currentLegKey() {
    return this.truck.toId ? `${this.truck.fromId}>${this.truck.toId}` : null;
  }

  // ETA 계산 입력 — 정차(하차) 중이면 현재 정차지는 dwellRemaining으로만 반영하고
  // remaining에서 제외해 자기 자신으로의 구간 조회(S1>S1)를 막는다.
  etaInputs() {
    const remaining = this.remainingIds();
    if (this.truck.atStopId && remaining[0] === this.truck.atStopId) {
      return {
        fromId: this.truck.atStopId,
        remaining: remaining.slice(1),
        legProgress: 0,
        dwellRemaining: this.truck.dwellRemaining + this.extraDwellQueued,
      };
    }
    return {
      fromId: this.truck.fromId,
      remaining,
      legProgress: this.truck.toId ? this.truck.progress : 0,
      dwellRemaining: this.extraDwellQueued,
    };
  }

  legDurationSec(key) {
    const f = (this.legFactors[key] || 1) * this.globalFactor;
    return routeData.legs[key].duration * BASE_ROAD_FACTOR * f;
  }

  // ---------- 이벤트/알림 ----------
  logEvent(message, type = 'info') {
    this.events.push({ ts: this.simTime, time: fmtTime(this.simTime), type, message });
    if (this.events.length > 120) this.events.shift();
  }

  notify(title, body) {
    // 앱 푸시 + 카카오 알림톡 두 채널 동시 발송(데모)
    const base = { id: this.notifications.length + 1, ts: this.simTime, time: fmtTime(this.simTime), title, body };
    this.notifications.push(base);
    this.logEvent(`고객 알림 발송(푸시·알림톡): ${title}`, 'notify');
  }

  // ---------- ETA ----------
  recalcEta(reason, { silent = false, forceNotify = false } = {}) {
    const cust = this.stops[CUSTOMER_STOP];
    if (cust.status === 'done') { this.eta = null; return; }

    const departed = this.phase === 'delivering';
    let seconds;
    if (departed) {
      const inputs = this.etaInputs();
      if (!inputs.remaining.includes(CUSTOMER_STOP)) return; // 고객 정차지 하차 중 — 마지막 ETA 유지
      seconds = secondsUntilArrival({
        targetStopId: CUSTOMER_STOP,
        ...inputs,
        legs: routeData.legs,
        serviceTimeSec: SERVICE_TIME_SEC,
        legFactors: this.legFactors,
        globalFactor: this.globalFactor,
      });
    } else {
      const remaining = [...this.order];
      // 출발 전: 06:30 출발 가정으로 산출
      const departMs = (6 * 60 + 30) * MIN;
      seconds = secondsUntilArrival({
        targetStopId: CUSTOMER_STOP, remaining, fromId: 'MFC', legProgress: 0, dwellRemaining: 0,
        legs: routeData.legs, serviceTimeSec: SERVICE_TIME_SEC,
        legFactors: this.legFactors, globalFactor: this.globalFactor,
      }) + Math.max(0, (departMs - this.simTime) / 1000);
    }

    const arrival = this.simTime + seconds * 1000;
    const time = roundTo5Min(arrival);
    const prev = this.eta;
    const deltaMin = prev ? Math.round((arrival - prev.arrival) / MIN) : 0;

    this.eta = { arrival, time, reason, updatedAt: this.simTime, deltaMin };
    if (!silent && prev) {
      this.logEvent(`ETA 재계산(${reason}): ${fmtTime(time)} 도착 예정 (${deltaMin >= 0 ? '+' : ''}${deltaMin}분)`, 'eta');
      if (Math.abs(deltaMin) >= 10 || forceNotify) {
        this.notify('배송 예정 시간이 변경되었습니다', `새 도착 예정 시간: ${fmtTime(time)} (사유: ${reason})`);
      }
    }
  }

  // ---------- 고객 노출 상태 ----------
  customerStatus() {
    const cust = this.stops[CUSTOMER_STOP];
    if (cust.status === 'done') return { key: 'delivered', label: '배송 완료' };
    if (this.phase === 'delivering') {
      const remaining = this.remainingIds();
      if (remaining.indexOf(CUSTOMER_STOP) === 0) return { key: 'nearby', label: '인근 배송 중' };
      return { key: 'shipping', label: '배송 중' };
    }
    if (this.prepDone.length > 0) {
      const last = this.prepDone[this.prepDone.length - 1];
      return { key: last.key, label: last.label };
    }
    return { key: 'paid', label: '결제 완료' };
  }

  timeline() {
    const cust = this.stops[CUSTOMER_STOP];
    const st = this.customerStatus();
    const prepTime = (key) => {
      const d = this.prepDone.find((s) => s.key === key);
      return d ? fmtTime(d.at) : null;
    };
    const items = [
      { label: '주문 접수', time: '어제 21:38' },
      { label: '결제 완료', time: '어제 21:38' },
      { label: '피킹 중', time: prepTime('picking') },
      { label: '라벨 부착', time: prepTime('labeling') },
      { label: '상차 대기', time: prepTime('staged') },
      { label: '배송 중', time: prepTime('departed') },
      { label: '인근 배송 중', time: st.key === 'nearby' ? fmtTime(this.simTime) : null },
      { label: '배송 완료', time: cust.deliveredAt ? fmtTime(cust.deliveredAt) : null },
    ];
    const stepOrder = ['ordered', 'paid', 'picking', 'labeling', 'staged', 'shipping', 'nearby', 'delivered'];
    const curIdx = stepOrder.indexOf(st.key);
    return items.map((item, i) => ({
      ...item,
      state: i < curIdx ? 'done' : i === curIdx ? 'current' : 'pending',
    }));
  }

  // ---------- 시나리오 제어 ----------
  // 리모컨에서 한 단계씩 수동 진행: 피킹 중 → 라벨 부착 → 상차 대기 → 배송 출발
  advance() {
    if (this.phase === 'delivering' || this.phase === 'done') return;
    const step = PREP_STEPS[this.prepDone.length];
    if (!step) return;
    if (this.phase === 'idle') {
      this.phase = 'preparing';
      this.logEvent('시나리오 시작 — MFC 출고 프로세스 진행', 'system');
    }
    this.simTime = step.simMin * MIN;
    this.prepDone.push({ ...step, at: this.simTime });
    this.logEvent(`구간 스캔: ${step.label}`, 'scan');
    if (step.key === 'departed') {
      this.phase = 'delivering';
      this.beginLeg(this.order[0]);
      this.recalcEta('배송 출발', { silent: true });
      this.notify('배송이 출발했습니다 🚚', `주문하신 상품이 가락 MFC에서 출발했어요. 도착 예정 ${fmtTime(this.eta.time)}`);
    } else {
      this.recalcEta(step.label, { silent: true });
    }
    this.emit();
  }

  setSpeed(v) {
    if (![1, 5, 20].includes(v)) return;
    this.speed = v;
    this.logEvent(`시뮬레이션 배속 변경: ${v}x`, 'system');
  }

  injectTraffic() {
    if (this.phase !== 'delivering') return;
    const key = this.currentLegKey();
    if (key) this.legFactors[key] = 2.5;
    this.globalFactor = 1.4;
    this.incidents.push({ at: this.simTime, label: '탄천대로 3중 추돌 사고' });
    this.logEvent('실시간 교통정보 수신(티맵·네이버): 탄천대로 사고 — 구간 지연 반영', 'incident');
    this.recalcEta('실시간 교통 지연(사고)', { forceNotify: true });
    this.emit();
  }

  injectDwell() {
    if (this.phase !== 'delivering') return;
    const SIX_MIN = 6 * 60;
    if (this.truck.dwellRemaining > 0) this.truck.dwellRemaining += SIX_MIN;
    else this.extraDwellQueued += SIX_MIN;
    this.logEvent('정차 지연 감지: 앞 배송지 하차 지연 +6분', 'incident');
    this.recalcEta('앞 배송지 정차 지연', { forceNotify: true });
    this.emit();
  }

  reorder(stopId, dir) {
    // 기사 앱: 아직 배송 전(현재 목적지 제외)의 정차지만 위/아래로 이동
    const cur = this.currentIndex();
    const idx = this.order.indexOf(stopId);
    if (idx === -1 || this.stops[stopId].status !== 'pending') return;
    const swapWith = dir === 'up' ? idx - 1 : idx + 1;
    if (swapWith <= cur && this.phase === 'delivering') return; // 현재 목적지 위로는 불가
    if (swapWith < 0 || swapWith >= this.order.length) return;
    if (this.stops[this.order[swapWith]].status === 'done') return;
    [this.order[idx], this.order[swapWith]] = [this.order[swapWith], this.order[idx]];
    this.logEvent(`기사 앱: 배송 순서 변경 — ${this.stops[stopId].name} ${dir === 'up' ? '앞으로' : '뒤로'}`, 'driver');
    this.recalcEta('기사 배송 순서 변경', { forceNotify: false });
    this.emit();
  }

  completeCurrentStop() {
    // 기사 앱 하차 완료 스캔 — 남은 하차 시간 건너뜀
    if (this.phase === 'delivering' && this.truck.dwellRemaining > 0) {
      this.truck.dwellRemaining = 0;
      this.finishStop();
      this.emit();
    }
  }

  // ---------- 이동 ----------
  beginLeg(toId) {
    this.truck.fromId = this.truck.atStopId || this.truck.fromId;
    this.truck.toId = toId;
    this.truck.progress = 0;
    this.truck.atStopId = null;
    this.stops[toId].status = 'current';
    const leg = routeData.legs[this.currentLegKey()];
    this.logEvent(`다음 목적지 이동 시작: ${this.stops[toId].name} (${(leg.distance / 1000).toFixed(1)}km)`, 'move');
  }

  arriveAtStop() {
    const id = this.truck.toId;
    this.truck.atStopId = id;
    this.truck.fromId = id;
    this.truck.toId = null;
    this.truck.progress = 0;
    this.truck.dwellRemaining = SERVICE_TIME_SEC + this.extraDwellQueued;
    this.extraDwellQueued = 0;
    const p = routeData.points.find((x) => x.id === id);
    this.truck.lat = p.lat; this.truck.lng = p.lng;
    this.logEvent(`구간 스캔: ${this.stops[id].name} 도착 — 하차 시작`, 'scan');
    if (id === CUSTOMER_STOP) {
      this.notify('기사님이 도착했어요', '주문하신 상품을 문 앞으로 전달 중입니다.');
    }
  }

  finishStop() {
    const id = this.truck.atStopId;
    this.stops[id].status = 'done';
    this.stops[id].deliveredAt = this.simTime;
    this.truck.dwellRemaining = 0;
    this.logEvent(`구간 스캔: ${this.stops[id].name} 배송 완료 (${this.stops[id].boxes}박스)`, 'scan');
    if (id === CUSTOMER_STOP) {
      this.notify('배송이 완료되었습니다 ✅', `${fmtTime(this.simTime)} 문 앞에 상품을 전달했어요. 오늘도 미트박스를 이용해 주셔서 감사합니다.`);
      this.eta = null;
    }
    const next = this.remainingIds()[0];
    if (next) {
      this.beginLeg(next);
      if (next === CUSTOMER_STOP && !this.notifiedNearby) {
        this.notifiedNearby = true;
        this.notify('곧 도착 예정이에요', '고객님 상품이 곧 도착할 예정이에요. 잠시만 기다려 주세요!');
      }
      this.recalcEta('정차지 배송 완료', { silent: false });
    } else {
      this.phase = 'done';
      this.logEvent('금일 배송 전체 완료 — 복귀', 'system');
    }
  }

  tick(manual = false) {
    if (this.phase === 'delivering') {
      const dt = (TICK_REAL_MS / 1000) * this.speed; // 시뮬레이션 초
      this.simTime += dt * 1000;

      if (this.truck.dwellRemaining > 0) {
        this.truck.dwellRemaining -= dt;
        if (this.truck.dwellRemaining <= 0) this.finishStop();
      } else if (this.truck.toId) {
        const key = this.currentLegKey();
        this.truck.progress += dt / this.legDurationSec(key);
        if (this.truck.progress >= 1) {
          this.arriveAtStop();
        } else {
          const pos = interpolate(routeData.legs[key].coords, this.truck.progress);
          this.truck.lat = pos[0]; this.truck.lng = pos[1];
        }
      }

      // 주기적 드리프트 보정: 공식 ETA와 8분 이상 벌어지면 자동 재계산
      if (this.eta && this.stops[CUSTOMER_STOP].status !== 'done') {
        const inputs = this.etaInputs();
        if (inputs.remaining.includes(CUSTOMER_STOP)) {
          const secs = secondsUntilArrival({
            targetStopId: CUSTOMER_STOP, ...inputs,
            legs: routeData.legs, serviceTimeSec: SERVICE_TIME_SEC,
            legFactors: this.legFactors, globalFactor: this.globalFactor,
          });
          const drift = Math.abs(this.simTime + secs * 1000 - this.eta.arrival);
          if (drift > 8 * MIN) this.recalcEta('이동 지연 자동 감지');
        }
      }
    }
    if (!manual) this.emit();
  }

  // ---------- 스냅샷 ----------
  snapshot() {
    const currentLeg = this.currentLegKey();
    const leg = currentLeg ? routeData.legs[currentLeg] : null;
    return {
      phase: this.phase,
      simTime: this.simTime,
      simClock: fmtTime(this.simTime),
      speed: this.speed,
      customerStopId: CUSTOMER_STOP,
      truck: {
        lat: this.truck.lat, lng: this.truck.lng,
        fromId: this.truck.fromId, toId: this.truck.toId,
        progress: this.truck.progress,
        dwelling: this.truck.dwellRemaining > 0,
        dwellRemaining: Math.max(0, Math.round(this.truck.dwellRemaining)),
        remainingM: leg ? Math.round(leg.distance * (1 - this.truck.progress)) : 0,
      },
      order: this.order.map((id) => ({ ...this.stops[id], deliveredTime: this.stops[id].deliveredAt ? fmtTime(this.stops[id].deliveredAt) : null })),
      customerStatus: this.customerStatus(),
      timeline: this.timeline(),
      eta: this.eta ? {
        time: this.eta.time,
        timeText: fmtTime(this.eta.time),
        reason: this.eta.reason, deltaMin: this.eta.deltaMin,
        updatedAt: this.eta.updatedAt,
      } : null,
      vehicles: VEHICLES,
      nextStep: this.phase === 'idle' || this.phase === 'preparing'
        ? (PREP_STEPS[this.prepDone.length] ? { key: PREP_STEPS[this.prepDone.length].key, label: PREP_STEPS[this.prepDone.length].label } : null)
        : null,
      events: this.events.slice(-40).reverse(),
      notifications: this.notifications,
      incidents: this.incidents,
      kpi: {
        boxesTotal: 70,
        boxesDelivered: this.order.filter((id) => this.stops[id].status === 'done').reduce((s, id) => s + this.stops[id].boxes, 0),
        stopsDone: this.order.filter((id) => this.stops[id].status === 'done').length,
        stopsTotal: this.order.length,
        globalFactor: this.globalFactor,
        etaAccuracy: 82.4, // 최근 30일 ±15분 적중률(데모 고정값)
      },
    };
  }

  emit() { this.broadcast(this.snapshot()); }
}

// polyline 좌표 배열에서 진행률(거리 기준) 위치 보간
function interpolate(coords, progress) {
  if (coords.length < 2) return coords[0];
  const dists = [0];
  for (let i = 1; i < coords.length; i++) {
    dists.push(dists[i - 1] + haversine(coords[i - 1], coords[i]));
  }
  const total = dists[dists.length - 1];
  const target = total * Math.min(1, Math.max(0, progress));
  for (let i = 1; i < coords.length; i++) {
    if (dists[i] >= target) {
      const segLen = dists[i] - dists[i - 1] || 1;
      const f = (target - dists[i - 1]) / segLen;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f,
      ];
    }
  }
  return coords[coords.length - 1];
}

function haversine([lat1, lng1], [lat2, lng2]) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { Simulation, CUSTOMER_STOP, SERVICE_TIME_SEC };
