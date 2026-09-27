# 개발 환경과 로컬 빠른 시작

이 문서는 외부 주문 자료, 운영 계정, 운영 비밀값 없이 현재 저장소를 로컬에서 실행하는 절차다. 기준 소스는 `40387756a5c02d02af6ac134d4a2d5bfa1146bef`이다. 로컬 실행 결과는 운영 배포나 실데이터 연동의 증거가 아니다.

## 준비 사항

| 항목 | 조건 | 근거 |
| --- | --- | --- |
| Node.js | `22.13.0` 이상 | [`package.json`](../package.json)의 `engines.node` |
| SQLite | 별도 npm 패키지가 아니라 Node 내장 `node:sqlite` 사용 | [`resource-store.js`](../lib/resource-store.js) |
| npm 의존성 | 잠금 파일과 일치하도록 설치 | [`package-lock.json`](../package-lock.json) |
| 로컬 주소 | `http://127.0.0.1:3001` | 서버가 `127.0.0.1`에만 바인딩됨: [`server.js`](../server.js) |

서버는 시작할 때 자원 저장소 모듈을 불러오므로 `RESOURCE_DATABASE`를 사용하지 않더라도 `node:sqlite`를 제공하는 Node 버전이 필요하다. 이 저장소의 지원 기준은 `package.json`에 선언된 Node 22.13 이상이다.

## 격리된 로컬 실행

저장소 루트에서 다음 명령을 순서대로 실행한다. `.runtime/local`만 사용하므로 저장소에 남아 있는 다른 로컬 자료나 운영 경로를 읽지 않는다.

```sh
node --version
npm ci

umask 077
mkdir -p .runtime/local/dispatch-data .runtime/local/dispatch-state

node scripts/manage-access.js issue-invite \
  --file "$PWD/.runtime/local/access.json" \
  --output "$PWD/.runtime/local/invite.txt" \
  --hours 2

env -u RESOURCE_DATABASE \
PUBLIC_ORIGIN=http://127.0.0.1:3001 \
ACCESS_FILE="$PWD/.runtime/local/access.json" \
DISPATCH_DATA_DIR="$PWD/.runtime/local/dispatch-data" \
DISPATCH_STATE_DIR="$PWD/.runtime/local/dispatch-state" \
PORT=3001 \
npm start
```

`node --version`의 결과가 `v22.13.0`보다 낮으면 실행을 중단하고 Node를 올린다. 초대 발급 명령은 초대 코드 자체가 아니라 생성된 파일 경로를 출력한다. `.runtime/local/invite.txt`는 비밀번호와 같은 비밀값으로 취급하고 저장소에 추가하거나 메신저로 보내지 않는다.

초대 출력 파일이 이미 있으면 CLI는 덮어쓰지 않고 종료한다. 기존 파일을 재사용하지 말고 `--output`에 새 로컬 파일명을 지정해 새 초대를 발급한다.

서버가 시작되면 같은 컴퓨터의 브라우저에서 다음 순서로 계정을 만든다.

1. `http://127.0.0.1:3001/dev/register`를 연다.
2. 로컬 초대 파일의 코드, 새 로컬 사용자명, 8자 이상의 새 비밀번호를 입력한다.
3. `http://127.0.0.1:3001/login`에서 방금 만든 계정으로 로그인한다.
4. 검토가 끝나면 서버 터미널에서 `Ctrl-C`로 종료한다.

빈 `DISPATCH_DATA_DIR`을 사용하므로 날짜별 원본 데이터 API는 사용할 수 없음으로 응답한다. `RESOURCE_DATABASE`를 설정하지 않았으므로 자원 등록부 API도 `503 RESOURCE_DATABASE_UNAVAILABLE`로 닫힌다. 두 API 응답은 격리 실행의 정상 상태다. 자원 등록부는 다른 자료로 대체하지 않는다. 합본 화면은 manifest가 404인 설치에 한해 기존 시나리오로 전환할 수 있다. 따라서 화면에 보이는 예시 차량을 날짜별 원본 연결 성공으로 해석하지 않는다. 보존 시나리오와 합본 데모 화면은 저장소에 포함된 자산으로 확인할 수 있다.

## 환경 변수

