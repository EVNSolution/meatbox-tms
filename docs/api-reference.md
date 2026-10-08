# HTTP API 참조

서버가 제공하는 HTTP 경로와 요청·응답 계약을 정리한다. 모든 `/api/*` 경로는 `meatbox_session` 쿠키가 필요하다. 현재 인증은 세션 존재만 확인하며 역할·테넌트·기사·고객별 자원 권한은 검사하지 않는다.

## 공통 규칙

아래 JSON은 구조를 설명하는 가상·축약 예시이며 그대로 재전송할 fixture가 아니다. 실제 명령의 ID·boot·revision·날짜는 최신 조회 응답에서 가져온다.

- 응답은 별도 표기가 없으면 JSON이다.
- 인증이 없거나 세션이 만료된 API 요청은 `401 {"error":"LOGIN_REQUIRED"}`다.
- 경로에 `;`(경로 매개변수) 또는 `%3B`가 있으면 로그인 여부와 무관하게 Kotlin API는 `400 {"error":"INVALID_PATH"}`를 반환하고, 웹 게이트웨이는 `;`와 `#`가 있는 경로를 `404`로 거절한다. 어떤 경로도 매개변수를 쓰지 않는다.
- 상태 변경은 브라우저가 보내는 `Origin`이 설정된 `PUBLIC_ORIGIN`과 정확히 같아야 한다.
- 날짜 명령은 `Content-Type: application/json`, 최대 `128 KiB`다. 자원 변경은 최대 `256 KiB`다.
- 날짜 명령은 인증 사용자별 분당 120회를 넘으면 `429 COMMAND_RATE_LIMITED`와 `Retry-After`를 반환한다.
- 날짜 상태와 명령 응답은 `Accept-Encoding: gzip`을 협상한다. 정적 원본은 준비된 `.gz` 동반 파일이 있을 때 사용한다.
- 오류 응답은 내부 경로나 예외 전문을 노출하지 않는다.

## 경로 요약

| 방법 | 경로 | 역할 |
|---|---|---|
| `GET` | `/api/session` | 현재 세션 사용자 |
| `GET` | `/api/dispatch-data/manifest` | 준비된 날짜와 원본 메타데이터 |
| `GET` | `/api/dispatch-data/days/{date}` | 날짜별 원본 주문·후보 그룹 |
| `GET` | `/api/dispatch-data/regions` | 공통 권역 GeoJSON |
| `GET` | `/api/dispatch-data/destinations` | 선택일까지의 누적 배송지 검색 |
| `GET` | `/api/dispatch-data/days/{date}/state` | 날짜별 배차·운행 snapshot |
| `POST` | `/api/dispatch-data/days/{date}/commands` | 날짜별 배차·운행 명령 |
| `GET` | `/api/resources` | 차량·지역 코드 등록부 |
| `POST` | `/api/resources/region-codes` | 지역 코드 생성 |
| `PATCH` | `/api/resources/region-codes/{code}` | 지역 코드 이름 변경 |
| `PATCH` | `/api/resources/vehicles` | 차량 지역 코드 일괄 변경 |
| `PATCH` | `/api/resources/vehicles/{id}` | 차량 한 대의 지역 코드 변경 |

구현 조립은 [`server.js`](../server.js), 날짜 조회는 [`dispatch-data.js`](../lib/dispatch-data.js), 날짜 상태·명령은 [`source-operations-router.js`](../lib/source-operations-router.js), 자원 API는 [`resource-router.js`](../lib/resource-router.js)를 따른다.

## 세션

### `GET /api/session`

응답 핵심:

```json
{
  "user": {
    "username": "reviewer",
    "displayName": "검토자",
    "createdAt": 1780000000000
  }
}
```

비밀번호 해시, 세션 토큰과 초대 코드는 반환하지 않는다. 사용자 객체에는 역할이나 접근 범위가 없다. 실제 공개 필드는 [`publicUser`](../lib/access.js)에서 확인한다.

