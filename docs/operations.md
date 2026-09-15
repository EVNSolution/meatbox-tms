# 운영과 검토 기준

## 인스턴스

- EC2: `i-03d1f27429c948b7d`, `ap-northeast-2`, Public IP `3.36.96.156`
- HTTPS: Caddy 2.11.4, Let’s Encrypt `shortlived` IP 인증서 자동 관리
- 앱: `meatbox-gateway.service`, `127.0.0.1:3001`, 전용 `meatbox-demo` 사용자
- 릴리스: `/opt/meatbox-demo/releases/<git-sha>`, 활성 심볼릭 링크 `/opt/meatbox-demo/current`
- 계정과 초대 해시: `/var/lib/meatbox-demo/access.json` (0600), StateDirectory (0700)
- 기존 서버: `/home/ubuntu/meatbox-demo`, 이전 `meatbox-demo.service`는 전환 완료 후 중지/비활성화
- 최초 전환 백업: `/home/ubuntu/meatbox-backups/20260913T082032Z/` (앱, Caddy 설정/바이너리/인증서 데이터, 서비스)

현재 주소가 자동 할당 Public IP라면 인스턴스 stop/start 때 주소가 바뀔 수 있습니다. 별도 Elastic IP를 새로 연결하면 현재 주소 자체가 바뀌므로 이 작업에서는 주소를 변경하지 않습니다.

## 초대 발급

SSH/서버 권한을 가진 운영자가 실행합니다. 공개 관리자 API는 없습니다.

```sh
sudo -u meatbox-demo node /opt/meatbox-demo/current/scripts/manage-access.js issue-invite \
  --file /var/lib/meatbox-demo/access.json \
  --output /var/lib/meatbox-demo/invite-reviewer.txt --hours 24
```

출력은 초대 코드가 담긴 파일 경로뿐입니다. 초대 코드와 `https://3.36.96.156/dev/register`를 검토자에게 별도로 전달합니다. 초대 파일은 0600으로 생성되며 이미 있는 파일을 덮어쓰지 않습니다. 비밀번호는 가입자가 직접 입력합니다. 파일 내용/초대 코드를 로그, 이슈, Git에 남기지 않습니다.

```sh
sudo -u meatbox-demo node /opt/meatbox-demo/current/scripts/manage-access.js disable-user \
  --file /var/lib/meatbox-demo/access.json --username USERNAME
```

비활성화 후 다음 요청/명령부터 거절하며 이미 열린 WebSocket도 다음 상태 전송 전에 권한을 확인하며, 유효하지 않으면 전송을 중단하고 닫힙니다. 로그인 세션은 8시간이며 재시작 시 모두 만료됩니다. 초대 코드가 없는 가입은 실패합니다. 사용자 이름은 대소문자를 구분하지 않습니다.

계정 파일 갱신은 프로세스 간 잠금과 원자적 rename으로 보호합니다. 프로세스 강제 종료로 `access.json.lock` 디렉터리가 남으면 요청은 안전하게 실패합니다. 앱/CLI 작성 프로세스가 없는지 확인하고 상태를 백업한 뒤 잠금 디렉터리를 제거하여 복구합니다. 살아 있는 작성자의 잠금을 제거하지 않습니다.

## 배포

1. `npm ci`, `npm test`, 구문 검사와 브라우저 검증을 완료하고 커밋합니다.
2. `git archive <sha>`의 내용을 새 릴리스 디렉터리에 풀고 `npm ci --omit=dev`를 실행합니다. 테스트도 같은 릴리스에서 실행합니다.
3. `/opt/meatbox-demo/current`를 새 릴리스로 원자적으로 교체하고 서비스를 재시작합니다.
4. `systemctl is-active meatbox-gateway`, `/login` 200, 익명 `/` 302, `/api/session` 401, 익명 WebSocket 거부를 확인합니다.
5. 로그인 후 세 분기와 시나리오→합본 상태 반영, 로그아웃을 실제 브라우저에서 확인합니다.

다차량 운영 릴리스는 위 절차에 다음 확인을 추가합니다.

