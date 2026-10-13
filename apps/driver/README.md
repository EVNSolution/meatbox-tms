# 미트박스 Android 배송원 앱

Expo SDK 56 / React Native 0.85.3. Android package: `com.evnsolution.meatbox.driver`.

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

Firebase Android 앱의 `google-services.json`을 `.private/google-services.json`에 저장하거나 `GOOGLE_SERVICES_JSON` 경로를 지정합니다. 서비스 계정 키는 앱에 넣지 않습니다. 서버의 FCM 설정에만 사용합니다. 설정이 없거나 알림 권한/토큰 등록이 실패하면 앱에 푸시 연결 실패가 표시됩니다. 메시지는 앱에서 서버를 조회해 확인할 수 있습니다.

## 기기 설치 없는 TEST APK 빌드

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
- 배송·지도 두 탭. 배송 시작 전과 이후에 대기 배송지를 묶음 단위로 편집합니다. 현재·완료·보류 주문의 위치는 유지합니다.
- 현재 배송지의 도착 처리 후 완료·다음 처리가 가능합니다. 서버 응답을 반영하고 상태 충돌 시 최신 상태를 불러옵니다.
- 지도는 실제 주문 좌표만 표시합니다. 좌표가 없는 배송지는 안내문으로 표시합니다. 마커를 누르면 상세 sheet가 열립니다. 내 위치는 지도에서만 사용하고 서버에 전송하지 않습니다.
- 메시지 버튼에서 운영팀 내역을 확인하고 메시지를 보냅니다. FCM은 `meatbox-driver` 채널을 사용합니다. 현재 날짜·차량에 맞는 푸시만 처리합니다.

## API 계약

공통: native cookie, `Origin` 헤더, `credentials: include`. 로그인은 form `POST /login` 후 `GET /api/session` 확인입니다. 서버는 `{user:{username,displayName}}`을 반환합니다.

날짜별 기본 경로: `/api/dispatch-data/days/{date}`.

- `GET /state`: ETag 지원. `boot`, `revision`, `fleetVehicles`, `fleetDeliveries`, `vehicleStates`, `dispatch.phase` 사용.
- `POST /commands`: `expectedBoot`와 `expectedRevision` 필수. `start_route`, `arrive_stop`, `complete_stop`, `set_route_order`.
- `PUT /driver/push-token`: `{vehicleId,token,deviceId,platform:'android'}`.
- `DELETE /driver/push-token`: `{token}`. 저장된 등록 날짜로 해제합니다.
- `GET /driver/messages?vehicleId=...`: `{messages:[{id,from,body,createdAt}]}`.
- `POST /driver/messages`: `{vehicleId,body,from:'driver'}`.

Kotlin 배송 도착/완료 값은 `HH:mm` 문자열 또는 null입니다. 상태는 `pending/current/done/skipped`, 차량 단계는 `idle/preparing/delivering/done`입니다. 배송지 묶음은 Kotlin과 같은 NFC 정규화·trim한 이름+주소를 사용합니다. 좌표는 `[longitude, latitude]`입니다.

## 검증 경계

순수 도메인·API 계약 테스트는 QR 구분, 묶음 순서/보호 위치, 현재 배송지 동작, 서울 날짜 전환, 잘못된 응답 거부, ETag/CAS 및 날짜별 메시지/토큰 경로를 확인합니다. 이 검사는 실제 Android QR 카메라, 네이티브 지도/위치 권한, 앱 재시작 후 cookie 복원, FCM 수신, TEST 배포 성공의 증거를 대신하지 않습니다.

## 의존성 audit 잔여 사항

2026-10-13 검사에서 `brace-expansion` override 두 곳을 `5.0.12`, `shell-quote`를 `1.11.0`으로 갱신했습니다. 설치된 버전과 lockfile이 일치합니다.

`npm audit --json` 결과는 high 20개, critical 0개입니다. 20개는 전이 의존성 경로를 포함한 패키지 집계이며 별개의 취약점 20건이라는 뜻이 아닙니다. 남은 직접 advisory는 다음 두 패키지입니다.

- `braces@3.0.3`: 중첩 패턴에 의한 stack exhaustion. [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
- `node-forge@1.4.0`: RSA PKCS#1 v1.5 서명 검증의 추가 중첩 DigestAlgorithm 허용. [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).

검사 당시 npm registry의 최신 버전은 각각 `3.0.3`, `1.4.0`이며 수정 버전이 없습니다. audit의 자동 수정 제안에는 Expo 44 등 호환성을 깨는 하향 변경이 포함되어 적용하지 않았습니다. 이 결과를 audit 통과 또는 릴리스 보안 승인으로 해석하지 않습니다. 원본 JSON은 로컬 `tmp/npm-audit-2026-10-13.json`에 보관합니다.
