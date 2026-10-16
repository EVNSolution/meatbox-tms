# 새 기술 스택 개발 환경

2026-10-05, Asia/Seoul. [아키텍처 결정](new-stack-architecture.md)과 [도구·작업 기준](agent-tooling-setup.md)에 따른 개발·검증 방법이다.

## 현재 구조

| 경로 | 역할 |
| --- | --- |
| `apps/web/` | 운영·가이드·로그인·등록 네 진입점을 가진 단일 Vite MPA |
| `services/api/` | Kotlin/Spring 인증, 원본 조회, 자원, 날짜별 상태 API |
| `test/api-connection/` | 실제 bootJar와 게이트웨이를 함께 실행하는 소유권·재시작·장애 계약 검사 |
| `test/web-fork-baseline.test.mjs` | 포크 provenance와 active/removed 파일 검사 |
| `deploy/new-stack/` | TEST 패키징·서비스·전환·복구 설정 |

운영 화면은 `combined/app.mjs`가 헤더와 배차 관리·배송 관제·자원 관리 메뉴를 직접 소유한다. `ui-layout/`은 참조 전용이다. 기사·고객·scenario 데모와 전용 자산은 제거됐고 모든 실행 모드에서 해당 URL과 `/ws/simulation`은 410이다.

포크 인벤토리 schema 3은 최초 142 source, 163 mapped target, 21 authored라는 역사적 근거를 유지하면서 각 항목의 active/removed 상태와 마지막 SHA를 기록한다. 이 숫자를 현재 활성 파일 수로 사용하지 않는다.

## 고정 도구와 설치

- Node.js 22.18 이상. 현재 로컬 확인값은 Node 26.3.1, npm 11.16.0이며 설치는 lockfile을 따른다.
- JDK toolchain 21, Kotlin 2.3.21, Spring Boot 4.1.1 (`services/api/build.gradle.kts`).
- TypeScript 7.0.2, Oxlint 1.86.0, Vite 8.3.2

```sh
make setup-new-stack
make check-new-stack
make check-release
```

설치는 lockfile을 사용한다. `make check-modules`는 Kotlin `check bootJar`와 프런트 typecheck·lint·build·테스트·산출물을 확인하는 공통 모듈 검사다. `make check-new-stack`은 공통 검사에 포크 provenance와 golden 회귀를 더하는 독립 개발 검사다. `make check-release`는 공통 검사 뒤 루트 전체 Node/golden/배포·패키지 회귀를 한 번 실행하고 실제 JAR 연결 계약을 검사한다. 루트 `npm test`에 포함된 포크 회귀를 별도로 반복하지 않는다. `make check-api-connection`은 연결 계약만 따로 빌드·검사할 때 사용한다. 작은 변경은 먼저 인접 focused test를 실행한다.

## 로컬 실행

```sh
make dev-web
make run-fork-fixture
make run-connected-fixture
make run-native-fixture
make check-api-connection
```

`make dev-web`은 `127.0.0.1:5173`에서 실행하며 `/api`만 프록시한다. `/scenario/api`와 `/ws/simulation` 개발 프록시는 없다. raw Vite preview는 정적 확인용이므로 인증·Origin·보호 자산·owner 장애 계약은 보호 게이트웨이에서 검사한다.

관제 화면의 온도·ETA·기사 배정을 브라우저로 확인하려면 native fixture를 텔레메트리 토큰과 함께 띄우고 합성 자료를 채운다. 아래 값은 임시 합성 값이다.

```sh
MEATBOX_FORK_FIXTURE_TELEMETRY_TOKEN=fixture-telemetry-token-0001 MEATBOX_FORK_FIXTURE_TELEMETRY_STALE_MINUTES=1 node scripts/web-fork-fixture.mjs --native
# 출력의 accessFile 경로를 써서 다른 터미널에서:
node scripts/seed-control-fixture.mjs --access-file <accessFile> --token fixture-telemetry-token-0001 --keep-alive
```

