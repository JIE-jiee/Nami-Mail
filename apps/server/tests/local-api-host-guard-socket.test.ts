import fs from "node:fs";
import { request as httpRequest } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Type-only imports: erased at compile time, so they do not evaluate config.js
// before the port below is in place.
import type { buildApp } from "../src/app.js";
import type { config } from "../src/config.js";
import type { openDatabase } from "../src/db.js";

/**
 * Token-less Host allowlist over a real socket.
 *
 * Every Host case in app.test.ts goes through light-my-request's inject(),
 * which bypasses the listener and stamps its own host header — so the suite
 * proves the predicate but never the wire form a browser or a dev proxy
 * actually produces. That gap is how a real regression shipped: the web dev
 * server forwarded its own `Host: localhost:5173` to the local API (http-proxy
 * does not rewrite Host unless changeOrigin is set) and every /api call came
 * back 403 under `npm run dev`, with all 86 inject-based cases still green.
 *
 * These cases drive a bound TCP listener with an explicit Host header, so the
 * guard is exercised the way the dev proxy shape reaches it.
 *
 * The port is discovered before src/config.js is evaluated, because config.port
 * is frozen at module load and the allowlist compares the header against it.
 * That is why every runtime import below is dynamic: a value import would
 * evaluate config with the vitest-level PORT=80 pin and never bind a matching
 * port.
 */

type BuildApp = typeof buildApp;
type AppConfig = typeof config;
type OpenDatabase = typeof openDatabase;

let build: BuildApp;
let appConfig: AppConfig;
let open: OpenDatabase;
let boundPort = 0;

/** Asks the OS for a free loopback port the way a desktop host would. */
async function freeLoopbackPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port from the probe server.");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

function getWithHost(host: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    // Node only synthesizes a Host header when the caller did not set one, so
    // this is the exact authority the guard sees on the wire.
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: boundPort,
      method: "GET",
      path: "/api/accounts",
      headers: { host },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("token-less Host allowlist over a real socket", () => {
  const originalPort = process.env.PORT;
  let app: Awaited<ReturnType<BuildApp>>;
  let db: ReturnType<OpenDatabase>;
  let backgroundDirectory = "";

  beforeAll(async () => {
    boundPort = await freeLoopbackPort();
    process.env.PORT = String(boundPort);
    ({ buildApp: build } = await import("../src/app.js"));
    ({ config: appConfig } = await import("../src/config.js"));
    ({ openDatabase: open } = await import("../src/db.js"));
    expect(appConfig.port).toBe(boundPort);

    db = open(":memory:");
    backgroundDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nami-mail-host-guard-"));
    app = await build({ db, masterKey: Buffer.alloc(32, 7), backgroundDirectory });
    await app.listen({ host: "127.0.0.1", port: boundPort });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
    expect(address.port).toBe(boundPort);
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) db.close();
    if (backgroundDirectory) fs.rmSync(backgroundDirectory, { recursive: true, force: true });
    // Leave the process-wide pin the vitest config installs for inject-based
    // suites intact for any file this worker runs next.
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
  });

  it("serves a token-less request whose Host is the bound loopback authority", async () => {
    const response = await getWithHost(`127.0.0.1:${boundPort}`);

    expect(response.statusCode).toBe(200);
  });

  it("accepts the localhost name on the bound port", async () => {
    const response = await getWithHost(`localhost:${boundPort}`);

    expect(response.statusCode).toBe(200);
  });

  it("refuses a token-less request whose Host is a dev server's port", async () => {
    // This is the shape a dev proxy produces when it forwards the browser's
    // Host verbatim: the peer is loopback, the authority is not this server's.
    const response = await getWithHost("127.0.0.1:5180");

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: "local_api_forbidden_host" });
  });

  it("refuses a rebound authority even on the bound port", async () => {
    const response = await getWithHost(`rebound.example.test:${boundPort}`);

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ ok: false, code: "local_api_forbidden_host" });
  });
});
