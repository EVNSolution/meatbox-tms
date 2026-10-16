# 미트박스 TMS 마스터 계획서

범위·결정·진행 상태의 **정본**이다. 2026-10-16 정의 세션에서 시작했다.
원본 요구는 미트박스 업무요구서 2차(수정본) 63항목이며, 아래 괄호 번호는 그 문서의 No다.
다른 계획 문서와 충돌하면 이 문서가 우선한다. 세부 계약은 기준 문서에 두고 여기에는 결론만 둔다.

## 갱신 규칙

- 작업 단위마다 이 문서를 **같은 커밋**에서 갱신한다. 코드만 바꾸고 이 문서를 두지 않는다.
- 상태는 [검증 가이드](verification.md)의 증거 단계만 쓴다. `미착수` → `구현` → `로컬 검증` → `서버 반영` → `업무 확인`. 문서 산출물은 `초안` → `합의`.
- 한 단계의 증거로 다음 단계를 올리지 않는다. 근거 없는 승격은 되돌린다.
- 범위·결정이 바뀌면 "결정 기록"에 날짜와 함께 추가한다. 이전 결정은 지우지 않고 대체했다고 적는다.
- 미트박스 명세·자료가 없는 항목은 `업무 확인`으로 올리지 않는다.

## 범위 경계

우리는 TMS 파트만 만든다. 주문 웹과 고객 앱은 미트박스 것이 있다.

| 구분 | 내용 |
| --- | --- |
| 우리 몫 | TMS 웹(배차·관제·기준정보·대시보드), 배송원 앱(Android·iOS), 온도 단말(STEGO) 연동, API 서버 |
| 미트박스가 열어야 하는 API | 주문 수신·배송 상태 회신(5), ETA 전송(2), 온도 전송(17) |
| 미트박스가 줘야 하는 자료 | 신선/택배 구분값(23), 바코드·상품·수량 매핑(55·56), 상차 완료 상태(44), 출입정보 조회 권한(45), CS 요청 입력 주체(48), 과거 배송지 Raw(7) |
| 미트박스 몫 | 고객 알림(Push·알림톡), 고객 실시간 조회 화면. 우리는 데이터만 보낸다 |

## 결정 기록

| 날짜 | 결정 |
| --- | --- |
| 2026-10-16 | 웹 프런트는 1차 종료. 부족 기능만 아래 메모에 남기고 새 화면 작업은 열지 않는다 |
| 2026-10-16 | 서버는 TEST 한 대 유지. QA·운영 분리는 비용 때문에 뒤로 미룬다 |
| 2026-10-16 | 예시 화면보다 JSON 계약 먼저. 앱→서버 이벤트와 서버→미트박스 송신 3종을 샘플 JSON과 모의 수신기로 고정한다 |
| 2026-10-16 | 주소 정제(7)는 지도 API 키워드 검색 + 과거 배송지 DB 매칭. Raw 미수령 시 지도 API만 |
| 2026-10-16 | 부분 배송 완료(61)는 기본 제공 확정 |
| 2026-10-16 | 날짜·PoC 주차는 관리하지 않는다. 가능한 구현은 전부 한다 |
| 2026-10-16 | API 오류 대응(19)·계약 종료 데이터 일괄 제공(20)은 우리 서버 구현 범위 |
| 2026-10-16 | 미트박스 형식을 강요받을 경우를 대비해 내부 이벤트와 송신 JSON을 분리한다 |