## 날짜 원본 조회

### `GET /api/dispatch-data/manifest`

매니페스트 파일을 검증한 뒤 그대로 반환한다. 필수 구조는 `schemaVersion: 1`, 유효한 `defaultDate`, 중복 없는 `dates[].date`이며 기본일은 날짜 목록 안에 있어야 한다. `source.csvSha256`은 날짜 상태의 `sourceId`와 체크포인트 원본 일치 검사에 사용한다.

### `GET /api/dispatch-data/days/{date}`

`{date}`는 실제 달력의 `YYYY-MM-DD`이고 매니페스트에 등록되어야 한다. 날짜 파일을 그대로 반환하며 핵심 필드는 다음과 같다.

```json
{
  "schemaVersion": 1,
  "date": "2026-09-16",
  "groups": [{ "id": "G1", "label": "배송기사 표기" }],
  "orders": [{ "id": "O1", "groupId": "G1", "name": "배송지", "address": "주소", "boxes": 2 }],
  "summary": { "orders": 1, "boxes": 2 }
}
```

실제 생성 파일에는 좌표·권역·순서 등 추가 필드가 있다. 전체 생성 계약은 [`prepare-dispatch-data.py`](../scripts/prepare-dispatch-data.py)와 [날짜별 원본 배차 자료](dated-dispatch-data.md)를 기준으로 한다.

### `GET /api/dispatch-data/regions`

검증된 설치의 `regions.geojson`을 그대로 반환한다. 날짜별 상태를 변경하지 않는다.

### `GET /api/dispatch-data/destinations`

질의:

| 이름 | 기본값 | 제약 |
|---|---|---|
| `date` | `manifest.defaultDate` | 매니페스트 등록일 |
| `q` | 빈 문자열 | 문자열, 최대 100자 |
| `page` | `1` | 1 이상, 최대 1,000,000 |
| `pageSize` | `20` | 1~100 |

응답은 선택일까지 누적한 배송지다.

```json
{
  "date": "2026-09-16",
  "fromDate": "2026-01-02",
  "total": 1,
  "page": 1,
  "pageSize": 20,
  "pageCount": 1,
  "summary": { "destinations": 1, "orders": 3, "boxes": 5 },
  "items": [{
    "id": "destination-1",
    "name": "배송지",
    "address": "주소",
    "detailAddress": "상세주소",
    "regionNames": ["권역"],
    "orderCount": 3,
    "boxCount": 5,
    "orderDays": 2,
    "firstOrderDate": "2026-01-02",
    "lastOrderDate": "2026-09-16"
  }]
}
```

`summary`는 검색 결과가 아니라 그 날짜까지의 전체 누적 snapshot 합계다. 결과가 없어도 `pageCount`는 최소 1이며 요청 페이지가 범위를 넘으면 마지막 페이지로 맞춘다.

### 원본 조회 오류

| 상태 | 코드 | 의미 |
|---|---|---|
| `400` | `DISPATCH_DATA_QUERY_INVALID` | 누적 배송지 질의가 범위를 벗어남 |
| `404` | `DISPATCH_DATA_UNAVAILABLE` | 매니페스트 설치가 없음 |
| `404` | `DISPATCH_DATA_NOT_FOUND` | 날짜·파일·배송지 카탈로그가 없음 |
| `500` | `DISPATCH_DATA_INVALID` | JSON, 스키마 또는 원본 서명이 잘못됨 |

## 날짜 상태 조회

### `GET /api/dispatch-data/days/{date}/state`

날짜 aggregate의 공개 snapshot을 반환한다. 아래는 서울 날짜가 2026-09-28일 때 과거 2026-09-16을 조회하는 축약 예시다. `today`와 `operatingDate`는 요청 당시 서울 날짜에 따라 달라진다.

