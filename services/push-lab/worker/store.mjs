import { id } from '../server/crypto.mjs';
import { transaction } from '../server/db.mjs';

export class WorkerStore {
  constructor(db, { now = () => Date.now(), leaseMs = 60_000, maxAttempts = 3, retryBaseMs = 1_000, retryMaxMs = 60_000, random = Math.random } = {}) {
    this.db = db;
    this.now = now;
    this.leaseMs = leaseMs;
    this.maxAttempts = maxAttempts;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.random = random;
  }

  acquire(owner) {
    const now = this.now();
    return transaction(this.db, () => {
      const current = this.db.prepare("SELECT * FROM worker_state WHERE name='sender'").get();
      if (current && current.owner !== owner && current.lease_until > now) return null;
      const version = (current?.version || 0) + 1;
      this.db.prepare(`INSERT INTO worker_state(name,owner,version,lease_until,heartbeat_at) VALUES ('sender',?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,version=excluded.version,lease_until=excluded.lease_until,heartbeat_at=excluded.heartbeat_at`)
        .run(owner, version, now + this.leaseMs, now);
      return { owner, version, leaseUntil: now + this.leaseMs };
    });
  }

  heartbeat(lease) {
    const now = this.now();
    const result = this.db.prepare(`UPDATE worker_state SET lease_until=?,heartbeat_at=?
      WHERE name='sender' AND owner=? AND version=? AND lease_until>?`).run(now + this.leaseMs, now, lease.owner, lease.version, now);
    return result.changes === 1;
  }

  release(lease) {
    const now = this.now();
    const result = this.db.prepare(`UPDATE worker_state SET lease_until=?,heartbeat_at=?
      WHERE name='sender' AND owner=? AND version=?`).run(now, now, lease.owner, lease.version);
    return result.changes === 1;
  }

  claim(lease) {
    const now = this.now();
    return transaction(this.db, () => {
      const activeLease = this.db.prepare(`SELECT 1 FROM worker_state WHERE name='sender' AND owner=? AND version=? AND lease_until>?`)
        .get(lease.owner, lease.version, now);
      if (!activeLease) return null;
      // Expired sends are terminally quarantined for explicit operator policy; never auto-resend them.
      this.db.prepare(`UPDATE outbox SET status='unknown',last_error_class='worker_lost',owner=NULL,lease_until=NULL,updated_at=?
        WHERE status='sending' AND lease_until<=?`).run(now, now);
      this.db.prepare(`UPDATE outbox SET status='expired',updated_at=? WHERE status IN ('queued','retrying') AND expires_at<=?`).run(now, now);
      this.db.prepare(`UPDATE outbox SET status='cancelled',updated_at=? WHERE status IN ('queued','retrying') AND (
        deliverable=0 OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.id=outbox.subscription_id AND (s.revoked_at IS NOT NULL OR s.expires_at<=?))
        OR EXISTS (SELECT 1 FROM events e JOIN deliveries d ON d.id=e.delivery_id WHERE e.id=outbox.event_id AND (d.deliverable=0 OR d.expires_at<=? OR d.revision<>e.revision))
      )`).run(now, now, now);
      const item = this.db.prepare(`SELECT o.*,s.delivery_id,i.fcm_fid,i.fid_version
        FROM outbox o
        JOIN subscriptions s ON s.id=o.subscription_id
        JOIN installations i ON i.id=s.installation_id AND i.active=1
        JOIN events e ON e.id=o.event_id
        JOIN deliveries d ON d.id=e.delivery_id
        WHERE o.deliverable=1 AND d.deliverable=1 AND o.status IN ('queued','retrying')
          AND o.available_at<=? AND (o.retry_at IS NULL OR o.retry_at<=?) AND o.expires_at>?
          AND s.revoked_at IS NULL AND s.expires_at>? AND d.expires_at>? AND d.revision=e.revision
        ORDER BY o.available_at,o.created_at LIMIT 1`).get(now, now, now, now, now);
      if (!item) return null;
      const version = item.version + 1;
      const claimed = this.db.prepare(`UPDATE outbox SET status='sending',owner=?,version=?,lease_until=?,selected_fid=?,selected_fid_version=?,attempts=attempts+1,updated_at=?
        WHERE id=? AND version=? AND status IN ('queued','retrying')`).run(lease.owner, version, now + this.leaseMs, item.fcm_fid, item.fid_version, now, item.id, item.version);
      if (claimed.changes !== 1) return null;
      const attemptId = id();
      this.db.prepare('INSERT INTO send_attempts(id,outbox_id,attempt_number,started_at) VALUES (?,?,?,?)')
        .run(attemptId, item.id, item.attempts + 1, now);
      return { ...item, owner: lease.owner, attemptId, version, attempts: item.attempts + 1, selected_fid: item.fcm_fid, selected_fid_version: item.fid_version };
    });
  }

  finish(item, { messageId = null, errorClass = null, retryAfterMs = null }) {
    const now = this.now();
    return transaction(this.db, () => {
      const current = this.db.prepare(`SELECT o.*,s.revoked_at,s.expires_at AS subscription_expires_at
        FROM outbox o JOIN subscriptions s ON s.id=o.subscription_id WHERE o.id=?`).get(item.id);
      if (!current || current.status !== 'sending' || current.owner !== item.owner || current.version !== item.version) return false;
      let status = 'accepted';
      let retryAt = null;
      if (errorClass) {
        if (errorClass === 'unknown') status = 'unknown';
        else if (current.revoked_at != null || current.subscription_expires_at <= now) status = 'cancelled';
        else if (['transient', 'rate_limited'].includes(errorClass) && current.attempts < this.maxAttempts && current.expires_at > now + 1_000) {
          const exponential = this.retryBaseMs * (2 ** (current.attempts - 1));
          const cappedBackoff = Math.min(this.retryMaxMs, exponential * (0.5 + this.random()));
          const candidateRetryAt = now + Math.max(retryAfterMs || 0, cappedBackoff);
          if (candidateRetryAt >= current.expires_at) status = 'expired';
          else {
            status = 'retrying';
            retryAt = candidateRetryAt;
          }
        } else status = 'failed';
      }
      this.db.prepare(`UPDATE outbox SET status=?,retry_at=?,last_error_class=?,provider_message_id=?,owner=NULL,lease_until=NULL,updated_at=?
        WHERE id=? AND owner=? AND version=?`).run(status, retryAt, errorClass, messageId, now, item.id, item.owner, item.version);
      this.db.prepare(`UPDATE send_attempts SET finished_at=?,result=?,provider_message_id=?,error_class=? WHERE id=?`)
        .run(now, status, messageId, errorClass, item.attemptId);
      if (errorClass === 'invalid_registration') {
        this.db.prepare(`UPDATE installations SET active=0,updated_at=?
          WHERE id=(SELECT installation_id FROM subscriptions WHERE id=?) AND active=1 AND fcm_fid=? AND fid_version=?`)
          .run(now, current.subscription_id, current.selected_fid, current.selected_fid_version);
      }
      return true;
    });
  }

  markUnknown(item) {
    return this.finish(item, { errorClass: 'unknown' });
  }
}
