# 배송원 앱 ↔ 서버 이벤트와 미트박스 연동 계약 (초안)

미트박스와 합의하지 않은 **우리 측 제안**이다. 합의되면 이 문서를 계약으로 승격하고 [마스터 계획서](master-plan.md)의 트랙 B 상태를 올린다.
현행 코드의 운행 명령([API 참조](api-reference.md))은 운영 웹 기준이며, 아래 앱 이벤트는 그 명령을 대체하는 목표 계약이다. 아래 JSON은 구조 설명용 가상 값이다.

## 1. 공통 규칙

| 규칙 | 내용 |
| --- | --- |
| 작업 식별자 | 앱이 이벤트마다 UUID `eventId`를 만든다. 서버는 `(vehicleId, eventId)`가 같은 요청을 다시 받으면 처음 응답을 그대로 돌려준다. 두 번 반영하지 않는다 |
| 시각 | `occurredAt`은 단말 시각, `receivedAt`은 서버 시각. ISO 8601, 오프셋 포함 (`2026-11-02T09:12:03+09:00`) |
| 재시도 | 네트워크 오류·`5xx`·`429`는 5초 → 15초 → 45초 → 2분 → 5분 간격으로 무기한 재시도. 미전송 기록은 지우지 않는다 |
| 중단 | `400`·`401`·`403`·`413`은 재시도하지 않고 앱에 표시. `409`는 서버 상태를 다시 읽고 사용자 판단 |
| 오류 형식 | RFC 9457 `application/problem+json`. `type`, `title`, `status`, `detail`, `code`. 내부 경로·예외 전문은 넣지 않는다 |
| 사진 | 이벤트와 분리해 먼저 올린다. `POST /api/driver/photos`가 `photoId`를 돌려주고 이벤트는 `photoIds`로 참조. 사진별 전송 상태를 앱이 따로 관리한다 |
| 전송 순서 | 앱은 저장 순서대로 보낸다. 서버는 `occurredAt`으로 정렬하지 않고 받은 순서로 반영하되, 같은 배송지의 완료 뒤 도착 같은 역행은 `409`로 거절한다 |
| 식별자 | `orderId` 미트박스 주문번호. `stopId` 배송지 묶음. `vehicleId` 차량. `driverId` 기사 계정. 표시 이름으로 연결하지 않는다 |

오류 예:

```json
{
  "type": "https://tms.example/problems/stop-state",
  "title": "Stop already completed",
  "status": 409,
  "detail": "stop S-104 was completed at 2026-11-02T10:41:00+09:00",
  "code": "STOP_ALREADY_COMPLETED"
}
```

## 2. 앱 → 서버 이벤트

`POST /api/driver/events`. 본문 하나에 이벤트 하나. 응답 `202`에 반영 결과와 다음 배송지를 돌려준다.

공통 봉투:

```json
{
  "eventId": "6f1c0e3a-...",
  "type": "stop_completed",
  "occurredAt": "2026-11-02T10:41:00+09:00",
  "date": "2026-11-02",
  "vehicleId": "V-021",
  "location": { "lat": 37.5012, "lng": 127.0396, "accuracyM": 8 },
  "payload": {}
}
```

| `type` | 뜻 | `payload` | 미트박스로 나가는 상태 |
| --- | --- | --- | --- |
| `departed` | 상차 완료 후 출발 | `{ "stopOrder": ["S-101","S-102"] }` | `departed` + 전체 ETA |
| `zone_entered` | 배송 권역 진입 | `{ "zoneId": "Z-07" }` | ETA 재산출 |
| `stop_completed` | 배송 완료 | `{ "stopId", "orderIds": [], "photoIds": [], "note": "", "scannedCodes": [] }` | `delivered` |
| `stop_failed` | 미배송 | `{ "stopId", "orderIds": [], "reasonCode", "note": "", "photoIds": [] }` | `failed` |
| `stop_partially_completed` | 부분 완료 | `{ "stopId", "orderId", "items": [{ "sku", "deliveredQty", "orderedQty" }], "photoIds": [], "note": "" }` | `partially_delivered` |
| `route_reordered` | 출발 전 순서 변경 | `{ "stopOrder": ["S-102","S-101"], "expectedRevision": 8 }` | 없음. 출발 후에는 `409` |

`reasonCode`는 운영이 정하는 코드표다. 초안: `ABSENT`, `ACCESS_DENIED`, `ADDRESS_MISMATCH`, `REFUSED`, `NO_STORAGE`, `OTHER`.

위치는 이벤트가 아니다. `POST /api/driver/locations`에 30초 수집분을 1분마다 배열로 보낸다.

```json
{ "vehicleId": "V-021", "samples": [{ "at": "2026-11-02T10:40:00+09:00", "lat": 37.50, "lng": 127.03, "accuracyM": 12 }] }
```

응답 예:

```json
{
  "accepted": true,
  "duplicate": false,
  "receivedAt": "2026-11-02T10:41:02+09:00",
  "stop": { "stopId": "S-104", "status": "done" },
  "next": { "stopId": "S-105", "eta": "2026-11-02T11:05:00+09:00" }
}
```

## 3. 서버 → 미트박스 송신 3종

미트박스가 받을 끝점이다. 경로는 미트박스 쪽에서 정하고, 본문은 아래를 제안한다.

