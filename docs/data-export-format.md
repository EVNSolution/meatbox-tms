# 운영 데이터 내보내기 형식

계약 종료 때 미트박스에 넘기는 아카이브의 형식 명세다 (업무요구서 20번). 아카이브 하나로 주문·배차·운행 이력·사진·온도·자원을 다른 시스템에서 복원할 수 있다. 만드는 방법과 절차는 [운영 런북](operations.md)의 "계약 종료 데이터 내보내기"를 따른다.

## 한눈에

- 파일은 `.zip` 하나다 (ZIP64, 4GB 초과 가능). Windows·macOS·Linux 기본 도구로 열린다.
- 최상위 `manifest.json`이 파일 목록·크기·SHA-256·건수를 담는다. 먼저 이 파일로 검증한다.
- JSON 파일은 UTF-8이다. `.jsonl`은 한 줄에 JSON 하나다.
- **시간대는 모두 `Asia/Seoul`(+09:00)이다.** ISO 8601 오프셋 문자열(`2026-10-14T09:12:03+09:00`)을 쓰는 필드는 그렇게 적었다. `…At`이 숫자(밀리초)이면 Unix epoch 밀리초(UTC)다.
- **제외한다:** 로그인 계정·비밀번호 해시·초대 코드·세션, 기사 앱 푸시 토큰·세션 해시·사용자 이름·장치 ID, 환경 변수와 비밀값.
- **들어 있다:** 고객 이름·전화번호·주소·출입 정보·배송 메모, 기사 위치, 사진. 개인정보이므로 받는 쪽이 보관·접근 기준을 정한다.

## 디렉터리

```
manifest.json
orders/{date}.json                  미트박스가 보낸 주문 (받은 값 + 반영된 값)
source/{date}.json                  그 날짜 배차가 쓴 주문 원본(day JSON)
dispatch/{date}.json                날짜 배차 상태 체크포인트 원본
dispatch/{date}.summary.json        사람이 읽는 요약 (차량별 경로·상태·시각·ETA·사유)
driver/{date}.json                  기사 앱 이벤트·위치·메시지 (토큰 제외)
photos/{date}/{photoId}.jpg|png     배송 사진 원본
photos/index.json                   사진이 어느 주문·배송지에 붙었는지
telemetry/{vehicleId}/{date}.jsonl  온도 측정값 (하루 한 파일, 차량별)
telemetry/{vehicleId}/outbox.json   온도 송신 상태
telemetry/ranges.json               차량별 허용 온도 범위 (있을 때만)
resources/vehicles.json             차량 등록부
resources/region-codes.json         지역 코드
resources/driver-profiles.json      기사 기준정보 (개인정보 포함, 있을 때만)
```

`{date}`는 배송일 `YYYY-MM-DD`다. 범위를 주면 그 범위(양끝 포함)의 날짜 파일만 들어간다. `resources/`·`telemetry/*/outbox.json`·`telemetry/ranges.json`은 날짜가 없어 항상 전체가 들어간다. 해당 데이터가 없으면 파일이 없다.

## manifest.json

| 필드 | 뜻 |
|---|---|
| `schemaVersion` | 이 문서의 형식 버전. 지금 `1` |
| `exportedAt` | 만든 시각 (+09:00) |
| `timezone` | 항상 `Asia/Seoul` |
| `serverVersion`, `serverCommit` | 만든 서버의 버전과 커밋. 빌드 정보가 없으면 `unknown` |
| `range` | `{from, to}` 요청 범위. 없으면 `null` (전체) |
| `include` | 들어간 묶음: `orders`·`dispatch`(+`source`)·`driver`·`photos`·`telemetry`·`resources` |
| `counts` | `orders`(주문 건수, `orders/` 파일의 `order` 배열 길이 합), `dispatchDates`, `driverDates`, `photos`(사진 파일 수), `telemetryReadings`(측정 줄 수), `vehicles`, `regionCodes`, `driverProfiles`(기사 기준정보 수) |
| `files[]` | `path`, `size`(바이트), `sha256`(소문자 16진), 선택 `changedDuringExport` |
| `warnings[]` | 일부 파일을 못 넣은 이유. 비어 있어야 완전하다 |

`manifest.json` 자신은 `files`에 없다. 범위에 아무것도 없으면 `files`가 비고 `counts`가 모두 `0`이다.

**`changedDuringExport: true`** — 서버가 운영 중에 내보내므로, 읽는 동안 그 파일이 바뀌었다는 표시다. 파일 내용은 읽기 시작 시점의 완전한 상태이거나(JSON), 완전한 줄까지의 앞부분이다(`.jsonl`). 더 새 내용이 있을 수 있으니 필요하면 다시 내보낸다. 운영 중단 상태(서버 중지)에서 만들면 표시가 없다.

## 파일별 형식

