# Push Lab TEST 관제 화면 구현 계약

작성일: 2026-09-23 · 상태: 구현 전 계약 · 범위: `meatbox-web-push-pilot` worktree의 로컬 mock

## 1. 결과와 경계

독립된 `/push-lab/control/` 화면에서 관리자가 TEST 배송을 만들고, 만료되는 고객 초대 링크를 한 번 복사하고, 배송 단계를 변경하고, **선택한 구독 한 건**에 테스트 알림을 enqueue하고, 구독·발송 결과를 읽는다. 고객은 기존 `/push-lab/`에서 자기 초대의 배송만 조회하고 별도 동의와 브라우저 권한을 거쳐 구독한다. 기존 TMS 로그인과 무관하다.

초기 화면은 밀도 높은 배송 표 하나이며 행 선택 시 같은 화면의 상세 영역에 구독과 발송 이력을 표시한다. 목록 필터·새 배송 입력은 간결한 인라인 컨트롤로 둔다. 카드형 대시보드, 별도 상세 페이지, 전체/대량 발송, 삭제, 실배송 입력 기능은 없다. 모든 배송과 발송 표시는 `TEST`라고 쓴다. `accepted`는 mock 또는 FCM의 **서버 접수**일 뿐 실제 기기 수신·표시 증거가 아님을 상태 옆에 상시 표시한다.

기본 sender는 기존 `mock`이다. real sender, FCM 자격증명, allowlist, 서버·DNS·Caddy·운영 DB는 건드리지 않는다. `deployment_probe`와 `deliverable=false`는 목록/선택/발송에서 제외하며, 기존 worker의 FID allowlist 검사와 구독·만료·revision claim 경계를 그대로 적용한다. 새 패키지는 추가하지 않는다.

## 2. 기준 구현과 재사용 지점

- `PushLabService.createFixture()`는 배송과 초대를 한 transaction으로 만들고 32-byte 랜덤 코드는 해시만 저장한다. 관제 생성은 이 메서드를 재사용한다.
- `exchangeInvite()`는 초대의 1회 CAS 소비, 2분 동일 교환키 재시도, 고객 세션의 배송 권한을 제공한다. 고객 API와 `mb_push_session` 쿠키는 유지한다.
- `emitEvent()`는 revision CAS와 `(event_id, subscription_id, notification_type)` 중복 방지를 수행한다. 현재는 완료 단계에서만 이전 대기 outbox를 즉시 취소한다. 관제 단계 변경은 같은 transaction 경계를 재사용하되 **알림 자동 enqueue 없이** 상태 이벤트를 남기고 이전 revision의 `queued/retrying` 작업을 즉시 취소하도록 작은 옵션/메서드로 확장한다. 기존 CLI 호출의 기본 enqueue 동작은 보존한다.
- 개별 발송은 `emitEvent()`의 전체 활성 구독 fanout을 호출하지 않는다. 같은 DB transaction·event ID 중복 검사·outbox 유일 키를 사용하되 지정한 `subscriptionId` 한 건만 insert하는 service 메서드를 둔다. 고객 `enqueueSelfTest()`는 고객 세션/설치 proof용이므로 관리자 인증에 재사용하지 않는다.
- 기존 `WorkerStore.claim()`은 발송 직전에 delivery, 구독, revision, 만료를 재검사한다. 관제 HTTP 핸들러가 직접 FCM을 호출하지 않는다.

## 3. 관리자 인증과 환경

관제 API prefix는 `/push-lab/control/api/`, 정적 파일 prefix는 `/push-lab/control/`이다. **모든 관제 데이터·변경 권한은 서버가 검사**한다. 로그인 화면의 정적 껍데기는 공개 가능하지만 배송 데이터는 인증 전 렌더하지 않는다. 고객 `mb_push_session`·설치 쿠키나 브라우저의 `isAdmin` 값은 관리 권한이 아니다. 관리자 전용 `mb_push_admin_session`은 `Secure; HttpOnly; SameSite=Strict; Path=/push-lab/control/`로 발급하고, DB에는 원문이 아닌 SHA-256 세션 토큰 해시·CSRF 해시·생성/만료 시각만 둔다. 관리자 CSRF 원문은 랜덤 세션 토큰과 hash 파일 derived key의 HMAC-SHA256으로 결정적으로 생성하며, UI 재시작 후 `GET /session`에서 같은 방식으로 복구한다. 관리자 세션에 암호화 CSRF 값이나 `EXCHANGE_KEYS` 의존성은 없다. hash 파일의 비밀번호 교체로 derived key가 바뀌면 기존 관리자 세션은 CSRF 해시 검증에 실패해 무효가 되고 다시 로그인해야 한다. 만료는 로그인부터 최대 8시간, 로그아웃 시 서버에서 폐기한다.

