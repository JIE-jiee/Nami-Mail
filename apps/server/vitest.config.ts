import { defineConfig } from "vitest/config";

// light-my-request's inject() defaults every request's Host header to
// "localhost:80". The token-less Host allowlist in app.ts compares that header
// against the configured port, so tests must run with PORT=80 or every
// token-less route test would be rejected as a rebound authority. One knob
// here keeps all test files consistent without per-file env pinning.
export default defineConfig({
  test: {
    env: {
      PORT: "80",
    },
  },
});
