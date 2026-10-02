import type { AccountDiscoveryResult, OAuthProvider, ProviderDiscovery, ProviderInfo } from "./types";

/**
 * Add-account entry decision: whether the OAuth panel, the password field, or
 * the discovery pending state renders for the current form state.
 *
 * Extracted from AddAccountModal so the chain is unit-testable as a pure
 * function (apps/web/src/oauth-entry.test.ts). Three deliberate deviations
 * from the historical inline chain:
 * - `providerPrefersOAuth` no longer requires `oauthAvailable`, so a missing
 *   Microsoft client id still renders the panel where its disabled note and
 *   the one-time setup guidance live.
 * - `authMethods` falls back to `matchedProvider ?? selectedProvider`, so a
 *   selected provider card classifies the credential before discovery runs.
 * - `oauthOnly` reads only `authMethods`, matching the server's
 *   `isOAuthOnlyProvider` rule, so an incomplete email on an oauth-only
 *   provider (e.g. `@outlook.com`) no longer flashes a misleading password
 *   field.
 */

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(value: string): boolean {
  return emailPattern.test(value.trim());
}

/** The provider fields the decision reads (keeps test fixtures minimal). */
export type ProviderEntryInfo = Pick<ProviderInfo, "id" | "authMethods" | "oauthAvailable">;

/** The discovery fields the decision reads. */
export type DiscoveryEntryInfo = Pick<ProviderDiscovery, "id" | "family" | "authMethods" | "recommendedAuthMethod">;

/** The discovery result fields the decision reads. */
export type DiscoveryResultEntry = Pick<AccountDiscoveryResult, "oauthProvider" | "oauthAvailable">;

export type OAuthEntryInput = {
  discoveryEmail: string;
  normalizedEmail: string;
  discovery: DiscoveryResultEntry | null;
  activeDiscovery: DiscoveryEntryInfo | undefined;
  matchedProvider: ProviderEntryInfo | undefined;
  selectedProvider: ProviderEntryInfo | undefined;
  /** Selected catalog id ("" / CUSTOM_IMAP_PROVIDER_ID / a preset id); drives `usingPassword`. */
  selectedProviderId: string;
  explicitAuthMode: "oauth" | "password" | null;
  manualOpen: boolean;
  isGmail: boolean;
};

export type OAuthEntry = {
  activeOAuthProvider: OAuthProvider | null | undefined;
  oauthAvailable: boolean;
  authMethods: string[];
  oauthOnly: boolean;
  canUsePassword: boolean;
  providerPrefersOAuth: boolean;
  showOAuthPanel: boolean;
  usingPassword: boolean;
  needsProviderDiscovery: boolean;
};

export function providerAuthMethods(provider?: Pick<ProviderInfo, "id" | "authMethods">): string[] {
  if (provider?.authMethods?.length) return provider.authMethods;
  if (provider?.id === "gmail") return ["app-password", "oauth2"];
  if (provider?.id === "microsoft") return ["oauth2"];
  return ["app-password"];
}

export function oauthProviderFor(provider: Pick<ProviderDiscovery, "id" | "family">): OAuthProvider | undefined {
  if (provider.id === "gmail" || provider.family === "google") return "google";
  if (provider.id === "microsoft" || provider.family === "microsoft") return "microsoft";
  return undefined;
}

export function resolveOAuthEntry(input: OAuthEntryInput): OAuthEntry {
  const {
    discoveryEmail,
    normalizedEmail,
    discovery,
    activeDiscovery,
    matchedProvider,
    selectedProvider,
    selectedProviderId,
    explicitAuthMode,
    manualOpen,
    isGmail,
  } = input;

  const activeOAuthProvider = discoveryEmail === normalizedEmail && discovery
    ? discovery.oauthProvider
    : activeDiscovery ? oauthProviderFor(activeDiscovery) : undefined;
  const oauthAvailable = discoveryEmail === normalizedEmail && discovery
    ? discovery.oauthAvailable
    : matchedProvider?.oauthAvailable ?? true;
  const needsProviderDiscovery = validEmail(normalizedEmail) && !matchedProvider && discoveryEmail !== normalizedEmail;
  const authMethods = activeDiscovery?.authMethods ?? providerAuthMethods(matchedProvider ?? selectedProvider);
  const oauthOnly = authMethods.length > 0 && authMethods.every((method) => method === "oauth2");
  const canUsePassword = !oauthOnly;
  const providerPrefersOAuth = Boolean(
    activeOAuthProvider && activeDiscovery?.recommendedAuthMethod !== "app-password" && !isGmail
  );
  const showOAuthPanel = Boolean(
    activeOAuthProvider && !manualOpen && (explicitAuthMode === "oauth" || (explicitAuthMode === null && providerPrefersOAuth))
  );
  const usingPassword = (validEmail(normalizedEmail) || Boolean(selectedProviderId) || Boolean(matchedProvider))
    && !needsProviderDiscovery
    && canUsePassword
    && (manualOpen || !showOAuthPanel);

  return {
    activeOAuthProvider,
    oauthAvailable,
    authMethods,
    oauthOnly,
    canUsePassword,
    providerPrefersOAuth,
    showOAuthPanel,
    usingPassword,
    needsProviderDiscovery,
  };
}