```json
{
  "boot": "서버-프로세스-UUID",
  "revision": 0,
  "sourceData": {
    "date": "2026-09-16",
    "sourceId": "원본-CSV-SHA256",
    "operatingDate": "2026-09-28"
  },
  "dispatch": {
    "phase": "unplanned",
    "today": "2026-09-28",
    "readOnly": true,
    "draftVersion": 0,
    "confirmedVersion": 0
  },
  "dispatchCandidates": [],
  "dispatchPreview": [],
  "dispatchOrders": [],
  "fleetDeliveries": [],
  "fleetVehicles": [],
  "vehicleStates": {},
  "events": [],
  "notifications": []
}
```

서버는 `ETag: "source-{boot}-{date}-{revision}-{today}"`를 보낸다. 클라이언트의 `If-None-Match`가 같으면 본문 없이 `304`다. 서울 날짜가 바뀌면 revision이 같아도 ETag와 `dispatch.readOnly`가 바뀔 수 있다.

## 날짜 명령

### `POST /api/dispatch-data/days/{date}/commands`

모든 요청에 다음 두 필드가 필요하다.

```json
{
  "expectedBoot": "직전-state의-boot",
  "expectedRevision": 3,
  "type": "명령-이름"
}
```

성공 응답:

```json
{
  "state": { "boot": "서버-프로세스-UUID", "revision": 4 },
  "result": { "type": "명령-이름" }
}
```

`state`는 축약 응답이 아니라 상태 조회와 같은 전체 snapshot이다. 명령 결과가 불명확하게 끊기면 클라이언트는 같은 명령을 자동 재전송하지 않고 최신 state를 다시 읽는다. 명령 ID 기반 멱등성은 구현되어 있지 않다.

### 배차 명령

| `type` | 추가 필드 | 계약 |
|---|---|---|
| `calculate_dispatch` | `vehicleIds: string[]` | 선택 후보로 전체 주문 계산안을 만든다 |
| `reassign` | `orderIds: string[]`, `targetVehicleId: string` | 동일 배송지 주문 전체를 계산안/수정안 안에서 이동한다 |
| `publish_dispatch` | `draftVersion: integer` | 최신 계산안 또는 수정안을 확정한다 |
| `begin_dispatch_revision` | 없음 | 확정본에서 수정안을 연다 |
| `discard_dispatch_revision` | 없음 | 수정안을 버리고 확정본을 유지한다 |

최초 계산 요청 예:

```json
{
  "type": "calculate_dispatch",
  "expectedBoot": "a0b1c2d3-boot",
  "expectedRevision": 0,
  "vehicleIds": ["G1", "G2"]
}
```

전송 요청 예:

```json
{
  "type": "publish_dispatch",
  "expectedBoot": "a0b1c2d3-boot",
  "expectedRevision": 2,
  "draftVersion": 2
}
```

### 운행 명령

운행 명령은 확정 후에만 허용된다.

| `type` | 추가 필드 | 핵심 검증 |
|---|---|---|
| `set_scenario` | `vehicleId`, `stopId`, `scenario` | `received`, `picking`, `ready`, `shipping`, `arrived`; `completed`는 거부 |
| `arrive_stop` | `vehicleId`, `stopId` | 현재 이동 중인 목적지만 도착 처리 |
| `complete_stop` | `vehicleId`, `stopId`, `hasPhoto: true`, `confirmedRequestIds: string[]` | 도착 상태, 사진 확인 플래그, 모든 필수 요청 ID |
| `set_route_order` | `vehicleId`, `order`, `expectedOrder`, `expectedStatuses`, `expectedPhase` | 경로 전체와 차량 상태에 대한 추가 CAS, 배송지 묶음 연속성 |
| `toggle_skip` | `vehicleId`, `stopId` | 묶음 전체가 대기 또는 보류일 때 전환 |
| `set_delivery_tip` | `vehicleId`, `stopId`, `body` | 비어 있지 않은 평문 최대 500자, 완료 묶음 변경 금지 |
| `send_customer_notice` | `vehicleId`, `stopId`, `body`, 선택 `author` | 평문 최대 300자, snapshot에 고객 팝업 기록 |

