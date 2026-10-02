import type { DatabaseHandle } from "./db.js";
import { serverLog } from "./logging.js";

// Product decision (2026-09): outbound submission records are send history,
// not an audit ledger, so they are kept for 90 days and pruned at startup.
// The conversation/audit tables of the Agent store stay append-only by
// design and are intentionally untouched by this module.
export const OUTBOUND_SUBMISSION_RETENTION_DAYS = 90;

// Rows deleted per statement. Each DELETE autocommits, so a large backlog
// prunes as many short transactions instead of one startup-blocking long one.
const PRUNE_BATCH_SIZE = 1_000;

type PrunePageRow = { rowid: number };

/**
 * Deletes outbound submissions older than the retention window and returns
 * the number of rows removed (-1 when the prune failed).
 *
 * Age column: `created_at`. It is NOT NULL, written by every insert path
 * (prepareSubmission and the legacy bulk rows alike), and both this cutoff
 * and the stored values are `Date.toISOString()` output, so the plain TEXT
 * comparison is chronological. `submitted_at`/`confirmed_at` are nullable
 * and unset for rows that never reached SMTP, so they cannot serve here.
 *
 * Status guard: rows in `pending` are read by the background scheduler
 * (scheduled-send.ts picks up `status = 'pending' AND send_at IS NOT NULL`),
 * so pruning them would silently cancel scheduled sends, and rows in
 * `submitting` are converted to `unknown_delivery` by
 * recoverInterruptedSubmissions() at startup — pruning them first would erase
 * the uncertain-delivery record. Both states self-resolve; their rows become
 * prunable on a later startup. Every other status older than the window goes.
 *
 * Mount point: the tail of migrateOutboundSubmissionStorage() — after its
 * verification sweep and outside its migration transaction. The prune is not
 * a migration: it has no marker and is not one-shot, so its failure must not
 * alter migration semantics, which is why this function never throws — a
 * failure logs a warning and startup proceeds with the existing rows.
 *
 * Backup note: routes/backup.ts streams only message RFC822 sources via IMAP;
 * outbound_submissions is not part of any backup export (verified by grep),
 * so pruning changes nothing a restore could bring back — records past the
 * window are unrecoverable by design, which is the accepted trade-off.
 *
 * Batching: keyset pagination over rowid (the cursor advances past the page
 * just deleted, so total work stays O(N) — same pattern as the verification
 * sweep in outbox.ts) instead of one unbounded DELETE, whose journal would
 * grow with the backlog. `PRAGMA foreign_keys = ON` (db.ts) cascades each
 * deletion into outbound_attachment_submissions, so no attachment-token rows
 * are orphaned.
 */
export function pruneExpiredOutboundSubmissions(db: DatabaseHandle, now: Date = new Date()): number {
  try {
    const cutoff = new Date(now.getTime() - OUTBOUND_SUBMISSION_RETENTION_DAYS * 86_400_000).toISOString();
    const selectPage = db.prepare(`
      SELECT rowid FROM outbound_submissions
      WHERE rowid > ? AND created_at < ?
        AND status NOT IN ('pending', 'submitting')
      ORDER BY rowid LIMIT ?
    `);
    let cursor = 0;
    let pruned = 0;
    for (;;) {
      const page = selectPage.all(cursor, cutoff, PRUNE_BATCH_SIZE) as PrunePageRow[];
      if (page.length === 0) break;
      const placeholders = page.map(() => "?").join(", ");
      pruned += db.prepare(
        `DELETE FROM outbound_submissions WHERE rowid IN (${placeholders})`,
      ).run(...page.map((row) => row.rowid)).changes;
      cursor = page[page.length - 1]!.rowid;
      if (page.length < PRUNE_BATCH_SIZE) break;
    }
    return pruned;
  } catch (error) {
    serverLog.warn(
      { retentionDays: OUTBOUND_SUBMISSION_RETENTION_DAYS },
      "Outbound submission retention prune failed; existing records are kept",
      error,
    );
    return -1;
  }
}
