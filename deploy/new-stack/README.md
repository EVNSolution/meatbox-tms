# TEST new-stack deployment assets

These files support two explicit rollout modes without replacing the full Caddy configuration. `connected` is the default and keeps Node as the authentication and dated-dispatch owner. `native` moves authentication, dated dispatch, and resources to Kotlin and keeps the legacy Node service stopped and disabled.

- Install `meatbox-api.service` and `meatbox-web.service` under `/etc/systemd/system/`.
- Install `meatbox-gateway-new-stack.conf` as `/etc/systemd/system/meatbox-gateway.service.d/10-new-stack.conf`.
- Create `/etc/meatbox-tms/api.env`, `/etc/meatbox-tms/web.env`, and `/etc/meatbox-tms/owners.env` from the examples with mode `0600`. The mode configurator preserves unknown existing settings and the exact `MEATBOX_PUBLIC_ORIGIN`, then changes only the known runtime and ownership keys. Node and web read the same owner file.
- Keep `/opt/meatbox-demo/current` unchanged. The Node drop-in points execution at `/opt/meatbox-tms/current/legacy` while continuing to read the canonical dataset and persistent state from their existing locations.
- Change only the existing fallback proxy from `127.0.0.1:3001` to `127.0.0.1:4173`. The `/push-lab` handler at `127.0.0.1:3300` must remain byte-for-byte unchanged.

Build and verify a release locally from the repository root:

```sh
make package-new-stack
node scripts/package-new-stack.mjs --verify .runtime/new-stack-release/<release-id>
```

The Make target rebuilds the current web and JAR and passes Kotlin, frontend, golden, real-JAR and packaging tests before creating an immutable package. The low-level Node packager copies existing artifact bytes; it does not itself attest build freshness. Do not use it directly to prepare a deployment candidate.

GitHub Actions stores the package produced by a successful `New stack checks` run as the `meatbox-test-release` artifact. `.github/workflows/deploy-test.yml` downloads that exact artifact and does not run npm installation, Gradle, Vite, tests, or another package build. Automatic deployment accepts only the current successful `main` push run. Manual deployment accepts either that current `main` run or a current open same-repository PR run; fork, stale, cancelled, failed, and wrong-workflow runs are rejected. The deployment workflow itself is checked out from the default branch, so a PR artifact cannot replace its privileged verification or transport code.

`verify-ci-artifact.mjs` binds the selected run, immutable repository and owner IDs, current branch or PR head plus merge revision, run attempt, artifact API digest and expiry, archive checksum, release manifest, clean source SHA and release ID into a mode-`0600` trusted record. It verifies the package with the default-branch checkout tool and requires every packaged deploy tool to be byte-identical to that reviewed checkout before any AWS identity is issued. `deploy-ci-artifact.sh` consumes only that record, uses an EC2 Instance Connect ephemeral key or an existing SSH control socket, requires the pinned TEST host key, captures the exact native active release and legacy revision, and calls the default-branch reviewed `rollout.sh` with those compare-and-swap values. Re-selecting the already active release takes the host release lock and verifies the exact mode, current symlink target, installed manifest, revision and source SHA before exiting without a restart. Failed remote candidates remain in their private `/tmp/meatbox-test-release.*` staging directory for bounded diagnosis; owned local keys and SSH masters are always removed. The result JSON records snapshot, transfer, rollout and total elapsed time without credentials.

Required TEST environment variables are `MEATBOX_TEST_ROLE_ARN`, `MEATBOX_TEST_INSTANCE_ID`, `MEATBOX_TEST_HOST`, `MEATBOX_TEST_AZ`, and `MEATBOX_TEST_KNOWN_HOSTS`. They are configured on the protected `test` GitHub environment, whose deployment branch policy permits only `main`. The reviewed target is instance `i-03d1f27429c948b7d`, host `3.36.96.156`, availability zone `ap-northeast-2a`, and region `ap-northeast-2`; the wrapper rejects a different target.

The AWS role trust is recorded in `test-oidc-trust.json`. It requires the immutable GitHub OIDC subject `repo:EVNSolution@267003080/meatbox-tms@1368015789:environment:test`, the `test` environment, `refs/heads/main`, audience `sts.amazonaws.com`, repository ID `1368015789`, and owner ID `267003080`. `test-deploy-permissions.json` limits the role to `ec2-instance-connect:SendSSHPublicKey` for this one instance and OS user `ubuntu`; it intentionally grants no `DescribeInstances`. These public JSON files contain no credentials. The GitHub environment and AWS role are configured. Automatic main CI artifact deployment has been verified through Actions OIDC on TEST; each new candidate still requires its own successful CI, artifact identity check, installed revision, health and authenticated UI verification. A draft PR or local branch does not activate automatic deployment.

