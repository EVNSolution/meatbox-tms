# 운영 런북

서비스 구성, 상태 보존, 배포·백업·복구와 장애 대응 절차를 설명한다. 운영 작업마다 실제 환경을 점검하고 적용 버전·설정·검증 결과를 [릴리스 기록](templates/release-record.md) 또는 [장애 기록](templates/incident-record.md)에 남긴다.

구현 기능과 API 계약은 [API 참고](api-reference.md), 데이터 상태와 전이 규칙은 [도메인과 상태](domain-and-state.md), 출시 판단 기준은 [운영 준비도](production-readiness.md)를 함께 본다. 날짜별 원자료의 생성·이동 규칙은 [날짜별 배차 자료](dated-dispatch-data.md)를 따른다.

## 운영 원칙

1. 소스 검증, 배포 후보, 서버 배치, 데이터 복원, 브라우저 확인을 각각 별도 증거로 남긴다.
2. 계정 파일, 날짜별 체크포인트, 자원 DB, 주문 데이터셋을 하나의 데이터로 취급하지 않는다.
3. 배차 상태를 쓰는 서비스는 한 프로세스만 운영한다. 현재 JSON 체크포인트에는 프로세스 간 잠금이나 다중 노드 합의가 없다.
4. 현재 릴리스가 읽을 수 없는 체크포인트나 자원 DB를 연결한 채 서비스를 시작하지 않는다.
5. 원본 CSV, 계정 파일, 쿠키, 초대 코드, 체크포인트, 운영 DB를 Git·이슈·일반 로그·공개 정적 경로에 두지 않는다.
6. 운영 변경은 승인된 변경 창에서만 수행한다. 이 문서의 읽기 전용 명령은 배포나 복구 권한을 뜻하지 않는다.

## 런타임 구성

### 환경 변수

| 변수 | 필수 여부 | 코드상 기본값 | 의미와 실패 방식 |
| --- | --- | --- | --- |
| `NODE_ENV` | 배포 템플릿에서 설정 | 없음 | 템플릿은 `production`을 사용한다. 애플리케이션 분기에는 현재 직접 사용하지 않는다. |
| `PUBLIC_ORIGIN` | 필수 | 없음 | 스킴·호스트·포트를 포함한 정확한 origin이다. 형식이 다르거나 없으면 시작에 실패한다. 공개 호스트는 HTTPS여야 한다. 로그인, 상태 변경, WebSocket의 Origin 검사 기준이다. |
| `PORT` | 선택 | `3001` | Node가 `127.0.0.1`에서 수신할 포트다. 외부에는 직접 공개하지 않고 역방향 프록시를 거친다. |
| `ACCESS_FILE` | 필수 | 없음 | 계정·초대 해시 파일 경로다. 설정이 없으면 시작에 실패한다. 경로는 있으나 파일이 없으면 최초 읽기에서 빈 저장소로 취급될 수 있으므로 파일 존재와 복구 여부를 따로 확인한다. |
| `DISPATCH_DATA_DIR` | 선택 | `<release>/.runtime/dispatch-data` | 읽기용 날짜별 데이터셋 경로다. `manifest.json`, `days/` 등은 [날짜별 배차 자료](dated-dispatch-data.md)의 계약과 일치해야 한다. |
| `DISPATCH_STATE_DIR` | 선택 | 미설정 | 날짜별 배차·운행 체크포인트 경로다. 미설정이면 상태는 프로세스 메모리에만 남고 재시작 시 사라진다. 배포 템플릿은 `/var/lib/meatbox-demo/dispatch-state`를 설정한다. |
| `RESOURCE_DATABASE` | 자원 기능 사용 시 필수 | 미설정 | 기존 SQLite 자원 등록부 경로다. 미설정이면 `/api/resources`는 503이다. 파일 또는 스키마 오류도 앱 시작이 아니라 최초 자원 API 접근에서 드러날 수 있다. |

`package.json`은 Node.js `>=22.13`을 요구한다. `deploy/meatbox-gateway.service`는 전용 사용자, `UMask=0077`, `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/var/lib/meatbox-demo`를 사용한다. `deploy/Caddyfile`은 HTTPS를 종료하고 `127.0.0.1:3001`로 전달하는 템플릿이다. 템플릿의 IP와 경로는 현재 운영값이라는 증거가 아니다.

### 데이터와 지속성

