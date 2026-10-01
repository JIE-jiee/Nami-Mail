import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = join(import.meta.dirname, "..", "..");

import { resolve } from "node:path";

function dependenciesOf(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.dependencies ?? {};
}

// `file:` specifiers are written relative to each manifest, so the same
// workspace package reads differently from root vs apps/server. Compare the
// resolved absolute target instead of the literal range.
function normalizedRange(range, manifestDir) {
  if (!range.startsWith("file:")) return range;
  return resolve(manifestDir, range.slice("file:".length));
}

test("root runtime dependencies stay in lockstep with apps/server", () => {
  // Why the duplicates exist at all: electron-builder collects production
  // dependencies from the ROOT manifest when packing the installer, so the
  // runtime deps must be declared here too even though apps/server is their
  // real owner (see ARCHITECTURE-ROADMAP §3, "新增运行时依赖需同步根清单").
  //
  // The failure mode this guards against is silent drift: bumping fastify in
  // one manifest but not the other resolves to two different major trees at
  // install time and ships a stale server. Keep the two maps identical.
  const rootManifestDir = repoRoot;
  const serverManifestDir = join(repoRoot, "apps", "server");
  const root = dependenciesOf(join(serverManifestDir, "..", "..", "package.json"));
  const server = dependenciesOf(join(serverManifestDir, "package.json"));

  assert.deepEqual(
    Object.keys(root).sort(),
    Object.keys(server).sort(),
    "root and apps/server must declare the exact same runtime dependency set",
  );
  for (const [name, rootRange] of Object.entries(root)) {
    const rootNormalized = normalizedRange(rootRange, rootManifestDir);
    const serverNormalized = normalizedRange(server[name], serverManifestDir);
    assert.equal(
      rootNormalized,
      serverNormalized,
      `version range drift for ${name}: root=${rootRange} server=${server[name]}`,
    );
  }
});