The rollout script expects a verified candidate, the exact legacy `REVISION` at `/opt/meatbox-demo/current`, and the expected active new-stack release ID (or `none` for a first installation):

```sh
sudo deploy/new-stack/rollout.sh /path/to/<release-id> \
  <expected-legacy-revision> connected <connected:id-or-native:id-or-none>
```

An omitted mode defaults to `connected`. An omitted active state is accepted only when there is no new-stack current pointer. Pass `none` only for the first new-stack install; otherwise pass the exact current state, for example `native:c1f29a657678-7cc16465b91dc217`. Use `native` after the Kotlin authentication and dated-dispatch candidate passes its migration checks:

```sh
sudo deploy/new-stack/rollout.sh /path/to/<release-id> \
  <expected-legacy-revision> native <connected:id-or-native:id-or-none>
```

Native mode installs the no-Node-dependency API and web unit templates, uses a 256 MB JVM heap with a 640 MB service memory ceiling, enables `MEATBOX_AUTH_ENABLED` and `MEATBOX_DISPATCH_ENABLED`, points them at the existing account and checkpoint paths, sets all three owners to `kotlin`, and disables `meatbox-gateway.service`. Connected mode retains its 128 MB heap and 320 MB API service ceiling. If `/etc/meatbox-push-lab/push-lab-web.env` exists, the rollout requires its session URL to be the reviewed Node or Kotlin loopback URL, changes only that value to Kotlin after the API health check, and restarts only `meatbox-push-lab-web.service` when it was already active. An absent file is left alone; any other URL fails before services are stopped. The old unit, release, drop-in, data, and exact Push Lab environment remain available for rollback. Re-running the same already-active native release is rejected before services are stopped.

A direct `native` to `connected` rollout is rejected before release installation or service mutation. Use the reviewed backup rollback to restore the prior connected configuration, Push Lab session URL and service state.

Candidate `REVISION` must match its manifest Git head; it can differ from the preserved legacy revision. Rollout and deliberate rollback share a nonblocking host lock. Existing new-stack target, installed manifest, deployment mode and expected active mode and ID must agree before mutation, and the pointer is checked again before cutover. A stale expected mode or ID, or concurrent transition is rejected. The script takes a stopped-service backup before switching writers. Automatic rollback restores code, systemd, and Caddy configuration while retaining the live account, checkpoint, and resource files. Restoring those data files is a separate point-in-time recovery decision.

After a successful rollout, use the printed backup path and active mode plus release ID for a deliberate code rollback:

```sh
sudo /opt/meatbox-tms/current/deploy/new-stack/rollback.sh \
  /var/backups/meatbox-tms/<rollout-backup> \
  <connected:active-id-or-native:active-id>
```

Before stopping services, rollback verifies the previous immutable target, installed manifest, matching backed-up mode and all required service enable/active state files. Invalid, missing or unsafe backup records are rejected. New backups always record `push-env-present` as `0` or `1`; older backups without that marker are accepted only when a complete regular Push environment and both service-state files prove presence. Other markerless backups are rejected. Transitional or unsupported service states are rejected before mutation. This stops Kotlin first and does **not** restore `access.json`, dispatch checkpoints, or the live v2 resource database from the backup. It restores the exact prior API, web, owner, and optional Push Lab environment files plus the previous service enable/active states. A rollback to a previous native release therefore leaves Node inactive and retains the Kotlin Push Lab session URL. The data copies remain restricted recovery evidence.

To reapply the same immutable release after rollback, pass its installed directory to the original rollout command. The packager verifies all declared files, ignores only the separately installed `legacy/node_modules` directory, runs a fresh `npm ci --omit=dev`, and then reuses the matching release ID:

```sh
sudo /opt/meatbox-tms/releases/<release-id>/deploy/new-stack/rollout.sh \
  /opt/meatbox-tms/releases/<release-id> \
  <expected-legacy-revision> \
  connected \
  <connected:id-or-native:id-or-none>
```

Use `native` as the third (mode) argument when reapplying a native release after rollback.
