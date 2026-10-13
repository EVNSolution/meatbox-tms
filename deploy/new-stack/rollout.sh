#!/bin/sh
# Blue/green rollout on one TEST host. The candidate starts in the idle slot, proves
# health end to end, Caddy switches traffic in one reload, then the old slot stops.
# Sessions persist in /var/lib/meatbox-demo/sessions.json, so users stay signed in.
set -eu

validate_rollout_revisions() {
  release_source=$1
  old_current=$2
  expected_current_revision=$3

  candidate_revision=$(sed -n '1p' "$release_source/REVISION")
  case "$candidate_revision" in
    *[!0-9a-f]*|'') echo "candidate revision must be a lowercase Git SHA" >&2; return 65 ;;
  esac
  test "${#candidate_revision}" -eq 40 || { echo "candidate revision must be a lowercase Git SHA" >&2; return 65; }
  manifest_revision=$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{40}$/.test(manifest.git?.head)) process.exit(2);
    process.stdout.write(manifest.git.head);
  ' "$release_source/MANIFEST.json") || { echo "manifest git.head must be a lowercase Git SHA" >&2; return 65; }
  test "$candidate_revision" = "$manifest_revision" || {
    echo "candidate revision does not match manifest git.head" >&2
    return 65
  }
  test -r "$old_current/REVISION" || { echo "current legacy REVISION is missing" >&2; return 66; }
  active_revision=$(sed -n '1p' "$old_current/REVISION")
  test "$active_revision" = "$expected_current_revision" || { echo "active legacy revision changed" >&2; return 65; }
}
# END_VALIDATE_ROLLOUT_REVISIONS

acquire_release_lock() {
  lock_file=$1
  command -v flock >/dev/null 2>&1 || { echo "flock is required for release operations" >&2; return 69; }
  exec 9>"$lock_file"
  flock -n 9 || { echo "another release operation is in progress" >&2; return 75; }
}
# END_ACQUIRE_RELEASE_LOCK

validate_active_release() {
  new_current=$1
  new_releases=$2
  mode_file=$3
  expected_active_deployment=$4

  ACTIVE_RELEASE_TARGET=none
  ACTIVE_DEPLOYMENT=none
  if [ -L "$new_current" ]; then
    test -n "$expected_active_deployment" || {
      echo "existing deployment requires EXPECTED_ACTIVE_DEPLOYMENT" >&2
      return 64
    }
    test "$expected_active_deployment" != none || { echo "active new-stack release exists" >&2; return 65; }
    case "$expected_active_deployment" in
      connected:*|native:*) ;;
      *) echo "expected active deployment is invalid" >&2; return 64 ;;
    esac
    expected_active_mode=${expected_active_deployment%%:*}
    expected_active_release_id=${expected_active_deployment#*:}
    printf '%s\n' "$expected_active_release_id" | grep -Eq '^[0-9a-f]{12}-[0-9a-f]{16}$' || {
      echo "expected active deployment is invalid" >&2
      return 64
    }
    active_release=$(cd "$new_current" 2>/dev/null && pwd -P) || {
      echo "active new-stack link target is missing" >&2
      return 66
    }
    expected_release=$new_releases/$expected_active_release_id
    test "$active_release" = "$expected_release" || { echo "active new-stack target changed" >&2; return 65; }
    test -x "$active_release/tools/package-new-stack.mjs" || { echo "active release verifier is missing" >&2; return 66; }
    node "$active_release/tools/package-new-stack.mjs" --verify-installed "$active_release"
    active_release_id=$(node -e '
      const fs = require("fs");
      const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (!/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(manifest.releaseId)) process.exit(2);
      process.stdout.write(manifest.releaseId);
    ' "$active_release/MANIFEST.json") || { echo "active release manifest is invalid" >&2; return 65; }
    test "$active_release_id" = "$expected_active_release_id" || { echo "active release changed" >&2; return 65; }
    test -f "$mode_file" && test ! -L "$mode_file" || { echo "deployment mode is missing or unsafe" >&2; return 66; }
    active_mode=$(sed -n '1p' "$mode_file")
    test "$active_mode" = "$expected_active_mode $expected_active_release_id" || {
      echo "deployment mode does not match expected active deployment" >&2
      return 65
    }
    ACTIVE_RELEASE_TARGET=$active_release
    ACTIVE_DEPLOYMENT=$expected_active_deployment
  elif [ -e "$new_current" ]; then
    echo "new-stack current path exists but is not a symlink" >&2
    return 65
  else
    case "$expected_active_deployment" in
      ''|none) ;;
      *) echo "expected active release is not installed" >&2; return 65 ;;
    esac
    test ! -e "$mode_file" && test ! -L "$mode_file" \
      || { echo "deployment mode exists without an active release" >&2; return 65; }
  fi
}
# END_VALIDATE_ACTIVE_RELEASE