## 트랙 A. 서버 단단하게

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| [x] RFC 9457 공통 오류 응답 (19) | 로컬 검증 | `ProblemResponseTest`(DispatchException·429·500·404·405), `ApiPathGuardHttpTest`(필터 401·400, 실서버 404), `DriverHttpTest`(429 Retry-After), 계약 테스트 58건 통과. `error`·`message` 호환 필드는 프런트가 `code`로 옮긴 뒤 제거 |
| [x] 오류 자동 감지·담당자 알림 (19) | 로컬 검증 | `ops/ErrorAlertsTest`(500·저장 실패 감지, 10분 창 억제·요약 99건, 다른 code 별도, 채널 예외 시 500 유지, 큐 상한), `ops/WebhookAlertChannelTest`(로컬 HTTP 수신), `ops/OpsAlertsHttpTest`(`GET /api/ops/alerts` 401·목록). 채널은 로그 기본·웹훅 선택. 미트박스 송신 실패는 `meatbox-outbound` 알림으로 연결됨(아래 트랙 B). 메일·운영 시간 외 대응 기준은 남음 |
| [x] 명령 결과를 요청 ID로 영속 조회, 응답 유실 후 중복 적용 방지 | 로컬 검증 | `DispatchStoreTest`(재전송·본문 불일치·재시작·저장 실패·보존 한도), `test/api-connection/kotlin-state-owner.test.mjs`(HTTP 재전송·GET·재시작). 날짜당 500건·24시간·8MiB. [다음 기능 계획](next-feature-delivery-plan.md) F04 |
| [ ] 테넌트·소속·역할 권한 (3) | 미착수 | F05·F06 |
| [ ] 원본 변경 시 기존 배차 재사용 차단 | 미착수 | F02 |
| [x] 계약 종료 시 운영 데이터 일괄 내보내기 (20) | 로컬 검증 | `export/ExportWriterTest`(manifest 크기·SHA-256 대조, 내보낸 체크포인트로 새 state-dir의 `DispatchStore`가 같은 snapshot 복원, 사진 색인=`stop_completed`의 `photoIds`, 온도 줄 수, 자원 JSON 왕복, 토큰·세션 제외, 빈 범위, 쓰는 중인 줄 처리), `ExportJobsTest`(동시 실행 409, 디스크 507, 없는 jobId 404, 재시작 뒤 조회, 7일 삭제, CLI), `ExportHttpTest`(세션 없음 401, 202→done→다운로드 SHA-256, 400). 실제 JAR 시나리오: 주문 3건 수신→배차 확정→출발·사진·완료→온도 수신→`POST /api/ops/export`→내려받아 manifest 8파일 전부 일치, CLI(`--meatbox.export.out`)도 같은 형식. [형식 명세](data-export-format.md)·[런북](operations.md). 서버 반영·실제 규모(사진 수 GB) 시험은 안 했다. 역할 권한은 없고 세션 + 감사 로그만이다(권한 단위에서 제한) |
| [ ] 미디어 6개월 Standard 후 장기 보관 이전 (26) | 미착수 | |

## 트랙 B. 앱↔서버 이벤트와 미트박스 송신 계약

