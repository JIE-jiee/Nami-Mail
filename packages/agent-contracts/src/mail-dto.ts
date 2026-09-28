import { z } from "zod";

/**
 * Wire DTOs of the local mail API.
 *
 * These schemas mirror the JSON payloads of `GET/POST /api/...` one field at a
 * time; they are the single authority shared by the server (producer) and the
 * web client (consumer). They are compile-time contracts today: neither side
 * runtime-parses responses, so a field added here must also be added to the
 * producer and vice versa — TypeScript enforces it at the annotated seams
 * (`publicAccount`, `messageRow`).
 *
 * Deliberately out of scope: encrypted-at-rest columns (`encrypted_password`,
 * `*_enc`), snake_case DB columns, and the `folders` extension the web client
 * attaches to `AccountWire` (see `apps/web/src/types.ts`).
 */

export const mailAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const messageAttachmentSchema = z.object({
  partId: z.string(),
  filename: z.string(),
  contentType: z.string(),
  size: z.number(),
  related: z.boolean(),
  disposition: z.enum(["attachment", "inline"]),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

export const folderSchema = z.object({
  path: z.string(),
  name: z.string(),
  specialUse: z.string().nullable(),
  total: z.number(),
  unseen: z.number(),
});
export type Folder = z.infer<typeof folderSchema>;

/**
 * The account as `publicAccount` serializes it: credentials stripped, snake_case
 * folded to camelCase, `authMethod` carried through from `auth_method`.
 * The web client extends this with `folders: Folder[]`.
 */
export const accountWireSchema = z.object({
  id: z.string(),
  email: z.string(),
  provider: z.string(),
  providerName: z.string(),
  authMethod: z.enum(["password", "oauth2"]),
  status: z.string(),
  lastError: z.string().nullable(),
  lastErrorCode: z.string().nullish(),
  lastSyncWarningCode: z.string().nullish(),
  lastSyncedAt: z.string().nullable(),
  signature: z.string(),
  createdAt: z.string(),
});
export type AccountWire = z.infer<typeof accountWireSchema>;

export const messageSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  accountEmail: z.string(),
  providerName: z.string(),
  mailbox: z.string(),
  uid: z.number(),
  /** Confirmed as archived, including a verified pending move. */
  archived: z.boolean().optional(),
  /** A move is reconciling; actions requiring stable folder membership stay disabled. */
  movePending: z.boolean().optional(),
  /** The server confirmed a move but cannot safely identify the target UID. */
  moveLocationUnverified: z.boolean().optional(),
  subject: z.string(),
  from: mailAddressSchema,
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  /** RFC Message-ID, when the provider supplied one. */
  messageId: z.string().nullish(),
  /** RFC In-Reply-To header, retained for re-opening a reply draft. */
  inReplyTo: z.string().nullish(),
  /** RFC References chain, retained for reply threading. */
  references: z.array(z.string()).optional(),
  sentAt: z.string(),
  snippet: z.string(),
  textBody: z.string(),
  htmlBody: z.string(),
  flags: z.array(z.string()),
  seen: z.boolean(),
  flagged: z.boolean(),
  hasAttachments: z.boolean(),
  attachments: z.array(messageAttachmentSchema),
  size: z.number(),
  /** Local "snoozed until" marker; while set the message is hidden from the unified inbox. */
  snoozedUntil: z.string().nullish(),
});
export type Message = z.infer<typeof messageSchema>;

export const contactSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  notes: z.string(),
  autoCollected: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const statsSchema = z.object({
  accounts: z.number(),
  messages: z.number(),
  unread: z.number(),
  starred: z.number().optional(),
  snoozed: z.number().optional(),
  attachments: z.number().optional(),
});
export type Stats = z.infer<typeof statsSchema>;