`seed-control-fixture.mjs`는 두 차량의 배차를 확정하고 오늘의 온도(정상 차량, 범위 밖 차량, 곧 조용해지는 차량)를 넣고, 기사 계정(`fork-driver` / `local-driver-1234`)을 만들어 한 차량에 배정한 뒤 출발 이벤트를 보내 서버 ETA를 만든다. 합성 자료만 쓰며 fixture 밖에는 아무것도 쓰지 않는다.

합성 fixture의 로그인은 `fork-reviewer` / `local-fork-1234`이며 3주문·2차량의 로컬 합성 자료만 사용한다. `Ctrl-C` 또는 SIGTERM으로 종료한다. 합성 fixture는 임시 access JSON, 날짜 원본, checkpoint, SQLite를 만들고 종료 때 제거한다. 실자료 경로를 사용하지 않는다. Connected fixture는 이전 혼합 소유 계약의 비교·롤백용이고, native fixture는 Node API 없이 Kotlin이 인증·세션·네 원본 읽기·자원·날짜별 state/commands를 모두 소유한다.

## 게이트웨이와 API 계약

공개 allowlist는 로그인·등록에 필요한 정확한 파일만 포함한다. 나머지 HTML·JS·CSS는 현재 owner의 `/api/session` 확인 뒤 제공한다. 정상 401은 로그인 흐름으로 보내고, 세션 검사 연결 실패·timeout·5xx·해석 불가능 응답은 503으로 닫는다.

Kotlin owner를 선택할 때에는 `MEATBOX_KOTLIN_API_ORIGIN`과 `MEATBOX_AUTH_OWNER`, `MEATBOX_DISPATCH_OWNER`, `MEATBOX_RESOURCES_OWNER`를 함께 설정한다. 한 경계에 writer를 둘 이상 두지 않는다. 선택한 Kotlin이 멈추면 Node로 fallback하지 않는다.

유지하는 화면 경로는 `/combined/`, `/ui-layout/`, `/login`, `/dev/register`다. `/scenario` 계열, 고객·기사·발표 aliases, combined 고객·기사 HTML, `/ws/simulation`은 인증이나 owner 전달 전에 410이다. 알 수 없는 `/api`는 404다.

Kotlin 날짜별 writer는 다음 여섯 명령만 받는다.

- `calculate_dispatch`
- `reassign`
- `publish_dispatch`
- `begin_dispatch_revision`
- `discard_dispatch_revision`
- `set_route_order`

기존 access JSON v1, dispatch checkpoint v2, resource SQLite v2와 checkpoint 내부 operational schema 1 projection은 호환·복구 경계다. 데모 명령을 추가하지 않는다.

## 브라우저 데이터 규칙

프런트는 HTTP source/resource/state API만 사용한다. manifest 누락·손상은 명시적 오류로 표시하며 시뮬레이션 상태로 전환하지 않는다. 지도 좌표는 현재 source 응답에 포함된 값만 사용한다. 좌표가 없으면 no-data 상태를 표시하고 `/scenario/api`에서 보충하지 않는다.

## 검사와 산출물

```sh
npm --prefix apps/web run check
./services/api/gradlew -p services/api --no-daemon check bootJar
node --test test/api-connection/*.test.mjs
```

웹 생성물은 `apps/web/.runtime/dist/`, 서버 생성물은 `services/api/build/`에 두고 Git에서 제외한다. 패키저는 현재 working tree의 파일 바이트를 담으므로 삭제된 데모를 기준 커밋에서 복원하지 않는다. 새 TEST 릴리스의 성공 수치와 SHA는 실제 배포·복구·재적용·인증 smoke가 끝난 [데모 삭제 결과](demo-removal-result.md)에서만 기록한다. 기존 수치는 [Kotlin 상태 이관 결과](kotlin-state-migration-result.md)의 이전 실행 증거다.

