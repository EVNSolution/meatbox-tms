# 미트박스 Android 배송원 앱

Expo SDK 56 / React Native 0.85.3. Android package: `com.evnsolution.meatbox.driver`. Firebase 적용 TEST 후보는 `0.1.0(2)`입니다.

## 실행과 검사

```sh
npm ci
npm run check
npx expo install --check
npm run prebuild:android
npm run android
```

`npm run check`는 TypeScript, 테스트, lint를 순서대로 실행합니다. `npm run prebuild:android`는 SDK 56 템플릿 `expo-template-bare-minimum@56.0.37`을 고정하고 의존성을 다시 설치하지 않습니다.

`metro.config.js`는 Expo 기본 설정을 유지하고 Metro 변환 worker만 2개로 제한합니다. 이 설정은 전체 Node 또는 네이티브 빌드 메모리 상한이 아닙니다.

`npm run android`는 연결된 기기에 설치할 수 있으므로 기기 사용 허가가 있을 때만 실행합니다. 개발 서버는 `npm start`로 실행합니다. MapLibre와 FCM은 Expo Go 대신 개발/릴리스 네이티브 빌드가 필요합니다.

`.env.example`의 TEST API origin을 확인하고 필요한 경우 `.env`로 복사합니다. API 인증서가 Android에서 신뢰되어야 합니다. 인증서 검증을 끄는 설정은 없습니다. 모의 서버로 대체하는 기능은 없습니다.

Firebase Android 앱의 `google-services.json`을 `.private/google-services.json`에 저장하거나 `GOOGLE_SERVICES_JSON` 경로를 지정합니다. 서비스 계정 키는 앱에 넣지 않습니다. 서버의 FCM 설정에만 사용합니다. 설정 파일의 Android package가 일치해야 합니다. 명시한 파일이 없거나 서비스 계정 키이면 prebuild를 중단합니다. 설정이 없거나 알림 권한/토큰 등록이 실패하면 앱에 푸시 연결 실패가 표시됩니다. 메시지는 앱에서 서버를 조회해 확인할 수 있습니다.

## GitHub Actions TEST APK 빌드

기본 빌드 경로입니다. Actions의 **Driver APK** workflow를 `main`에서 수동 실행합니다. 다른 브랜치나 태그에서는 실행되지 않습니다.

- `android-test` 환경의 Secret 5개를 사용합니다: `DRIVER_GOOGLE_SERVICES_JSON`, `DRIVER_KEYSTORE_BASE64`, `DRIVER_KEYSTORE_PASSWORD`, `DRIVER_KEY_ALIAS`, `DRIVER_KEY_PASSWORD`.
- 배송원 전용 PKCS12 키로 서명합니다. 인증서 SHA-256이 workflow의 `EXPECTED_CERT_SHA256`과 다르면 실패합니다. debug keystore로 대체하지 않습니다.
- Secret이 없거나 Firebase 설정이 이 패키지와 맞지 않으면 실패합니다.
- 결과는 artifact `meatbox-driver-apk-run<실행 ID>-<Git SHA>`이며 14일 보관합니다. APK, `SHA256SUMS`, 비밀값 없는 `metadata.json`이 들어 있습니다.
- 복원한 Firebase 설정과 keystore는 성공·실패와 관계없이 마지막 단계에서 지웁니다.

전용 키 APK는 debug 서명 APK와 서명이 달라 그 위에 업데이트로 설치되지 않습니다. 기존 debug APK를 지운 뒤 설치합니다.

## 로컬 TEST APK 빌드 (비상용)

Android SDK와 JDK 21을 준비한 뒤 앱 디렉터리에서 실행합니다. SDK 56 템플릿을 고정하며 네이티브 생성물은 Git에 넣지 않습니다.

```sh
CI=1 EXPO_NO_TELEMETRY=1 npm run prebuild:android
cd android
CI=1 EXPO_NO_TELEMETRY=1 NODE_OPTIONS=--max-old-space-size=2048 CMAKE_BUILD_PARALLEL_LEVEL=2 ./gradlew --no-daemon --max-workers=2 --no-parallel -Dorg.gradle.jvmargs="-Xmx2048m -XX:MaxMetaspaceSize=512m" -Pkotlin.compiler.execution.strategy=in-process -PreactNativeArchitectures=arm64-v8a --init-script ../scripts/android-build-limits.gradle :app:assembleRelease
```

출력은 `android/app/build/outputs/apk/release/app-release.apk`입니다. 이 명령은 기기에 설치하지 않습니다. ARM64 기기용이며 네이티브 컴파일과 링크 작업 수도 제한합니다. Metro worker는 2개입니다. 이 제한은 전체 프로세스 메모리의 합산 상한이 아닙니다.