기본 계정/비밀번호/비밀값은 없다. `PUSH_LAB_ADMIN_PASSWORD_HASH_FILE`이 가리키는 컨테이너 read-only 파일에 운영자가 만든 `saltHex:derivedKeyHex` 한 줄을 넣는다. `salt`는 16-byte 이상, derived key는 Node `scrypt`의 `N=16384,r=8,p=1,keylen=64` 결과다. 파일 미설정·형식 오류·읽기 오류면 관리자 로그인/관제 API를 fail-closed `503 admin_unconfigured`로 처리한다. 원문 비밀번호·hash 파일은 이미지, Git, 브라우저 bundle, 응답, 로그에 넣지 않는다. 테스트는 임시 fixture hash 주입으로만 구성한다. 같은 origin의 두 웹 슬롯은 동일 hash 파일과 SQLite를 사용해야 한다. 배포 설정 변경은 이 로컬 구현 범위 밖이다.

`GET /push-lab/control/api/login-challenge`는 5분짜리 임의 login CSRF를 `mb_push_admin_login_csrf`라는 `Secure; HttpOnly; SameSite=Strict; Path=/push-lab/control/` 쿠키와 JSON `csrfToken`으로 준다. 로그인 POST는 해당 쿠키와 `X-CSRF-Token`의 일치, 정확한 `Origin === ALLOWED_ORIGIN`, `Content-Type: application/json`, scrypt 검증을 요구한다. 로그인 실패는 동일한 `401 invalid_credentials`로 응답하고 비밀번호를 기록하지 않으며 DB 기반 실패 횟수 제한(접속원별 5회/15분, 429)을 적용한다. 접속원은 `req.socket.remoteAddress`를 사용하며 임의 `X-Forwarded-For`를 믿지 않는다. 그 외 모든 관제 mutation은 정확한 Origin, 유효 관리자 세션 및 해당 세션의 `X-CSRF-Token`이 필수다. GET은 서버 세션 검증이 필수이고 모든 관제 응답은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`를 적용한다. 로그인 challenge와 로그인 이외의 관제 API는 익명 호출 불가다.

초대 원문은 생성/재발급 성공 응답에만 한 번 포함하고 DB에는 해시만 둔다. UI는 링크를 일시적으로 보여 복사하게 하고 페이지 재방문·목록·상세에는 다시 노출하지 않는다. URL은 기존 고객 파서가 받는 `${ALLOWED_ORIGIN}/push-lab/#invite=${encodeURIComponent(inviteCode)}`이며 fragment는 요청·Referer로 보내지지 않는다. 링크 복사 후 화면에서 지울 수 있고, 재발급은 이전 미사용 초대를 transaction에서 만료시킨다. 이미 교환된 고객 세션은 재발급만으로 철회하지 않는다.

## 4. HTTP 계약

JSON 요청/응답. 시각은 epoch milliseconds. ID는 불투명한 문자열이다. 아래 모든 경로는 `/push-lab/control/api` 기준이며 오류는 기존 `{ "error": "code" }` 형식이다. `401`은 관리자 세션 없음/만료, `403`은 Origin/CSRF 오류, `404`는 범위 밖 또는 존재하지 않는 TEST 배송/구독, `409`는 상태·revision·idempotency 충돌, `410`은 배송 만료, `429`는 로그인 제한이다. 쓰기 성공은 DB commit 후에만 응답한다.

| Method / path | 요청 | 성공 응답 및 부작용 |
|---|---|---|
| `GET /login-challenge` | 없음 | `200 {csrfToken}` + login CSRF 쿠키. 비밀 설정 오류 시 503 |
| `POST /login` | `{password}` + login CSRF 헤더/쿠키 | `200 {authenticated:true,csrfToken,expiresAt}` + 관리자 세션 쿠키. 기존 고객 쿠키는 무시 |
| `GET /session` | 관리자 쿠키 | `200 {authenticated:true,csrfToken,expiresAt}`. 만료면 401 |
| `POST /logout` | 관리자 쿠키 + CSRF | `200 {authenticated:false}` + 서버 세션 삭제/쿠키 만료 |
| `GET /deliveries?limit=50&cursor=...` | 관리자 쿠키 | `200 {deliveries:[{id,userId,stage,revision,baselineAt,etaAt,expiresAt,activeSubscriptions,latestStatus}],nextCursor}`. `scope=test`/`deliverable=1`만, 최신순, 최대 50. cursor는 안정적 `(createdAt,id)` 또는 기존 schema의 `(baselineAt,id)` 키셋 |
| `POST /deliveries` | `{userId,stage?,baselineAt?,etaAt?,expiresAt?}` | `201 {delivery:{id,userId,stage,revision,baselineAt,etaAt,expiresAt},invite:{url,expiresAt}}`. 서버가 배송 ID와 invite code 생성; TEST 사용자 별칭만 허용, 단계는 7개 상수 중 하나, 만료는 현재 이후 최대 24시간, ETA ≥ baseline. 기본 단계 `배송대기` |
| `GET /deliveries/:id` | 관리자 쿠키 | `200 {delivery:{id,userId,stage,revision,baselineAt,etaAt,expiresAt},subscriptions:[{id,status,providerActive,subscribedAt,expiresAt}],outbox:[{id,eventId,notificationType,status,attempts,availableAt,updatedAt,errorClass}]}`. 최근 outbox 최대 50, 최신순. FID·proof·세션·초대·provider 원문 식별자 제외 |
| `POST /deliveries/:id/invitations` | `{}` + 관리자 CSRF | `201 {invite:{url,expiresAt}}`. 미사용 초대는 같은 transaction에서 만료, 새 초대는 `min(now+1h,delivery.expiresAt)`까지. 이미 소비된 초대/세션은 보존. 재요청은 새 링크이므로 UI에서 명시적 1회 동작 |
| `POST /deliveries/:id/stage` | `{stage,expectedRevision,eventId}` | `200 {delivery:{id,stage,revision},enqueued:0}`. 7단계 중 **바로 다음 단계만** 허용. 서버가 expectedRevision과 현재 revision CAS 후 기존 `emitEvent` transaction에서 이전 대기 알림 취소; 이벤트 타입 `stage_change`, 자동 발송 0. 같은 eventId+동일 payload는 저장된 결과를 반환, 다른 payload는 409 |
| `POST /deliveries/:id/test-notifications` | `{subscriptionId,eventId,expectedRevision}` | `202 {eventId,outboxId,status:"queued",enqueued:1}`. 현재 배송 revision과 선택 구독을 확인하고 `manual_test` 한 건만 enqueue. 동일 eventId+동일 payload는 기존 outbox/상태 반환; payload 변경은 409. 배송/구독 만료·철회·provider inactive·`deployment_probe`는 거부. TTL은 `min(now+5min,delivery.expiresAt)` |

