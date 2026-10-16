# 검증 가이드

이 문서는 현재 저장소에서 어떤 명령이 어떤 주장을 뒷받침하는지 정의한다. 과거 문서의 테스트 수, 서버 주소, 배포 결과를 현재 결과로 복사하지 않는다.

## 증거 단계

각 단계는 바로 아래 단계의 결과를 포함한다고 가정하지 않는다. 필요한 단계를 각각 확인하고 기록한다.

| 단계 | 증명하는 내용 | 증명하지 않는 내용 |
| --- | --- | --- |
| 소스 구현 | 코드와 회귀가 저장소에 존재함 | 해당 커밋에서 테스트가 통과함 |
| 로컬 검증 | 특정 환경에서 명령이 성공함 | 배포 후보나 운영 서버가 같은 산출물을 사용함 |
| 운영 runtime | 운영 프로세스가 특정 불변 커밋·설정·상태로 응답함 | 실제 사용자 기기에서 업무가 끝까지 성공함 |
| 실기기·현장 | 지정 기기와 네트워크에서 수신·조작·복구를 관찰함 | 다른 OS·기기·통신사까지 일반화된 품질 |

결과에는 최소한 다음을 남긴다.

- 검증한 전체 commit SHA와 작업 트리 상태
- Node 및 OS 버전
- 실행한 명령 원문, 종료 코드, 시작·종료 시각
- 성공·실패·건너뜀의 개별 결과와 로그 위치
- 사용한 자료의 종류: 합성, 익명화 사본, 운영 읽기 전용, 운영 변경
- 포함하지 않은 계층: 배포, 데이터 이행, 실기기, 외부 공급자 등

## 저장소 공식 명령

다음 명령만 현재 `package.json`에 정의되어 있다.

| 명령 | 실제 실행 대상 | 사용 목적 |
| --- | --- | --- |
| `npm start` | `node server.js` | 애플리케이션 시작. 테스트 명령이 아님 |
| `npm test` | `node --test` | Node 테스트 탐색과 전체 회귀 |
| `npm run check:capacity` | `node scripts/capacity-check.mjs` | 합성 대용량 상태의 직렬화·복원·모델 변환 확인 |
| `npm run check:capacity:stream` | `node scripts/capacity-stream-check.mjs` | 합성 WebSocket 동시 연결과 변경 프레임 확인 |

`make check-api-contracts`의 계약 테스트는 오류 본문을 `test/api-connection/problem.mjs`의 `assertProblem`으로 검사한다(`application/problem+json`, `code`=`error`, `status`=HTTP 상태).

lint, typecheck, build, 브라우저 E2E, 배포 스모크용 npm 스크립트는 없다. [`vehicle-operations-browser-check.mjs`](../scripts/vehicle-operations-browser-check.mjs)와 Python 준비 스크립트용 테스트 파일은 존재하지만 `package.json`의 공식 명령에 연결되어 있지 않다. 필요한 도구·fixture·실행 계약을 별도로 확정하기 전에는 표준 릴리스 명령으로 간주하지 않는다.

## 기능별 소스와 회귀

