# 디자인 레퍼런스 조사

> **초기 디자인·정적 데모 이력.** 이 문서는 현재 구현·운영 서버의 상태를 나타내지 않습니다. [현행 저장소 문서](../../../README.md)를 먼저 사용하세요. 원문은 당시 판단의 근거로 보존합니다.

조사일은 2026-09-13입니다. 미트박스 공개 브랜드 경험, 사용자가 지정한 Analytics Dashboard 원본, 공식 운영 UI 가이드를 분리해 검토했습니다. 공개 커머스가 미트박스 내부 TMS와 같다고 해석하지 않습니다.

## R1 미트박스 공식 커머스

- 출처: [미트박스 홈페이지](https://www.meatbox.co.kr/fo/main/mainPage.do)
- 확인 방법: 공개 페이지의 브라우저 렌더 화면, 접근성 트리, 보이는 요소의 computed style.
- 관측: 흰 배경, 짙은 제목, 붉은 계열 로고, 자홍색 검색 액션, 연한 회색 보조 버튼. 상단의 검색·배송지·주문배송, 상품의 배송 예정일과 주문 마감 정보를 확인했습니다.
- 적용 제안: “무엇이 배송되는지, 어느 단계인지, 언제 도착할지”를 명확하게 읽는 우선순위. 브랜드 액션색은 제한적으로 사용합니다.
- 제외: 쇼핑몰 배너·상품 이미지·판매 지표를 운영 화면에 옮기지 않습니다. 로고 원본 다운로드나 UI 복제는 하지 않았습니다.

| 관측 요소 | 브라우저 computed style | 해석 |
|---|---|---|
| 검색 버튼 배경 | `rgb(219, 14, 100)` / `#DB0E64` | 공개 액션색 후보. 공식 CI 지정색·로고색 확정 아님 |
| 섹션 제목 | `rgb(35, 34, 33)` / `#232221` | 짙은 주요 텍스트 |
| 검색 입력 글자 | `rgb(65, 63, 61)` / `#413F3D` | 보조 텍스트 후보 |
| 고객센터·회원가입 버튼 배경 | `rgb(242, 244, 247)` / `#F2F4F7` | 보조 표면 후보 |
| 다음 버튼 테두리 | `rgb(228, 231, 236)` / `#E4E7EC` | 얇은 구분선 후보 |
| body font stack | `pretendard`, `pretendard Fallback`, `Pretendard`, 한국어 시스템 글꼴 등 | CSS 지정 순서만 확인. 실제 폰트 파일 확보·검증 아님 |
| 보조 버튼 radius | 6px, 카테고리 탭 8px | 일부 요소 관측. 전체 사이트 공통 토큰으로 단정하지 않음 |

Insane Search 엔진은 실행했으나 로컬 의존성·검증 문제로 본문 성공 판정을 얻지 못했습니다. 브라우저 도구로 같은 공개 페이지를 직접 열어 위 화면과 값을 확인했습니다. 접근 실패를 브랜드 정보로 대신 추정하지 않았습니다.

## R2 Analytics Dashboard 지정 템플릿

- [템플릿 원본](/Users/jiin/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/skills/artifact-template-analytics-dashboard/assets/reference.xlsx)
- [보존된 미리보기](/Users/jiin/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/skills/artifact-template-analytics-dashboard/assets/preview.png)
- [템플릿 설정](/Users/jiin/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/skills/artifact-template-analytics-dashboard/artifact-template.json)

설정, XLSX의 시트·스타일·차트 구조, 제공된 preview.png를 확인했습니다. 시트는 Dashboard, Data & Targets, 숨겨진 _Chart Helpers이며 차트는 4개입니다. 제공 미리보기에는 상단 기간·최신 데이터 시점, 2행의 지표, 중간 차트, 하단 비교 표가 있습니다. 색상은 짙은 남색 계열, 밝은 숫자, 청록 강조이며 글꼴은 Arial입니다. 원본 수치는 템플릿의 합성 웹 분석 예시입니다.

| 참고할 구조 | 미트박스 데모로 바꾸는 방식 | 가져오지 않을 내용 |
|---|---|---|
| 상단 기간과 최신 데이터 시점 | 기준일·시나리오 시각·마지막 확인 | 실제 실시간 연결 표시 |
| 일관된 숫자 요약 블록 | 전체/배송 중/완료 등 합성 건수 표본 | 웹 사용자·매출·전환율 수치 |
| 요약 뒤 상세 비교 | 현재 상태·ETA 목록에서 상세 이력으로 이동 | 분모가 없는 달성률 |
| 현재 값과 비교 기준을 나란히 배치 | 이전·현재 ETA와 변화 원인 | 실제 성능으로 보이는 합성 시계열 |

사용자는 웹 UI 조사와 준비 문서만 요청했습니다. 따라서 이번에는 템플릿을 **정보 배치의 레퍼런스**로 활용했고, 스프레드시트를 복제·작성하지 않았습니다. 전체 어두운 테마보다 R1의 밝은 화면을 우선하는 것은 명시적인 디자인 제안입니다. 웹 구현이 원본 스프레드시트의 충실한 복제물이라고 주장하지 않습니다.

## R3 Carbon Data table

- 공식 출처: [Data table usage](https://carbondesignsystem.com/components/data-table/usage/)
- 근거: 검색·필터·정렬을 가진 테이블, 보조 정보의 행 확장, 밀도 높은 목록에 충분한 폭을 주는 가이드.
- 적용 제안: 운영 배송 목록을 주 영역에 두고, ETA 변경 이력은 선택한 배송의 상세에서 확인합니다. 미리보기 때문에 목록을 작은 카드 안에 압축하지 않습니다.
- 경계: Carbon 패키지·디자인 테마를 채택한 것은 아닙니다. 기능 전체를 데모 범위로 가져오지 않습니다.

## R4 Carbon Status indicators

- 공식 출처: [Status indicators](https://carbondesignsystem.com/patterns/status-indicator-pattern/)
- 근거: 상태의 의미를 색뿐 아니라 레이블·도형·아이콘으로 전달하는 패턴.
- 적용 제안: 배송 단계와 ETA 상태를 별도 표시하며, 변화량은 숫자와 “늦어짐/앞당겨짐”으로 설명합니다. 브랜드 강조색을 모든 경고에 공통 적용하지 않습니다.
- 경계: 원문 배송 상태를 Carbon의 일반 상태 목록으로 치환하지 않습니다. 상태 정의는 도메인 문서를 따릅니다.

## R5 W3C 상태 변경 접근성

- 공식 출처: [Understanding SC 4.1.3 Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html)
- 근거: 화면의 상태 변경을 포커스 이동 없이 보조기술이 인식할 수 있게 하는 설명.
- 적용 제안: 선택 배송의 ETA가 바뀌면 주문 문맥, 이전·현재 시간 범위, 변경 사유를 함께 알립니다. 모든 행의 갱신을 반복적인 강한 경고로 만들지 않습니다.
- 경계: 이 링크는 WCAG의 해설 자료이며 구현 완료·준수 인증의 증거가 아닙니다.

## 남은 미확정 사항

회사 소개 후보인 [미트박스글로벌 채용·회사 사이트](https://meatbox.career.greetinghr.com/)는 조사 과정에서 직접 접근이 차단되어 시각 근거에서 제외했습니다. 공개 커머스와 공식 가이드로 이번 방향을 정하는 데 필요한 근거는 확보했습니다. 내부 TMS 화면, 공식 CI 가이드, 앱의 실제 배송조회 화면은 확인하지 않았습니다.

Carbon·W3C 링크는 조사일에 확인한 문서를 기준으로 하며, 현재 단계에서 라이브러리 버전은 선택하지 않습니다. best-practice-research의 조사 결과는 여기서 종료합니다. 사용자에게 이미 허용된 준비 문서만 작성했으며 구현 워크플로를 시작하지 않았습니다.

## 원본 보존 확인값

- 역할 문서 SHA-256: `8225354ebe2b8bbadf4801a88971f679c895719ebe36720a3c09f823d752cf9a`
- 템플릿 XLSX SHA-256: `ab655c867ea1c9eed617ec0eeec643946c1e49e9d5227e9db740c95daba26e46`
- 템플릿 preview.png SHA-256: `b5c458e744d46ef4211d167d3451864148853aa73708323068504da956ce03b3`

세 원본은 읽기 전용으로 취급했습니다. 기밀 RAW 링크·개인 연락처·메일 전문은 이 디렉토리에 복사하지 않았습니다.