| 자산 | 코드상 동작 | 운영 한계 |
| --- | --- | --- |
| 애플리케이션 릴리스 | 읽기 전용 코드와 정적 자산 | 실행 SHA를 애플리케이션이 자동 노출하지 않는다. 배포 절차가 별도 `REVISION` 등 변경 불가능한 표식을 남겨야 한다. |
| 계정 파일 | JSON, 파일 잠금, 동기화 후 원자적 rename, 0600 | 비밀번호 해시와 초대 해시를 포함한다. 세션은 파일에 없고 프로세스 메모리에만 있다. 재시작은 모든 세션을 만료시킨다. |
| 날짜별 데이터셋 | 애플리케이션은 읽기만 수행 | 체크포인트의 `sourceId`는 manifest의 `source.csvSha256`과 일치해야 한다. 다른 데이터셋과 체크포인트를 섞으면 복원이 거부된다. |
| 배차 체크포인트 | 날짜별 JSON, 파일 동기화 후 원자적 rename | 정상 재시작 복원용이다. 디렉터리를 `fsync`하지 않아 전원 손실 시 최신 rename 보존을 보장하지 않는다. 날짜별 직렬화는 한 프로세스 안에서만 적용된다. |
| 자원 등록부 | 기존 SQLite 파일을 지연 연결하고 트랜잭션·revision으로 변경 | `user_version=1` 파일은 최초 DB 연결 때 v2로 자동 이행한다. 자원 조회 요청도 연결을 열기 때문에 쓰기를 유발할 수 있다. 다중 서비스 쓰기는 검증된 계약이 아니다. |
| 배송 사진 | 포함된 예시 이미지 또는 선택 파일의 브라우저 `blob:` URL로 미리보기 | 사진 바이트를 서버에 전송하거나 저장하지 않는다. 서버는 `hasPhoto: true`라는 클라이언트 주장만 검사한다. |

### 단일 프로세스 경계

- 날짜별 명령은 프로세스 내부 큐로 직렬화하고 `boot`·`revision`을 확인한다.
- 최대 8개 날짜 엔진을 메모리에 유지한다. `DISPATCH_STATE_DIR`가 설정된 경우에만 명령 성공 전에 디스크 체크포인트를 저장한다.
- 계정 파일만 별도 프로세스 사이의 파일 잠금을 구현한다.
- SQLite 자원 등록부에는 트랜잭션과 revision 충돌 검사가 있지만, 여러 애플리케이션 복제본을 지원 구성으로 정의하지 않았다.
- 수평 확장, 공유 세션, 고가용성, 전원 손실 내구성이 필요하면 저장 계층과 세션 계층을 먼저 교체해야 한다.

## 읽기 전용 사전 점검

아래 명령은 예시 경로를 실제 값으로 바꾼 뒤 운영 호스트에서 실행하는 **읽기 전용 템플릿**이다. 대상 호스트의 도구 설치 상태와 실행 권한을 먼저 확인한다.

```sh
SERVICE_NAME=meatbox-gateway.service
APP_CURRENT=/opt/meatbox-demo/current
STATE_ROOT=/var/lib/meatbox-demo

systemctl is-active "$SERVICE_NAME"
systemctl show "$SERVICE_NAME" \
  --property=User,Group,MainPID,ExecMainStartTimestamp,NRestarts,FragmentPath,DropInPaths
readlink -f "$APP_CURRENT"
stat -c '%A %U:%G %n' "$APP_CURRENT" "$STATE_ROOT"
```

기본 수집은 unit과 drop-in의 경로 메타데이터까지로 제한한다. 실제 설정 본문은 권한 있는 담당자가 호스트 안에서 비밀값을 출력·수집하지 않는 방식으로 별도 확인한다. `systemctl cat` 또는 전체 환경 덤프를 일반 점검 로그에 남기지 않는다.

릴리스와 데이터 연결은 내용을 노출하지 않고 메타데이터로 확인한다.

```sh
APP_CURRENT=/opt/meatbox-demo/current
STATE_ROOT=/var/lib/meatbox-demo

test -r "$APP_CURRENT/REVISION" && sed -n '1p' "$APP_CURRENT/REVISION"
find "$STATE_ROOT" -maxdepth 2 -type f \
  -printf '%M %u:%g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n'
find "$APP_CURRENT/.runtime/dispatch-data" -maxdepth 2 -type f \
  -printf '%M %u:%g %s %TY-%Tm-%TdT%TH:%TM:%TS %p\n'
```

`find` 결과에는 고객 데이터 파일명이 포함될 수 있다. 공유 전 경로와 파일명을 검토한다. `access.json`, 체크포인트, SQLite의 내용을 `cat`하거나 로그에 복사하지 않는다.

### 자원 DB 읽기 주의

`GET /api/resources`는 일반 v2 DB에서는 조회지만, v1 DB라면 `openExisting()`가 v2 이행을 실행한다. 운영 변경 전에 자원 API를 읽기 전용 점검으로 호출하지 않는다. 먼저 SQLite를 직접 읽기 전용으로 열어 버전을 확인한다.