기본 Expo debug keystore로 서명하는 TEST 데모입니다. 스토어 배포용 서명이 아닙니다. Firebase 파일을 제공하기 전에 만든 APK는 푸시 설정이 없습니다. 파일 제공 후 다시 prebuild와 APK 빌드를 실행해야 합니다.

## 동작

- TMS 계정 로그인. 시작 시 `/api/session`으로 세션을 확인합니다. 비밀번호를 저장하지 않습니다.
- 서울 기준 당일 차량을 선택합니다. 선택은 날짜별로 복원합니다. TEST 데모는 기존 TMS 계정의 수동 차량 선택 범위입니다.
- 차량의 모든 주문을 `meatbox:YYYY-MM-DD:<orderId>` QR로 확인해야 배송 시작 버튼이 활성화됩니다. 다른 날짜·다른 차량·중복·미등록 QR을 구분합니다. 수령 확인은 이 기기에 저장되며 서버의 수령 증빙 기능은 아닙니다.
- 배송·지도 두 탭. 배송 시작 전에만 대기 배송지를 묶음 단위로 편집합니다("자동 생성" 제안 포함). 배송 시작 뒤 편집은 다음 단위에서 엽니다.
- 현재 배송지에서 "완료 · 미배송 처리"를 열어 완료 / 미배송(사유 6종) / 부분 완료(주문 1건 배송지만, 품목별 수량)를 사진 최대 3장(완료는 1장 이상 필수)과 특이사항(500자)과 함께 보냅니다. 보고는 단말 큐에 저장되고 화면에는 바로 닫힌 배송지로 보입니다. 전송 대기 건수는 상단 배지로, 멈춘 건은 빨간 배지와 목록 시트(다시 시도·삭제)로 확인합니다.
- 지도는 실제 주문 좌표만 표시합니다. 좌표가 없는 배송지는 안내문으로 표시합니다. 마커를 누르면 상세 sheet가 열립니다. 내 위치는 지도 표시, 출발 이벤트의 위치 1회, 운행 중 위치 전송(아래)에 사용합니다.
- 메시지 버튼에서 운영팀 내역을 확인하고 메시지를 보냅니다. FCM은 `meatbox-driver` 채널을 사용합니다. 현재 날짜·차량에 맞는 푸시만 처리합니다.
- 실행 중 토큰이 바뀌면 새 토큰을 서버에 직접 등록합니다. 토큰 이벤트 안에서 토큰 조회를 다시 호출하지 않습니다. 앱이 foreground로 돌아오면 권한과 토큰을 재확인하되 권한 팝업을 반복해서 열지 않습니다.

## 배송 완료 보고와 단말 큐

- 사진: 시스템 카메라 또는 사진 선택기에서 받아 긴 변 1600px·JPEG 0.8로 줄이고(5MiB를 넘으면 0.6으로 한 번 더) 앱 문서 폴더 `outbox/{eventId}/`에 보관합니다. 상수는 `src/domain/photoPolicy.ts` 한 곳입니다(`REQUIRE_COMPLETION_PHOTO`, 최대 3장).
- 큐(`src/outbox/Outbox.ts`): 저장 순서대로 한 번에 하나, 사진을 먼저 올린 뒤 `photoIds`를 넣어 이벤트를 보냅니다. 네트워크 오류·5xx·429·408은 5초→15초→45초→2분→5분 간격으로 무기한 재시도합니다. 응답이 유실됐을 수 있으면 `GET events/{eventId}`로 먼저 확인합니다. 400·401·403·413과 409는 `rejected`로 멈추고 뒤 항목도 기다립니다. 401로 멈춘 건은 다시 로그인하면 자동으로 재시도합니다.
- 큐는 AsyncStorage(메타데이터)와 사진 파일에 저장되어 앱 재시작 후 복구됩니다. 전송은 앱이 열려 있을 때만 합니다(시작, 새 항목, 전경 복귀, 재시도 시각). 백그라운드 전송은 없습니다.
- 서버는 현재(`current`) 배송지만 완료로 받습니다. 앱은 `arrived` 이벤트를 보내지 않으며 `stop_*` 한 번에 도착과 완료가 처리됩니다.

## 상품 확인 (바코드·QR 스캔과 수기 입력)

배송 완료 화면은 그 배송지 품목에 `barcode`가 하나라도 있으면 "상품 확인" 구역을 보입니다. 카메라로 스캔하거나 코드를 직접 입력하면 품목 바코드와 대조해 일치 / 이미 읽음 / 품목에 없음을 알립니다(`src/domain/scanMatch.ts`). 공백·하이픈·대소문자는 무시하고, 수량은 비교하지 않습니다. 읽지 못한 품목이나 품목에 없는 코드가 있으면 경고 후 완료할 수 있습니다(`src/domain/scanPolicy.ts`의 `ALLOW_COMPLETION_ON_SCAN_MISMATCH`). 읽은 코드는 전부 `stop_completed.scannedCodes`에 실립니다. 바코드가 없는 배송지는 이 단계가 없습니다. 미트박스의 바코드·상품 매핑 자료를 받기 전에는 이 대조를 확정 규칙으로 쓰지 않습니다.

