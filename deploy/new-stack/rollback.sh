#!/bin/sh
# Deliberate code rollback after a successful rollout: restore the backed-up environment
# files, then run the reviewed blue/green rollout with the previous release. Traffic moves
# back in one Caddy reload; live account, session, checkpoint and resource files stay.
set -eu

validate_restore_target() {
  backup_config=$1
  new_releases=$2

  RESTORE_RELEASE_TARGET=none
  RESTORE_DEPLOYMENT=none
  test -f "$backup_config/new-current-link.txt" || { echo "backup has no previous release; nothing to roll back to" >&2; return 66; }
  restore_target=$(sed -n '1p' "$backup_config/new-current-link.txt")
  test -n "$restore_target" || { echo "restore release target is missing" >&2; return 66; }
  restore_release=$(cd "$restore_target" 2>/dev/null && pwd -P) || {
    echo "restore release target is missing" >&2
    return 66
  }
  releases_root=$(cd "$new_releases" && pwd -P)
  case "$restore_release" in
    "$releases_root"/*) ;;
    *) echo "restore release target is outside immutable releases" >&2; return 65 ;;
  esac
  test -x "$restore_release/tools/package-new-stack.mjs" || { echo "restore release verifier is missing" >&2; return 66; }
  node "$restore_release/tools/package-new-stack.mjs" --verify-installed "$restore_release"
  restore_release_id=$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(manifest.releaseId)) process.exit(2);
    process.stdout.write(manifest.releaseId);
  ' "$restore_release/MANIFEST.json") || { echo "restore release manifest is invalid" >&2; return 65; }
  test "$restore_release" = "$releases_root/$restore_release_id" || {
    echo "restore release manifest does not match target" >&2
    return 65
  }
  test -f "$backup_config/deployment-mode" && test ! -L "$backup_config/deployment-mode" || {
    echo "backup deployment mode is missing or unsafe" >&2
    return 66
  }
  restore_mode=$(sed -n '1p' "$backup_config/deployment-mode")
  test "$restore_mode" = "native $restore_release_id" || {
    echo "restore deployment mode does not match target" >&2
    return 65
  }
  RESTORE_RELEASE_TARGET=$restore_release
  RESTORE_DEPLOYMENT=native:$restore_release_id
}
# END_VALIDATE_RESTORE_TARGET

if [ "$#" -ne 2 ]; then
  echo "usage: $0 BACKUP_DIR EXPECTED_ACTIVE_DEPLOYMENT" >&2
  exit 64
fi

SCRIPT_DIRECTORY=$(cd "$(dirname "$0")" && pwd -P)
BACKUP_DIR=$(cd "$1" && pwd -P)
EXPECTED_ACTIVE_DEPLOYMENT=$2
case "$EXPECTED_ACTIVE_DEPLOYMENT" in
  native:*) ;;
  *) echo "expected active deployment must be native:<release-id>" >&2; exit 64 ;;
esac
NEW_RELEASES=/opt/meatbox-tms/releases
ENV_ROOT=/etc/meatbox-tms

test "$(id -u)" -eq 0 || { echo "rollback must run as root" >&2; exit 77; }
test -d "$BACKUP_DIR/config" && test ! -L "$BACKUP_DIR/config" || { echo "rollback backup is incomplete" >&2; exit 66; }
validate_restore_target "$BACKUP_DIR/config" "$NEW_RELEASES"
test -f "$BACKUP_DIR/config/legacy.REVISION" || { echo "backup legacy revision is missing" >&2; exit 66; }
LEGACY_REVISION=$(sed -n '1p' "$BACKUP_DIR/config/legacy.REVISION")
for name in api.env web.env owners.env; do
  test -f "$BACKUP_DIR/config/$name" && test ! -L "$BACKUP_DIR/config/$name" || {
    echo "restore configuration is missing or unsafe: $BACKUP_DIR/config/$name" >&2
    exit 66
  }
done

# Environment first, so the restored release starts with the configuration it ran with.
for name in api.env web.env owners.env; do
  install -m 0600 "$BACKUP_DIR/config/$name" "$ENV_ROOT/$name"
done
echo "restoring $RESTORE_DEPLOYMENT through the blue/green rollout" >&2
exec "$SCRIPT_DIRECTORY/rollout.sh" "$RESTORE_RELEASE_TARGET" "$LEGACY_REVISION" native "$EXPECTED_ACTIVE_DEPLOYMENT"