```sh
RESOURCE_DB=/var/lib/meatbox-demo/resources/resources.sqlite

RESOURCE_DB="$RESOURCE_DB" node --input-type=commonjs -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.env.RESOURCE_DB, { readOnly: true });
  try {
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const source = db.prepare("SELECT kind, imported_count, excluded_count, revision FROM source_catalog WHERE id=1").get();
    console.log(JSON.stringify({ version, source }));
  } finally { db.close(); }
'
```

`version`이 `1`이면 서비스를 통해 조회하지 말고 백업·복원 검증과 이행 승인을 먼저 완료한다. `version`이 `2`여도 이 명령은 스키마와 요약만 확인하며 데이터 정확성이나 운영 연결을 증명하지 않는다.

## 릴리스 절차

### 1. 변경 전 증거

다음을 하나의 변경 기록에 남긴다.

- 승인자, 작업자, 변경 창, 대상 환경
- 현재 활성 릴리스 경로와 실행 표식
- 서비스 사용자·재시작 횟수·시작 시각
- 데이터셋 경로와 manifest 해시
- 체크포인트 파일 목록과 해시
- 계정 파일·자원 DB의 크기, 소유자, 모드, 해시
- 자원 DB `user_version`, source 요약, revision
- 복구할 이전 릴리스와 그 릴리스의 체크포인트·DB 호환성 결과

값을 확인할 수 없으면 `미확인`으로 기록하고 배포 승인 조건에서 제외하지 않는다.

### 2. 후보 검증

저장소에 정의된 검증은 `npm test`, 두 용량 점검 스크립트, 브라우저 점검 스크립트다. lint와 typecheck 스크립트는 현재 `package.json`에 없다. 후보 릴리스에서는 다음을 별도 환경에서 수행하고 정확한 Git SHA·Node 버전·종료 코드·테스트 수를 남긴다.

```sh
npm ci
npm test -- --test-concurrency=1
npm run check:capacity
npm run check:capacity:stream
node --check server.js
node --check lib/access.js
node --check lib/resource-store.js
node --check lib/resource-router.js
node --check lib/source-operations-router.js
```

이 명령은 실서버 변경 창에서 실행하는 절차가 아니라 배포 후보 검증 절차다. 브라우저 점검은 합성 fixture 범위이므로 실제 계정·데이터·기기 검증을 대체하지 않는다.

### 3. 일관된 백업

백업 생성은 디스크를 변경하며 민감정보 복제본을 만든다. **배포 승인, 제한된 백업 경로, 보존 기간, 복원 시험 계획이 있을 때만 수행한다.**

1. 백업 창과 가용성 영향을 승인한 뒤 서비스를 중지하고 종료를 확인한다. 현재 앱에는 maintenance/drain 상태나 in-flight 쓰기 0건을 증명하는 전용 API가 없다. 외부 write gate만으로 일관성이 확보되었다고 가정하지 않는다.
2. 별도 계정 CLI·가져오기 작업 등 다른 작성자도 실행 중이지 않은지 확인한다. 외부 gate와 쓰기 종료를 독립적으로 증명한 다른 절차가 없다면, 현재 구현의 일관된 파일 백업 기준은 서비스와 다른 작성자를 모두 멈춘 시점이다.
3. 계정 파일, 전체 체크포인트 디렉터리, 자원 DB와 SQLite 보조 파일, 데이터셋 연결 정보, 활성 릴리스 표식을 같은 복구 지점으로 백업한다.
4. 백업을 제한 디렉터리에 저장하고 0700/0600 권한을 적용한다.
5. 백업 목록과 SHA256을 만들되 파일 내용은 출력하지 않는다.
6. 격리 위치에서 JSON 구문, 체크포인트의 날짜·`sourceId`, SQLite 무결성, 계정 파일 구조를 검증한다.

서비스가 쓰는 동안 SQLite 파일을 단순 복사하거나 날짜별 JSON을 서로 다른 시점에 복사한 결과를 일관된 복구 지점으로 간주하지 않는다.

### 4. 활성화

활성화는 서비스를 변경한다. 승인된 배포 담당자만 다음 순서를 실행한다.