## 위치 수집, 배차 알림, 이력, 운영 전화, 배송팁

- **위치 수집**(`src/tracking/LocationTracker.ts`, `src/platform/tracking.ts`): 출발 뒤 위치 포그라운드 서비스(`expo-location` + `expo-task-manager`, 상단 알림 "운행 중 위치를 운영팀에 전송하고 있습니다")가 30초마다 위치를 받습니다. 위치 작업이 불릴 때 마지막 시도 후 1분이 지났으면 200건씩 `POST locations`로 보냅니다(별도 타이머 없음). 네트워크가 없으면 단말에 보관하고 1시간이 지나거나 240건을 넘으면 오래된 것부터 버립니다. 마지막 배송지 완료, 로그아웃, 차량 변경 때 남은 위치를 한 번 보내고 멈춥니다. 상수는 `src/domain/trackingPolicy.ts`입니다.
- **권한 안내**: 위치 전경 권한은 출발 때 요청하고, 첫 출발 뒤 한 번 "항상 허용"과 배터리 최적화 제외를 권장 안내합니다(필수 아님, 거절해도 운행은 막지 않음). **30초 간격이 절전 상태에서 유지되는지는 실기기 PoC가 필요합니다.**
- **배차 변경 알림**: 운영자가 배차를 바꾸면 서버가 `route_changed` 푸시를 보냅니다. 앱은 받으면 상태와 경로를 다시 읽고 서버 문장을 배너로 보여 줍니다(`src/domain/pushEffect.ts`). FCM 설정은 위 "동작"의 푸시 항목과 같습니다.
- **오늘 이력**: 상단 "오늘 이력"이 `GET history`를 최신순으로 보여 줍니다.
- **운영팀 전화**: 빌드 때 `EXPO_PUBLIC_MEATBOX_OPS_PHONE`을 넣으면 "운영팀 전화" 버튼이 `tel:`로 전화 앱을 엽니다. 비어 있으면 버튼이 없습니다. 교체 방법은 [운영 절차](../../docs/operations.md#배송원-앱-빌드-설정)입니다.
- **배송팁·고객 요청**: 상세 보기에 `customerRequests`와 `tip`이 보이고, 닫히지 않은 배송지는 "배송팁 쓰기/수정"으로 `POST stops/{stopId}/tip`(`requestId` 멱등, 500자)을 호출합니다. 온라인에서만 저장합니다.

## 서버 기사 끝점 연결 (경로·상세·순서·출발)

`src/api/driverApi.ts`가 `docs/api-reference.md`의 기사 끝점을 한 곳에서 부릅니다. 응답이 계약과 다르면 `INVALID_RESPONSE`로 거부합니다. 오류는 `ApiError.code`(problem+json의 `code`)로 분기하고 401은 로그인 화면입니다.

- `GET .../driver/route`: 배송지별 ETA(`estimated:false`는 흐리게 표시), 서버 `stopId`, 순서 변경이 기대하는 `revision`. 날짜 상태가 바뀔 때마다 다시 읽습니다.
- `GET .../driver/stops/{id}`: 고객 요청, 배송팁, 출입 정보, 운송 조건, 품목, 직전 완료 사진(`GET photos/{id}`)을 "상세 보기"에서 읽습니다.
- `POST .../driver/route/suggest`: 순서 편집기의 "자동 생성". 제안만 받고 서버 상태는 안 바뀝니다. 목록에 반영한 뒤 "완료"를 눌러야 `route_reordered`(`expectedRevision`)로 적용됩니다. `409 REVISION_CONFLICT`면 최신 상태를 다시 읽습니다.
- `POST .../driver/events`: `departed`(전경 위치 1회 포함)와 `route_reordered`. 같은 요청을 다시 보낼 때는 `eventId`뿐 아니라 시각·위치까지 같은 본문이어야 서버가 `duplicate`로 답합니다(`domain/retryAttempt.ts`). 출발 뒤에는 순서 편집 버튼을 숨깁니다.
- 위치는 출발 때만 읽습니다(`expo-location`, 전경 권한만). 권한이 없거나 읽지 못해도 출발은 막지 않습니다. 백그라운드 수집은 다음 단위입니다.
- 쓰기는 모두 이벤트입니다. `POST /commands`와 `boot`·`expectedRevision`은 앱에서 쓰지 않습니다. `GET /state`는 읽기 전용으로 남아 차량 선택, QR 수령 확인, 지도 핀 좌표, 품목·오프라인 표시에 씁니다(서버 끝점 정리 단위 후).

## API 코드 라이브 점검

앱 화면이 아니라 앱의 API·도메인 코드를 실제 서버에 붙여 보는 스크립트입니다. 합성 데이터 서버를 띄운 뒤 실행합니다.

```sh
make run-native-fixture   # 다른 터미널, 합성 데이터 (계정은 scripts/web-fork-fixture.mjs의 fixture 값)
EXPO_PUBLIC_MEATBOX_API_BASE_URL=http://127.0.0.1:4173 LIVE_CHECK_USERNAME=... LIVE_CHECK_PASSWORD=... npx tsx scripts/live-check.mts
```

로그인 → 경로 → 제안 → 순서 변경 → 오래된 revision 거부 → 출발 → ETA 라벨 → 앱의 실제 큐 코드로 사진 업로드·완료·미배송·부분 완료 전송(응답 유실 흉내 포함)과 이력 확인까지 봅니다. 정차 결과는 `LIVE_CHECK_PLAN=completed,failed`처럼 경로 순서대로 정하고(`completed`·`failed`·`partial`) 실행마다 새 서버가 필요합니다. 출력 예는 `docs/evidence/driver-app-live-check-2026-10-16.txt`(경로·출발)와 `docs/evidence/driver-app-live-check-d2-2026-10-16.txt`(완료 보고, 2회)입니다. **Android 에뮬레이터·실기기에서 화면을 확인한 기록은 아직 없습니다.** 화면 렌더 테스트 도구(jest 등)도 없어서 화면은 뷰모델 테스트까지만 검사합니다.

## API 계약

공통: native cookie, `Origin` 헤더, `credentials: include`. 로그인은 form `POST /login` 후 `GET /api/session` 확인입니다. 서버는 `{user:{username,displayName}}`을 반환합니다.

날짜별 기본 경로: `/api/dispatch-data/days/{date}`.

- `GET /state`: ETag 지원. `boot`, `revision`, `fleetVehicles`, `fleetDeliveries`, `vehicleStates`, `dispatch.phase` 사용.
- `PUT /driver/push-token`: `{vehicleId,token,deviceId,platform:'android'}`.
- `DELETE /driver/push-token`: `{token}`. 저장된 등록 날짜로 해제합니다.
- `GET /driver/messages?vehicleId=...`: `{messages:[{id,from,body,createdAt}]}`.
- `POST /driver/messages`: `{vehicleId,body,from:'driver'}`.

Kotlin 배송 도착/완료 값은 `HH:mm` 문자열 또는 null입니다. 상태는 `pending/current/done/skipped`, 차량 단계는 `idle/preparing/delivering/done`입니다. 배송지 묶음은 Kotlin과 같은 NFC 정규화·trim한 이름+주소를 사용합니다. 좌표는 `[longitude, latitude]`입니다.

## 검증 경계

순수 도메인·API 계약 테스트는 QR 구분, 묶음 순서/보호 위치, 현재 배송지 동작, 서울 날짜 전환, 잘못된 응답 거부, ETag/CAS 및 날짜별 메시지/토큰 경로를 확인합니다. 전송 큐의 순서·재시도·재확인·멈춤·복원 규칙도 순수 테스트(`src/outbox/Outbox.test.ts`)로 확인합니다. 이 검사는 사진 촬영·압축·파일 보관, AsyncStorage 영속, 앱 강제 종료 뒤 복구, 완료 처리 화면 렌더, 실제 Android QR 카메라, 네이티브 지도/위치 권한, 앱 재시작 후 cookie 복원, FCM 수신, TEST 배포 성공의 증거를 대신하지 않습니다.

## 의존성 audit 잔여 사항

2026-10-13 검사에서 `brace-expansion` override 두 곳을 `5.0.12`, `shell-quote`를 `1.11.0`으로 갱신했습니다. 설치된 버전과 lockfile이 일치합니다.

`npm audit --json` 결과는 high 20개, critical 0개입니다. 20개는 전이 의존성 경로를 포함한 패키지 집계이며 별개의 취약점 20건이라는 뜻이 아닙니다. 남은 직접 advisory는 다음 두 패키지입니다.

- `braces@3.0.3`: 중첩 패턴에 의한 stack exhaustion. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- `node-forge@1.4.0`: RSA PKCS#1 v1.5 서명 검증의 추가 중첩 DigestAlgorithm 허용. [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

검사 당시 npm registry의 최신 버전은 각각 `3.0.3`, `1.4.0`이며 수정 버전이 없습니다. audit의 자동 수정 제안에는 Expo 44 등 호환성을 깨는 하향 변경이 포함되어 적용하지 않았습니다. 이 결과를 audit 통과 또는 릴리스 보안 승인으로 해석하지 않습니다. 원본 JSON은 로컬 `tmp/npm-audit-2026-10-13.json`에 보관합니다.
