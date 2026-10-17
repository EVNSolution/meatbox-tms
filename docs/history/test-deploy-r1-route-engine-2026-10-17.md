# TEST 경로 엔진(R-1) 배포·연동 기록 (2026-10-17)

[릴리스 기록 양식](../templates/release-record.md)을 따른다. 합성 주문만 썼다. 비밀값·쿠키·토큰은 적지 않는다.

## 대상과 결과

- 기록일·시간대: 2026-10-17 22:23~22:41 KST (Asia/Seoul), 아래 UTC 시각은 같은 날 13:23~13:41Z.
- 대상 환경·서비스: TEST 단일 호스트(`i-03d1f27429c948b7d`), `meatbox-api@green`(API 8082). 엔진은 전용 인스턴스 `meatbox-route-engine`(`i-03fc76005facd40d8`, 사설 IP 172.31.0.176).
- 작업 담당: 실행 Claude 세션. 확인 담당: 사용자가 TEST 웹에 직접 로그인한 세션을 앱 내 브라우저로 사용하고 나머지는 에이전트가 수행.
- 이전 실행 릴리스: `fb41d4b4b48f-1a237657f37348a6`. 실제 실행 릴리스: `2809e28b4cc2-b897ab134cf69dbd` (Git `2809e28b4cc22019e8d24da006755347f986401e`).
- 변경 목적: ETA·자동 배송 순서·운행 거리를 OSRM+VROOM 실도로 기준으로 계산하고, 엔진이 없으면 직선거리로 떨어진다.
- 최종 판정: 전환 완료. 엔진 연결과 폴백을 TEST에서 관찰했다. 미트박스 실 송수신 확인은 아니다.

## 전제와 보존 기준

- 배포: CI run `39036379687` 성공(4m29s, 13:23:47Z~13:28:16Z) → Deploy Run `39036690685` 성공(1m11s). 단계별 ms: snapshot 891, transfer 9542, rollout 27435, total 49314. 백업 `/var/backups/meatbox-tms/20261017T132859Z-347888`. 활성 슬롯 `green`.
- 설정 차이(TEST `/etc/meatbox-tms/api.env`에만 추가, 0600 root 유지, 저장소 변경 없음): `MEATBOX_OSRM_BASE_URL=http://172.31.0.176:5005`, `MEATBOX_VROOM_URL=http://172.31.0.176:3005/`. 변경 전 사본 `api.env.before-r1-20261017`.
- 적용: `systemctl restart meatbox-api@green` 1회(13:31:24Z), 시작 로그 13:31:33Z, health `UP`(재시작 10초 뒤), 시작 로그 오류 0건. 실행 중 프로세스 환경에 두 키가 모두 있음을 확인(값은 기록하지 않음). 세션은 `sessions.json`으로 유지된다.
- 날짜: `2026-11-08`(CSV 매니페스트에 없는 가장 가까운 일요일. 이전 시도 `2026-10-21`은 CSV 날짜라 주문 수신이 409였다). `2026-10-18`·`10-25`·`11-01`은 이미 API 원본 날짜다.
- 접근: 사용자가 앱 내 브라우저에서 본인 계정으로 직접 로그인했다(역할 `ops`). 에이전트는 계정을 만들거나 비밀번호를 입력하지 않았다. 주문 수신 토큰은 호스트에서 셸이 읽어 쓰고 출력·기록하지 않았다.

## 증거

| 층위 | 실행 대상·명령 또는 확인 방법 | 결과·시각·근거 위치 | 미확인 범위 |
|---|---|---|---|
| 소스·의존성·테스트 | CI `39036379687` | 성공. 로컬 `make check-api`(381)·`check-api-contracts`(87/88, 1건 건너뜀)·`check-web-app`(409+4)·`check-root-tests`(267) | |
| 불변 후보·설정 | Deploy `39036690685` 로그 | `trusted`, source `main`, `2809e28b4cc2-b897ab134cf69dbd` | |
| 서버 실행 버전·서비스 상태 | 호스트 `active-slot`·`deployment-mode`·`current` 링크·`REVISION` | `green`, `native 2809e28b4cc2-b897ab134cf69dbd`, SHA `2809e28b…986401e`와 일치. 8082 health `UP`. `meatbox-api@blue` 실패 표시는 이전 슬롯의 낡은 유닛(기능 영향 없음) | 8081 슬롯 |
| 엔진 도달 | TEST 호스트에서 사설 IP 호출 | OSRM `nearest` 200, VROOM 200 | |
| 연동(엔진 켬) | 주문 3건 수신 `R1-A/B/C` → 계산·확정 → suggest → 출발 → ETA | 아래 표 | 미트박스 실 송수신 |
| 폴백(엔진 끔) | 인스턴스 정지 뒤 suggest 반복 | 아래 표 | |
| 인증·HTTP·접근 제한 | 사용자의 로그인 세션(`ops`)으로 호출 | `/api/session` 200 | 기사 앱·고객 화면 |

