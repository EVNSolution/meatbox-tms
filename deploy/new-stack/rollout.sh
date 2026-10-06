#!/bin/sh
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

validate_rollout_transition() {
  case "$1:$2" in
    connected:native:*)
      echo "native to connected requires the reviewed rollback to restore Push Lab and service state" >&2
      return 65
      ;;
  esac
}
# END_VALIDATE_ROLLOUT_TRANSITION

acquire_release_lock() {
  lock_file=$1
  command -v flock >/dev/null 2>&1 || { echo "flock is required for release operations" >&2; return 69; }
  exec 9>"$lock_file"
  flock -n 9 || { echo "another release operation is in progress" >&2; return 75; }
}
# END_ACQUIRE_RELEASE_LOCK

validate_systemctl_state_file() {
  state_file=$1
  state_kind=$2
  test -f "$state_file" && test ! -L "$state_file" || {
    echo "rollback service state is missing or unsafe: $state_file" >&2
    return 66
  }
  test "$(awk 'END { print NR }' "$state_file")" -eq 1 || {
    echo "rollback service state must contain exactly one line: $state_file" >&2
    return 65
  }
  state_value=$(sed -n '1p' "$state_file")
  case "$state_kind:$state_value" in
    enabled:enabled|enabled:enabled-runtime|enabled:masked|enabled:masked-runtime|\
    enabled:static|enabled:indirect|enabled:disabled|enabled:not-found|\
    active:active|active:inactive|active:failed|active:not-found) ;;
    *) echo "rollback service state is invalid: $state_file" >&2; return 65 ;;
  esac
}
# END_VALIDATE_SYSTEMCTL_STATE_FILE

validate_rollback_state_files() {
  backup_config=$1
  push_web_service=$2
  for service in meatbox-gateway.service meatbox-api.service meatbox-web.service; do
    validate_systemctl_state_file "$backup_config/$service.enabled" enabled
    validate_systemctl_state_file "$backup_config/$service.active" active
  done
  push_marker=$backup_config/push-env-present
  push_env_backup=$backup_config/push-lab-web.env
  push_enabled_backup=$backup_config/$push_web_service.enabled
  push_active_backup=$backup_config/$push_web_service.active
  test -f "$push_marker" && test ! -L "$push_marker" || {
    echo "Push Lab presence marker is missing or unsafe" >&2
    return 66
  }
  test "$(awk 'END { print NR }' "$push_marker")" -eq 1 || {
    echo "Push Lab presence marker must contain exactly one line" >&2
    return 65
  }
  push_present=$(sed -n '1p' "$push_marker")
  case "$push_present" in 0|1) ;; *) echo "Push Lab presence marker is invalid" >&2; return 65 ;; esac
  if [ "$push_present" -eq 1 ]; then
    test -f "$push_env_backup" && test ! -L "$push_env_backup" || {
      echo "Push Lab environment backup is unsafe" >&2
      return 65
    }
    validate_systemctl_state_file "$push_enabled_backup" enabled
    validate_systemctl_state_file "$push_active_backup" active
  else
    for push_file in "$push_env_backup" "$push_enabled_backup" "$push_active_backup"; do
      test ! -e "$push_file" && test ! -L "$push_file" || {
        echo "Push Lab backup files conflict with absence marker" >&2
        return 65
      }
    done
  fi
}
# END_VALIDATE_ROLLBACK_STATE_FILES

validate_restore_config_files() {
  backup_config=$1
  restore_deployment=$2
  required_files=Caddyfile
  if [ "$restore_deployment" != none ]; then
    required_files="$required_files meatbox-api.service meatbox-web.service api.env web.env owners.env"
    case "$restore_deployment" in
      connected:*) required_files="$required_files 10-new-stack.conf" ;;
      native:*) ;;
      *) echo "restore deployment is invalid" >&2; return 65 ;;
    esac
  fi
  for filename in Caddyfile meatbox-api.service meatbox-web.service api.env web.env owners.env 10-new-stack.conf; do
    required=0
    case " $required_files " in *" $filename "*) required=1 ;; esac
    restore_file=$backup_config/$filename
    if [ "$required" -eq 1 ] || [ -e "$restore_file" ] || [ -L "$restore_file" ]; then
      test -f "$restore_file" && test ! -L "$restore_file" || {
        echo "restore configuration is missing or unsafe: $restore_file" >&2
        return 66
      }
    fi
  done
}
# END_VALIDATE_RESTORE_CONFIG_FILES

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

