# TEST 미트박스 연동 PoC 흐름 기록 (2026-10-16)

[릴리스 기록 양식](../templates/release-record.md)을 따른다. 합성 주문만 썼다. 비밀값·쿠키·초대 코드는 적지 않는다.

## 대상과 결과

- 기록일·시간대: 2026-10-16 15:38~15:45 KST (Asia/Seoul).
- 대상 환경·서비스: TEST 단일 호스트(`i-03d1f27429c948b7d`), `meatbox-api@green` (API 8082).
- 작업 담당: 실행 Claude 하위 세션. 확인 담당: 사용자(미지정, 아래 "남은 제한" 참고).
- 이전 실행 릴리스: `native:2788ad000147-d95d5340a5acbe80`. 실제 실행 릴리스: `348f63eaec86-cfced4b416614b47` (Git `348f63eaec86848f1e4ca4f4ae50484d71ced315`).
- 변경 목적: `main` 348f63e까지의 미트박스 연동 서버 기능을 TEST에서 끝까지 관찰한다. 제품 코드 변경은 없다.
- 최종 판정: 전환 완료. 시나리오 전 단계 통과. 웹 배차 화면 확인만 하지 못했다.

## 전제와 보존 기준

- 배포: CI run `38861967785` 성공(2m53s) → Deploy Run `38862246555` 성공. 단계별 ms: snapshot 1399, transfer 11988, rollout 26003, total 52160. 백업 `/var/backups/meatbox-tms/20261016T063801Z-325806`. 활성 슬롯 `green`.
- 설정 대비(TEST `/etc/meatbox-tms/api.env`에만 추가, 0600 root 유지, 저장소 변경 없음):
  - `MEATBOX_INBOUND_TOKEN`: TEST 전용 무작위 값(48자). 값은 호스트에만 있다.
  - `MEATBOX_MOCK_RECEIVER_ENABLED=true`.
  - `MEATBOX_API_BASE_URL=http://127.0.0.1:${SERVER_PORT}/mock/meatbox`. `SERVER_PORT`는 슬롯 환경 파일이 정하므로 슬롯이 바뀌어도 자기 자신을 가리킨다. 시작 로그에서 "비어 있음" 메시지가 사라지고 발송이 동작했다.
  - 변경 전 사본: 호스트 `/etc/meatbox-tms/api.env.before-poc-20261016`.
- 적용: `systemctl restart meatbox-api@green` 1회(06:40 UTC). 세션은 `sessions.json`으로 유지된다.
- 다음 배포에서 위 세 키가 남는지는 `configure-mode.mjs`가 모르는 키를 보존하는 코드(`update()`)로만 확인했다. 실제 배포로 확인하지 않았다.
- 날짜 선택: 오늘 `2026-10-16`은 CSV 매니페스트에 있어 미트박스 주문을 받을 수 없다(`SOURCE_CONFLICT`, 이 거절은 시험하지 않았다). 매니페스트에 없는 가장 가까운 날짜 `2026-10-18`을 썼다. 변경 가능한 미래 날짜다.
- 접근: 임시 검토 계정 `poc-review-20261016`(초대 CLI → `/dev/register` → 공개 HTTPS 로그인). 호출은 SSH 터널로 `127.0.0.1:8082`에 보냈다. 이유: 웹 게이트웨이가 `/api/meatbox/*`와 `/mock/*`를 API로 넘기지 않는다(공개 주소 `/mock/...`는 `302 /login`). 즉 미트박스가 TEST 공개 주소로 주문을 밀어 넣는 경로는 아직 없다.

## 증거

날짜 `2026-10-18`, 차량 `api-g01`·`api-g02`(합성 후보), 사진은 8×8 PNG 합성 1장.

