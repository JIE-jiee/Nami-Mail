import { describe, expect, it } from "vitest";
import viteConfig from "./vite.config";

/**
 * Dev proxy policy: the local API's token-less Host allowlist
 * (apps/server/src/app.ts, isTrustedTokenlessHost) only accepts the server's
 * own loopback authorities on the configured port. http-proxy forwards the
 * browser's Host header untouched unless changeOrigin is set, so a dev server
 * on :5173 used to hand the backend `Host: localhost:5173` and every /api call
 * came back 403 — invisible to the app.test.ts suite, whose 86 inject() cases
 * bypass a real socket and stamp their own host header.
 *
 * The guard is deliberately not relaxed (that reopens DNS rebinding), so the
 * proxy has to present the target's own authority instead. This test pins that
 * contract at the only place it is expressed.
 */
describe("vite dev server proxy", () => {
  const proxy = viteConfig.server?.proxy?.["/api"];

  it("proxies /api through an object target so proxy options survive", () => {
    // The string shorthand ("/api": "http://127.0.0.1:3187") accepts no
    // options at all; assert the object form first so a silent revert to the
    // shorthand cannot pass on the target string alone.
    expect(typeof proxy).toBe("object");
    expect(proxy).toMatchObject({ target: "http://127.0.0.1:3187" });
  });

  it("rewrites the forwarded Host to the target origin", () => {
    // Removing changeOrigin restores http-proxy's default (pass the browser's
    // Host through), which is the regression this test exists to catch.
    expect(proxy).toMatchObject({ changeOrigin: true });
  });

  it("targets an authority the token-less Host allowlist accepts", () => {
    // changeOrigin makes the backend see `Host: <target.host>`, so the target
    // must name 127.0.0.1 / localhost / [::1] on the server's configured
    // port (apps/server/src/config.ts, config.port) or the guard answers 403.
    const target = new URL(String((proxy as { target: string }).target));
    expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
    expect(target.port).toBe("3187");
  });
});