if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
  echo "usage: $0 VERIFIED_RELEASE_DIR EXPECTED_LEGACY_REVISION [connected|native] [EXPECTED_ACTIVE_DEPLOYMENT|none]" >&2
  exit 64
fi

RELEASE_SOURCE=$(cd "$1" && pwd -P)
EXPECTED_CURRENT_REVISION=$2
MODE=${3:-connected}
EXPECTED_ACTIVE_DEPLOYMENT=${4-}
case "$MODE" in connected|native) ;; *) echo "mode must be connected or native" >&2; exit 64 ;; esac
case "$EXPECTED_CURRENT_REVISION" in
  *[!0-9a-f]*|'') echo "expected revision must be a lowercase Git SHA" >&2; exit 64 ;;
esac
test "${#EXPECTED_CURRENT_REVISION}" -eq 40 || { echo "expected revision must be a lowercase Git SHA" >&2; exit 64; }

OLD_CURRENT=/opt/meatbox-demo/current
NEW_ROOT=/opt/meatbox-tms
NEW_RELEASES=$NEW_ROOT/releases
NEW_CURRENT=$NEW_ROOT/current
STATE_ROOT=/var/lib/meatbox-demo
SYSTEMD_ROOT=/etc/systemd/system
DROPIN_DIR=$SYSTEMD_ROOT/meatbox-gateway.service.d
DROPIN_FILE=$DROPIN_DIR/10-new-stack.conf
API_UNIT=$SYSTEMD_ROOT/meatbox-api.service
WEB_UNIT=$SYSTEMD_ROOT/meatbox-web.service
ENV_ROOT=/etc/meatbox-tms
API_ENV=$ENV_ROOT/api.env
WEB_ENV=$ENV_ROOT/web.env
OWNERS_ENV=$ENV_ROOT/owners.env
MODE_FILE=$ENV_ROOT/deployment-mode
PUSH_ENV=/etc/meatbox-push-lab/push-lab-web.env
PUSH_WEB_SERVICE=meatbox-push-lab-web.service
CADDY_FILE=/etc/caddy/Caddyfile
BACKUP_ROOT=/var/backups/meatbox-tms
LOCK_FILE=/run/lock/meatbox-tms-release.lock
BACKUP_ID=$(date -u +%Y%m%dT%H%M%SZ)-$$
BACKUP_DIR=$BACKUP_ROOT/$BACKUP_ID

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
validate_rollout_transition "$MODE" "$ACTIVE_DEPLOYMENT"
PREVIOUS_RELEASE_TARGET=$ACTIVE_RELEASE_TARGET
PREVIOUS_DEPLOYMENT=$ACTIVE_DEPLOYMENT
if [ "$MODE" = native ] && [ "$ACTIVE_RELEASE_TARGET" = "$TARGET_RELEASE" ] \
  && [ "$ACTIVE_DEPLOYMENT" = "native:$RELEASE_ID" ]; then
  echo "native release is already active: $RELEASE_ID" >&2
  exit 75
fi

validate_rollout_revisions "$RELEASE_SOURCE" "$OLD_CURRENT" "$EXPECTED_CURRENT_REVISION"
test -f "$CADDY_FILE" || { echo "Caddy configuration is missing" >&2; exit 66; }
FALLBACK_NODE_COUNT=$(grep -Ec '^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:3001[[:space:]]*$' "$CADDY_FILE" || true)
FALLBACK_WEB_COUNT=$(grep -Ec '^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:4173[[:space:]]*$' "$CADDY_FILE" || true)
test "$((FALLBACK_NODE_COUNT + FALLBACK_WEB_COUNT))" -eq 1 || {
  echo "expected exactly one Node or web fallback in Caddy configuration" >&2
  exit 65
}
if grep -q 'push-lab' "$CADDY_FILE"; then
  grep -q '127\.0\.0\.1:3300' "$CADDY_FILE" || { echo "push-lab handler target is not preserved" >&2; exit 65; }