단계 변경과 수동 알림에서 `eventId`는 클라이언트가 동작 시작 시 한 번 생성하는 UUID이며 응답 유실 재시도에는 그대로 사용한다. `expectedRevision`은 선택한 배송 상세의 값이고 동시 변경 시 409를 보여 새로고침한다. `accepted`, `unknown`, `failed` 등 outbox 상태는 상세 재조회로 관찰한다. `enqueued=1`도 기기 수신을 뜻하지 않는다. 수동 발송 버튼은 구독 한 행을 명시적으로 선택한 뒤에만 활성화한다.

## 5. 구현 소유권과 결합점

| 담당 | 소유 파일 | 책임 |
|---|---|---|
| 서버 담당 | `services/push-lab/server/{http,service,db,admin-auth}.mjs`, 신규 `services/push-lab/migrations/005_*.sql`, 서버 중심 `services/push-lab/test/*control*.test.mjs` | 관리자 인증·쿠키·Origin/CSRF·API·TEST 조회·재발급·CAS·개별 outbox. 기존 고객 API/worker 계약 유지 |
| 화면 담당 | 신규 `services/push-lab/public/control/{index.html,app.mjs,styles.css}` 및 화면 단위 테스트 | 한 화면 배송 표·선택 상세·행별 TEST 알림·링크 일시 복사·발송 상태 문구. 서버 파일/고객 화면은 수정하지 않음 |
| 계획 담당 | `docs/plans/web-push-pilot-plan.md`, `docs/plans/push-lab-control-console-plan.md` | 이 계약과 구현 결과의 경계 기록 |

서버 담당이 `/push-lab/control/` 정적 경로를 별도 allowlist로 서빙하고 기존 `/push-lab/` 고객 정적 서빙과 겹치지 않게 한다. 특히 `/push-lab/control/api/*`는 정적 파일 fallback 전에 처리하고, 임의 파일 경로 접근을 막는다. 화면 담당은 위 JSON 필드와 오류 코드만 사용하며 서버 내부 import를 하지 않는다. 화면은 관리자 쿠키를 읽을 수 없고 `GET /session`의 성공으로만 권한을 안다.

## 6. 완료 검증

1. 관리자 비밀 미설정 시 fail-closed, 잘못된 로그인/CSRF/Origin 및 고객 세션만 가진 호출은 관제 데이터·mutation 접근 0건. 로그인 제한, 로그아웃, 8시간 만료, 재시작 후 세션 조회 확인.
2. TEST 배송 생성 → fragment 초대 링크 복사 → 고객 페이지에서 교환 → 해당 배송만 조회 → 명시 동의/브라우저 권한 → 등록/구독. 초대 만료·재발급 시 기존 미사용 링크 거절, 이미 교환된 세션 유지.
3. 단계 변경의 순서·revision 경합·eventId 재시도와 알림 자동 enqueue 0건 확인. 수동 발송은 선택 구독 1건만 outbox에 생성되고 중복 요청에도 1건이다. 철회/만료/배송 완료 이후 worker claim은 기존 경계를 지킨다.
4. mock worker 처리 후 관제 상세에 `accepted`와 mock 접수가 보이고, UI가 실제 기기 수신으로 오해시키지 않는다. FID·초대 원문·관리 비밀은 목록/상세/로그/번들에 없다.
5. 기존 고객 API·테스트, worker allowlist·CAS, readiness, 정적 경로가 회귀하지 않는다. 이 로컬 결과는 실제 FCM 접수·휴대폰 표시·공개 HTTPS 배포 증거가 아니다.
