#!/bin/sh
set -eu

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

  case "$expected_active_deployment" in
    connected:*|native:*) ;;
    *) echo "expected active deployment is invalid" >&2; return 64 ;;
  esac
  expected_active_mode=${expected_active_deployment%%:*}
  expected_release_id=${expected_active_deployment#*:}
  printf '%s\n' "$expected_release_id" | grep -Eq '^[0-9a-f]{12}-[0-9a-f]{16}$' || {
    echo "expected active deployment is invalid" >&2
    return 64
  }
  test -L "$new_current" || { echo "active new-stack link is missing" >&2; return 66; }
  active_release=$(cd "$new_current" 2>/dev/null && pwd -P) || {
    echo "active new-stack link target is missing" >&2
    return 66
  }
  expected_release=$new_releases/$expected_release_id
  test "$active_release" = "$expected_release" || { echo "active new-stack target changed" >&2; return 65; }
  test -x "$active_release/tools/package-new-stack.mjs" || { echo "active release verifier is missing" >&2; return 66; }
  node "$active_release/tools/package-new-stack.mjs" --verify-installed "$active_release"
  active_release_id=$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(manifest.releaseId)) process.exit(2);
    process.stdout.write(manifest.releaseId);
  ' "$active_release/MANIFEST.json") || { echo "active release manifest is invalid" >&2; return 65; }
  test "$active_release_id" = "$expected_release_id" || { echo "active release changed" >&2; return 65; }
  test -f "$mode_file" && test ! -L "$mode_file" || { echo "deployment mode is missing or unsafe" >&2; return 66; }
  active_mode=$(sed -n '1p' "$mode_file")
  test "$active_mode" = "$expected_active_mode $expected_release_id" || {
    echo "deployment mode does not match expected active deployment" >&2
    return 65
  }
}
# END_VALIDATE_ACTIVE_RELEASE