fi
test -f "$STATE_ROOT/access.json" || { echo "account file is missing" >&2; exit 66; }
test -d "$STATE_ROOT/dispatch-state" || { echo "dispatch checkpoint directory is missing" >&2; exit 66; }
test -f "$STATE_ROOT/resources/resources.sqlite" || { echo "resource database is missing" >&2; exit 66; }
DATASET_ROOT=/opt/meatbox-demo/datasets/0b7107924f0ce822a95125c4b7eb0c1498fc4ea7f066e76ce951bcdac1ed7005
test -d "$DATASET_ROOT" || { echo "canonical dispatch dataset is missing" >&2; exit 66; }

mkdir -p "$NEW_RELEASES" "$BACKUP_ROOT"
chmod 0755 "$NEW_ROOT" "$NEW_RELEASES"
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

if [ "$MODE" = connected ]; then
  (
    cd "$TARGET_RELEASE/legacy"
    npm ci --omit=dev --ignore-scripts
  )
fi

mkdir -p "$BACKUP_DIR/config" "$BACKUP_DIR/data"
chmod 0700 "$BACKUP_DIR" "$BACKUP_DIR/config" "$BACKUP_DIR/data"
cp -a "$CADDY_FILE" "$BACKUP_DIR/config/Caddyfile"
cp -a "$OLD_CURRENT/REVISION" "$BACKUP_DIR/config/legacy.REVISION"
systemctl show meatbox-gateway.service --property=ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts,FragmentPath,DropInPaths > "$BACKUP_DIR/config/service-before.txt"
readlink -f "$OLD_CURRENT" > "$BACKUP_DIR/config/legacy-current.txt"
if [ -L "$NEW_CURRENT" ]; then
  readlink "$NEW_CURRENT" > "$BACKUP_DIR/config/new-current-link.txt"
elif [ -e "$NEW_CURRENT" ]; then
  echo "new-stack current path exists but is not a symlink" >&2
  exit 65
fi
for file in "$DROPIN_FILE" "$API_UNIT" "$WEB_UNIT" "$API_ENV" "$WEB_ENV" "$OWNERS_ENV" "$MODE_FILE"; do
  if [ -e "$file" ]; then cp -a "$file" "$BACKUP_DIR/config/$(basename "$file")"; fi
done
for service in meatbox-gateway.service meatbox-api.service meatbox-web.service; do
  systemctl is-enabled "$service" > "$BACKUP_DIR/config/$service.enabled" 2>/dev/null || true
  systemctl is-active "$service" > "$BACKUP_DIR/config/$service.active" 2>/dev/null || true
done

PUSH_ENV_PRESENT=0
if [ "$MODE" = native ] && [ -e "$PUSH_ENV" ]; then
  test -f "$PUSH_ENV" && test ! -L "$PUSH_ENV" || { echo "push-lab env must be a regular file" >&2; exit 65; }
  PUSH_ENV_PRESENT=1
  cp -a "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"
  chmod 0600 "$BACKUP_DIR/config/push-lab-web.env"
  systemctl is-enabled "$PUSH_WEB_SERVICE" > "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.enabled" 2>/dev/null || true
  systemctl is-active "$PUSH_WEB_SERVICE" > "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.active" 2>/dev/null || true
fi
printf '%s\n' "$PUSH_ENV_PRESENT" > "$BACKUP_DIR/config/push-env-present"
chmod 0600 "$BACKUP_DIR/config/push-env-present"

API_INPUT=$API_ENV
WEB_INPUT=$WEB_ENV
OWNERS_INPUT=$OWNERS_ENV
if [ "$MODE" = native ] && [ ! -f "$API_INPUT" ]; then
  echo "native mode requires the reviewed existing api.env public origin" >&2
  exit 66
