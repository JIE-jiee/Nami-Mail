/**
 * Row-level access to `accounts` / `folders` for the HTTP layer.
 *
 * This module is a leaf (only type-only imports) so routes can depend on it
 * without inheriting the sync/agent graph. It exists because these queries
 * were duplicated across `routes/accounts.ts` (existence checks twice, the
 * 18-column password-account INSERT twice) and `routes/filter-rules.ts`, with
 * no shared place to fix a column or a collation once.
 */
import type { DatabaseHandle } from "./db.js";
import type { AccountRecord } from "./types.js";

export function accountById(db: DatabaseHandle, id: string): AccountRecord | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRecord | undefined;
}

export function accountExists(db: DatabaseHandle, id: string): boolean {
  return db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(id) !== undefined;
}

/** Case-insensitive lookup used to reject a duplicate mailbox before adding it. */
export function accountIdByEmail(db: DatabaseHandle, email: string): string | null {
  const row = db
    .prepare("SELECT id FROM accounts WHERE email = ? COLLATE NOCASE")
    .get(email) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listAccountRows(db: DatabaseHandle): AccountRecord[] {
  return db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as AccountRecord[];
}

export function listFolderRows(db: DatabaseHandle): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM folders ORDER BY account_id, name").all() as Array<Record<string, unknown>>;
}

/** Returns the number of updated rows, so the caller can turn 0 into a 404. */
export function updateAccountSignature(db: DatabaseHandle, id: string, signature: string): number {
  return db.prepare("UPDATE accounts SET signature = ? WHERE id = ?").run(signature, id).changes;
}

export type PasswordAccountInsert = {
  id: string;
  email: string;
  providerId: string;
  providerName: string;
  encryptedPassword: string;
  credentialCryptoVersion: number;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapTransport: string;
  imapUsername: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpTransport: string;
  smtpUsername: string;
  usernameMode: string;
  createdAt: string;
};

/** Inserts a password-authenticated mailbox row. OAuth flows use their own writer. */
export function insertPasswordAccountRow(db: DatabaseHandle, account: PasswordAccountInsert): void {
  db.prepare(
    `
        INSERT INTO accounts (
          id, email, provider, provider_name, encrypted_password, credential_crypto_version, auth_method,
          imap_host, imap_port, imap_secure, imap_transport, imap_username,
          smtp_host, smtp_port, smtp_secure, smtp_transport, smtp_username,
          username_mode, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'password', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
      `,
  ).run(
    account.id,
    account.email,
    account.providerId,
    account.providerName,
    account.encryptedPassword,
    account.credentialCryptoVersion,
    account.imapHost,
    account.imapPort,
    account.imapSecure ? 1 : 0,
    account.imapTransport,
    account.imapUsername,
    account.smtpHost,
    account.smtpPort,
    account.smtpSecure ? 1 : 0,
    account.smtpTransport,
    account.smtpUsername,
    account.usernameMode,
    account.createdAt,
  );
}