| # | 요청 | 응답 | 핵심 필드·관찰 |
|---|---|---|---|
| 1 | 토큰 없이 `POST /api/meatbox/orders` | 401 | `INBOUND_UNAUTHORIZED` |
| 2 | 주문 `POC-1016-A1` v1 | 202 | `applied:true`, `duplicate:false` |
| 3 | 주문 `POC-1016-A2` v1 (A1과 같은 이름·주소) | 202 | `applied:true` |
| 4 | 주문 `POC-1016-B1` v1 | 202 | `applied:true` |
| 5 | A1 같은 본문 재전송 | 200 | `duplicate:true`, `applied:false` |
| 6 | `GET .../state` | 200 | revision 0, `unplanned`, `inbound.received 3/applied 3`, 후보 `api-g01`…`g08`. 매니페스트에 `source:"api"`, orders 3 |
| 7 | `calculate_dispatch` (`api-g01`,`api-g02`) | 200 | revision 0→1, `draft`. A1·A2는 `api-g01`(목적지 1), B1은 `api-g02` |
| 8 | `publish_dispatch` | 200 | revision 1→2, `published`, confirmedVersion 1 |
| 9 | `GET /mock/meatbox/received` | 200 | 약 5초 내 `dispatched` 3건(A1·A2·B1). `Idempotency-Key`=`messageId` |
| 10 | 사진 업로드 `.../driver/photos` | 201 | `photoId` 발급, bytes 74 |
| 11 | 이벤트 `departed` ×2 (`api-g01`,`api-g02`) | 202 | revision 2→3→4. `departed` 3건 도착(주문별) |
| 12 | 사전 시도: 출발 없이 `stop_completed` | 409 | `OPERATION_REVISION_CONFLICT`("현재 이동 중인 배송지만 도착 처리"). 상태 불변(revision 2). 출발 이벤트가 먼저 필요하다는 정상 동작 |
| 13 | `stop_completed` (`eventId=poc-evt-complete-1`, A1·A2, 사진) | 202 | `duplicate:false`, `stop.status:"done"`. revision 4→6 |
| 14 | 13과 같은 `eventId`·본문 재전송 | 202 | `duplicate:true`, `receivedAt` 동일, revision 6 불변 |
| 15 | `stop_failed` (`api-g02`, `ABSENT`) | 202 | `stop.status:"skipped"`. revision 6→8 |
| 16 | 모의 수신기 | — | `delivered` A1·A2: `messageId` `2026-10-18-6-…`, `photos` 1건, `note` 일치. `failed` B1: `messageId` `2026-10-18-8-POC-1016-B1`, `failure.reasonCode:"ABSENT"`. 키는 모두 `messageId`와 같음 |
| 17 | `GET /api/ops/outbox?date=2026-10-18` | 200 | `pending 0`, `failed 0`, `sent 9` (dispatched 3 + departed 3 + delivered 2 + failed 1) |
| 18 | `GET /api/ops/alerts` (취소 전) | 200 | 알림 0건 |
| 19 | 취소 `POC-1016-B1` v2 `cancelled` | 202 | `applied:false`, `held:"ORDER_CANCELLED_AFTER_DISPATCH"` |
| 20 | `GET .../state` (취소 후) | 200 | 주문 3건 유지, revision 8 불변, `inbound.stamp` 3→4, `warnings[0].code:"ORDER_CANCELLED_AFTER_DISPATCH"` |
| 21 | `GET /api/ops/alerts` (취소 후) | 200 | 알림 1건 `meatbox-inbound ORDER_CANCELLED_AFTER_DISPATCH`, 채널 `LogAlertChannel` |
| 22 | 서버 로그 | — | WARN은 위 알림 1줄뿐. ERROR 없음 |
| 23 | 계정 비활성화 뒤 기존 쿠키 `GET /api/session` | 401 | 35초 뒤 확인 |

승격 근거: 위 표는 우리 TEST 서버가 자기 모의 수신기로 보낸 것이다. 미트박스 실 송수신이 아니므로 `업무 확인`은 아니다.

## 시험하지 못한 것

- TEST 운영 웹 배차 화면 확인. 이유: 로컬 개발 호스트가 아닌 TEST 로그인 화면에 임시 비밀번호를 입력하는 일을 에이전트 규칙이 막는다. 화면은 보지 못했다. API로는 `manifest.dates[]`의 `source:"api"` 항목과 `days/2026-10-18`의 합성 주문 3건을 확인했다.
- `SOURCE_CONFLICT` 거절, 위치 배치, `zone_entered`·`stop_partially_completed`·`route_reordered`, 기사 조회 GET 중 `route` 외 3개, ETA·온도 송신, TEST에서의 재시도·4xx 거절, 재시작 뒤 이어 보내기, 다음 배포 뒤 설정 유지.
- 알림 웹훅(`MEATBOX_ALERT_WEBHOOK_URL`) 채널. TEST는 로그 채널만 쓴다.

## 정리와 남은 것

- 정리함: 임시 계정 `poc-review-20261016` 비활성화(계정 삭제 CLI 없음), 초대 파일 디렉터리 삭제, 로컬 임시 키·쿠키·비밀번호·토큰 사본 삭제, SSH 터널 종료.
- 남김(삭제하지 않음): 합성 자료는 체크포인트 보존 원칙(운영 런북: 체크포인트·`inbound/` 파일을 지우거나 옮기지 않는다)과 영구 삭제 금지 때문에 지우지 않았다. 호스트 `/var/lib/meatbox-demo/dispatch-state/` 아래 `2026-10-18.json`, `driver-2026-10-18.json`, `inbound/2026-10-18.json`, `photos/2026-10-18/<photoId>.png`. TEST 매니페스트에 `2026-10-18`(source api, 주문 3건)이 계속 보인다. 이 날짜는 `2026-10-19` 이후 읽기 전용이 된다.
- 남김(설정): 위 `api.env` 세 키, `api.env.before-poc-20261016` 사본.
- 남은 제한: 미트박스 호출 경로(게이트웨이→API, 고정 IP 허용)는 미구성. 모의 수신기는 TEST에서만 켠다. 운영·QA에는 켜지 않는다.