배포용 산출물은 로컬에서 `make package-new-stack`으로 만든다. 이 명령은 `check-release`를 먼저 실행해 현재 소스에서 JAR·웹을 빌드하고 계약 검사까지 통과한 뒤 immutable 패키지를 생성한다. CI는 같은 순서를 한 워크플로에서 명시적으로 실행해 `make check-release`의 빌드·검사를 한 번 통과한 바이트를 `node scripts/package-new-stack.mjs --archive`로 한 번만 포장한다. 생성한 `.tar.gz`, `SHA256SUMS`, 실제 checkout SHA·PR head SHA·run ID·run attempt를 담은 `release-metadata.json`만 `meatbox-test-release` artifact로 7일 보관한다. 첫 실행은 같은 이름의 artifact를 덮지 않고, 실패 복구 재실행만 같은 run의 artifact를 교체하며 새 attempt를 기록한다. PR에서는 merge ref를 검사하므로 metadata의 실제 checkout SHA와 PR head SHA를 구분한다. 배포 단계는 이 artifact를 재사용하며 설치·검사·빌드를 반복하지 않는다.

`node scripts/package-new-stack.mjs`는 이미 생성한 바이트를 포장하는 저수준 도구이며, 독립 실행만으로 빌드 최신성을 보장하지 않는다. 패키지의 dirty scope에는 프런트·Kotlin 소스도 포함된다. `.gradle/`, `.kotlin/`, `build/`와 `.runtime/`은 Git 기준점에서 제외한다.

프런트 책임은 [프로젝트 구조](project-structure.md), 최초 포크 근거는 [프런트 포크 계획](frontend-fork-plan.md)을 따른다.

## 계정 오프라인 관리

TEST에서는 API의 systemd 사용자 `meatbox-demo`로 CLI를 실행한다. 로컬에서는 access 파일 소유자인 사용자로 실행한다. 실행 전 서비스 사용자, access 파일 소유자, 대상 사용자와 백업을 확인한다.

CLI는 새 0600 파일을 만든 뒤 access 파일을 원자적으로 교체한다. root로 실행하면 access 파일이 root 소유로 바뀌어 API 인증 요청이 503으로 실패할 수 있다. 2026-10-06 TEST 확인에서 이 실패를 재현했고 서비스 사용자 소유권으로 복구했다. CLI를 root로 실행하지 않는다.

아래는 현재 TEST 경로다. 초대 출력 경로와 대상 사용자 이름은 자리표시자다. 초대 출력 디렉터리는 `meatbox-demo`가 소유하는 비공개 디렉터리여야 한다. 실제 비밀을 문서나 콘솔에 출력하지 않는다. 초대는 기존 파일을 덮어쓰지 않는 새 0600 파일에 저장한다.

```sh
systemctl show "meatbox-api@$(cat /etc/meatbox-tms/active-slot).service" --property=User --value
sudo stat -c '%U:%G %a' /var/lib/meatbox-demo/access.json
# Expected: meatbox-demo; meatbox-demo:meatbox-demo 600.

sudo -u meatbox-demo java -Xmx128m -jar /opt/meatbox-tms/current/api/meatbox-api.jar \
  --spring.main.web-application-type=none \
  --meatbox.auth.access-file=/var/lib/meatbox-demo/access.json \
  --meatbox.auth.admin-command=issue-invite \
  --meatbox.auth.admin-output=/absolute/private/path/invite.txt

sudo -u meatbox-demo java -Xmx128m -jar /opt/meatbox-tms/current/api/meatbox-api.jar \
  --spring.main.web-application-type=none \
  --meatbox.auth.access-file=/var/lib/meatbox-demo/access.json \
  --meatbox.auth.admin-command=disable-user \
  --meatbox.auth.admin-username=reviewed-user
```

CLI는 웹 서버 없이 실행하며 `AuthStore`의 교차 프로세스 잠금·원자적 쓰기 경계를 공유한다. 실행 후 access 파일의 소유자와 0600 권한, API health와 인증 응답을 다시 확인한다.