계약 본문은 [연동 계약 초안](integration-contract.md)에 있다.

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| [x] 앱→서버 이벤트 목록 확정: 출발, 권역 진입, 배송 완료, 미배송, 부분 완료, 순서 변경 | 초안 | 위치는 이벤트와 분리해 1분 배치 |
| [x] 이벤트별 샘플 JSON | 초안 | 작업 식별자, 재시도 간격, RFC 9457 포함 |
| [x] 서버→미트박스 송신 JSON 3종: 배송 상태(5), ETA(2), 온도(17) | 초안 | 주문 수신(5) 제안 본문과 GET/POST 끝점 요약 포함 |
| [x] 앱 이벤트 `departed`·`stop_completed`·`stop_failed`와 사진 업로드 수신 | 서버 반영 | TEST 릴리스 `348f63eaec86-cfced4b416614b47`에서 관찰: 출발 전 `stop_completed` 409, `departed` 202, 사진 201, `stop_completed` 202(`done`), 같은 `eventId` 재전송 `duplicate:true`·revision 불변, `stop_failed` 202(`skipped`). [기록](history/test-poc-meatbox-flow-2026-10-16.md). 실기기·기사 앱이 아니라 curl로 보낸 합성 이벤트 |
| [x] 앱 이벤트 나머지 3종(`zone_entered`·`stop_partially_completed`·`route_reordered`)과 위치 배치 수신 | 로컬 검증 | `DriverEventsTest`(이벤트 6종 정상 경로, 재전송 `duplicate`, 본문 불일치 409, `ROUTE_LOCKED`, 사진·사유 코드·date 거부, 재시작 뒤 조회), `DriverLocationPhotoTest`(120건 유지, `source: "driver"`, 사진 바이트·형식·`../`), `DriverActivityHttpTest`(202, 413·415 거부). 경로는 현행 `.../driver/*`이며 `/api/driver/*`는 권한 단위에서 옮긴다. 기사 계정 권한은 남음. ETA는 아래 트랙 E |
| [x] 기사 조회 GET 4개: 경로·배송지 상세·당일 이력·이벤트 결과 | 로컬 검증 | `DriverQueriesTest`(경로 순서·상태·`eta` null·revision, 배송지 상세와 직전 완료 사진, 다른 차량 배송지 404, 이력의 완료·미배송·사유), `DriverActivityHttpTest`(200·404·401), `test/api-connection/kotlin-state-owner.test.mjs`의 실제 JAR 시나리오(사진 업로드 → `stop_completed` → 재전송 `duplicate` → 재시작 뒤 `events/{eventId}` → `history`). 출입정보 권한 제한은 남음. 출발 뒤 `eta` 채움은 `driver/DriverEtaTest`(트랙 E) |
| [x] 우리 쪽 모의 수신 엔드포인트 | 서버 반영 | `integrations/meatbox/mock/MockMeatboxReceiverTest`(3종 202, 필수 키·`Idempotency-Key` 누락 400, 중복 키 1건, 200건 상한, 송신기→수신기 실제 HTTP, 꺼짐이면 404). `meatbox.mock-receiver.enabled`가 켜질 때만 뜨는 테스트 전용 TEST 관찰([기록](history/test-poc-meatbox-flow-2026-10-16.md)): 내부 포트에서 `delivery-status` 4종 상태(`dispatched`·`departed`·`delivered`·`failed`) 9건을 받음, 키=`messageId`. 공개 주소 `/mock/*`는 게이트웨이가 열지 않음(`302 /login`). ETA·온도 수신은 TEST에서 관찰하지 않음. |
| [x] 배송 상태 송신 어댑터(outbox) | 서버 반영 | `driver/OutboxMessagesTest`(이벤트별 상태 매핑, 재전송 시 항목 1건, 저장 실패 시 상태·항목 없음), `integrations/meatbox/outbound/OutboxSenderTest`(202 `sentAt`, 503 두 번 뒤 202·5초→15초, 400 재시도 없음·알림 1회, 연결 거부 11회 알림 1회, 재시작 뒤 이어 보내기), `integrations/meatbox/outbound/OpsOutboxTest`(`GET /api/ops/outbox` 401·정상), `test/api-connection/kotlin-state-owner.test.mjs`의 실제 JAR PoC 시나리오. `arriving`·온도 송신·사진 서명 URL은 남음(ETA 송신은 아래 별도 행). 미트박스 실 송수신은 `업무 확인` 전 TEST 관찰([기록](history/test-poc-meatbox-flow-2026-10-16.md)): 확정→`dispatched` 3, `departed` 3, `delivered` 2, `failed` 1이 5초 안에 도착, `ops/outbox` pending 0·failed 0·sent 9, 오류 알림 0. TEST 재시도·4xx 거절·재시작은 관찰하지 않음. 미트박스 실 송수신은 `업무 확인` 전. |
| [x] ETA 송신 (2) | 서버 반영 | `driver/DriverEtaTest`(`departed` 한 번에 `kind=eta` 1건, 본문 키 `messageId·vehicleId·computedAt·reason·stops[{sequence,orderIds,eta}]`, `messageId`=`{date}-{revision}-eta-{vehicleId}`, 같은 `eventId` 재전송 시 `etas`·`outbox` 불변), `OutboxSenderTest`(시험 서버에 `/tms/eta` 추가), `test/api-connection/kotlin-state-owner.test.mjs`의 실제 JAR 시나리오(출발 → 발송기가 `/mock/meatbox/tms/eta`로 보내 `received?kind=eta`에 1건 도착, `ops/outbox` pending 0·failed 0). 재산출 4종(`completed`·`delayed`·`zone_entered`·`reordered`)은 아래 트랙 E 2·3행. 미트박스 실 수신은 관찰하지 않음 TEST 릴리스 `092f94bebb3e-9f924d3dce34b651`에서 관찰: `departed` 202 → 모의 수신기 `kind=eta` 1건(`reason departed`, `messageId`=`Idempotency-Key`), 재산출 3종(`delayed`·`zone_entered`·`reordered`)도 도착, `ops/outbox` pending 0·failed 0. 미트박스 실 수신은 아님. 근거 [2차 기록](history/test-poc-eta-telemetry-2026-10-16.md). |
| [x] 미트박스 주문 수신 끝점과 API 원본 날짜 | 서버 반영 | `integrations/meatbox/inbound/InboundOrdersTest`(본문 매핑·검증 오류, 적용 집합 기준 `sourceId` 결정성, 정책 매트릭스: 배차 전 적용·계산안 폐기+경고·확정 뒤 보류 4종, 중복·낮은 version·본문 충돌, 과거 날짜·날짜 이동), `integrations/meatbox/inbound/DispatchStoreInboundTest`(3건→snapshot 3건, 계산안 중 변경→계산안 폐기, 확정 뒤 취소→주문 유지+경고+체크포인트 바이트 불변, CSV 날짜 충돌 409, 계산안 폐기 뒤 쓰기 실패 시 상태, 재시작), `integrations/meatbox/inbound/InboundDaysReaderTest`(매니페스트 병합·날짜 JSON), `integrations/meatbox/inbound/MeatboxOrdersHttpTest`(401·400·415·413·202/200/409, 주문 변경 시 상태 ETag 변경, 같은 코드 알림 1회), `integrations/meatbox/inbound/MeatboxOrdersDisabledHttpTest`(토큰 없음 404), `test/api-connection/kotlin-inbound-orders.test.mjs`의 실제 JAR 시나리오(주문 3건 → 계산 → 확정 → `stop_completed` → `/mock/meatbox/received`에 `delivered` → 확정 뒤 취소·완료 뒤 변경은 경고만 → 재시작 뒤 같은 상태). CSV 날짜의 기존 테스트는 그대로 통과. 미트박스 실제 송신·게이트웨이 경로 열기·고정 IP·확정 뒤 변경 반영(F11)·좌표화(7)·웹이 API 날짜를 그리는 모습은 남음 TEST 관찰([기록](history/test-poc-meatbox-flow-2026-10-16.md)): 토큰 없음 401, 주문 3건(같은 배송지 2건 포함) 202, 재전송 200 `duplicate`, 계산·확정 후 취소 202 `ORDER_CANCELLED_AFTER_DISPATCH`·주문 유지·알림 1건. 오늘 날짜는 CSV 매니페스트에 있어 미래 날짜 `2026-10-18`로 관찰. 웹 배차 화면은 관찰하지 못함. 게이트웨이가 `/api/meatbox/*`를 열지 않아 내부 포트로만 호출함. |
| [ ] 고객 실시간 조회 예시 화면 1장 | 미착수 | 미트박스 설득용. 그 이상 그리지 않음 |
| [ ] 미트박스에 계약 초안 전달 | 미착수 | 확인 질문 8개는 계약 문서 6절 |
| [ ] 미트박스 명세·인증·테스트 환경 수령 | 미착수 | 외부 의존 |