### orders/{date}.json
미트박스가 `POST /api/meatbox/orders`로 보낸 주문의 날짜별 저장본이다.

| 필드 | 뜻 |
|---|---|
| `schemaVersion` | `1` |
| `date` | 배송일 |
| `stamp` | 이 파일이 바뀔 때마다 1씩 오르는 번호 |
| `order` | 주문 ID 목록 (처음 받은 순서) |
| `orders.{orderId}.received` | 마지막으로 받은 버전: `version`, `status`(`active`·`cancelled`), `hash`, `at`(받은 시각, epoch 밀리초), `order`(본문 전체), `phone`(고객 전화번호) |
| `orders.{orderId}.applied` | 배차에 반영된 버전. 같은 필드(`hash` 제외). 배차 확정 뒤 온 새 버전은 `received`만 바뀐다 |
| `warnings[]` | 반영하지 못한 이유: `code`, `orderId`, `version`, `at`(epoch 밀리초). 최근 것만 남는다 |

### source/{date}.json
그 날짜 배차가 실제로 쓴 주문 원본이다. `sourceId`가 `dispatch/{date}.json`의 `sourceId`와 짝이다. 준비된 CSV 자료에서 온 날짜도 같은 형식으로 들어가므로, 주문이 `orders/`에 없어도 배차를 복원할 수 있다. 필드: `date`, `summary{orders, boxes}`, `groups[]`(차량 후보 `id`·`label`·`regionNames`), `orders[]`(`id`, `groupId`, `name`, `address`, `boxes`, `sequence`, `coordinates`[경도, 위도], `zoneIds`).

### dispatch/{date}.json
서버가 쓰는 체크포인트 그대로다. 복원은 이 파일을 새 상태 디렉터리의 `{date}.json`으로 두면 된다.

| 필드 | 뜻 |
|---|---|
| `schemaVersion` | `2` |
| `date`, `sourceId` | 날짜와 원본 식별자(`source/`와 짝) |
| `revision` | 명령이 적용될 때마다 1씩 오르는 번호 |
| `phase` | `unplanned`·`draft`·`published`·`amending` |
| `draftVersion`, `confirmedVersion` | 계산안·확정본 번호 |
| `stateTimestamp` | 운행 엔진 시계(epoch 밀리초) |
| `candidateIds`, `draftAssignments` | 후보 차량과 계산안 배정 |
| `confirmedEngineCheckpoint` | 확정 배차와 운행 상태: 경로·주문 상태·완료/도착 시각·이벤트. 엔진 내부 형식이므로 읽기에는 요약 파일을 쓴다 |
| `commandResults[]` | 처리한 명령의 요청 ID별 저장 응답 (재전송 방지용, 24시간) |
| `outbox[]` | 미트박스로 보낼/보낸 배송 상태·ETA 메시지: `messageId`, `kind`, `orderId`, `body`, `attempts`, `createdAt`·`nextAttemptAt`·`sentAt`·`failedAt`(epoch 밀리초, 미해당 `null`), `lastStatus` |
| `etas.{vehicleId}` | 차량별 최신 ETA: `computedAt`, `reason`, `departedAt`, `stops[{stopId, sequence, eta, estimated, actualAt?}]` |

### dispatch/{date}.summary.json
체크포인트에서 파생한 읽기용 요약이다. 원본에 없는 정보는 없다.

| 필드 | 뜻 |
|---|---|
| `date`, `revision`, `phase`, `sourceId` | 체크포인트와 같다 |
| `vehicles[].vehicleId`, `plate`, `driver` | 차량 ID, 번호판, 기사 표시 이름 |
| `vehicles[].etaComputedAt` | 그 차량 ETA를 계산한 시각 (없으면 빈 문자열) |
| `vehicles[].stops[]` | 방문 순서대로. `sequence`(1부터), `orderId`, `name`, `address`, `boxes`, `status`(`pending`·`current`·`done`·`skipped`), `arrivedAt`·`completedAt`(**`HH:mm` 시계 문자열, 서울 시각**, 날짜는 파일의 `date`), `eta`(ISO, +09:00) |
| `vehicles[].stops[].closedBy` | 그 배송지를 닫은 기사 이벤트(있을 때): `eventId`, `type`(`stop_completed`·`stop_failed`·`stop_partially_completed`), `occurredAt`(ISO, 기기 시각), `reasonCode`(`ABSENT`·`ACCESS_DENIED`·`ADDRESS_MISMATCH`·`REFUSED`·`NO_STORAGE`·`OTHER`), `note`, `photoIds` |

### driver/{date}.json
기사 앱이 보낸 것의 날짜별 저장본이다.

