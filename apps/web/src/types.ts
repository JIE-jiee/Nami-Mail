import {
  appSettingsCoreDefaults,
  type AccountWire,
  type AppSettingsCore,
} from "@nami/agent-contracts";

// Mail wire DTOs are single-sourced in @nami/agent-contracts (zod schema authority,
// consumed at compile time). Do not redeclare them here — extend the contract
// package instead so server and web cannot drift.
import type {
  Contact,
  Folder,
  MailAddress,
  Message,
  MessageAttachment,
  Stats,
} from "@nami/agent-contracts";

export type {
  Contact,
  Folder,
  MailAddress,
  Message,
  MessageAttachment,
  Stats,
};

/**
 * `AccountWire` as `publicAccount` serializes it, plus the `folders` payload
 * that GET /api/accounts assembles per account. (The add-account response
 * omits `folders`; consumers treat an empty list accordingly.)
 */
export type Account = AccountWire & { folders: Folder[] };

export type OutboundAttachment = {
  token: string;
  filename: string;
  contentType: string;
  size: number;
};

export type OutboundSubmissionStatus = "pending" | "submitting" | "submitted" | "confirmed" | "unknown_delivery" | "failed";

/** A local record of one user-initiated SMTP submission. It deliberately omits mail body content. */
export type OutboundSubmission = {
  id: string;
  accountId: string;
  messageId: string;
  /** Optional display-only summary decrypted by the local service; never includes body content. */
  subject?: string | null;
  recipients?: string[];
  deliveryStatus: OutboundSubmissionStatus;
  /** ISO time a scheduled send should leave the local queue, when this is a scheduled send. */
  sendAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  postSubmitWarning: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProviderInfo = {
  id: string;
  name: string;
  domains: string[];
  credentialHint: string;
  credentialName: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  basicAuthLimited: boolean;
  /** A supported interactive authorization route, when the provider has one. */
  oauthProvider?: OAuthProvider | null;
  /** Whether this Nami Mail installation has that authorization route configured. */
  oauthAvailable?: boolean;
  family?: string;
  priority?: "P0" | "P1" | "P2" | string;
  authMethods?: string[];
  recommendedAuthMethod?: string;
  credentialLabel?: string;
  helpText?: string;
  caveat?: string;
  capabilities?: { imap: boolean; smtp: boolean; pop: boolean; apis: string[] };
  /** Legacy shared rule retained for older providers. */
  usernameMode?: "email" | "local";
  imapUsernameMode?: "email" | "local";
  smtpUsernameMode?: "email" | "local";
  imap?: MailServerPreset;
  smtp?: MailServerPreset;
};

export type MailTransport = "tls" | "starttls";

export type MailServerPreset = {
  host: string;
  port: number;
  transport: MailTransport;
  secure?: boolean;
};

export type ManualMailServerConfig = MailServerPreset & {
  username: string;
};

export type ManualAccountConfig = {
  imap: ManualMailServerConfig;
  smtp: ManualMailServerConfig;
};

export type ProviderDiscovery = {
  id: string;
  name: string;
  family: string;
  priority?: string;
  domain: string;
  isCustom: boolean;
  source: string;
  confidence: string;
  authMethods: string[];
  recommendedAuthMethod?: string;
  credentialLabel: string;
  credentialName: string;
  credentialHint: string;
  helpText?: string;
  caveat?: string;
  setupSteps: string[];
  helpUrl?: string;
  helpLabel?: string;
  usernameMode: "email" | "local";
  imapUsernameMode?: "email" | "local";
  smtpUsernameMode?: "email" | "local";
  basicAuthLimited: boolean;
  capabilities: { imap: boolean; smtp: boolean; pop: boolean; apis: string[] };
  imap: MailServerPreset;
  smtp: MailServerPreset;
};

export type OAuthProvider = "google" | "microsoft";

export type AccountDiscoveryResult = {
  ok: boolean;
  provider: ProviderDiscovery;
  oauthProvider?: OAuthProvider | null;
  oauthAvailable: boolean;
};

export type OAuthAttempt = {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type OAuthAttemptStatus = {
  status: "pending" | "success" | "error" | "expired";
  accountId?: string;
  code?: string;
  message?: string;
};

export type FilterRuleCondition =
  | { kind: "from"; value: string }
  | { kind: "to"; value: string }
  | { kind: "subject"; value: string }
  | { kind: "has_attachments"; value: boolean };

export type FilterRuleAction =
  | { kind: "mark_seen" }
  | { kind: "add_flag" }
  | { kind: "archive" }
  | { kind: "move_to_folder"; folderPath: string };

export type FilterRule = {
  id: string;
  name: string;
  enabled: boolean;
  /** null applies the rule to every account; otherwise only that account. */
  accountId: string | null;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type FilterRuleInput = {
  name: string;
  accountId?: string | null;
  enabled?: boolean;
  conditions: FilterRuleCondition[];
  actions: FilterRuleAction[];
};

export type FilterRuleUpdate = Partial<FilterRuleInput>;

export type ContactInput = {
  email: string;
  name?: string;
  notes?: string;
};

export type ContactUpdate = Partial<ContactInput>;

/** A local mail template. Name/subject/body are encrypted at rest by the local service. */
export type MailTemplate = {
  id: string;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  /** True for templates shipped with the app and not yet edited by the user. */
  builtin?: boolean;
};

export type MailTemplateInput = {
  name: string;
  subject?: string;
  body: string;
};

export type MailTemplateUpdate = Partial<MailTemplateInput>;

export const calendarEventColors = ["blue", "green", "amber", "red", "purple", "teal"] as const;
export type CalendarEventColor = typeof calendarEventColors[number];

/** A local calendar event. Timestamps are UTC ISO strings. */
export type CalendarEvent = {
  id: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  color: CalendarEventColor;
  createdAt: string;
  updatedAt: string;
};

export type CalendarEventInput = {
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  color?: CalendarEventColor;
};

export type CalendarEventUpdate = Partial<CalendarEventInput>;

export type {
  AgentAccessLevel,
  AppTheme,
  BackgroundPreset,
  CloseBehavior,
  ListDensity,
  NotificationSound,
  SyncMessageLimit,
} from "@nami/agent-contracts";

export type AutoReplyMode = "llm" | "template";

export type AutoReplyScopeField = "from" | "domain" | "subject";
export type AutoReplyScopeOperator = "contains" | "not-contains" | "equals";
export type AutoReplyScopeAction = "reply" | "ignore";

export type AutoReplyScopeRule = {
  id: string;
  field: AutoReplyScopeField;
  op: AutoReplyScopeOperator;
  value: string;
  action: AutoReplyScopeAction;
  enabled: boolean;
};

export type AutoReplyScope = {
  contactsOnly: boolean;
  startDate: string | null;
  endDate: string | null;
  threadOnce: boolean;
  rules: AutoReplyScopeRule[];
};

export type AutoReplyTemplate = {
  text: string;
  skipConfirmation: boolean;
};

export type AutoReplyConfig = {
  enabled: boolean;
  /** Mailbox scope selected by the user; empty means nothing is monitored. */
  accountIds: string[];
  /** llm = Agent drafts each reply; template = fixed template with placeholder substitution. */
  mode: AutoReplyMode;
  template: AutoReplyTemplate;
  scope: AutoReplyScope;
  /** LLM-mode auto-replies are always drafted for user confirmation before sending. */
  requireConfirmation: boolean;
  /** Per-account daily cap on confirmed auto-replies. */
  dailyLimitPerAccount: number;
};

/** Mirrors the server-side decline reasons surfaced by the auto-reply review dialog. */
export type AutoReplyDecisionReason =
  | "screening" | "scope" | "low-value" | "sensitive" | "user-rejected"
  | "daily-cap" | "llm-failed" | "send-failed" | "no-template" | "expired";

export type AutoReplyDecisionRecord = {
  id: string;
  accountId: string;
  reason: AutoReplyDecisionReason;
  fromAddress: string;
  fromName: string;
  subject: string;
  detail: string;
  occurredAt: string;
};

/**
 * Derived from the shared settings contract (`AppSettingsCore`) plus the
 * server-derived wire fields. `autoReply` keeps the web-local shape because
 * the contract's scope carries optional dates.
 */
export type AppSettings = AppSettingsCore & {
  autoReply: AutoReplyConfig;
  /** The cap actually applied, after the SYNC_MESSAGE_LIMIT environment override. */
  effectiveSyncMessageLimit: number | null;
  customBackgroundUrl: string | null;
  autoReplyInvalid: boolean;
  updatedAt: string;
};

export type AppSettingsPatch = Partial<Pick<
  AppSettings,
  "theme" | "locale" | "backgroundPreset" | "backgroundIntensity" | "notificationsEnabled" | "notifyWhenFocused" | "notificationSound" | "refreshIntervalSeconds" | "realtimePushEnabled" | "syncMessageLimit" | "closeBehavior" | "launchAtStartup" | "globalShortcutEnabled" | "agentToolRoundLimit" | "listDensity" | "avatarGravatarEnabled" | "avatarBimiEnabled" | "agentAccessLevel" | "agentCliAccessLevel" | "agentMcpAccessLevel" | "autoReply"
>>;

export const defaultAppSettings: AppSettings = {
  ...appSettingsCoreDefaults,
  autoReply: {
    enabled: false,
    accountIds: [],
    mode: "llm",
    template: { text: "", skipConfirmation: false },
    scope: { contactsOnly: false, startDate: null, endDate: null, threadOnce: true, rules: [] },
    requireConfirmation: true,
    dailyLimitPerAccount: 30,
  },
  effectiveSyncMessageLimit: null,
  customBackgroundUrl: null,
  autoReplyInvalid: false,
  updatedAt: "",
};
