import { decrypt, encrypt, hash, id, token } from './crypto.mjs';
import { ApiError, assert } from './errors.mjs';
import { transaction } from './db.mjs';
import { STAGES } from '../public/model.mjs';

const DAY = 86_400_000;
const RETRY_WINDOW = 120_000;
const SELF_TEST_WINDOW = 600_000;
const SELF_TEST_LIMIT = 3;
const INSTALLATION_BOOTSTRAP_RETRY = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PushLabService {
  constructor(db, { now = () => Date.now(), selfTestDelayMs = 30_000 } = {}) {
    this.db = db;
    this.now = now;
    this.selfTestDelayMs = selfTestDelayMs;
  }

  createFixture({ deliveryId = id(), userId, inviteCode = token(), stage = '배송대기', baselineAt, etaAt = null, expiresAt, deliverable = true }) {
    return this.#createFixture({ deliveryId, userId, inviteCode, stage, baselineAt, etaAt, expiresAt, deliverable, scope: 'test' });
  }

  createDeploymentProbe({ userId, inviteCode = token(), stage = '배송대기', baselineAt, etaAt = null, expiresAt }) {
    return this.#createFixture({
      deliveryId: `deployment_probe:${id()}`,
      userId,
      inviteCode,
      stage,
      baselineAt,
      etaAt,
      expiresAt,
      deliverable: false,
      scope: 'deployment_probe',
    });
  }

  #createFixture({ deliveryId, userId, inviteCode, stage, baselineAt, etaAt, expiresAt, deliverable, scope }) {
    const now = this.now();
    baselineAt ??= now;
    expiresAt ??= now + DAY;
    assert(userId, 400, 'user_required');
    assert(etaAt == null || etaAt >= baselineAt, 400, 'invalid_eta');
    transaction(this.db, () => {
      this.db.prepare(`INSERT INTO deliveries(id,user_id,stage,baseline_at,eta_at,expires_at,deliverable,scope)
        VALUES (?,?,?,?,?,?,?,?)`).run(deliveryId, userId, stage, baselineAt, etaAt, expiresAt, Number(deliverable), scope);
      this.db.prepare(`INSERT INTO invitations(id,code_hash,user_id,delivery_id,expires_at)
        VALUES (?,?,?,?,?)`).run(id(), hash(inviteCode), userId, deliveryId, expiresAt);
    });
    return { deliveryId, inviteCode, expiresAt, scope, deliverable: Boolean(deliverable) };
  }

  exchangeInvite({ inviteCode, exchangeKey, sessionToken = null }) {
    assert(inviteCode && exchangeKey, 400, 'exchange_input_required');
    const now = this.now();
    return transaction(this.db, () => {
      const invitation = this.db.prepare('SELECT * FROM invitations WHERE code_hash=?').get(hash(inviteCode));
      assert(invitation && invitation.expires_at > now, 401, 'invalid_invite');
      const keyHash = hash(exchangeKey);
      if (invitation.consumed_at != null) {
        assert(invitation.exchange_key_hash === keyHash, 409, 'invite_already_consumed');
        assert(invitation.retry_until > now && invitation.retry_cipher, 410, 'exchange_retry_expired');
        const original = JSON.parse(decrypt(invitation.retry_cipher));
        const session = this.db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(invitation.session_id, now);
        assert(session, 410, 'exchange_retry_expired');
        return this.#sessionResponse(session, original.sessionToken);
      }

      let session = sessionToken ? this.#session(sessionToken, now) : null;
      if (session) assert(session.user_id === invitation.user_id, 409, 'session_user_mismatch');
      let rawSession = sessionToken;
      let csrfToken;
      if (!session) {
        rawSession = token();
        csrfToken = token();
        session = {
          id: id(),
          user_id: invitation.user_id,
          expires_at: Math.min(now + DAY, invitation.expires_at),
        };
        this.db.prepare(`INSERT INTO sessions(id,token_hash,user_id,csrf_hash,csrf_cipher,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?)`).run(session.id, hash(rawSession), session.user_id, hash(csrfToken), encrypt(csrfToken), now, session.expires_at);
      } else {
        csrfToken = decrypt(session.csrf_cipher);
      }
      this.db.prepare('INSERT OR IGNORE INTO session_deliveries(session_id,delivery_id) VALUES (?,?)')
        .run(session.id, invitation.delivery_id);
      const deliveryIds = this.db.prepare('SELECT delivery_id FROM session_deliveries WHERE session_id=? ORDER BY delivery_id')
        .all(session.id).map((row) => row.delivery_id);
      const response = { sessionToken: rawSession, csrfToken, sessionExpiresAt: session.expires_at, deliveryIds };
      const consumed = this.db.prepare(`UPDATE invitations SET consumed_at=?,exchange_key_hash=?,session_id=?,retry_cipher=?,retry_until=?
        WHERE id=? AND consumed_at IS NULL`).run(now, keyHash, session.id, encrypt(JSON.stringify(response)), now + RETRY_WINDOW, invitation.id);
      assert(consumed.changes === 1, 409, 'invite_exchange_race');
      return response;
    });
  }

  authenticate(sessionToken) {
    const session = this.#session(sessionToken, this.now());
    assert(session, 401, 'session_required');
    return session;
  }

  authenticateMutation(sessionToken, csrfToken) {
    const session = this.authenticate(sessionToken);
    assert(typeof csrfToken === 'string' && csrfToken.length > 0 && hash(csrfToken) === session.csrf_hash, 403, 'csrf_invalid');
    return session;
  }

  restoreSession(sessionToken) {
    const session = this.authenticate(sessionToken);
    const { csrfToken, sessionExpiresAt, deliveryIds } = this.#sessionResponse(session, sessionToken);
    return { csrfToken, sessionExpiresAt, deliveryIds };
  }

  getDelivery(sessionToken, deliveryId, proofToken = null) {
    const session = this.authenticate(sessionToken);
    this.#authorizeDelivery(session.id, deliveryId);
    const delivery = this.db.prepare('SELECT id,stage,revision,baseline_at AS baselineAt,eta_at AS etaAt,expires_at AS expiresAt,deliverable FROM deliveries WHERE id=?').get(deliveryId);
    assert(delivery && delivery.expiresAt > this.now(), 404, 'delivery_not_found');
    delivery.deliverable = Boolean(delivery.deliverable);
    let subscription = null;
    let registration = null;
    if (proofToken) {
      const installation = this.db.prepare('SELECT id,active,provider,project_id,fid_version FROM installations WHERE proof_hash=?').get(hash(proofToken));
      if (installation) {
        registration = {
          active: installation.active === 1,
          provider: installation.provider,
          projectId: installation.project_id,
          fidVersion: installation.fid_version,
        };
        const row = this.db.prepare(`SELECT expires_at AS expiresAt,revoked_at AS revokedAt FROM subscriptions
          WHERE delivery_id=? AND installation_id=?`).get(deliveryId, installation.id);
        if (row) {
          const revoked = row.revokedAt != null;
          const expired = row.expiresAt <= this.now();
          const consentActive = !revoked && !expired;
          subscription = {
            active: installation.active === 1 && consentActive,
            consentActive,
            providerActive: installation.active === 1,
            status: revoked ? 'revoked' : expired ? 'expired' : 'active',
            revoked,
            expired,
            expiresAt: row.expiresAt,
            fidVersion: installation.fid_version,
          };
        }
      }
    }
    return { delivery, subscription, registration };
  }

  registerInstallation(sessionToken, csrfToken, proofToken, { fid, provider = 'fcm', projectId, expectedFidVersion = null, bootstrapKey = null }) {
    this.authenticateMutation(sessionToken, csrfToken);
    assert(provider === 'fcm' && fid && projectId, 400, 'registration_invalid');
    const now = this.now();
    return transaction(this.db, () => {
      let installation = proofToken ? this.db.prepare('SELECT * FROM installations WHERE proof_hash=?').get(hash(proofToken)) : null;
      if (proofToken) assert(installation, 401, 'installation_required');
      let rawProof = proofToken;
      if (!installation) {
        assert(typeof bootstrapKey === 'string' && bootstrapKey.length >= 16 && bootstrapKey.length <= 128, 400, 'bootstrap_key_required');
        assert(expectedFidVersion == null || expectedFidVersion === 0, 409, 'fid_version_conflict');
        const bootstrapHash = hash(bootstrapKey);
        installation = this.db.prepare('SELECT * FROM installations WHERE bootstrap_key_hash=?').get(bootstrapHash);
        if (installation) {
          assert(installation.fcm_fid === fid && installation.project_id === projectId && installation.provider === provider, 409, 'bootstrap_payload_conflict');
          assert(installation.proof_retry_until > now && installation.proof_recovery_cipher, 410, 'bootstrap_retry_expired');
          return {
            proofToken: decrypt(installation.proof_recovery_cipher),
            installationId: installation.id,
            fidVersion: installation.fid_version,
            active: installation.active === 1,
          };
        }
        rawProof = token();
        installation = { id: id(), fid_version: 1 };
        this.db.prepare(`INSERT INTO installations(id,proof_hash,provider,project_id,fcm_fid,fid_version,active,created_at,updated_at,bootstrap_key_hash,proof_recovery_cipher,proof_retry_until)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(installation.id, hash(rawProof), provider, projectId, fid, 1, 1, now, now, bootstrapHash, encrypt(rawProof), now + INSTALLATION_BOOTSTRAP_RETRY);
      } else if (installation.fcm_fid !== fid || installation.project_id !== projectId) {
        assert(expectedFidVersion === installation.fid_version, 409, 'fid_version_conflict');
        this.db.prepare(`UPDATE installations SET project_id=?,fcm_fid=?,fid_version=fid_version+1,active=1,updated_at=? WHERE id=?`)
          .run(projectId, fid, now, installation.id);
        installation.fid_version += 1;
      } else if (installation.active !== 1) {
        this.db.prepare('UPDATE installations SET active=1,updated_at=? WHERE id=?').run(now, installation.id);
      }
      return { proofToken: rawProof, installationId: installation.id, fidVersion: installation.fid_version, active: true };
    });
  }

  subscribe(sessionToken, csrfToken, proofToken, deliveryId, consentVersion = 'pilot-v1') {
    const session = this.authenticateMutation(sessionToken, csrfToken);
    this.#authorizeDelivery(session.id, deliveryId);
    const installation = this.#installation(proofToken);
    const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
    const now = this.now();
    assert(delivery.expires_at > now, 410, 'delivery_expired');
    return transaction(this.db, () => {
      let subscription = this.db.prepare('SELECT * FROM subscriptions WHERE delivery_id=? AND installation_id=?').get(deliveryId, installation.id);
      if (subscription) {
        this.db.prepare(`UPDATE subscriptions SET consent_version=?,subscribed_at=?,expires_at=?,revoked_at=NULL WHERE id=?`)
          .run(consentVersion, now, delivery.expires_at, subscription.id);
      } else {
        subscription = { id: id() };
        this.db.prepare(`INSERT INTO subscriptions(id,delivery_id,installation_id,consent_version,subscribed_at,expires_at)
          VALUES (?,?,?,?,?,?)`).run(subscription.id, deliveryId, installation.id, consentVersion, now, delivery.expires_at);
      }
      return { active: true, expiresAt: delivery.expires_at };
    });
  }

  unsubscribe(sessionToken, csrfToken, proofToken, deliveryId) {
    const session = this.authenticateMutation(sessionToken, csrfToken);
    this.#authorizeDelivery(session.id, deliveryId);
    const installation = this.#installation(proofToken, false);
    const now = this.now();
    return transaction(this.db, () => {
      const subscription = this.db.prepare('SELECT id FROM subscriptions WHERE delivery_id=? AND installation_id=?').get(deliveryId, installation.id);
      if (subscription) {
        this.db.prepare('UPDATE subscriptions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now, subscription.id);
        this.db.prepare(`UPDATE outbox SET status='cancelled',updated_at=?
          WHERE subscription_id=? AND status IN ('queued','retrying')`).run(now, subscription.id);
      }
      return { active: false, boundary: 'sending_or_unknown_may_arrive' };
    });
  }

  enqueueSelfTest(sessionToken, csrfToken, proofToken, deliveryId, idempotencyKey) {
    const session = this.authenticateMutation(sessionToken, csrfToken);
    this.#authorizeDelivery(session.id, deliveryId);
    const installation = this.#installation(proofToken);
    assert(idempotencyKey && idempotencyKey.length <= 128, 400, 'idempotency_key_required');
    const now = this.now();
    return transaction(this.db, () => {
      const existing = this.db.prepare(`SELECT o.id AS outboxId,o.status,o.available_at AS sendAfter
        FROM self_test_requests r JOIN outbox o ON o.event_id=r.event_id
        WHERE r.session_id=? AND r.delivery_id=? AND r.idempotency_key=?`).get(session.id, deliveryId, idempotencyKey);
      if (existing) return existing;
      const recent = this.db.prepare('SELECT count(*) AS count FROM self_test_requests WHERE session_id=? AND created_at>?')
        .get(session.id, now - SELF_TEST_WINDOW).count;
      assert(recent < SELF_TEST_LIMIT, 429, 'self_test_rate_limited');
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
      assert(delivery.deliverable === 1, 409, 'delivery_not_deliverable');
      const subscription = this.db.prepare(`SELECT * FROM subscriptions
        WHERE delivery_id=? AND installation_id=? AND revoked_at IS NULL AND expires_at>?`).get(deliveryId, installation.id, now);
      assert(subscription, 409, 'active_subscription_required');
      const eventId = id();
      const outboxId = id();
      const sendAfter = now + this.selfTestDelayMs;
      this.db.prepare('INSERT INTO events(id,delivery_id,revision,type,stage_intent,created_at) VALUES (?,?,?,?,?,?)')
        .run(eventId, deliveryId, delivery.revision, 'self_test', null, now);
      this.db.prepare('INSERT INTO self_test_requests(session_id,delivery_id,idempotency_key,event_id,created_at) VALUES (?,?,?,?,?)')
        .run(session.id, deliveryId, idempotencyKey, eventId, now);
      this.db.prepare(`INSERT INTO outbox(id,event_id,subscription_id,notification_type,available_at,expires_at,deliverable,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(outboxId, eventId, subscription.id, 'self_test', sendAfter, Math.min(now + 300_000, delivery.expires_at), 1, 'queued', now, now);
      return { outboxId, status: 'queued', sendAfter };
    });
  }

  createAdminDelivery({ userId, stage = '배송대기', baselineAt = this.now(), etaAt = null, expiresAt = this.now() + DAY }, origin) {
    const now = this.now();
    assert(typeof userId === 'string' && /^test[-_a-z0-9]{1,59}$/i.test(userId), 400, 'test_user_required');
    assert(STAGES.includes(stage), 400, 'invalid_stage');
    assert(Number.isSafeInteger(baselineAt) && Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + DAY, 400, 'invalid_expiry');
    assert(etaAt == null || (Number.isSafeInteger(etaAt) && etaAt >= baselineAt), 400, 'invalid_eta');
    const fixture = this.createFixture({ userId, stage, baselineAt, etaAt, expiresAt });
    return {
      delivery: this.#adminDelivery(fixture.deliveryId),
      invite: { url: `${origin}/push-lab/#invite=${encodeURIComponent(fixture.inviteCode)}`, expiresAt: fixture.expiresAt },
    };
  }

  listAdminDeliveries({ limit = 50, cursor = null } = {}) {
    const count = Number(limit);
    assert(Number.isInteger(count) && count >= 1 && count <= 50, 400, 'invalid_limit');
    let before = null;
    if (cursor) {
      assert(typeof cursor === 'string' && cursor.length <= 512, 400, 'invalid_cursor');
      try {
        before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        assert(Array.isArray(before) && before.length === 2 && Number.isSafeInteger(before[0]) && typeof before[1] === 'string', 400, 'invalid_cursor');
      } catch { throw new ApiError(400, 'invalid_cursor'); }
    }
    const rows = this.db.prepare(`SELECT d.id,d.user_id AS userId,d.stage,d.revision,d.baseline_at AS baselineAt,d.eta_at AS etaAt,d.expires_at AS expiresAt,
      (SELECT count(*) FROM subscriptions s JOIN installations i ON i.id=s.installation_id
        WHERE s.delivery_id=d.id AND s.revoked_at IS NULL AND s.expires_at>? AND i.active=1) AS activeSubscriptions,
      (SELECT o.status FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.delivery_id=d.id ORDER BY o.created_at DESC,o.id DESC LIMIT 1) AS latestStatus
      FROM deliveries d WHERE d.scope='test' AND d.deliverable=1
      AND (? IS NULL OR d.baseline_at<? OR (d.baseline_at=? AND d.id<?))
      ORDER BY d.baseline_at DESC,d.id DESC LIMIT ?`).all(this.now(), before?.[0] ?? null, before?.[0] ?? null, before?.[0] ?? null, before?.[1] ?? null, count + 1);
    const page = rows.slice(0, count);
    const last = page.at(-1);
    return { deliveries: page, nextCursor: rows.length > count ? Buffer.from(JSON.stringify([last.baselineAt, last.id])).toString('base64url') : null };
  }

  getAdminDelivery(deliveryId) {
    const delivery = this.#adminDelivery(deliveryId);
    const now = this.now();
    const subscriptions = this.db.prepare(`SELECT s.id,
      CASE WHEN s.revoked_at IS NOT NULL THEN 'revoked' WHEN s.expires_at<=? THEN 'expired' ELSE 'active' END AS status,
      i.active AS providerActive,s.subscribed_at AS subscribedAt,s.expires_at AS expiresAt
      FROM subscriptions s JOIN installations i ON i.id=s.installation_id WHERE s.delivery_id=? ORDER BY s.subscribed_at DESC,s.id DESC`)
      .all(now, deliveryId).map((row) => ({ ...row, providerActive: Boolean(row.providerActive) }));
    const outbox = this.db.prepare(`SELECT o.id,o.event_id AS eventId,o.notification_type AS notificationType,o.status,o.attempts,
      o.available_at AS availableAt,o.updated_at AS updatedAt,o.last_error_class AS errorClass
      FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.delivery_id=? ORDER BY o.created_at DESC,o.id DESC LIMIT 50`).all(deliveryId);
    return { delivery, subscriptions, outbox };
  }

  reissueAdminInvitation(deliveryId, origin) {
    const now = this.now();
    return transaction(this.db, () => {
      const delivery = this.#adminDelivery(deliveryId);
      assert(delivery.expiresAt > now, 410, 'delivery_expired');
      this.db.prepare('UPDATE invitations SET expires_at=? WHERE delivery_id=? AND consumed_at IS NULL AND expires_at>?')
        .run(now, deliveryId, now);
      const inviteCode = token();
      const expiresAt = Math.min(now + 3_600_000, delivery.expiresAt);
      this.db.prepare('INSERT INTO invitations(id,code_hash,user_id,delivery_id,expires_at) VALUES (?,?,?,?,?)')
        .run(id(), hash(inviteCode), delivery.userId, deliveryId, expiresAt);
      return { invite: { url: `${origin}/push-lab/#invite=${encodeURIComponent(inviteCode)}`, expiresAt } };
    });
  }

  advanceAdminStage(deliveryId, { stage, expectedRevision, eventId }) {
    assert(UUID.test(eventId), 400, 'event_id_required');
    assert(Number.isInteger(expectedRevision) && expectedRevision >= 1, 400, 'invalid_revision');
    const delivery = this.#adminDelivery(deliveryId);
    const existing = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    if (existing) {
      assert(existing.delivery_id === deliveryId && existing.revision === expectedRevision + 1 && existing.type === 'stage_change' && existing.stage_intent === stage, 409, 'event_id_conflict');
      return { delivery: { id: deliveryId, stage, revision: existing.revision }, enqueued: 0 };
    }
    assert(delivery.expiresAt > this.now(), 410, 'delivery_expired');
    assert(STAGES.indexOf(stage) === STAGES.indexOf(delivery.stage) + 1, 409, 'stage_order_conflict');
    assert(delivery.revision === expectedRevision, 409, 'delivery_revision_conflict');
    this.emitEvent({ eventId, deliveryId, revision: expectedRevision + 1, stage, notificationType: 'stage_change', expiresAt: delivery.expiresAt, enqueue: false, cancelPending: true });
    return { delivery: { id: deliveryId, stage, revision: expectedRevision + 1 }, enqueued: 0 };
  }

  enqueueAdminTest(deliveryId, { subscriptionId, eventId, expectedRevision }) {
    assert(UUID.test(eventId), 400, 'event_id_required');
    assert(typeof subscriptionId === 'string' && subscriptionId.length > 0, 400, 'subscription_required');
    assert(Number.isInteger(expectedRevision) && expectedRevision >= 1, 400, 'invalid_revision');
    const now = this.now();
    return transaction(this.db, () => {
      const delivery = this.#adminDelivery(deliveryId);
      const existing = this.db.prepare(`SELECT e.*,o.id AS outboxId,o.status,o.subscription_id AS subscriptionId FROM events e
        LEFT JOIN outbox o ON o.event_id=e.id WHERE e.id=?`).get(eventId);
      if (existing) {
        assert(existing.delivery_id === deliveryId && existing.revision === expectedRevision && existing.type === 'manual_test'
          && existing.subscriptionId === subscriptionId, 409, 'event_id_conflict');
        return { eventId, outboxId: existing.outboxId, status: existing.status, enqueued: 1 };
      }
      assert(delivery.expiresAt > now, 410, 'delivery_expired');
      assert(delivery.revision === expectedRevision, 409, 'delivery_revision_conflict');
      assert(delivery.stage !== '배송 완료', 409, 'delivery_completed');
      const subscription = this.db.prepare(`SELECT s.id FROM subscriptions s JOIN installations i ON i.id=s.installation_id
        WHERE s.id=? AND s.delivery_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND i.active=1`).get(subscriptionId, deliveryId, now);
      assert(subscription, 404, 'subscription_not_found');
      const outboxId = id();
      this.db.prepare('INSERT INTO events(id,delivery_id,revision,type,stage_intent,created_at) VALUES (?,?,?,?,?,?)')
        .run(eventId, deliveryId, expectedRevision, 'manual_test', null, now);
      this.db.prepare(`INSERT INTO outbox(id,event_id,subscription_id,notification_type,available_at,expires_at,deliverable,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(outboxId, eventId, subscriptionId, 'manual_test', now, Math.min(now + 300_000, delivery.expiresAt), 1, 'queued', now, now);
      return { eventId, outboxId, status: 'queued', enqueued: 1 };
    });
  }

  #adminDelivery(deliveryId) {
    const row = this.db.prepare(`SELECT id,user_id AS userId,stage,revision,baseline_at AS baselineAt,eta_at AS etaAt,
      expires_at AS expiresAt FROM deliveries WHERE id=? AND scope='test' AND deliverable=1`).get(deliveryId);
    assert(row, 404, 'delivery_not_found');
    return row;
  }

  emitEvent({ eventId, deliveryId, revision, stage = null, notificationType, availableAt = this.now(), expiresAt, enqueue = true, cancelPending = false }) {
    const now = this.now();
    return transaction(this.db, () => {
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
      assert(delivery, 404, 'delivery_not_found');
      const existing = this.db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
      if (existing) {
        assert(existing.delivery_id === deliveryId
          && existing.revision === revision
          && existing.type === notificationType
          && existing.stage_intent === stage, 409, 'event_id_conflict');
        return { enqueued: 0 };
      } else {
        if (stage != null) {
          assert(revision === delivery.revision + 1, 409, 'delivery_revision_conflict');
          const changed = this.db.prepare('UPDATE deliveries SET stage=?,revision=? WHERE id=? AND revision=?')
            .run(stage, revision, deliveryId, delivery.revision);
          assert(changed.changes === 1, 409, 'delivery_revision_conflict');
          if (stage === '배송 완료' || cancelPending) {
            this.db.prepare(`UPDATE outbox SET status='cancelled',updated_at=? WHERE status IN ('queued','retrying')
              AND subscription_id IN (SELECT id FROM subscriptions WHERE delivery_id=?)`).run(now, deliveryId);
          }
        } else {
          assert(revision === delivery.revision, 409, 'delivery_revision_conflict');
        }
        this.db.prepare('INSERT INTO events(id,delivery_id,revision,type,stage_intent,created_at) VALUES (?,?,?,?,?,?)')
          .run(eventId, deliveryId, revision, notificationType, stage, now);
      }
      if (!enqueue || delivery.scope === 'deployment_probe' || !delivery.deliverable) return { enqueued: 0 };
      let enqueued = 0;
      const subscriptions = this.db.prepare(`SELECT * FROM subscriptions
        WHERE delivery_id=? AND revoked_at IS NULL AND expires_at>?`).all(deliveryId, now);
      for (const subscription of subscriptions) {
        const result = this.db.prepare(`INSERT OR IGNORE INTO outbox(id,event_id,subscription_id,notification_type,available_at,expires_at,deliverable,status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id(), eventId, subscription.id, notificationType, availableAt, Math.min(expiresAt, delivery.expires_at), 1, 'queued', now, now);
        enqueued += Number(result.changes);
      }
      return { enqueued };
    });
  }

  cleanupDeploymentProbe(deliveryId) {
    return transaction(this.db, () => {
      const delivery = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(deliveryId);
      assert(delivery && delivery.scope === 'deployment_probe' && delivery.deliverable === 0, 404, 'deployment_probe_not_found');
      const references = this.db.prepare(`SELECT
        (SELECT count(*) FROM session_deliveries WHERE delivery_id=?) AS sessions,
        (SELECT count(*) FROM subscriptions WHERE delivery_id=?) AS subscriptions,
        (SELECT count(*) FROM outbox o JOIN events e ON e.id=o.event_id WHERE e.delivery_id=?) AS outbox`)
        .get(deliveryId, deliveryId, deliveryId);
      assert(references.sessions === 0 && references.subscriptions === 0 && references.outbox === 0, 409, 'deployment_probe_in_use');
      this.db.prepare('DELETE FROM invitations WHERE delivery_id=?').run(deliveryId);
      this.db.prepare('DELETE FROM events WHERE delivery_id=?').run(deliveryId);
      this.db.prepare('DELETE FROM deliveries WHERE id=?').run(deliveryId);
      return { deliveryId, removed: true };
    });
  }

  #session(rawToken, now) {
    if (!rawToken) return null;
    return this.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(rawToken), now) || null;
  }

  #sessionResponse(session, rawSession) {
    const deliveryIds = this.db.prepare('SELECT delivery_id FROM session_deliveries WHERE session_id=? ORDER BY delivery_id')
      .all(session.id).map((row) => row.delivery_id);
    return { sessionToken: rawSession, csrfToken: decrypt(session.csrf_cipher), sessionExpiresAt: session.expires_at, deliveryIds };
  }

  #authorizeDelivery(sessionId, deliveryId) {
    assert(this.db.prepare('SELECT 1 FROM session_deliveries WHERE session_id=? AND delivery_id=?').get(sessionId, deliveryId), 404, 'delivery_not_found');
  }

  #installation(proofToken, requireActive = true) {
    assert(proofToken, 401, 'installation_required');
    const installation = this.db.prepare('SELECT * FROM installations WHERE proof_hash=?').get(hash(proofToken));
    assert(installation, 401, 'installation_required');
    if (requireActive) assert(installation.active === 1, 409, 'installation_inactive');
    return installation;
  }
}

export { ApiError };
