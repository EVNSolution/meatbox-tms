# Push Lab 로컬 검증 및 P2 입력

이 문서는 `push-lab`의 로컬 mock 검증과 HTTPS·실기기 시험 준비를 분리한다. 이 저장소의 결과만으로 공개 배포, FCM 접수 또는 기기 표시를 완료했다고 기록하지 않는다.

## 로컬 mock 실행

Node 26.3.1 이미지가 포함한 SQLite가 3.51.3 이상인지 이미지 빌드와 컨테이너 시작 때 각각 검사한다. 조건을 만족하지 않으면 실행하지 않는다. SQLite 파일과 백업은 서로 다른 Docker volume에 남고, 컨테이너 root filesystem은 read-only다.

```sh
cd deploy/push-lab
cp .env.example .env
# .env의 placeholder를 다음 명령의 출력으로 교체한다.
openssl rand -base64 32
docker compose config
docker compose build
docker compose up -d --wait
./smoke.sh
```

생성한 값은 `PUSH_LAB_EXCHANGE_KEYS`에만 저장하고 Git, 이미지, 로그에 넣지 않는다. Compose는 이 값이 없으면 구성 단계에서 실패하며, 애플리케이션은 base64로 디코딩한 길이가 정확히 32바이트가 아니면 시작하지 않는다.

키를 교체할 때는 `openssl rand -base64 32`로 새 키를 만들고 `새 키,이전 키` 순서의 콤마 목록으로 배포한다. 첫 키로 새 교환 복구 데이터, 최초 installation proof의 2분 응답복구 데이터, 세션 CSRF 복구 데이터를 암호화하고 N-1 키는 기존 데이터 복호화에만 사용한다. 이전 키는 두 종류의 2분 재시도 기한만이 아니라 **그 키로 암호화된 CSRF를 가진 마지막 활성 세션의 만료 시각**까지 유지하고, 해당 세션이 모두 만료됐음을 확인한 뒤 제거한다. 두 슬롯과 worker에는 전환 기간 동안 같은 순서의 키 목록을 제공한다.

기본 sender는 항상 `mock`이다. 단일 컨테이너는 `PUSH_LAB_MODE=all`로 웹과 워커를 함께 실행한다. 같은 이미지를 분리하려면 단일 서비스를 내린 뒤 다음 구성을 사용한다.

```sh
docker compose down
docker compose -f compose.yaml -f compose.split.yaml --profile split up -d --wait
COMPOSE_FILE=compose.yaml:compose.split.yaml PUSH_LAB_SERVICE=push-lab-web ./smoke.sh
```

`down -v`는 구독·철회·queue와 백업을 삭제하므로 일반 종료나 재시작 절차에 사용하지 않는다.

## 로컬 TEST 관제 관리자 설정

관제 화면은 `/push-lab/control/`이며 관리자 hash 파일을 설정하지 않은 기본 Compose에서는 관제 로그인/API만 `503 admin_unconfigured`로 닫힌다. 기존 고객 화면과 mock sender는 그대로 실행된다. 테스트 전용 비밀번호는 12자 이상으로 정하고 저장소 밖의 파일에 hash만 생성한다. 생성 CLI는 비밀번호를 **stdin**으로 받고 `saltHex:derivedKeyHex` 한 줄만 stdout으로 출력한다. 비밀번호를 명령 인자·환경변수·Git·로그에 남기지 않는다.

```sh
cd deploy/push-lab
umask 077
export PUSH_LAB_ADMIN_HASH_HOST_FILE=/absolute/private/path/push-lab-admin.hash
python3 -c 'import getpass,sys; sys.stdout.write(getpass.getpass("Local TEST admin password: ") + "\n")' \
  | node ../../services/push-lab/server/admin-password-hash-cli.mjs > "$PUSH_LAB_ADMIN_HASH_HOST_FILE"
chmod 600 "$PUSH_LAB_ADMIN_HASH_HOST_FILE"
docker compose -f compose.yaml -f compose.admin-local.yaml.example config --quiet
docker compose -f compose.yaml -f compose.admin-local.yaml.example up -d --build --wait
```

호스트 파일은 컨테이너의 `/run/secrets/push-lab-admin-password-hash`에 read-only로 마운트된다. 파일은 컨테이너 `node` 사용자에게 읽기 가능하고 다른 사용자에게 읽기 불가해야 한다. macOS Docker Desktop과 Linux의 bind-mount 소유권 동작이 다를 수 있으므로 로그인 전 파일 읽기 권한을 확인한다. 분리 모드에서는 base → split → admin 순서로 overlay를 적용하며 web에만 파일을 연결한다.