slot_web_port() { case "$1" in blue) echo 4173 ;; green) echo 4174 ;; *) return 64 ;; esac; }
slot_api_port() { case "$1" in blue) echo 8081 ;; green) echo 8082 ;; *) return 64 ;; esac; }
# END_SLOT_PORTS

# Determines which slot serves traffic now and which one receives the candidate.
# "legacy" means the pre-slot fixed units (meatbox-api.service/meatbox-web.service) on blue ports.
resolve_slots() {
  caddy_file=$1
  active_slot_file=$2

  fallback_count=$(grep -Ec '^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:(4173|4174)[[:space:]]*$' "$caddy_file" || true)
  test "$fallback_count" -eq 1 || { echo "expected exactly one web fallback in Caddy configuration" >&2; return 65; }
  CURRENT_WEB_PORT=$(grep -E '^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:(4173|4174)[[:space:]]*$' "$caddy_file" \
    | sed -E 's/.*127\.0\.0\.1:([0-9]+).*/\1/')
  if [ -e "$active_slot_file" ]; then
    test -f "$active_slot_file" && test ! -L "$active_slot_file" || { echo "active slot file is unsafe" >&2; return 65; }
    ACTIVE_SLOT=$(sed -n '1p' "$active_slot_file")
    case "$ACTIVE_SLOT" in blue|green) ;; *) echo "active slot file is invalid" >&2; return 65 ;; esac
    test "$(slot_web_port "$ACTIVE_SLOT")" = "$CURRENT_WEB_PORT" || {
      echo "Caddy fallback does not match the active slot" >&2
      return 65
    }
  else
    ACTIVE_SLOT=legacy
    test "$CURRENT_WEB_PORT" = 4173 || { echo "legacy deployment must serve on 4173" >&2; return 65; }
  fi
  case "$ACTIVE_SLOT" in blue) TARGET_SLOT=green ;; *) TARGET_SLOT=blue ;; esac
  if [ "$ACTIVE_SLOT" = legacy ]; then TARGET_SLOT=green; fi
  TARGET_WEB_PORT=$(slot_web_port "$TARGET_SLOT")
  TARGET_API_PORT=$(slot_api_port "$TARGET_SLOT")
}
# END_RESOLVE_SLOTS

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 VERIFIED_RELEASE_DIR EXPECTED_LEGACY_REVISION [native] [EXPECTED_ACTIVE_DEPLOYMENT|none]" >&2
  exit 64
fi

SCRIPT_DIRECTORY=$(cd "$(dirname "$0")" && pwd -P)
RELEASE_SOURCE=$(cd "$1" && pwd -P)
EXPECTED_CURRENT_REVISION=$2
MODE=${3:-native}
EXPECTED_ACTIVE_DEPLOYMENT=${4-}
test "$MODE" = native || { echo "only native mode is deployable; connected mode is retired" >&2; exit 64; }
case "$EXPECTED_CURRENT_REVISION" in
  *[!0-9a-f]*|'') echo "expected revision must be a lowercase Git SHA" >&2; exit 64 ;;
esac
test "${#EXPECTED_CURRENT_REVISION}" -eq 40 || { echo "expected revision must be a lowercase Git SHA" >&2; exit 64; }