## 트랙 C. TMS 웹 (1차 종료)

1차 종료다. 아래는 요구서 대비 부족 기능 메모이며 착수 여부는 결정 기록에 따른다.
`코드 없음`은 2026-10-16 키워드 검색 결과이고 실제 화면 확인은 아니다.

후속: 웹이 날짜 명령에 `requestId`를 보내고 응답 유실 시 같은 요청을 재전송하도록 한다. 서버는 이미 받는다([API 참조](api-reference.md)).

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| 배차 전용 화면, 핀 배차, 개별·일괄 이관 (9·12·21·22) | 구현 | `apps/web/combined/dispatch-*` |
| 권역 폴리곤 저장·반복 사용 (8·11) | 미확인 | polygon 2파일. 저장·불러오기 여부 확인 필요 |
| 권역별 물동량 표시 (10) | 미확인 | |
| 복수 기사 위치 관제 (13·14) | 미확인 | |
| 기사 마스터·Capa 설정 (18·27) | 미확인 | Capa 2파일 |
| [ ] 온도 관제 화면 (15·16) | 미착수 | 코드 없음 |
| [ ] 신선/택배 필터 (23) | 미확인 | 미트박스 구분값 필요 |
| [ ] 운영 대시보드 (24) | 미착수 | 코드 없음 |
| [ ] Capa 초과 경고 (28) | 미확인 | |
| [ ] 일일 목표 초과 인센티브 계산 (29) | 미착수 | 코드 없음 |
| [ ] 앱 특이사항 조회·이력 (30) | 미착수 | 코드 없음 |
| [ ] 배차 변경 시 기사 알림 발송 (31) | 미확인 | 알림 5파일. 앱 Push 연결 여부 확인 필요 |
| [ ] 주소 검증·정제 UI (7) | 미착수 | 지도 API + 과거 배송지 DB |
| [ ] 출발 처리·ETA 산출 관리 화면 (1) | 미확인 | ETA 5파일 |

