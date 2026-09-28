const fs = require("node:fs");

const files = [
  "apps/web/src/AccountsDialog.clipboard.test.tsx",
  "apps/web/src/AgentMemoryDialog.test.tsx",
  "apps/web/src/AgentWorkspace.integration.test.tsx",
  "apps/web/src/AutoReplyPendingDialog.test.tsx",
  "apps/web/src/ComposeModal.test.tsx",
  "apps/web/src/FilterRulesSection.test.tsx",
  "apps/web/src/ManagementDialogs.test.tsx",
  "apps/web/src/MessageList.test.tsx",
  "apps/web/src/SendingStatusModal.test.tsx",
  "apps/web/src/accountHealth.test.tsx",
  "apps/web/src/agentContext.test.ts",
  "apps/web/src/mailListState.test.ts",
];

for (const p of files) {
  const text = fs.readFileSync(p, "utf8");
  const eol = (text.match(/\r\n/g) || []).length > 0 ? "\r\n" : "\n";
  const lines = text.split(eol);
  let inserted = 0;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = lines[i].match(/^(\s*)provider: "[^"]+",\s*$/);
    if (m) {
      const next = lines[i + 1] || "";
      if (!/authMethod:/.test(next)) {
        out.push(`${m[1]}authMethod: "password",`);
        inserted++;
      }
    }
  }
  if (inserted === 0) throw new Error(`${p}: 未找到 provider 行，需人工确认`);
  fs.writeFileSync(p, out.join(eol), "utf8");
  console.log(`${p}: +${inserted} authMethod`);
}
console.log("done");
