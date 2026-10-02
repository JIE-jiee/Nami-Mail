import { describe, expect, it } from "vitest";
import { autoReplyDecisionReasons, outboundSubmissionStatuses } from "@nami/agent-contracts";
import { openDatabase, type DatabaseHandle } from "../src/db.js";

/**
 * The enum columns' CHECK constraints are verbatim SQL strings in db.ts; the
 * wire vocabulary they gate lives in @nami/agent-contracts. These assertions
 * keep the two from drifting: the constraint's value set must equal the
 * contract array's set exactly (membership, not order — SQLite never reads it
 * as an ordered list).
 */

function checkValueSet(db: DatabaseHandle, table: string, constraint: RegExp): string[] {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row) throw new Error(`Table ${table} is missing from the schema.`);
  const match = row.sql.match(constraint);
  if (!match) throw new Error(`No CHECK (… IN (…)) constraint found for ${table}.`);
  return match[1]!
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!value.startsWith("'") || !value.endsWith("'")) throw new Error(`Unexpected CHECK literal: ${value}`);
      return value.slice(1, -1);
    });
}

describe("schema enum CHECK constraints match the contract vocabulary", () => {
  it("outbound_submissions.status carries exactly the contract submission statuses", () => {
    const db = openDatabase(":memory:");
    try {
      expect(checkValueSet(db, "outbound_submissions", /status [^;]*?CHECK \(status IN \(([^)]*)\)\)/).sort())
        .toEqual([...outboundSubmissionStatuses].sort());
    } finally {
      db.close();
    }
  });

  it("auto_reply_decisions.reason carries exactly the contract decision reasons", () => {
    const db = openDatabase(":memory:");
    try {
      expect(checkValueSet(db, "auto_reply_decisions", /reason [^;]*?CHECK \(reason IN \(([^)]*)\)\)/).sort())
        .toEqual([...autoReplyDecisionReasons].sort());
    } finally {
      db.close();
    }
  });
});