fi
if [ ! -f "$API_INPUT" ]; then API_INPUT=$TARGET_RELEASE/deploy/new-stack/api.env.example; fi
if [ ! -f "$WEB_INPUT" ]; then WEB_INPUT=$TARGET_RELEASE/deploy/new-stack/web.env.example; fi
if [ ! -f "$OWNERS_INPUT" ]; then OWNERS_INPUT=$TARGET_RELEASE/deploy/new-stack/owners.env.example; fi
CONFIG_CANDIDATE=$BACKUP_DIR/config/candidate
node "$TARGET_RELEASE/deploy/new-stack/configure-mode.mjs" "$MODE" "$API_INPUT" "$WEB_INPUT" "$OWNERS_INPUT" "$CONFIG_CANDIDATE"
if [ "$PUSH_ENV_PRESENT" -eq 1 ]; then
  node "$TARGET_RELEASE/deploy/new-stack/configure-push-session-url.mjs" \
    "$BACKUP_DIR/config/push-lab-web.env" "$BACKUP_DIR/config/push-lab-web.env.candidate"
fi
validate_restore_config_files "$BACKUP_DIR/config" "$PREVIOUS_DEPLOYMENT"
validate_rollback_state_files "$BACKUP_DIR/config" "$PUSH_WEB_SERVICE"

MUTATED=0
PUSH_MUTATED=0
rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  if [ "$MUTATED" -eq 1 ]; then
    if [ "$PUSH_MUTATED" -eq 1 ]; then systemctl stop "$PUSH_WEB_SERVICE"; fi
    systemctl stop meatbox-api.service
    systemctl stop meatbox-web.service
    systemctl stop meatbox-gateway.service
    if [ -f "$BACKUP_DIR/config/10-new-stack.conf" ]; then
      mkdir -p "$DROPIN_DIR"
      cp -a "$BACKUP_DIR/config/10-new-stack.conf" "$DROPIN_FILE"
    else
      rm -f "$DROPIN_FILE"
    fi
    if [ -f "$BACKUP_DIR/config/meatbox-api.service" ]; then cp -a "$BACKUP_DIR/config/meatbox-api.service" "$API_UNIT"; else rm -f "$API_UNIT"; fi
    if [ -f "$BACKUP_DIR/config/meatbox-web.service" ]; then cp -a "$BACKUP_DIR/config/meatbox-web.service" "$WEB_UNIT"; else rm -f "$WEB_UNIT"; fi
    if [ "$PREVIOUS_RELEASE_TARGET" != none ]; then
      ln -s "$PREVIOUS_RELEASE_TARGET" "$NEW_CURRENT.rollback"
      mv -Tf "$NEW_CURRENT.rollback" "$NEW_CURRENT"
    else
      rm -f "$NEW_CURRENT"
    fi
    cp -a "$BACKUP_DIR/config/Caddyfile" "$CADDY_FILE.rollback"
    mv -f "$CADDY_FILE.rollback" "$CADDY_FILE"
    if [ -f "$BACKUP_DIR/config/api.env" ]; then cp -a "$BACKUP_DIR/config/api.env" "$API_ENV"; else rm -f "$API_ENV"; fi
    if [ -f "$BACKUP_DIR/config/web.env" ]; then cp -a "$BACKUP_DIR/config/web.env" "$WEB_ENV"; else rm -f "$WEB_ENV"; fi
    if [ -f "$BACKUP_DIR/config/owners.env" ]; then cp -a "$BACKUP_DIR/config/owners.env" "$OWNERS_ENV"; else rm -f "$OWNERS_ENV"; fi
    if [ "$PREVIOUS_DEPLOYMENT" != none ]; then
      previous_mode=${PREVIOUS_DEPLOYMENT%%:*}
      previous_release_id=${PREVIOUS_DEPLOYMENT#*:}
      printf '%s %s\n' "$previous_mode" "$previous_release_id" > "$MODE_FILE.rollback"
      chmod 0600 "$MODE_FILE.rollback"
      mv -f "$MODE_FILE.rollback" "$MODE_FILE"
    else
      rm -f "$MODE_FILE"
    fi
    if [ "$PUSH_MUTATED" -eq 1 ]; then install -m 0600 "$BACKUP_DIR/config/push-lab-web.env" "$PUSH_ENV"; fi
    systemctl daemon-reload
    for service in meatbox-gateway.service meatbox-api.service meatbox-web.service; do
      state=$(sed -n '1p' "$BACKUP_DIR/config/$service.enabled")
      case "$state" in
        enabled) systemctl enable "$service" ;;
        enabled-runtime) systemctl enable --runtime "$service" ;;
        masked) systemctl mask "$service" ;;
        masked-runtime) systemctl mask --runtime "$service" ;;
        *) systemctl disable "$service" 2>/dev/null || true ;;
      esac
    done
    if [ "$PUSH_MUTATED" -eq 1 ]; then
      state=$(sed -n '1p' "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.enabled")
      case "$state" in
        enabled) systemctl enable "$PUSH_WEB_SERVICE" ;;
        enabled-runtime) systemctl enable --runtime "$PUSH_WEB_SERVICE" ;;
        masked) systemctl mask "$PUSH_WEB_SERVICE" ;;
        masked-runtime) systemctl mask --runtime "$PUSH_WEB_SERVICE" ;;
        *) systemctl disable "$PUSH_WEB_SERVICE" 2>/dev/null || true ;;
      esac
    fi
    if [ "$(sed -n '1p' "$BACKUP_DIR/config/meatbox-gateway.service.active")" = active ]; then systemctl start meatbox-gateway.service; fi
    if [ "$(sed -n '1p' "$BACKUP_DIR/config/meatbox-api.service.active")" = active ]; then systemctl start meatbox-api.service; fi
    if [ "$(sed -n '1p' "$BACKUP_DIR/config/meatbox-web.service.active")" = active ]; then systemctl start meatbox-web.service; fi
    if [ "$PUSH_MUTATED" -eq 1 ] \
      && [ "$(sed -n '1p' "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.active")" = active ]; then
      systemctl start "$PUSH_WEB_SERVICE"
    fi
    caddy validate --config "$CADDY_FILE" && systemctl reload caddy
    echo "rollout failed; code and routing were rolled back, live data was retained at $STATE_ROOT" >&2
  fi
  exit "$status"
}
trap rollback EXIT HUP INT TERM