| 필드 | 뜻 |
|---|---|
| `schemaVersion` | `2` |
| `devices[]` | 등록 장치. **`vehicleId`, `platform`(`android`)만** 남긴다. 푸시 토큰·세션 해시·사용자 이름·장치 ID는 뺀다 |
| `messages[]` | 관제↔기사 메시지: `id`, `vehicleId`, `from`(`ops`·`driver`), `body`, `createdAt`(ISO) |
| `events[]` | 기사 이벤트(오래된 것부터, 파일당 최대 3000건): `eventId`, `type`, `vehicleId`, `occurredAt`(기기 시각), `receivedAt`(서버 시각), `stopId`, `assignmentUnitId`, `orderIds`, `location{lat,lng,accuracyM}`, 종류별 `photoIds`·`note`·`reasonCode`·`items`·`scannedCodes`·`stopOrder`·`zoneId` |
| `locations.{vehicleId}[]` | 위치 샘플(차량당 최근 120건): `at`(ISO), `lat`, `lng`, `accuracyM`(m) |
| `locationVersion` | 위치를 받을 때마다 오르는 번호 |

### photos/{date}/{photoId}.jpg|png, photos/index.json
사진 원본이다. 파일 이름의 `photoId`는 서버가 만든 UUID다. 색인:

| 필드 | 뜻 |
|---|---|
| `photos[].photoId`, `date` | 사진 ID와 올린 날짜 |
| `photos[].file` | 아카이브 안 경로. 이벤트가 가리키는데 파일이 없으면 `null` |
| `photos[].eventId`, `type`, `vehicleId`, `stopId`, `occurredAt`, `orderIds` | 그 사진을 붙인 기사 이벤트와 배송지·주문. 이벤트가 없으면 `eventId`만 `null` (올렸지만 어느 이벤트에도 안 붙은 사진) |

### telemetry/{vehicleId}/{date}.jsonl
`{date}`는 **측정 시각의 서울 날짜**다. 한 줄이 측정 하나다.

| 키 | 뜻 |
|---|---|
| `t` | 측정 시각 (ISO, +09:00) |
| `c` | 섭씨 온도 (°C) |
| `s` | 센서 ID |
| `k` | 칸 종류(예 `frozen`·`chilled`), 없을 수 있다 |
| `r` | 서버가 받은 시각 (epoch 밀리초) |

같은 센서·같은 초의 중복은 저장 때 걸러져 있다. 파일 끝의 완전하지 않은 줄(쓰는 중)은 넣지 않는다.

### telemetry/{vehicleId}/outbox.json, telemetry/ranges.json
`outbox.json`은 미트박스로 보낸 온도 묶음 메시지와 어디까지 묶었는지(`cursor`: 날짜별 바이트 위치, `outbox[]`: `dispatch/`의 `outbox[]`와 같은 항목)다. `ranges.json`은 `{"차량ID": {"kind":"frozen"} 또는 {"min":0,"max":5}}`(°C)다.

### resources/vehicles.json, resources/region-codes.json
SQLite 차량 등록부를 JSON으로 푼 것이다.

| 필드 | 뜻 |
|---|---|
| `vehicles.json` `revision` | 등록부 변경 번호 |
| `source` | `kind`(가져온 출처), `importedCount`, `excludedCount` |
| `vehicles[]` | `id`, `plate`(번호판), `originalCode`(원본 카탈로그 코드, 없으면 `null`), `active`(false면 운행 제외), `regionCode`(지역 코드, 없으면 `null`) |
| `region-codes.json` `regionCodes[]` | 지역 코드 문자열 목록 (영문 대문자·숫자) |

### resources/driver-profiles.json
운영자가 입력한 기사 기준정보다. 서버 상태 디렉터리의 `driver-profiles.json`을 그대로 넣는다. **연락처·주소·계약정보가 들어 있는 개인정보**이므로 받는 쪽이 보관·접근 기준을 정한다.

| 필드 | 뜻 |
|---|---|
| `revision` | 변경 번호 |
| `profiles{계정}` | 기사 계정 이름 → `region`(권역), `skill`(숙련도), `phone`, `address`, `contract`, `vehicleType`(차종), `topSpec`(탑 사양), `capa{stops, boxes, weightKg}`(최대 착지수·Box·중량). 비워 둔 항목은 키가 없다 |

## 복원 방법

1. `manifest.json`의 `files[]`로 각 파일의 크기와 SHA-256을 대조한다. `warnings`가 비어 있고 `changedDuringExport`가 없는지 본다.
2. 주문은 `orders/`, 배송 결과는 `dispatch/{date}.summary.json`과 `driver/{date}.json`의 `events`, 사진은 `photos/index.json`, 온도는 `telemetry/`, 차량은 `resources/`에서 읽는다.
3. 같은 서버로 되돌릴 때는 `dispatch/{date}.json`을 새 상태 디렉터리의 `{date}.json`으로, `source/{date}.json`을 원본 자료의 `days/{date}.json`으로 둔다. `sourceId`가 같아야 읽힌다.

가져오기(import) 도구는 이 아카이브에 포함하지 않는다.
