# Android 배송원 TEST 데모 계약

기준일: 2026-10-13, Asia/Seoul. Firebase 적용 앱 후보는 **0.1.0 (versionCode 2)**이며 Android package는 `com.evnsolution.meatbox.driver`다.

## 범위와 인증

기존 TMS 계정으로 로그인하고 당일 차량을 수동 선택하는 TEST 데모다. 로그인한 TMS 사용자가 차량을 선택할 수 있다. 차량 선택과 메시지의 `from` 값은 실제 운전자 신원이나 운영자 역할을 증명하지 않는다. 별도 운전자 계정·차량별 권한 체계는 이번 구현에 포함하지 않는다.

서버 소유자는 Kotlin API다. 기존 로그인·세션 쿠키와 공개 origin 검사를 사용한다. 앱은 비밀번호를 저장하지 않고 `/api/session`으로 로그인 결과를 확인한다. 앱 실행·설정·화면 동작은 [앱 README](../apps/driver/README.md), 서버·웹 책임은 [확정 아키텍처](new-stack-architecture.md)를 따른다.

## 배송 명령

기본 경로는 `/api/dispatch-data/days/{date}`다. `GET /state`가 반환한 `boot`와 `revision`을 다음 `POST /commands`의 `expectedBoot`, `expectedRevision`으로 보낸다. 쓰기는 유효한 세션, 일치하는 `Origin`, JSON 본문을 요구한다. 성공 응답은 `{state,result}`다.

| 명령 | 명령별 필수 필드 | 동작과 거부 조건 |
| --- | --- | --- |
| `start_route` | `vehicleId` | 시작 전 차량의 첫 대기 배송지 묶음을 현재 배송지로 바꾼다. 이미 출발했거나 대기 주문이 없으면 거부한다. |
| `arrive_stop` | `vehicleId`, `orderId` | 현재 이동 중인 배송지 묶음을 도착 처리한다. 다른 차량·다른 배송지와 반복 도착 처리를 거부한다. |
| `complete_stop` | `vehicleId`, `orderId` | 도착한 현재 배송지 묶음을 완료하고 다음 대기 배송지로 이동한다. 도착 전 완료를 거부한다. |
| `set_route_order` | `vehicleId`, `order`, `expectedOrder`, `expectedStatuses`, `expectedPhase` | 현재 순서·상태·차량 단계가 요청 기준과 일치해야 한다. 같은 배송지 주문은 붙여 두며 현재·완료·보류 주문 위치를 보호한다. |

모든 명령은 `type`, `expectedBoot`, `expectedRevision`도 포함해야 한다. `order`와 `expectedOrder`는 주문 ID 배열이다. 배송지 묶음에는 동일 배송지의 원본 주문 ID 전체를 포함한다. `arrive_stop`과 `complete_stop`에는 `stopId` 대신 해당 차량의 원본 `orderId`를 보낸다.

배차 전송이 선행되어야 운행 명령을 처리한다. 상태 충돌은 409로 거부한다. 앱은 최신 상태를 조회한 뒤 사용자가 상태를 확인하도록 한다. 서버는 과거 날짜의 명령을 거부한다. 수령 QR 확인 내역은 기기 로컬 상태이므로 서버가 `start_route`에서 수령 증빙을 검증하는 계약은 아니다.

## 메시지와 기기 등록 API

모든 경로는 기존 TMS 세션으로 보호한다. 변경 요청은 공개 origin과 일치하는 `Origin` 및 `Content-Type: application/json`을 요구한다. 날짜는 유효한 `YYYY-MM-DD`이며 배차 원본에 존재해야 한다. 차량은 해당 날짜의 `fleetVehicles`에 존재해야 한다.