1. 하나의 검증된 커밋에서 릴리스 디렉터리를 만들고 운영 의존성을 설치한다.
2. 릴리스에 정확한 Git SHA를 담은 `REVISION`을 기록한다.
3. 검증한 데이터셋을 읽기 전용으로 배치하고 릴리스가 참조할 경로를 고정한다.
4. `PUBLIC_ORIGIN`, `ACCESS_FILE`, `DISPATCH_DATA_DIR`, `DISPATCH_STATE_DIR`, `RESOURCE_DATABASE`를 후보 계약과 대조한다.
5. 자원 DB가 v1이면 시작 또는 최초 조회가 쓰기 이행을 일으킬 수 있다. 복사본에서 이행·복원을 검증하고 승인받기 전에는 후보를 해당 원본 DB에 연결하지 않는다.
6. 현재 활성 릴리스가 사전 점검 때와 같은지 다시 확인한다. 달라졌으면 중단한다.
7. 원자적으로 활성 릴리스 연결을 바꾸고 서비스를 재시작한다.

신규 자원 DB 생성은 `scripts/import-resource-catalog.mjs`의 명시적 실행으로만 수행한다. 이 스크립트는 출력 파일을 만들고 SQLite에 원본 차량 카탈로그를 기록하는 **변경 명령**이다. 같은 지문의 기존 DB는 `unchanged`를 반환할 수 있다. 그러나 v1 DB는 이 출력 전에 `openExisting()`에서 v2로 이행할 수 있으므로 `unchanged`를 파일 무변경 증거로 사용하지 않는다. 비변경 확인은 기존 v2와 전후 지문을 확인한 범위에만 적용한다. 다른 지문의 기존 DB는 덮어쓰지 않는다. 날짜 JSON·출력 절대 경로, 백업, 예상 원본 지문, 보존할 레코드 수를 승인 기록에 넣지 못하면 실행하지 않는다.

### 5. 활성화 후 검증

먼저 인증 없는 경계를 확인한다. 아래 요청은 상태를 바꾸지 않는다.

```sh
PUBLIC_ORIGIN=https://example.invalid

curl --fail-with-body --silent --show-error --output /dev/null \
  --write-out 'login=%{http_code}\n' "$PUBLIC_ORIGIN/login"
curl --silent --show-error --output /dev/null \
  --write-out 'root=%{http_code} redirect=%{redirect_url}\n' "$PUBLIC_ORIGIN/"
curl --silent --show-error --output /dev/null \
  --write-out 'session=%{http_code}\n' "$PUBLIC_ORIGIN/api/session"
```

코드상 기대값은 `/login` 200, 익명 `/` 302, 익명 `/api/session` 401이다. 실제 origin으로 바꾸지 않은 `example.invalid` 예시를 그대로 실행하지 않는다.

이후 제한된 검증 계정으로 로그인·로그아웃, 세 탭의 조회, 데이터 날짜·source 요약, 과거 날짜 읽기 전용, 고객·배송원 링크, 브라우저 콘솔 오류를 확인한다. 자원 DB가 v1일 가능성을 제거하기 전에는 자원 관리 화면을 열지 않는다.

실제 배차 계산, 배차 확정, 상태 변경, 알림, 배송 완료, 지역코드 변경은 스모크 테스트가 아니라 운영 데이터 변경이다. 별도 승인·격리 자료·복구 기준 없이는 실행하지 않는다.

| 계층 | 배포 완료에 필요한 증거 |
| --- | --- |
| 소스 | 검토된 커밋과 변경 범위 |
| 후보 | 동일 SHA의 테스트·구문 검사 결과 |
| 서버 | 활성 릴리스 경로, `REVISION`, 서비스 상태 |
| 데이터 | 데이터셋 지문, 체크포인트·자원 DB 호환성, 백업 검증 |
| HTTP | 인증 없는 상태 코드와 보안 경계 |
| 브라우저 | 실제 origin에서 인증 후 읽기 흐름과 콘솔 확인 |

## 복원과 롤백

복원과 롤백은 운영 상태를 변경한다. 장애 지휘자 또는 승인된 운영 책임자가 복구 지점과 데이터 손실 범위를 선택한 뒤 수행한다.

### 코드 롤백과 시점 복원 구분

코드만 이전 버전으로 되돌리는 경우에도 현재 상태를 구버전이 읽을 수 있는지 검증한다. 전환 전 백업을 다시 적용하는 것은 별도의 **시점 복원**이며 전환 후 확정 배차·완료·자원 변경을 잃을 수 있다. 먼저 현재 자료를 보존하고, 백업 이후 기록의 범위·대사 방법·허용 손실을 결정한다. 이 기준과 업무 영향 승인이 없으면 과거 백업을 운영 경로에 덮어쓰지 않는다. 복구 성공은 서비스 재기동뿐 아니라 새 업무 기록 보존 또는 승인된 손실의 대사까지 포함한다.

### 복원 순서

