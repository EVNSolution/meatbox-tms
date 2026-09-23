#!/bin/sh
set -eu

service=${PUSH_LAB_SERVICE:-push-lab}
base_url=${PUSH_LAB_BASE_URL:-http://127.0.0.1:${PUSH_LAB_PORT:-3300}}
probe_id=

cleanup_probe() {
  [ -n "$probe_id" ] || return 0
  cleanup_json=$(docker compose exec -T "$service" node server/fixture-cli.mjs cleanup-probe --delivery="$probe_id")
  printf '%s' "$cleanup_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (value.removed !== true) throw new Error("deployment probe cleanup failed");
});
'
  probe_id=
}

trap cleanup_probe EXIT INT TERM

# Deployment smoke must never enqueue a deliverable notification. The server
# must assign deployment_probe records deliverable=false and exclude them in
# both enqueue and worker claim paths, even when a previous smoke was interrupted.
docker compose exec -T "$service" node -e '
const sender = process.env.PUSH_LAB_SENDER_MODE;
const deliverable = process.env.DEPLOYMENT_PROBE_DELIVERABLE;
if (sender !== "mock") throw new Error(`smoke refuses sender mode: ${sender}`);
if (deliverable !== "false") throw new Error(`deployment_probe must have deliverable=false, found: ${deliverable}`);
console.log(JSON.stringify({ sender, deploymentProbeDeliverable: false }));
'

curl --fail --silent --show-error "$base_url/healthz"
printf '\n'
curl --fail --silent --show-error "$base_url/readyz"
printf '\n'

# The application chooses the deployment_probe scope and a unique delivery ID;
# callers cannot turn a normal fixture into a deliverable deployment probe.
probe_json=$(docker compose exec -T "$service" node server/fixture-cli.mjs create \
  --probe=true --user=deployment-probe-smoke)
probe_id=$(printf '%s' "$probe_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (!value.deliveryId?.startsWith("deployment_probe:") || value.scope !== "deployment_probe" || value.deliverable !== false) process.exit(1);
  process.stdout.write(value.deliveryId);
});
')
event_id="deployment_probe_event:${probe_id#deployment_probe:}"

emit_json=$(docker compose exec -T "$service" node server/fixture-cli.mjs emit-test-event \
  --event="$event_id" --delivery="$probe_id" --type=deployment_probe --ttl=60000)
printf '%s' "$emit_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (value.enqueued !== 0) throw new Error("deployment probe enqueued " + value.enqueued + " notifications");
});
'

inspect_json=$(docker compose exec -T "$service" node server/fixture-cli.mjs inspect-probe --delivery="$probe_id")
printf '%s' "$inspect_json" | node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const value = JSON.parse(input);
  if (value.scope !== "deployment_probe" || value.deliverable !== false || value.outboxCount !== 0) throw new Error("unsafe deployment probe result");
  console.log(JSON.stringify({ scope: value.scope, deliverable: value.deliverable, enqueued: 0, outboxCount: value.outboxCount }));
});
'

cleanup_probe
trap - EXIT INT TERM
