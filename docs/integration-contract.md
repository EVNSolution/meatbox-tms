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
| 오류 형식 | RFC 9457 `application/problem+json`. `type`(`about:blank`), `title`, `status`, `detail`, `code`. 앱은 `code`로 분기한다. 웹 호환용 `error`·`message` 필드가 더 올 수 있으며 앱은 무시한다. 내부 경로·예외 전문은 넣지 않는다 |
| 사진 | 이벤트와 분리해 먼저 올린다. `POST /api/driver/photos`가 `photoId`를 돌려주고 이벤트는 `photoIds`로 참조. 사진별 전송 상태를 앱이 따로 관리한다 |
| 전송 순서 | 앱은 저장 순서대로 보낸다. 서버는 `occurredAt`으로 정렬하지 않고 받은 순서로 반영하되, 같은 배송지의 완료 뒤 도착 같은 역행은 `409`로 거절한다 |
| 식별자 | `orderId` 미트박스 주문번호. `stopId` 배송지 묶음. `vehicleId` 차량. `driverId` 기사 계정. 표시 이름으로 연결하지 않는다 |

오류 예:

```json
{
  "type": "about:blank",
  "title": "Stop already completed",
  "status": 409,
  "detail": "stop S-104 was completed at 2026-11-02T10:41:00+09:00",
  "code": "STOP_ALREADY_COMPLETED"
}
```

## 2. 앱 → 서버 이벤트

`POST /api/driver/events`. 본문 하나에 이벤트 하나. 응답 `202`에 반영 결과와 다음 배송지를 돌려준다.