| 메서드·경로 | 요청 | 성공 응답 |
| --- | --- | --- |
| `PUT /driver/push-token` | `{vehicleId,token,deviceId,platform:"android"}` | `{registered:true}` |
| `DELETE /driver/push-token` | `{token}` | `{unregistered:true}` |
| `GET /driver/messages?vehicleId=...` | 차량 ID query | `{messages:[{id,from,body,createdAt}]}` |
| `POST /driver/messages` | `{vehicleId,body,from:"driver"\|"ops"}` | `{message:{id,from,body,createdAt},push:{status,attempted,sent,failed}}` |

변경 요청은 표에 명시된 키만 허용한다. 중복 키, 이어 붙인 JSON, 객체가 아닌 JSON, 잘못된 필드 타입을 거부한다. 본문은 최대 8,192바이트다. 문자열은 빈 값과 앞뒤 공백을 허용하지 않는다. 메시지 본문에는 줄바꿈을 허용한다.

- `body`: 최대 1,000자.
- `vehicleId`, `deviceId`: 최대 128자. `deviceId`는 null을 허용하지 않는다.
- `token`: 최대 4,096자. 토큰과 기기 ID에는 공백을 허용하지 않는다.
- 사용자별 변경 요청: 분당 30회. 메시지 조회: 분당 120회. 초과 시 429와 `Retry-After: 60`을 반환한다.
- 날짜별 메시지: 최대 2,000개. 날짜별 기기 등록: 최대 1,000개, 차량별 최대 3개. 상한을 넘으면 409를 반환한다.

과거 날짜 또는 `dispatch.readOnly` 상태에서는 메시지 전송과 기기 등록을 409 `DRIVER_DATE_READ_ONLY`로 거부한다. 과거 메시지 조회와 기존 토큰 해제는 허용한다. DELETE는 로그인한 사용자의 등록만 제거하며 다른 사용자의 등록을 제거하지 않는다.

메시지를 먼저 저장하고 푸시를 처리한다. 응답이 끊겼다면 재전송 전에 메시지 기록을 조회해야 한다. 메시지 POST에는 중복 요청을 합치는 idempotency 계약이 없다.

| `push.status` | 의미 |
| --- | --- |
| `sent` | 대상 전부의 요청을 FCM이 수락했다. 기기 수신·표시·읽음은 확인하지 않는다. |
| `partial` | 일부 대상의 요청만 FCM이 수락했다. |
| `failed` | 인증 준비 또는 FCM 요청이 실패했다. 메시지 기록은 저장되어 있다. |
| `unconfigured` | 서버 FCM 설정이 없어 푸시를 요청하지 않았다. |
| `no-device` | 유효한 등록 기기가 없다. |
| `not-requested` | 배송원의 답장이다. 운영 웹은 메시지를 조회하며 푸시는 요청하지 않는다. |

`attempted`, `sent`, `failed`는 서버가 처리한 대상 수다. `sent`는 FCM 수락 수이며 실제 기기 전달 수가 아니다. 서버는 토큰·세션 digest·서비스 계정 키를 API 응답에 포함하지 않는다.

## 상태 저장과 세션 만료

메시지와 등록은 `MEATBOX_DISPATCH_STATE_DIR`의 `driver-{date}.json`에 저장한다. schemaVersion은 2다. 파일 권한은 0600이며 임시 파일을 기록한 뒤 atomic rename으로 교체한다. 저장 실패는 성공으로 반환하지 않는다.

등록에는 `username`, `sessionDigest`, `vehicleId`, `token`, `deviceId`, `platform`을 저장한다. `sessionDigest`는 기존 세션 토큰의 SHA-256이며 raw cookie를 저장하지 않는다. 동일 사용자의 동일 `deviceId` 재등록은 토큰과 차량 선택을 교체한다.

새 등록과 메시지 저장 전에 기존 AuthService로 세션과 계정 상태를 확인한다. 로그아웃, 계정 비활성화, 8시간 세션 만료에 해당하는 등록은 제거한다. 제거한 등록은 차량별 3개 상한과 푸시 대상에 포함하지 않는다. native AuthService가 없는 호환 모드에서는 기기 등록·푸시 대상을 허용하지 않는다.

