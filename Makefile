.DEFAULT_GOAL := check-new-stack

.PHONY: setup-new-stack check-new-stack check-release run-api run-web dev-web preview-web run-fork-fixture run-connected-fixture run-native-fixture check-api-connection package-new-stack

setup-new-stack:
	npm ci
	npm --prefix tools/oxlint/anti-slop ci
	npm --prefix apps/web ci
	./services/api/gradlew -p services/api --no-daemon classes

check-new-stack:
	./services/api/gradlew -p services/api --no-daemon check bootJar
	npm --prefix apps/web run check
	node --test test/web-fork-baseline.test.mjs test/web-fork-legacy/*.test.mjs

check-release: check-new-stack
	npm test
	node --test test/api-connection/*.test.mjs

run-api:
	./services/api/gradlew -p services/api --no-daemon bootRun

run-web:
	npm --prefix apps/web run build
	npm --prefix apps/web run serve:legacy

dev-web:
	npm --prefix apps/web run dev

preview-web:
	npm --prefix apps/web run serve:legacy

run-fork-fixture:
	npm --prefix apps/web run build
	node scripts/web-fork-fixture.mjs

run-connected-fixture:
	./services/api/gradlew -p services/api --no-daemon bootJar
	npm --prefix apps/web run build
	node scripts/web-fork-fixture.mjs --kotlin --resources

run-native-fixture:
	./services/api/gradlew -p services/api --no-daemon bootJar
	npm --prefix apps/web run build
	node scripts/web-fork-fixture.mjs --native

check-api-connection:
	./services/api/gradlew -p services/api --no-daemon check bootJar
	npm --prefix apps/web run build
	node --test test/api-connection/*.test.mjs

package-new-stack: check-release
	node scripts/package-new-stack.mjs --archive