| 주장 | 구현 근거 | 관련 테스트 | 현재 한계 |
| --- | --- | --- | --- |
| 초대·가입·로그인·비활성화 | [`access.js`](../lib/access.js), [`server.js`](../server.js) | [`access.test.js`](../test/access.test.js), [`gateway.test.js`](../test/gateway.test.js), [`portal-validation.test.js`](../test/portal-validation.test.js) | 역할·주문·차량 단위 인가 없음. 세션은 메모리 저장 |
| HTTP/WebSocket 인증과 Origin 검사 | [`server.js`](../server.js), [`state-broadcast.js`](../lib/state-broadcast.js) | [`gateway.test.js`](../test/gateway.test.js), [`state-stream.test.mjs`](../test/state-stream.test.mjs), [`state-broadcast.test.js`](../test/state-broadcast.test.js) | 실기기·공개 네트워크·TLS 검증 아님 |
| 날짜별 원본 조회 | [`dispatch-data.js`](../lib/dispatch-data.js) | [`dispatch-data.test.js`](../test/dispatch-data.test.js) | 외부 공급 API 수신 계약 없음 |
| 배차 초안·확정·수정과 체크포인트 | [`dispatch-operations.mjs`](../lib/dispatch-operations.mjs), [`source-operations-router.js`](../lib/source-operations-router.js) | [`dispatch-operations.test.mjs`](../test/dispatch-operations.test.mjs), [`source-operations-api.test.js`](../test/source-operations-api.test.js), [`system-integration.test.mjs`](../test/system-integration.test.mjs) | 동일 프로세스 날짜별 직렬화. 다중 프로세스 조정·감사 저장 없음 |
| 시나리오 상태와 ETA 표시 | [`operating-simulation.js`](../lib/operating-simulation.js), [`vehicle-timing.js`](../lib/vehicle-timing.js) | [`fleet-flow.test.js`](../test/fleet-flow.test.js), [`vehicle-timing.test.js`](../test/vehicle-timing.test.js), [`combined-adapter.test.mjs`](../test/combined-adapter.test.mjs) | 실제 GPS나 현장 도착 자료 기반 성능 검증 아님 |
| 지역 코드 자원 등록부 | [`resource-store.js`](../lib/resource-store.js), [`resource-router.js`](../lib/resource-router.js) | [`resource-api.test.js`](../test/resource-api.test.js) | 주문 DB나 B_AREA 배차 의미를 제공하지 않음 |
| 배송 사진 필수 UI | [`driver.mjs`](../apps/combined/driver.mjs), [`scenario-controls.js`](../lib/scenario-controls.js) | [`scenario-controls.test.js`](../test/scenario-controls.test.js), [`system-integration.test.mjs`](../test/system-integration.test.mjs) | 사진 업로드·서버 저장·증빙 ID 없음 |

관련 테스트가 있다는 사실은 해당 테스트가 현재 커밋에서 성공했다는 뜻이 아니다. 실행 결과를 별도 기록한다.

## 미트박스 송신 PoC 시나리오

미트박스의 실제 API 명세가 오기 전의 **PoC 통과 기준**이다. 실제 미트박스와의 송수신을 증명하지 않는다(`업무 확인`은 실 송수신). 송신기가 계약 3.1 본문을 `Idempotency-Key`와 함께 계약대로 우리 모의 수신기(계약 5절)에 보내고 수신기가 받는다는 것까지다.

- 시나리오: `test/api-connection/kotlin-state-owner.test.mjs`의 `Kotlin sends delivery-status messages to the mock Meatbox receiver after driver events`. 실제 JAR을 `--meatbox.mock-receiver.enabled=true`, `--meatbox.outbound.base-url=<자기 주소>/mock/meatbox`, 주기 1초로 띄운다.
- 순서: 배차 확정 → `departed` → 사진 업로드 → `stop_completed` → `GET /mock/meatbox/received`를 최대 15초 폴링.
- 기대: `dispatched`·`departed`·`delivered` 메시지가 도착하고, `Idempotency-Key`가 본문 `messageId`와 같고, `photos`가 사진 경로이고, `GET /api/ops/outbox`가 `pending 0`·`failed 0`이다.
- 나머지 동작(재시도 간격, 4xx 거절, 연결 거부 11회 알림, 재시작 뒤 이어 보내기, 저장 실패 시 송신함 미생성)은 `OutboxMessagesTest`, `OutboxSenderTest`, `MockMeatboxReceiverTest`, `OpsOutboxTest`가 시계를 주입해 확인한다.
- 포함하지 않음: 실제 미트박스 인증·끝점, 사진 서명 URL, TEST 서버 배포, ETA·온도 송신.

## 로컬 검증 순서

1. 검증 대상을 전체 SHA로 고정하고, 다른 변경이 섞이지 않았는지 확인한다.
2. [개발 환경](development.md)의 Node 조건과 잠금 파일 설치 조건을 맞춘다.
3. `npm test`를 실행하고 종료 코드와 실패·건너뜀을 기록한다.
4. 용량 또는 실시간 프레임 변경이 있으면 `npm run check:capacity`와 `npm run check:capacity:stream`을 추가한다.
5. 실패가 있으면 그 상태로 중단하고 원인을 분리한다. 일부 테스트 성공을 전체 성공으로 보고하지 않는다.
6. 테스트 이후 작업 트리에 예상하지 않은 파일 변경이 생기지 않았는지 확인한다.

용량 스크립트는 같은 프로세스의 합성 자료를 사용한다. 결과는 회귀와 비교에 사용할 수 있지만 운영 서버 용량, TLS 비용, DB 지연, 지도 타일, 실제 네트워크 SLA를 증명하지 않는다.