OLD_CURRENT=/opt/meatbox-demo/current
NEW_ROOT=/opt/meatbox-tms
NEW_RELEASES=$NEW_ROOT/releases
NEW_CURRENT=$NEW_ROOT/current
SLOTS_ROOT=$NEW_ROOT/slots
STATE_ROOT=/var/lib/meatbox-demo
SYSTEMD_ROOT=/etc/systemd/system
ENV_ROOT=/etc/meatbox-tms
API_ENV=$ENV_ROOT/api.env
WEB_ENV=$ENV_ROOT/web.env
OWNERS_ENV=$ENV_ROOT/owners.env
MODE_FILE=$ENV_ROOT/deployment-mode
ACTIVE_SLOT_FILE=$ENV_ROOT/active-slot
PUSH_ENV=/etc/meatbox-push-lab/push-lab-web.env
PUSH_WEB_SERVICE=meatbox-push-lab-web.service
CADDY_FILE=/etc/caddy/Caddyfile
BACKUP_ROOT=/var/backups/meatbox-tms
LOCK_FILE=/run/lock/meatbox-tms-release.lock
BACKUP_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
BACKUP_DIR=$BACKUP_ROOT/$BACKUP_ID
DATASET_ROOT=/opt/meatbox-demo/datasets/0b7107924f0ce822a95125c4b7eb0c1498fc4ea7f066e76ce951bcdac1ed7005

test "$(id -u)" -eq 0 || { echo "rollout must run as root" >&2; exit 77; }
acquire_release_lock "$LOCK_FILE"
test -f "$RELEASE_SOURCE/MANIFEST.json" || { echo "release manifest is missing" >&2; exit 66; }
test -x "$RELEASE_SOURCE/tools/package-new-stack.mjs" || { echo "release verifier is missing" >&2; exit 66; }
RELEASE_ID=$(node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(m.releaseId))process.exit(2);process.stdout.write(m.releaseId)' "$RELEASE_SOURCE/MANIFEST.json")
TARGET_RELEASE=$NEW_RELEASES/$RELEASE_ID
if [ -d "$TARGET_RELEASE" ] && [ "$RELEASE_SOURCE" = "$(cd "$TARGET_RELEASE" && pwd -P)" ]; then
  node "$RELEASE_SOURCE/tools/package-new-stack.mjs" --verify-installed "$RELEASE_SOURCE"
else
  node "$RELEASE_SOURCE/tools/package-new-stack.mjs" --verify "$RELEASE_SOURCE"
fi
validate_active_release "$NEW_CURRENT" "$NEW_RELEASES" "$MODE_FILE" "$EXPECTED_ACTIVE_DEPLOYMENT"
PREVIOUS_RELEASE_TARGET=$ACTIVE_RELEASE_TARGET
PREVIOUS_DEPLOYMENT=$ACTIVE_DEPLOYMENT
if [ "$ACTIVE_RELEASE_TARGET" = "$TARGET_RELEASE" ] && [ "$ACTIVE_DEPLOYMENT" = "native:$RELEASE_ID" ]; then
  echo "native release is already active: $RELEASE_ID" >&2
  exit 75
fi
case "$PREVIOUS_DEPLOYMENT" in
  connected:*) echo "connected deployments are retired; restore a native backup first" >&2; exit 65 ;;
esac

validate_rollout_revisions "$RELEASE_SOURCE" "$OLD_CURRENT" "$EXPECTED_CURRENT_REVISION"
test -f "$CADDY_FILE" || { echo "Caddy configuration is missing" >&2; exit 66; }
if grep -q 'push-lab' "$CADDY_FILE"; then
  grep -q '127\.0\.0\.1:3300' "$CADDY_FILE" || { echo "push-lab handler target is not preserved" >&2; exit 65; }