`.driver-state.lock`의 OS 파일 잠금은 여러 API 프로세스의 읽기·변경·저장 구간을 직렬화한다. 1초 안에 잠금을 얻지 못하면 503 `DRIVER_STATE_BUSY`를 반환한다. 프로세스가 종료되면 OS가 잠금을 해제한다. 이 잠금의 범위는 메시지·기기 상태 파일이다. 인증 세션 판정은 각 API 프로세스의 기존 AuthService를 사용하며 별도 분산 세션 동기화 기능을 추가하지 않는다.

FCM의 `UNREGISTERED` 등 공급자 거부는 실패로 보고한다. 해당 응답만으로 등록을 즉시 삭제하는 기능은 아직 없다. 등록은 세션 유효성 검사, 재등록 교체, DELETE로 정리한다. 날짜별 메시지 파일의 자동 보관 기간·자동 삭제 정책도 추가하지 않는다.

## FCM 설정

서버 환경에 다음 값을 설정한다. 서비스 계정 키는 저장소와 릴리스 정적 자산 밖에 둔다.

```text
MEATBOX_FCM_PROJECT_ID=<Firebase 프로젝트 ID>
MEATBOX_FCM_SERVICE_ACCOUNT_FILE=<외부 서비스 계정 JSON의 절대 경로>
```

서비스 계정 JSON은 서버 실행 사용자 `meatbox-demo`가 읽을 수 있어야 한다. 파일 소유자는 `meatbox-demo`, 권한은 0600으로 관리한다. 코드에서 파일과 상위 경로의 심볼릭 링크를 허용하지 않는다. 설정은 기존 서버 환경 관리 절차로 적용한다. 이번 데모를 위해 privileged 배포 스크립트를 수정하지 않는다.

Android에는 Firebase Android 앱의 `google-services.json`만 제공한다. 앱의 `GOOGLE_SERVICES_JSON` 경로 또는 Git에서 제외된 `.private/google-services.json`을 사용한다. 서버 서비스 계정 키를 앱에 넣지 않는다. 앱 설정 변경 후 네이티브 빌드가 필요하며 구체적인 절차는 [앱 README](../apps/driver/README.md)를 따른다.

TEST Firebase 프로젝트는 `meatbox-push-pilot-20260923`다. `Meatbox Driver TEST` Android 앱을 등록하고 package 일치를 확인했다. 기존 Web Push 파일럿의 FCM 전송 계정과 키를 서버 안에서 재사용한다. Android 구성 파일, 서비스 계정 키와 인증 토큰은 Git·CI artifact·문서에 포함하지 않는다. 앱 빌드에는 공개 클라이언트 설정에 해당하는 Firebase 리소스만 포함한다.