MUTATED=1
systemctl stop meatbox-web.service 2>/dev/null || true
systemctl stop meatbox-api.service 2>/dev/null || true
systemctl stop meatbox-gateway.service
test "$(systemctl is-active meatbox-gateway.service || true)" = inactive

cp -a "$STATE_ROOT/access.json" "$BACKUP_DIR/data/access.json"
cp -a "$STATE_ROOT/dispatch-state" "$BACKUP_DIR/data/dispatch-state"
cp -a "$STATE_ROOT/resources" "$BACKUP_DIR/data/resources"
find "$BACKUP_DIR/data" -type d -exec chmod 0700 {} +
find "$BACKUP_DIR/data" -type f -exec chmod 0600 {} +
find "$BACKUP_DIR/data" -type f -exec sha256sum -- {} + > "$BACKUP_DIR/config/data.SHA256SUMS"
install -m 0600 "$BACKUP_DIR/config/data.SHA256SUMS" "$BACKUP_DIR/data/SHA256SUMS"
rm -f "$BACKUP_DIR/config/data.SHA256SUMS"
(
  cd "$BACKUP_DIR/data"
  sha256sum -c SHA256SUMS >/dev/null
)
node -e '
  const {DatabaseSync}=require("node:sqlite");
  const db=new DatabaseSync(process.argv[1],{readOnly:true});
  try {
    const version=db.prepare("PRAGMA user_version").get().user_version;
    const integrity=db.prepare("PRAGMA integrity_check").get().integrity_check;
    if (version !== 2 || integrity !== "ok") process.exit(2);
  } finally { db.close(); }
' "$BACKUP_DIR/data/resources/resources.sqlite"

