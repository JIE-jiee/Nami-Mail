import { describe, expect, it, vi } from "vitest";

import {
  acquireAccountWriteSlots,
  withAccountWriteLocks,
  withHeldWriteSlots,
} from "../src/sync-locks.js";

/** Releases are idempotent, so every path can run them defensively. */
function releaseAll(releases: Array<() => void>): void {
  for (const release of [...releases].reverse()) release();
}

describe("account write slot under saturation", () => {
  it("fails a burst of waiters on a wedged account over a window, well before the client budget", async () => {
    vi.useFakeTimers();
    const WAITERS = 60;
    const STEP_MS = 10;
    let releaseHolder!: () => void;
    try {
      // One operation that never releases its slot — a provider command that
      // will never answer — and the burst of writes queued behind it.
      const holder = new Promise<void>((resolve) => { releaseHolder = resolve; });
      const holding = withAccountWriteLocks(["herd-1"], () => holder);
      await vi.advanceTimersByTimeAsync(0);

      // Fake timers move the clock for the waiters; the test stamps each
      // rejection with the step it fired in, so no test has to trust Date.
      let clock = 0;
      let settled = 0;
      const waiters = Array.from({ length: WAITERS }, (_, index) =>
        withAccountWriteLocks(["herd-1"], async () => `served-${index}`).then(
          (served) => { settled += 1; return { served, at: -1 }; },
          (error: Error) => { settled += 1; return { error: error.message, at: clock }; },
        ),
      );
      // Every waiter is queued, and every wait is still open.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(0);

      // Walk the clock well past the client budget so a slot wait that is not
      // tiered below it fails an assertion here instead of hanging.
      for (let elapsed = 0; elapsed < 35_000; elapsed += STEP_MS) {
        await vi.advanceTimersByTimeAsync(STEP_MS);
        clock += STEP_MS;
      }
      const results = await Promise.all(waiters);
      const failedAt = results.map((result) => result.at);

      // Nobody was served behind a holder that never let go, and every failure
      // names the account instead of surfacing as a bare timeout.
      expect(results.every((result) => "error" in result)).toBe(true);
      expect(new Set(results.map((result) => ("error" in result ? result.error : ""))).size).toBe(1);
      expect("error" in results[0]! ? results[0].error : "").toMatch(
        /Timed out waiting for the account herd-1 write slot/,
      );

      // Not the old behaviour: every waiter armed the same deadline as the
      // queue it joined, so all 60 rejections landed inside one millisecond.
      expect(new Set(failedAt).size).toBeGreaterThan(WAITERS / 2);
      expect(Math.max(...failedAt) - Math.min(...failedAt)).toBeGreaterThan(1_000);

      // Tiered below the renderer's 30s request budget, so the server gives up
      // first and the real reason still has budget left to reach the UI.
      expect(Math.max(...failedAt)).toBeLessThan(30_000);
      expect(Math.max(...failedAt)).toBeLessThanOrEqual(13_200);

      // A wedged account does not poison the chain: later writes still run.
      releaseHolder();
      await holding;
      await withAccountWriteLocks(["herd-1"], async () => undefined);
    } finally {
      releaseHolder?.();
      vi.useRealTimers();
    }
  });

  it("serves 200 concurrent writes on one account in strict FIFO order", async () => {
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        withAccountWriteLocks(["fifo-1"], async () => {
          order.push(index);
        }),
      ),
    );
    expect(order).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  it("keeps peak concurrency at the number of accounts, not the number of writers", async () => {
    const accounts = ["peak-1", "peak-2", "peak-3", "peak-4"];
    let active = 0;
    let peak = 0;
    const runs: Array<Promise<void>> = [];
    for (let round = 0; round < 20; round += 1) {
      for (const accountId of accounts) {
        runs.push(
          withAccountWriteLocks([accountId], async () => {
            active += 1;
            peak = Math.max(peak, active);
            // Yield so same-account writers really do pile up behind each other.
            await new Promise((resolve) => setTimeout(resolve, 0));
            active -= 1;
          }),
        );
      }
    }
    await Promise.all(runs);
    expect(peak).toBe(4);
  });

  it("completes every overlapping multi-account acquisition instead of deadlocking", async () => {
    const groups = [
      ["multi-1", "multi-2"],
      ["multi-2", "multi-3"],
      ["multi-3", "multi-1"],
      ["multi-1", "multi-3", "multi-4"],
      ["multi-4", "multi-2"],
      ["multi-2", "multi-4", "multi-1"],
    ];
    const acquired: string[] = [];
    const outcome = await Promise.race([
      Promise.all(
        groups.map((group) =>
          withAccountWriteLocks(group, async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            acquired.push(group.join("+"));
          }),
        ),
      ).then(() => "completed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("completed");
    expect(acquired).toHaveLength(groups.length);
  });

  it("does not self-deadlock when an executor re-enters the lock for the account it already holds", async () => {
    // The operation queue's shape: the slot is taken first, then the executor
    // runs in a held-slot context where its own nested acquisition must be a
    // no-op instead of waiting on the gate it is holding — with 50 writers
    // queued behind it, exactly as a saturated account would look.
    const releases = await acquireAccountWriteSlots(["held-1"]);
    try {
      const queued = Array.from({ length: 50 }, () => withAccountWriteLocks(["held-1"], async () => undefined));
      const outcome = await Promise.race([
        withHeldWriteSlots(["held-1"], async () =>
          withAccountWriteLocks(["held-1"], async () => "executor-done"),
        ),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1_000)),
      ]);
      expect(outcome).toBe("executor-done");
      releaseAll(releases);
      await Promise.all(queued);
    } finally {
      releaseAll(releases);
    }
  });
});
