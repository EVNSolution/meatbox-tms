#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 TRUSTED_RELEASE_JSON [RESULT_JSON]" >&2
  exit 64
fi

SCRIPT_DIRECTORY=$(cd "$(dirname "$0")" && pwd -P)
REPOSITORY_ROOT=$(cd "$SCRIPT_DIRECTORY/../.." && pwd -P)
REVIEWED_VERIFIER=$REPOSITORY_ROOT/scripts/package-new-stack.mjs
REVIEWED_ROLLOUT=$SCRIPT_DIRECTORY/rollout.sh
REVIEWED_ARTIFACT_VERIFIER=$SCRIPT_DIRECTORY/verify-ci-artifact.mjs
TRUSTED_RELEASE_JSON=$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")
RESULT_JSON=${2:-.runtime/test-deploy-result.json}
TEST_HOST=${MEATBOX_TEST_HOST:-3.36.96.156}
TEST_USER=${MEATBOX_TEST_USER:-ubuntu}
TEST_INSTANCE_ID=${MEATBOX_TEST_INSTANCE_ID:-i-03d1f27429c948b7d}
TEST_AZ=${MEATBOX_TEST_AZ:-ap-northeast-2a}
AWS_REGION=${AWS_REGION:-ap-northeast-2}

[[ "$TEST_HOST" == "3.36.96.156" && "$TEST_INSTANCE_ID" == "i-03d1f27429c948b7d" && "$TEST_AZ" == "ap-northeast-2a" ]] || {
  echo "TEST target does not match the reviewed Meatbox server" >&2
  exit 64
}