## 트랙 D. 배송원 앱

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| [ ] 주기적 위치 수집·전송, 백그라운드 포함 (39·40·41) | 미착수 | 30초 수집·1분 전송 기본값. 절전·강제 종료 상태별 확인 |
| [x] 지도·핀·배송 정보 상세 (42·45) | 로컬 검증 | 앱이 서버 `GET route`·`GET stops/{id}`를 읽는다. `apps/driver/src/api/driverApi.test.ts`(경로·상세·제안 경로와 쿠키·Origin, problem+json `code` 분기, 형식이 틀린 응답 거부), `domain/routeView.test.ts`(ETA 시각과 `estimated:false` 흐림, 핀 흐림 판정, 고객 요청·배송팁·출입 정보·운송 조건·품목 구역), `docs/evidence/driver-app-live-check-2026-10-16.txt`(앱의 API·도메인 코드를 로컬 JAR에 붙인 점검: 로그인 → route → stop 상세 → ETA 라벨). **에뮬레이터·실기기 미확인**: 화면 렌더, MapLibre 지도, 직전 완료 사진의 쿠키 전달은 확인하지 못했다(화면 렌더 테스트 도구도 없다). 핀 좌표는 아직 날짜 상태(`GET state`)에서 읽는다. 완료 이벤트 전환 때 서버 경로 요약에 좌표를 더한다. 출입정보 권한 제한은 남음 |
| [x] 출발 전 순서 변경 (43) | 로컬 검증 | 편집기의 "자동 생성"이 `POST route/suggest`로 제안을 받아 목록에 반영하고, "완료"가 `route_reordered`(`expectedRevision`)로 적용한다. `409 REVISION_CONFLICT`는 최신 상태를 다시 읽고 안내한다. 출발 뒤에는 편집 버튼을 숨긴다(다음 단위에서 연다). `domain/routeDraft.test.ts`(제안 → 앱 배송지 순서, 빠지거나 겹치거나 모르는 배송지 거부, 닫힌 배송지는 제자리, 요약 문구), `domain/retryAttempt.test.ts`·`driverApi.test.ts`(재전송은 같은 본문), 라이브 점검(`lockFirst` 제안 → 적용 → `GET route` 순서 일치, 같은 `eventId` 재전송 `duplicate:true`, 오래된 revision `REVISION_CONFLICT`, 출발 뒤 변경 409). **에뮬레이터·실기기 미확인**: 드래그 편집 화면과 버튼 동작은 보지 못했다. 관리자 재배차와 동시 변경 시 적용 순서 미정 |
| [x] 상차 완료 후 출발 처리 (44) | 로컬 검증 | 픽업 화면의 "배송 시작"이 `departed` 이벤트를 보낸다(전경 위치 1회 취득, 권한이 없거나 읽지 못하면 위치 없이 보내고 알린다). 응답 `next.eta`로 첫 ETA가 오고 목록은 새로고침으로 채운다. `domain/location.test.ts`(위치 값 검증, 시간 초과), `driverApi.test.ts`, 라이브 점검(`departed` → `next.eta`, 같은 이벤트 재전송 `duplicate:true`, 모든 열린 배송지 ETA 채움). **에뮬레이터·실기기 미확인**: 위치 권한 대화상자와 실제 위치 취득은 보지 못했다. 상차 완료 상태 연계 기준 미트박스 확인 필요(지금은 앱의 QR 수령 확인, 기기 로컬, 뒤에 출발). 백그라운드 위치 수집은 다음 단위 |
| [ ] 배송팁 조회·기사 등록 (46·47) | 미착수 | |
| [ ] CS 요청사항 표시 (48) | 미착수 | |
| [ ] 운영 연락처 전화 연결 (49) | 미착수 | |
| [ ] 완료 사진 촬영·앨범, 기본 1장 최대 3장, 자동 압축 (50·52·53) | 미착수 | |
| [ ] 직전 완료 사진 함께 표시 (51) | 미착수 | 동일 배송지 식별 기준 미정 |
| [ ] 완료 특이사항 입력 (54) | 미착수 | |
| [ ] 바코드·QR 스캔과 수기 입력 (55·56) | 미착수 | 미트박스 매핑 자료 필요 |
| [ ] 당일 완료 이력 (57) | 미착수 | |
| [ ] 오프라인 임시 저장과 복구 후 재시도 (58·59) | 미착수 | 작업 식별자, 사진별 전송 상태, 응답 유실 시 재확인 |
| [ ] 미배송 사유·사진 (60) | 미착수 | |
| [ ] 부분 완료 (61) | 미착수 | 기본 제공 확정 |
| [ ] 배차 변경 알림 수신 (31) | 미착수 | |
| [ ] 스토어 배포·OS 호환 (36·37·38) | 미착수 | |