- 준비 전과 활성화 직전에 현재 `REVISION`이 예상 이전 SHA인지 각각 확인합니다. 다른 배포가 먼저 반영되었으면 활성화를 중단합니다.
- 새 릴리스 테스트에서 현재 예시 데이터(차량 130대, 배송지 4,523곳, 9,090박스), 다른 크기의 수신 데이터, 기준 수량의 80~120% 미리보기와 고객 지연 알림의 29분, 30분, 31분 경계값을 확인합니다. V1은 8곳/60박스, V2부터 V130은 차량별 35곳/계획 70박스이며 합성 차량의 `capacityBoxes`는 `null`입니다. 예시 수량을 실데이터 계약이나 적재 상한으로 확정하지 않습니다.
- 누적 알림 부하 테스트에서 정차지별 최근 50건과 전체 최근 1,000건 상한, 단조 증가 ID, 배송지별 격리와 사용자 단위 명령 제한을 확인합니다.
- 계정 파일 `/var/lib/meatbox-demo/access.json`은 릴리스 밖에 유지하고, 배포 전후 digest가 같은지 확인합니다.
- 서비스 재시작 뒤 인증된 HTTPS 화면에서 주문 지도, 다차량 배송 목록, 고객 알림, 배송팁, 고객 시간대와 세 뷰어를 확인합니다.
- 고객 알림과 배송팁은 시연 메모리에만 기록됩니다. 실제 앱 푸시, 알림톡 또는 배송원 장치 전송을 배포 성공 조건으로 주장하지 않습니다.
- 임시 QA 계정을 사용했다면 확인 뒤 비활성화하고 초대 파일, 쿠키와 작업용 SSH 키를 정리합니다.

세부 기능 경계와 검증 항목은 [다차량 운영 계획](fleet-operations-plan.md)과 [테스트 명세](fleet-operations-test-spec.md)를 따릅니다.

릴리스마다 Git SHA를 파일 `REVISION`에 기록합니다. 로그에는 요청 본문, 비밀번호, 쿠키를 기록하지 않습니다. 서비스는 데이터 디렉터리만 쓸 수 있으며 외부에서는 Node 포트에 접근하지 않고 Caddy HTTPS를 경유합니다.

## HTTPS와 SSLip

최종 Caddyfile에는 Public IP만 있습니다. HTTP는 같은 IP의 HTTPS로 자동 이동합니다. SSLip DNS 자체는 제3자 서비스라 삭제할 수 없지만 이 서비스의 SSLip 호스트와 리디렉션 설정은 제거합니다.

IP 인증서는 160시간 유효하며 Caddy가 자동 갱신합니다. `/var/lib/caddy/.local/share/caddy`를 영속 보존하고 80/443을 유지합니다. 별도 Certbot을 중복 실행하지 않습니다.