RELEASE_FIELDS=()
while IFS= read -r field; do RELEASE_FIELDS+=("$field"); done < <(node -e '
  const fs = require("fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.format !== 1 || !/^[0-9a-f]{12}-[0-9a-f]{16}$/.test(value.releaseId)
    || !/^[0-9a-f]{40}$/.test(value.sourceSha) || !/^[0-9a-f]{64}$/.test(value.archiveSha256)
    || typeof value.archive !== "string") process.exit(2);
  for (const field of [value.releaseId, value.sourceSha, value.archiveSha256, value.archive]) console.log(field);
' "$TRUSTED_RELEASE_JSON")
[[ ${#RELEASE_FIELDS[@]} -eq 4 ]] || { echo "trusted release record is invalid" >&2; exit 65; }
RELEASE_ID=${RELEASE_FIELDS[0]}
SOURCE_SHA=${RELEASE_FIELDS[1]}
ARCHIVE_SHA=${RELEASE_FIELDS[2]}
ARCHIVE=${RELEASE_FIELDS[3]}
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" && "$(basename "$ARCHIVE")" == "$RELEASE_ID.tar.gz" ]] || {
  echo "trusted release archive is missing or misnamed" >&2
  exit 66
}
[[ "$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')" == "$ARCHIVE_SHA" ]] || {
  echo "trusted release archive checksum changed" >&2
  exit 65
}

START_MS=$(node -e 'process.stdout.write(String(Date.now()))')
LOCAL_TEMP=$(mktemp -d "${TMPDIR:-/tmp}/meatbox-test-deploy.XXXXXX")
OWN_CONTROL=0
REMOTE_STAGE=''
SSH_ARGS=()
CONTROL_PATH=${SSH_CONTROL_PATH:-$LOCAL_TEMP/ssh-control}

cleanup() {
  status=$?
  if [[ "$OWN_CONTROL" -eq 1 ]]; then
    ssh -S "$CONTROL_PATH" -O exit "$TEST_USER@$TEST_HOST" >/dev/null 2>&1 || true
  fi
  rm -rf "$LOCAL_TEMP"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

if [[ -n "${MEATBOX_TEST_KNOWN_HOSTS_FILE:-}" ]]; then
  KNOWN_HOSTS_FILE=$MEATBOX_TEST_KNOWN_HOSTS_FILE
elif [[ -n "${MEATBOX_TEST_KNOWN_HOSTS:-}" ]]; then
  KNOWN_HOSTS_FILE=$LOCAL_TEMP/known_hosts
  printf '%s\n' "$MEATBOX_TEST_KNOWN_HOSTS" > "$KNOWN_HOSTS_FILE"
  chmod 0600 "$KNOWN_HOSTS_FILE"
else
  echo "pinned TEST known_hosts entry is required" >&2
  exit 64
fi
[[ -f "$KNOWN_HOSTS_FILE" && ! -L "$KNOWN_HOSTS_FILE" ]] || { echo "known_hosts file is unsafe" >&2; exit 65; }

if [[ -n "${SSH_CONTROL_PATH:-}" ]]; then
  [[ -S "$CONTROL_PATH" ]] || { echo "existing SSH control path is unavailable" >&2; exit 66; }
  SSH_ARGS=(-o ControlPath="$CONTROL_PATH" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS_FILE")
else
  KEY_FILE=$LOCAL_TEMP/eic-key
  ssh-keygen -q -t ed25519 -N '' -f "$KEY_FILE"
  aws ec2-instance-connect send-ssh-public-key \
    --region "$AWS_REGION" \
    --instance-id "$TEST_INSTANCE_ID" \
    --availability-zone "$TEST_AZ" \
    --instance-os-user "$TEST_USER" \
    --ssh-public-key "file://$KEY_FILE.pub" >/dev/null
  SSH_ARGS=(-o ControlPath="$CONTROL_PATH" -i "$KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS_FILE")
  ssh "${SSH_ARGS[@]}" -o ControlMaster=yes -o ControlPersist=120 -MNf "$TEST_USER@$TEST_HOST"
  OWN_CONTROL=1
fi

ssh_remote() {
  # shellcheck disable=SC2029
  ssh "${SSH_ARGS[@]}" "$TEST_USER@$TEST_HOST" "$@"
}

SNAPSHOT_START=$(node -e 'process.stdout.write(String(Date.now()))')
ACTIVE_FIELDS=()
while IFS= read -r field; do ACTIVE_FIELDS+=("$field"); done < <(ssh_remote "sudo sh -eu -c 'cat /etc/meatbox-tms/deployment-mode; sed -n 1p /opt/meatbox-demo/current/REVISION'")
[[ ${#ACTIVE_FIELDS[@]} -eq 2 && "${ACTIVE_FIELDS[0]}" =~ ^native\ ([0-9a-f]{12}-[0-9a-f]{16})$ ]] || {
  echo "TEST active deployment snapshot is not a valid native release" >&2
  exit 65
}
ACTIVE_RELEASE_ID=${BASH_REMATCH[1]}
[[ "${ACTIVE_FIELDS[1]}" =~ ^[0-9a-f]{40}$ ]] || { echo "TEST legacy revision is invalid" >&2; exit 65; }
ACTIVE_DEPLOYMENT="native:$ACTIVE_RELEASE_ID"
LEGACY_REVISION=${ACTIVE_FIELDS[1]}
SNAPSHOT_END=$(node -e 'process.stdout.write(String(Date.now()))')

if [[ "$ACTIVE_RELEASE_ID" == "$RELEASE_ID" ]]; then
  # shellcheck disable=SC2016
  REMOTE_STAGE=$(ssh_remote 'stage=$(mktemp -d /tmp/meatbox-test-release.XXXXXX) && chmod 0700 "$stage" && printf "%s\n" "$stage"')
  scp "${SSH_ARGS[@]}" "$REVIEWED_VERIFIER" "$REVIEWED_ARTIFACT_VERIFIER" "$TEST_USER@$TEST_HOST:$REMOTE_STAGE/"
  ssh_remote "sudo flock -n /run/lock/meatbox-tms-release.lock node '$REMOTE_STAGE/verify-ci-artifact.mjs' --installed-root /opt/meatbox-tms --mode-file /etc/meatbox-tms/deployment-mode --expected-release-id '$RELEASE_ID' --expected-source-sha '$SOURCE_SHA' --reviewed-verifier '$REMOTE_STAGE/package-new-stack.mjs' >/dev/null"
  RESULT_STATUS=noop
  ssh_remote "rm -rf '$REMOTE_STAGE'"
  REMOTE_STAGE=''
else
  # shellcheck disable=SC2016
  REMOTE_STAGE=$(ssh_remote 'stage=$(mktemp -d /tmp/meatbox-test-release.XXXXXX) && chmod 0700 "$stage" && printf "%s\n" "$stage"')
  [[ "$REMOTE_STAGE" =~ ^/tmp/meatbox-test-release\.[A-Za-z0-9]+$ ]] || { echo "remote staging path is unsafe" >&2; exit 65; }
  TRANSFER_START=$(node -e 'process.stdout.write(String(Date.now()))')
  scp "${SSH_ARGS[@]}" "$ARCHIVE" "$REVIEWED_VERIFIER" "$REVIEWED_ROLLOUT" "$TEST_USER@$TEST_HOST:$REMOTE_STAGE/"
  TRANSFER_END=$(node -e 'process.stdout.write(String(Date.now()))')
  ssh_remote bash -s -- "$REMOTE_STAGE" "$RELEASE_ID" "$ARCHIVE_SHA" "$SOURCE_SHA" <<'REMOTE_VERIFY'
set -euo pipefail
stage=$1
release_id=$2
expected_archive_sha=$3
expected_source_sha=$4
archive=$stage/$release_id.tar.gz
[[ "$(sha256sum "$archive" | awk '{print $1}')" == "$expected_archive_sha" ]]
tar -xzf "$archive" -C "$stage"
release=$stage/$release_id
node "$stage/package-new-stack.mjs" --verify "$release" >/dev/null
node -e '
  const fs = require("fs");
  const [manifestFile, releaseId, sourceSha, revisionFile] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const revision = fs.readFileSync(revisionFile, "utf8").trim();
  if (manifest.releaseId !== releaseId || manifest.git?.head !== sourceSha || manifest.git?.dirty !== false
    || manifest.git?.dirtyEntries?.length || revision !== sourceSha) process.exit(2);
' "$release/MANIFEST.json" "$release_id" "$expected_source_sha" "$release/REVISION"
REMOTE_VERIFY
  ROLLOUT_START=$(node -e 'process.stdout.write(String(Date.now()))')
  ssh_remote "sudo '$REMOTE_STAGE/rollout.sh' '$REMOTE_STAGE/$RELEASE_ID' '$LEGACY_REVISION' native '$ACTIVE_DEPLOYMENT'"
  ROLLOUT_END=$(node -e 'process.stdout.write(String(Date.now()))')
  RESULT_STATUS=deployed
  ssh_remote "rm -rf '$REMOTE_STAGE'"
  REMOTE_STAGE=''
fi

END_MS=$(node -e 'process.stdout.write(String(Date.now()))')
mkdir -p "$(dirname "$RESULT_JSON")"
# shellcheck disable=SC2016
RESULT_STATUS="$RESULT_STATUS" RELEASE_ID="$RELEASE_ID" SOURCE_SHA="$SOURCE_SHA" ACTIVE_DEPLOYMENT="$ACTIVE_DEPLOYMENT" \
START_MS="$START_MS" SNAPSHOT_START="$SNAPSHOT_START" SNAPSHOT_END="$SNAPSHOT_END" \
TRANSFER_START="${TRANSFER_START:-0}" TRANSFER_END="${TRANSFER_END:-0}" ROLLOUT_START="${ROLLOUT_START:-0}" ROLLOUT_END="${ROLLOUT_END:-0}" END_MS="$END_MS" \
node -e '
  const fs = require("fs");
  const number = name => Number(process.env[name]);
  const duration = (start, end) => start && end ? end - start : 0;
  const result = {
    format: 1,
    status: process.env.RESULT_STATUS,
    releaseId: process.env.RELEASE_ID,
    sourceSha: process.env.SOURCE_SHA,
    previousDeployment: process.env.ACTIVE_DEPLOYMENT,
    timingsMs: {
      snapshot: duration(number("SNAPSHOT_START"), number("SNAPSHOT_END")),
      transfer: duration(number("TRANSFER_START"), number("TRANSFER_END")),
      rollout: duration(number("ROLLOUT_START"), number("ROLLOUT_END")),
      total: duration(number("START_MS"), number("END_MS")),
    },
  };
  fs.writeFileSync(process.argv[1], `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: "wx" });
' "$RESULT_JSON"
cat "$RESULT_JSON"
