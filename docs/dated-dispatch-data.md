# 날짜별 원본 자료와 데이터 준비

이 문서는 **원본 파일 → 조회용 산출물**의 책임을 설명합니다. 배차 상태 전이는 [도메인](domain-and-state.md), 배포·백업은 [운영 절차](operations.md), 원본의 과거 수량·성능 측정은 [초기 기록](history/dated-dispatch-data-2026-09-16.md)으로 분리합니다.

## 자료의 종류

| 자료 | 생산·사용 코드 | 의미 |
|---|---|---|
| 원본 CSV·SHP | [prepare-dispatch-data.py](../scripts/prepare-dispatch-data.py) 입력 | 개인정보와 위치가 포함된 비공개 원본 |
| `manifest.json`, `days/*.json`, gzip, `regions.geojson` | 위 스크립트 → [dispatch-data.js](../lib/dispatch-data.js) | 날짜별 주문·후보 그룹·공통 경계의 조회 자료 |
| `destinations.json` | [prepare-destination-data.py](../scripts/prepare-destination-data.py) | 날짜 누적 배송처 집계. 일별 운행·현재 자원 등록부와 다름 |
| 미트박스 주문 수신 파일 | Kotlin API `integrations/meatbox/inbound/InboundOrders` | `POST /api/meatbox/orders`로 받은 주문의 날짜별 파일(`{state-dir}/inbound/{date}.json`). 준비 스크립트 산출물이 아니며 상태 디렉터리가 소유 |
| 날짜별 체크포인트 | [source-operations-router.js](../lib/source-operations-router.js) | 계산안·확정 배차·진행 상태. 원본 산출물과 별도 저장 |
| 자원 SQLite | [import-resource-catalog.mjs](../scripts/import-resource-catalog.mjs) | 명시적으로 가져온 차량·지역 코드 등록부. 일별 주문 DB가 아님 |

`DISPATCH_DATA_DIR` 기본값은 저장소 아래 `.runtime/dispatch-data`입니다. 원본·산출물·체크포인트·계정 파일·자원 DB를 한 종류의 ‘데이터’로 묶어 교체하지 않습니다. `.runtime/`는 Git 제외 대상이지만 접근 통제·보존 기간을 대신하지 않습니다.

## 날짜 원본의 두 종류

한 날짜의 주문 원본은 **준비된 CSV 묶음**(매니페스트·`days/{date}.json`) 또는 **미트박스가 보낸 주문**(API 원본) 중 하나다. 읽기 경로(`manifest`, `days/{date}`)는 API 날짜를 매니페스트에 `source: "api"`(`weekday`, `orders`, `boxes` 포함)로 끼워 넣고 같은 모양의 날짜 JSON(`groups`는 합성 후보, `orders`는 활성 주문)을 만들어 돌려준다. API 날짜가 없으면 매니페스트 응답은 원본 바이트 그대로다.

