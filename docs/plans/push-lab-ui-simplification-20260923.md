# Push Lab UI simplification (2026-09-23)

## Decision

- A valid same-origin one-time link opens the delivery immediately on every browser, including ordinary iPhone Safari. Scrub the fragment before exchange. A missing, invalid, consumed, or expired link asks for a new secure link; there is no install-first or code-paste detour.
- The customer page keeps one responsive delivery status, supplied ETA, seven stages, and optional notification consent. Remove the phone mockup, duplicate status/branding, empty product/location cards, and customer self-test countdown. Keep the existing Meatbox brand assets and colors.
- Unsupported browsers still show delivery and a short notification limitation. Only supported environments show usable consent and subscribe controls. Permission remains a direct click action. A server-saved subscription and real sender mode do not prove receipt on a device.
- Provider config failure cannot block delivery loading or polling. Preserve one-time exchange, CSRF, FID registration and revocation behavior.

## Regression lock before edit

- Add failing customer tests for immediate iPhone exchange, no install gate, same-origin parsing, unsupported control hiding, user-gesture permission, config failure isolation, and mock/denied truthfulness.
- Retain and rerun session teardown, security exchange, provider-registration, and probe tests.

## Verification

- Run focused customer and security tests, then the push-lab suite. Check JavaScript syntax and diff whitespace. Inspect 320px, 390px and desktop layout through the approved browser UI path. Actual phone receipt remains a separate unverified gate.
