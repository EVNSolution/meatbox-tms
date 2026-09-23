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

## 기존 HTTPS 서버의 격리 mock sidecar 준비와 배포

2026-09-23 읽기 전용 preflight에서 기존 서버는 `x86_64`, systemd 259, Caddy 2.11.4, Node 22.22.1이며 Docker/Podman이 없었다. `/etc/caddy/Caddyfile` SHA-256은 저장소의 `deploy/Caddyfile`과 같은 `383f21698a2ac51b3f02c7e2c6bdfbfcdb1f31225b16d507cf064d2f00fe9f49`였다. 기존 TMS는 `127.0.0.1:3001`, 활성 릴리스 `549f13b5741328656d20ce27ef10e36692efda5b`, `/login` 200과 익명 `/api/session` 401이었다. 메모리 available 492 MiB/전체 908 MiB, swap 0, 루트 디스크 여유 2.3 GiB, `3300` 포트 미사용을 관측했다. 기존 TMS·Caddy의 systemd 메모리 peak는 각각 약 84/43 MiB였고, 배차 checkpoint는 파일 2개였다. 이는 **전환 전 시점** 증거이며 현재 용량·내용 불변의 보장은 아니다.

Docker 설치나 전역 Node 교체 없이 `deploy/push-lab/meatbox-push-lab.service.example`의 단일 web+mock worker를 전용 비특권 사용자로 실행한다. 공식 Node 26.3.1 `linux-x64.tar.xz`의 SHA-256은 `55647180e4ae58ffeaa3294e89aa4abda7c371dfbd64b44cbdb022980177aae0`([공식 SHASUMS](https://nodejs.org/dist/v26.3.1/SHASUMS256.txt))이다. 실제 내려받은 파일을 이 값과 대조하고 그 Node의 SQLite가 3.51.3 이상임을 확인한다. 의존성·`public/vendor`는 서버 밖 Linux x64 빌드에서 만들고, 테스트한 Git SHA를 `/opt/meatbox-push-lab/releases/<sha>`에 읽기 전용으로 설치한다. `/opt/meatbox-push-lab/current`는 검증한 릴리스만 가리킨다. 시작 명령은 전용 Node의 `server/all.mjs`를 직접 실행한다. `npm start:all`의 prestart vendor 생성은 읽기 전용 릴리스에 쓰므로 사용하지 않는다.

서버 내 위치와 권한은 다음과 같다.

| 대상 | 소유·권한 | 역할 |
|---|---|---|
| `/etc/systemd/system/meatbox-push-lab.service` | root:root 0644 | 독립 서비스; StateDirectory 0700, MemoryHigh 128M/Max 192M, CPUQuota 50%, TasksMax 64, 정상 drain용 TimeoutStopSec 65초 |
| `/etc/meatbox-push-lab/push-lab.env` | root:root 0600 | `native.env.example` 기반 mock·origin·교환키·빌드 SHA; Git/로그에 값 미기록 |
| `/etc/meatbox-push-lab/admin-password.hash` | root:root 0600 | 새 테스트 관리자 hash; systemd `LoadCredential`로 서비스에만 읽기 경로 제공 |
| `/var/lib/meatbox-push-lab/` | meatbox-push-lab 0700 | 전용 SQLite, worker lock/pause, `backups/`; 기존 TMS 상태와 분리 |
| `/opt/meatbox-push-lab/` | root 소유, 릴리스 쓰기 금지 | 전용 Node runtime·불변 릴리스·current 링크 |

관리자 원문 비밀번호는 서버와 저장소가 아닌 운영자 로컬 0600 파일에만 보관하고, 새 hash만 서버에 둔다. `EXCHANGE_KEYS`는 별도 무작위 32바이트 base64 키이며 실값을 명령 인자·PR·문서·로그에 넣지 않는다. `PUSH_LAB_SENDER_MODE=mock`, `DEPLOYMENT_PROBE_DELIVERABLE=false`, `PUSH_LAB_BIND_HOST=127.0.0.1`, `PUBLIC_ORIGIN=ALLOWED_ORIGIN=https://3.36.96.156`을 고정한다. worker 락 하위 프로세스는 `process.execPath`로 같은 전용 Node를 사용한다. systemd의 localhost 전용 네트워크 허용은 외부 FCM egress를 열지 않는다.

공개 진입 전에는 live Caddyfile·기존 TMS PID/시작 시각/릴리스 SHA/health와 checkpoint 파일 개수·내용 hash·최신 mtime을 읽기 전용으로 기록하고, 기존 Caddyfile을 별도 보관한다. 서버의 실제 여유 메모리·디스크, 설치/스테이징/롤백 보관의 총량을 다시 측정해 한계를 넘으면 중단한다. `systemd-analyze verify`, 전용 Node/SQLite 확인, 서비스 기동 후 `ss`의 **127.0.0.1:3300** 바인딩, `/healthz`·`/readyz`, 관제 login 및 `senderMode=mock`, 고객/관제 정적 JS의 JavaScript MIME, 전용 DB 백업→격리 복원 점검을 먼저 통과해야 한다. Docker 전용 `smoke.sh`·`backup.sh`·`restore-check.sh` 결과를 native 검증으로 대체하지 않는다.

native 백업/복원 점검은 전용 사용자와 Node로 `deploy/push-lab/native-backup-check.mjs`를 실행한다. `DB_PATH=/var/lib/meatbox-push-lab/push-lab.sqlite`, `PUSH_LAB_BACKUP_DIR=/var/lib/meatbox-push-lab/backups`, `PUSH_LAB_APP_DIR=/opt/meatbox-push-lab/current`를 전달하며 실제 파일은 그 사용자의 0700 state 안에 생성한다. 이 도구는 **현재 schema만** 받아 live DB를 SQLite backup API로 스냅샷하고 파일 SHA·무결성·외래키를 확인한 뒤, 별도 임시 복사본의 원본 테이블 전체 열·행 digest와 활성/철회 구독·queued/cancelled outbox 집계를 비교한다. 과거 v1/v2 migration 호환성은 위의 Docker 격리 시험 증거이며 native 도구의 주장에 포함하지 않는다. 성공한 백업만 0600 manifest와 짝을 이룬다. 임시 복사본은 정리하며 live DB 교체나 sender 시작은 하지 않는다.

`deploy/push-lab/Caddyfile.same-origin.example`은 현재 TLS 부분과 TMS `3001` upstream을 유지한 **후보**다. `/push-lab`만 슬래시 경로로 redirect하고 `handle /push-lab/*`로 URI를 그대로 `127.0.0.1:3300`에 전달한다. 인터넷 대면 Caddy가 `X-Push-Lab-Client-IP: {remote_host}`를 덮어쓰며, Node는 실측한 loopback TCP peer만 `PUSH_LAB_TRUSTED_PROXY_PEERS`로 신뢰한다. `handle_path`는 필요한 접두사를 제거하므로 사용하지 않는다. 같은 origin은 프로세스·DB 격리이지 브라우저의 별도 신뢰 경계가 아니다. DNS/Firebase/실제 FCM은 변경하지 않는다.

후보를 별도 `caddy validate`하고 내부 readiness·native 백업 복원·root의 최종 gate를 통과한 뒤에만 Caddy를 reload한다. native 서비스의 stop/restart도 65초 이내 정상 drain, DB 보존, `/readyz` 복귀를 확인한다. 공개 전환 뒤 HTTPS 인증서 검증, `/push-lab/`·관제·모바일 고객 링크/QR, 기존 `/login`·`/combined/`·`/api/session`, TMS PID/시작 시각/SHA와 checkpoint 개수/hash/mtime을 전후 비교한다. 문제가 생기면 **보관한 기존 Caddyfile만 복원해 validate/reload하고 새 pilot 서비스만 중지**한다. 파일럿 SQLite·backup과 기존 TMS 데이터는 보존하며 TMS 서비스 재시작·릴리스 전환은 하지 않는다. 공개 HTTPS 페이지 확인은 FCM 접수나 실기기 알림 수신 증거가 아니다.

### 2026-09-23 공개 mock 배포 증거

- Git SHA `25329736a98fdb5ba6a2cfc1875ee490565eb053`의 Linux x64 아티팩트를 서버 밖에서 빌드했다. 45,280,276바이트 tar SHA-256 `8fe34da7a2bae723ba6d6bab72fdc2124836b823e43a7315a659004df3683e64`를 전송 후 서버에서 재확인하고 전용 릴리스 경로에 풀었다. 전용 Node 26.3.1과 SQLite 3.53.1을 사용했고 전역 Node 22와 기존 TMS 릴리스는 바꾸지 않았다.
- 새 systemd unit을 `systemd-analyze verify`한 뒤 전용 비특권 사용자로 `127.0.0.1:3300`에만 기동했다. 내부 health/ready 200, 관리자 login/session 200, 고객·관제·vendor JavaScript MIME을 확인했다. 파일럿 전용 합성 구독 1건에서 `queued → mock accepted`를 관측했으며 실제 FCM 발송은 없었다. 최고 관측 메모리는 약 91 MiB로 설정 상한 192 MiB 이하였다.
- native **현재 schema 5→5** SQLite backup→격리 restore는 `integrity_check=ok`, 외래키 위반 0, 원본 14개 테이블의 전체 열·행 digest 동일, 활성 구독 1건을 확인했다. 백업 SHA-256은 `998a8fcd1082c0e395eb8d7b0f58a34a69ac86fa2729dd5518c1191e63502aa0`이고 백업과 manifest는 파일럿 전용 `backups/`에 남겼다. 새 서비스만 정상 재시작한 후에도 ready 200, 활성 구독 1건과 mock accepted outbox 1건이 유지됐다. 이 native 검사는 과거 v1/v2 migration 증거가 아니다.
- 기존 `/etc/caddy/Caddyfile`과 보관본의 SHA-256 `383f21698a2ac51b3f02c7e2c6bdfbfcdb1f31225b16d507cf064d2f00fe9f49`를 CAS 확인하고 후보를 `caddy validate`한 뒤 원자 적용·graceful reload했다. 현재 설정 SHA-256은 `4e4000b92a5aba4ec72abf24633cee2097aa0082728a7bc75db6953c23aa7260`이다. 인증서 검증을 켠 외부 HTTPS에서 `/push-lab/`·`/push-lab/control/`·health/ready가 200, ready의 build SHA가 위 릴리스와 같고 vendor JS·앱 JS·TTF·manifest MIME이 정확했다. Caddy가 위조된 전용 client-IP 헤더를 덮어쓰는지 서버 loopback A의 401×5→429와 별도 외부 B의 정상 login 200으로 확인했다. A는 서버 loopback bucket이며 사용자 IP의 오답 제한을 시험하지 않았다.
- 전후 기존 TMS PID `102395`, 시작 시각, 릴리스 `549f13b5741328656d20ce27ef10e36692efda5b`, 배차 checkpoint 2개·집계 내용 hash·최신 mtime이 같았다. 기존 `/login`은 200, 익명 `/api/session`은 401, Caddy PID `42150`도 유지됐다. 익명 `/combined/` 경로는 기존 TMS 로그인으로 302 전달됨을 배포 후 확인했으며 이 경로의 전환 전 HTTP 코드는 기록하지 않았다. 루트 디스크 여유는 전환 후 약 1.7 GiB였다.

위 첫 공개 릴리스 `2532973`의 관리자 인증은 파일럿 전용 hash 비밀번호였다. 아래 후속 릴리스부터는 기존 TMS 세션으로 전환했다. 공개 HTTPS/QR 표시나 mock `accepted`는 모바일 브라우저의 실제 링크 열기, FCM 접수, Android/iOS 알림 표시·클릭을 증명하지 않는다.

첫 배포에서 서버 전용 Node 아카이브 설치(10:29 KST), 서버 밖 Docker 이미지 생성(10:37), 45MB 아티팩트 작성(10:38)·서버 배치(10:41), 전용 unit 설치(10:42), 파일럿 재시작(10:46), Caddy 공개 전환(10:49)을 완료 시각으로 관측했다. 각 구간은 인증·전송·압축 해제·검증·판단 시간을 함께 포함하므로 **개별 build/upload/restart 소요 시간이나 병목 순위를 측정한 값이 아니다**. Docker가 서버에 없어서 이미지 빌드가 느려졌다고 단정할 근거는 없다. Docker를 사용하면 변경되지 않은 빌드 [레이어 캐시](https://docs.docker.com/build/cache/)와 [이미지 레이어 재사용](https://docs.docker.com/get-started/docker-concepts/building-images/understanding-image-layers/)의 이점이 있지만, 이미지는 서버 밖 Docker에서 빌드했고 서버에 Docker를 설치하지 않았다. 아래 후속 배포는 최초 런타임·서비스 계정 준비를 반복하지 않았다.

### 2026-09-23 기존 TMS 세션 인증 후속 배포

고정 Git SHA `d1911c998b4a35ffab458cbb6b80e20f3414a895`에서 Linux x64 아티팩트 43,820,583바이트, SHA-256 `31311b60feb6ac33c922c077ee47ff34d341d5b320faf67324b2d7ef21b8c711`을 서버 밖에서 만들고 전송·서버 재검증 후 별도 immutable release에 설치했다. PR CI의 test와 GitGuardian은 통과했다. 기존 Node/runtime·TMS·Caddy는 교체하지 않았다. 전송 구간은 4초, 파일럿 env/current 전환·재시작·내부 ready 확인은 5초였다. Docker build 로그의 Firebase vendor 단계는 4.6초였고 `npm ci` 레이어는 캐시 재사용이었다. 압축·서버 추출·안전 검증 전체 시간을 하나의 이미지 변경 소요로 측정하지는 않았다.

기존 root:root 0600 운영 env를 같은 권한의 `push-lab.env.before-d1911c9`로 보관한 뒤, 파일럿만 `PUSH_LAB_ADMIN_AUTH_MODE=tms_session`, `PUSH_LAB_TMS_SESSION_URL=http://127.0.0.1:3001/api/session`, **사용자가 승인한 canonical username 한 개만** `PUSH_LAB_TMS_ALLOWED_USERNAMES`에 설정하고 재시작했다. 실제 username·비밀번호·hash·토큰은 문서·PR에 기록하지 않는다. 기존 `EXCHANGE_KEYS`·mock sender·SQLite는 보존했다. [`native.env.example`](../deploy/push-lab/native.env.example)은 여전히 비활성 주석 예시다. 목록이 없거나 빈 값이면 관리자는 fail-closed 503이어야 하며 전체 사용자 허용 값으로 대체하지 않는다.

adapter는 브라우저의 단일 `meatbox_session` 쿠키만 TMS loopback `GET /api/session`에 `Cookie`와 `Accept: application/json`으로 전달하며, 다른 쿠키·비밀번호·identity 헤더는 보내지 않는다. redirect·retry·cache 없이 TMS 401은 파일럿 401, 허용된 사용자 200은 통과, 목록 밖은 403, 그 밖의 응답·설정 오류는 503으로 처리한다. 기존 unit의 `IPAddressDeny=any`와 `IPAddressAllow=localhost` 그대로 loopback TMS 호출이 가능했다. 외부 네트워크·TMS 서비스·계정·데이터·Caddy 설정은 변경하지 않았다. 이는 실제 승인 사용자 세션의 200 성공 증거가 아니다.

운영에서 TLS 검증을 켠 `/push-lab/`·`/push-lab/control/`은 200, `/push-lab/readyz`는 위 build SHA와 schema 5, `/push-lab/control/api/auth-mode`는 `{"authMode":"tms"}`였다. 무세션과 합성 구형 파일럿 쿠키는 각각 401, 형식상 유효하지만 무효인 합성 TMS 쿠키는 파일럿과 TMS upstream 모두 401이었다. 이 마지막 검사는 실제 사용자 쿠키를 읽거나 로그인하지 않고 adapter의 upstream 도달성을 확인한 것이다. JS·TTF MIME, `127.0.0.1:3300` 바인딩, mock sender를 확인했다. 전후 TMS PID `102395`·릴리스 `549f13b5741328656d20ce27ef10e36692efda5b`, Caddy PID `42150`·설정 hash `4e4000b92a5aba4ec72abf24633cee2097aa0082728a7bc75db6953c23aa7260`, 배차 checkpoint 2개·집계 hash·최신 mtime이 같았다. 기존 `/login` 200·익명 `/api/session` 401도 유지됐다.

전환 전·후 각각 native **현재 schema 5→5** SQLite backup→격리 restore가 `integrity=ok`, 외래키 위반 0, 원본 14개 테이블의 전체 열·행 보존, 활성 구독 1건으로 통과했다. 백업 SHA-256은 전 `e8b9523e330e17bb1d5366ff8e6af633ab6b40af7f6632d8bcda0719bab97f1e`, 후 `3cb4473dba9f16b0f5289f667b8fd4b8923b8817512a5ab87e5e8f380b813980`이며 전용 state의 backup·manifest를 유지한다. 문제 발생 시 위 env 보관본과 이전 파일럿 릴리스 symlink만 복원해 **파일럿 서비스만** 재시작한다. TMS/Caddy/파일럿 DB는 복구 대상으로 덮어쓰지 않는다.

이 소스는 루트 `npm test` 508/508, push-lab `npm test` 78/78과 전체 `git diff --check`를 통과했다. 여기에는 합성 TMS 세션의 정확한 허용·거부, 쿠키 파싱, upstream 장애·timeout fail-closed 테스트가 포함된다. 프런트의 인증 모드별 화면·재확인 동작은 로컬에서 검증했고 공개 HTTP GET smoke도 통과했으나, 공개 브라우저 도구가 사용 불가해 마지막 네트워크 오류 분기와 실제 TMS 로그인 UI를 재검증하지 못했다. **실제 승인 사용자 TMS 세션으로 관제 200, 미허용 실제 계정 403, 운영 TMS 장애 503, 로그아웃 직후 경합은 운영에서 시험하지 않았다.** 자격·쿠키를 읽거나 운영 로그인·계정 변경을 수행하지 않았다. 인증 직후 TMS logout/비활성화가 일어나는 경합은 요청마다 TMS 세션을 재검증하는 계약으로 제한하지만 이미 진행 중인 작업의 동시 경계를 운영에서 증명한 것은 아니다.

사용자가 실제 TMS canonical username으로 정정했으며, **그 한 계정만** 비밀 제외 메타데이터의 좁은 조회로 존재·활성 상태를 확인하고 운영 allowlist에 설정했다. 최초 제시된 이메일 원문·계정 목록·비밀번호·hash·토큰은 이 저장소와 PR에 기록하지 않는다.

## P2 HTTPS·실기기 시험 전 필수 입력

- 고정 HTTPS origin과 DNS 소유권, 인증서 발급·갱신 방식
- 실제 호스트의 컨테이너 또는 native runtime/Caddy 버전, 가용 메모리·디스크, 사용 포트, 현재 서비스와 실행 SHA
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

이 절의 Caddy 예제는 P2 real sender를 켜는 지시가 아니다. 동일-origin **mock** sidecar의 별도 승인·공개 전환은 위 증거에 기록했으며 DNS·Firebase 설정·기존 TMS 데이터는 바꾸지 않았다. 실제 FCM을 위한 고정 origin, Firebase SDK 통신 범위, 전용 CSP와 기기 증거는 별도 승인·검증이 필요하다.

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