```sh
docker compose -f compose.yaml -f compose.split.yaml -f compose.admin-local.yaml.example \
  --profile split config --quiet
docker compose -f compose.yaml -f compose.split.yaml -f compose.admin-local.yaml.example \
  --profile split up -d --build --wait
```

두 모드를 바꿀 때는 사용 중인 구성을 `down`으로 종료하되 volume은 보존한다. 실제 비밀번호와 hash 파일은 테스트 산출물로도 복사하지 않는다.

## 배포 smoke 안전 조건

배포 probe는 반드시 서버가 부여한 `deployment_probe` 영역과 `deliverable=false`를 사용한다. API enqueue와 worker claim 양쪽에서 제외해야 하며, smoke 중단 후 레코드가 남아도 outbox 생성과 real FCM 호출은 0건이어야 한다.

`smoke.sh`는 먼저 real sender에서 실행을 거부하고 `DEPLOYMENT_PROBE_DELIVERABLE=false`를 확인한다. health/readiness 성공 후 서버가 고유 ID를 부여한 실제 probe fixture를 만들고 이벤트를 emit하여 `enqueued=0`, `outboxCount=0`을 검사한다. 일반 fixture ID를 probe로 받지 않으며 고객·일반 테스트 fixture를 조회하거나 정리하지 않는다. 종료 시에도 `scope=deployment_probe`, `deliverable=false`, outbox·구독·세션 연결 0건을 다시 확인한 정확한 probe ID만 한 트랜잭션으로 정리한다. 중간 종료로 안전 정리가 실패해도 해당 probe는 서버와 worker 양쪽에서 계속 발송 불가 상태다.

## 일관된 백업과 복구 점검

실행 중인 DB 파일을 직접 복사하지 않는다. Node의 `sqlite.backup()` API로 WAL을 포함한 일관된 백업을 별도 backup volume에 생성한다. 백업 직후 백업 DB 자체에서 schema version, `integrity_check`, `foreign_key_check`, 상태별 건수와 SHA-256을 계산해 같은 이름의 `.manifest.json` sidecar를 원자적으로 저장한다. 상태 요약에는 세션 활성/만료, installation 활성/비활성, 구독 활성/철회/만료, outbox의 모든 status, worker lease 활성/만료 건수만 들어가며 ID·token·endpoint·cipher·자격증명 원문은 출력하지 않는다.

```sh
cd deploy/push-lab
./backup.sh
./restore-check.sh push-lab-YYYYmmddTHHMMSSZ.sqlite
```

분리 모드에서는 같은 Compose 파일 집합과 web 서비스명을 지정한다.

```sh
COMPOSE_FILE=compose.yaml:compose.split.yaml ./backup.sh push-lab-web
COMPOSE_FILE=compose.yaml:compose.split.yaml ./restore-check.sh push-lab-YYYYmmddTHHMMSSZ.sqlite push-lab-web
```

복구 점검의 기준은 변할 수 있는 live DB가 아니라 백업 순간에 작성된 sidecar다. 백업을 임시 별도 DB로 복사해 파일 SHA-256, `PRAGMA integrity_check`, `PRAGMA foreign_key_check=0`, 기록된 원본 schema, 같은 분류 시각의 상태 summary/digest를 sidecar와 비교한다. 이어서 또 다른 실행 프로세스나 sender 없이 그 임시 복사본만 애플리케이션 `openDatabase()`로 열어 현재 schema까지 migration 가능한지 확인하고, migration 뒤에도 무결성·외래키·상태 summary/digest가 그대로인지 검사한다. 추가로 원본 DB의 `schema_meta`를 제외한 모든 테이블에서 **원본에 있던 열과 행**을 migration 뒤 DB와 비교한다. 새 migration 열·metadata 행은 이 비교 대상이 아니다. 출력의 `sourceSchemaVersion`, `currentSchemaVersion`, `migrated`, `sourceRowsPreserved`, `sourceTablesCompared`, `senderMode=not-started`를 증거로 보관한다. sidecar의 `stateDigest`는 상태별 **집계** hash이며 단독으로 행 단위 보존을 증명하지 않는다. v1/v2 백업은 현재 schema까지 migration 성공해야 하고, 현재 schema 백업은 `migrated=false`와 원본 열·행 보존을 모두 만족해야 한다.

이 검사는 복구 **가능성 및 핵심 상태 보존** 증거이며 실제 운영 DB 교체나 외부 발송 증거가 아니다. 일반 코드 rollback에서 DB를 과거 백업으로 되돌리지 않는다. 실제 재해 복구는 현재 DB 보존, 승인된 복구 대상, 철회·queue 비교, real sender 비활성, 백업 파일과 sidecar 동시 보존 후 별도 승인 절차로 수행한다.