1. 변경 요청을 차단하고 단일 작성 프로세스를 중지한다.
2. 손상 의심이 있는 현재 릴리스, 계정 파일, 체크포인트, 자원 DB, 데이터셋 연결을 삭제하지 말고 별도 증거로 보존한다.
3. 선택한 백업의 해시·권한·JSON 구문·SQLite 무결성을 격리 위치에서 확인한다.
4. 애플리케이션 릴리스, 데이터셋, 체크포인트를 한 호환 세트로 맞춘다. 체크포인트 `sourceId`와 manifest `source.csvSha256`가 달라서는 안 된다.
5. 자원 DB 스키마 버전이 대상 릴리스와 호환되는지 확인한다. v2 DB를 v1 파일로 되돌리는 역이행은 정의되어 있지 않다.
6. 계정 파일은 별도로 복원한다. 프로세스 재시작으로 기존 세션은 소멸한다.
7. 제한된 로컬 또는 격리 포트에서 로딩과 읽기 검증을 마친 뒤 트래픽을 복구한다.
8. 공개 경로에서 인증 경계와 브라우저 조회를 다시 확인한다.

체크포인트 오류를 피하려고 파일을 삭제하거나 `reset` 명령을 실행하지 않는다. 현재 배차 엔진은 확정 배차와 운행 상태에 대한 `reset`을 거부한다. 복원 실패 원인을 보존하고 호환 가능한 릴리스·데이터셋·체크포인트 조합을 선택한다.

### 코드 롤백

코드만 이전 릴리스로 바꾸면 이전 코드가 디스크 상태를 읽지 않거나, checkpoint schema·원자료 지문이 달라지거나, 이미 v2로 이행된 자원 DB를 읽지 못하거나, 데이터셋 연결과 source가 어긋날 수 있다. 롤백 후보도 배포 전에 실제 백업 복원 시험을 통과해야 한다. 코드, 데이터셋 연결, 체크포인트 호환성, 자원 DB 호환성을 한 묶음으로 판정한다.

## 장애 분류

| 증상 | 먼저 확인할 읽기 전용 근거 | 판정과 다음 조치 |
| --- | --- | --- |
| 서비스 시작 실패 | `systemctl show/status`, 최근 오류 이름, origin·계정 경로, Node 버전 | 반복 재시작 전에 현재 릴리스와 환경 표식을 보존한다. |
| 재시작 후 전체 로그아웃 | 서비스 시작 시각 | 세션이 메모리 전용이므로 예상 동작이다. 계정 손실로 오판하지 않는다. |
| 모든 로그인 실패 | 계정 파일 존재·소유자·모드·해시, 잠금 디렉터리 | 살아 있는 작성자가 없는지 확인하기 전에는 `.lock`을 제거하지 않는다. |
| `/api/resources` 503 | DB 경로·파일·권한·read-only SQLite 검사 | v1이면 API 조회도 이행을 시작할 수 있으므로 먼저 백업·승인한다. |
| 배차 데이터 404 | 데이터 경로, manifest, 요청 날짜 | 데이터 미설치와 날짜 미존재를 구분한다. 데모 자료로 자동 대체하지 않는다. |
| `DISPATCH_STATE_SOURCE_MISMATCH` | manifest 지문과 checkpoint `sourceId` | 체크포인트 삭제로 우회하지 않는다. 올바른 데이터셋 또는 복구 지점을 선택한다. |
| `DISPATCH_STATE_INVALID` | JSON 구문, schema/date/source, 릴리스 호환성 | 손상 파일을 보존한 채 백업 복원을 검토한다. |
| `BOOT_MISMATCH`/`REVISION_CONFLICT` | 시작 시각, 최신 boot/revision | 동일 명령을 자동 재전송하지 않는다. 최신 상태와 결과를 사람이 확인한다. |
| `DISPATCH_STATE_WRITE_FAILED` | 상태 디렉터리 권한·용량·파일시스템 | 성공으로 간주하지 않는다. 이전 revision 유지 여부를 조회한다. |
| `DATE_READ_ONLY` | 선택 날짜와 KST 오늘 | 보호 동작이다. 서버 시간이나 날짜를 바꿔 우회하지 않는다. |
| 자원 revision 409 | 최신 자원 revision | 최신 목록과 변경 의도를 다시 비교한다. |
| 사진 완료 분쟁 | checkpoint 사건과 브라우저 동작 | 서버에는 사진이 없다. `hasPhoto`를 증빙으로 판단하지 않는다. |

### 서버 오류 자동 알림 (Kotlin API)

Kotlin API는 5xx를 내면 담당자 알림을 한 번 보낸다. 채널 설정이 없어도 동작한다.