| 변수 | 필수 여부 | 역할 | 로컬 원칙 |
| --- | --- | --- | --- |
| `PUBLIC_ORIGIN` | 필수 | HTTP Origin, 쿠키 보안 속성, WebSocket Origin 검사의 기준 | 정확한 origin만 허용한다. 로컬에서는 `http://127.0.0.1:3001` 사용 |
| `ACCESS_FILE` | 필수 | 사용자와 초대 해시를 저장하는 JSON 파일 | `.runtime/local/access.json` 사용. 운영 계정 파일 복사 금지 |
| `PORT` | 선택 | HTTP 포트, 기본값 `3001` | 선택한 포트를 `PUBLIC_ORIGIN`에도 동일하게 반영 |
| `DISPATCH_DATA_DIR` | 선택 | 날짜별 manifest/day/region 자료 경로 | 빠른 시작에서는 빈 격리 디렉터리 사용 |
| `DISPATCH_STATE_DIR` | 선택 | 날짜별 배차 체크포인트 경로 | 설정하지 않으면 날짜별 변경 상태가 메모리에만 남음 |
| `RESOURCE_DATABASE` | 선택 | 기존 자원 등록부 SQLite 파일 | 빠른 시작에서는 설정하지 않음. 존재하지 않거나 잘못된 DB는 닫힌 상태로 실패 |

`PUBLIC_ORIGIN`이 HTTP이면서 loopback 주소가 아니면 서버가 시작을 거부한다. 다른 기기에서 접근하려고 바인딩 주소를 바꾸거나 임시 공개 터널을 열지 않는다. 원격 접근은 별도 운영 설계와 승인을 거친 HTTPS 역방향 프록시 범위다.

## 계정 관리 CLI

현재 CLI는 초대 발급과 사용자 비활성화만 제공한다.

```text
node scripts/manage-access.js issue-invite --file <access.json> [--output <invite.txt>] [--hours <positive-number>]
node scripts/manage-access.js disable-user --file <access.json> --username <username>
```

- 초대는 1회용이고 기본 유효기간은 24시간이다. 빠른 시작은 노출 시간을 줄이기 위해 2시간을 사용한다.
- 사용자명은 소문자로 정규화된다.
- 로그인 세션은 서버 메모리에만 존재하므로 서버를 다시 시작하면 다시 로그인해야 한다.
- 비활성화는 계정 파일에 상태를 저장한다. 별도 CLI 프로세스에서 실행한 경우, 실행 중인 서버는 다음 세션 확인에서 비활성 상태를 읽어 접근을 거부한다. 즉시 모든 서버 세션 메모리를 직접 지우는 원격 관리 API는 아니다.

세부 규칙과 파일 잠금 방식은 [`access.js`](../lib/access.js), 관련 회귀는 [`access.test.js`](../test/access.test.js)와 [`gateway.test.js`](../test/gateway.test.js)를 참조한다.

## 자원 등록부 SQLite 경계

현재 HEAD에는 지역 코드와 차량 연결을 보관하는 독립 자원 등록부가 있다. 서버는 `RESOURCE_DATABASE`가 가리키는 **이미 생성된 파일**만 연다. 값이 없거나 파일·스키마가 유효하지 않으면 API는 503으로 실패하며 다른 자료를 대신 사용하지 않는다. 단, 유효한 기존 v1 DB는 첫 API 조회에서도 v2로 자동 이행될 수 있다. 운영 DB를 빠른 시작에 연결하지 않는 이유다.

등록부 생성은 [`import-resource-catalog.mjs`](../scripts/import-resource-catalog.mjs)가 명시적 절대 경로의 날짜 자료를 입력받을 때만 수행한다. 이 절차에는 실제 입력 자료가 필요하므로 외부 데이터 없는 빠른 시작에는 포함하지 않는다. SQLite 등록부는 주문 수신 DB나 B_AREA 배차 구현을 뜻하지 않는다.

## 개발 확인

저장소가 공식적으로 제공하는 확인 명령과 증거 기록 방법은 [검증 가이드](verification.md)를 따른다. 현재 `package.json`에는 lint, typecheck, build, 브라우저 E2E 스크립트가 없다. 존재하지 않는 명령을 릴리스 기준으로 적지 않는다.

## 흔한 시작 실패

| 증상 | 확인할 내용 |
| --- | --- |
| `ACCESS_FILE is required.` | `ACCESS_FILE`이 비어 있거나 서버 명령에 전달되지 않음 |
| `PUBLIC_ORIGIN must be an exact origin` | 경로가 포함됐거나 origin 형식이 아님. 스킴·호스트·포트만 사용 |
| `Public access requires HTTPS` | loopback이 아닌 주소에 HTTP origin을 사용함 |
| `RESOURCE_DATABASE_UNAVAILABLE` | 빠른 시작에서는 정상. 자원 기능이 필요하면 별도 등록부 준비 절차를 따름 |
| `DISPATCH_DATA_UNAVAILABLE` | 빠른 시작에서는 정상. 빈 격리 데이터 디렉터리를 사용 중임 |
| 로그인 후 재시작하자 로그아웃됨 | 세션은 프로세스 메모리에 저장됨 |

운영 배포, 백업, 복구, 상태 디렉터리 권한은 [운영 가이드](operations.md), 실서비스 전환 조건은 [운영 준비도](production-readiness.md)를 따른다.
