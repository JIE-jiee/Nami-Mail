/**
 * MCP server lifecycle for the Agent: CRUD over the encrypted server store,
 * stdio process connect/disconnect, and tool registration into the shared
 * Tool Registry.
 *
 * Extracted verbatim from AgentService (the #108 pattern): the manager owns
 * its store and process maps, AgentService keeps one-line delegates so its
 * public surface — and the agent-mcp-servers test suite — stay untouched.
 * `AgentService.close()` delegates to `dispose()`.
 */
import type { DatabaseHandle } from "../db.js";
import { AgentServiceError } from "./agent-shared.js";
import { McpStdioClient, probeMcpServer, type McpServerCapabilities } from "./mcp-client.js";
import {
  AgentMcpServerStore,
  AgentMcpServerStoreError,
  configurationFingerprint,
  type AgentMcpServerCheck,
  type AgentMcpServerConfiguration,
  type AgentMcpServerInput,
  type AgentMcpServerSummary,
} from "./mcp-server-store.js";
import { createMcpAgentTools } from "./mcp-tool-adapter.js";
import type { ToolRegistry } from "@nami/agent-core";

export type AgentMcpServerList = {
  items: AgentMcpServerSummary[];
};

/** Result of a one-shot external MCP server synchronization pass. */
export type AgentMcpSyncReport = {
  connected: string[];
  failed: Array<{ id: string; label: string; error: string }>;
};

export class AgentMcpServerManager {
  private readonly servers: AgentMcpServerStore;
  // Live external MCP server processes and the registry names they contributed.
  private readonly mcpClients = new Map<string, McpStdioClient>();
  private readonly mcpServerToolNames = new Map<string, string[]>();
  private readonly mcpFingerprints = new Map<string, string>();
  private mcpSyncPromise: Promise<AgentMcpSyncReport> | null = null;

  constructor(
    db: DatabaseHandle,
    masterKey: Buffer,
    private readonly tools: ToolRegistry,
  ) {
    this.servers = new AgentMcpServerStore(db, masterKey);
  }

  list(): AgentMcpServerList {
    return { items: this.servers.list() };
  }

