import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";

const MCP_PATH = resolve(process.cwd(), ".mcp.json");

interface McpServer {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface McpJson {
  mcpServers: Record<string, McpServer>;
}

export function readMcpJson(): McpJson {
  if (!existsSync(MCP_PATH)) return { mcpServers: {} };
  try {
    return JSON.parse(readFileSync(MCP_PATH, "utf-8"));
  } catch {
    return { mcpServers: {} };
  }
}

export function writeMcpJson(data: McpJson): void {
  writeFileSync(MCP_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function addRemoteMcp(key: string, url: string, headers: Record<string, string>): void {
  const data = readMcpJson();
  data.mcpServers[key] = { type: "http", url, headers };
  writeMcpJson(data);
}

export function addLocalMcp(key: string, pkg: string, extraArgs: string[] = [], env?: Record<string, string>): void {
  const data = readMcpJson();
  const entry: McpServer = { command: "npx", args: ["-y", pkg, ...extraArgs] };
  if (env && Object.keys(env).length > 0) entry.env = env;
  data.mcpServers[key] = entry;
  writeMcpJson(data);
}

export function removeMcp(key: string): boolean {
  const data = readMcpJson();
  if (!data.mcpServers[key]) return false;
  delete data.mcpServers[key];
  writeMcpJson(data);
  return true;
}

export function listConfigured(): string[] {
  return Object.keys(readMcpJson().mcpServers);
}

export function mcpJsonPath(): string {
  return MCP_PATH;
}

export function ensureProxy(): void {
  const data = readMcpJson();
  if (!data.mcpServers["mcpx-proxy"]) {
    data.mcpServers["mcpx-proxy"] = {
      command: "npx",
      args: ["-y", "@mcpx-io/proxy@latest"],
    };
    writeMcpJson(data);
  }
}

// ─── Global settings.json ─────────────────────────────────────────────────────

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

interface ClaudeSettings {
  mcpServers?: Record<string, McpServer>;
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")); } catch { return {}; }
}

function writeSettings(data: ClaudeSettings): void {
  const dir = join(homedir(), ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function addGlobalMcp(key: string, server: McpServer): void {
  const settings = readSettings();
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers[key] = server;
  writeSettings(settings);
}

export function isGlobalMcpConfigured(key: string): boolean {
  return !!(readSettings().mcpServers?.[key]);
}

export function ensureGlobalProxyAndMemory(): void {
  const settings = readSettings();
  if (!settings.mcpServers) settings.mcpServers = {};
  let changed = false;

  // proxy
  if (!settings.mcpServers["mcpx-proxy"]) {
    settings.mcpServers["mcpx-proxy"] = {
      command: "npx",
      args: ["-y", "@mcpx-io/proxy@latest"],
    };
    changed = true;
  }

  // memory
  if (!settings.mcpServers["mcpx-memory"]) {
    settings.mcpServers["mcpx-memory"] = {
      type: "http",
      url: "http://localhost:4099/memory/mcp",
      headers: {
        Accept: "application/json, text/event-stream",
        "X-Memory-Token": `mcpx:enc:memory`,
      },
    };
    changed = true;
  }

  if (changed) writeSettings(settings);
}
