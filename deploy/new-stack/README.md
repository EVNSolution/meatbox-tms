# TEST new-stack deployment assets

These files deploy the native Kotlin stack as two blue/green slots on one host, so a rollout never interrupts service. Slot `blue` listens on web `4173` and API `8081`; slot `green` on web `4174` and API `8082`. Caddy forwards the public site to exactly one slot's web port; the rollout starts the candidate in the idle slot, proves it healthy end to end, switches Caddy in one reload, drains and stops the old slot. Signed-in users keep their sessions because the API persists them in `/var/lib/meatbox-demo/sessions.json` (mode `0600`, token digests only; expired or logged-out sessions never return).

- `meatbox-api@.service` and `meatbox-web@.service` are systemd template units; the rollout installs them and `/etc/meatbox-tms/slot-blue.env` / `slot-green.env` (per-slot ports) itself. `/opt/meatbox-tms/slots/<slot>` points at that slot's immutable release and `/opt/meatbox-tms/current` at the active one; `/etc/meatbox-tms/active-slot` records which slot serves traffic.
- Create `/etc/meatbox-tms/api.env`, `/etc/meatbox-tms/web.env`, and `/etc/meatbox-tms/owners.env` from the examples with mode `0600`. The mode configurator preserves unknown existing settings and the exact `MEATBOX_PUBLIC_ORIGIN`, then changes only the known runtime and ownership keys; slot files override the ports.
- Keep `/opt/meatbox-demo/current` unchanged; its `REVISION` is the legacy compare-and-swap value. The retired Node API and `meatbox-gateway.service` stay stopped and disabled.
- The Caddyfile keeps exactly one `reverse_proxy 127.0.0.1:4173` or `:4174` fallback line; the rollout rewrites only that line. The `/push-lab` handler at `127.0.0.1:3300` must remain byte-for-byte unchanged.

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

The rollout script expects a verified candidate, the exact legacy `REVISION` at `/opt/meatbox-demo/current`, the mode `native`, and the expected active new-stack release ID (or `none` for a first installation):

```sh
sudo deploy/new-stack/rollout.sh /path/to/<release-id> \
  <expected-legacy-revision> native <native:id-or-none>
```

`native` is the only deployable mode; `connected` is retired and rejected before any change. Pass `none` only for the first new-stack install; otherwise pass the exact current state, for example `native:c1f29a657678-7cc16465b91dc217`. A host still running the pre-slot fixed units (`meatbox-api.service`, `meatbox-web.service` on 4173/8081) is treated as the `legacy` slot: the first rollout starts `green`, switches, then stops and disables the fixed units.

Order of one rollout: verify the candidate and the active release CAS; take the backup while the old slot still serves (`access.json`, `sessions.json` and checkpoints are written by atomic rename, the resource database is copied with `VACUUM INTO` and integrity-checked); write the env candidates, Push Lab session URL candidate (`configure-push-session-url.mjs INPUT OUTPUT 8081|8082`) and Caddyfile candidate and validate it; start `meatbox-api@<target>` and wait for `/actuator/health`; start `meatbox-web@<target>` and wait for `/login` through the new gateway; install the Caddyfile and `systemctl reload caddy`; move the Push Lab session URL to the target API port and restart `meatbox-push-lab-web.service` if it was active; wait up to ten seconds for established connections to the old web port to drain; stop the old slot; re-check the active release CAS; move `current`, `deployment-mode` and `active-slot`; enable the target slot units and disable the old ones. Until the old slot stops, only in-flight requests that Caddy accepted before the reload can still reach it, so the candidate becomes the single writer within one request round trip of the switch.

Candidate `REVISION` must match its manifest Git head; it can differ from the preserved legacy revision. Rollout holds a nonblocking host lock. Existing new-stack target, installed manifest, deployment mode and expected active mode and ID must agree before mutation, and the pointer is checked again before it moves. Re-running the same already-active release is rejected before any change. Automatic rollback runs in reverse: env files back, old slot restarted if it was stopped, Caddy back, Push Lab back, candidate slot stopped and disabled, pointers back. Live account, session, checkpoint, and resource files are never restored by the rollback; the data copies under the backup directory are restricted recovery evidence.

After a successful rollout, use the printed backup path and the active release ID for a deliberate code rollback. It restores the backed-up `api.env`, `web.env` and `owners.env`, then runs the same blue/green rollout with the previous release, so the rollback is also uninterrupted:

```sh
sudo /opt/meatbox-tms/current/deploy/new-stack/rollback.sh \
  /var/backups/meatbox-tms/<rollout-backup> \
  native:<active-id>
```

The backup must name a previous immutable release under `/opt/meatbox-tms/releases` whose installed manifest and backed-up `deployment-mode` agree; a first-install backup has nothing to roll back to. A release built before session persistence drops sessions when it starts.

To reapply the same immutable release after rollback, pass its installed directory to the original rollout command. The packager verifies all declared files and reuses the matching release ID:

```sh
sudo /opt/meatbox-tms/releases/<release-id>/deploy/new-stack/rollout.sh \
  /opt/meatbox-tms/releases/<release-id> \
  <expected-legacy-revision> \
  native \
  native:<active-id>
```
