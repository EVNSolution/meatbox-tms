# Push Lab UI assets

The isolated Push Lab pages reuse the byte-identical official UI reference assets already held in `apps/combined/assets/`. This provenance document is outside the HTTP-served `services/push-lab/public/` directory.

| Public asset | Reference and provenance | SHA-256 |
| --- | --- | --- |
| `assets/meatbox-logo.svg` | Original Meatbox horizontal logo, [Meatbox CDN](https://static-cdn.meatbox.co.kr/public/fstatic/icon/common/M_Logo.svg). | `2231ec7d8b06a067285c554be3a9d11d16e302f64480f36e0079bd72cf71c088` |
| `assets/PretendardVariable.ttf` | Pretendard Variable 1.309, copied without modification from the combined demo's reference asset. | `3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22` |

Pretendard is distributed under SIL Open Font License 1.1. The included `assets/OFL-1.1.txt` retains its license notice; see also the [upstream full license](https://github.com/orioncactus/pretendard/blob/main/LICENSE). These assets are local UI references and do not establish a separate company-wide brand-use grant.

WOFF2 conversion was not performed: the installed toolchain contains neither a WOFF2 encoder nor fontTools with Brotli. No new package or external font host was introduced.
