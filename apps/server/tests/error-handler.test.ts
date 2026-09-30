import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Generated per run so the fixture carries no credential literal.
const desktopSessionToken = `desktop-session-${randomUUID()}`;

// Fastify's inject stamps a synthetic default of "Host: localhost:80" on
// every request that does not carry an explicit host header, and the token-less
// Host allowlist in src/app.ts only accepts this server's own loopback
// authorities on the configured port. Pinning PORT=80 (hoisted above the src
// imports) keeps every inject-based case inside that allowlist, exactly as
// app.test.ts does.
vi.hoisted(() => {
  process.env.PORT = "80";
});

import { buildApp } from "../src/app.js";
import { openDatabase, type DatabaseHandle } from "../src/db.js";
import { setServerLogger } from "../src/logging.js";

type LoggedCall = { meta: object; message: string; error?: unknown };

describe("unhandled local API errors", () => {
  let app: FastifyInstance;
  let db: DatabaseHandle;
  let logged: LoggedCall[];

  beforeEach(async () => {
    logged = [];
    setServerLogger({
      info: (meta, message) => { logged.push({ meta, message }); },
      warn: (meta, message) => { logged.push({ meta, message }); },
      error: (meta, message) => { logged.push({ meta, message }); },
    });
    db = openDatabase(":memory:");
    app = await buildApp({ db, masterKey: Buffer.alloc(32, 3) });
  });

  afterEach(async () => {
    if (app) await app.close();
    if (db) db.close();
    setServerLogger(undefined);
  });

  it("answers an unwrapped handler failure with the ok/code/message contract", async () => {
    // A route whose handler throws before any try/catch — the shape a newly
    // added route gets for free from here on.
    app.get("/api/unwrapped-boom", async () => {
      throw new Error("connection to C:\\Users\\demo\\AppData\\nami-mail.sqlite failed: token=super-secret");
    });

    const response = await app.inject({ method: "GET", url: "/api/unwrapped-boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      code: "internal_error",
      message: "本地服务处理请求时发生错误，请稍后重试。",
    });
    // Neither the stack, the file path, nor the credential-ish text the
    // handler threw may reach the client.
    expect(response.body).not.toContain("C:\\Users\\demo");
    expect(response.body).not.toContain("super-secret");
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("statusCode");
  });

  it("records the unhandled failure in the server log with the request it came from", async () => {
    const failure = new Error("provider socket exploded");
    app.get("/api/unwrapped-logged", async () => { throw failure; });

    await app.inject({ method: "GET", url: "/api/unwrapped-logged?detail=1" });

    const record = logged.find((entry) => entry.message === "Unhandled local API error");
    expect(record).toBeDefined();
    // serverLog merges the failure under `err`, the key pino expands into a
    // full stack; the client only ever saw the fixed message.
    expect(record?.meta).toMatchObject({ method: "GET", statusCode: 500, err: failure });
  });

  it("keeps an error that already carries a 4xx status on Fastify's client-error path", async () => {
    // The boundary that must not move: a 4xx is a deliberate answer (Fastify's
    // own content-type, body-size and validation errors all land here), so its
    // status and body stay exactly what the default handler produces. Only
    // 5xx and status-less failures are re-shaped into the API contract.
    app.get("/api/client-error", async () => {
      throw Object.assign(new Error("Unsupported Media Type"), { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE" });
    });

    const response = await app.inject({ method: "GET", url: "/api/client-error" });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      statusCode: 415,
      error: "Unsupported Media Type",
      message: "Unsupported Media Type",
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    });
    expect(logged.some((entry) => entry.message === "Unhandled local API error")).toBe(false);
  });

  it("leaves the statuses handlers send themselves byte-for-byte unchanged", async () => {
    // These never enter the error handler at all (reply.send is a plain
    // response, not a throw), so the net above them must not have moved them.
    const protectedApp = await buildApp(
      { db, masterKey: Buffer.alloc(32, 3) },
      { localApiAccessToken: desktopSessionToken },
    );
    try {
      const unauthorized = await protectedApp.inject({ method: "GET", url: "/api/accounts" });
      const forbidden = await app.inject({ method: "GET", url: "/api/accounts", headers: { host: "evil.example:80" } });
      const missing = await app.inject({ method: "GET", url: "/api/does-not-exist" });
      const notReady = await app.inject({ method: "POST", url: "/api/agent/confirmations/confirmation-1", payload: { decision: "approve" } });

      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json()).toEqual({ ok: false, code: "local_api_unauthorized", message: "本地服务请求未获授权。" });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json()).toEqual({ ok: false, code: "local_api_forbidden_host", message: "本地服务拒绝了来自未授权来源的请求。" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ ok: false, message: "接口不存在。" });
      expect(notReady.statusCode).toBe(503);
      expect(notReady.json()).toEqual({ ok: false, code: "auto_reply_unavailable", message: "自动回复引擎当前不可用。" });
      expect(logged.filter((entry) => entry.message === "Unhandled local API error")).toHaveLength(0);
    } finally {
      await protectedApp.close();
    }
  });


  it("keeps a thrown non-Error value on the same unified path", async () => {
    app.get("/api/unwrapped-string", async () => { throw "raw string failure"; });

    const response = await app.inject({ method: "GET", url: "/api/unwrapped-string" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ ok: false, code: "internal_error" });
    expect(response.body).not.toContain("raw string failure");
  });
});