IP 주소로 접속하는 클라이언트는 SNI를 생략할 수 있습니다. EC2의 내부 주소와 Public IP가 다르므로 `default_sni 3.36.96.156`으로 올바른 IP 인증서를 선택합니다. 인증서 검증은 끄지 않습니다.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -I https://3.36.96.156/login
openssl s_client -connect 3.36.96.156:443 -verify_return_error </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -dates -ext subjectAltName
sudo journalctl -u caddy --since '1 hour ago' --no-pager
```

공식 근거: [Caddy ACME issuer](https://caddyserver.com/docs/caddyfile/directives/tls), [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https), [Let’s Encrypt IP 인증서](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability).

## 롤백

이전 **인증된** 릴리스로 current 심볼릭 링크를 되돌리고 `meatbox-gateway`를 재시작합니다. 계정 파일은 릴리스 밖에 두어 유지합니다. 최초 전환 이전 서버에는 인증이 없으므로 이전 Caddyfile을 그대로 복원하여 공개하지 않습니다. 첫 릴리스가 실패하면 외부에는 유지보수 503을 내고, 백업은 로컬 확인/복구용으로만 사용합니다.

## 레이아웃 규칙

좌측 메뉴와 전역 시나리오 팝업을 유지합니다. 운영 뷰어의 지도는 주문 관리에서 사용하고 배송 관제에는 두지 않습니다. 고객, 배송원과 주문 지도는 같은 로컬 MapLibre·OFM 테마를 사용합니다. 주문 지도는 `/scenario/api/route-data`에 등록된 실제 좌표만 DSV 목적지 마커로 표시하며, 좌표 없는 배송지는 위치 미등록 건수로 알립니다. 확인되지 않은 좌표나 직선 경로를 만들지 않습니다. 지도 모서리의 `지도 시나리오` 팝업은 수신 데이터 전체를 100% 기준으로 삼아 총수량을 80~120%로 미리 봅니다. 개별 주문의 원본 수량은 유지하며, 배차 알고리즘 결과로 해석하지 않습니다. 배송 목록은 데스크톱에서 배송지 한 곳당 44px 한 행을 사용하고 전체 검색 결과를 50개씩 표시합니다. 고객 매장 선택기도 전체 검색 결과를 50개씩 표시합니다. 관제는 선택 배송 상세를 본문에 한 번만 두고 우측에는 같은 차량의 얇은 배송지 목록을 둡니다. 카드 내부 간격은 부모의 padding/gap이 정하고 상태별 하단 보정은 하지 않습니다. 실제 도착과 배송 완료는 한 외곽 테두리와 한 내부 구분선을 사용합니다.

## 수동 상태 선택 기준

가이드는 시간순 설명서 대신 주문과 배송 장면을 직접 고르는 여섯 개의 짧은 버튼을 제공합니다. `주문 관련` 그룹은 `접수 완료`, `피킹 중`, `출고 준비`, `배송 관련` 그룹은 `배송 중`, `배송지 도착`, `배송 완료`입니다.

- `set_scenario`는 `received`, `picking`, `ready`, `shipping`, `arrived`, `completed` 가운데 하나와 선택한 실시간 배송지 `S1`부터 `S8`까지를 받습니다.
- 임의 프리셋을 바로 선택할 수 있으며 중간 이벤트를 기다리지 않습니다. 현재와 다른 선택은 상태를 한 번 계산해 모든 인증 연결에 반영하고, 같은 프리셋과 배송지를 다시 선택하면 계산하거나 재전파하지 않습니다.
- 현재 선택은 스냅샷의 `scenarioPreset`과 `scenarioStopId`를 따릅니다. 초기화 값은 `received`와 `S1`이며, 순서 변경이나 보류로 현재 프리셋 의미가 깨지면 두 값이 `null`일 수 있습니다.
- 합성 차량 배송지는 시나리오를 변경하지 않습니다. 배송팁과 운영자 수동 안내는 프리셋 변경으로 삭제하지 않습니다.
- 프리셋과 배송 순서 변경은 고객 약속 시간대와 운영 정확 ETA 기준을 전체 초기화하지 않습니다. 도착과 완료 프리셋은 선택 배송의 고정 실제 도착 시각을 정확 시각으로 제공하고, 약속이 없는 배송만 새 시간대를 만듭니다. 전체 기준 초기화는 명시적 `reset`에서만 수행합니다.
- 서버의 500ms 시뮬레이션 진행은 사용하지 않습니다. 현재 합본의 `OperatingSimulation` 도착은 반복 `tick` 없이 한 번 전환합니다. 일반 시뮬레이션 폴백의 최대 10,000회 안전 제한은 원본 회귀용으로 유지합니다. 자동 주행, 자동 하차 완료, 배속, 사고와 정차 지연 컨트롤도 합본에 없습니다.
- 이전 `advance`, `place_order`, `speed`, `traffic`, `dwell` WebSocket 명령은 차단합니다. 배송원 화면의 기존 `arrive_stop`, `complete_stop` 명령은 유지하고 각각 수동 `arrived`, `completed` 프리셋을 한 번 적용합니다.
- 인증 상태 확인, 사용자 명령 제한 정리와 브라우저 WebSocket 재연결에 필요한 타이머는 유지합니다.
- 인증 후 `/`는 `/combined/`로 바로 이동합니다. `/scenario/`는 상현 원본 고객 화면으로 진입하고, `/scenario/customer`, `/scenario/driver`, `/scenario/control`, `/scenario/present`는 각 원본 참조 화면을 제공합니다. 원본 파일은 수정하지 않으며 별도 타이머나 자동 진행 엔진을 시작하지 않습니다.
- 상세 계약과 로컬 검증은 [수동 시나리오 계획](manual-scenarios-plan.md)과 [테스트 명세](manual-scenarios-test-spec.md)를 따릅니다. 배포 완료는 별도 릴리스 SHA, 운영 서비스 상태와 인증된 화면 검증으로 확인합니다. 운영 계정 변경은 기능 변경 범위에 포함하지 않습니다.


## 가입과 로그인 입력

비밀번호 최소 길이는 데모 사용성에 대한 사용자 결정으로 8자, 최대 128자입니다. 길이 조건은 브라우저와 서버가 함께 검증합니다. 실제 업무용 인증 표준 준수를 의미하지 않습니다.

필드마다 안내 영역을 하나만 두고, 오류가 생기면 같은 위치의 문구를 해결 방법으로 교체합니다. 수정하면 원래 안내를 복원합니다. 한 줄 높이를 확보하고 긴 문구는 잘리지 않게 줄바꿈합니다. 색 외에도 오류 문구, `aria-invalid`, 연결된 안내와 제출 시 포커스로 상태를 전달합니다.

참고: [GOV.UK 오류 문구](https://design-system.service.gov.uk/components/error-message/), [W3C 폼 알림](https://www.w3.org/WAI/tutorials/forms/notifications/). 2026-09-13 확인.