- 감지 지점: 처리되지 않은 예외(500 `INTERNAL_ERROR`, kind `server`)와 5xx로 나가는 `DispatchException`(저장 실패 `DISPATCH_STATE_WRITE_FAILED` 포함, kind `dispatch`).
- 억제: 같은 `(kind, code)`는 10분 창에서 첫 1건만 보낸다. 나머지는 세기만 한다. 창이 닫히면 억제 건수를 담은 요약 1건을 보낸다. 요약은 30초 간격 점검에서 나가므로 창 종료 후 최대 약 30초 늦다.
- 본문: kind, code, 발생 시각(UTC), 서버 이름, 억제 건수, 예외 클래스 이름(또는 고정 메시지). 요청 본문·쿠키·스택·내부 경로는 넣지 않는다.
- 발송: 전용 단일 스레드가 보낸다. 요청은 막히지 않는다. 대기 100건을 넘기면 버리고 `dropped`만 올린다. 채널 실패는 WARN 로그 한 줄이고 요청 응답은 그대로다.
- 알림은 프로세스 메모리에만 있다. 재시작하면 창과 최근 목록이 비워지고, 재시작 직후 같은 오류는 다시 한 번 알린다. 슬롯이 둘이면 슬롯마다 따로 센다.

| 변수 | 필수 여부 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `MEATBOX_ALERT_WEBHOOK_URL` | 선택 | 없음 | 설정하면 JSON `{subject, body, at, text}`를 POST한다. `text`는 `subject`와 `body`를 합친 값이며 Slack incoming webhook용이다. 시간 초과 5초, 리다이렉트 없음, 2xx가 아니면 실패다. 비우면 WARN 로그만 남긴다. URL은 비밀값이므로 `api.env`(0600)에만 둔다. http·https가 아니면 시작에 실패한다. |
| `MEATBOX_ALERT_SERVER_NAME` | 선택 | 호스트 이름 | 알림 본문의 서버 식별이다. 슬롯을 구분하려면 슬롯별로 설정한다. |

확인 경로: 세션이 있는 상태로 `GET /api/ops/alerts`를 호출한다. 최근 알림 50건(`subject`, `at`, `suppressedCount`), 채널 종류, 버린 건수를 돌려준다. 세션이 없으면 `401 LOGIN_REQUIRED`다. 로그 채널일 때는 `journalctl -u meatbox-api@<slot>`에서 `ALERT`로 찾는다.

알림을 받으면 위 장애 분류 표의 코드 행으로 이어간다. 메일 채널은 아직 없다. 운영 시간 외 대응 기준은 정하지 않았다. 미트박스 송신 실패는 아래 절의 알림으로 같은 채널에 연결된다.

### 미트박스 주문 수신 (Kotlin API)