완료 요청 예(변경 가능한 날짜의 최신 상태를 조회한 후 사용):

```json
{
  "type": "complete_stop",
  "expectedBoot": "a0b1c2d3-boot",
  "expectedRevision": 8,
  "vehicleId": "G1",
  "stopId": "O1",
  "hasPhoto": true,
  "confirmedRequestIds": ["request_0123456789ab"]
}
```

`confirmedRequestIds`는 해당 배송지 묶음의 `fleetDeliveries[].customerRequests.items[]`에서 필수 항목의 실제 `id`를 읽어 그대로 보낸다. 위 `request_0123456789ab`도 가상 값이며 주문 ID와 요청 종류를 조합해 만들지 않는다. `hasPhoto`는 업로드된 파일이나 영구 증빙을 참조하지 않는다. `send_customer_notice`도 외부 푸시·문자 전송을 수행하지 않는다.

### 날짜 명령 오류와 동시성

| 상태 | 대표 코드 | 처리 |
|---|---|---|
| `400` | `INVALID_COMMAND`, `INVALID_CANDIDATES`, `INVALID_ASSIGNMENT` | 본문·필드·업무 규칙을 수정한다 |
| `409` | `BOOT_MISMATCH` | state를 다시 읽거나 페이지를 새로 연다 |
| `409` | `REVISION_CONFLICT` | 최신 state를 읽고 사용자 결정을 다시 적용한다 |
| `409` | `DRAFT_CONFLICT` | 최신 계산안과 `draftVersion`을 다시 확인한다 |
| `409` | `DATE_READ_ONLY` | 과거 날짜는 조회만 한다 |
| `409` | `PROTECTED_DESTINATION` | 진행·완료 배송지 묶음을 수정안에서 제외한다 |
| `409` | `DISPATCH_NOT_PUBLISHED`, `DISPATCH_ALREADY_PUBLISHED` | 현재 `dispatch.phase`에 맞는 명령을 사용한다 |
| `413` | `COMMAND_TOO_LARGE` | 본문을 제한 안으로 줄인다 |
| `429` | `COMMAND_RATE_LIMITED` | `Retry-After` 이후 최신 state부터 다시 확인한다 |
| `500` | `DISPATCH_STATE_WRITE_FAILED` | 기존 상태는 유지된다. 저장소를 복구한 뒤 state부터 확인한다 |
| `500` | `DISPATCH_STATE_INVALID`, `DISPATCH_STATE_SOURCE_MISMATCH` | 체크포인트 또는 원본 불일치를 복구해야 한다 |
| `503` | `SOURCE_OPERATIONS_CAPACITY` | 변경 중인 날짜가 모두 사용 중이다. 잠시 후 다시 조회한다 |

업무 규칙 오류 중 코드가 따로 없는 것은 `400 INVALID_COMMAND`와 최대 300자의 사용자 메시지로 반환될 수 있다.

## 자원 등록부

`RESOURCE_DATABASE`가 없거나 열 수 없으면 모든 자원 경로는 `503 RESOURCE_DATABASE_UNAVAILABLE`이다. API가 새 DB를 만들거나 레거시 원본을 자동 가져오지는 않는다.

주의: 기존 schema v1 DB는 최초 연결 시 [`migrateV1`](../lib/resource-store.js)로 schema v2에 자동 마이그레이션된다. store 연결이 lazy이므로 `GET /api/resources`가 최초 연결이면 GET도 DB를 변경할 수 있다.

### `GET /api/resources`

```json
{
  "revision": 4,
  "regionCodes": [{ "code": "Z001" }],
  "vehicles": [{ "id": "G1", "plate": "12가3456", "regionCode": "Z001" }],
  "source": { "kind": "legacy_vehicle_catalog", "importedCount": 1, "excludedCount": 0 }
}
```

활성 차량만 반환한다. 지역 코드가 없는 차량은 `regionCode: null`이며 목록 뒤에 정렬된다.