fi
resolve_slots "$CADDY_FILE" "$ACTIVE_SLOT_FILE"
test -f "$STATE_ROOT/access.json" || { echo "account file is missing" >&2; exit 66; }
test -d "$STATE_ROOT/dispatch-state" || { echo "dispatch checkpoint directory is missing" >&2; exit 66; }
test -f "$STATE_ROOT/resources/resources.sqlite" || { echo "resource database is missing" >&2; exit 66; }
test -d "$DATASET_ROOT" || { echo "canonical dispatch dataset is missing" >&2; exit 66; }
test -f "$API_ENV" || { echo "native mode requires the reviewed existing api.env public origin" >&2; exit 66; }

# Reviewed deploy tools: the release ships them; a rollback of an older release uses this script's own directory.
TOOLS_DIR=$RELEASE_SOURCE/deploy/new-stack
test -f "$TOOLS_DIR/meatbox-api@.service" || TOOLS_DIR=$SCRIPT_DIRECTORY
for tool in meatbox-api@.service meatbox-web@.service configure-mode.mjs configure-push-session-url.mjs; do
  test -f "$TOOLS_DIR/$tool" || { echo "reviewed deploy tool is missing: $tool" >&2; exit 66; }
done

mkdir -p "$NEW_RELEASES" "$SLOTS_ROOT" "$BACKUP_ROOT"
chmod 0755 "$NEW_ROOT" "$NEW_RELEASES" "$SLOTS_ROOT"
chmod 0700 "$BACKUP_ROOT"
if [ -e "$TARGET_RELEASE" ]; then
  test -d "$TARGET_RELEASE" || { echo "immutable release target is not a directory" >&2; exit 73; }
  node "$TARGET_RELEASE/tools/package-new-stack.mjs" --verify-installed "$TARGET_RELEASE"
  cmp "$RELEASE_SOURCE/MANIFEST.json" "$TARGET_RELEASE/MANIFEST.json"
else
  cp -a "$RELEASE_SOURCE" "$TARGET_RELEASE"
  chmod -R a+rX "$TARGET_RELEASE"
  node "$TARGET_RELEASE/tools/package-new-stack.mjs" --verify "$TARGET_RELEASE"
fi

# Backup while the old slot still serves. Every business file is written by atomic rename, and the
# SQLite copy is a consistent VACUUM INTO snapshot, so no writer has to stop for the backup.
mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/data/resources"
chmod 0700 "$BACKUP_DIR" "$BACKUP_DIR/config" "$BACKUP_DIR/data" "$BACKUP_DIR/data/resources"
cp -a "$CADDY_FILE" "$BACKUP_DIR/config/Caddyfile"
cp -a "$OLD_CURRENT/REVISION" "$BACKUP_DIR/config/legacy.REVISION"
readlink -f "$OLD_CURRENT" > "$BACKUP_DIR/config/legacy-current.txt"
if [ -L "$NEW_CURRENT" ]; then readlink "$NEW_CURRENT" > "$BACKUP_DIR/config/new-current-link.txt"; fi
printf '%s\n' "$ACTIVE_SLOT" > "$BACKUP_DIR/config/active-slot-before"
for file in "$API_ENV" "$WEB_ENV" "$OWNERS_ENV" "$MODE_FILE" "$ACTIVE_SLOT_FILE"; do
  if [ -e "$file" ]; then cp -a "$file" "$BACKUP_DIR/config/$(basename "$file")"; fi
done
PUSH_ENV_PRESENT=0
PUSH_WAS_ACTIVE=inactive
if [ -e "$PUSH_ENV" ]; then
  test -f "$PUSH_ENV" && test ! -L "$PUSH_ENV" || { echo "push-lab env must be a regular file" >&2; exit 65; }
  PUSH_ENV_PRESENT=1
  cp -a "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"
  chmod 0600 "$BACKUP_DIR/config/push-lab-web.env"
  PUSH_WAS_ACTIVE=$(systemctl is-active "$PUSH_WEB_SERVICE" || true)