미트박스가 `POST /api/meatbox/orders`([API 참조](api-reference.md#미트박스-주문-수신-kotlin-api-전용))로 보낸 주문은 상태 디렉터리의 `inbound/{date}.json`에 날짜별로 쌓인다. 준비된 CSV 묶음(`DISPATCH_DATA_DIR`)에는 쓰지 않는다.

| 변수 | 필수 여부 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `MEATBOX_INBOUND_TOKEN` | 수신 시 필수 | 없음 | 미트박스가 `Authorization: Bearer`로 보내는 토큰이다. **비우면 `/api/meatbox/*` 경로가 없다(404).** 16자 미만이면 시작에 실패한다. 비밀값이므로 `api.env`(0600)에만 두고 로그·알림에 넣지 않는다. 이미 받은 주문은 토큰이 없어도 날짜 조회에 보인다. |
| `MEATBOX_INBOUND_GROUP_COUNT` | 선택 | `8` | 미트박스 주문 날짜에 만드는 합성 후보 차량 수(1~50). 실제 차량이 아니다. 바꾸면 이미 받은 날짜의 후보 목록도 바뀐다. |

- 백업·복원: `inbound/`는 `DISPATCH_STATE_DIR`의 일부다. 체크포인트와 같이 백업하고 같이 복원한다. 체크포인트만 과거로 되돌려 주문 집합이 맞지 않으면 `DISPATCH_STATE_SOURCE_MISMATCH`로 닫힌다(조용히 새로 시작하지 않는다).
- 게이트웨이: 웹 게이트웨이(`apps/web`)는 `/api/meatbox/*`를 Kotlin API로 보내지 않는다. 미트박스가 호출하려면 배포 쪽에서 이 경로만 API(`127.0.0.1`)로 연결하고, 미트박스 고정 IP만 허용한다. 이 저장소는 웹을 바꾸지 않았다.
- 알림: 확정 이후 도착한 변경·취소·신규 주문은 `meatbox-inbound` / `ORDER_CHANGED_AFTER_DISPATCH`·`ORDER_CANCELLED_AFTER_DISPATCH`·`ORDER_ADDED_AFTER_DISPATCH`·`ORDER_CHANGED_AFTER_COMPLETION`으로 알린다. 같은 코드는 10분 창에서 한 번만 알리고 나머지는 요약으로 센다. 건별 경고는 날짜 상태 `sourceData.inbound.warnings`에 남는다. 이 경고를 해소하는 화면은 아직 없다.
- 장애: 저장 실패는 `500 INBOUND_WRITE_FAILED`이고 미트박스가 같은 요청을 다시 보낸다. 계산안 중 변경이 계산안을 버릴 때 저장이 실패하면 계산안만 사라진 상태이므로 운영자가 다시 계산한다.
- 롤백: 이전 버전은 `inbound/`를 읽지 못한다. 롤백하면 미트박스 날짜가 매니페스트에 없어 조회되지 않고 체크포인트는 그대로 남는다. 파일을 지우거나 옮기지 않는다.

### 도착 예정 시각 (ETA) 설정 (Kotlin API)

`departed` 이벤트가 배송지별 도착 예정 시각을 계산할 때 쓰는 값이다. 외부 경로 API는 쓰지 않는다(직선거리 모델). 바꾸면 슬롯을 다시 시작해야 하고, 이미 계산한 ETA는 그대로 둔다.

| 변수 | 필수 여부 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `MEATBOX_ETA_DETOUR_FACTOR` | 선택 | `1.4` | 직선거리에 곱하는 우회계수. 0 이하이면 시작에 실패한다. |
| `MEATBOX_ETA_SPEED_KMH` | 선택 | `25` | 평균 속도(km/h), 도심 기준. 0 이하이면 시작에 실패한다. |
| `MEATBOX_ETA_SERVICE_MINUTES` | 선택 | `5` | 배송지 하나에서 쓰는 작업 시간(분). 음수이면 시작에 실패한다. |

- 이 값들은 `application.yml`의 `meatbox.eta.detour-factor`·`speed-kmh`·`service-minutes`에 매핑된다.
- 값은 실측으로 맞춘 것이 아니다. TEST·운영에서 실제 도착과 ETA를 비교해 조정한다.

### 미트박스 송신 (Kotlin API)

기사 앱 이벤트나 배차 확정이 주문 상태를 바꾸면 서버가 미트박스에 배송 상태 메시지([연동 계약](integration-contract.md) 3.1)를 보낸다. 메시지는 상태 변경과 같은 체크포인트 쓰기로 날짜 상태의 송신함에 쌓이고, 단일 스레드 발송기가 주기적으로 집어 보낸다.

| 변수 | 필수 여부 | 기본값 | 의미 |
| --- | --- | --- | --- |
| `MEATBOX_API_BASE_URL` | 송신 시 필수 | 없음 | 미트박스 기본 주소(http·https). 비우면 발송기가 돌지 않고 송신함에만 쌓인다(시작 로그 1줄). 메시지는 `POST {주소}/tms/delivery-status`로 간다. |
| `MEATBOX_API_TOKEN` | 선택 | 없음 | 있으면 `Authorization: Bearer`로 보낸다. 비우면 헤더를 생략한다. 비밀값이므로 `api.env`(0600)에만 둔다. 로그·알림·`/api/ops/outbox`에 넣지 않는다. |
| `MEATBOX_OUTBOX_INTERVAL_SECONDS` | 선택 | `5` | 발송기 주기. 1 미만은 1로 본다. |
| `MEATBOX_MOCK_RECEIVER_ENABLED` | 선택 | `false` | **테스트 전용.** 켜면 `/mock/meatbox/*` 모의 수신기가 뜬다. 아래 참고. |

ETA(`kind: "eta"`)는 같은 송신함·발송기로 `POST {주소}/tms/eta`에 간다. 거절 알림 코드는 `ETA_REJECTED`, 불통은 `ETA_UNREACHABLE`이다.

- 전송: `Content-Type: application/json`, `Idempotency-Key: <messageId>`, 시간 초과 10초, 리다이렉트 없음. 2xx면 `sentAt`을 기록한다.
- 재시도: `5xx`·`429`·시간 초과·연결 실패는 5초 → 15초 → 45초 → 2분 → 5분(상한) 간격으로 무기한 반복한다. 같은 `messageId`로 다시 보내므로 미트박스가 키로 중복을 막아야 한다. 응답을 받기 전에 프로세스가 죽거나 `sentAt` 저장이 실패하면 같은 메시지가 한 번 더 간다.
- 거절: 그 밖의 `4xx`·`3xx`는 재시도 없이 `failedAt`과 상태 코드를 남기고 알림 `meatbox-outbound` / `DELIVERY_STATUS_REJECTED`를 보낸다. 본문을 고치지 않고 다시 보내지 않는다.
- 불통: 한 메시지가 11번 실패하면 알림 `meatbox-outbound` / `DELIVERY_STATUS_UNREACHABLE`을 보낸다. 이후에도 재시도는 계속한다. 알림 억제는 위 규칙(10분 창)을 따른다.
- 순서: 한 주문의 메시지는 앞 메시지가 끝나야 나간다(`4xx` 거절은 끝난 것으로 본다).
- 확인: 세션이 있는 상태로 `GET /api/ops/outbox?date=YYYY-MM-DD`. `pending`(미전송), `failed`(거절), `sent`와 최근 20건(`attempts`, `nextAttemptAt`, `lastStatus`)을 돌려준다. `pending`이 줄지 않으면 `lastStatus`가 `timeout`·`connect-failed`·`5xx`인지, `MEATBOX_API_BASE_URL`이 비었는지 본다.
- 복구: 미전송 건은 재시작해도 체크포인트에 남아 이어서 나간다. 거절(`failed`) 건은 자동으로 다시 보내지 않는다. 미트박스가 본문 문제를 고친 뒤 다시 보내는 도구는 아직 없다. 체크포인트를 손으로 고치지 않는다.
- 슬롯 전환: 새 슬롯이 쓰기 주체가 된 뒤 이전 슬롯의 발송기가 오래된 캐시로 체크포인트를 덮어쓰지 않도록, 쓰기 전에 파일의 `revision`을 대조한다. 전환 중 같은 메시지가 두 슬롯에서 한 번씩 갈 수 있으므로 미트박스의 `Idempotency-Key` 처리가 전제다.

모의 수신기(테스트 전용): 운영 JAR에 같은 코드가 들어 있고 `MEATBOX_MOCK_RECEIVER_ENABLED`가 `true`일 때만 켜진다. 기본값은 `false`이며 `deploy/new-stack/api.env.example`에도 켜는 줄이 없다. **TEST 서버의 `api.env`에만** `MEATBOX_MOCK_RECEIVER_ENABLED=true`와 `MEATBOX_API_BASE_URL=http://127.0.0.1:<API 포트>/mock/meatbox`를 넣고 슬롯을 다시 시작한다. 세션이 없는 경로이므로 게이트웨이(Caddy)에서 `/mock/*`를 외부로 열지 않는다(API는 `127.0.0.1`만 수신한다). 받은 목록은 `curl http://127.0.0.1:<포트>/mock/meatbox/received?kind=delivery-status`로 본다. 운영·QA에는 켜지 않는다. 실제 미트박스 주소를 받으면 두 변수를 바꾸고 모의 수신기를 끈다.

최근 로그는 요청 본문을 출력하지 않는 범위로 제한한다. 현재 Node 오류 처리는 오류 이름만 출력하지만 프록시·플랫폼 로그 정책은 별도 확인이 필요하다.

```sh
SERVICE_NAME=meatbox-gateway.service
journalctl -u "$SERVICE_NAME" --since '30 minutes ago' --no-pager --priority=warning
```

## 계정 운영

`scripts/manage-access.js`는 서버 파일을 변경하는 관리 도구다. 공개 관리자 API는 없다.

- `issue-invite`는 계정 파일에 초대 해시를 추가하고 새 0600 파일에 평문 초대 코드를 쓴다.
- `disable-user` CLI는 계정 파일의 비활성 상태를 저장한다. 별도 CLI가 실행 중 서버 메모리를 직접 지우지는 않는다. 서버는 다음 HTTP 세션 확인, WebSocket 메시지 처리 또는 주기적 세션 점검(30초)에서 거절하므로 적용 결과를 확인한다.
- 초대 코드는 한 번만 사용하고 만료 시간을 제한한다. 평문 초대 파일은 전달과 수령 확인 후 승인된 보존 정책에 따라 정리한다.
- CLI를 서비스 사용자와 다른 사용자로 실행하면 소유권이 바뀔 수 있다. 대상·출력·실행 사용자를 변경 기록에서 확인한다.
- 계정 종류별 권한은 아직 없다. 계정 발급 자체가 전체 인증 영역 접근 권한 부여다. [보안과 접근](security-and-access.md)을 따른다.

## 운영 인수인계 기록

릴리스 또는 장애 복구 기록에는 변경 목적과 승인자, 이전/신규 릴리스, Node 버전과 검증 결과, 데이터셋 지문, 상태·DB 호환성, 백업과 복원 시험, 활성화 시각, HTTP·브라우저 확인, 실행하지 않은 검증, 남은 위험, 롤백 여부를 포함한다.

날짜별 수량이나 과거 배포 결과는 이 런북에 현재값으로 복사하지 않는다. 시간에 따라 달라지는 근거는 별도 변경 기록에 남긴다.