### 지역 코드 변경

`POST /api/resources/region-codes`

```json
{ "revision": 4, "code": "SEOUL1" }
```

`PATCH /api/resources/region-codes/{code}`

```json
{ "revision": 5, "code": "SEOUL2" }
```

코드는 영문자로 시작하는 영문·숫자 1~40자이며 서버가 대문자로 정규화한다. 이름 변경은 SQLite 외래 키의 `ON UPDATE CASCADE`로 차량 배정에도 반영한다.

### 차량 지역 코드 변경

`PATCH /api/resources/vehicles`

```json
{
  "revision": 6,
  "assignments": [
    { "id": "G1", "regionCode": "SEOUL2" },
    { "id": "G2", "regionCode": null }
  ]
}
```

1~1000개의 서로 다른 활성 차량을 한 트랜잭션으로 변경한다. 하나라도 잘못되면 전부 롤백하고 revision을 올리지 않는다. 같은 지역 코드를 여러 차량에 지정할 수 있다.

`PATCH /api/resources/vehicles/{id}`는 한 대를 바꾸는 축약 경로다.

```json
{ "revision": 7, "regionCode": "SEOUL2" }
```

모든 성공 응답은 갱신된 전체 자원 snapshot이다.

### 자원 오류

| 상태 | 코드 | 의미 |
|---|---|---|
| `400` | `INVALID_JSON`, `INVALID_INPUT` | JSON 또는 정확한 필드 집합이 잘못됨 |
| `400` | `INVALID_REVISION` | revision이 음수이거나 정수가 아님 |
| `400` | `INVALID_REGION_CODE`, `REGION_CODE_NOT_FOUND` | 코드 형식 또는 참조가 잘못됨 |
| `400` | `INVALID_ASSIGNMENTS` | 일괄 목록 크기·중복·항목 형식이 잘못됨 |
| `403` | `ORIGIN_REQUIRED` | 설정 origin과 다른 변경 요청 |
| `404` | `VEHICLE_NOT_FOUND`, `REGION_CODE_NOT_FOUND` | 활성 차량 또는 변경 대상 코드를 찾지 못함 |
| `409` | `RESOURCE_REVISION_CONFLICT` | 다른 자원 변경이 먼저 커밋됨 |
| `409` | `REGION_CODE_EXISTS` | 생성·변경할 코드가 이미 있음 |
| `503` | `RESOURCE_DATABASE_UNAVAILABLE` | DB 미설정, 손상 또는 열기 실패 |

`REGION_CODE_NOT_FOUND`는 작업에 따라 `400` 또는 `404`다. 차량 배정에서 참조 코드가 없으면 `400`, 이름 변경 대상 자체가 없으면 `404`다.

## 폼과 레거시 WebSocket

다음 경로는 JSON REST API가 아니지만 같은 서버의 외부 계약이다.

| 방법 | 경로 | 설명 |
|---|---|---|
| `GET/POST` | `/login` | 폼 로그인. 성공 `303`, 실패 `401` |
| `GET/POST` | `/dev/register` | 초대 기반 등록. 성공 `303`, 검증 실패 `400` |
| `POST` | `/logout` | 세션 종료와 해당 WebSocket `4401` 종료 |
| `GET` | `/scenario/api/route-data` | 레거시 고정 경로 데이터 |
| WebSocket | `/ws/simulation` | 레거시 시뮬레이션 상태·명령 |

폼 POST도 정확한 Origin을 요구하며, 로그인·등록 시도는 IP별 15분에 20회로 제한한다. `/ws/simulation`은 인증 쿠키와 Origin을 검사하고 사용자별 초당 10개를 넘는 명령 연결을 `4429`로 닫는다.

레거시 WebSocket 상태는 날짜별 REST 상태와 공유하지 않는다. 신규 연동은 날짜별 REST 계약을 기준으로 하고 레거시 route-data나 WebSocket을 운영 원본으로 사용하지 않는다.