fi
cp -a "$STATE_ROOT/access.json" "$BACKUP_DIR/data/access.json"
cp -a "$STATE_ROOT/dispatch-state" "$BACKUP_DIR/data/dispatch-state"
if [ -f "$STATE_ROOT/sessions.json" ]; then cp -a "$STATE_ROOT/sessions.json" "$BACKUP_DIR/data/sessions.json"; fi
node -e '
  const {DatabaseSync}=require("node:sqlite");
  const [source, target]=process.argv.slice(1);
  const db=new DatabaseSync(source,{readOnly:true});
  try { db.prepare("VACUUM INTO ?").run(target); } finally { db.close(); }
  const copy=new DatabaseSync(target,{readOnly:true});
  try {
    const version=copy.prepare("PRAGMA user_version").get().user_version;
    const integrity=copy.prepare("PRAGMA integrity_check").get().integrity_check;
    if (version !== 2 || integrity !== "ok") process.exit(2);
  } finally { copy.close(); }
' "$STATE_ROOT/resources/resources.sqlite" "$BACKUP_DIR/data/resources/resources.sqlite"
find "$BACKUP_DIR/data" -type d -exec chmod 0700 {} +
find "$BACKUP_DIR/data" -type f -exec chmod 0600 {} +
find "$BACKUP_DIR/data" -type f -exec sha256sum -- {} + > "$BACKUP_DIR/config/data.SHA256SUMS"
install -m 0600 "$BACKUP_DIR/config/data.SHA256SUMS" "$BACKUP_DIR/data/SHA256SUMS"
rm -f "$BACKUP_DIR/config/data.SHA256SUMS"
(
  cd "$BACKUP_DIR/data"
  sha256sum -c SHA256SUMS >/dev/null
)

CONFIG_CANDIDATE=$BACKUP_DIR/config/candidate
WEB_INPUT=$WEB_ENV
OWNERS_INPUT=$OWNERS_ENV
if [ ! -f "$WEB_INPUT" ]; then WEB_INPUT=$TARGET_RELEASE/deploy/new-stack/web.env.example; fi
if [ ! -f "$OWNERS_INPUT" ]; then OWNERS_INPUT=$TARGET_RELEASE/deploy/new-stack/owners.env.example; fi
node "$TOOLS_DIR/configure-mode.mjs" native "$API_ENV" "$WEB_INPUT" "$OWNERS_INPUT" "$CONFIG_CANDIDATE"
if [ "$PUSH_ENV_PRESENT" -eq 1 ]; then
  node "$TOOLS_DIR/configure-push-session-url.mjs" \
    "$BACKUP_DIR/config/push-lab-web.env" "$BACKUP_DIR/config/push-lab-web.env.candidate" "$TARGET_API_PORT"
fi
for slot in blue green; do
  printf 'SERVER_PORT=%s\nMEATBOX_LEGACY_GATEWAY_PORT=%s\nMEATBOX_KOTLIN_API_ORIGIN=http://127.0.0.1:%s\n' \
    "$(slot_api_port "$slot")" "$(slot_web_port "$slot")" "$(slot_api_port "$slot")" > "$BACKUP_DIR/config/candidate/slot-$slot.env"
  chmod 0600 "$BACKUP_DIR/config/candidate/slot-$slot.env"
done
sed "s/^\([[:space:]]*\)reverse_proxy[[:space:]]\+127\.0\.0\.1:${CURRENT_WEB_PORT}[[:space:]]*$/\1reverse_proxy 127.0.0.1:$TARGET_WEB_PORT/" \
  "$CADDY_FILE" > "$BACKUP_DIR/config/Caddyfile.candidate"
test "$(grep -Ec "^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:${TARGET_WEB_PORT}[[:space:]]*$" "$BACKUP_DIR/config/Caddyfile.candidate")" -eq 1
if grep -q 'push-lab' "$CADDY_FILE"; then
  test "$(grep -c '127\.0\.0\.1:3300' "$CADDY_FILE")" = "$(grep -c '127\.0\.0\.1:3300' "$BACKUP_DIR/config/Caddyfile.candidate")"