  create(input: AgentMcpServerInput): AgentMcpServerSummary {
    try {
      return this.servers.save(input);
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  update(id: string, input: AgentMcpServerInput): AgentMcpServerSummary {
    try {
      if (!this.servers.get(id)) throw new AgentMcpServerStoreError("NOT_FOUND", "MCP 服务器配置不存在。", 404);
      const updated = this.servers.save(input, id);
      // The configuration changed; drop any live process so the next run reconnects.
      this.disconnect(id);
      return updated;
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  async check(id: string, signal?: AbortSignal): Promise<AgentMcpServerSummary> {
    let configuration: AgentMcpServerConfiguration;
    try {
      const stored = this.servers.get(id);
      if (!stored) throw new AgentMcpServerStoreError("NOT_FOUND", "MCP 服务器配置不存在。", 404);
      configuration = stored;
    } catch (error) {
      throw this.mapStoreError(error);
    }
    const fingerprint = configurationFingerprint(configuration);
    const probe = await probeMcpServer({
      command: configuration.command,
      args: configuration.args,
      env: configuration.env,
      ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
      connectTimeoutMs: Math.min(configuration.timeoutMs, 15_000),
      requestTimeoutMs: configuration.timeoutMs,
    }, { signal });
    if (signal?.aborted) throw new AgentServiceError("CANCELLED", "MCP 服务器连接检查已取消。", 499, true);
    const checkedAt = new Date().toISOString();
    const check: AgentMcpServerCheck = probe.ok
      ? {
        ok: true,
        toolCount: probe.toolCount,
        toolNames: probe.toolNames,
        ...(probe.capabilities ? { serverInfo: probe.capabilities.serverInfo } : {}),
        checkedAt,
      }
      : { ok: false, toolNames: [], error: probe.error, checkedAt };
    try {
      return this.servers.saveCheck(id, fingerprint, check);
    } catch (error) {
      throw this.mapStoreError(error);
    }
  }

  delete(id: string): void {
    try {
      if (!this.servers.remove(id)) throw new AgentMcpServerStoreError("NOT_FOUND", "MCP 服务器配置不存在。", 404);
    } catch (error) {
      throw this.mapStoreError(error);
    }
    this.disconnect(id);
  }

  /**
   * Connects enabled MCP servers and registers their tools into the shared
   * Tool Registry. Runs are serialized through mcpSyncPromise so concurrent
   * Agent turns share one synchronization pass.
   */
  async sync(signal?: AbortSignal): Promise<AgentMcpSyncReport> {
    if (this.mcpSyncPromise) return this.mcpSyncPromise;
    this.mcpSyncPromise = this.performSync(signal);
    try {
      return await this.mcpSyncPromise;
    } finally {
      this.mcpSyncPromise = null;
    }
  }

  private async performSync(signal?: AbortSignal): Promise<AgentMcpSyncReport> {
    const configured = this.servers.listAll();
    const enabledIds = new Set(configured.filter((entry) => entry.enabled).map((entry) => entry.id));
    for (const id of [...this.mcpClients.keys()]) {
      if (!enabledIds.has(id)) this.disconnect(id);
    }
    const connected: string[] = [];
    const failed: AgentMcpSyncReport["failed"] = [];
    for (const configuration of configured) {
      if (!configuration.enabled) continue;
      if (signal?.aborted) break;
      try {
        await this.connect(configuration, signal);
        connected.push(configuration.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : "MCP 服务器连接失败。";
        failed.push({ id: configuration.id, label: configuration.label, error: message });
      }
    }
    return { connected, failed };
  }

  private async connect(configuration: AgentMcpServerConfiguration, signal?: AbortSignal): Promise<void> {
    const fingerprint = configurationFingerprint(configuration);
    const existing = this.mcpClients.get(configuration.id);
    if (existing && existing.isConnected && this.mcpFingerprints.get(configuration.id) === fingerprint) return;
    if (existing) this.disconnect(configuration.id);
    const client = new McpStdioClient({
      command: configuration.command,
      args: configuration.args,
      env: configuration.env,
      ...(configuration.cwd ? { cwd: configuration.cwd } : {}),
      connectTimeoutMs: Math.min(configuration.timeoutMs, 15_000),
      requestTimeoutMs: configuration.timeoutMs,
    });
    let capabilities: McpServerCapabilities;
    try {
      capabilities = await client.connect({ signal });
    } catch (error) {
      client.close();
      throw error;
    }
    this.mcpClients.set(configuration.id, client);
    this.mcpFingerprints.set(configuration.id, fingerprint);
    this.registerTools(configuration.id, configuration.label, capabilities.tools);
  }

  private registerTools(serverId: string, serverLabel: string, tools: McpServerCapabilities["tools"]): void {
    this.unregisterTools(serverId);
    const client = this.mcpClients.get(serverId);
    if (!client) return;
    const registered: string[] = [];
    for (const tool of createMcpAgentTools({ client, serverId, serverLabel, tools })) {
      const result = this.tools.register(tool);
      if (result.ok) registered.push(tool.descriptor.name);
    }
    this.mcpServerToolNames.set(serverId, registered);
  }

  private unregisterTools(serverId: string): void {
    for (const name of this.mcpServerToolNames.get(serverId) ?? []) {
      this.tools.unregister(name);
    }
    this.mcpServerToolNames.delete(serverId);
  }

  /** Names of every tool currently registered from an external MCP server. */
  externalToolNames(): ReadonlySet<string> {
    const names = new Set<string>();
    for (const registered of this.mcpServerToolNames.values()) {
      for (const name of registered) names.add(name);
    }
    return names;
  }

  private disconnect(serverId: string): void {
    this.unregisterTools(serverId);
    this.mcpClients.get(serverId)?.close();
    this.mcpClients.delete(serverId);
    this.mcpFingerprints.delete(serverId);
  }

  private mapStoreError(error: unknown): unknown {
    if (error instanceof AgentMcpServerStoreError) {
      return new AgentServiceError(error.code, error.message, error.statusCode, error.retryable);
    }
    return error;
  }

  /** Closes every live MCP process; called from AgentService.close(). */
  dispose(): void {
    for (const client of this.mcpClients.values()) client.close();
    this.mcpClients.clear();
    this.mcpServerToolNames.clear();
    this.mcpFingerprints.clear();
  }
}