## 변경 유형별 최소 게이트

| 변경 유형 | 최소 소스·로컬 증거 | 추가로 필요한 증거 |
| --- | --- | --- |
| 문서만 변경 | 링크, 명령, 현재 소스와의 일치 | 배포 주장을 추가했다면 별도 runtime 근거 |
| 인증·세션 | 전체 회귀, 익명/잘못된 Origin/로그아웃/비활성화 거부 경로 | 공개 HTTPS, 재시작, 세션 저장소 장애, 계정별 인가 |
| 배차 상태·저장 | 전체 회귀, revision 충돌, 저장 실패, 정상 재시작 복원 | 동시 writer, 비정상 종료, 백업·복구, 운영 상태 보존 |
| 자원 등록부 | 전체 회귀, CAS 충돌, 재시작, 잘못된 DB fail-closed | 실제 원본 인수, 백업·복원, 여러 프로세스 동시 쓰기 |
| GPS·ETA | 계산 회귀와 누락값 처리 | 실제 기기 시각·정확도·지연을 포함한 재생 시험과 현장 표본 |
| 사진·알림 | UI/명령 회귀 | 저장 객체, 재시작 조회, 보존·삭제, 공급자 접수, 실기기 수신·클릭 |
| 배포 | 후보 SHA의 로컬 검증 | 불변 산출물, runtime SHA, readiness, 롤백, 인증 화면 |

## 운영 runtime 확인

운영 확인은 배포 전에 만든 후보와 배포 후 실행 상태를 연결해야 한다.

1. 후보 commit SHA와 검증 결과를 고정한다.
2. 배포된 파일 또는 이미지가 그 후보에서 만들어졌음을 확인한다.
3. 프로세스가 읽은 필수 환경 변수와 상태 경로를 비밀값 없이 기록한다.
4. readiness와 인증된 핵심 조회를 확인한다.
5. 기존 확정 배차, 진행 상태, 계정, 체크포인트가 보존됐는지 읽기 전용으로 비교한다.
6. 실패 시 이전 산출물과 상태를 복원하는 절차를 실제로 검증한다.

현재 저장소에는 runtime SHA를 노출하는 전용 health/readiness endpoint가 없다. 서비스 프로세스가 응답한다는 사실만으로 실행 SHA를 확정할 수 없다. [`meatbox-gateway.service`](../deploy/meatbox-gateway.service)와 [`Caddyfile`](../deploy/Caddyfile)은 배포 예시 구성이고 특정 릴리스가 운영 중이라는 증거가 아니다.

## 실기기·현장 확인

실기기 결과에는 기기 모델, OS·브라우저 또는 앱 버전, 네트워크, 계정 역할, 운영 날짜, 주문/배차 식별자, 관찰 시각을 남긴다.

- GPS: 장치 시각, 서버 수신 시각, 정확도, 오래된 위치 거절, 권한 철회, 백그라운드 복귀
- ETA: 입력 위치·경로·서비스 시간의 출처, 예측 시각, 실제 도착 시각, 누락 구간, 평가 규칙
- 사진: 촬영/선택, 업로드 완료, 서버 증빙 ID, 재시작 후 조회, 권한이 다른 계정의 접근 거절
- 알림: 내부 이벤트 생성, 공급자 접수, 기기 표시, 탭 후 올바른 주문 이동을 각각 기록
- 오프라인: 명령 ID, 재연결, 중복 실행 방지, 오래된 상태 거절, 최종 서버 상태

브라우저의 로컬 미리보기, mock 응답, 등록된 기기 수, 공급자 접수는 실제 수신·표시·클릭의 대체 증거가 아니다.

## CI 상태

저장소에는 `.github/workflows` 또는 다른 CI 파이프라인 정의가 없다. 따라서 로컬 명령의 성공만 기록할 수 있으며 “CI 통과”라고 보고할 수 없다. 운영 전에는 최소한 `npm ci`와 `npm test`를 깨끗한 격리 환경에서 실행하고, 실패 시 배포를 차단하며, 결과를 commit SHA에 연결하는 자동화가 필요하다.

운영 전 미완료 게이트의 우선순위는 [운영 준비도](production-readiness.md), 실제 배포·백업 절차는 [운영 가이드](operations.md)를 따른다.