**구현됨(현행 경로).** 이벤트 6종, 위치 배치, 사진 업로드를 서버가 받는다. 현행 경로와 동작은 [API 참조](api-reference.md#기사-앱-끝점-kotlin-api-전용)를 따른다. 이 문서의 상태는 계속 초안이다. 계약과 다른 점:

- 경로 접두사가 `/api/dispatch-data/days/{date}/driver/...`다.
- `eventId`는 UUID가 아니어도 영문·숫자·`-`·`_` 1~64자면 받는다. 멱등 범위는 `(vehicleId, eventId)`가 아니라 날짜 안의 `eventId`다. 본문(차량 포함)이 다르면 `409 REQUEST_ID_MISMATCH`다.
- `next.eta`는 차량이 출발해 ETA를 계산한 뒤에는 그 배송지의 도착 예정 시각이고 출발 전에는 `null`이다. 계산은 3.2의 구현됨 절을 따른다.
- `stop_failed`의 `reasonCode`는 6개 코드 밖이면 `400 INVALID_REASON_CODE`다. 품목(`items`)은 검증하지 않고 기록만 한다.
- `stopId`는 배송지 묶음의 첫 주문 ID다. 앱의 `S-104` 같은 값은 아직 없다.
- `GET events/{eventId}`는 `200`으로 같은 본문을 돌려주고 `duplicate`가 `true`다. 없으면 `404 REQUEST_NOT_FOUND`다.
- 이벤트 하나가 운행 명령 여러 개로 번역되어 날짜 `revision`이 여러 번 오를 수 있다. 응답의 `revision`은 노출하지 않는다.

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
| `zone_entered` | 배송 권역 진입 | `{ "zoneId": "Z-07" }` | ETA 재산출(`reason: zone_entered`). 위치 필수, 권역 밖이면 `422` |
| `stop_completed` | 배송 완료 | `{ "stopId", "orderIds": [], "photoIds": [], "note": "", "scannedCodes": [] }` | `delivered` |
| `stop_failed` | 미배송 | `{ "stopId", "orderIds": [], "reasonCode", "note": "", "photoIds": [] }` | `failed` |
| `stop_partially_completed` | 부분 완료 | `{ "stopId", "orderId", "items": [{ "sku", "deliveredQty", "orderedQty" }], "photoIds": [], "note": "" }` | `partially_delivered` |
| `route_reordered` | 순서 변경(출발 후에는 남은 배송지만) | `{ "stopOrder": ["S-102","S-101"], "expectedRevision": 8 }` | 출발 후에는 ETA 재산출(`reason: reordered`). 완료·현재·보류 배송지를 옮기면 `409` |

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

**구현됨(배송 상태만).** 기사 앱 이벤트·배차 확정이 상태를 바꾸면 같은 체크포인트 쓰기로 송신함(`outbox`)에 메시지를 남기고, 발송기가 `POST {MEATBOX_API_BASE_URL}/tms/delivery-status`로 보낸다([운영](operations.md#미트박스-송신-kotlin-api)). 계약과 다른 점:

- `arriving`은 보내지 않는다. 다음 배송지가 되는 시점을 이번에 정하지 않았다.
- `photos`는 `{PUBLIC_ORIGIN}/api/dispatch-data/days/{date}/driver/photos/{photoId}`다. **서명 토큰이 없고 우리 세션이 필요하다.** 미트박스가 그대로는 받을 수 없다. 서명 URL은 후속이다.
- `messageId`는 `{date}-{revision}-{orderId}`(주문 ID의 `A-Za-z0-9._-` 밖 문자는 `_`)이고 `Idempotency-Key`와 같다. 본문의 `items`는 부분 완료만, `failure`는 미배송만 채우고 나머지는 `null`이다.
- `dispatched`는 배차 확정 명령(`publish_dispatch`) 성공 때 보낸다. 수정안을 확정하면 차량이 바뀐 주문만 다시 보낸다.
- 한 주문의 메시지는 순서대로 나간다. 앞 메시지가 재시도 중이면 뒤 메시지는 기다린다.
- `429`는 `5xx`처럼 재시도하고, 그 밖의 `4xx`·`3xx`는 재시도 없이 `failedAt`을 남기고 알림(`meatbox-outbound`/`DELIVERY_STATUS_REJECTED`)을 보낸다. 한 메시지가 11번 실패하면 `DELIVERY_STATUS_UNREACHABLE` 알림을 보낸다.
- 인증은 `MEATBOX_API_TOKEN`이 있을 때만 `Authorization: Bearer`를 붙인다. 고정 IP 허용은 배포 쪽 과제다.
- 온도(3.3)는 보내지 않는다. ETA(3.2)는 출발과 재산출(위 3.2)에서 보낸다. 송신함의 `kind`로 나중에 얹는다.

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

**구현됨.** 기사 앱 `departed` 이벤트가 성공하면 같은 체크포인트 쓰기로 송신함에 `kind: "eta"` 메시지를 남기고, 발송기가 `POST {MEATBOX_API_BASE_URL}/tms/eta`로 보낸다. 계산은 [API 참조](api-reference.md#도착-예정-시각-eta)를 따른다. 계약과 다른 점:

- `reason` 다섯 가지를 모두 보낸다. `departed`는 출발, `completed`는 배송지 완료·미배송·부분 완료 뒤 재산출이다. `delayed`는 그 배송지가 예정(ETA+작업시간)보다 임계(기본 10분) 이상 이르거나 늦게 닫혔을 때다. 이른 경우도 `delayed`다. `zone_entered`는 권역 진입, `reordered`는 출발 후 순서 변경이다.
- 재산출은 남은(열린) 배송지만 담고 `sequence`는 전체 경로의 위치다. 완료분은 담지 않는다. 배송지가 닫힌 시각이 기준이라 첫 남은 배송지는 "닫힌 시각 + 이동"이다.
- 재산출 때마다 메시지를 보내지 않는다. 새 ETA가 마지막으로 보낸 ETA와 임계 이상 벌어질 때만 보낸다. `reordered`는 항상 보낸다.
- 아직 보내지 않은 ETA 메시지가 있으면 새 메시지가 그것을 대체한다(차량 전체 목록이므로 최신본만 남는다). 이미 보낸 메시지는 그대로 남고 새 메시지가 따로 간다.
- `messageId`는 출발이 `{date}-{revision}-eta-{vehicleId}`, 재산출은 `{date}-{revision}-eta-{vehicleId}-r{n}`(n은 재산출 횟수)이며 `Idempotency-Key`와 같다. 권역 진입은 엔진 revision을 바꾸지 않아 접미 없이는 id가 겹친다. 차량 하나의 ETA 메시지는 앞 메시지가 끝나야 나간다.
- `stops[].orderIds`는 그 배송지 묶음의 주문들이고, `eta`는 분 단위 `+09:00` 시각이다. 우리 쪽에 있는 `estimated`(좌표 없음 표시)는 이 본문에 넣지 않는다. 미트박스에 보여 줄지는 미정이다.
- 이동 시간은 직선거리 모델이라 실제 도로와 다를 수 있다. 설정(우회계수·속도·작업시간)은 [운영](operations.md#도착-예정-시각-eta-설정-kotlin-api)에 있다.
- 이 메시지가 거절(`4xx`)되면 알림 `meatbox-outbound` / `ETA_REJECTED`를 보내고 재시도하지 않는다. 한 메시지가 11번 실패하면 `ETA_UNREACHABLE`을 보낸다.

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

**구현됨.** `POST /api/meatbox/orders`가 이 본문을 받아 그 날짜의 배차 원본으로 쓴다. 필드·응답·오류는 [API 참조](api-reference.md#미트박스-주문-수신-kotlin-api-전용), 변경·취소 반영은 [도메인](domain-and-state.md#미트박스가-보낸-주문api-원본)에 있다. 이 문서의 상태는 계속 초안이다. 계약과 다른 점:

- 인증은 `MEATBOX_INBOUND_TOKEN`과 비교하는 `Authorization: Bearer`다. 토큰이 없으면 경로가 없다. 고정 IP 허용과 게이트웨이 경로 열기는 배포 쪽 과제다.
- 응답은 첫 수신 `202`, 중복·낮은 version(`ignored`) `200`, 같은 version에 다른 본문 `409`다.
- 취소는 `orderId`·`version`·`status`·`deliveryDate`만 있으면 된다.
- 배차 전(`unplanned`)이면 바로 반영한다. 계산안(`draft`)이면 반영하고 계산안을 버린다. 확정 이후(`published`·`amending`)와 완료 주문은 변경·취소·신규 모두 **반영하지 않고** 경고와 운영 알림만 남긴다. 반영 경로는 후속이다.
- `deliveryDate`가 이미 받은 주문과 다르면 `422`로 거절한다. 지난 날짜도 `422`다.
- 좌표(`address.lat/lng`)가 없으면 좌표 없이 배차한다. 주소 정제·좌표화(7)는 하지 않았다.
- 후보 차량은 합성 그룹이다(`MEATBOX_INBOUND_GROUP_COUNT`). 실제 차량 연결은 미트박스 자료가 아니라 자원 등록부 작업(F08)이다.
- `customer.phone`은 저장만 하고 `access`는 기존 기사 앱 규칙(제한 없음)대로 나간다.

## 5. 모의 수신기

미트박스 명세 전까지 PoC는 우리 서버의 `/mock/meatbox/*`가 3장의 본문을 받아 `202`를 돌려주는 것으로 통과시킨다. 첫 송신 구현과 같은 작업 단위에서 만들었다.

**구현됨.** `meatbox.mock-receiver.enabled=true`일 때만 뜨는 테스트 전용 수신기다. 필수 키·`Idempotency-Key`를 검사하고 최근 200건을 `GET /mock/meatbox/received`로 보여 준다. 세션이 없으므로 운영에 켜지 않는다. 경로와 오류는 [API 참조](api-reference.md#모의-수신기-mockmeatbox-테스트-전용)에 있다. 송신기가 `{base}/tms/<종류>`로 보내므로 수신기는 `/mock/meatbox/tms/<종류>`도 받는다(기본 주소 `.../mock/meatbox`). 3.2 본문은 출발과 재산출이 보낸다. 3.3 본문은 검사만 하고 송신기는 아직 보내지 않는다.

## 6. 미트박스에 확인할 것

- 수신 끝점 경로와 인증 방식. Bearer인지, IP 허용인지.
- 주문은 밀어 넣기인지 당기기인지. 취소·변경 전달 방식.
- `status` 값 매핑. 그쪽 고객 화면 상태와 1:1인지.
- 사진은 URL 참조로 충분한지, 파일을 넘겨야 하는지.
- 상차 완료 상태를 누가 만드는지. WMS에서 오는지, 기사 앱에서 찍는지.
- 테스트 환경과 고정 IP 허용.
- 주문의 `deliveryDate`가 바뀔 수 있는가. 지금은 `422`로 막는다. 바뀐다면 이전 날짜 취소와 새 날짜 등록을 어떤 식으로 보낼지.
- 배차 확정 뒤의 변경·취소·신규 주문을 어떻게 다룰지. 지금은 반영하지 않고 경고만 남긴다. 확정 뒤 반영을 기대하는지, 그때 기사에게 알릴지.

## 7. 끝점 요약 (GET / POST)

조회는 `GET`, 상태를 바꾸거나 기록을 남기는 요청은 `POST`다. `GET`은 몇 번 불러도 같고 부작용이 없다. `POST`는 작업 식별자로 중복을 막는다.
`/api/driver/*`는 기사 세션, `/api/meatbox/*`는 미트박스 토큰, 미트박스 쪽 경로는 그쪽 발급 토큰을 쓴다. 기존 `push-token`·`messages`는 [API 참조](api-reference.md)에 있다.

### 7.1 앱 → 우리 서버

구현됨(현행 경로): 아래 7개 끝점이 모두 `/api/dispatch-data/days/{date}/driver/{route|stops/{stopId}|history|events|events/{eventId}|photos|photos/{photoId}|locations}`에 있다. 표의 `/api/driver/...` 경로는 기사 계정 권한 단위에서 옮길 목표 경로다. 조회는 `vehicleId` 쿼리를 받고, `route`의 `eta`는 출발 전 `null`이고 출발 뒤 값이 채워지며, 배송지 상세의 출입정보는 아직 제한 없이 나간다.

| 방법 | 경로 | 역할 | 본문·응답 |
| --- | --- | --- | --- |
| `GET` | `/api/driver/days/{date}/route` | 배정 배송지·순서·상태·ETA. 앱 시작과 재동기화 | 응답에 `revision`. 순서 변경 때 `expectedRevision`으로 보냄 |
| `GET` | `/api/driver/days/{date}/stops/{stopId}` | 배송지 상세. 고객·품목·출입정보·배송팁·CS 요청·직전 완료 사진 | 출입정보는 권한 있을 때만 |
| `GET` | `/api/driver/days/{date}/history` | 당일 완료·미배송 이력 (57) | 완료 시각·배송지 기준 |
| `GET` | `/api/driver/events/{eventId}` | 응답을 잃었을 때 처리 결과 재확인 | `202`와 같은 본문. 없으면 `404` → 재전송 |
| `POST` | `/api/driver/photos` | 사진 업로드 | `multipart`, 압축본. 응답 `{ "photoId" }` |
| `POST` | `/api/driver/events` | 이벤트 6종 (2절) | 봉투 + `payload`. 응답 `202` |
| `POST` | `/api/driver/locations` | 위치 1분 배치 | `samples[]`. 응답 `202` |

### 7.2 우리 서버 → 미트박스

경로는 미트박스가 정한다. 아래는 자리 표시다.

| 방법 | 경로 | 역할 | 본문 |
| --- | --- | --- | --- |
| `POST` | `{meatbox}/tms/delivery-status` | 주문 상태 (3.1) | `Idempotency-Key: messageId` |
| `POST` | `{meatbox}/tms/eta` | 차량 ETA 전체 (3.2) | 같음 |
| `POST` | `{meatbox}/tms/temperature` | 온도 1분 묶음 (3.3) | 같음 |

미트박스 응답은 `202 { "accepted": true }`를 기대한다. `4xx`는 본문을 고쳐야 하므로 재시도하지 않고 운영 알림.

### 7.3 미트박스 → 우리 서버

| 방법 | 경로 | 역할 | 본문 |
| --- | --- | --- | --- |
| `POST` | `/api/meatbox/orders` | 주문 등록·변경·취소 (4절) | `Idempotency-Key: orderId:version` |
| `GET` | `/api/meatbox/orders/{orderId}` | 우리가 가진 최신 상태 확인 | 상태·마지막 송신 `messageId`. **이번에 만들지 않았다.** 날짜 상태 조회(`sourceData.inbound`)로 확인한다 |

당기기 방식이면 `GET {meatbox}/orders?date=YYYY-MM-DD`를 우리가 주기 호출하고 4절 본문을 배열로 받는다.

### 7.4 모의 수신기 (우리 서버, PoC 전용)

| 방법 | 경로 | 역할 |
| --- | --- | --- |
| `POST` | `/mock/meatbox/delivery-status` | 3.1 본문 검증 후 `202` |
| `POST` | `/mock/meatbox/eta` | 3.2 본문 검증 후 `202` |
| `POST` | `/mock/meatbox/temperature` | 3.3 본문 검증 후 `202` |
| `GET` | `/mock/meatbox/received` | 받은 메시지 목록. PoC 확인용 |

운영 빌드에는 넣지 않는다.