## 트랙 E. ETA·경로 (마지막)

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| [x] 출발 시 배송지별 ETA 산출 (1) | 서버 반영 | `eta/EtaModelTest`(도착 단조 증가, 좌표 없는 배송지 `estimated:false`, 출발 위치 없음, 우회계수·속도·작업시간 변경 시 결과 변화, 추정기 교체, 설정 검증), `driver/DriverEtaTest`(출발 → 기사 경로·배송지 상세·이벤트 응답 `next`에 `eta`, 재시작 뒤 유지, 기기 시계가 5분 넘게 어긋나면 서버 시각과 `departureTimeSource`, 설정이 바뀌면 ETA 이동), JAR 시나리오. 외부 경로 API 없는 직선거리 모델(우회계수 1.4·25km/h·배송지당 5분)이라 실제 도착과의 오차는 측정하지 않음. 재산출(33·34)·지오펜스(32)는 아래 행 TEST 릴리스 `092f94bebb3e-9f924d3dce34b651`에서 관찰: `departed` 뒤 기사 경로 ETA 단조 증가(17:42<17:52<17:57), 좌표 없는 배송지 `estimated:false`. 실제 도착과의 오차는 측정하지 않음. 근거 [2차 기록](history/test-poc-eta-telemetry-2026-10-16.md). |
| [x] 배송지·권역 지오펜스로 완료·진입 판정 (32) | 로컬 검증 | 범위는 권역 진입의 검증과 재산출이다. `driver/DriverEtaRecomputeTest`(`zone_entered` 폴리곤 안 → reason `zone_entered`·임계 이상이면 메시지, 임계 미만이면 갱신만, 위치 없음 400 `LOCATION_REQUIRED`·폴리곤 밖 422 `ZONE_MISMATCH`로 파일 바이트 불변, 폴리곤 없는 zoneId는 기록만·재전송 불변), `eta/PointInPolygonTest`(ray casting: 안·밖·구멍·MultiPolygon·비다각형). 실제 `regions.geojson` 폴리곤은 쓰지 않았고 경계 GPS 오차 허용은 정하지 않음(엄격 포함). 지오펜스로 완료를 자동 판정하지는 않는다(완료는 기사 앱 이벤트) TEST에서 `zone_entered`(폴리곤 없는 zoneId) 재산출과 `LOCATION_REQUIRED` 400은 관찰했으나 폴리곤 밖 `ZONE_MISMATCH`는 못 봐 올리지 않음([2차 기록](history/test-poc-eta-telemetry-2026-10-16.md)). |
| [x] 순서 변경·지연 시 ETA 재산출 (33·34) | 서버 반영 | `driver/DriverEtaRecomputeTest`(완료·미배송 뒤 남은 배송지만 재계산·닫힌 배송지 이전 ETA 보존과 `actualAt`·시각 기준 `completed`/`delayed`(이름·늦음 모두), 마지막 송신 ETA와의 차이가 임계에 닿을 때만 메시지, 미전송 메시지 교체·전송된 뒤에는 새 메시지·messageId 중복 없음, 마지막 배송지는 메시지 없음, ETA 없는 차량은 재산출 없음, 재전송 불변·재시작 유지·이전 체크포인트 복원, 출발 후 대기 배송지 순서 변경 `reordered`·닫힌·현재 배송지 이동과 종료 경로는 409 `ROUTE_LOCKED`·`REVISION_CONFLICT` 유지), `driver/DriverEventsTest`의 `ROUTE_LOCKED` 단정 무수정 통과, `test/api-connection/kotlin-state-owner.test.mjs`의 실제 JAR 시나리오(출발 → 즉시 완료 → `/mock/meatbox/received?kind=eta`에 `departed` 뒤 `delayed`, id `-r1`, `ops/outbox` pending 0·failed 0). 임계 10분은 근거 없는 초기값이고 직선거리 모델의 오차는 측정하지 않음. 미트박스 실 수신은 관찰하지 않음 TEST 릴리스 `092f94bebb3e-9f924d3dce34b651`에서 관찰: 완료가 ETA보다 이르게 닫히자(임계 1분) `delayed`, 출발 후 대기 배송지 순서 변경 `reordered`(현재 배송지를 옮기면 409 `ROUTE_LOCKED`), 각각 남은 배송지만 새 ETA. `completed` 이유는 보지 않음. 근거 [2차 기록](history/test-poc-eta-telemetry-2026-10-16.md). |
| [x] 자동 배송 순서 (62) | 로컬 검증 | `eta/RoutePlannerTest`(최근접+2-opt가 무작위 순서보다 짧음, 현재 순서보다 길지 않음, 좌표 없는 배송지는 주소 앞 3어절이 같은 배송지 뒤 또는 끝·`placed` 보고, 닫힌 배송지 고정, `lockFirst`, 출발점 없음, 200개 5초 안·결정적), `driver/DriverRouteSuggestTest`(창고에서 가까운 순·합계·`revision`, 제안 전후 파일 바이트와 snapshot 불변·같은 응답, 제안을 `route_reordered`로 적용하면 `GET route` 순서 일치, 출발 뒤 `pending`만 이동하고 적용 성공, 종료 경로 409 `ROUTE_LOCKED`, `lockFirst` 오류), `DriverActivityHttpTest`(본문 없음·`{}`·`lockFirst`, Origin 403·세션 401, 상태 불변), `test/api-connection/kotlin-state-owner.test.mjs`의 실제 JAR 시나리오(창고 설정 → 확정 → suggest → `route_reordered` 적용 → `GET route` 순서 일치). 직선거리 × 우회계수 모델이라 요구서의 좌회전 제한·간선도로 위주는 계산하지 않는다(`TravelTimeEstimator` 교체 자리). 창고 좌표(`MEATBOX_ROUTE_DEPOT_LAT/LNG`)는 TEST 미설정이고 미트박스 물류센터 좌표를 받아 설정한다. 상태를 바꾸지 않는 제안이며 운영 날짜 명령은 없다. 실제 경로 대비 거리 오차는 측정하지 않음 |
| [ ] 자동 주행 경로·내비 연동 (63) | 미착수 | |