- `sourceId`는 CSV 날짜에서 매니페스트 `source.csvSha256`, API 날짜에서 `api-` + 적용된 활성 주문 `id:version`의 SHA-256이다. 체크포인트는 날짜마다 자기 원본의 `sourceId`에 묶인다.
- 준비 디렉터리(`DISPATCH_DATA_DIR`)에는 API 주문을 쓰지 않는다. 같은 날짜가 두 원본에 있으면 닫는다. 변경·취소 정책과 저장 순서는 [도메인과 상태](domain-and-state.md#미트박스가-보낸-주문api-원본)에 있다.
- 준비 완료 판단의 CSV 항목(원본 지문, 행 합계 등)은 API 날짜에 해당하지 않는다. API 날짜의 대사는 수신 파일의 `received`/`applied` 건수와 경고로 한다.

## 날짜와 식별자

**현재 운영일은 서울의 실제 달력 날짜**입니다. `manifest.defaultDate`와 `source.dateShift`는 자료 선택·출처 메타데이터이며 현재 날짜를 고정하는 설정이 아닙니다. 과거는 조회만 가능하고 오늘 자료가 없으면 빈 상태를 표시합니다. [날짜 해석 코드](../apps/combined/operating-date.mjs), [조회 날짜 선택](../apps/combined/dated-dispatch.mjs)

과거 준비 작업에서는 원본 날짜를 발표일에 맞춰 이동한 적이 있습니다. 이런 변환은 원래 날짜를 `sourceDate`와 manifest 변환 정보에 보존합니다. 새 자료에 날짜 이동을 관행적으로 적용하지 않습니다. 이력이 실제 당일 주문이나 실제 배송완료 증거가 되는 것도 아닙니다.

CSV 기사 표기는 후보 그룹의 출처입니다. `grp_` 식별자는 기사 표기로부터 생성되며 정식 직원·차량 신원 증명이 아닙니다. 주문 키는 날짜·결제·구매자·주소·상세주소·기사·좌표·권역 조합에서 만들어집니다. 완전히 같은 원본 행도 임의 제거하지 않고 순수량을 합산하는 현재 정책을 유지합니다. 회원 번호는 해시 계산에 사용하며 브라우저 응답에 원문을 노출하지 않습니다.

배차의 배송지 묶음은 정규화된 이름·주소 기준입니다. 누적 배송처 자료의 키와 같다고 가정하지 않습니다. 자세한 식별자 구분은 [도메인과 상태](domain-and-state.md)에 있습니다.

## 좌표와 권역

준비 코드의 CSV 기본 좌표계는 `EPSG:5179`이며 `--csv-crs`로 지정할 수 있습니다. SHP는 `.prj`를 읽어 변환합니다. 기존 자료는 별도의 SHP 좌표계를 사용했으므로 CSV와 같다고 단정하지 않습니다. WGS84 경도·위도로 변환하고 좌표·수량·권역 형식을 검증합니다.

CSV 권역코드와 SHP `ZONE_ID`는 동일 체계라고 가정하지 않습니다. 원본 폴리곤의 점 포함 결과로 연결하며 경계·구멍·다중 폴리곤을 임의로 새로 그리지 않습니다. 자료에 없는 실제 GPS·주행 경로·상품 온도·근무 시간은 만들어 내지 않습니다. 고객·배송원 예상 시간의 계획값은 실제 관측값과 별개입니다.

## 로컬 자료 준비

다음은 **승인된 원본을 별도 로컬 후보 디렉터리로 가공하는 예시**입니다. 운영 경로에 직접 실행하지 않습니다. 입력 경로와 실제 원본에 존재하는 날짜를 먼저 정해야 합니다.

GIS 변환에는 `pyproj`, `pyshp`, `shapely`가 필요합니다. 현재 저장소에는 Python 잠금 파일이 없습니다. [초기 기록](history/dated-dispatch-data-2026-09-16.md)의 당시 확인 버전을 재현 기준으로 참고하되, 새 환경의 설치 결과·버전·회귀 결과를 함께 기록합니다. Node 서비스 런타임에 GIS 패키지를 설치하는 구조는 아닙니다.

```sh
# 저장소 루트. 아래 세 값은 예시이며 실제 승인된 입력으로 바꿉니다.
export TMS_SOURCE_DIR=/absolute/path/to/approved-source
export TMS_CANDIDATE_DIR="$PWD/.runtime/dispatch-candidate"
export TMS_SOURCE_DAY=2025-09-17

python3 -m venv .runtime/data-prep-venv
.runtime/data-prep-venv/bin/python -m pip install pyproj==3.8.0 pyshp==3.1.6 shapely==2.1.2
.runtime/data-prep-venv/bin/python scripts/prepare-dispatch-data.py \
  --source "$TMS_SOURCE_DIR" \
  --output "$TMS_CANDIDATE_DIR" \
  --default-date "$TMS_SOURCE_DAY"
.runtime/data-prep-venv/bin/python scripts/prepare-destination-data.py \
  --source "$TMS_SOURCE_DIR/analysis_dataset.csv" \
  --manifest "$TMS_CANDIDATE_DIR/manifest.json" \
  --output "$TMS_CANDIDATE_DIR/destinations.json"
```

필수 입력은 `analysis_dataset.csv`, `MP_ADM_KMEANS.shp/.shx/.dbf/.prj/.cpg`입니다. `--source-date`와 `--operating-date`는 명시적 날짜 이동에만 함께 사용하며 같은 요일 조건을 확인합니다. 보통의 화면 날짜 선택에는 산출물을 다시 만들 필요가 없습니다.

`prepare-dispatch-data.py`는 기본적으로 기존 출력 덮어쓰기를 거부합니다. `--replace`는 기존 산출물을 교체하며 성공 후 작업용 이전 디렉터리를 제거합니다. **영구 백업을 만드는 옵션이 아닙니다.** 운영 전환용 백업은 별도로 보존해야 합니다. 누적 배송처 스크립트도 출력 카탈로그를 교체하므로 위 후보 경로에서 검증합니다.

## 준비 완료 판단

1. 입력 파일 지문과 변환 옵션·도구 버전을 기록합니다.
2. 원본 행·박스 합계가 날짜별 산출물과 일치하는지 검증합니다. 고정된 과거 수량을 정답으로 사용하지 않습니다.
3. 모든 주문의 그룹 참조·식별자·좌표·수량이 유효한지, 미등록 값이 숨겨지지 않았는지 확인합니다.
4. 날짜 이동이 있다면 원본 날짜·요일·주문 ID·수량·좌표·순서가 보존되는지 확인합니다.
5. 누적 카탈로그의 manifest 지문이 해당 후보와 일치하는지 확인합니다.
6. 기존 체크포인트의 `sourceId`와 새 원본의 호환성을 확인합니다. 불일치를 파일 삭제나 재계산으로 해결하지 않습니다.
7. 격리 환경에서 후보 조회와 기존 초안·확정 상태 복원을 확인한 뒤 [릴리스 기록](templates/release-record.md)에 근거를 남깁니다.

관련 회귀: [원본 준비](../scripts/test_prepare_dispatch_data.py), [누적 배송처](../scripts/test_prepare_destination_data.py), [조회 API](../test/dispatch-data.test.js), [배차 상태](../test/dispatch-operations.test.mjs). 전체 실행 방법은 [검증 가이드](verification.md)를 따릅니다.

## 자원 등록부와의 관계

가져오기 도구는 하루 자료의 모든 그룹 ID와 표시 차량번호를 보존하고, 코드 형식·용차 제외 조건에 맞는 행을 활성화합니다. 과거 ‘155개 보존·31개 활성’은 특정 입력의 결과이며 고정 수량 계약이 아닙니다. 등록 코드와 표시 차량번호는 실제 신원 확인이 아닙니다.

신규 자원 DB 생성은 명시적 가져오기 작업입니다. 기존 v1 자원 DB는 최초 열기에서 v2로 이행할 수 있어 단순 API 조회에도 쓰기가 생길 수 있습니다. 파일 지문·백업·권한·스키마 확인과 rollback은 [운영 절차](operations.md)를 따릅니다. 차량·지역 코드 등록부와 주문 공급용 DB는 별도 책임입니다.