연동(엔진 켬), 날짜 `2026-11-08`, 차량 `api-g01`:

| # | 요청 | 응답 | 핵심 필드 |
|---|---|---|---|
| 1 | 주문 `R1-A`·`R1-B`·`R1-C` 수신(서울 좌표) | 202 ×3 | `applied:true` |
| 2 | `calculate_dispatch`, `publish_dispatch` | 200, 200 | `unplanned` → `published` |
| 3 | `POST .../driver/route/suggest` | 200 | `engine:"vroom"`, `totalKm 18.2`, `totalMinutes 29`, 순서 R1-A·R1-C·R1-B |
| 4 | 이벤트 `departed`(시청 좌표, 13:39:45Z) | 202 | |
| 5 | `GET .../driver/route` | 200 | ETA R1-A 22:56, R1-B 23:18, R1-C 23:36(+09:00). 출발 22:39:45 → 첫 배송지 +16분. 모두 `estimated:true` |
| 6 | `GET .../state` | 200 | `vehicleStates[api-g01].eta.engine:"osrm"`, `reason:"departed"` |
| 7 | `GET /api/ops/alerts` | 200 | `route-engine` 알림 0건(전체 0건) |
| 8 | 출발 뒤 suggest 한 번 더 | 200 | `engine:"vroom"`, `totalKm 18.2`, `totalMinutes 24` |

폴백(엔진 인스턴스 정지 13:40:29Z 이후):

| # | 요청 | 응답 | 핵심 필드 |
|---|---|---|---|
| 9 | suggest 첫 호출 | 200, 3.05초 | `engine:"osrm"`(60초 캐시된 행렬을 썼기 때문), VROOM 3초 시간 초과 → 2-opt, `totalKm 18.2` |
| 10 | suggest 둘째 호출 | 200, 3.11초 | `engine:"haversine"`(OSRM 3초 시간 초과) |
| 11 | suggest 셋째 호출 | 200, 26ms | `engine:"haversine"`, `totalKm 22.5`, `totalMinutes 59`, 같은 순서. 30초 휴지로 엔진을 부르지 않음 |
| 12 | `GET /api/ops/alerts` | 200 | `route-engine OSRM_UNAVAILABLE` 1건, `route-engine VROOM_UNAVAILABLE` 1건(코드마다 1회) |

전후 비교(같은 주문, 출발 뒤): 도로 18.2km·24분 → 직선 22.5km·59분. 첫 배송지 ETA는 출발 뒤 +16분(도로).

## 복구와 인계

- 중단·복구 기준: 엔진 설정 때문에 API가 실패하면 `api.env`의 두 줄을 지우거나 `api.env.before-r1-20261017`로 되돌리고 `meatbox-api@green`을 재시작한다. 코드 롤백은 필요 없다. 엔진이 꺼져도 API는 직선거리로 계산한다.
- 이전 릴리스·데이터 호환: ETA 항목의 `engine` 필드는 엔진이 설정됐을 때만 저장되며 이전 코드는 모르는 필드를 읽지 않는다.
- 전환 이후 기록 보존: 아래 합성 자료는 지우지 않았다.
- 엔진 인스턴스는 폴백 확인 직후 정지했다(13:40:29Z). 시연 전에 켜는 절차는 [운영](../operations.md#시연-전-엔진-켜기와-끝나면-끄기)에 있다.

## 정리와 남은 것

- 정리함: 로컬 임시 SSH 키 삭제. 사용자의 웹 로그인 세션은 사용자 것이라 손대지 않았다(로그아웃은 사용자가 한다). 임시 계정은 만들지 않았다.
- 남김(삭제하지 않음): 체크포인트 보존 원칙과 영구 삭제 금지 때문에 `2026-11-08`의 합성 주문 3건과 상태·`inbound/`·ETA 항목을 지우지 않았다. 이 날짜는 TEST 매니페스트에 `source:"api"`, 주문 3건으로 계속 보이고 `driver` 상태는 출발 처리되어 있다. 날짜가 지나면 읽기 전용이 된다.
- 남김(설정): `api.env`의 엔진 두 줄, `api.env.before-r1-20261017`.
- 남은 제한:
  - 엔진을 끈 직후 최대 60초는 캐시된 행렬 때문에 `engine:"osrm"`으로 답할 수 있다.
  - 엔진이 꺼진 상태의 첫 요청은 OSRM·VROOM 시간 초과로 각각 약 3초씩 걸린다. 이후 30초는 즉시 직선거리로 답한다.
  - 웹 대시보드 라벨은 `distanceBasis`를 읽지 않아 도로 기준 거리도 "추정"으로 보인다(웹 후속).
  - 엔진 인스턴스를 켜 두지 않으면 시연에서 직선거리 ETA가 나온다.
