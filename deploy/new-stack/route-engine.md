# TEST 호스트 경로 엔진 (OSRM + VROOM, 시연용)

ETA·자동 배송 순서·운행 거리를 실도로 기준으로 계산하는 엔진이다. API는 `MEATBOX_OSRM_BASE_URL`·`MEATBOX_VROOM_URL`이 있을 때만 쓰고, 없거나 실패하면 직선거리·2-opt로 떨어진다. 엔진이 없어도 배포는 막히지 않는다. 설정은 [운영 문서](../../docs/operations.md#경로-엔진-설정-osrm--vroom-시연용)에 있다.

## 현재 상태 (2026-10-17)

- **TEST 호스트에는 설치하지 않는다.** t3.micro(전체 908MB, 사용 가능 404MB), docker 없음, 디스크 8.8GB 여유라 실행 중 엔진(OSRM 1.16GiB + VROOM 41MiB)을 올릴 수 없다.
- **엔진 전용 인스턴스를 따로 만들었다.** 이름 `meatbox-route-engine`, `i-03fc76005facd40d8`, t3.medium(4GiB), 20GB gp3, ap-northeast-2a, TEST와 같은 VPC·서브넷, 사설 IP `172.31.0.176`(정지·시작해도 유지). Ubuntu 24.04, docker 29.1.3, 엔진 폴더 `/opt/meatbox-route`.
- 보안 그룹 `sg-0e8ffdf4b173eea9d`(meatbox-route-engine): 5005·3005는 TEST 보안 그룹(`sg-0dfb51362bee497f5`)에서만 들어오고, 22번 규칙은 없다. 컨테이너 포트는 사설 IP에만 연결된다(공개 노출 없음).
- **평소에는 정지해 둔다.** 정지 중 비용은 디스크 약 2달러/월이고, 켜 두면 t3.medium 시간당 약 0.05달러다. 시연 전에 켜고 끝나면 끈다.
  ```sh
  aws ec2 start-instances --region ap-northeast-2 --instance-ids i-03fc76005facd40d8
  aws ec2 stop-instances  --region ap-northeast-2 --instance-ids i-03fc76005facd40d8
  ```
  시작하면 docker와 두 컨테이너가 저절로 올라온다(정지→시작 후 약 1분 안에 OSRM·VROOM이 200으로 답함을 확인).
- 확인한 것(TEST 호스트에서 사설 IP로 호출): OSRM 경로 200(3.7ms), VROOM 200, `table` 요청 시간은 20점 0.17초, 100점 0.99초, 150점 1.58초, **200점 2.4초**. API 시간 초과가 3초라 200점은 여유가 얇다(VROOM 200곳도 약 2.45초, 한 요청에서 차례로 부르면 약 5초). 보통 한 대의 배송지 수(수십 곳)는 합쳐 1초 안이다. 느려지면 API는 직선거리로 떨어진다.
- **API 쪽 설정은 아직 넣지 않았다.** 이 변경은 아직 푸시·배포 전이라 TEST의 JAR에 엔진 코드가 없다. 배포한 뒤 `/etc/meatbox-tms/api.env`에 아래 두 줄을 넣고 활성 슬롯을 다시 시작한다.
  ```sh
  MEATBOX_OSRM_BASE_URL=http://172.31.0.176:5005
  MEATBOX_VROOM_URL=http://172.31.0.176:3005/
  ```
- 엔진 인스턴스에 들어가야 할 때: 보안 그룹에 22번(내 IP만)을 잠깐 열고 EC2 Instance Connect로 접속한 뒤 규칙을 지운다.
- 지도는 한국 전체다(`south-korea-latest`, 서울만이 아님). 서울시청 기준 부산 393km 4.9시간, 광주 297km 3.7시간, 강릉 216km 2.9시간이고 전국에 흩어진 200점 table은 1.79초, VROOM은 1.69초였다. 제주·울릉은 배편 구간을 도로처럼 계산한다(제주 539km 8.2시간). 섬 배송지는 ETA에 배편 시간이 들어간다.
- 증거: [route-engine-osrm-vroom-2026-10-17.txt](../../docs/evidence/route-engine-osrm-vroom-2026-10-17.txt)(실제 JAR 시나리오는 로컬 docker 엔진). 지도 파일 만들기(`prepare.sh`) 최대 사용량은 약 5GB라서 이 인스턴스에서는 돌리지 않고, 만들어 둔 `data/`(약 1.8GB)를 복사했다.

## 설치 절차

엔진 정의는 `08_UPS/clever-ups/infra/route`(원본은 `04_CLEVER_Route/clever-route-server`의 `osrm-korea`·`vroom-korea`, OSRM v5.27.1 고정, `--max-table-size 1000`, VROOM `maxlocations 1000`·`maxvehicles 200`)를 그대로 쓴다. 이 저장소에는 복사하지 않는다.

0. 이 절차는 엔진 전용 인스턴스를 새로 만들 때의 순서다(위 인스턴스는 이미 만들어 둠). 지도 파일은 5GB 이상 여유가 있는 곳에서 만들어 `data/`를 복사해도 된다.
1. 여유 확인. 실행만 하면 RAM 3GB 이상, 지도를 만들려면 5GB 이상이다.
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
5. 시작한다. 두 컨테이너에 `restart: unless-stopped`가 있어 호스트 재시작 때 docker와 함께 올라온다. 다른 호스트(TEST)가 부르려면 `compose.yml`의 `127.0.0.1:`을 이 호스트의 사설 IP로 바꾼다. 같은 호스트에서만 쓰면 그대로 둔다.
   ```sh
   cd /opt/meatbox-route && sudo sed -i 's/127\.0\.0\.1:/<사설 IP>:/' compose.yml   # 사설 IP를 쓸 때만
   docker compose up -d
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
