import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { setServerLogger, type ServerLogSink } from "../src/logging.js";
import { OUTBOUND_SUBMISSION_RETENTION_DAYS, pruneExpiredOutboundSubmissions } from "../src/outbox-retention.js";
import { migrateOutboundSubmissionStorage, prepareSubmission } from "../src/outbox.js";

const DAY_MS = 86_400_000;
const now = new Date("2026-09-30T12:00:00.000Z");
const cutoffMs = now.getTime() - OUTBOUND_SUBMISSION_RETENTION_DAYS * DAY_MS;

function insertAccount(db: DatabaseHandle): void {
  db.prepare(`
    INSERT INTO accounts (
      id, email, provider, provider_name, encrypted_password,
      imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
      username_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-1", "sender@example.com", "custom", "Demo", "encrypted",
    "imap.example.com", 993, 1, "smtp.example.com", 465, 1,
    "email", "connected", new Date().toISOString(),
  );
}

function createSubmission(db: DatabaseHandle, masterKey: Buffer, key: string, sendAt?: string): string {
  const submission = prepareSubmission(db, masterKey, {
    accountId: "account-1",
    accountEmail: "sender@example.com",
    idempotencyKey: key,
    request: { to: ["recipient@example.com"], subject: "Status update", text: "Hello.", attachmentTokens: [] },
    ...(sendAt !== undefined ? { sendAt } : {}),
  }).submission;
  return submission.id;
}

/** Ages a row's created_at to an absolute instant and pins its status. */
function ageSubmission(db: DatabaseHandle, id: string, createdAtIso: string, status = "confirmed"): void {
  db.prepare("UPDATE outbound_submissions SET created_at = ?, updated_at = ?, status = ? WHERE id = ?")
    .run(createdAtIso, createdAtIso, status, id);
}

function submissionCount(db: DatabaseHandle): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM outbound_submissions").get() as { count: number }).count;
}

function bulkInsertOldSubmissions(db: DatabaseHandle, count: number, createdAtIso: string): void {
  const insert = db.prepare(`
    INSERT INTO outbound_submissions (
      id, account_id, idempotency_key, request_fingerprint, rfc_message_id, request_json,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `bulk-${index}`, "account-1", `sub_bulk_${index}`, `fp-${index}`,
        `<bulk-${index}@example.com>`, "{}", createdAtIso, createdAtIso,
      );
    }
  })();
}

describe("outbound submission retention (90 days)", () => {
  let db: DatabaseHandle;
  let masterKey: Buffer;
  const capturedWarns: Array<{ meta: object; message: string }> = [];
  const capturingLogger: ServerLogSink = {
    info: () => undefined,
    warn: (meta, message) => capturedWarns.push({ meta, message }),
    error: () => undefined,
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    masterKey = randomBytes(32);
    insertAccount(db);
    capturedWarns.length = 0;
    setServerLogger(capturingLogger);
  });

  afterEach(() => {
    setServerLogger(undefined);
    db.close();
  });

  it("prunes submissions older than the window and keeps those inside it", () => {
    const prunedId = createSubmission(db, masterKey, "sub_old");
    ageSubmission(db, prunedId, new Date(cutoffMs - 1).toISOString());
    const boundaryId = createSubmission(db, masterKey, "sub_boundary");
    ageSubmission(db, boundaryId, new Date(cutoffMs).toISOString());
    const freshId = createSubmission(db, masterKey, "sub_fresh");

    expect(pruneExpiredOutboundSubmissions(db, now)).toBe(1);
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(prunedId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(boundaryId)).toBeDefined();
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(freshId)).toBeDefined();
  });

  it("never prunes scheduled sends or in-flight submitting rows, however old", () => {
    const scheduledId = createSubmission(db, masterKey, "sub_scheduled", new Date(now.getTime() + 30 * DAY_MS).toISOString());
    ageSubmission(db, scheduledId, new Date(cutoffMs - DAY_MS).toISOString(), "pending");
    const submittingId = createSubmission(db, masterKey, "sub_submitting");
    ageSubmission(db, submittingId, new Date(cutoffMs - DAY_MS).toISOString(), "submitting");

    expect(pruneExpiredOutboundSubmissions(db, now)).toBe(0);
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(scheduledId)).toBeDefined();
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(submittingId)).toBeDefined();
  });

  it("prunes a backlog larger than one batch through repeated pages", () => {
    bulkInsertOldSubmissions(db, 2_500, new Date(cutoffMs - DAY_MS).toISOString());
    const freshId = createSubmission(db, masterKey, "sub_fresh");

    expect(pruneExpiredOutboundSubmissions(db, now)).toBe(2_500);
    expect(submissionCount(db)).toBe(1);
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(freshId)).toBeDefined();
  });

  it("cascades pruned submissions into their attachment join rows", () => {
    const id = createSubmission(db, masterKey, "sub_old_with_attachment");
    ageSubmission(db, id, new Date(cutoffMs - DAY_MS).toISOString());
    db.prepare(`
      INSERT INTO outbound_attachments (token, account_id, filename, content_type, size, storage_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("token-1", "account-1", "report.pdf", "application/pdf", 10, "storage-token-1", new Date(cutoffMs - DAY_MS).toISOString());
    db.prepare(`
      INSERT INTO outbound_attachment_submissions (attachment_token, account_id, submission_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run("token-1", "account-1", id, new Date(cutoffMs - DAY_MS).toISOString());

    expect(pruneExpiredOutboundSubmissions(db, now)).toBe(1);
    expect(db.prepare("SELECT 1 FROM outbound_attachment_submissions WHERE submission_id = ?").get(id)).toBeUndefined();
  });

  it("logs a warning and leaves rows in place when the prune fails, without throwing", () => {
    db.exec("DROP TABLE outbound_submissions");

    expect(pruneExpiredOutboundSubmissions(db, now)).toBe(-1);
    expect(capturedWarns).toHaveLength(1);
    expect(capturedWarns[0]!.message).toContain("retention prune failed");
  });

  it("runs from the startup migration path after its verification sweep", () => {
    const prunedId = createSubmission(db, masterKey, "sub_old");
    ageSubmission(db, prunedId, new Date(Date.now() - (OUTBOUND_SUBMISSION_RETENTION_DAYS + 1) * DAY_MS).toISOString());
    const freshId = createSubmission(db, masterKey, "sub_fresh");

    const result = migrateOutboundSubmissionStorage(db, masterKey);
    expect(result.migrated).toBe(0);
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(prunedId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM outbound_submissions WHERE id = ?").get(freshId)).toBeDefined();
    expect(capturedWarns).toHaveLength(0);
  });
});
