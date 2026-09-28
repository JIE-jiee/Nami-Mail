import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuntimeContext } from "../types.js";
import { validationMessage } from "../helpers.js";
import { resolveBimiLogo } from "../avatars/bimi.js";
import { buildBimiPersistence, pruneBimiLogoCache } from "../avatars/bimi-cache-store.js";

export type AvatarRouteDeps = {
  context: RuntimeContext;
  log: FastifyInstance["log"];
};

/**
 * Sender-avatar lookups that must run server-side: BIMI brand logos need DNS
 * TXT queries, which the browser cannot perform. Read-only and independent of
 * the mail store; the renderer caches results per domain.
 */
export function registerAvatarRoutes(app: FastifyInstance, deps: AvatarRouteDeps): void {
  const persistence = buildBimiPersistence(deps.context.db);
  try {
    pruneBimiLogoCache(deps.context.db);
  } catch (error) {
    // Pruning is hygiene, not correctness — stale rows are ignored anyway.
    deps.log.warn({ err: error }, "bimi_logo_cache pruning failed");
  }

  app.get("/api/avatars/bimi/:domain", async (request, reply) => {
    const parsed = z.object({ domain: z.string().trim().min(4).max(253) }).strict().safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ ok: false, message: validationMessage(parsed.error) });
    const resolution = await resolveBimiLogo(parsed.data.domain, persistence);
    if (!resolution.ok) return { ok: false };
    return { ok: true, logo: resolution.logo };
  });
}
