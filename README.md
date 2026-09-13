# 미트박스 TMS 검토 작업 공간

로그인한 사용자가 시나리오 원본, UI/레이아웃 원본, 합본을 선택하는 데모입니다. 기존 배송 현황 시스템과 연결할 화면을 검토하며, 실제 차량 TMS 연결이나 고객 알림 발송을 수행하지 않습니다.

## URL과 소유 범위

운영 주소: **https://3.36.96.156/**

| 경로 | 용도 | 코드 |
|---|---|---|
| `/` | 로그인 후 작업 선택 | `apps/portal/` |
| `/scenario/` | 박상현 작업 원본의 진입 페이지 | `workspaces/sanghyun-scenario/` |
| `/scenario/customer?id=S5` | 고객 시나리오 | 위와 같음 |
| `/scenario/driver` | 기사 시나리오 | 위와 같음 |
| `/scenario/control` | 지도 관제 시나리오 | 위와 같음 |
| `/scenario/present` | 진행 단계와 사건 제어 | 위와 같음 |
| `/ui-layout/#/design` | 지인 작업 원본의 디자인 가이드 | `workspaces/jiin-ui/` |
| `/ui-layout/#/control` | 원본 B안 단말 관제 | 위와 같음 |
| `/combined/#/deliveries` | 합본 배송 현황 | `apps/combined/` |
| `/combined/#/control` | 합본 단말 관제 | 위와 같음 |
| `/combined/#/customer` | 합본 고객 보기 | 위와 같음 |
| `/login` | 로그인 | `apps/portal/`, `lib/access.js` |
| `/dev/register` | 메뉴에 노출하지 않는 초대 기반 개발용 가입 | 위와 같음 |

`workspaces/`의 두 원본은 보존용입니다. 박상현 원본 기준 커밋은 `f41af790be7529d4d2da9e8ac44826acdd120a50`이며, 원본 파일별 SHA-256은 `docs/source-snapshots.json`에 있습니다. 원본 코드 수정은 별도 작업으로 검토하고, 통합 변경은 `apps/combined/`와 루트 게이트웨이에 적용합니다. `/scenario/` 경로와 WebSocket 주소만 HTTP 응답 시 치환하여 원본 바이트를 유지합니다.

시나리오와 합본은 **하나의 메모리 시뮬레이션**을 공유합니다. 어느 화면에서든 단계 변경/리셋하면 접속한 모든 검토자에게 반영됩니다. 서비스 재시작 시 시뮬레이션과 로그인 세션은 초기화되고 계정은 유지됩니다. UI/레이아웃은 독립 표본입니다.

합본은 차량 V1 한 대와 배송 8곳을 표현합니다. 고객 공식 ETA와 계속 계산되는 ETA를 분리하며, 원본의 단일 시각을 시간 범위로 바꾸지 않습니다. 실제 도착, 배송 완료, 단말 수신 여부도 각각 구분합니다. `customer?id=S5`는 시연 배송 선택이며 로그인 권한을 대신하지 않습니다.

## 로컬 실행

Node.js 22 이상을 사용합니다. 별도 번들 빌드 없이 Express와 ws만 설치합니다.

```sh
npm ci
mkdir -p .runtime
node scripts/manage-access.js issue-invite --file .runtime/access.json --output .runtime/invite.txt
PUBLIC_ORIGIN=http://127.0.0.1:3001 ACCESS_FILE=.runtime/access.json PORT=3001 npm start
```

`http://127.0.0.1:3001/dev/register`에서 초대 파일의 코드를 입력하여 가입한 뒤 로그인합니다. 초대 코드는 기본 24시간 내 1회 사용 가능하며 회원가입 링크는 일반 화면에 노출하지 않습니다. 기본 계정/비밀번호는 없습니다.

```sh
npm test
node --check server.js
node --check lib/access.js
node --check apps/combined/app.mjs
git diff --check
```

인증, 익명 HTTP/API/WebSocket 차단, 외부 Origin 거부, 세션 종료, 초대 1회 사용, 원본 보존, ETA 의미와 UI 팝업 범위를 검증합니다. CSS는 실제 브라우저에서 넓은 화면과 좁은 화면을 함께 점검합니다.

## 배포와 계정 관리

`deploy/meatbox-gateway.service`와 `deploy/Caddyfile`을 사용합니다. 자세한 배포/롤백/초대 발급 절차는 [운영 문서](docs/operations.md)를 참고하세요. 계정 파일, 초대 코드, SSH 키는 Git에 넣지 않습니다.