mkdir -p "$DROPIN_DIR" "$ENV_ROOT"
chmod 0755 "$DROPIN_DIR"
chmod 0700 "$ENV_ROOT"
install -m 0600 "$CONFIG_CANDIDATE/api.env" "$API_ENV"
install -m 0600 "$CONFIG_CANDIDATE/web.env" "$WEB_ENV"
install -m 0600 "$CONFIG_CANDIDATE/owners.env" "$OWNERS_ENV"
if [ "$MODE" = native ]; then
  install -m 0644 "$TARGET_RELEASE/deploy/new-stack/meatbox-api-native.service" "$API_UNIT"
  install -m 0644 "$TARGET_RELEASE/deploy/new-stack/meatbox-web-native.service" "$WEB_UNIT"
else
  install -m 0644 "$TARGET_RELEASE/deploy/new-stack/meatbox-api.service" "$API_UNIT"
  install -m 0644 "$TARGET_RELEASE/deploy/new-stack/meatbox-web.service" "$WEB_UNIT"
  install -m 0644 "$TARGET_RELEASE/deploy/new-stack/meatbox-gateway-new-stack.conf" "$DROPIN_FILE"
fi
validate_active_release "$NEW_CURRENT" "$NEW_RELEASES" "$MODE_FILE" "$EXPECTED_ACTIVE_DEPLOYMENT"
ln -s "$TARGET_RELEASE" "$NEW_CURRENT.next"
mv -Tf "$NEW_CURRENT.next" "$NEW_CURRENT"

CADDY_CANDIDATE=$BACKUP_DIR/config/Caddyfile.candidate
sed 's/^\([[:space:]]*\)reverse_proxy[[:space:]]\+127\.0\.0\.1:3001[[:space:]]*$/\1reverse_proxy 127.0.0.1:4173/' "$CADDY_FILE" > "$CADDY_CANDIDATE"
test "$(grep -Ec '^[[:space:]]*reverse_proxy[[:space:]]+127\.0\.0\.1:4173[[:space:]]*$' "$CADDY_CANDIDATE")" -eq 1
if grep -q 'push-lab' "$CADDY_FILE"; then
  test "$(grep -c '127\.0\.0\.1:3300' "$CADDY_FILE")" = "$(grep -c '127\.0\.0\.1:3300' "$CADDY_CANDIDATE")"
fi
caddy validate --config "$CADDY_CANDIDATE"

systemctl daemon-reload
systemctl enable meatbox-api.service meatbox-web.service
if [ "$MODE" = native ]; then
  systemctl disable meatbox-gateway.service
else
  systemctl enable meatbox-gateway.service
  systemctl start meatbox-gateway.service
fi
systemctl start meatbox-api.service
systemctl start meatbox-web.service

attempt=0
until curl --fail --silent --show-error http://127.0.0.1:8081/actuator/health >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1
done
if [ "$PUSH_ENV_PRESENT" -eq 1 ]; then
  cmp "$PUSH_ENV" "$BACKUP_DIR/config/push-lab-web.env"
  PUSH_MUTATED=1
  install -m 0600 "$BACKUP_DIR/config/push-lab-web.env.candidate" "$PUSH_ENV"
  if [ "$(sed -n '1p' "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.active")" = active ]; then
    systemctl restart "$PUSH_WEB_SERVICE"
  fi
fi
attempt=0
until curl --fail --silent --show-error http://127.0.0.1:4173/login >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1
done

install -m 0644 "$CADDY_CANDIDATE" "$CADDY_FILE.next"
mv -f "$CADDY_FILE.next" "$CADDY_FILE"
systemctl reload caddy
systemctl is-active --quiet meatbox-api.service
systemctl is-active --quiet meatbox-web.service
if [ "$MODE" = native ]; then
  test "$(systemctl is-active meatbox-gateway.service || true)" = inactive
else
  systemctl is-active --quiet meatbox-gateway.service
fi

printf '%s %s\n' "$MODE" "$RELEASE_ID" > "$MODE_FILE.next"
chmod 0600 "$MODE_FILE.next"
mv -f "$MODE_FILE.next" "$MODE_FILE"

MUTATED=0
trap - EXIT HUP INT TERM
printf 'rollout complete: release=%s mode=%s backup=%s\n' "$RELEASE_ID" "$MODE" "$BACKUP_DIR"
