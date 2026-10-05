# Meatbox single frontend module

`apps/web/` is the only maintained frontend package. Vite builds four HTML entries: the operator workspace (`combined/index.html`), the reference guide (`ui-layout/index.html`), login, and registration. `/portal-auth.js` remains an independent TypeScript authentication bundle.

The operator workspace owns its header and navigation in `combined/app.mjs`. Its three routes are dispatch planning, delivery control, and resource management. The guide documents the current controls and tokens; it is not a scenario runner or a second product UI.

Kotlin owns authentication, sessions, the four source reads, the resource registry, and dated dispatch state and commands in native mode. The Node gateway serves the built files and forwards `/api` requests to the selected owner. It does not supply product state or fall back to another writer after an owner failure.

From the repository root:

```sh
make setup-new-stack
make check-new-stack
make run-fork-fixture
make check-api-connection
make run-connected-fixture
make run-native-fixture
```

`make dev-web` runs Vite at `http://127.0.0.1:5173`. Its only application proxy prefix is `/api`; scenario API and simulation WebSocket proxies have been removed. Use the protected gateway, rather than raw Vite preview, to validate login, session, Origin, protected assets, and API ownership.

The gateway serves `/combined/`, `/ui-layout/`, `/login`, and `/dev/register`. Retired scenario, customer, driver, presentation, combined demo, and `/ws/simulation` paths return 410 in every ownership mode. Unknown `/api` paths return 404 and a selected Kotlin outage returns 503 without Node fallback.

`public/` contains only the fixed-path theme and portal authentication assets. A Vite `public/` directory is a copy convention, not an authorization policy: the gateway exposes only its exact unauthenticated allowlist and protects operational files with the current session owner.

## Maintenance map

| Responsibility | Owner |
| --- | --- |
| Build entries and development API routing | [`vite.config.mjs`](vite.config.mjs), [`scripts/api-routing.mjs`](scripts/api-routing.mjs) |
| Protected static gateway and retired-route boundary | [`scripts/legacy-gateway.mjs`](scripts/legacy-gateway.mjs) |
| Operator shell, header, and navigation | [`combined/app.mjs`](combined/app.mjs), [`combined/index.html`](combined/index.html) |
| Dispatch planning and dated source loading | `combined/dated-dispatch.mjs`, `combined/order-planning.mjs`, `combined/source-client.mjs` |
| Delivery control | `combined/vehicle-control.mjs` and its adjacent models |
| Resource management | `combined/resource-management.mjs`, `combined/resource-client.mjs` |
| Reused date and workflow controls | `combined/date-picker.mjs`, `combined/date-summary-toolbar.mjs`, `combined/dispatch-workflow.mjs` |
| Reference-only design guide | `ui-layout/app.mjs`, `ui-layout/design-guide.mjs`, `ui-layout/design-guide.css` |
| Authentication boundary | `src/auth.ts`, `src/auth-contract.ts`, login/registration HTML, `public/portal.css` |
| Shared visual foundation | [`public/theme.css`](public/theme.css) |

Keep pure calculations beside their consumers with colocated `.test.mjs` files. Browser clients use HTTP APIs only. Missing or invalid manifests must produce a visible error; they must not open a simulation channel or manufacture demo state. Maps use coordinates already present in the selected source. If the source has no usable coordinates, show the no-data state rather than fetching `/scenario/api` or inventing locations.

`combined/styles.css` and `ui-layout/styles.css` are ordered import lists. Preserve cascade order and keep page-specific rules beside their page. The operator and guide may share tokens and real reusable controls, but the guide must not become an alternate implementation.

`npm run check` runs strict TypeScript checking, Oxlint, the Vite build, package tests, and built-artifact checks. The root `make check-new-stack` adds Kotlin `check bootJar`, provenance checks, and compatibility tests. Run a focused test first, then the package and root checks appropriate to the change. UI changes also require browser verification at the affected routes and viewport sizes.

The provenance manifest keeps the initial fork history separately from the active tree. Its schema records the historical 142 source files, 163 mapped targets, and 21 authored files, plus each record's active/removed disposition and last known SHA. Do not reinterpret those historical totals as the current active-file count. See [the architecture decision](../../docs/new-stack-architecture.md), [development guide](../../docs/new-stack-development.md), [project structure guide](../../docs/project-structure.md), and [demo removal result](../../docs/demo-removal-result.md).

Build output is `apps/web/.runtime/dist/`. TEST currently uses the native Kotlin ownership mode described in [the Kotlin migration result](../../docs/kotlin-state-migration-result.md). QA and production promotion remain separate work.