2026-09-23 격리 mock rehearsal: `COMPOSE_PROJECT_NAME=mbpushpilotverify0923`, loopback 포트 `34371`, Node `26.3.1`, SQLite `3.53.1`에서 schema 4 백업·복원 후 관제 migration을 포함한 schema 5 이미지로 같은 test volume을 재시작했다. 재시작 뒤에도 구독 활성 1·철회 1, outbox queued 1·cancelled 1이 유지됐다. 새 schema 5 백업 `push-lab-20260923T004553Z.sqlite`의 복원은 `5→5, migrated=false`, 합성 v1/v2 백업은 각각 `1→5`, `2→5, migrated=true`였다. 세 복원 모두 `integrity=ok`, 외래키 위반 0, `sourceRowsPreserved=true`였고 현재 schema의 원본 14개 테이블, 과거 schema의 원본 11개 테이블에 있던 열·행을 비교했다. 실행은 `./backup.sh`, `./restore-check.sh <backup-name>` 및 `docker compose exec`의 합성 fixture 생성/상태 조회로 확인했다. 실제 FCM 발송·운영 DB 교체는 수행하지 않았다.

같은 날 별도 프로젝트 `mbpushadminverify0923`의 loopback 포트 `34372`에서 repo 밖 임시 hash 파일을 web에 read-only로 마운트한 단일 mock 컨테이너의 `/healthz`, `/readyz`, 관제 정적 화면, login challenge가 HTTP 200이었다. challenge → 로그인 → 세션 조회는 모두 HTTP 200, `authenticated=true`, `senderMode=mock`이었다. `compose.yaml + compose.admin-local.yaml.example` 및 `compose.yaml + compose.split.yaml + compose.admin-local.yaml.example`의 `config --quiet`가 통과했다. 별도 `mbpushsplitverify0923` 포트 `34373`에서 split web·worker가 모두 healthy였고 `/healthz`, `/readyz`, login challenge가 HTTP 200이었다. 실행 중 컨테이너 설정에서도 관리자 hash 파일은 web에만 read-only로 연결되고 worker의 환경변수·마운트에는 없음을 확인했다. 비밀번호·hash 원문은 출력하지 않았다.

로컬 CI 순서(`npm ci` 루트 → `npm ci`와 `npm run vendor:firebase` push-lab → 루트 `npm test` → push-lab `npm audit --omit=dev`, `npm test` → `docker build`)에서 루트 493/493, push-lab 63/63, audit 취약점 0건, 이미지 빌드 성공을 확인했다. GitHub Actions 실행·PR 상태는 별도 증거다.

## P2 HTTPS·실기기 시험 전 필수 입력

- 고정 HTTPS origin과 DNS 소유권, 인증서 발급·갱신 방식
- 실제 호스트의 Docker/Caddy 버전, 가용 메모리·디스크, 사용 포트, 현재 서비스와 실행 SHA
- 테스트 전용 Firebase project의 공개 web config와 VAPID 공개키
- 최소 권한 service account 파일의 승인된 호스트 경로, 소유자, 교체·폐기 담당자
- Android 실기기/Chrome 버전과 iPhone 또는 iPad의 OS 버전, 홈 화면 Web App 설치 절차
- 허용된 테스트 사용자·배송·기기 allowlist와 구독/증거 보관 기간
- 공개 origin에서 사용할 세션 검증 키와 교환 복구 키, N/N-1 교체 호환 방식
- 배포 이미지 digest, Git SHA, schema 범위, rollback 보관 위치

`compose.real-split.yaml.example`은 입력 형식만 제공하며 반드시 base, split, real 순서의 세 파일로만 사용한다. base+real 두 파일만 실행하지 않는다.

```sh
docker compose \
  -f compose.yaml \
  -f compose.split.yaml \
  -f compose.real-split.yaml.example \
  --profile split config

docker compose \
  -f compose.yaml \
  -f compose.split.yaml \
  -f compose.real-split.yaml.example \
  --profile split up -d --wait
```

real 구성에서 공개 Firebase web config와 VAPID 공개키는 `push-lab-web`에만 전달한다. 승인된 테스트 Firebase service account는 `PUSH_LAB_FIREBASE_CREDENTIALS`로 지정하며 `push-lab-worker`에만 `/run/secrets/firebase-service-account.json` read-only secret으로 마운트한다. `PUSH_LAB_REAL_FID_ALLOWLIST`에는 발송이 허용된 테스트 FID만 콤마로 구분해 넣는다. 자격증명과 FID allowlist는 이미지, Git, 브라우저, 로그에 넣지 않는다.

기본 `compose.yaml`과 `compose.yaml + compose.split.yaml`은 계속 mock sender다. real overlay를 붙인 세 파일 구성에서만 worker가 real sender가 되며, web에는 발송 자격증명을 제공하지 않는다. 이 오버레이는 이번 로컬 mock 검증에서 실행하지 않는다.