validate_restore_target() {
  backup_config=$1
  new_releases=$2
  new_current=$3
  restore_link_file=$backup_config/new-current-link.txt
  restore_mode_file=$backup_config/deployment-mode

  RESTORE_RELEASE_TARGET=none
  RESTORE_DEPLOYMENT=none
  if [ ! -e "$restore_link_file" ] && [ ! -L "$restore_link_file" ]; then
    test ! -e "$restore_mode_file" && test ! -L "$restore_mode_file" \
      || { echo "restore mode exists without a release link" >&2; return 65; }
    return 0
  fi
  test -f "$restore_link_file" && test ! -L "$restore_link_file" || {
    echo "restore release link must be a regular file" >&2
    return 65
  }
  test -f "$restore_mode_file" && test ! -L "$restore_mode_file" || {
    echo "restore deployment mode is missing or unsafe" >&2
    return 65
  }
  test "$(awk 'END { print NR }' "$restore_link_file")" -eq 1 || {
    echo "restore release link must contain exactly one line" >&2
    return 65
  }
  test "$(awk 'END { print NR }' "$restore_mode_file")" -eq 1 || {
    echo "restore deployment mode must contain exactly one line" >&2
    return 65
  }
  restore_link=$(sed -n '1p' "$restore_link_file")
  case "$restore_link" in
    /*) restore_candidate=$restore_link ;;
    *) restore_candidate=$(dirname "$new_current")/$restore_link ;;
  esac
  restore_release=$(cd "$restore_candidate" 2>/dev/null && pwd -P) || {
    echo "restore release target is missing" >&2
    return 66
  }
  restore_release_id=$(basename "$restore_release")
  printf '%s\n' "$restore_release_id" | grep -Eq '^[0-9a-f]{12}-[0-9a-f]{16}$' || {
    echo "restore release id is invalid" >&2
    return 65
  }
  test "$restore_release" = "$new_releases/$restore_release_id" || {
    echo "restore release target is outside immutable releases" >&2
    return 65
  }
  test -x "$restore_release/tools/package-new-stack.mjs" || { echo "restore release verifier is missing" >&2; return 66; }
  node "$restore_release/tools/package-new-stack.mjs" --verify-installed "$restore_release"
  restore_manifest_id=$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(manifest.releaseId)) process.exit(2);
    process.stdout.write(manifest.releaseId);
  ' "$restore_release/MANIFEST.json") || { echo "restore release manifest is invalid" >&2; return 65; }
  test "$restore_manifest_id" = "$restore_release_id" || { echo "restore release manifest does not match target" >&2; return 65; }
  restore_mode=$(sed -n '1p' "$restore_mode_file")
  case "$restore_mode" in
    "connected $restore_release_id") RESTORE_DEPLOYMENT=connected:$restore_release_id ;;
    "native $restore_release_id") RESTORE_DEPLOYMENT=native:$restore_release_id ;;
    *) echo "restore deployment mode does not match target" >&2; return 65 ;;
  esac
  RESTORE_RELEASE_TARGET=$restore_release
}
# END_VALIDATE_RESTORE_TARGET

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
  if [ -e "$push_marker" ] || [ -L "$push_marker" ]; then
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
  elif [ -f "$push_env_backup" ] && [ ! -L "$push_env_backup" ] \
    && [ -f "$push_enabled_backup" ] && [ ! -L "$push_enabled_backup" ] \
    && [ -f "$push_active_backup" ] && [ ! -L "$push_active_backup" ]; then
    push_present=1
  else
    echo "legacy Push Lab backup presence is unverifiable" >&2
    return 65
  fi
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

if [ "$#" -ne 2 ]; then
  echo "usage: $0 ROLLOUT_BACKUP_DIR EXPECTED_ACTIVE_DEPLOYMENT" >&2
  exit 64
fi

BACKUP_DIR=$(cd "$1" && pwd -P)
EXPECTED_ACTIVE_DEPLOYMENT=$2
case "$BACKUP_DIR" in
  /var/backups/meatbox-tms/*) ;;
  *) echo "backup must be under /var/backups/meatbox-tms" >&2; exit 64 ;;
esac
NEW_RELEASES=/opt/meatbox-tms/releases
NEW_CURRENT=/opt/meatbox-tms/current
STATE_ROOT=/var/lib/meatbox-demo
SYSTEMD_ROOT=/etc/systemd/system
DROPIN_DIR=$SYSTEMD_ROOT/meatbox-gateway.service.d
DROPIN_FILE=$DROPIN_DIR/10-new-stack.conf
API_UNIT=$SYSTEMD_ROOT/meatbox-api.service
WEB_UNIT=$SYSTEMD_ROOT/meatbox-web.service
ENV_ROOT=/etc/meatbox-tms
OWNERS_ENV=$ENV_ROOT/owners.env
MODE_FILE=$ENV_ROOT/deployment-mode
PUSH_ENV=/etc/meatbox-push-lab/push-lab-web.env
PUSH_WEB_SERVICE=meatbox-push-lab-web.service
CADDY_FILE=/etc/caddy/Caddyfile
LOCK_FILE=/run/lock/meatbox-tms-release.lock

test "$(id -u)" -eq 0 || { echo "rollback must run as root" >&2; exit 77; }
acquire_release_lock "$LOCK_FILE"
test -d "$BACKUP_DIR/config" && test ! -L "$BACKUP_DIR/config" || { echo "rollback backup is incomplete" >&2; exit 66; }
test -f "$BACKUP_DIR/config/Caddyfile" && test ! -L "$BACKUP_DIR/config/Caddyfile" \
  || { echo "Caddy backup is missing or unsafe" >&2; exit 66; }
validate_active_release "$NEW_CURRENT" "$NEW_RELEASES" "$MODE_FILE" "$EXPECTED_ACTIVE_DEPLOYMENT"
validate_restore_target "$BACKUP_DIR/config" "$NEW_RELEASES" "$NEW_CURRENT"
validate_restore_config_files "$BACKUP_DIR/config" "$RESTORE_DEPLOYMENT"
validate_rollback_state_files "$BACKUP_DIR/config" "$PUSH_WEB_SERVICE"
caddy validate --config "$BACKUP_DIR/config/Caddyfile"

# Kotlin is stopped first so it cannot write the v2 resource database during code rollback.
systemctl stop meatbox-api.service
systemctl stop meatbox-web.service
systemctl stop meatbox-gateway.service
if [ -f "$BACKUP_DIR/config/push-lab-web.env" ]; then systemctl stop "$PUSH_WEB_SERVICE"; fi

if [ -f "$BACKUP_DIR/config/10-new-stack.conf" ]; then
  mkdir -p "$DROPIN_DIR"
  cp -a "$BACKUP_DIR/config/10-new-stack.conf" "$DROPIN_FILE"
else
  rm -f "$DROPIN_FILE"
fi
if [ -f "$BACKUP_DIR/config/meatbox-api.service" ]; then cp -a "$BACKUP_DIR/config/meatbox-api.service" "$API_UNIT"; else rm -f "$API_UNIT"; fi
if [ -f "$BACKUP_DIR/config/meatbox-web.service" ]; then cp -a "$BACKUP_DIR/config/meatbox-web.service" "$WEB_UNIT"; else rm -f "$WEB_UNIT"; fi
if [ "$RESTORE_RELEASE_TARGET" != none ]; then
  ln -s "$RESTORE_RELEASE_TARGET" "$NEW_CURRENT.rollback"
  mv -Tf "$NEW_CURRENT.rollback" "$NEW_CURRENT"
else
  rm -f "$NEW_CURRENT"
fi
cp -a "$BACKUP_DIR/config/Caddyfile" "$CADDY_FILE.rollback"
mv -f "$CADDY_FILE.rollback" "$CADDY_FILE"

if [ -f "$BACKUP_DIR/config/api.env" ]; then cp -a "$BACKUP_DIR/config/api.env" "$ENV_ROOT/api.env"; else rm -f "$ENV_ROOT/api.env"; fi
if [ -f "$BACKUP_DIR/config/web.env" ]; then cp -a "$BACKUP_DIR/config/web.env" "$ENV_ROOT/web.env"; else rm -f "$ENV_ROOT/web.env"; fi
if [ -f "$BACKUP_DIR/config/owners.env" ]; then cp -a "$BACKUP_DIR/config/owners.env" "$OWNERS_ENV"; else rm -f "$OWNERS_ENV"; fi
if [ "$RESTORE_DEPLOYMENT" != none ]; then
  restore_mode=${RESTORE_DEPLOYMENT%%:*}
  restore_release_id=${RESTORE_DEPLOYMENT#*:}
  printf '%s %s\n' "$restore_mode" "$restore_release_id" > "$MODE_FILE.rollback"
  chmod 0600 "$MODE_FILE.rollback"
  mv -f "$MODE_FILE.rollback" "$MODE_FILE"
else
  rm -f "$MODE_FILE"
fi
if [ -f "$BACKUP_DIR/config/push-lab-web.env" ]; then install -m 0600 "$BACKUP_DIR/config/push-lab-web.env" "$PUSH_ENV"; fi

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
if [ -f "$BACKUP_DIR/config/push-lab-web.env" ]; then
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
if [ -f "$BACKUP_DIR/config/push-lab-web.env" ] \
  && [ "$(sed -n '1p' "$BACKUP_DIR/config/$PUSH_WEB_SERVICE.active")" = active ]; then
  systemctl start "$PUSH_WEB_SERVICE"
fi
systemctl reload caddy
if [ "$(sed -n '1p' "$BACKUP_DIR/config/meatbox-gateway.service.active")" = active ]; then systemctl is-active --quiet meatbox-gateway.service; fi

printf 'code rollback complete: backup=%s live-data-retained=%s\n' "$BACKUP_DIR" "$STATE_ROOT"
