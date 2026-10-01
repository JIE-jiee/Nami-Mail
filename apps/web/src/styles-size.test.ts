import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("styles.css size ratchet", () => {
  // ESLint 无法解析 CSS，巨型文件的 max-lines 棘轮在这里续上：
  // 只允许瘦身，不允许继续增长。瘦身时请同步下调此阈值。
  // 2026-10-01 有记录的一次上调（18_440 → 18_483）：服务商磁贴条为
  // "选中非核心服务商后保持可见" 增加 display 分支、surfaced 入场动画
  // 与 has-surfaced 高度档（含窄窗覆盖）；下轮 CSS 瘦身时应优先收回。
  const FROZEN_MAX_LINES = 18_483;

  it("does not grow beyond the frozen baseline", () => {
    const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
    const lines = css.split("\n").length;
    expect(lines).toBeLessThanOrEqual(FROZEN_MAX_LINES);
    // 防止阈值与实际值脱节后被人遗忘：当前值应始终留在阈值下方但附近。
    expect(lines).toBeGreaterThan(FROZEN_MAX_LINES - 400);
  });
});
