import { isIP } from "node:net";

/**
 * True for hostnames that only this machine can answer to.
 *
 * Used to decide whether a user-supplied endpoint may use plain `http://`
 * instead of `https://`: a loopback endpoint never leaves the machine, so
 * talking to a local LLM or translation service in the clear is acceptable.
 * Anything else must be https.
 *
 * This is deliberately NOT the same decision as `config.ts`'s bind-host check:
 * that one guards the `HOST` environment variable at startup (raw string, may
 * carry brackets) and additionally accepts IPv4-mapped forms. Keep the two
 * apart — merging them would change which hosts are allowed to bind.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return Number(normalized.split(".", 1)[0]) === 127;
}