공통: `Idempotency-Key: <messageId>` 헤더. 응답 `2xx`면 전달 완료. `5xx`·시간 초과는 공통 규칙과 같은 간격으로 재시도. 인증은 미트박스 발급 Bearer 토큰, 송신 IP는 우리 TEST·운영 고정 IP.

### 3.1 배송 상태

주문 단위로 보낸다. 묶음 배송지 하나가 완료되면 주문 수만큼 보낸다.

```json
{
  "messageId": "m-2026-11-02-000871",
  "orderId": "MB-20261102-48213",
  "status": "delivered",
  "occurredAt": "2026-11-02T10:41:00+09:00",
  "vehicleId": "V-021",
  "photos": ["https://tms.example/photos/p-91ac?token=..."],
  "note": "문 앞 아이스박스",
  "items": [{ "sku": "PK-001", "orderedQty": 3, "deliveredQty": 3 }],
  "failure": null
}
```

| `status` | 발생 시점 |
| --- | --- |
| `dispatched` | 운영이 배차 확정 |
| `departed` | 기사 출발 |
| `arriving` | 이 주문이 다음 배송지가 됨 |
| `delivered` | 완료 |
| `partially_delivered` | 부분 완료. `items`에 수량 |
| `failed` | 미배송. `failure: { "reasonCode", "note" }` |

사진 URL은 서명된 링크이며 유효기간이 있다. 미트박스가 장기 보관하려면 수신 즉시 복사한다.

### 3.2 ETA

차량 단위, 출발 시와 재산출 때마다 전체를 다시 보낸다. 부분 갱신은 없다.

```json
{
  "messageId": "m-2026-11-02-000872",
  "vehicleId": "V-021",
  "computedAt": "2026-11-02T09:12:10+09:00",
  "reason": "departed",
  "stops": [
    { "sequence": 1, "orderIds": ["MB-20261102-48213"], "eta": "2026-11-02T09:40:00+09:00" },
    { "sequence": 2, "orderIds": ["MB-20261102-48220", "MB-20261102-48221"], "eta": "2026-11-02T09:58:00+09:00" }
  ]
}
```

`reason`은 `departed`, `zone_entered`, `reordered`, `delayed`, `completed` 중 하나.

### 3.3 온도

차량 단위, 1분 묶음. 단말 미수신 구간은 보내지 않고 `gap: true`로 표시하지 않는다. 없는 건 없는 것이다.

```json
{
  "messageId": "m-2026-11-02-000873",
  "vehicleId": "V-021",
  "sensorId": "STEGO-7731",
  "measurements": [
    { "measuredAt": "2026-11-02T09:12:00+09:00", "celsius": -18.4 },
    { "measuredAt": "2026-11-02T09:12:30+09:00", "celsius": -18.1 }
  ]
}
```

## 4. 미트박스 → 서버 주문 수신

미트박스가 주문을 밀어 넣는 방식을 제안한다. 당기는 방식이면 같은 본문을 조회 응답으로 쓴다.

`POST /api/meatbox/orders`, `Idempotency-Key: <orderId>:<version>`. 취소·변경은 `version`을 올려 같은 끝점으로 다시 보낸다.

```json
{
  "orderId": "MB-20261102-48213",
  "version": 1,
  "status": "active",
  "deliveryDate": "2026-11-02",
  "deliveryType": "fresh",
  "customer": { "name": "○○정육", "phone": "010-0000-0000" },
  "address": { "road": "서울 강남구 테헤란로 1", "detail": "지하 1층 주방", "lat": null, "lng": null },
  "access": { "entranceCode": "1234*", "placeNote": "뒷문 냉장고 앞" },
  "items": [{ "sku": "PK-001", "name": "삼겹살 1kg", "qty": 3, "boxes": 1, "weightKg": 3.2, "barcode": "8801234567890" }],
  "csNote": "오전 중 배송 요청"
}
```

| 필드 | 쓰는 곳 |
| --- | --- |
| `deliveryType` `fresh` / `parcel` | 배차 화면 필터 (23) |
| `access.*` | 기사 앱 상세 (45), 출입정보 권한 |
| `items[].barcode` | 스캔 대조 (55·56) |
| `address.lat/lng` | 없으면 우리가 정제·좌표화 (7) |
| `status` `active` / `cancelled` | 배차 전이면 제외, 배차 후면 운영 알림 |

## 5. 모의 수신기

미트박스 명세 전까지 PoC는 우리 서버의 `/mock/meatbox/*`가 3장의 본문을 받아 `202`를 돌려주는 것으로 통과시킨다. 첫 송신 구현과 같은 작업 단위에서 만든다. 아직 없다.

## 6. 미트박스에 확인할 것

- 수신 끝점 경로와 인증 방식. Bearer인지, IP 허용인지.
- 주문은 밀어 넣기인지 당기기인지. 취소·변경 전달 방식.
- `status` 값 매핑. 그쪽 고객 화면 상태와 1:1인지.
- 사진은 URL 참조로 충분한지, 파일을 넘겨야 하는지.
- 상차 완료 상태를 누가 만드는지. WMS에서 오는지, 기사 앱에서 찍는지.
- 테스트 환경과 고정 IP 허용.