fi
caddy validate --config "$BACKUP_DIR/config/Caddyfile.candidate"

wait_http() {
  url=$1
  attempts=$2
  attempt=0
  until curl --fail --silent --show-error --output /dev/null "$url"; do
    attempt=$((attempt + 1)); [ "$attempt" -lt "$attempts" ] || return 1; sleep 1
  done
}

start_old_slot() {
  if [ "$ACTIVE_SLOT" = legacy ]; then
    systemctl start meatbox-api.service meatbox-web.service
  else
    systemctl start "meatbox-api@$ACTIVE_SLOT.service" "meatbox-web@$ACTIVE_SLOT.service"
  fi
}
stop_old_slot() {
  if [ "$ACTIVE_SLOT" = legacy ]; then
    systemctl stop meatbox-web.service 2>/dev/null || true
    systemctl stop meatbox-api.service 2>/dev/null || true
  else
    systemctl stop "meatbox-web@$ACTIVE_SLOT.service" 2>/dev/null || true
    systemctl stop "meatbox-api@$ACTIVE_SLOT.service" 2>/dev/null || true
  fi
}

MUTATED=0
CADDY_SWITCHED=0
OLD_STOPPED=0
PUSH_MUTATED=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$MUTATED" -eq 1 ]; then
    # Reverse order of the cutover: config back, old slot serving, candidate slot gone.
    for name in api.env web.env owners.env; do
      if [ -f "$BACKUP_DIR/config/$name" ]; then cp -a "$BACKUP_DIR/config/$name" "$ENV_ROOT/$name"; else rm -f "$ENV_ROOT/$name"; fi
    done
    if [ "$OLD_STOPPED" -eq 1 ]; then
      start_old_slot
      wait_http "http://127.0.0.1:$CURRENT_WEB_PORT/login" 60
    fi
    if [ "$CADDY_SWITCHED" -eq 1 ]; then
      cp -a "$BACKUP_DIR/config/Caddyfile" "$CADDY_FILE.rollback"
      mv -f "$CADDY_FILE.rollback" "$CADDY_FILE"
      caddy validate --config "$CADDY_FILE" && systemctl reload caddy
    fi
    if [ "$PUSH_MUTATED" -eq 1 ]; then
      install -m 0600 "$BACKUP_DIR/config/push-lab-web.env" "$PUSH_ENV"
      if [ "$PUSH_WAS_ACTIVE" = active ]; then systemctl restart "$PUSH_WEB_SERVICE"; fi
    fi
    systemctl stop "meatbox-web@$TARGET_SLOT.service" "meatbox-api@$TARGET_SLOT.service"
    systemctl disable "meatbox-web@$TARGET_SLOT.service" "meatbox-api@$TARGET_SLOT.service" 2>/dev/null
    if [ "$PREVIOUS_RELEASE_TARGET" != none ]; then
      ln -s "$PREVIOUS_RELEASE_TARGET" "$NEW_CURRENT.rollback"
      mv -Tf "$NEW_CURRENT.rollback" "$NEW_CURRENT"
    fi
    for name in deployment-mode active-slot; do
      if [ -f "$BACKUP_DIR/config/$name" ]; then install -m 0600 "$BACKUP_DIR/config/$name" "$ENV_ROOT/$name"; else rm -f "$ENV_ROOT/$name"; fi
    done
    echo "rollout failed; the previous slot serves again and live data was retained at $STATE_ROOT" >&2
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM

