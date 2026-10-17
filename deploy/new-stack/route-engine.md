# TEST 호스트 경로 엔진 (OSRM + VROOM, 시연용)

ETA·자동 배송 순서·운행 거리를 실도로 기준으로 계산하는 엔진이다. API는 `MEATBOX_OSRM_BASE_URL`·`MEATBOX_VROOM_URL`이 있을 때만 쓰고, 없거나 실패하면 직선거리·2-opt로 떨어진다. 엔진이 없어도 배포는 막히지 않는다. 설정은 [운영 문서](../../docs/operations.md#경로-엔진-설정-osrm--vroom-시연용)에 있다.

## 현재 상태 (2026-10-17 확인)

- **TEST 호스트에는 설치하지 않았다.** `free -m` 결과 전체 908MB, 사용 가능 404MB, 스왑 2GB. x86_64, CPU 2개, 디스크 23GB 중 8.8GB 남음. docker 없음. 5GB 이상 남는다는 설치 조건에 못 미친다.
- 로컬(colima 4GiB VM, docker 29.5)에서는 실행해 확인했다. 정지 상태 사용량은 OSRM 1.16GiB, VROOM 41MiB다. 지도 파일 만들기(`prepare.sh`)의 최대 사용량은 약 5GB다. 증거: [route-engine-osrm-vroom-2026-10-17.txt](../../docs/evidence/route-engine-osrm-vroom-2026-10-17.txt).
- 필요한 인스턴스: RAM 8GB 이상(예: 2 vCPU 8GiB급), 디스크 40GB 이상. 호스트에서 `prepare.sh`까지 돌리려면 RAM 16GB급이 안전하다. 블루/그린 슬롯 두 개가 겹치는 배포 중에도 엔진이 계속 떠 있어야 한다. 증설이 먼저다.
- 증설 없이 쓰려면 지도 파일을 다른 컴퓨터에서 만들어 `data/`(약 1.7GB)만 복사하는 방법이 있다. 그래도 실행 중 엔진(약 1.3GB)과 두 슬롯 JVM이 한 호스트에 겹치므로 여유 RAM을 `free -m`으로 먼저 확인한다.

## 설치 절차

엔진 정의는 `08_UPS/clever-ups/infra/route`(원본은 `04_CLEVER_Route/clever-route-server`의 `osrm-korea`·`vroom-korea`, OSRM v5.27.1 고정, `--max-table-size 1000`, VROOM `maxlocations 1000`·`maxvehicles 200`)를 그대로 쓴다. 이 저장소에는 복사하지 않는다.

1. 여유 확인. 5GB 이상이 아니면 멈추고 인스턴스부터 키운다.
   ```sh
   free -m
   df -h /
   ```
2. docker와 compose 플러그인을 설치하고 부팅 때 켜지게 한다.
   ```sh
   sudo systemctl enable --now docker
   ```
3. 엔진 폴더를 복사한다(로컬에서 `rsync`). `data/`는 제외한다.
   ```sh
   sudo mkdir -p /opt/meatbox-route && sudo chown ubuntu /opt/meatbox-route
   rsync -a --exclude data <로컬>/08_UPS/clever-ups/infra/route/ ubuntu@<TEST>:/opt/meatbox-route/
   ```
4. 한국 지도를 받아 OSRM 파일을 만든다(약 275MB 내려받기, 수십 분, 최대 RAM 약 5GB).
   ```sh
   cd /opt/meatbox-route && ./prepare.sh
   ```
   다른 컴퓨터에서 만든 `data/south-korea-latest.osrm*`를 같은 위치로 복사해도 된다.
5. 시작한다. 두 컨테이너에 `restart: unless-stopped`가 있어 호스트 재시작 때 docker와 함께 올라온다.
   ```sh
   cd /opt/meatbox-route && docker compose up -d
   curl -s "http://127.0.0.1:5005/route/v1/car/126.978,37.5665;127.0276,37.4979?overview=false" | head -c 200
   docker stats --no-stream
   free -m
   ```
   포트는 `127.0.0.1:5005`(OSRM), `127.0.0.1:3005`(VROOM)뿐이다. Caddy에서 열지 않는다.
6. `/etc/meatbox-tms/api.env`(0600)에 두 줄을 더하고 활성 슬롯을 다시 시작한다. `deploy/new-stack/api.env.example`에 주석 줄이 있다.
   ```sh
   MEATBOX_OSRM_BASE_URL=http://127.0.0.1:5005
   MEATBOX_VROOM_URL=http://127.0.0.1:3005/
   ```
7. 확인: 인증된 세션으로 `POST /api/dispatch-data/days/<date>/driver/route/suggest?vehicleId=<id>` 응답의 `engine`이 `vroom`이고, 출발한 차량의 ETA 항목(`vehicleStates[v].eta.engine`)이 `osrm`인지 본다. `haversine`이면 엔진에 닿지 못한 것이다. 알림 `route-engine`을 본다.

## 갱신·중지

- 지도 갱신: `data/`의 `south-korea-latest.osm.pbf`를 지우고 `prepare.sh`를 다시 돌린 뒤 `docker compose up -d --force-recreate`. 시연에는 이 주기로 충분하다(자동 갱신 없음).
- 중지: `docker compose down`. API는 다음 요청부터 직선거리로 계산하고 알림을 1회 보낸다. 알림을 피하려면 `api.env`의 두 줄을 지우고 슬롯을 다시 시작한다. 코드 롤백은 필요 없다.
- 엔진을 켜고 끄는 것은 API 배포와 무관하다. 배포 아티팩트에는 엔진이 들어 있지 않다.

## 라이선스

OSRM·VROOM은 BSD-2-Clause, 지도 데이터는 © OpenStreetMap 기여자(ODbL)다. 웹 지도의 저작 표기는 [운영 문서](../../docs/operations.md#경로-엔진-설정-osrm--vroom-시연용)의 "남은 경계"를 본다.