## Worker configuration pause 해제

worker가 잘못된 자격증명·프로젝트 설정 등 configuration 오류를 받으면 `/var/lib/push-lab/worker.pause`를 기록하고 새 작업 claim을 멈춘다. single/all health와 split worker health는 marker가 있는 동안 실패하며, split web health는 별도로 유지된다. 원인은 worker 로그의 `push-lab worker paused` 코드와 marker 내용을 함께 확인한다.

자격증명·프로젝트·allowlist를 먼저 수정하고 설정 검증을 마친 뒤에만 `compose.clear-pause-once.yaml.example`을 한 번 추가해 `PUSH_LAB_CLEAR_PAUSE=1`로 marker를 명시적으로 해제한다. 이 값을 `.env`나 상시 Compose 구성에 넣지 않는다. split real 구성의 copy-ready 절차는 다음과 같다.

```sh
docker compose \
  -f compose.yaml \
  -f compose.split.yaml \
  -f compose.real-split.yaml.example \
  -f compose.clear-pause-once.yaml.example \
  --profile split up -d --force-recreate push-lab-worker

# marker 제거와 worker health 회복을 확인한다.
docker compose \
  -f compose.yaml \
  -f compose.split.yaml \
  -f compose.real-split.yaml.example \
  --profile split ps push-lab-worker

# 일회성 overlay를 제거한 정상 구성으로 즉시 다시 생성한다.
docker compose \
  -f compose.yaml \
  -f compose.split.yaml \
  -f compose.real-split.yaml.example \
  --profile split up -d --force-recreate push-lab-worker
```

마지막 재생성 뒤 컨테이너 환경에 `PUSH_LAB_CLEAR_PAUSE`가 남지 않았는지 확인한다. 해제 뒤에도 configuration 오류가 재발하면 worker는 marker를 즉시 다시 만들고 health가 다시 실패한다. marker 파일을 수동 삭제하거나 자격증명 수정 전에 일회성 overlay를 반복 적용하지 않는다. single/all 점검에서는 base와 일회성 overlay 두 파일을 사용하고 대상 서비스만 `push-lab`로 바꾼다.

Caddy 예제도 준비 산출물일 뿐이다. 실제 설정은 기존 TMS 경로를 보존한 상태에서 별도 파일로 `caddy validate`하고, 후보 readiness를 연속 확인한 뒤에만 reload한다. 고정 origin과 Firebase SDK 통신 범위를 확정한 뒤 push-lab 전용 CSP를 검증하며 기존 TMS CSP를 넓히지 않는다. 이 작업에서는 서버, DNS, 인증서, Caddy를 변경하지 않는다.

## 증거를 구분하는 기록표

| 증거 단계 | 필요한 기록 | 이 단계가 증명하지 않는 것 |
|---|---|---|
| 단위·mock | 테스트 명령, 통과 건수, Node/SQLite 버전, sender=mock | FCM 접수, 기기 표시 |
| 컨테이너 | 이미지 digest, `/healthz`, `/readyz`, 재시작 후 DB·예약 복구, backup/restore-check | 공개 HTTPS, 실기기 수신 |
| 공개 HTTPS | origin, 인증서 검증, 배포 SHA/digest, 내부·외부 readiness, Caddy validate/reload 결과 | FCM 접수, 알림 표시·클릭 |
| FCM 접수 | 허용 구독, enqueue/attempt 시각, FCM message ID 또는 오류 분류 | OS 알림 표시·사용자 열람 |
| 실기기 | 기기·OS·브라우저, 권한/등록 상태, 화면 잠금 상태의 표시 시각, 클릭 후 자기 주문 조회 | 다른 OS·브라우저의 동작 보장 |

Android Chrome과 iOS 홈 화면 Web App 결과를 별도로 남긴다. iOS 일반 Safari 탭이나 일반 앱 WebView 성공으로 대체하지 않는다. 모든 시험 알림은 `테스트`로 표시하고, 허용된 기기 외 발송 건수는 0이어야 한다.

## 종료 조건

P1 완료 보고에는 mock 자동시험, 컨테이너 health/readiness, SQLite 런타임, 재시작 영속성, 백업 복구를 포함한다. P2 완료 보고는 여기에 공개 HTTPS, FCM 접수, Android 표시·클릭, iOS 홈 화면 Web App 표시·클릭 증거가 모두 추가된 때만 가능하다.

참고: [Node.js `sqlite.backup()` API](https://nodejs.org/download/release/v26.2.0/docs/api/sqlite.html#sqlitebackupdb-path-options), [SQLite WAL](https://sqlite.org/wal.html)
