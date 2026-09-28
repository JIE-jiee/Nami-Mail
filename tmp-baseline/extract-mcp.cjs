const fs = require("node:fs");

const path = "apps/server/src/agent-service.ts";
const text = fs.readFileSync(path, "utf8");
const crlf = (text.match(/\r\n/g) || []).length;
const lf = (text.match(/\n/g) || []).length;
if (crlf !== lf || crlf === 0) throw new Error(`行尾异常 CRLF=${crlf} LF=${lf}`);
const eol = "\r\n";
const lines = text.split(eol);

function expect(no, expected) {
  if (lines[no - 1] !== expected) {
    throw new Error(`第 ${no} 行漂移\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(lines[no - 1])}`);
  }
}

// ---- 边界断言（原始行号） ----
expect(76, 'import { McpStdioClient, probeMcpServer, type McpServerCapabilities } from "./agent/mcp-client.js";');
expect(77, "import {");
expect(81, "  type AgentMcpServerCheck,");
expect(85, '} from "./agent/mcp-server-store.js";');
expect(86, 'import { createMcpAgentTools } from "./agent/mcp-tool-adapter.js";');
expect(212, "export type AgentMcpServerList = {");
expect(220, "};");
expect(659, "  private readonly mcpServers: AgentMcpServerStore;");
expect(679, "  // Live external MCP server processes and the registry names they contributed.");
expect(683, "  private mcpSyncPromise: Promise<AgentMcpSyncReport> | null = null;");
expect(687, "    this.mcpServers = new AgentMcpServerStore(options.db, options.masterKey);");
expect(719, "    ]);");
expect(842, "    for (const client of this.mcpClients.values()) client.close();");
expect(845, "    this.mcpFingerprints.clear();");
expect(879, "  mcpServerList(): AgentMcpServerList {");
expect(1050, "  }");
expect(1916, "      const externalMcpToolNames = this.externalMcpToolNames();");

// ---- 一次性降序删除/替换 ----
const delegates = [
  "  mcpServerList(): AgentMcpServerList {",
  "    return this.mcpManager.list();",
  "  }",
  "",
  "  createMcpServer(input: AgentMcpServerInput): AgentMcpServerSummary {",
  "    return this.mcpManager.create(input);",
  "  }",
  "",
  "  updateMcpServer(id: string, input: AgentMcpServerInput): AgentMcpServerSummary {",
  "    return this.mcpManager.update(id, input);",
  "  }",
  "",
  "  async checkMcpServer(id: string, signal?: AbortSignal): Promise<AgentMcpServerSummary> {",
  "    return this.mcpManager.check(id, signal);",
  "  }",
  "",
  "  deleteMcpServer(id: string): void {",
  "    this.mcpManager.delete(id);",
  "  }",
  "",
  "  async syncMcpServers(signal?: AbortSignal): Promise<AgentMcpSyncReport> {",
  "    return this.mcpManager.sync(signal);",
  "  }",
];
const typeReExport = [
  '// MCP 域已抽至 agent/mcp-server-manager.ts；类型在此再导出以保持公共面不变。',
  'export type { AgentMcpServerList, AgentMcpSyncReport } from "./agent/mcp-server-manager.js";',
];

const ops = [
  [1916, 1, ["      const externalMcpToolNames = this.mcpManager.externalToolNames();"]],
  [879, 172, delegates],
  [842, 4, ["    this.mcpManager.dispose();"]],
  [719, 1, ["    ]);", "    this.mcpManager = new AgentMcpServerManager(options.db, options.masterKey, this.tools);"]],
  [687, 1, []],
  [679, 5, []],
  [659, 1, ["  private readonly mcpManager: AgentMcpServerManager;"]],
  [212, 9, typeReExport],
  [86, 1, ['import { AgentMcpServerManager } from "./agent/mcp-server-manager.js";']],
  [77, 9, ['import { type AgentMcpServerInput, type AgentMcpServerSummary } from "./agent/mcp-server-store.js";']],
  [76, 1, []],
];
for (const [start, remove, insert] of ops) {
  console.log(`@${start}: -${remove} +${insert.length}`);
  lines.splice(start - 1, remove, ...insert);
}

let out = lines.join(eol);
const before = (text.match(/(?:\r\n){3,}/g) || []).length;
if (before !== 0) throw new Error(`原文件已存在 ${before} 处三连换行`);
out = out.replace(/(?:\r\n){3,}/g, eol + eol);

fs.writeFileSync(path, out, "utf8");
console.log("done. lines:", out.split(eol).length, "(was", text.split(eol).length + ")");
