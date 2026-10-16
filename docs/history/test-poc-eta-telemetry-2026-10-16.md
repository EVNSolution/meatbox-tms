# TEST ETA·온도 연동 관찰 기록 (2026-10-16, 2차)

[릴리스 기록 양식](../templates/release-record.md)을 따른다. [1차 기록](test-poc-meatbox-flow-2026-10-16.md)의 절차를 재사용했다. 합성 주문만 썼다. 비밀값·쿠키·초대 코드는 적지 않는다.

## 대상과 결과

- 기록일·시간대: 2026-10-16 17:36~17:42 KST (Asia/Seoul).
- 대상 환경·서비스: TEST 단일 호스트(`i-03d1f27429c948b7d`), `meatbox-api@green` (API 8082).
- 작업 담당: 실행 Claude 하위 세션. 확인 담당: 사용자(미지정).
- 실행 릴리스: `092f94bebb3e-9f924d3dce34b651` (Git `092f94bebb3ea3430d15a6ea8c563fa170b1c07b`, main HEAD). 이전 실행 릴리스에서 바뀐 것은 없다. 제품 코드 변경은 없다.
- 변경 목적: ETA 산출·재산출과 온도 수신·묶음 송신을 TEST에서 끝까지 관찰한다.
- 최종 판정: 관찰 완료. 아래 "시험하지 못한 것"을 뺀 시나리오 전 단계 통과. 버그 없음, 확인할 동작 2건.

## 전제와 보존 기준

- 배포: CI run `38874321400` 성공(2m39s) → Deploy Run `38874620306` 성공(1m17s). 활성 슬롯 `green`, 호스트 `current` = 위 릴리스.
- 설정(TEST `/etc/meatbox-tms/api.env`에만 임시 추가, 0600 root, 값은 기록하지 않음): `MEATBOX_TELEMETRY_TOKEN`(48자 무작위), `MEATBOX_ETA_DELAY_THRESHOLD_MINUTES=1`. 변경 전 사본 `api.env.before-poc2-20261016`. 적용·원복 모두 `systemctl restart meatbox-api@green` 1회씩.
- `telemetry/ranges.json`: 차량 `api-g01` `{"kind":"frozen"}` 1건. 서버가 파일 수정 시각을 보고 다시 읽으므로 재기동 없이 적용됐다.
- 날짜: 오늘 `2026-10-16`은 CSV 매니페스트라 주문을 받을 수 없다. 매니페스트에 없는 `2026-10-25`(시나리오 1: 출발·완료 지연·권역 진입)와 `2026-11-01`(시나리오 2: 출발 후 순서 변경)을 썼다. 한 날짜로는 순서 변경을 시험할 수 없다: 완료 뒤 남은 배송지가 현재 1·대기 1이면 대기끼리 바꿀 수 없다(`409 ROUTE_LOCKED`, 아래 7번).
- 접근: 임시 검토 계정 `poc2-review-20261016`(초대 CLI → `/dev/register` → `/login`). 호출은 호스트 안에서 `127.0.0.1:8082`로 보냈다. 이유는 1차와 같다(게이트웨이가 `/api/telemetry/*`·`/mock/*`를 API로 넘기지 않음).

## 증거

차량 `api-g01`(합성 후보). 주문 `POC2-A·B·C`(2026-10-25, A·B 좌표 있음·C 없음), `POC2-D·E·F`(2026-11-01, 같은 구성).

