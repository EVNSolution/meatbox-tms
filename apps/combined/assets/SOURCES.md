# UI reference assets

이 디렉터리는 로컬 UI 레퍼런스에서 실제 브랜드 표현과 타이포그래피를 검토하기 위한 원본 자산을 보관합니다. 각 자산은 디자인 근거의 표본이며, 별도의 미트박스 CI/브랜드 가이드나 자산 사용 승인 문서를 대신하지 않습니다.

## Assets

### `meatbox-logo.svg`

- 출처: https://static-cdn.meatbox.co.kr/public/fstatic/icon/common/M_Logo.svg
- 역할: 미트박스 한국어 가로형 로고 레퍼런스
- 원본 속성: `105 × 25` viewBox, `#E60028`, `#212322`, white
- 처리: 원본 SVG를 변형 없이 저장
- SHA-256: `2231ec7d8b06a067285c554be3a9d11d16e302f64480f36e0079bd72cf71c088`

### `meatbox-app.webp`

- 출처: https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/72/bd/14/72bd1459-ca61-47e4-5eef-6a9ce060d9cd/Placeholder.mill/400x400bb-75.webp
- 역할: App Store에서 배포되는 미트박스 앱 아이콘 레퍼런스
- 원본 속성: `400 × 400`, WebP, RGB
- 처리: 원본 이미지를 변형 없이 저장
- SHA-256: `9e15812f416651aa6e9a2152c989adb3b4b69130d70db882f37c5a75a8cdeb2c`

### `PretendardVariable.ttf`

- 출처: 로컬 설치 파일 `/Users/jiin/Library/Fonts/PretendardVariable.ttf`
- 역할: 로컬 UI 레퍼런스의 self-hosted 한국어 UI 서체
- 폰트 메타데이터: Pretendard Variable, Version 1.309, Copyright © 2023 Kil Hyung-jin
- 라이선스: SIL Open Font License 1.1 (`OFL-1.1.txt`)
- 처리: 원본 TTF를 byte-for-byte 복사. 현재 환경에 `fontTools`와 Brotli가 없어 WOFF2 변환은 수행하지 않음
- SHA-256: `3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22`

## Usage boundary

로고, 앱 아이콘, 폰트는 서로 다른 역할의 레퍼런스입니다. 이 파일들에서 관측한 색, 형태, 굵기를 전사 디자인 토큰이나 공식 브랜드 규정으로 확대 해석하지 않습니다.

## Component icons

- Module: `../reference-icons.mjs`
- Source: https://www.meatbox.co.kr/ (live DOM observed 2026-09-14)
- Eight SVG geometries: search, location, truck, bell, user, support, close, next.
- Original viewBox and path geometry preserved. Monochrome fills use `currentColor` for size/color specimens; hidden from the accessibility tree when paired with button text or a separate accessible label.
- Shape names describe the local specimen; original navigation placement does not establish TMS routing semantics.
