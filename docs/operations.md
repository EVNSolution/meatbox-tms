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

좌측 메뉴와 전역 시나리오 팝업을 유지합니다. 지도 없는 단말 관제의 지도 펼치기는 빈 미리보기 안내만 보여줍니다. 카드 내부 간격은 부모의 padding/gap이 정하고 상태별 하단 보정은 하지 않습니다. 긴 안내가 있는 카드와 같은 행에서 높이를 맞출 때 남는 공간은 본문이 받습니다. 안내 문장에 필요한 구분점은 유지하되 제목/짧은 메타데이터의 장식용 구분점은 줄입니다.

## 합본 시연 가이드와 완료 확인

가이드의 시각은 실제 벽시계가 아닌 시뮬레이션 시각입니다. 출고 준비는 05:45 주문 접수, 05:50 피킹, 06:05 라벨 부착, 06:20 상차 대기, 06:30 출발 순서이며 각 단계에 다음 행동과 시간 변화가 표시됩니다. 배송 중에는 현재 목적지의 이동/하차를 구분합니다.

- `arrive_stop`은 현재 이동 목적지 `stopId`가 일치할 때만 기존 엔진의 `tick(true)`를 반복하여 도착 경계까지 진행합니다. 기존 교통·ETA·시각 계산을 재사용하고 배속을 유지합니다. 반복은 10,000 tick으로 제한합니다.
- `complete_stop`은 도착 후 현재 시각의 하차 완료 스캔입니다. 합본은 대상 `stopId`를 보내 이미 완료했거나 다른 배송지로 넘어간 요청을 무시합니다. 기존 기사 원본의 `stopId` 없는 명령도 계속 지원합니다.
- 첫 배송 완료 후 도착/완료 시각과 완료 건수를 확인하고 다음 목적지 안내로 이어갑니다. 8곳 전체 완료와 초기화도 동일한 엔진을 사용합니다. 추가 상황·초기화는 모든 접속자에게 반영됩니다.
- 로컬 확인: 인증 WebSocket을 통한 주문→출발→첫 도착→완료, 8곳 전체 진행 회귀, 기존 원본 바이트 보존을 포함해 Node 테스트 47개 통과. 실제 브라우저에서 첫 배송 완료, 단계 시각, 다음 목적지, 1280px/390px 배치와 지도 확대를 확인했습니다. 브라우저 검증의 상세 기록은 로컬 `.omx/state/scenario-guide/ralph-progress.json`에 있습니다.


## 가입과 로그인 입력

비밀번호 최소 길이는 데모 사용성에 대한 사용자 결정으로 8자, 최대 128자입니다. 길이 조건은 브라우저와 서버가 함께 검증합니다. 실제 업무용 인증 표준 준수를 의미하지 않습니다.

필드마다 안내 영역을 하나만 두고, 오류가 생기면 같은 위치의 문구를 해결 방법으로 교체합니다. 수정하면 원래 안내를 복원합니다. 한 줄 높이를 확보하고 긴 문구는 잘리지 않게 줄바꿈합니다. 색 외에도 오류 문구, `aria-invalid`, 연결된 안내와 제출 시 포커스로 상태를 전달합니다.

참고: [GOV.UK 오류 문구](https://design-system.service.gov.uk/components/error-message/), [W3C 폼 알림](https://www.w3.org/WAI/tutorials/forms/notifications/). 2026-09-13 확인.