MUTATED=1
mkdir -p "$ENV_ROOT"
chmod 0700 "$ENV_ROOT"
install -m 0600 "$CONFIG_CANDIDATE/api.env" "$API_ENV"
install -m 0600 "$CONFIG_CANDIDATE/web.env" "$WEB_ENV"
install -m 0600 "$CONFIG_CANDIDATE/owners.env" "$OWNERS_ENV"
install -m 0600 "$CONFIG_CANDIDATE/slot-blue.env" "$ENV_ROOT/slot-blue.env"
install -m 0600 "$CONFIG_CANDIDATE/slot-green.env" "$ENV_ROOT/slot-green.env"
install -m 0644 "$TOOLS_DIR/meatbox-api@.service" "$SYSTEMD_ROOT/meatbox-api@.service"
install -m 0644 "$TOOLS_DIR/meatbox-web@.service" "$SYSTEMD_ROOT/meatbox-web@.service"
ln -s "$TARGET_RELEASE" "$SLOTS_ROOT/$TARGET_SLOT.next"
mv -Tf "$SLOTS_ROOT/$TARGET_SLOT.next" "$SLOTS_ROOT/$TARGET_SLOT"
systemctl daemon-reload

# 1. Start the candidate in the idle slot and prove it end to end before any traffic reaches it.
systemctl stop "meatbox-web@$TARGET_SLOT.service" "meatbox-api@$TARGET_SLOT.service" 2>/dev/null || true
systemctl start "meatbox-api@$TARGET_SLOT.service"
wait_http "http://127.0.0.1:$TARGET_API_PORT/actuator/health" 90
systemctl start "meatbox-web@$TARGET_SLOT.service"
wait_http "http://127.0.0.1:$TARGET_WEB_PORT/login" 30

# 2. Switch traffic in one Caddy reload. New requests go to the candidate; in-flight requests finish.
install -m 0644 "$BACKUP_DIR/config/Caddyfile.candidate" "$CADDY_FILE.next"
mv -f "$CADDY_FILE.next" "$CADDY_FILE"
systemctl reload caddy
CADDY_SWITCHED=1
if [ "$PUSH_ENV_PRESENT" -eq 1 ]; then
  cmp "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"
  PUSH_MUTATED=1
  install -m 0600 "$BACKUP_DIR/config/push-lab-web.env.candidate" "$PUSH_ENV"
  if [ "$PUSH_WAS_ACTIVE" = active ]; then systemctl restart "$PUSH_WEB_SERVICE"; fi
fi

# 3. Drain and stop the old slot. Only after this is the candidate the single writer.
attempt=0
while [ "$(ss -Htn state established "( sport = :$CURRENT_WEB_PORT )" | wc -l)" -gt 0 ] && [ "$attempt" -lt 10 ]; do
  attempt=$((attempt + 1)); sleep 1
done
stop_old_slot
OLD_STOPPED=1

validate_active_release "$NEW_CURRENT" "$NEW_RELEASES" "$MODE_FILE" "$EXPECTED_ACTIVE_DEPLOYMENT"
ln -s "$TARGET_RELEASE" "$NEW_CURRENT.next"
mv -Tf "$NEW_CURRENT.next" "$NEW_CURRENT"
printf 'native %s\n' "$RELEASE_ID" > "$MODE_FILE.next"
chmod 0600 "$MODE_FILE.next"
mv -f "$MODE_FILE.next" "$MODE_FILE"
printf '%s\n' "$TARGET_SLOT" > "$ACTIVE_SLOT_FILE.next"
chmod 0600 "$ACTIVE_SLOT_FILE.next"
mv -f "$ACTIVE_SLOT_FILE.next" "$ACTIVE_SLOT_FILE"
if [ "$ACTIVE_SLOT" = legacy ]; then
  systemctl disable meatbox-api.service meatbox-web.service 2>/dev/null || true
else
  systemctl disable "meatbox-web@$ACTIVE_SLOT.service" "meatbox-api@$ACTIVE_SLOT.service"
fi
systemctl enable "meatbox-api@$TARGET_SLOT.service" "meatbox-web@$TARGET_SLOT.service"
systemctl is-active --quiet "meatbox-api@$TARGET_SLOT.service"
systemctl is-active --quiet "meatbox-web@$TARGET_SLOT.service"
test "$(systemctl is-active meatbox-gateway.service || true)" = inactive

MUTATED=0
trap - EXIT HUP INT TERM
printf 'rollout complete: release=%s slot=%s backup=%s\n' "$RELEASE_ID" "$TARGET_SLOT" "$BACKUP_DIR"