## 트랙 F. 온도 단말

| 항목 | 상태 | 근거·메모 |
| --- | --- | --- |
| [ ] STEGO 단말 수신·차량 매핑 (15·16) | 로컬 검증 | **수신 끝점까지**: 단말이 보낼 일반 본문을 받는 `POST /api/telemetry/temperature`(아래 두 행의 검증)다. **STEGO 단말 규격 변환(`integrations/stego/`)·단말과 차량의 매핑은 미착수**이며 단말 계약 주체가 미정이다 (25). 온도 단위·분류 기준은 섭씨 -60~60, 칸 `frozen`·`chilled`로 임시 설정했다 |
| [x] 온도 이력 조회 | 서버 반영 | `telemetry/TemperatureStoreTest`(줄 형식·서울 날짜별 파일·파일 권한 0600, 같은 센서·초 무시, 다른 날짜 분리, 늦은 측정이 최신 값을 못 덮음, 다른 프로세스가 쓴 줄 인식·잘린 끝줄 보정, 재시작 뒤 최신 값 복원, stale 10분 경계, 이력 날짜 경계 조회, 본문 검증 거절 코드, 1분 평균·최소·최대), `telemetry/TemperatureHttpTest`(토큰 없음·틀림·주문 토큰 401, 202·재전송 `accepted:0`·미등록 차량 `UNKNOWN_VEHICLE` 알림 1회, 형식·크기·범위 거절 시 파일 없음, 세션 없음 401, `latest`·`raw`·`1m`, 24시간 초과·역순·잘못된 이름 400). 수신 끝점·저장·조회까지다. 센서 단말(STEGO)이 실제로 보내는 모습은 보지 못했고 게이트웨이 경로는 배포 쪽 설정이 필요하다. 허용 범위·경고·snapshot 노출·미트박스 송신은 아래 행 TEST 릴리스 `092f94bebb3e-9f924d3dce34b651`에서 관찰: `latest`(센서별, `stale:false`)·1분 이력·토큰 없음/틀림 401 problem+json. STEGO 실단말은 아님. 근거 [2차 기록](history/test-poc-eta-telemetry-2026-10-16.md). |
| [x] 온도 허용 범위·이탈 경고·snapshot 노출 (15·16) | 로컬 검증 | `telemetry/TemperatureWatchTest`(연속 3개 이탈에서만 알림 1회·단발 스파이크 무시·범위 안 측정으로 해제, 같은 창 재이탈은 알림 창이 억제, `compartment` > 차량 항목 > 기본 종류 순, 범위 없으면 판정 안 함, 파일 수정 시각이 바뀌면 다시 읽기·깨진 파일은 `onInvalid` 한 번, stale 창보다 오래된 측정은 무시, 여러 센서 중 최신 값·모든 센서가 조용해야 stale), `telemetry/TemperatureSnapshotTest`(값 없으면 snapshot 바이트·ETag 불변, 오늘 날짜에만 `vehicleStates[v].temperature`, 값·stale 변화가 ETag `-t`에 반영, 기사 경로 `temperature`, 다른 날짜는 없음), `TemperatureHttpTest`(`latest`의 `range`·`outOfRange`). 허용 범위는 `telemetry/ranges.json`이며 **임시 위치**다: 자원 등록부 `vehicles` 필드로 옮길 예정이고 그때까지 값은 운영자가 파일로 관리한다. 기본 범위(냉동 -18 이하·냉장 0~5)와 연속 3개·10분은 근거 없는 초기값이다. 웹이 이 필드를 그리는 모습은 확인하지 않았다. 웹 소비처(`operations-adapter`·`source-context`·`vehicle-operations-model`)는 차량 상태의 키를 하나씩 읽고 어댑터는 `...state`로 통과시켜 알 수 없는 키를 거부하지 않는다(코드 읽기, `make check-web-app` 통과) TEST에서 연속 3개 이탈 `latest outOfRange`·알림 1건·범위 안 측정 해제는 관찰했으나 오늘 snapshot 노출은 오늘이 CSV 날짜라 못 봐 올리지 않음([2차 기록](history/test-poc-eta-telemetry-2026-10-16.md)). |
| [x] 미트박스 온도 송신 (17) | 서버 반영 | `telemetry/TemperatureBatcherTest`(1분 묶음 → 메시지 1건 → `/tms/temperature`에 messageId=`Idempotency-Key`로 전송·`sentAt`, 센서별 분리·500건 분할, 새 측정만 보냄·빠진 구간은 채우지 않음·늦게 온 오래된 측정은 다음 묶음에, 같은 분 재묶음은 id `-2`, 재시작 뒤 안 보낸 메시지 이어서 전송·보낸 측정 재전송 없음, 앞 메시지가 안 끝나면 뒤 메시지 대기, `4xx` 거절은 재시도 없이 `TEMPERATURE_REJECTED` 1회), `test/api-connection/kotlin-telemetry.test.mjs`의 실제 JAR 시나리오(토큰 401/404 → 수신 → 재전송 `accepted:0` → `latest`·이력 → 오늘 snapshot·기사 경로에 온도 → `/mock/meatbox/received?kind=temperature`에 `messageId` 키·측정 3건·`measuredAt`/`celsius` 두 키 → `ops/telemetry` pending 0·sent 1·알림 0 → 늦게 온 측정만 다음 메시지 → 재시작 뒤 최신 값 복원·재전송 없음). 계약 3.3 본문 그대로이며 `compartment`는 보내지 않는다. 미트박스 실 수신은 `업무 확인` 전이고 우리 모의 수신기까지만 통과했다. TEST 릴리스 `092f94bebb3e-9f924d3dce34b651`에서 관찰: 센서별·`measuredAt` 오름차순 메시지가 약 1분 뒤 모의 수신기에 도착(17건·2건), `messageId`=`Idempotency-Key`, `ops/telemetry` pending 0·failed 0. 미트박스 실 수신은 아님. 근거 [2차 기록](history/test-poc-eta-telemetry-2026-10-16.md). |

## 환경

| 항목 | 상태 | 메모 |
| --- | --- | --- |
| TEST 서버 | 서버 반영 | 블루/그린 단일 호스트 |
| QA 서버 | 미착수 | 비용 사유로 보류 |
| 운영 서버 | 미착수 | 비용 사유로 보류 |

## 완료 조건

- 우리 몫 항목: TEST 환경에서 해당 기능 PoC 통과가 `업무 확인`이다.
- 미트박스 송신 3종: 명세 수령 전은 모의 수신기 통과까지만. 실 송수신 확인이 `업무 확인`이다.
- 미트박스 자료가 전제인 항목: 자료 미수령이면 `업무 확인`으로 올리지 않는다.
- 운영 개시(4)는 QA·운영 서버와 사용자 교육까지 포함한다.