서버는 Google OAuth와 FCM HTTP v1 주소를 고정해서 사용한다. 서비스 계정 JSON의 임의 `token_uri`로 요청하지 않는다. RS256 서명, `firebase.messaging` scope, 만료 전 access token 갱신을 사용한다. 토큰 교환과 최대 3개 기기 요청의 전체 처리 예산은 4초다. 공급자 응답 실패를 임의 성공으로 바꾸거나 자동 재전송하지 않는다. 공급자 계약은 [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [서비스 계정 OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)를 따른다.

알림에는 `미트박스 배송`과 `운영팀의 새 메시지가 있습니다.`라는 일반 문구만 보낸다. data는 `type:"ops_message"`, `date`, `vehicleId`, `messageId`, 일반 `title`, 일반 `body`를 포함한다. 운영자가 입력한 원문은 푸시 payload에 넣지 않는다. 앱은 인증된 메시지 API에서 원문을 조회한다.

사용자에게 표시되는 Android 운영 알림은 `priority: "HIGH"`, `notification.channel_id: "meatbox-driver"`를 사용한다. 앱은 같은 채널을 생성한다. 실행 중 토큰이 바뀌면 새 토큰을 등록하며, 앱이 foreground로 돌아오면 알림 권한과 토큰을 다시 확인한다. 토큰 이벤트는 전달받은 토큰을 직접 사용해 토큰 조회가 반복되는 것을 막는다.

`type:"route_changed"`(운영자가 배차를 바꿈)도 같은 채널과 같은 정책으로 보낸다. 본문은 변경 건수만 담은 서버 문장이고 규칙은 [API 참조](api-reference.md#배차-변경-푸시-route_changed)에 있다.

FCM이 미설정이거나 등록이 실패해도 메시지 저장과 조회는 사용할 수 있다. 앱은 활성 상태에서 10초마다 조회한다. 웹 메시지 창은 열려 있는 동안 5초마다 조회한다. 이 조회 기능은 백그라운드 기기 알림을 보장하지 않는다.

## 웹 QR과 확인 범위

운영 웹의 차량별 `수령 QR 출력`은 주문마다 `meatbox:YYYY-MM-DD:<orderId>` QR을 생성한다. QR에는 날짜와 주문 ID만 포함한다. 앱은 다른 날짜·다른 차량·미등록·중복 스캔을 구분한다. 수령 확인은 해당 기기에 저장한다. 서버의 수령 증빙이나 실제 인수 확인 기록으로 해석하지 않는다.

2026-10-13 후보에서 Kotlin backend 테스트 **99개 통과**를 확인했다. 이 검사는 배송 상태·거부 조건, 메시지 저장, 입력·세션 경계, 저장 실패, 잠금, 모의 OAuth/FCM 응답을 포함한다. 실제 FCM 수신의 증거는 아니다.

사용자는 실제 Android 기기 사용을 보류했다. 기기 설치, QR 카메라, 네이티브 지도·권한, 앱 재시작 후 세션 복원, 실제 푸시 수신은 아직 검증하지 않았다. 앱의 타입 검사·lint·도메인/API 테스트 18개, 웹 테스트 295개·산출물 검사 4개, 기존 루트 테스트 267개, 실제 Kotlin JAR API 검사 57개가 통과했다. 합성 자료로 로그인·배차 계산/전송·주문별 QR·메시지 저장을 브라우저에서 확인했다. A4 인쇄는 QR 3개가 1페이지, 카드 27개가 3페이지이며 마지막 카드의 잘림이 없음을 확인했다.

SDK 56 템플릿으로 ARM64 Android APK 빌드가 성공했다(7분 53초). Google 서비스 설정이 없는 기본 debug keystore 서명 TEST APK다. npm audit는 high 20·critical 0이며 원인 advisory는 수정 버전이 없는 braces와 node-forge 두 종류다. 이번 release Metro source map의 1,303개 경로에는 두 패키지가 없다. 자세한 의존성 제한은 앱 README를 따른다. CI와 TEST 배포 결과는 별도 전달 기록에서 확인한다.

위 미설정 APK는 versionCode 1의 초기 검증 결과다. Firebase 적용 후보는 versionCode 2로 구분한다. 구성 파일 검증을 포함한 앱 검사 21개와 FCM payload 단위검사 3개가 통과했다. TEST 서버의 `meatbox-demo` 사용자와 설정된 키로 Google OAuth 및 FCM `validate_only: true` 요청이 모두 HTTP 200을 반환했다. 이 검사는 인증·권한·요청 형식만 확인하며 실제 기기에 전달하지 않는다. 새 APK·CI·TEST 배포 결과는 PR 전달 기록으로 연결하고, 실제 기기 수신과 알림 표시 여부는 기기 검증 때 확인한다.

후속 전달은 [작업 기준](delivery-workflow.md)과 [TEST 배포·복구 절차](../deploy/new-stack/README.md)를 따른다.
