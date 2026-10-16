# HTTP API 참조

서버가 제공하는 HTTP 경로와 요청·응답 계약을 정리한다. `/api/meatbox/*`(미트박스 주문 수신)와 `POST /api/telemetry/temperature`(온도 단말 수신)를 뺀 모든 `/api/*` 경로는 `meatbox_session` 쿠키가 필요하다. 현재 인증은 세션 존재만 확인하며 역할·테넌트·기사·고객별 자원 권한은 검사하지 않는다.

## 공통 규칙

아래 JSON은 구조를 설명하는 가상·축약 예시이며 그대로 재전송할 fixture가 아니다. 실제 명령의 ID·boot·revision·날짜는 최신 조회 응답에서 가져온다.

- 응답은 별도 표기가 없으면 JSON이다.
- 모든 `4xx`·`5xx` 응답은 RFC 9457 `Content-Type: application/problem+json`이다. 필터·컨트롤러·Spring 기본 오류가 같은 본문을 쓴다. 예외: `/login`·`/register` 폼 화면의 HTML 오류.
- 오류 본문 필드는 `type`(항상 `about:blank`), `title`(코드를 풀어 쓴 짧은 영문), `status`, `detail`(사용자 메시지, 최대 300자), `code`다. 클라이언트는 `code`로 분기한다.
- 호환 필드 `error`(값은 `code`와 같음)와 `message`(`detail`과 같음, 메시지가 있을 때만)를 당분간 함께 내보낸다. 웹 프런트가 `code`·`detail`로 옮기면 두 필드를 뺀다.
- Spring이 직접 만드는 오류(없는 경로 `404 NOT_FOUND`, `405 METHOD_NOT_ALLOWED`, `415 UNSUPPORTED_MEDIA_TYPE`, 읽을 수 없는 본문 `400 BAD_REQUEST`)도 같은 형식이며 `code`는 HTTP 상태 이름이다. `detail`은 상태 문구이고 요청 경로를 담지 않는다.
- 처리되지 않은 예외는 `500 INTERNAL_ERROR`와 고정 `detail`이다. 예외 전문은 서버 로그에만 남는다.
- 인증이 없거나 세션이 만료된 API 요청은 `401 LOGIN_REQUIRED`다.
```json
{"type":"about:blank","title":"Login required","status":401,"detail":"Login required","code":"LOGIN_REQUIRED","error":"LOGIN_REQUIRED"}
```
- 경로에 `;`(경로 매개변수) 또는 `%3B`가 있으면 로그인 여부와 무관하게 Kotlin API는 `400 INVALID_PATH`를 반환하고, 웹 게이트웨이는 `;`와 `#`가 있는 경로를 `404`로 거절한다. 어떤 경로도 매개변수를 쓰지 않는다.
- 상태 변경은 브라우저가 보내는 `Origin`이 설정된 `PUBLIC_ORIGIN`과 정확히 같아야 한다.
- 날짜 명령은 `Content-Type: application/json`, 최대 `128 KiB`다. 자원 변경은 최대 `256 KiB`다.
- 날짜 명령은 인증 사용자별 분당 120회를 넘으면 `429 COMMAND_RATE_LIMITED`와 `Retry-After: 60`을 반환한다. 모든 `429` 응답이 같은 헤더를 가진다.
- 날짜 상태와 명령 응답은 `Accept-Encoding: gzip`을 협상한다. 정적 원본은 준비된 `.gz` 동반 파일이 있을 때 사용한다.
- 오류 응답은 내부 경로나 예외 전문을 노출하지 않는다.
- 아래 오류 표의 상태·코드는 그대로이며 본문 형식만 위 규칙을 따른다.

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
| `GET` | `/api/dispatch-data/days/{date}/commands/{requestId}` | 저장된 명령 결과 조회 |
| `POST` | `/api/dispatch-data/days/{date}/driver/events` | 기사 앱 이벤트 6종 수신 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/events/{eventId}` | 이벤트 처리 결과 재확인 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/route` | 차량의 배송지 순서·상태·주문·좌표·ETA. 기사 앱이 읽는 하루 전체 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/vehicles` | 그날의 차량 목록과 phase·배송지·주문 수, 차량 선택용 (Kotlin API 전용) |
| `POST` | `/api/dispatch-data/days/{date}/driver/stops/{stopId}/tip` | 배송팁 등록, `requestId` 멱등 (Kotlin API 전용) |
| `POST` | `/api/dispatch-data/days/{date}/driver/route/suggest` | 자동 배송 순서 제안, 상태 불변 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/stops/{stopId}` | 배송지 상세 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/history` | 당일 완료·미배송 이력 (Kotlin API 전용) |
| `POST` | `/api/dispatch-data/days/{date}/driver/locations` | 기사 위치 배치 수신 (Kotlin API 전용) |
| `POST` | `/api/dispatch-data/days/{date}/driver/photos` | 완료 사진 업로드 (Kotlin API 전용) |
| `GET` | `/api/dispatch-data/days/{date}/driver/photos/{photoId}` | 올린 사진 다시 받기 (Kotlin API 전용) |
| `POST` | `/api/meatbox/orders` | 미트박스가 밀어 넣는 주문 등록·변경·취소. 세션이 아니라 Bearer 토큰, 토큰 미설정이면 경로 없음 (Kotlin API 전용) |
| `POST` | `/api/telemetry/temperature` | 온도 단말(또는 게이트웨이)이 밀어 넣는 측정값. 세션이 아니라 Bearer 토큰, 토큰 미설정이면 경로 없음 (Kotlin API 전용) |
| `GET` | `/api/telemetry/temperature/latest` | 차량·센서별 최신 온도와 마지막 수신 경과 (Kotlin API 전용) |
| `GET` | `/api/telemetry/temperature/{vehicleId}?from=&to=&resolution=` | 한 차량의 온도 이력, 최대 24시간 (Kotlin API 전용) |
| `GET` | `/api/ops/alerts` | 최근 서버 오류 알림 50건과 채널 종류 (Kotlin API 전용) |
| `GET` | `/api/ops/telemetry` | 온도 메시지 송신 대기·거절·완료 건수, 차량별 (Kotlin API 전용) |
| `GET` | `/api/ops/outbox?date=` | 미트박스 송신 대기·거절·완료 건수와 최근 20건 (Kotlin API 전용) |
| `POST` | `/api/ops/days/{date}/source-conflict/resolve` | 원본이 바뀐 날짜의 체크포인트를 유지·보관 (Kotlin API 전용) |
| `POST` | `/api/ops/export` | 운영 데이터 내보내기 작업 시작 (Kotlin API 전용) |
| `GET` | `/api/ops/export`, `/api/ops/export/{jobId}`, `/api/ops/export/{jobId}/download` | 작업 목록·상태, 아카이브 받기 (Kotlin API 전용) |
| `POST` `GET` | `/mock/meatbox/*` | 미트박스 모의 수신기. **테스트 전용**, 기본 꺼짐 (Kotlin API 전용) |
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

차량이 출발했으면 `vehicleStates[vehicleId].eta`에 그 차량의 도착 예정 시각(아래 "도착 예정 시각")이 들어간다. 출발 전 차량에는 이 필드가 없다. 웹은 모르는 필드를 읽지 않고 그대로 넘긴다. ETA는 `departed`·`stop_*`·출발 후 `route_reordered` 명령과 같은 쓰기로 바뀌므로 `revision`과 ETag도 함께 바뀐다. `zone_entered`의 재산출은 명령이 없어 `revision`이 그대로이므로 ETag의 `-e{재산출 횟수}`로 바뀐다.

**오늘(서울) 날짜의** snapshot에는 온도 단말이 값을 보낸 차량의 `vehicleStates[vehicleId].temperature`도 들어간다(아래 "온도 단말 수신과 조회"). 다른 날짜에는 없다. 값은 그 차량 센서 중 측정 시각이 가장 새로운 것이다. 값이 없는 차량·날짜는 바이트가 이전과 같다. 체크포인트에는 쓰지 않는다.

```json
"temperature": { "celsius": -18.4, "measuredAt": "2026-11-02T09:12:00+09:00", "stale": false, "outOfRange": false }
```

`stale`은 모든 센서가 10분(설정) 넘게 새 값을 보내지 않았다는 뜻이고, `outOfRange`는 어느 센서든 허용 범위를 벗어난 것이 확정됐다는 뜻이다. 아무것도 바뀌지 않아도 차량이 stale로 바뀌면 화면이 달라지므로 `sourceData.temperatureVersion`이 함께 바뀐다.

**원본이 바뀐 날짜(Kotlin API 전용).** 날짜의 저장된 체크포인트가 묶인 원본(`sourceId`)이나 그 날짜 파일의 내용(`contentHash`)이 현재와 다르면 계획을 읽을 수 없다. 이때는 오류 대신 200으로 아래 모양을 돌려준다. 계획을 읽지 못하므로 `dispatch`는 `null`이고 다른 필드는 없다. 이 경우의 ETag에는 `-c{detectedAt}`가 붙는다.

```json
{
  "date": "2026-10-05",
  "boot": "서버-프로세스-UUID",
  "dispatch": null,
  "sourceConflict": {
    "expectedSourceId": "체크포인트가 묶인 sourceId",
    "actualSourceId": "지금 원본의 sourceId",
    "detectedAt": "2026-10-05T01:00:00Z",
    "checkpointPhase": "draft",
    "reason": "source"
  }
}
```

`reason`은 `sourceId`가 다르면 `source`, 같은데 날짜 파일 내용만 다르면 `content`다. `detectedAt`은 이 서버 프로세스가 같은 변경을 처음 본 시각이다. 서버는 어느 쪽도 자동으로 고르지 않는다. 해소는 `POST /api/ops/days/{date}/source-conflict/resolve`다. `contentHash`가 없는 이전 체크포인트는 `sourceId`가 현재와 같으면 현재 내용으로 지문을 계산해 제자리 승격하고(충돌이 아니다), 다르면 충돌이다.

서버는 `ETag: "source-{boot}-{date}-{revision}-{today}"`를 보낸다. 기사 앱 위치를 받은 날짜는 `-l{위치 버전}`, ETA를 재산출한 날짜는 `-e{재산출 횟수 합}`이 뒤에 붙는다. 온도가 보이는 날짜는 `-t{온도 버전}`도 붙는다(값·stale·이탈 중 하나라도 바뀌면 달라진다). 클라이언트의 `If-None-Match`가 같으면 본문 없이 `304`다. 서울 날짜가 바뀌면 revision이 같아도 ETag와 `dispatch.readOnly`가 바뀔 수 있다.

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

`state`는 축약 응답이 아니라 상태 조회와 같은 전체 snapshot이다.

#### 요청 ID (선택)

본문에 `requestId`를 넣으면 응답이 끊겨도 같은 요청을 다시 보낼 수 있다.

```json
{ "requestId": "3f6c1d52-8a4e-4b0e-9c7a-2d5e8f1a6b90" }
```

- 형식: 영문·숫자·`-`·`_` 1~64자. UUID를 권장한다. 그 밖의 값과 문자열이 아닌 값은 `400 INVALID_COMMAND`다.
- 없으면 지금과 같다. 재전송 보호가 없다.
- 같은 `(date, requestId)`가 이미 성공했으면 서버는 CAS(`expectedBoot`·`expectedRevision`·`draftVersion`)보다 먼저 저장된 응답을 그대로 돌려준다. 상태는 바꾸지 않는다. 서버가 재시작되어 `boot`가 바뀌었어도 같다. 응답의 `state.boot`는 처음 응답 값이다.
- 같은 `requestId`인데 `requestId`를 뺀 본문이 다르면 `409 REQUEST_ID_MISMATCH`다. 본문 비교는 키 순서를 정렬한 JSON의 SHA-256이다.
- 성공(`200`)한 명령만 저장한다. 실패한 명령은 상태를 바꾸지 않았으므로 같은 `requestId`로 다시 보낼 수 있다.
- 결과는 날짜 체크포인트와 같은 파일 쓰기로 저장한다. 저장에 실패하면 상태도 결과도 남지 않는다.
- 보존: 날짜당 최근 500건, 24시간, 결과 본문 합계 8MiB 중 먼저 닿는 한도까지다. 넘으면 오래된 것부터 제거한다. 제거된 `requestId`를 다시 보내면 새 명령으로 처리한다.

### `GET /api/dispatch-data/days/{date}/commands/{requestId}`

저장된 결과가 있으면 `POST`가 처음 돌려준 것과 같은 `200` 본문이다. 없거나 보존 한도로 제거됐으면 `404 REQUEST_NOT_FOUND`다. 세션 쿠키가 필요하다. 상태를 바꾸지 않는다. 응답을 받지 못한 클라이언트는 `POST`를 다시 보내지 않고 이 경로로 결과만 확인할 수도 있다.

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
| `set_delivery_tip` | `vehicleId`, `orderId`, `body` | 엔진 명령이며 날짜 명령 끝점(`commands`)은 받지 않는다. 기사 끝점 `POST .../driver/stops/{stopId}/tip`이 쓴다. 비어 있지 않은 평문 500자 이하(`<`·`>`·제어문자 불가), 묶음의 모든 주문에 같은 팁, 완료·미배송 묶음과 바뀐 내용이 없는 경우는 거절 |
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
| `409` | `REQUEST_ID_MISMATCH` | 같은 `requestId`에 다른 본문이다. 새 `requestId`로 보낸다 |
| `404` | `REQUEST_NOT_FOUND` | 결과 조회 경로 전용. 저장된 결과가 없다. 명령은 적용되지 않았거나 보존 한도로 제거됐다. state를 읽어 확인한다 |
| `409` | `DRAFT_CONFLICT` | 최신 계산안과 `draftVersion`을 다시 확인한다 |
| `409` | `DATE_READ_ONLY` | 과거 날짜는 조회만 한다 |
| `409` | `PROTECTED_DESTINATION` | 진행·완료 배송지 묶음을 수정안에서 제외한다 |
| `409` | `DISPATCH_NOT_PUBLISHED`, `DISPATCH_ALREADY_PUBLISHED` | 현재 `dispatch.phase`에 맞는 명령을 사용한다 |
| `409` | `SOURCE_CHANGED` | 날짜 원본이 체크포인트와 달라졌다. 명령은 적용되지 않았다. `GET state`의 `sourceConflict`를 확인하고 운영자가 해소한다 |
| `413` | `COMMAND_TOO_LARGE` | 본문을 제한 안으로 줄인다 |
| `429` | `COMMAND_RATE_LIMITED` | `Retry-After` 이후 최신 state부터 다시 확인한다 |
| `500` | `DISPATCH_STATE_WRITE_FAILED` | 기존 상태는 유지된다. 저장소를 복구한 뒤 state부터 확인한다 |
| `500` | `DISPATCH_STATE_INVALID` | 체크포인트가 손상됐다. 파일을 보존한 채 복구한다. 원본 불일치는 더 이상 이 코드가 아니라 `409 SOURCE_CHANGED`다 |
| `503` | `SOURCE_OPERATIONS_CAPACITY` | 변경 중인 날짜가 모두 사용 중이다. 잠시 후 다시 조회한다 |

업무 규칙 오류 중 코드가 따로 없는 것은 `400 INVALID_COMMAND`와 최대 300자의 사용자 메시지로 반환될 수 있다.

## 기사 앱 끝점 (Kotlin API 전용)

경로 접두사는 `/api/dispatch-data/days/{date}/driver`다. 기존 `push-token`·`messages`와 같은 접두사를 쓴다.
계약 초안의 `/api/driver/...` 짧은 경로는 기사 계정 권한 단위에서 옮긴다. 지금 기사 신원은 TMS 세션과 본문의 `vehicleId` 선택이며 소유 관계를 검사하지 않는다.
세션 쿠키와 정확한 `Origin`이 필요하다. 쓰기는 사용자당 분당 30회, 읽기는 120회이며 넘으면 `429 DRIVER_RATE_LIMITED`다.
본문은 `application/json`이다. 이벤트는 최대 `16 KiB`, 위치는 `64 KiB`다. 넘으면 `413 DRIVER_BODY_TOO_LARGE`다.
`{date}`는 변경 가능한 날짜여야 한다. 과거 날짜는 `409 DRIVER_DATE_READ_ONLY`다.

### `POST .../driver/events`

본문 하나에 이벤트 하나다. 응답은 `202`다.

```json
{
  "eventId": "6f1c0e3a-1d2e-4f50-9a77-0a1b2c3d4e5f",
  "type": "stop_completed",
  "occurredAt": "2026-11-02T10:41:00+09:00",
  "date": "2026-11-02",
  "vehicleId": "G1",
  "location": { "lat": 37.5012, "lng": 127.0396, "accuracyM": 8 },
  "payload": { "stopId": "O4", "photoIds": ["9c3f0e8e-0f43-4d7a-8c1d-2b6f5a1e7d10"], "note": "문 앞" }
}
```

- `eventId`: 영문·숫자·`-`·`_` 1~64자. 날짜 명령의 `requestId`로 그대로 쓴다. 같은 날짜의 명령 결과와 한 이름 공간을 쓴다.
- `date`: 경로의 `{date}`와 같아야 한다. 다르면 `400 INVALID_INPUT`이다.
- `occurredAt`: 오프셋이 있는 ISO 8601이다. 서버는 이 값으로 순서를 바꾸지 않고 받은 순서로 반영한다.
- `location`: 선택. `lat`, `lng`, 선택 `accuracyM`. 이벤트 기록에만 남는다. 차량 위치는 `locations`로 받는다.
- 정해진 필드 밖의 키는 `400 INVALID_INPUT`이다.

| `type` | `payload` | 서버 동작 |
|---|---|---|
| `departed` | 선택 `stopOrder: string[]` | `stopOrder`가 있으면 `set_route_order`, 이어서 `start_route`. 출발 시각·위치를 이벤트 기록에 남긴다 |
| `zone_entered` | `zoneId` | 상태 변경 없음. `zoneId`·시각·위치를 이벤트 기록에 남긴다. 그 차량에 저장된 ETA가 있으면 `location`이 필수(`400 LOCATION_REQUIRED`)이고 남은 배송지 ETA를 다시 계산한다. 권역 폴리곤이 있고 위치가 밖이면 `422 ZONE_MISMATCH`다 |
| `stop_completed` | `stopId`, 선택 `orderIds`, `photoIds`, `note`, `scannedCodes` | 도착하지 않은 배송지면 `arrive_stop`, 이어서 `complete_stop`. `photoIds`는 올린 사진이어야 한다 |
| `stop_failed` | `stopId`, `reasonCode`, 선택 `orderIds`, `photoIds`, `note` | 도착하지 않았으면 `arrive_stop`, 이어서 `skip_stop`. 배송지는 `skipped`가 된다 |
| `stop_partially_completed` | `stopId`, `items[]`, 선택 `orderId`, `photoIds`, `note` | `stop_completed`와 같은 명령. `items`는 이벤트 기록에만 남고 품목 검증은 없다 |
| `route_reordered` | `stopOrder`, 선택 `expectedRevision` | `set_route_order`. 출발 후(`delivering`)에도 아직 대기(`pending`)인 배송지끼리는 바꿀 수 있고 ETA를 다시 계산한다. 현재·완료·보류 배송지의 자리가 달라지거나 차량 phase가 `done`이면 `409 ROUTE_LOCKED` |

- `stopId`는 배송지 묶음의 첫 주문 ID다. 같은 묶음의 다른 주문 ID도 받으며, 응답은 항상 첫 주문 ID를 돌려준다.
- `stopOrder`는 그 차량의 배송지를 빠짐없이 한 번씩 나열한다. 모자라거나 겹치면 `400 INVALID_INPUT`이다.
- `expectedRevision`은 날짜 상태의 `revision`이다. 다르면 `409 REVISION_CONFLICT`다.
- `reasonCode`는 `ABSENT`, `ACCESS_DENIED`, `ADDRESS_MISMATCH`, `REFUSED`, `NO_STORAGE`, `OTHER`다. 그 밖은 `400 INVALID_REASON_CODE`다.
- `note`는 최대 500자, `scannedCodes`는 최대 200개, `photoIds`는 최대 10개다.
- 한 이벤트의 명령은 한 번에 적용한다. 중간에 실패하면 아무것도 바뀌지 않고 결과도 저장하지 않는다.
- 상태 역행(이미 완료한 배송지의 완료, 출발한 차량의 출발 등)은 운행 상태 기계의 `409 OPERATION_REVISION_CONFLICT`다. 새 코드를 만들지 않았다.
- 명령마다 날짜 `revision`이 1씩 오른다. 도착하지 않은 배송지의 `stop_completed`는 `arrive_stop`과 `complete_stop` 두 단계라 2 오른다. 재전송은 오르지 않는다.

응답 `202`:

```json
{
  "accepted": true,
  "duplicate": false,
  "receivedAt": "2026-11-02T10:41:02+09:00",
  "stop": { "stopId": "O4", "status": "done" },
  "next": { "stopId": "O3", "eta": "2026-11-02T10:58:00+09:00" }
}
```

- `stop`은 `stop_*` 이벤트에만 있다. `status`는 `done` 또는 `skipped`다.
- `next`는 다음 배송지다. 남은 배송지가 없으면 없다. `eta`는 차량이 출발해 ETA를 계산한 뒤에는 그 배송지의 도착 예정 시각이고, 출발 전에는 `null`이다.
- `departed` 이벤트가 성공하면 같은 쓰기로 그 차량의 ETA를 계산해 저장하고, 미트박스 ETA 메시지(`kind: "eta"`)를 송신함에 남긴다. 이어서 `stop_*`·`zone_entered`·출발 후 `route_reordered`가 성공하면 남은 배송지 ETA를 다시 계산해 저장하고, 응답의 `next.eta`도 새 값이다. 계산과 설정은 아래 "도착 예정 시각(ETA)"를 따른다.
- `receivedAt`은 처음 받은 서버 시각이다. 재전송에도 같은 값이다.
- 같은 `eventId`를 다시 보내면 처음 응답을 돌려주고 `duplicate`만 `true`다. 상태는 바꾸지 않는다. 서버가 재시작되어도 같다.
- 같은 `eventId`에 다른 본문이면 `409 REQUEST_ID_MISMATCH`다.
- 성공한 이벤트만 저장한다. 실패한 `eventId`는 다시 보낼 수 있다.
- 결과 보존은 날짜 명령과 같다(날짜당 500건, 24시간). 지난 `eventId`를 다시 보내면 새 이벤트로 처리하고, 이미 반영된 상태면 `409`다.

### `POST .../driver/locations`

```json
{ "vehicleId": "G1", "samples": [{ "at": "2026-11-02T10:40:00+09:00", "lat": 37.5, "lng": 127.03, "accuracyM": 12 }] }
```

- `samples`는 1~200건이다. `accuracyM`은 선택이다. 각 샘플은 `at`, `lat`, `lng`만 허용한다.
- 차량당 최근 120건만 기사 상태 파일(`driver-{date}.json`)에 남긴다. 같은 `at`의 샘플은 덮어쓰므로 재전송해도 늘지 않는다.
- 응답 `202 { "accepted": 샘플 수, "retained": 남은 수, "receivedAt" }`.
- 가장 최근 `at`의 샘플이 날짜 상태의 `fleetVehicles[].location`을 덮어쓴다. `source`는 `"driver"`다. 합성 위치는 `"demo"`다. 같은 위치가 `vehicleStates[].truck`과 기본 차량에도 반영되고 `truck.locationSource`가 `"driver"`가 된다.
- 위치를 받은 날짜의 상태에는 `sourceData.driverLocationVersion`이 있다. 위치가 바뀌면 ETag도 바뀐다.

### `POST .../driver/photos`, `GET .../driver/photos/{photoId}`

- `multipart/form-data`의 `file` 한 개다. `image/jpeg` 또는 `image/png`이고 실제 내용도 그 형식이어야 한다. 최대 5 MiB다.
- 응답 `201 { "photoId": "서버가 만든 UUID", "bytes": 크기 }`.
- 저장 위치는 상태 디렉터리의 `photos/{date}/{photoId}.{jpg|png}`다. 날짜당 5000장까지다.
- `GET`은 원본 바이트와 원본 `Content-Type`을 돌려준다. `photoId`가 UUID 형식이 아니면 파일 접근 전에 `400 INVALID_PHOTO_ID`다.
- 사진은 올린 날짜 경로로만 받을 수 있다. 사진과 차량·기사의 소유 관계는 아직 검사하지 않는다.

### 기사 앱 조회

모두 `GET`이며 상태를 바꾸지 않는다. `vehicleId` 쿼리가 필요하다(`events/{eventId}`는 제외). 없으면 `400`, 없는 차량이면 `404 DRIVER_VEHICLE_NOT_FOUND`다.

`GET .../driver/route?vehicleId=G1`

```json
{
  "date": "2026-11-02", "vehicleId": "G1", "revision": 8, "phase": "delivering",
  "dispatchPhase": "published", "operable": true,
  "vehicle": { "vehicleId": "G1", "label": "(Z001) 기사", "plate": "12가 3456", "region": "서울 강서" },
  "stops": [{
    "stopId": "O1", "sequence": 1, "orderIds": ["O1", "O2"], "name": "가게A", "address": "서울 …",
    "boxes": 2, "status": "current", "eta": "2026-11-02T09:40:00+09:00", "estimated": true,
    "coordinates": [126.81, 37.56],
    "orders": [{
      "orderId": "O1", "status": "current", "orderNumber": "MB-1", "name": "가게A", "address": "서울 …",
      "detailAddress": "1층", "boxes": 1, "deliveryType": "fresh", "csNote": "오전 배송",
      "items": [{ "sku": "PK-001", "name": "삼겹살 1kg", "qty": 3, "boxes": 1, "barcode": "8801234567890" }],
      "customerRequests": null, "tip": null, "transportConditions": null, "access": { "entranceCode": "1234*" }
    }]
  }],
  "next": { "stopId": "O1", "eta": "2026-11-02T09:40:00+09:00" }
}
```

- `vehicle`은 이 차량의 표시 정보다. `dispatchPhase`는 날짜의 배차 단계이고 `operable`은 확정(`published`)이거나 수정 중(`amending`)이어서 운행할 수 있다는 뜻이다. 확정 전에는 `stops`가 비고 `operable: false`다.
- `stops[].coordinates`는 `[경도, 위도]`이고 묶음에서 좌표가 있는 첫 주문의 것이다. 없으면 `null`이다.
- `stops[].orders[]`는 그 배송지 묶음의 주문 전부다. 항목은 `GET stops/{stopId}`의 `orders[]`와 같다(같은 함수가 만든다). 값이 없는 필드는 `null`이다. 품목의 `barcode`는 미트박스가 주문에 실어 보낸 값이고 없으면 키가 없다.
- 서버는 `Accept-Encoding: gzip`을 보낸 요청의 `application/json` 응답을 1 KiB 이상일 때 압축한다(`server.compression`). 오류 본문(`application/problem+json`)과 스스로 압축하는 날짜 상태·원본 끝점은 한 번만 인코딩된다. `ETag`는 본문 해시의 약한 태그(`W/"route-…"`)이고 `If-None-Match`가 같으면 `304`다. 약한 태그인 이유는 Tomcat이 강한 ETag가 붙은 응답을 압축하지 않기 때문이다. 200개 배송지·600개 주문 규모에서 압축 전 1 MiB 미만이다.

`GET .../driver/vehicles`

```json
{
  "date": "2026-11-02", "dispatchPhase": "published", "operable": true,
  "vehicles": [
    { "vehicleId": "G1", "label": "(Z001) 기사", "plate": "12가 3456", "region": "서울 강서", "phase": "idle", "stops": 12, "orders": 31 }
  ]
}
```

- 세션만 필요하다. 그날의 모든 차량이고 `stops`는 배송지 묶음 수, `orders`는 주문 수다. 기사 앱의 차량 선택이 쓰며 다른 차량의 주문 내용은 담지 않는다.
- 날짜 형식이 틀리면 `400 INVALID_DATE`다.

- `revision`은 날짜 상태의 `revision`이며 `route_reordered`의 `expectedRevision`으로 보낸다.
- `temperature`는 오늘 날짜에 그 차량의 온도 값이 있을 때만 나온다: `{celsius, measuredAt, stale, outOfRange}`(날짜 상태의 같은 필드). 없으면 키가 없다.
- `phase`는 차량 phase(`idle`, `preparing`, `delivering`, `done`)다. `status`는 `pending`, `current`, `done`, `skipped`다.
- `eta`·`estimated`는 차량이 출발해 ETA를 계산한 뒤에 채워지고, 출발 전에는 둘 다 `null`이다. 출발 뒤에는 완료한 배송지도 출발 때 계산한 값을 그대로 보인다(재산출은 아직 없다). `estimated: false`는 좌표가 없어 이동 시간을 못 더한 값이다. `next`는 아직 끝나지 않은 첫 배송지이고 없으면 생략한다.

`GET .../driver/stops/{stopId}?vehicleId=G1`

- 위 요약 필드에 `eta`, `estimated`, `assignmentUnitId`, `orders[]`, `previousPhoto`를 더한다. 같은 묶음의 아무 주문 ID로 조회해도 된다.
- `orders[]`: `orderId`, `status`, `orderNumber`, `name`, `address`, `detailAddress`, `boxes`, `items`, `customerRequests`, `tip`, `transportConditions`, `access`. 원본에 없는 값은 `null`이다.
- 출입정보(`access`)는 지금은 그대로 노출한다. 권한 단위에서 제한한다.
- `previousPhoto`는 같은 `assignmentUnitId`로 가장 최근에 완료한 날의 첫 사진 `{ "photoId", "date", "completedAt" }`이고 없으면 `null`이다. 사진은 그 `date` 경로로 받는다. 최근 14일치 기사 상태 파일만 찾는다.
- 그 차량의 배송지가 아니면 `404 STOP_NOT_FOUND`다.

`GET .../driver/history?vehicleId=G1`

- `items[]`는 완료(`done`)·미배송(`skipped`) 배송지를 `completedAt` 순으로 담는다. 항목은 위 요약 필드에 `result`(`completed`, `partially_completed`, `failed`)와 `completedAt`을 더한다.
- `completedAt`은 운행 엔진이 기록한 시각이다. 앱 시계가 아니다.
- 앱 이벤트로 처리한 배송지는 `reasonCode`, `note`, `photoIds`, `items`, `scannedCodes`도 담는다.

`GET .../driver/events/{eventId}`

- `POST events`가 돌려준 `202` 본문과 같은 본문을 `200`으로 돌려주며 `duplicate`는 항상 `true`다. 없거나 보존 한도로 제거됐으면 `404 REQUEST_NOT_FOUND`다. `eventId` 형식이 틀리면 `400 INVALID_INPUT`이다.
- 날짜 명령의 `requestId`로 저장된 결과 중 이벤트가 아닌 것은 돌려주지 않는다.

### `POST .../driver/stops/{stopId}/tip`

기사가 배송지에 남기는 배송팁이다(요구서 47). 다음 기사와 운영자가 배송지 상세에서 읽는다. 세션과 정확한 `Origin`이 필요하고 쓰기 한도(분당 30)를 쓴다. `stopId`는 같은 묶음의 아무 주문 ID여도 된다.

```json
{ "vehicleId": "G1", "requestId": "3f1c…", "body": "뒷문 이용, 벨 없음" }
```

```json
{
  "accepted": true, "duplicate": false, "stopId": "O1",
  "tip": { "body": "뒷문 이용, 벨 없음", "author": "(Z001) 합성 기사", "updatedAt": "2026-11-02T09:12:00+09:00" }
}
```

- `body`는 1~500자 평문이다. 앞뒤 공백을 지우고 줄바꿈을 `\n`으로 맞춘다. `<`·`>`·제어문자는 `400 INVALID_OPERATION`이다. 지금 팁과 같은 내용도 `400 INVALID_OPERATION`(변경 없음)이다.
- 묶음의 모든 주문에 같은 팁이 들어가고 `author`는 차량 기사 라벨이다. 날짜 상태의 `orders[].tip`과 배송지 상세에 바로 보인다. 운행 이벤트에 `delivery_tip`으로 기록된다.
- 이미 완료·미배송으로 닫힌 묶음은 `409 OPERATION_REVISION_CONFLICT`다. 출발 전과 출발 뒤 대기·현재 배송지는 바꿀 수 있다.
- `requestId`는 영문·숫자·`-`·`_` 64자 이하다. 같은 `requestId`와 같은 요청의 재전송은 저장된 결과를 `duplicate: true`로 돌려주고 상태를 바꾸지 않는다. 같은 `requestId`에 다른 내용은 `409 REQUEST_ID_MISMATCH`다. 이벤트의 `eventId`와 같은 ID 공간을 쓴다.
- 그 차량의 배송지가 아니면 `404 STOP_NOT_FOUND`다.

### 자동 배송 순서 제안

`POST .../driver/route/suggest?vehicleId=G1`. 본문은 없거나 `{ "lockFirst": "O3" }`다. Origin 헤더와 세션이 필요하고, 읽기 한도(분당 120)를 쓴다. **제안만 한다.** 날짜 상태·이벤트 기록·송신함·ETA·`revision`을 바꾸지 않으며, 같은 상태에서 같은 요청은 같은 응답이다. 앱이 받아 `route_reordered`로 적용하고, 운영이 같은 순서를 `set_route_order`로 확정할 수 있다. 날짜 명령(`commands`)에는 두지 않았다. 운영도 이 끝점을 세션으로 쓴다.

```json
{
  "date": "2026-11-02", "vehicleId": "G1", "revision": 8,
  "stopOrder": ["O3", "O4", "O1"], "changed": true, "totalMinutes": 70, "totalKm": 24.8,
  "placed": [{ "stopId": "O4", "placed": "no-coordinates", "afterStopId": "O1" }]
}
```

- `stopOrder`는 전체 배송지 ID다. `revision`은 `GET route`와 같은 값이라 `route_reordered`의 `expectedRevision`으로 그대로 보낸다. `changed`는 지금 순서와 다른지다.
- `totalMinutes`는 열린 배송지 사이 이동 시간과 배송지당 작업 시간(`MEATBOX_ETA_SERVICE_MINUTES`)의 합이다. `totalKm`은 이동 시간을 평균 속도(`MEATBOX_ETA_SPEED_KMH`)로 환산한 도로 추정 거리다. 둘 다 직선거리 × 우회계수 모델의 값이라 실측이 아니다.
- 출발 전에는 모든 배송지를, 출발 뒤에는 `pending` 배송지만 옮긴다. 현재·완료·보류 배송지는 제 자리에 있다(`route_reordered`의 규칙과 같다). 종료된 경로는 `409 ROUTE_LOCKED`다.
- 시작점은 출발 전에 창고 좌표(`MEATBOX_ROUTE_DEPOT_LAT/LNG`), 없으면 기사 앱의 최신 위치다. 출발 뒤에는 최신 위치, 없으면 직전 닫힌 배송지, 없으면 창고다. 시작점이 없으면 첫 열린 배송지가 그대로 첫 자리에 남는다.
- 알고리즘은 시작점에서의 최근접 이웃 뒤 2-opt(최대 100회 반복, 배송지 200개 상한)다. 지금 순서보다 긴 순서는 제안하지 않는다(`lockFirst`가 있으면 제외).
- 좌표가 없는 배송지는 주소 앞 3어절이 같은 배송지 바로 뒤에, 없으면 열린 배송지의 맨 끝에 놓고 `placed`에 `no-coordinates`로 알린다. 배송지는 이미 `assignmentUnitId` 묶음이라 "같은 묶음 뒤"는 따로 없다.
- `lockFirst`는 열린 배송지 중 좌표가 있는 배송지(묶음의 아무 주문 ID)이고 열린 배송지의 첫 자리가 된다. 아니면 `400 INVALID_INPUT`, 이 차량의 배송지가 아니면 `404 STOP_NOT_FOUND`다.
- **한계.** 도로 데이터가 없어 좌회전 제한·간선도로 위주(요구서 62번의 휴리스틱)는 계산하지 않는다. 거리는 `TravelTimeEstimator` 한 곳에서만 나오므로 경로 API 구현체로 바꾸면 이 제안과 ETA가 같이 바뀐다. 2-opt는 구간을 뒤집으므로 오가는 시간이 다른 추정기라면 계산부를 다시 본다. 자동 주행 경로(63)는 범위 밖이다.

### 도착 예정 시각 (ETA)

`departed` 이벤트가 성공하면 서버가 그 차량의 남은 배송지마다 도착 예정 시각을 계산해 날짜 체크포인트의 `etas`에 저장한다. 외부 경로 API는 쓰지 않는다. 저장 형태(날짜 상태의 `vehicleStates[v].eta`와 같다):

```json
{
  "computedAt": "2026-11-02T09:12:10+09:00", "reason": "departed",
  "departedAt": "2026-11-02T09:12:03+09:00", "departureTimeSource": "device",
  "stops": [{ "stopId": "O1", "sequence": 1, "eta": "2026-11-02T09:40:00+09:00", "estimated": true }]
}
```

- 모델: 도착 = 출발 시각 + 첫 구간 이동. 이후 도착 = 직전 도착 + 배송지당 작업시간 + 이동. 이동 시간 = 직선거리(하버사인) × 우회계수 ÷ 평균속도. ETA는 분 단위로 반올림한다. 순서는 출발 때 확정된 경로 순서다.
- 출발 위치: 이벤트 `location`, 없으면 그 차량의 가장 최근 위치 샘플. 둘 다 없으면 첫 배송지 이동 시간을 0으로 두고 그 배송지는 `estimated: false`다. 합성 차량 좌표(`truck`)는 쓰지 않는다.
- 좌표 없는 배송지는 직전 도착에 작업시간만 더하고 `estimated: false`다. 다음 배송지의 이동은 마지막으로 좌표를 아는 배송지에서 이어 계산한다.
- 출발 시각: 이벤트 `occurredAt`. 서버 수신 시각과 5분(`MAX_CLOCK_SKEW_MILLIS`)보다 더 다르면 수신 시각을 쓴다. `departureTimeSource`는 `"device"` 또는 `"server"`다.
- 같은 `eventId` 재전송은 저장된 값을 바꾸지 않고 송신함에도 더하지 않는다. 한 차량에는 최신 ETA 하나만 남는다.

재산출(`departed` 뒤, 그 차량에 저장된 ETA가 있을 때만. 웹 명령으로 출발한 차량은 ETA가 없어 재산출하지 않는다):

| 트리거 | 기준 시각 | 기준 위치 | `reason` |
|---|---|---|---|
| `stop_completed`·`stop_partially_completed`·`stop_failed` | 이벤트 시각(5분 넘게 어긋나면 서버 시각) | 이벤트 `location`, 없으면 닫힌 배송지 좌표 | 닫힌 시각이 예정(그 배송지 ETA + 작업시간)과 임계 이상 다르면 `delayed`(이르거나 늦음), 아니면 `completed` |
| `zone_entered` | 같음 | 이벤트 `location`(필수) | `zone_entered` |
| 출발 후 `route_reordered` | 같음 | 이벤트 `location`, 없으면 최근 위치 샘플 | `reordered` |

- 남은(열린) 배송지만 다시 계산한다. 첫 남은 배송지는 "기준 시각 + 이동"이고 작업시간은 배송지 사이에만 더한다. `sequence`는 전체 경로의 위치다.
- 닫힌 배송지는 이전 `eta`를 그대로 두고 `actualAt`(실제 닫힌 시각)을 더한다. 필드 추가만 있고 이전 체크포인트는 그대로 읽힌다.
- 저장 필드가 늘었다: `recomputes`(재산출 횟수), `reported`(마지막으로 미트박스에 보낸 열린 배송지 ETA `[{stopId, eta}]`). `reported`는 메시지를 보낼 때만 바뀐다.
- 미트박스 메시지는 새 ETA가 `reported`와 임계 이상 벌어질 때만 남는다(`reordered`는 항상). 임계 미만이면 `etas`만 갱신한다. 미전송 ETA 메시지는 새 메시지로 교체된다. `reported`가 없는 이전 체크포인트는 첫 재산출에서 메시지를 남긴다.
- 상태의 `sourceData.etaVersion`(재산출 횟수 합)이 ETag에 `-e{n}`으로 들어간다. `zone_entered`는 엔진 명령이 없어 `revision`이 안 바뀌기 때문이다.
- 설정은 [운영](operations.md#도착-예정-시각-eta-설정-kotlin-api)에 있다.

### 배차 변경 푸시 (`route_changed`)

운영자의 날짜 명령 `publish_dispatch`(확정·수정안 적용), `reassign`, `set_route_order`가 성공하면 서버가 명령 전후의 차량별 주문 ID 순서를 비교하고, 주문이 추가·제외되었거나 상대 순서가 바뀐 차량의 등록된 기기에 FCM data 메시지를 한 건씩 보낸다. 기사 본인의 `route_reordered`와 `arrive_stop`·`complete_stop` 같은 진행 명령은 보내지 않는다.

- data: `type: "route_changed"`, `date`, `vehicleId`, `messageId: "route-{revision}"`, `title: "미트박스 배송"`, `body`(예: `배차가 변경되었습니다. 주문 추가 2건 · 제외 1건 · 순서 변경`). 본문에는 건수만 들어가고 고객 정보는 없다.
- 발송은 디스패치 락 밖의 별도 스레드에서 한다. 명령 응답은 푸시를 기다리지 않고, 푸시 실패·FCM 미설정은 로그만 남기며 명령을 되돌리지 않는다. 앱은 전경으로 돌아올 때마다 상태를 다시 읽으므로 푸시를 놓쳐도 최신 경로를 본다.
- 앱은 받으면 날짜 상태와 `GET route`를 다시 읽고 `body`를 배너로 보여 준다.

### 기사 앱 끝점 오류

| 상태 | 코드 | 의미 |
|---|---|---|
| `400` | `INVALID_INPUT` | 봉투·payload·샘플 형식이 잘못됨. `date` 불일치 포함 |
| `400` | `INVALID_EVENT_TYPE` | 정해지지 않은 `type` |
| `400` | `INVALID_REASON_CODE` | 정해지지 않은 `reasonCode` |
| `400` | `LOCATION_REQUIRED` | ETA가 저장된 차량의 `zone_entered`에 `location`이 없음 |
| `400` | `PHOTO_NOT_FOUND` | `photoIds`에 올리지 않은 사진이 있음 |
| `400` | `INVALID_PHOTO_ID` | `photoId`가 UUID 형식이 아님 |
| `404` | `PHOTO_NOT_FOUND` | `GET`으로 없는 사진을 요청함 |
| `422` | `ZONE_MISMATCH` | `zone_entered`의 위치가 그 `zoneId` 폴리곤 밖. 저장하지 않으며 같은 `eventId`로 다시 보내도 같다 |
| `404` | `STOP_NOT_FOUND` | 이 차량의 배송지가 아님 |
| `404` | `DRIVER_VEHICLE_NOT_FOUND` | 없는 차량 |
| `409` | `ROUTE_LOCKED` | 경로가 끝났거나, 출발한 차량의 현재·완료·보류 배송지를 옮기는 순서 변경 |
| `409` | `REVISION_CONFLICT` | `expectedRevision`이 현재와 다름 |
| `409` | `OPERATION_REVISION_CONFLICT` | 운행 상태 기계가 거부한 역행·순서 위반 |
| `409` | `REQUEST_ID_MISMATCH` | 같은 `eventId`에 다른 본문 |
| `409` | `DISPATCH_NOT_PUBLISHED` | 배차를 전송하기 전 |
| `409` | `DRIVER_DATE_READ_ONLY` | 과거 날짜 |
| `409` | `SOURCE_CHANGED` | 날짜 원본이 바뀌어 운영자 확인을 기다린다. 앱의 대기 중 보고는 지워지지 않는다 |
| `409` | `PHOTO_CAPACITY` | 날짜당 사진 5000장 초과 |
| `413` | `DRIVER_BODY_TOO_LARGE`, `PHOTO_TOO_LARGE` | 본문 또는 사진이 한도를 넘음 |
| `415` | `UNSUPPORTED_PHOTO_TYPE` | jpeg·png가 아님 |
| `503` | `DRIVER_STATE_WRITE_FAILED`, `DRIVER_PHOTO_WRITE_FAILED` | 저장 실패. 같은 요청을 다시 보낸다 |

## 미트박스 주문 수신 (Kotlin API 전용)

### `POST /api/meatbox/orders`

미트박스가 주문을 밀어 넣는다([연동 계약](integration-contract.md) 4절). 세션 쿠키가 아니라 `Authorization: Bearer <MEATBOX_INBOUND_TOKEN>`을 쓰고 `Origin` 검사는 없다. `MEATBOX_INBOUND_TOKEN`이 비어 있으면 경로가 없다(`404 NOT_FOUND`). 본문은 `application/json` 최대 1 MiB, 헤더 `Idempotency-Key`는 `{orderId}:{version}`과 같아야 한다.

```json
{
  "orderId": "MB-20261102-48213", "version": 1, "status": "active", "deliveryDate": "2026-11-02",
  "deliveryType": "fresh",
  "customer": { "name": "○○정육", "phone": "010-0000-0000" },
  "address": { "road": "서울 강남구 테헤란로 1", "detail": "지하 1층 주방", "lat": null, "lng": null },
  "access": { "entranceCode": "1234*", "placeNote": "뒷문" },
  "items": [{ "sku": "PK-001", "name": "삼겹살 1kg", "qty": 3, "boxes": 1, "weightKg": 3.2, "barcode": "8801234567890" }],
  "csNote": "오전 중 배송 요청"
}
```

- 필수: `orderId`(`A-Za-z0-9._-` 1~64자), `version`(1 이상 정수), `status`(`active`·`cancelled`), `deliveryDate`(`YYYY-MM-DD`, 서울 오늘 이후). `cancelled`는 이 네 개면 된다.
- `active`는 추가로 `deliveryType`(`fresh`·`parcel`), `customer.name`, `address.road`, `items`(1~200개, 각 `sku`·`qty`≥0·`boxes`≥0)가 필요하다. `address.lat`·`lng`는 둘 다 있거나 둘 다 없어야 하고, 없으면 `coordinates: null`로 들어간다(좌표화는 하지 않는다). `boxes`는 `items[].boxes`의 합이다. `customer.phone`은 저장만 하고 날짜 JSON에는 넣지 않는다.
- 같은 날짜의 주문은 날짜 상태와 배차에서 그 날짜의 원본이 된다. 변경·취소가 배차 상태별로 어떻게 반영되는지는 [도메인과 상태](domain-and-state.md#미트박스가-보낸-주문api-원본)에 있다.

응답은 첫 수신·새 version이면 `202`, 중복·무시면 `200`이다.

```json
{
  "accepted": true, "duplicate": false, "ignored": false, "applied": true, "draftReset": false,
  "held": null, "orderId": "MB-20261102-48213", "version": 1, "date": "2026-11-02", "sourceId": "api-3f…"
}
```

- `applied`: 배차가 보는 주문에 반영했는가. 확정 이후에는 `false`다.
- `held`: 반영하지 않고 경고로 남긴 이유(`ORDER_CHANGED_AFTER_DISPATCH`, `ORDER_CANCELLED_AFTER_DISPATCH`, `ORDER_ADDED_AFTER_DISPATCH`, `ORDER_CHANGED_AFTER_COMPLETION`). 운영 알림 `meatbox-inbound`이 같이 나간다.
- `draftReset`: 계산안을 버렸는가. 경고 `DRAFT_RESET_BY_INBOUND`가 날짜 상태 `sourceData.inbound.warnings`에 남는다.
- 마지막으로 받은 version보다 낮으면 `ignored: true`, 같은 version·같은 본문이면 `duplicate: true`다.

| 상태 | `code` | 의미 |
|---|---|---|
| `400` | `INVALID_ORDER` | 본문 형식·필드 오류. `detail`에 필드 이름 |
| `400` | `IDEMPOTENCY_KEY_MISMATCH` | 헤더가 없거나 `orderId:version`과 다름 |
| `401` | `INBOUND_UNAUTHORIZED` | Bearer 토큰이 없거나 다름. `WWW-Authenticate: Bearer` |
| `404` | `NOT_FOUND` | `MEATBOX_INBOUND_TOKEN`이 설정되지 않음 |
| `409` | `ORDER_VERSION_CONFLICT` | 같은 version에 다른 본문 |
| `409` | `SOURCE_CONFLICT` | 그 날짜의 원본이 준비된 CSV 묶음 |
| `413` | `ORDER_TOO_LARGE` | 본문이 1 MiB를 넘음 |
| `415` | `INVALID_ORDER` | `Content-Type`이 `application/json`이 아님 |
| `422` | `DELIVERY_DATE_PAST` | 지난 날짜 |
| `422` | `DELIVERY_DATE_CHANGE_UNSUPPORTED` | 이미 받은 주문의 `deliveryDate`가 바뀜 |
| `422` | `INBOUND_DAY_FULL` | 한 날짜 5000건 또는 16 MiB 초과 |
| `500` | `INBOUND_WRITE_FAILED`, `DISPATCH_STATE_WRITE_FAILED` | 저장 실패. 같은 요청을 다시 보내면 된다 |

날짜 조회·상태(`manifest`, `days/{date}`, `state`)는 미트박스 날짜를 같은 모양으로 돌려준다. `manifest.dates[]`에는 `source: "api"`, `orders`, `boxes`가 붙고, 상태의 `sourceData.inbound`(`kind`, `stamp`, `received`, `applied`, `warnings[]`)가 추가된다. 상태 ETag에는 `stamp`가 들어가 주문이 바뀌면 `304`가 나지 않는다.

## 온도 단말 수신과 조회 (Kotlin API 전용)

STEGO 단말의 통신 방식·수신 규격은 정해지지 않았다. 이 끝점은 단말 규격과 무관한 **일반 본문**이다. 단말 전용 변환은 이 본문을 만들어 보내는 어댑터(`integrations/stego/`, 아직 없음)가 맡는다.

### `POST /api/telemetry/temperature`

세션 쿠키가 아니라 `Authorization: Bearer <MEATBOX_TELEMETRY_TOKEN>`을 쓰고 `Origin` 검사는 없다. 토큰은 미트박스 주문 토큰·기사 세션과 별개다. `MEATBOX_TELEMETRY_TOKEN`이 비어 있으면 경로가 없다(`404 NOT_FOUND`). 본문은 `application/json` 최대 128 KiB다.

```json
{
  "vehicleId": "V-021", "sensorId": "STEGO-7731",
  "measurements": [
    { "measuredAt": "2026-11-02T09:12:00+09:00", "celsius": -18.4, "compartment": "frozen" },
    { "measuredAt": "2026-11-02T09:12:30+09:00", "celsius": -18.1 }
  ]
}
```

- `vehicleId`·`sensorId`는 `A-Za-z0-9._-` 1~64자다(`vehicleId`는 `latest`가 아니어야 한다). `measurements`는 1~500건이다. 알 수 없는 키는 거절한다.
- `measuredAt`은 오프셋이 있는 ISO 시각이고 초 단위로 내려 저장한다. `celsius`는 -60~60 숫자다. `compartment`는 선택이고 `frozen`·`chilled`만 받는다.
- 한 건이라도 틀리면 본문 전체를 거절하고 아무것도 저장하지 않는다.
- 같은 `sensorId`·같은 초의 측정은 이미 있는 것으로 보고 무시한다. 그래서 같은 배치를 다시 보내도 처음과 같은 `202`이고 `accepted`만 0이다. `Idempotency-Key`는 받아서 형식만 검사하고(`A-Za-z0-9._:-` 1~128자) 저장하지 않는다.
- 응답은 `202`다.

```json
{ "accepted": 2, "duplicate": 0, "receivedAt": "2026-11-02T09:12:31+09:00", "unknownVehicle": false }
```

- `unknownVehicle`은 자원 등록부가 켜져 있고 그 `vehicleId`가 등록부에 없을 때 `true`다. 이때도 저장하며, 알림 `telemetry` / `UNKNOWN_VEHICLE`을 보낸다(10분에 한 번). 등록부가 꺼져 있으면 `false`다.

| 상태 | `code` | 원인 |
|---|---|---|
| `400` | `INVALID_TELEMETRY` | 본문 형식·키·시각·`compartment` 오류 |
| `400` | `TEMPERATURE_OUT_OF_BOUNDS` | `celsius`가 -60~60 밖 |
| `400` | `MEASURED_AT_FUTURE` / `MEASURED_AT_TOO_OLD` | 서버 시각보다 5분 넘게 미래 / 7일보다 오래됨 |
| `400` | `INVALID_IDEMPOTENCY_KEY` | 헤더 형식 오류 |
| `401` | `TELEMETRY_UNAUTHORIZED` | 토큰 없음·틀림 (`WWW-Authenticate: Bearer`) |
| `409` | `TELEMETRY_CAPACITY` | 그 차량의 그날 파일이 100,000줄을 넘음 |
| `413` | `TELEMETRY_TOO_LARGE` | 본문 128 KiB 초과 |
| `415` | `INVALID_TELEMETRY` | `Content-Type`이 JSON이 아님 |
| `503` | `TELEMETRY_WRITE_FAILED` / `TELEMETRY_BUSY` | 파일 쓰기 실패 / 쓰기 잠금을 1초 안에 못 얻음. 단말이 같은 본문을 다시 보낸다 |

### `GET /api/telemetry/temperature/latest`

세션이 필요하다. 지금까지 값을 보낸 모든 차량·센서의 최신 값이다. `range`는 그 값에 적용되는 허용 범위(`min`·`max`, 한쪽은 `null`일 수 있다)이고 정해진 범위가 없으면 `null`이며 그 센서는 판정하지 않는다. `outOfRange`는 연속 3개 측정이 범위를 벗어나 확정된 상태다(아래 규칙). `stale`은 마지막 수신이 `MEATBOX_TELEMETRY_STALE_MINUTES`(기본 10분)보다 오래됐을 때 `true`다. 단말 시계가 아니라 서버가 받은 시각 기준이다.

```json
{
  "generatedAt": "2026-11-02T09:13:00+09:00",
  "vehicles": [{
    "vehicleId": "V-021", "sensorId": "STEGO-7731", "celsius": -18.1,
    "measuredAt": "2026-11-02T09:12:30+09:00", "receivedAt": "2026-11-02T09:12:31+09:00",
    "ageSeconds": 29, "stale": false, "outOfRange": false, "range": { "min": null, "max": -18.0 },
    "compartment": "frozen"
  }]
}
```

**허용 범위와 이탈 판정.** 범위는 ①측정의 `compartment`, ②`{state-dir}/telemetry/ranges.json`의 차량 항목, ③`MEATBOX_TELEMETRY_DEFAULT_KIND` 순으로 정한다. `frozen`은 -18 이하, `chilled`는 0~5(양 끝 포함)다. 셋 다 없으면 판정하지 않는다. 연속 3개 측정이 범위 밖이면 `outOfRange`가 되고 알림 `telemetry` / `OUT_OF_RANGE`를 한 번 보낸다. 범위 안 측정 하나로 풀린다. 단말 재전송처럼 stale 창보다 오래된 측정은 판정에 쓰지 않는다. 상태는 메모리에만 있어 재시작 뒤 아직 이탈 중이면 3개를 다시 받아야 확정된다.

### `GET /api/telemetry/temperature/{vehicleId}?from=&to=&resolution=`

세션이 필요하다. `from`·`to`는 오프셋이 있는 ISO 시각이다. `to`를 빼면 지금이다. 범위는 24시간을 넘을 수 없고 `to`가 `from`보다 뒤여야 한다(`400 INVALID_RANGE`). `resolution`은 `raw`(기본)나 `1m`이고 다른 값은 `400 INVALID_RESOLUTION`, 형식이 틀린 `vehicleId`는 `400 INVALID_VEHICLE`이다. 저장된 값이 없으면 빈 목록이다.

- `raw`: 측정 시각 순으로 최대 5,000건이고 넘으면 `truncated: true`다. 항목은 `sensorId`, `measuredAt`, `celsius`, `compartment`(있을 때).
- `1m`: 센서별로 분 단위로 묶어 `measuredAt`(그 분의 시작), `celsius`(평균, 소수 첫째 자리), `min`, `max`, `count`를 준다.

## 미트박스 송신 현황과 모의 수신기 (Kotlin API 전용)

### `GET /api/ops/outbox?date=YYYY-MM-DD`

세션이 필요하다(`/api/ops/*` 공통). 날짜 체크포인트의 송신함(`outbox`)을 요약한다. 없는 날짜는 `404 DISPATCH_DATA_NOT_FOUND`, 날짜 형식 오류는 `400 INVALID_DATE`, 날짜 상태 모듈이 꺼져 있으면 `503 OUTBOX_UNAVAILABLE`이다.

```json
{
  "date": "2026-11-02", "pending": 1, "failed": 0, "sent": 8,
  "recent": [{
    "messageId": "2026-11-02-6-MB-1", "kind": "delivery-status", "orderId": "MB-1", "attempts": 2,
    "lastStatus": "503", "nextAttemptAt": "2026-11-02T10:41:20+09:00", "sentAt": null, "failedAt": null
  }]
}
```

- `pending`은 미전송(재시도 대기 포함), `failed`는 `4xx` 거절로 멈춘 건, `sent`는 전송 완료 건이다. 완료·거절 건은 24시간, 최대 1000건까지 남는다. 미전송 건은 지우지 않는다.
- `recent`는 가장 늦게 쌓인 순 20건이다. `lastStatus`는 HTTP 상태 코드 또는 `timeout`·`connect-failed`다.
- 주문 본문·사진 URL·토큰은 넣지 않는다.

### `POST /api/ops/days/{date}/source-conflict/resolve`

세션이 필요하고 `Origin`이 공개 origin과 같아야 한다(`403 ORIGIN_REQUIRED`). 본문은 `{"action": "keep-checkpoint" | "discard-checkpoint"}`다. 서버는 어느 쪽도 자동으로 고르지 않는다. 누가 어느 날짜에 무엇을 골랐는지 서버 로그(INFO)에 남는다.

| action | 하는 일 |
|---|---|
| `keep-checkpoint` | 저장된 계획을 현재 원본(`sourceId`·`contentHash`)에 다시 묶는다. 계획 내용·`revision`은 그대로다. `published`·`amending`이면 `409 SOURCE_CHANGE_UNSAFE`로 거절한다. 새 원본이 저장된 계획을 담을 수 없으면(차량 구성이 다름 등) `409 SOURCE_CHANGE_INCOMPATIBLE`이다 |
| `discard-checkpoint` | 체크포인트를 삭제하지 않고 `{date}.json.discarded-{UTC시각}`로 옮기고 그 날짜를 미계획으로 되돌린다. 백업에는 명령 결과·송신함(미전송 메시지 포함)·ETA가 그대로 있다 |

성공하면 `200 {"date", "action", "previousPhase", "backup"}`이다(`backup`은 discard일 때만 파일 이름). 충돌이 없으면 `409 NO_SOURCE_CONFLICT`, 모르는 action은 `400 INVALID_ACTION`, 날짜 형식 오류는 `400 INVALID_DATE`, 원본이 없으면 `404 DISPATCH_DATA_NOT_FOUND`다. 거절된 요청은 파일을 바꾸지 않는다. 새 충돌은 운영 알림(kind `dispatch`, code `SOURCE_CHANGED`)으로 한 번 알리고 같은 코드는 10분 창에서 합친다.

### `GET /api/ops/telemetry`

세션이 필요하다. 온도 메시지의 송신함(차량별 `telemetry/{vehicleId}/outbox.json`)을 요약한다. 날짜 상태 모듈이 꺼져 있으면 경로가 없다. 메시지 본문은 넣지 않는다.

```json
{ "vehicles": [{ "vehicleId": "V-021", "pending": 0, "failed": 0, "sent": 12 }], "pending": 0, "failed": 0, "sent": 12 }
```

`pending`은 미전송(재시도 대기 포함), `failed`는 `4xx` 거절로 멈춘 건, `sent`는 전송 완료 건이다. 완료·거절 건은 24시간, 최대 1000건까지 남는다.

### 운영 데이터 내보내기 `/api/ops/export` (Kotlin API 전용)

계약 종료 때 보관 데이터를 한 파일로 내려받는다. 형식은 [내보내기 형식](data-export-format.md), 절차는 [운영 런북](operations.md)을 따른다. 모든 경로에 세션이 필요하다(`/api/ops/*` 공통, 없으면 `401 LOGIN_REQUIRED`). 날짜 상태 모듈이 꺼져 있으면 `503 EXPORT_UNAVAILABLE`이다. 아카이브에 고객 전화번호·출입 정보가 들어 있으므로 시작과 다운로드마다 서버 로그에 사용자 이름이 한 줄 남는다(`EXPORT_START`·`EXPORT_DOWNLOAD`).

`POST /api/ops/export` — 본문(선택): `{"from":"2026-10-01","to":"2026-10-31","include":["orders","dispatch","driver","photos","telemetry","resources"]}`. 세 필드 모두 선택이다. 날짜는 양끝 포함이고 생략하면 전체다. `include`를 생략하면 여섯 묶음 전부다.

```json
{ "jobId": "5f1c…", "state": "running", "requestedBy": "alice", "createdAt": "2026-10-16T08:00:00Z",
  "range": { "from": "2026-10-01", "to": "2026-10-31" }, "include": ["orders", "dispatch"] }
```

- `202`로 작업을 시작하고 바로 답한다. 서버가 `{state-dir}/exports/{jobId}.zip`을 비동기로 만든다.
- 동시에 하나만 돈다. 이미 도는 작업이 있으면 `409 EXPORT_IN_PROGRESS`.
- 남은 디스크가 대상 파일 크기의 2배보다 작으면 `507 EXPORT_DISK_SPACE`(아무것도 쓰지 않는다).
- 날짜 형식·순서 오류, 모르는 필드, 모르는 묶음 이름은 `400 INVALID_EXPORT`.

`GET /api/ops/export/{jobId}` — `state`는 `running`·`done`·`failed`. 끝나면 `finishedAt`, `bytes`, `sha256`과 `download` 경로가 붙는다. 실패하면 `error`(예외 종류만)가 붙는다. 없는 `jobId`는 `404 EXPORT_NOT_FOUND`. `GET /api/ops/export`는 `{"exports":[…]}`(최근 순)이다. 서버를 다시 시작해도 끝난 작업은 남는다.

`GET /api/ops/export/{jobId}/download` — `application/zip`을 스트리밍한다(`Content-Disposition: attachment`). 끝나지 않은 작업은 `409 EXPORT_NOT_READY`.

끝난 아카이브와 기록은 7일 뒤 자동으로 지운다(6시간마다 점검, 새 작업 시작 때도 점검).

### 모의 수신기 `/mock/meatbox/*` (테스트 전용)

미트박스 명세가 오기 전 PoC용 수신기다([연동 계약](integration-contract.md) 5·7.4절). `meatbox.mock-receiver.enabled=true`(`MEATBOX_MOCK_RECEIVER_ENABLED`)일 때만 뜨고, 꺼져 있으면 모든 경로가 `404`다. **세션도 인증도 없다.** 운영 설정에 켜지 않는다.

| 방법 | 경로 | 동작 |
|---|---|---|
| `POST` | `/mock/meatbox/delivery-status` 또는 `/mock/meatbox/tms/delivery-status` | 계약 3.1 본문 검사 후 `202 {"accepted":true}` |
| `POST` | `/mock/meatbox/eta` (`.../tms/eta`) | 계약 3.2 본문 검사 후 `202` |
| `POST` | `/mock/meatbox/temperature` (`.../tms/temperature`) | 계약 3.3 본문 검사 후 `202` |
| `GET` | `/mock/meatbox/received?kind=` | 받은 메시지(시간순, 최근 200건). `kind`는 `delivery-status`·`eta`·`temperature`. 항목은 `kind`, `idempotencyKey`, `receivedAt`, `body` |

- 송신기는 `{MEATBOX_API_BASE_URL}/tms/<종류>`로 보내므로, 모의 수신기를 쓸 때 기본 주소는 `http://127.0.0.1:<포트>/mock/meatbox`다.
- 필수 키: 배송 상태 `messageId`·`orderId`·`status`·`occurredAt`·`vehicleId`(`status`는 계약 6종 중 하나), ETA `messageId`·`vehicleId`·`computedAt`·`reason`·`stops`(배열), 온도 `messageId`·`vehicleId`·`sensorId`·`measurements`(배열).
- 오류는 `400` problem+json이다. `IDEMPOTENCY_KEY_REQUIRED`(헤더 없음), `IDEMPOTENCY_KEY_MISMATCH`(헤더 ≠ 본문 `messageId`), `INVALID_BODY`(필수 키·값 오류), `INVALID_KIND`(`received`의 `kind`).
- 같은 `Idempotency-Key`를 다시 받으면 `202`로 답하되 목록에는 한 번만 남는다. 목록은 프로세스 메모리에만 있다.

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