| # | 요청 | 응답 | 핵심 필드·관찰 |
|---|---|---|---|
| 1 | 주문 3건 수신 ×2일 | 202 ×6 | `applied:true` |
| 2 | `calculate_dispatch` → `publish_dispatch` | 200 | revision 0→1→2, `confirmedVersion 1` (두 날짜 모두) |
| 3 | `departed`(`stopOrder`, `location`) 10-25 | 202 | `next.eta` 17:42 |
| 4 | `GET .../driver/route` | 200 | `phase delivering`, ETA A 17:42 < B 17:52 < C 17:57 단조 증가, A·B `estimated:true`, 좌표 없는 C `estimated:false` |
| 5 | `/mock/meatbox/received?kind=eta` | 200 | 약 5초 내 1건, `reason departed`, `messageId`=`2026-10-25-3-eta-api-g01`=`Idempotency-Key`, stops 3건 |
| 6 | `stop_completed` A (ETA보다 3분 이르게 닫음) | 202 | `stop.status done`, 모의 수신기에 `reason delayed` 1건(id `-r1`, B·C만, B 17:43·C 17:48) |
| 7 | `route_reordered` B↔C (B가 현재 배송지) | 409 | `ROUTE_LOCKED`. 상태 불변. 문서대로의 거절이다 |
| 8 | `zone_entered`(location, zoneId `ZZ-NONE`) | 202 | `reason zone_entered` 1건(id `-r2`, B 17:41·C 17:46). 위치 없이 보내면 400 `LOCATION_REQUIRED` |
| 9 | 10-25 `ops/outbox` | 200 | pending 0, failed 0, sent 10 |
| 10 | 2026-11-01: `departed` → `route_reordered` D,F,E (`expectedRevision`) | 202, 202 | `reason reordered` 1건(id `-r1`, D 17:40·F 17:45·E 17:54). 순서는 D,F,E로 바뀌고 ETA 단조 증가. 11-01 `ops/outbox` pending 0, failed 0, sent 7 |
| 11 | `POST /api/telemetry/temperature` 센서 `POC2-S1` 10건(-19.0~-17.2), `POC2-S2` 2건 | 202 ×2 | `accepted 10`, `accepted 2`, `unknownVehicle:true`(합성 차량이 자원 등록부에 없음) |
| 12 | `GET .../temperature/latest` | 200 | 센서 2개, `stale:false`, `range {max:-18}`. 단 S1이 `outOfRange:true`(아래 "확인할 동작" 1) |
| 13 | 토큰 없음·틀린 토큰 `POST` | 401 | `application/problem+json`, `TELEMETRY_UNAUTHORIZED` |
| 14 | S1에 -19.0 1건 후 `latest` | 202, 200 | S1 `outOfRange:false`, S2 `false` |
| 15 | S1에 -10.0·-10.1·-10.2 | 202 | `latest` S1 `outOfRange:true` |
| 16 | `GET /api/ops/alerts` | 200 | `telemetry OUT_OF_RANGE` 1건(11번 직후, 첫 시점), `telemetry UNKNOWN_VEHICLE` 1건. 15번의 재이탈은 새 알림 없음(아래 "확인할 동작" 2) |
| 17 | `GET .../temperature/api-g01?resolution=1m` | 200 | 센서별 분 평균·min·max·count |
| 18 | `/mock/meatbox/received?kind=temperature` (송신 후 약 70초) | 200 | 2건: `api-g01-202610161740-POC2-S1`(측정 17건, 오름차순), `...-POC2-S2`(2건). `Idempotency-Key`=`messageId`. `ops/telemetry` pending 0, failed 0, sent 2 |
| 19 | 최종 `ops/outbox` 두 날짜, `ops/alerts` | 200 | pending 0. 알림은 16번의 2건뿐. 서버 WARN 이상 로그 없음 |

승격 근거: 위 표는 우리 TEST 서버가 자기 모의 수신기로 보낸 것이다. 미트박스 실 송수신이 아니므로 `업무 확인`은 아니다.

## 확인할 동작 (버그로 단정하지 않음)

1. 11번에서 S1이 -19.0→-17.2로 오르며 마지막 3건(-17.6·-17.4·-17.2)이 -18 이하 조건을 넘어 `outOfRange`가 됐다. 입력을 오르는 순서로 만든 시험 실수이고 서버는 문서대로 판정했다. 14번에서 범위 안 측정으로 풀리는 것도 확인했다.
2. 15번의 재이탈은 알림이 한 번 더 나가지 않았다. 문서는 같은 창의 재이탈을 알림 창이 억제한다고 한다(`TemperatureWatchTest`). 약 14초 간격이라 창 안이다. 억제 창 길이는 확인하지 않았다.

## 시험하지 못한 것

- 오늘 snapshot `vehicleStates[v].temperature`와 기사 경로 `temperature`. 이유: 노출은 서울 오늘 날짜에만 하는데 오늘은 CSV 날짜라 합성 주문·차량을 만들 수 없고, 오늘 `vehicleStates`는 비어 있다. 해당 단정은 로컬 시험(`TemperatureSnapshotTest`)에만 있다.
- 폴리곤이 있는 권역의 `422 ZONE_MISMATCH`. 이유: 합성 차량이 속한 실제 권역 폴리곤을 쓰지 않았다(`zoneId`는 regions에 없는 값).
- `reason completed`(마지막 이전 배송지가 임계 안에 닫히는 경우), 재시작 뒤 이어 보내기, 4xx 거절 시 재시도 없음.
- TEST 운영 웹 배차 화면. 이유는 1차와 같다.

## 정리와 남은 것

- 정리함: 임시 계정 `poc2-review-20261016` 비활성화(CLI 응답 `Disabled`), 호스트의 초대·비밀번호·쿠키 파일 삭제와 디렉터리 제거, `api.env`를 변경 전 사본으로 되돌리고 재기동(`telemetry` 키 0개, 수신 끝점 404 확인), 토큰이 든 중간 사본 삭제, `ranges.json`은 `ranges.json.poc2-removed-20261016`으로 이동, 로컬 임시 키·SSH 제어 소켓 삭제.
- 남김(삭제하지 않음, 체크포인트 보존 원칙): `dispatch-state/` 아래 `2026-10-25.json`, `2026-11-01.json`, `driver-2026-10-25.json`, `driver-2026-11-01.json`, `inbound/2026-10-25.json`, `inbound/2026-11-01.json`, `telemetry/api-g01/2026-10-16.jsonl`·`outbox.json`, `telemetry/ranges.json.poc2-removed-20261016`. TEST 매니페스트에 두 날짜(source api)가 계속 보인다.
- 남김(설정): `api.env.before-poc2-20261016`(현재 `api.env`와 같은 내용).
- 되돌릴 수 없는 것: 없음. 다만 온도 수신이 꺼진 상태다. 단말 연동을 이어 관찰하려면 토큰을 다시 넣는다.
- 남은 제한: 1차와 같다(미트박스 호출 경로 미구성, 모의 수신기는 TEST에서만).
